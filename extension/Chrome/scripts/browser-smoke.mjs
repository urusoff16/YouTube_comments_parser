import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runPersistenceChecks } from "./persistence-checks.mjs";

// Explicit development-only acceptance test; external requests never reach a real account.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE_PATH).href : "playwright");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = await mkdtemp(join(tmpdir(), "comment-tree-oauth-ui-"));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer(async (request, response) => {
  const path = resolve(root, `.${decodeURIComponent(new URL(request.url, "http://localhost").pathname)}`);
  if (!path.startsWith(`${root}${sep}`) || !types[extname(path)]) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.writeHead(200, { "Content-Type": types[extname(path)] }).end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
});
const errors = [];

async function boot(mode = "success", viewport = { width: 1280, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    const data = JSON.parse(localStorage.getItem("testChromePreferences") || "{}");
    const listeners = [];
    window.__smoke = { failStorage: false, authDenied: false, authCalls: [], helperTabs: 0, proxyRequests: Number(sessionStorage.getItem("testProxyRequests") || 0) };
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (window.__smoke.failStorage && args[1] === "readwrite" && args[0].includes("videoComments")) throw new Error("Test storage failure");
      return transaction.apply(this, args);
    };
    const endpoint = { continuationCommand: { token: "fixture-page" } };
    const html = `<script>ytcfg.set(${JSON.stringify({ INNERTUBE_API_KEY: "test-only", INNERTUBE_CONTEXT: { client: { clientName: "WEB", clientVersion: "fixture" } } })});</script><script>var ytInitialData = ${JSON.stringify({ sortFilterSubMenuRenderer: { subMenuItems: [{ serviceEndpoint: endpoint }] } })};</script>`;
    const comments = { commentRenderer: { commentId: "root-id", authorText: { simpleText: "@viewer" }, contentText: { simpleText: "Спасибо за видео! Когда будет продолжение?" }, publishedTimeText: { simpleText: "вчера" } } };
    window.chrome = {
      runtime: { id: "abcdefghijklmnopabcdefghijklmnop", getURL: (path) => `${location.origin}/${path}` },
      i18n: { getUILanguage: () => "ru" },
      storage: {
        local: {
          async get(key) { return key ? { [key]: data[key] } : { ...data }; },
          async set(values) {
            const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: data[key], newValue }]));
            Object.assign(data, values);
            localStorage.setItem("testChromePreferences", JSON.stringify(data));
            for (const callback of listeners) callback(changes, "local");
          },
        },
        onChanged: { addListener(callback) { listeners.push(callback); } },
      },
      identity: {
        async getAuthToken(details) {
          window.__smoke.authCalls.push(details);
          if (window.__smoke.authDenied) throw new Error("The user did not approve access.");
          return { token: "test-only-token", grantedScopes: ["https://www.googleapis.com/auth/youtube.force-ssl"] };
        },
        async clearAllCachedAuthTokens() {},
        async removeCachedAuthToken() {},
      },
      tabs: {
        async query() { return [{ id: 5, url: "https://www.youtube.com/watch?v=i2NB2bRZO-Y" }]; },
        async create() { window.__smoke.helperTabs += 1; throw new Error("Unexpected helper tab"); },
        async sendMessage(id, message) {
          if (message.type === "youtube-comments-proxy-ping") return { ok: true };
          window.__smoke.proxyRequests += 1;
          sessionStorage.setItem("testProxyRequests", String(window.__smoke.proxyRequests));
          return { ok: true, response: { ok: true, status: 200, body: message.method === "POST" ? JSON.stringify(comments) : html } };
        },
      },
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  let posts = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.origin !== "https://www.googleapis.com") return route.abort();
    if (url.pathname.endsWith("/channels")) {
      return route.fulfill({ json: { items: [{ id: "UC-test", snippet: { title: "Мой тестовый канал" } }] } });
    }
    assert.equal(url.pathname, "/youtube/v3/comments");
    assert.equal(route.request().method(), "POST");
    posts += 1;
    const body = route.request().postDataJSON();
    assert.equal(body.snippet.parentId, "root-id");
    if (mode === "uncertain") return route.abort();
    return route.fulfill({ json: { id: "mock-reply-id", snippet: { ...body.snippet, authorDisplayName: "Мой тестовый канал", authorChannelId: { value: "UC-test" }, publishedAt: "2026-10-16T12:00:00Z" } } });
  });
  await page.goto(`${origin}/collector.html?url=${encodeURIComponent("https://www.youtube.com/watch?v=i2NB2bRZO-Y")}&sourceTabId=5&action=collect`);
  await page.locator(".badge--done").waitFor();
  assert.equal(await page.locator("#total-count").textContent(), "1");
  assert.equal(await page.locator(".comment__reply-button").isDisabled(), true);
  return { context, page, get posts() { return posts; } };
}

