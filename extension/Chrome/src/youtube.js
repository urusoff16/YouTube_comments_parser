import { extensionError } from "./errors.js";

const SUPPORTED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtube-nocookie.com",
]);

const COMMENT_TARGETS = new Set([
  "comments-section",
  "engagement-panel-comments-section",
  "shorts-engagement-panel-comments-section",
]);

export class CollectorStoppedError extends Error {
  constructor() {
    super("Выгрузка остановлена пользователем.");
    this.name = "CollectorStoppedError";
  }
}

export function extractVideoId(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw extensionError("invalidUrl", "Введите полную ссылку на видео YouTube.");
  }

  if (!['http:', 'https:'].includes(url.protocol) || !SUPPORTED_HOSTS.has(url.hostname)) {
    throw extensionError("unsupportedHost", "Поддерживаются только ссылки YouTube.");
  }

  let candidate = null;
  if (url.hostname === "youtu.be") {
    candidate = url.pathname.split("/").filter(Boolean)[0];
  } else {
    candidate = url.searchParams.get("v");
    if (!candidate) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "live", "embed"].includes(parts[0])) candidate = parts[1];
    }
  }

  if (!candidate || !/^[A-Za-z0-9_-]{6,}$/.test(candidate)) {
    throw extensionError("videoIdMissing", "Не удалось определить ID видео в ссылке.");
  }
  return candidate;
}

export function normalizeYoutubeUrl(input) {
  return `https://www.youtube.com/watch?v=${extractVideoId(input)}`;
}

export function extractBalancedJson(source, startIndex) {
  const openingIndex = source.indexOf("{", startIndex);
  if (openingIndex === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return source.slice(openingIndex, index + 1);
  }
  return null;
}

function objectsAfterMatches(source, expression) {
  const objects = [];
  for (const match of source.matchAll(expression)) {
    const raw = extractBalancedJson(source, match.index + match[0].length);
    if (!raw) continue;
    try {
      objects.push(JSON.parse(raw));
    } catch {
      // YouTube can leave unrelated marker-like text in scripts; skip it.
    }
  }
  return objects;
}

