import { initializeLanguageSelect } from "./src/i18n.js";

const select = document.querySelector("#language");
let controller;

function showActiveLanguage() {
  for (const panel of document.querySelectorAll("[data-language-panel]")) {
    panel.hidden = panel.dataset.languagePanel !== controller.language;
  }
}

controller = await initializeLanguageSelect(select, { onChange: showActiveLanguage });
showActiveLanguage();