async function connectAndCompose(page) {
  await page.locator("#account-connect").click();
  await page.locator("#account-channel").waitFor({ state: "visible" });
  assert.match(await page.locator("#account-channel").textContent(), /UC-test/);
  await page.locator(".comment__reply-button").first().click();
  await page.locator(".reply-composer__input").fill("Спасибо за вопрос! Продолжение готовится.");
}

try {
  const success = await boot();
  await connectAndCompose(success.page);
  await success.page.evaluate(() => scrollTo(0, 0));
  await success.page.screenshot({ path: join(artifacts, "oauth-dark.png"), fullPage: true });
  await success.page.locator("#theme-toggle").click();
  await success.page.evaluate(() => scrollTo(0, 0));
  await success.page.screenshot({ path: join(artifacts, "oauth-light.png"), fullPage: true });
  await success.page.locator(".reply-composer").evaluate((form) => { form.requestSubmit(); form.requestSubmit(); });
  await success.page.locator('.reply-composer[data-state="sent"]').waitFor();
  await success.page.waitForFunction(() => document.querySelector("#total-count").textContent === "2");
  assert.equal(success.posts, 1);
  const saved = await success.page.evaluate(async () => {
    const db = await import("/src/database.js");
    const connection = await db.openCommentDatabase("i2NB2bRZO-Y");
    const comments = await db.readComments(connection);
    connection.close();
    return { comments, preferences: await chrome.storage.local.get(), helpers: window.__smoke.helperTabs };
  });
  assert.equal(saved.comments.length, 2);
  assert.equal(saved.comments[0].reply_count, 1);
  assert.equal(saved.comments[1].comment_id, "mock-reply-id");
  assert.equal(JSON.stringify(saved).includes("test-only-token"), false);
  assert.equal(saved.helpers, 0);
  assert.match(await success.page.locator('[data-comment-id="mock-reply-id"] .youtube-link').getAttribute("href"), /lc=mock-reply-id/);
  await success.page.locator(".reply-composer__cancel").click();
  await success.page.locator("#language").selectOption("en");
  await success.page.waitForFunction(() => document.documentElement.lang === "en");
  await success.page.locator("#account-disconnect").click();
  await success.page.locator("#account-connect").waitFor({ state: "visible" });
  assert.equal(await success.page.locator(".comment__reply-button").first().isDisabled(), true);
  await success.context.close();

  const uncertain = await boot("uncertain");
  await connectAndCompose(uncertain.page);
  await uncertain.page.locator(".reply-composer__send").click();
  await uncertain.page.locator('.reply-composer[data-state="uncertain"]').waitFor();
  assert.equal(await uncertain.page.locator(".reply-composer__send").isDisabled(), true);
  assert.equal(await uncertain.page.locator(".reply-composer__input").inputValue(), "Спасибо за вопрос! Продолжение готовится.");
  assert.equal(uncertain.posts, 1);
  await uncertain.page.reload();
  await uncertain.page.locator("#account-channel").waitFor({ state: "visible" });
  await uncertain.page.locator(".comment__reply-button").first().click();
  await uncertain.page.locator('.reply-composer[data-state="uncertain"]').waitFor();
  assert.equal(await uncertain.page.locator(".reply-composer__send").isDisabled(), true);
  assert.equal(uncertain.posts, 1, "Reload retried an uncertain post");
  await uncertain.context.close();

  const storageFailure = await boot();
  await connectAndCompose(storageFailure.page);
  await storageFailure.page.evaluate(() => { window.__smoke.failStorage = true; });
  await storageFailure.page.locator(".reply-composer__send").click();
  await storageFailure.page.locator('.reply-composer[data-state="sent"]').waitFor();
  await storageFailure.page.waitForFunction(() => document.querySelector(".reply-composer__notice").textContent.includes("локальная запись"));
  await storageFailure.page.locator(".reply-composer").evaluate((form) => form.requestSubmit());
  assert.equal(storageFailure.posts, 1);
  assert.equal(await storageFailure.page.locator(".reply-composer__send").isDisabled(), true);
  await storageFailure.context.close();

  const mobile = await boot("success", { width: 390, height: 844 });
  await mobile.page.evaluate(() => { window.__smoke.authDenied = true; });
  await mobile.page.locator("#account-connect").click();
  await mobile.page.waitForFunction(() => document.querySelector("#account-status").textContent.includes("отменён"));
  assert.equal(await mobile.page.locator("#account-channel").isVisible(), false);
  await mobile.page.locator("#theme-toggle").click();
  await mobile.page.evaluate(() => scrollTo(0, 0));
  await mobile.page.screenshot({ path: join(artifacts, "oauth-mobile-light.png"), fullPage: true });
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Page overflows mobile viewport");
  await mobile.context.close();
  const persistence = await runPersistenceChecks({ browser, origin, boot, connectAndCompose });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, scenarios: ["reply-and-local-export", "single-submit", "disconnect", "unknown-result", "local-storage-failure", "cancel-sign-in", "ru-en", "dark-light", "mobile", "unknown-result-after-reload", ...persistence], artifacts }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