export function extractPageConfiguration(html) {
  const configurations = objectsAfterMatches(html, /ytcfg\.set\s*\(/g);
  const configuration = Object.assign({}, ...configurations);
  if (!configuration.INNERTUBE_API_KEY || !configuration.INNERTUBE_CONTEXT) {
    throw extensionError("configurationMissing", "YouTube не отдал конфигурацию внутреннего API. Обновите расширение или повторите позже.");
  }
  return configuration;
}

export function extractInitialData(html) {
  const candidates = objectsAfterMatches(
    html,
    /(?:window\s*\[\s*["']ytInitialData["']\s*\]|(?:var\s+)?ytInitialData)\s*=\s*/g,
  );
  if (!candidates.length) {
    throw extensionError("initialDataMissing", "Не удалось прочитать начальные данные видео. Возможно, YouTube показал проверку или страницу согласия.");
  }
  return candidates[0];
}

export function* findValues(root, searchKey) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (current && typeof current === "object") {
      for (const [key, value] of Object.entries(current)) {
        if (key === searchKey) yield value;
        else stack.push(value);
      }
    }
  }
}

function firstValue(root, key, fallback = null) {
  return findValues(root, key).next().value ?? fallback;
}

function endpointToken(endpoint) {
  return endpoint?.continuationCommand?.token ?? endpoint?.continuationEndpoint?.continuationCommand?.token;
}

function endpointApiPath(endpoint) {
  return endpoint?.commandMetadata?.webCommandMetadata?.apiUrl
    ?? endpoint?.continuationEndpoint?.commandMetadata?.webCommandMetadata?.apiUrl
    ?? "/youtubei/v1/next";
}

function textFromRuns(value) {
  if (!value) return "";
  if (typeof value.simpleText === "string") return value.simpleText;
  return (value.runs ?? []).map((run) => run.text ?? "").join("");
}

function replyCommandFromRoot(root) {
  const endpoint = firstValue(root, "createCommentReplyEndpoint");
  if (!endpoint?.createReplyParams) return null;
  const apiPath = [...findValues(root, "webCommandMetadata")]
    .find((metadata) => metadata?.apiUrl?.includes("create_comment_reply"))?.apiUrl;
  return {
    api_path: apiPath ?? "/youtubei/v1/comment/create_comment_reply",
    create_reply_params: endpoint.createReplyParams,
  };
}

function unwrapRepeatedRenderer(value, key) {
  let current = value;
  while (current?.[key] && current[key] !== current) current = current[key];
  return current;
}

function engagementToolbarSurfaces(response) {
  const surfaces = new Map();
  for (const mutations of findValues(response, "mutations")) {
    if (!Array.isArray(mutations)) continue;
    for (const mutation of mutations) {
      const surface = mutation?.payload?.engagementToolbarSurfaceEntityPayload;
      const key = mutation?.entityKey ?? surface?.key;
      if (key && surface) surfaces.set(key, surface);
    }
  }
  return surfaces;
}

export function replyCommandsFromResponse(response) {
  const commands = new Map();
  const toolbarSurfaces = engagementToolbarSurfaces(response);
  for (const rawModel of findValues(response, "commentViewModel")) {
    const model = unwrapRepeatedRenderer(rawModel, "commentViewModel");
    if (!model?.commentId) continue;
    const command = replyCommandFromRoot(toolbarSurfaces.get(model.toolbarSurfaceKey))
      ?? replyCommandFromRoot(model);
    if (command) commands.set(model.commentId, command);
  }
  for (const renderer of findValues(response, "commentRenderer")) {
    if (!renderer?.commentId || commands.has(renderer.commentId)) continue;
    const command = replyCommandFromRoot(renderer);
    if (command) commands.set(renderer.commentId, command);
  }
  return commands;
}

export function parseCommentEntities(response) {
  const replyCommands = replyCommandsFromResponse(response);
  const toolbarStates = new Map(
    [...findValues(response, "engagementToolbarStateEntityPayload")]
      .filter((payload) => payload?.key)
      .map((payload) => [payload.key, payload]),
  );

  const payments = new Map();
  const surfaceKeys = new Map();
  for (const rawModel of findValues(response, "commentViewModel")) {
    const model = unwrapRepeatedRenderer(rawModel, "commentViewModel");
    if (model?.commentSurfaceKey && model?.commentId) surfaceKeys.set(model.commentSurfaceKey, model.commentId);
  }
  for (const payload of findValues(response, "commentSurfaceEntityPayload")) {
    if (!payload?.pdgCommentChip || !surfaceKeys.has(payload.key)) continue;
    payments.set(surfaceKeys.get(payload.key), firstValue(payload, "simpleText", ""));
  }

  const result = [];
  const entities = [...findValues(response, "commentEntityPayload")].reverse();
  for (const entity of entities) {
    const properties = entity?.properties ?? {};
    const author = entity?.author ?? {};
    const toolbar = entity?.toolbar ?? {};
    const commentId = properties.commentId;
    if (!commentId) continue;
    const isReply = commentId.includes(".");
    const toolbarState = toolbarStates.get(properties.toolbarStateKey) ?? {};
    const comment = {
      comment_id: commentId,
      parent_comment_id: isReply ? commentId.split(".", 1)[0] : null,
      author: author.displayName ?? "",
      author_channel_id: author.channelId ?? null,
      text: properties.content?.content ?? "",
      published_at_text: properties.publishedTime ?? "",
      published_at_timestamp: null,
      likes: String(toolbar.likeCountNotliked ?? "0").trim() || "0",
      reply_count: toolbar.replyCount ?? 0,
      is_reply: isReply,
      hearted_by_creator: toolbarState.heartState === "TOOLBAR_HEART_STATE_HEARTED",
      avatar_url: author.avatarThumbnailUrl ?? null,
    };
    if (replyCommands.has(commentId)) comment._reply_command = replyCommands.get(commentId);
    if (payments.has(commentId)) comment.paid = payments.get(commentId);
    result.push(comment);
  }
  return result;
}

function parseLegacyComments(response) {
  const replyCommands = replyCommandsFromResponse(response);
  const result = [];
  for (const renderer of findValues(response, "commentRenderer")) {
    if (!renderer?.commentId) continue;
    const comment = {
      comment_id: renderer.commentId,
      parent_comment_id: null,
      author: textFromRuns(renderer.authorText),
      author_channel_id: renderer.authorEndpoint?.browseEndpoint?.browseId ?? null,
      text: textFromRuns(renderer.contentText),
      published_at_text: textFromRuns(renderer.publishedTimeText),
      published_at_timestamp: null,
      likes: textFromRuns(renderer.voteCount) || "0",
      reply_count: renderer.replyCount ?? 0,
      is_reply: false,
      hearted_by_creator: Boolean(renderer.actionButtons?.commentActionButtonsRenderer?.creatorHeart),
      avatar_url: renderer.authorThumbnail?.thumbnails?.at(-1)?.url ?? null,
    };
    if (replyCommands.has(renderer.commentId)) comment._reply_command = replyCommands.get(renderer.commentId);
    result.push(comment);
  }
  return result;
}

export async function postYoutubeReply({ command, configuration, text, fetchImpl = fetch }) {
  const normalizedText = String(text ?? "").trim();
  if (!normalizedText) throw extensionError("replyEmpty", "Введите текст ответа.");
  if (!command?.create_reply_params || !configuration?.INNERTUBE_API_KEY || !configuration?.INNERTUBE_CONTEXT) {
    throw extensionError("replyUnavailable", "YouTube не предоставил действие для ответа на этот комментарий.");
  }

  const url = new URL(command.api_path || "/youtubei/v1/comment/create_comment_reply", "https://www.youtube.com");
  url.searchParams.set("key", configuration.INNERTUBE_API_KEY);
  const headers = { "Content-Type": "application/json" };
  if (configuration.INNERTUBE_CONTEXT_CLIENT_NAME) {
    headers["X-YouTube-Client-Name"] = String(configuration.INNERTUBE_CONTEXT_CLIENT_NAME);
  }
  if (configuration.INNERTUBE_CONTEXT_CLIENT_VERSION) {
    headers["X-YouTube-Client-Version"] = String(configuration.INNERTUBE_CONTEXT_CLIENT_VERSION);
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({
        context: configuration.INNERTUBE_CONTEXT,
        createReplyParams: command.create_reply_params,
        commentText: normalizedText,
      }),
    });
  } catch (error) {
    throw extensionError("replyNetwork", "Не удалось отправить ответ из-за сетевой ошибки.", {}, { cause: error });
  }

  if (!response.ok) {
    const code = [401, 403].includes(response.status) ? "replySignIn" : "replyRejectedHttp";
    throw extensionError(code, `YouTube отклонил публикацию ответа (HTTP ${response.status}).`, {
      status: response.status,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw extensionError("replyMalformed", "YouTube вернул непонятный ответ после публикации.", {}, { cause: error });
  }

  const actionResult = firstValue(data, "actionResult");
  if (actionResult?.status && actionResult.status !== "STATUS_SUCCEEDED") {
    throw extensionError("replyRejected", "YouTube не подтвердил публикацию ответа.");
  }
  const alert = firstValue(data, "alertRenderer");
  if (alert?.type === "ERROR") {
    throw extensionError("replyRejected", textFromRuns(alert.text) || "YouTube не подтвердил публикацию ответа.");
  }

  return { data, comments: parseComments(data) };
}

export function parseComments(response) {
  const entities = parseCommentEntities(response);
  return entities.length ? entities : parseLegacyComments(response);
}

export function nextEndpoints(response) {
  const continuations = [];
  const actions = [
    ...findValues(response, "reloadContinuationItemsCommand"),
    ...findValues(response, "appendContinuationItemsAction"),
  ];

  for (const action of actions) {
    for (const item of action?.continuationItems ?? []) {
      if (COMMENT_TARGETS.has(action.targetId)) {
        continuations.unshift(...findValues(item, "continuationEndpoint"));
      }
      if (action.targetId?.startsWith("comment-replies-item") && item.continuationItemRenderer) {
        const command = firstValue(item, "buttonRenderer")?.command;
        if (command) continuations.push(command);
      }
    }
  }
  return continuations;
}

function delay(milliseconds, signal) {
  if (!milliseconds) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new CollectorStoppedError());
    }, { once: true });
  });
}

