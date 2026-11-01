import test from "node:test";
import assert from "node:assert/strict";

import { createYoutubeRequester } from "../src/request-proxy.js";

test("передает запрос через content script вкладки YouTube", async () => {
  const messages = [];
  globalThis.chrome = {
    tabs: {
      async sendMessage(tabId, message) {
        messages.push({ tabId, message });
        if (message.type === "youtube-comments-proxy-ping") return { ok: true };
        return {
          ok: true,
          response: {
            ok: true,
            status: 200,
            statusText: "OK",
            body: '{"comments":5}',
          },
        };
      },
      async create() {
        throw new Error("Не должна создаваться новая вкладка");
      },
    },
  };

  const request = await createYoutubeRequester({
    preferredTabId: 42,
    videoUrl: "https://www.youtube.com/watch?v=i2NB2bRZO-Y",
  });
  const response = await request("https://www.youtube.com/youtubei/v1/next?key=test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"continuation":"token"}',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { comments: 5 });
  assert.equal(messages[0].message.type, "youtube-comments-proxy-ping");
  assert.equal(messages[1].message.type, "youtube-comments-proxy-fetch");
  assert.equal(messages[1].tabId, 42);
  assert.equal(messages[1].message.method, "POST");
});

test("переиспользует открытую вкладку YouTube вместо создания новой", async () => {
  let createCalls = 0;
  globalThis.chrome = {
    tabs: {
      async query() {
        return [
          { id: 77, url: "https://www.youtube.com/watch?v=i2NB2bRZO-Y" },
          { id: 78, url: "https://www.youtube.com/" },
        ];
      },
      async sendMessage(tabId, message) {
        if (message.type === "youtube-comments-proxy-ping") return { ok: tabId === 77 };
        return { ok: true, response: { ok: true, status: 200, statusText: "OK", body: "{}" } };
      },
      async create() {
        createCalls += 1;
        return { id: 99 };
      },
    },
  };

  const request = await createYoutubeRequester({
    videoUrl: "https://www.youtube.com/watch?v=i2NB2bRZO-Y",
  });
  assert.equal(request.tabId, 77);
  assert.equal(request.ownedTab, false);
  assert.equal(createCalls, 0);
});

test("подключает посредник к уже открытой вкладке после обновления расширения", async () => {
  let injected = false;
  let createCalls = 0;
  globalThis.chrome = {
    scripting: {
      async executeScript(details) {
        assert.deepEqual(details, { target: { tabId: 42 }, files: ["content-proxy.js"] });
        injected = true;
      },
    },
    tabs: {
      async sendMessage(_tabId, message) {
        if (message.type === "youtube-comments-proxy-ping") return injected ? { ok: true } : undefined;
        return { ok: true, response: { ok: true, status: 200, statusText: "OK", body: "{}" } };
      },
      async query() { return []; },
      async create() {
        createCalls += 1;
        return { id: 99 };
      },
    },
  };

  const request = await createYoutubeRequester({
    preferredTabId: 42,
    videoUrl: "https://www.youtube.com/watch?v=i2NB2bRZO-Y",
  });
  assert.equal(request.tabId, 42);
  assert.equal(request.ownedTab, false);
  assert.equal(injected, true);
  assert.equal(createCalls, 0);
});
