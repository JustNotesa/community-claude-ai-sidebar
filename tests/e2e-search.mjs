// Demo: real Firefox + extension performs an example SEARCH, then screenshots
// the resulting window (search result + the docked Claude sidebar).

import { Builder, By } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/claude_for_firefox-0.1.0.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";
const apiKey = process.env.ANTHROPIC_KEY;
const SEARCH_URL = "https://de.wikipedia.org/";
const task =
  process.argv[2] ||
  'Nutze das Suchfeld dieser Seite, suche nach "Mozilla Firefox" und sende die Suche ab. Nenne mir danach in EINEM Satz, was der erste Absatz des gefundenen Artikels aussagt.';

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
options.setPreference("xpinstall.signatures.required", false);
options.setPreference("extensions.webextOptionalPermissionPrompts", false);

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
try {
  await driver.manage().window().setRect({ width: 1280, height: 860 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1200);

  // tab 1: the search site
  await driver.get(SEARCH_URL);
  await driver.sleep(1500);
  const siteHandle = (await driver.getAllWindowHandles())[0];

  // tab 2: hidden harness drives the agent against tab 1
  await driver.switchTo().newWindow("tab");
  await driver.get(`moz-extension://${UUID}/e2e/harness.html`);
  await driver.sleep(800);
  await driver.findElement(By.id("key")).sendKeys(apiKey);
  await driver.findElement(By.id("task")).sendKeys(task);
  await driver.findElement(By.id("run")).click();

  let res = null;
  for (let i = 0; i < 90; i++) {
    res = await driver.executeScript("return window.__e2eResult || null;");
    if (res) break;
    await driver.sleep(2000);
  }
  console.log(
    "SEARCH_RESULT",
    JSON.stringify({ done: res?.done, tools: res?.tools, error: res?.error, text: res?.text }, null, 2)
  );

  // Show the result tab + open the sidebar, then screenshot the whole window.
  await driver.switchTo().window(siteHandle);
  await driver.sleep(1000);
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(`
    const SC = window.SidebarController || window.SidebarUI;
    const keys = SC && SC.sidebars ? [...SC.sidebars.keys()] : [];
    const v = keys.find(k => /sidebar-action/.test(k));
    if (SC && v) SC.show(v);
  `);
  await driver.sleep(2000);
  const png = await driver.takeScreenshot();
  writeFileSync(join(__dirname, "e2e-search.png"), png, "base64");
  console.log("SCREENSHOT -> e2e-search.png");
} finally {
  await driver.quit();
}
