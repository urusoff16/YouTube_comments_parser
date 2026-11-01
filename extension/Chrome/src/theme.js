const STORAGE_KEY = "appearanceTheme";
const DARK = "dark";
const LIGHT = "light";

export function normalizeTheme(value) {
  return value === LIGHT ? LIGHT : DARK;
}

export function nextTheme(value) {
  return normalizeTheme(value) === DARK ? LIGHT : DARK;
}

export function applyTheme(theme, root = document.documentElement) {
  const normalized = normalizeTheme(theme);
  root.dataset.theme = normalized;
  root.style.colorScheme = normalized;
  return normalized;
}

function renderButton(button, theme, translate = (key) => ({
  "theme.light": "Светлая",
  "theme.dark": "Тёмная",
  "theme.enableLight": "Включить светлую тему",
  "theme.enableDark": "Включить тёмную тему",
}[key] ?? key)) {
  const lightIsNext = theme === DARK;
  const icon = button.querySelector(".theme-toggle__icon");
  const label = button.querySelector(".theme-toggle__label");
  if (icon) icon.textContent = lightIsNext ? "☀" : "☾";
  if (label) label.textContent = translate(lightIsNext ? "theme.light" : "theme.dark");
  button.title = translate(lightIsNext ? "theme.enableLight" : "theme.enableDark");
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", String(theme === LIGHT));
}

export async function initializeThemeToggle(button, root = document.documentElement, translate) {
  const saved = await chrome.storage.local.get(STORAGE_KEY);
  let current = applyTheme(saved[STORAGE_KEY], root);
  renderButton(button, current, translate);

  button.addEventListener("click", async () => {
    current = applyTheme(nextTheme(current), root);
    renderButton(button, current, translate);
    await chrome.storage.local.set({ [STORAGE_KEY]: current });
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[STORAGE_KEY]) return;
    current = applyTheme(changes[STORAGE_KEY].newValue, root);
    renderButton(button, current, translate);
  });
  return {
    get current() { return current; },
    refresh() { renderButton(button, current, translate); },
  };
}
