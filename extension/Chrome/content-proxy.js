if (!globalThis.__commentTreeExporterProxyInstalled) {
  globalThis.__commentTreeExporterProxyInstalled = true;
  const ALLOWED_HOST = "www.youtube.com";
  const ALLOWED_PATHS = ["/watch", "/youtubei/"];

  function isAllowedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:"
        && url.hostname === ALLOWED_HOST
        && ALLOWED_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(path));
    } catch {
      return false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "youtube-comments-proxy-ping") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type !== "youtube-comments-proxy-fetch") return false;
    if (!isAllowedUrl(message.url)) {
      sendResponse({ ok: false, errorCode: "proxyBlocked", error: "Расширение заблокировало запрос к постороннему адресу." });
      return false;
    }

    (async () => {
      try {
        const response = await fetch(message.url, {
          method: message.method ?? "GET",
          credentials: "include",
          headers: message.headers ?? {},
          body: message.body ?? undefined,
        });
        sendResponse({
          ok: true,
          response: {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            body: await response.text(),
          },
        });
      } catch (error) {
        sendResponse({ ok: false, errorCode: "proxyNetwork", error: error.message || "Сетевая ошибка во вкладке YouTube." });
      }
    })();
    return true;
  });
}
