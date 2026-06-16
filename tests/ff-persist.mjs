// Proves the API key persists across sidebar reopens WITHIN one profile:
// set a key in storage, reload the panel, and confirm settings is NOT re-prompted.

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/claude_for_firefox-0.1.0.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";

const options = new firefox.Options();
options.addArguments("-headless");
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
options.setPreference("xpinstall.signatures.required", false);

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
try {
  await driver.installAddon(xpi, true);
  await driver.sleep(1200);
  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(1500);

  // First load: no key → settings overlay should be OPEN.
  const firstHidden = await driver.executeScript("return document.getElementById('settings').hidden");

  // Save a key the way the UI does, then reload the panel.
  await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const api = (typeof browser !== "undefined" && browser) || chrome;
    api.storage.local.set({ "claude.settings": {
      authMethod: "apikey", apiKey: "sk-ant-persist-test-123",
      model: "claude-opus-4-8", effort: "high"
    } }).then(() => done(true));
  `);
  await driver.navigate().refresh();
  await driver.sleep(1500);

  // Second load: key restored from storage → settings overlay should be HIDDEN.
  const after = await driver.executeScript(`
    const api = (typeof browser !== "undefined" && browser) || chrome;
    return { settingsHidden: document.getElementById('settings').hidden };
  `);
  const stored = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const api = (typeof browser !== "undefined" && browser) || chrome;
    api.storage.local.get("claude.settings").then((g) => done(g["claude.settings"]?.apiKey || null));
  `);

  console.log(JSON.stringify({
    firstLoad_settingsOpen: firstHidden === false,
    afterReload_settingsHidden: after.settingsHidden,
    keyStillInStorage: stored,
    RESULT: after.settingsHidden === true ? "PERSISTS — kein erneutes Fragen" : "FAIL — fragt erneut",
  }, null, 2));
} finally {
  await driver.quit();
}
