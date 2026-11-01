import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { translatorFor } from "../src/i18n.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("каждый статический ключ интерфейса существует в обеих локалях", async () => {
  const files = await Promise.all([
    "popup.html",
    "collector.html",
    "privacy.html",
  ].map((name) => readFile(resolve(projectRoot, name), "utf8")));
  const keys = new Set(files.flatMap((html) => (
    [...html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)].map((match) => match[1])
  )));

  for (const language of ["ru", "en"]) {
    const translate = translatorFor(language);
    for (const key of keys) assert.notEqual(translate(key), key, `${language}: ${key}`);
  }
});

test("локализованные поля manifest имеют допустимую структуру", async () => {
  const manifest = JSON.parse(await readFile(resolve(projectRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.default_locale, "en");
  assert.match(manifest.name, /^__MSG_.+__$/);
  for (const language of ["ru", "en"]) {
    const messages = JSON.parse(await readFile(resolve(projectRoot, `_locales/${language}/messages.json`), "utf8"));
    assert.ok(messages.extensionName.message.length <= 45);
    assert.ok(messages.extensionDescription.message.length <= 132);
  }
});