async function fetchWithRetry(url, init, { signal, onRetry, fetchImpl = fetch } = {}) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw new CollectorStoppedError();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (signal?.aborted) throw new CollectorStoppedError();
      if (response.ok) return response;
      if ([403, 413].includes(response.status)) {
        throw extensionError("youtubeRejected", `YouTube отклонил запрос (HTTP ${response.status}). Сделайте паузу и попробуйте позже.`, { status: response.status });
      }
      if (response.status !== 429 && response.status < 500) {
        throw extensionError("youtubeHttp", `YouTube вернул HTTP ${response.status}.`, { status: response.status });
      }
      if (attempt === maxAttempts) {
        throw extensionError("youtubeUnavailable", `YouTube не отвечает после ${maxAttempts} попыток (HTTP ${response.status}).`, {
          attempts: maxAttempts,
          status: response.status,
        });
      }
    } catch (error) {
      if (signal?.aborted) throw new CollectorStoppedError();
      if (error.code) throw error;
      if (attempt === maxAttempts) {
        throw extensionError("networkFailed", `Сетевая ошибка после ${maxAttempts} попыток: ${error.message}`, {
          attempts: maxAttempts,
          message: error.message,
        }, { cause: error });
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
    }
    const wait = Math.min(2 ** attempt * 1000, 20_000);
    onRetry?.({ attempt, wait });
    await delay(wait, signal);
  }
  throw extensionError("requestFailed", "Не удалось выполнить запрос.");
}

