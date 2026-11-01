import { extensionError } from "./errors.js";

const PING_MESSAGE = { type: "youtube-comments-proxy-ping" };

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pingTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, PING_MESSAGE);
    return response?.ok === true;
  } catch {
    return false;
  }
}

async function waitForProxy(tabId, attempts) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await pingTab(tabId)) return true;
    await wait(250);
  }
  return false;
}

async function ensureProxy(tabId) {
  if (await waitForProxy(tabId, 2)) return true;
  if (!chrome.scripting?.executeScript) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-proxy.js"],
    });
  } catch {
    return false;
  }
  return waitForProxy(tabId, 4);
}

function sameVideo(tabUrl, videoUrl) {
  try {
    const tab = new URL(tabUrl);
    const video = new URL(videoUrl);
    return tab.hostname.endsWith("youtube.com")
      && tab.searchParams.get("v") === video.searchParams.get("v");
  } catch {
    return false;
  }
}

async function reusableYoutubeTab(videoUrl, excludedTabId) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  } catch {
    return null;
  }
  tabs.sort((left, right) => Number(sameVideo(right.url, videoUrl)) - Number(sameVideo(left.url, videoUrl)));
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || tab.id === excludedTabId) continue;
    if (await ensureProxy(tab.id)) return tab.id;
  }
  return null;
}

async function resolveProxyTab(preferredTabId, videoUrl, onStatus, translate) {
  if (Number.isInteger(preferredTabId) && await ensureProxy(preferredTabId)) {
    return { tabId: preferredTabId, ownedTab: false };
  }

  const reusableTabId = await reusableYoutubeTab(videoUrl, preferredTabId);
  if (reusableTabId !== null) return { tabId: reusableTabId, ownedTab: false };

  onStatus?.(translate?.("status.openingHelperTab") ?? "Открываю служебную вкладку YouTube для запросов…");
  const tab = await chrome.tabs.create({ url: videoUrl, active: false });
  if (!Number.isInteger(tab.id) || !await waitForProxy(tab.id, 80)) {
    throw extensionError("proxyConnection", "Не удалось подключиться к вкладке YouTube. Обновите страницу видео и повторите запуск.");
  }
  return { tabId: tab.id, ownedTab: true };
}

function responseFromMessage(message) {
  const payload = message.response;
  return {
    ok: payload.ok,
    status: payload.status,
    statusText: payload.statusText,
    async text() { return payload.body; },
    async json() { return JSON.parse(payload.body); },
  };
}

export async function createYoutubeRequester({ preferredTabId, videoUrl, onStatus, t }) {
  const { tabId, ownedTab } = await resolveProxyTab(preferredTabId, videoUrl, onStatus, t);
  const requester = async function requestThroughYoutubeTab(url, init = {}) {
    const headers = init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : { ...(init.headers ?? {}) };
    let message;
    try {
      message = await chrome.tabs.sendMessage(tabId, {
        type: "youtube-comments-proxy-fetch",
        url: String(url),
        method: init.method ?? "GET",
        headers,
        body: init.body ?? null,
      });
    } catch (error) {
      throw extensionError("proxyLost", "Связь со вкладкой YouTube потеряна. Не закрывайте и не обновляйте её во время выгрузки.", {}, { cause: error });
    }
    if (!message?.ok) {
      throw extensionError(message?.errorCode || "proxyFailed", message?.error || "Вкладка YouTube не выполнила запрос.");
    }
    return responseFromMessage(message);
  };
  requester.tabId = tabId;
  requester.ownedTab = ownedTab;
  return requester;
}
