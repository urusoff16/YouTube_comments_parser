import test from "node:test";
import assert from "node:assert/strict";
import { createYoutubeAccount, YOUTUBE_REPLY_SCOPE } from "../src/youtube-account.js";
import { translatorFor } from "../src/i18n.js";

const channel = (id = "UC-owner") => ({ items: [{ id, snippet: { title: "My channel" } }] });
const reply = { id: "reply-id", snippet: { parentId: "root-id", textOriginal: "Спасибо!", authorChannelId: { value: "UC-owner" } } };
const options = { parentId: "root-id", text: " Спасибо! ", expectedChannelId: "UC-owner" };

function fixture(responses = [channel(), channel(), reply]) {
  const requests = [];
  const authCalls = [];
  let removed = 0;
  let cleared = 0;
  const identity = {
    async getAuthToken(details) {
      authCalls.push(details);
      return { token: "test-token", grantedScopes: [YOUTUBE_REPLY_SCOPE] };
    },
    async removeCachedAuthToken() { removed += 1; },
    async clearAllCachedAuthTokens() { cleared += 1; },
  };
  const api = createYoutubeAccount({
    identity,
    async fetchImpl(url, init) {
      requests.push({ url, ...init });
      const value = responses.shift();
      if (value instanceof Error) throw value;
      if (typeof value === "function") return value();
      return value instanceof Response ? value : Response.json(value);
    },
  });
  return { api, identity, requests, authCalls, get removed() { return removed; }, get cleared() { return cleared; } };
}

test("OAuth использует нужный scope; наружу возвращается только YouTube-канал", async () => {
  const f = fixture();
  const connected = await f.api.connect();
  assert.equal(connected.id, "UC-owner");
  assert.equal(connected.token, undefined);
  assert.equal(f.authCalls[0].interactive, true);
  assert.deepEqual(f.authCalls[0].scopes, [YOUTUBE_REPLY_SCOPE]);
  assert.match(f.requests[0].url, /channels\?part=snippet&mine=true$/);
  assert.equal(f.requests[0].credentials, "omit");
  connected.id = "changed-by-caller";
  assert.equal(f.api.channel.id, "UC-owner");
});

test("восстановление входа не вызывает интерактивное окно", async () => {
  const f = fixture();
  await f.api.connect({ interactive: false });
  assert.equal(f.authCalls[0].interactive, false);
});

test("отправляет один официальный POST с корневым parentId и возвращает настоящий ID", async () => {
  const f = fixture();
  await f.api.connect();
  const posted = await f.api.postReply(options);
  assert.equal(f.authCalls[1].interactive, false);
  const writes = f.requests.filter((request) => request.method === "POST");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, "https://www.googleapis.com/youtube/v3/comments?part=snippet");
  assert.deepEqual(JSON.parse(writes[0].body), { snippet: { parentId: "root-id", textOriginal: "Спасибо!" } });
  assert.equal(writes[0].headers.Authorization, "Bearer test-token");
  assert.equal(posted.comment_id, "reply-id");
  assert.equal(posted.parent_comment_id, "root-id");
  assert.equal(posted.author_channel_id, "UC-owner");
  assert.equal(posted.is_reply, true);
});

test("проверяет канал ещё раз и не отправляет после смены аккаунта", async () => {
  const f = fixture([channel(), channel("UC-other")]);
  await f.api.connect();
  await assert.rejects(() => f.api.postReply(options), { code: "oauthAccountChanged" });
  assert.equal(f.requests.some((request) => request.method === "POST"), false);
  assert.equal(f.api.channel.id, "UC-other");
});

test("два параллельных нажатия не создают два POST", async () => {
  const f = fixture();
  await f.api.connect();
  const first = f.api.postReply(options);
  await assert.rejects(() => f.api.postReply(options), { code: "oauthBusy" });
  await first;
  assert.equal(f.requests.filter((request) => request.method === "POST").length, 1);
});

test("отмена входа и отказ в scope не обращаются к API", async () => {
  const f = fixture();
  f.identity.getAuthToken = async () => { throw new Error("The user did not approve access."); };
  await assert.rejects(() => f.api.connect(), { code: "oauthCancelled" });
  assert.equal(f.requests.length, 0);
  f.identity.getAuthToken = async () => ({ token: "test-token", grantedScopes: [] });
  await assert.rejects(() => f.api.connect(), { code: "oauthPermissions" });
  assert.equal(f.requests.length, 0);
});

test("ошибка привязки OAuth-клиента имеет понятный код", async () => {
  const f = fixture();
  f.identity.getAuthToken = async () => { throw new Error("OAuth2 request failed: bad client id"); };
  await assert.rejects(() => f.api.connect(), { code: "oauthConfiguration" });
});