async function requestContinuation(endpoint, configuration, options) {
  const token = endpointToken(endpoint);
  if (!token) throw extensionError("continuationMissing", "YouTube вернул continuation без токена.");
  const path = endpointApiPath(endpoint);
  const url = new URL(path, "https://www.youtube.com");
  url.searchParams.set("key", configuration.INNERTUBE_API_KEY);

  const headers = { "Content-Type": "application/json" };
  if (configuration.INNERTUBE_CONTEXT_CLIENT_NAME) {
    headers["X-YouTube-Client-Name"] = String(configuration.INNERTUBE_CONTEXT_CLIENT_NAME);
  }
  if (configuration.INNERTUBE_CONTEXT_CLIENT_VERSION) {
    headers["X-YouTube-Client-Version"] = String(configuration.INNERTUBE_CONTEXT_CLIENT_VERSION);
  }

  const response = await fetchWithRetry(url, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ context: configuration.INNERTUBE_CONTEXT, continuation: token }),
  }, options);
  return response.json();
}

async function initialContinuation(data, configuration, options) {
  let sortMenu = firstValue(data, "sortFilterSubMenuRenderer")?.subMenuItems ?? [];
  if (!sortMenu.length) {
    const section = firstValue(data, "sectionListRenderer", {});
    const endpoint = [...findValues(section, "continuationEndpoint")][0]
      ?? firstValue(firstValue(data, "itemSectionRenderer", {}), "continuationItemRenderer")?.continuationEndpoint;
    if (!endpoint) throw extensionError("commentsUnavailable", "Комментарии не найдены: возможно, они отключены или недоступны.");
    data = await requestContinuation(endpoint, configuration, options);
    sortMenu = firstValue(data, "sortFilterSubMenuRenderer")?.subMenuItems ?? [];
  }
  const sortIndex = options.sort === "recent" ? 1 : 0;
  const endpoint = sortMenu[sortIndex]?.serviceEndpoint;
  if (!endpoint) throw extensionError("sortUnavailable", "YouTube не позволил выбрать запрошенную сортировку комментариев.");
  return endpoint;
}

export async function collectYoutubeComments(options) {
  const videoId = extractVideoId(options.url);
  const watchUrl = new URL(`https://www.youtube.com/watch?v=${videoId}`);
  if (options.language) watchUrl.searchParams.set("hl", options.language);

  options.onStatus?.(options.t?.("status.loadingPage") ?? "Загружаю страницу видео…");
  const page = await fetchWithRetry(watchUrl, {
    credentials: "include",
    headers: { "Accept": "text/html" },
  }, options);
  const html = await page.text();
  const configuration = extractPageConfiguration(html);
  if (options.language) configuration.INNERTUBE_CONTEXT.client.hl = options.language;
  await options.onReady?.(configuration);
  const initialData = extractInitialData(html);

  options.onStatus?.(options.t?.("status.loadingComments") ?? "Получаю список комментариев…");
  const firstEndpoint = await initialContinuation(initialData, configuration, options);
  const endpoints = [firstEndpoint];
  const visitedTokens = new Set();
  const seenComments = new Set();
  let total = 0;
  let pages = 0;

  while (endpoints.length && (!options.limit || total < options.limit)) {
    if (options.signal?.aborted) throw new CollectorStoppedError();
    await options.waitIfPaused?.();
    const endpoint = endpoints.pop();
    const token = endpointToken(endpoint);
    if (!token || visitedTokens.has(token)) continue;
    visitedTokens.add(token);

    const response = await requestContinuation(endpoint, configuration, options);
    pages += 1;
    const fresh = parseComments(response).filter((comment) => {
      if (!comment.comment_id || seenComments.has(comment.comment_id)) return false;
      seenComments.add(comment.comment_id);
      return true;
    });
    const remaining = options.limit ? Math.max(options.limit - total, 0) : fresh.length;
    const batch = options.limit ? fresh.slice(0, remaining) : fresh;
    if (batch.length) {
      await options.onComments?.(batch, { pages, total: total + batch.length });
      total += batch.length;
    }
    endpoints.push(...nextEndpoints(response));
    options.onProgress?.({ total, pages, queued: endpoints.length });
    if (endpoints.length && (!options.limit || total < options.limit)) {
      await delay(options.delay ?? 500, options.signal);
    }
  }

  return { total, pages, exhausted: endpoints.length === 0 };
}
