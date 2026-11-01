import { normalizeYoutubeUrl } from "./src/youtube.js";
import { initializeThemeToggle } from "./src/theme.js";
import { initializeLanguageSelect } from "./src/i18n.js";
import { localizedErrorMessage } from "./src/errors.js";

const form = document.querySelector("#export-form");
const urlInput = document.querySelector("#video-url");
const errorOutput = document.querySelector("#error");
const languageSelect = document.querySelector("#language");
const preferenceIds = ["sort", "format", "limit", "delay"];
let activeTab = null;
let themeController;
const languageController = await initializeLanguageSelect(languageSelect, {
  onChange: () => themeController?.refresh(),
});
const t = (key, values) => languageController.t(key, values);

function showError(message) {
  errorOutput.textContent = message;
  errorOutput.hidden = !message;
}

async function restorePreferences() {
  const preferences = await chrome.storage.local.get("exportPreferences");
  for (const id of preferenceIds) {
    const value = preferences.exportPreferences?.[id];
    if (value !== undefined) document.querySelector(`#${id}`).value = value;
  }
}

async function fillCurrentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab ?? null;
  try {
    if (tab?.url) urlInput.value = normalizeYoutubeUrl(tab.url);
  } catch {
    // A non-YouTube tab is normal: the user can paste a URL manually.
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");

  let url;
  try {
    url = normalizeYoutubeUrl(urlInput.value.trim());
  } catch (error) {
    showError(localizedErrorMessage(error, t));
    urlInput.focus();
    return;
  }

  const values = Object.fromEntries(new FormData(form));
  const preferences = {
    ...Object.fromEntries(preferenceIds.map((id) => [id, values[id] ?? ""])),
    language: languageController.preference,
  };
  await chrome.storage.local.set({ exportPreferences: preferences });

  const queryValues = { ...preferences, url, action: "collect" };
  try {
    if (activeTab?.id && normalizeYoutubeUrl(activeTab.url ?? "") === url) {
      queryValues.sourceTabId = String(activeTab.id);
    }
  } catch {
    // The collector will open a background YouTube tab when the current tab is unsuitable.
  }
  const query = new URLSearchParams(queryValues);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`collector.html?${query}`) });
  window.close();
});

await Promise.all([
  restorePreferences(),
  fillCurrentTabUrl(),
]);
themeController = await initializeThemeToggle(
  document.querySelector("#theme-toggle"),
  document.documentElement,
  t,
);