test("пустой и неоднозначный список каналов не разрешает публикацию", async () => {
  for (const [data, code] of [[{ items: [] }, "oauthNoChannel"], [{ items: [...channel().items, ...channel("other").items] }, "oauthChannelAmbiguous"]]) {
    const f = fixture([data]);
    await assert.rejects(() => f.api.connect(), { code });
    assert.equal(f.api.channel, null);
  }
});

test("неповторяемые сетевые ошибки, 5xx и неполный ответ считаются неопределённой отправкой", async () => {
  const failures = [new Error("Connection lost"), new Response("", { status: 503 }), new Response("bad json"), {}, { id: "id", snippet: { parentId: "wrong-thread" } }];
  for (const failure of failures) {
    const f = fixture([channel(), channel(), failure]);
    await f.api.connect();
    await assert.rejects(() => f.api.postReply(options), { code: "replyUncertain" });
    assert.equal(f.requests.filter((request) => request.method === "POST").length, 1);
  }
});

test("401 сбрасывает авторизацию без автоматического повтора публикации", async () => {
  const f = fixture([channel(), channel(), Response.json({ error: {} }, { status: 401 })]);
  await f.api.connect();
  await assert.rejects(() => f.api.postReply(options), { code: "oauthExpired" });
  assert.equal(f.removed, 1);
  assert.equal(f.api.channel, null);
  assert.equal(f.requests.length, 3);
});

test("квота, отключённый API, права и закрытая ветка различаются", async () => {
  for (const [reason, code] of [["quotaExceeded", "apiQuota"], ["accessNotConfigured", "oauthConfiguration"], ["insufficientPermissions", "oauthPermissions"], ["commentsDisabled", "apiCommentsDisabled"], ["forbidden", "apiForbidden"]]) {
    const f = fixture([channel(), channel(), Response.json({ error: { errors: [{ reason }] } }, { status: 403 })]);
    await f.api.connect();
    await assert.rejects(() => f.api.postReply(options), { code });
    assert.equal(f.requests.filter((request) => request.method === "POST").length, 1);
  }
});

test("пустой/слишком длинный текст и чужой редактор не отправляются", async () => {
  const f = fixture();
  await f.api.connect();
  for (const [changes, code] of [[{ text: " " }, "replyEmpty"], [{ text: "x".repeat(10_001) }, "replyTooLong"], [{ parentId: null }, "replyUnavailable"], [{ expectedChannelId: "other" }, "oauthAccountChanged"]]) {
    await assert.rejects(() => f.api.postReply({ ...options, ...changes }), { code });
  }
  assert.equal(f.requests.length, 1);
});

test("отключение очищает кэш и останавливает публикацию", async () => {
  const f = fixture();
  await f.api.connect();
  await f.api.disconnect();
  assert.equal(f.cleared, 1);
  assert.equal(f.api.channel, null);
  await assert.rejects(() => f.api.postReply(options), { code: "oauthAccountChanged" });
});

test("отключение из другой страницы во время проверки канала останавливает POST", async () => {
  let resolveRead;
  const f = fixture([channel(), () => new Promise((resolve) => { resolveRead = resolve; })]);
  await f.api.connect();
  const sending = f.api.postReply(options);
  await new Promise((resolve) => setImmediate(resolve));
  f.api.forgetConnection();
  resolveRead(Response.json(channel()));
  await assert.rejects(() => sending, { code: "oauthSignIn" });
  assert.equal(f.requests.some((request) => request.method === "POST"), false);
});

test("нет Chrome Identity — нет фиктивной успешной авторизации", async () => {
  const api = createYoutubeAccount({ identity: null });
  await assert.rejects(() => api.connect(), { code: "oauthUnavailable" });
});

test("новые статусы и ошибки переведены на русский и английский", () => {
  const keys = ["account.channel", "reply.oauthNotice", "reply.waitCollection", "reply.saved", "reply.storageFailed", "reply.localFailed", "reply.checkThread", "reply.connectFirst"];
  const errors = ["oauthUnavailable", "oauthConfiguration", "oauthCancelled", "oauthSignIn", "oauthExpired", "oauthPermissions", "oauthNoChannel", "oauthChannelAmbiguous", "oauthAccountChanged", "oauthBusy", "oauthNetwork", "apiQuota", "apiCommentsDisabled", "apiCommentMissing", "apiForbidden", "apiHttp", "apiMalformed", "replyTooLong", "replyUncertain"];
  for (const language of ["ru", "en"]) {
    const t = translatorFor(language);
    for (const key of [...keys, ...errors.map((code) => `error.${code}`)]) assert.notEqual(t(key), key);
  }
});
