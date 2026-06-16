// Loads the built extension into a real (headless) Firefox via Selenium/
// geckodriver, opens the sidebar panel page, and verifies the ES-module graph
// loaded and the UI rendered. Saves a screenshot of the real Firefox UI.

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

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
  // Approximate the real docked-sidebar width so the layout is representative.
  await driver.manage().window().setRect({ width: 380, height: 760 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1500);

  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(2500);

  const facts = await driver.executeScript(`
    const g = (id) => document.getElementById(id);
    return {
      title: document.title,
      modelOptions: g('model-select') ? g('model-select').options.length : -1,
      modelLabels: g('model-select') ? [...g('model-select').options].map(o=>o.textContent) : [],
      setModelOptions: g('set-model') ? g('set-model').options.length : -1,
      settingsOverlayVisible: g('settings') ? g('settings').hidden === false : null,
      hasComposer: !!g('composer'),
      hasApiKeyField: !!g('set-apikey'),
      tabTitle: g('tab-title') ? g('tab-title').textContent : null
    };
  `);
  console.log("FACTS", JSON.stringify(facts, null, 2));

  // Check IndexedDB got a session created on init (proves db.js works in FF).
  const sessionCount = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const req = indexedDB.open('claude-firefox');
    req.onsuccess = () => {
      try {
        const db = req.result;
        const tx = db.transaction('sessions','readonly');
        const c = tx.objectStore('sessions').count();
        c.onsuccess = () => done(c.result);
        c.onerror = () => done('count-error');
      } catch (e) { done('tx-error:' + e.message); }
    };
    req.onerror = () => done('open-error');
  `);
  console.log("SESSIONS_IN_IDB", sessionCount);

  const png = await driver.takeScreenshot();
  const out = join(__dirname, "ff-panel.png");
  writeFileSync(out, png, "base64");
  console.log("SCREENSHOT", out);

  // Simple pass/fail
  const ok = facts.modelOptions === 3 && facts.hasComposer && facts.hasApiKeyField;
  console.log("RESULT", ok ? "PASS — sidebar UI rendered in real Firefox" : "FAIL — see FACTS");
} finally {
  await driver.quit();
}
