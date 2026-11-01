import { extensionError } from "./errors.js";

export const YOUTUBE_REPLY_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";
const API_BASE = "https://www.googleapis.com/youtube/v3/";

function authError(error, interactive) {
  const message = String(error?.message ?? "");
  if (/bad client|invalid.client|invalid.scope|client.*(not found|invalid)|redirect.*mismatch/i.test(message)) {
    return extensionError("oauthConfiguration", "Проверьте OAuth Client ID и привязку к ID расширения.");
  }
  if (interactive && /cancel|denied|reject|did not approve|not approve/i.test(message)) {
    return extensionError("oauthCancelled", "Вход отменён или доступ не предоставлен.");
  }
  return extensionError("oauthSignIn", "Подключите YouTube через Google и разрешите доступ.");
}

function apiError(status, data) {
  const reasons = (data?.error?.errors ?? []).map((entry) => entry.reason);
  if (status === 401) return extensionError("oauthExpired", "Вход истёк. Подключите YouTube заново.");
  if (reasons.some((reason) => ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"].includes(reason)) || status === 429) {
    return extensionError("apiQuota", "YouTube ограничил частоту запросов или квоту проекта.");
  }
  if (reasons.includes("accessNotConfigured") || reasons.includes("serviceDisabled")) {
    return extensionError("oauthConfiguration", "Включите YouTube Data API v3 в проекте OAuth-клиента.");
  }
  if (reasons.includes("insufficientPermissions")) {
    return extensionError("oauthPermissions", "Google не предоставил разрешение на ответы YouTube.");
  }
  if (reasons.includes("commentsDisabled")) return extensionError("apiCommentsDisabled", "Комментарии отключены.");
  if (reasons.includes("ineligibleAccount")) return extensionError("oauthNoChannel", "У аккаунта нет доступного канала YouTube.");
  if (status === 404) return extensionError("apiCommentMissing", "Комментарий или видео больше не доступны.");
  if (status === 403 || reasons.includes("operationNotSupported")) {
    return extensionError("apiForbidden", "YouTube не разрешил ответить в эту ветку.");
  }
  return extensionError("apiHttp", `YouTube API вернул HTTP ${status}.`, { status });
}

function channelFromResponse(data) {
  const channels = data?.items ?? [];
  if (!channels.length) throw extensionError("oauthNoChannel", "У аккаунта нет доступного канала YouTube.");
  if (channels.length !== 1 || !channels[0].id) {
    throw extensionError("oauthChannelAmbiguous", "Не удалось однозначно определить канал. Выберите нужный канал при входе.");
  }
  const channel = channels[0];
  return {
    id: channel.id,
    title: channel.snippet?.title || channel.id,
    avatar_url: channel.snippet?.thumbnails?.default?.url ?? null,
    url: `https://www.youtube.com/channel/${encodeURIComponent(channel.id)}`,
  };
}

export function createYoutubeAccount({ identity = globalThis.chrome?.identity, fetchImpl = fetch } = {}) {
  let channel = null;
  let busy = false;
  let session = 0;

  async function token(interactive) {
    if (!identity?.getAuthToken) throw extensionError("oauthUnavailable", "Вход доступен в установленном расширении Chrome.");
    let result;
    try {
      result = await identity.getAuthToken({ interactive, enableGranularPermissions: true, scopes: [YOUTUBE_REPLY_SCOPE] });
    } catch (error) {
      channel = null;
      throw authError(error, interactive);
    }
    const value = typeof result === "string" ? result : result?.token;
    if (!value) {
      channel = null;
      throw extensionError("oauthSignIn", "Подключите YouTube через Google.");
    }
    if (result.grantedScopes && !result.grantedScopes.includes(YOUTUBE_REPLY_SCOPE)) {
      channel = null;
      throw extensionError("oauthPermissions", "Google не предоставил разрешение на ответы YouTube.");
    }
    return value;
  }

  async function request(path, accessToken, { body } = {}) {
    const writing = body !== undefined;
    let response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        method: writing ? "POST" : "GET",
        credentials: "omit",
        headers: { Authorization: `Bearer ${accessToken}`, ...(writing ? { "Content-Type": "application/json" } : {}) },
        ...(writing ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw extensionError(writing ? "replyUncertain" : "oauthNetwork", writing
        ? "Результат отправки неизвестен. Проверьте ветку на YouTube перед повтором."
        : "Не удалось подключиться к YouTube API.");
    }
    let data;
    try { data = await response.json(); } catch { data = null; }
    if (writing && (response.status >= 500 || response.status === 408)) {
      throw extensionError("replyUncertain", "Результат отправки неизвестен. Проверьте ветку на YouTube перед повтором.");
    }
    if (!response.ok) {
      if (response.status === 401) {
        channel = null;
        try { await identity.removeCachedAuthToken({ token: accessToken }); } catch { /* A new explicit sign-in will recover the cache. */ }
      }
      throw apiError(response.status, data);
    }
    if (!data) throw extensionError(writing ? "replyUncertain" : "apiMalformed", "YouTube вернул неполный ответ.");
    return data;
  }

  async function exclusive(action) {
    if (busy) throw extensionError("oauthBusy", "Дождитесь завершения текущего действия.");
    busy = true;
    try { return await action(); } finally { busy = false; }
  }

  return {
    get channel() { return channel ? { ...channel } : null; },
    forgetConnection() {
      session += 1;
      channel = null;
    },
    connect({ interactive = true } = {}) {
      return exclusive(async () => {
        channel = null;
        const connectingSession = session;
        const accessToken = await token(interactive);
        const connected = channelFromResponse(await request("channels?part=snippet&mine=true", accessToken));
        if (session !== connectingSession) throw extensionError("oauthSignIn", "Подключите YouTube заново.");
        channel = connected;
        return { ...channel };
      });
    },
    disconnect() {
      return exclusive(async () => {
        if (!identity?.clearAllCachedAuthTokens) throw extensionError("oauthUnavailable", "Требуется Chrome 106 или новее.");
        await identity.clearAllCachedAuthTokens();
        session += 1;
        channel = null;
      });
    },
    postReply({ parentId, text, expectedChannelId }) {
      return exclusive(async () => {
        const normalizedText = String(text ?? "").trim();
        if (!normalizedText) throw extensionError("replyEmpty", "Введите текст ответа.");
        if (normalizedText.length > 10_000) throw extensionError("replyTooLong", "Ответ слишком длинный.");
        if (!parentId || typeof parentId !== "string") throw extensionError("replyUnavailable", "Не найден основной комментарий ветки.");
        if (!channel || !expectedChannelId || channel.id !== expectedChannelId) {
          throw extensionError("oauthAccountChanged", "Канал изменился. Проверьте аккаунт и откройте редактор заново.");
        }
        const sendingSession = session;
        const accessToken = await token(false);
        channel = null;
        const current = channelFromResponse(await request("channels?part=snippet&mine=true", accessToken));
        if (session !== sendingSession) throw extensionError("oauthSignIn", "Подключение отключено. Войдите заново.");
        channel = current;
        if (channel.id !== expectedChannelId) {
          throw extensionError("oauthAccountChanged", "Канал изменился. Проверьте аккаунт и откройте редактор заново.");
        }
        // Never retry a write: a lost response can follow a successful publication.
        const data = await request("comments?part=snippet", accessToken, {
          body: { snippet: { parentId, textOriginal: normalizedText } },
        });
        if (!data.id || data.snippet?.parentId !== parentId) {
          throw extensionError("replyUncertain", "Результат отправки неизвестен. Проверьте ветку на YouTube перед повтором.");
        }
        return {
          comment_id: data.id,
          parent_comment_id: data.snippet.parentId,
          author: data.snippet.authorDisplayName || channel.title,
          author_channel_id: data.snippet.authorChannelId?.value || channel.id,
          author_channel_url: data.snippet.authorChannelUrl || channel.url,
          text: data.snippet.textOriginal ?? normalizedText,
          published_at_text: data.snippet.publishedAt ?? "",
          likes: String(data.snippet.likeCount ?? 0),
          reply_count: 0,
          is_reply: true,
          hearted_by_creator: false,
          avatar_url: data.snippet.authorProfileImageUrl || channel.avatar_url,
        };
      });
    },
  };
}
