// Full end-to-end run in real Firefox: load the extension, open a real page +
// the harness, and have the agent perform a task using the real Claude API.

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
const task =
  process.argv[2] || "Fasse den Inhalt dieser Seite in einem Satz zusammen und nenne den enthaltenen Link.";

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
options.setPreference("xpinstall.signatures.required", false);
options.setPreference("extensions.webextOptionalPermissionPrompts", false); // auto-grant optional perms

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
try {
  await driver.installAddon(xpi, true);
  await driver.sleep(1200);

  // tab 1: a real web page
  await driver.get("https://example.com/");
  await driver.sleep(800);

  // tab 2: the harness (extension page)
  await driver.switchTo().newWindow("tab");
  await driver.get(`moz-extension://${UUID}/e2e/harness.html`);
  await driver.sleep(800);

  await driver.findElement(By.id("key")).sendKeys(apiKey);
  await driver.findElement(By.id("task")).sendKeys(task);
  await driver.findElement(By.id("run")).click();

  let res = null;
  for (let i = 0; i < 75; i++) {
    res = await driver.executeScript("return window.__e2eResult || null;");
    if (res) break;
    await driver.sleep(2000);
  }

  console.log("E2E_RESULT", JSON.stringify(res, null, 2));

  // screenshot the harness for the record
  try {
    const png = await driver.takeScreenshot();
    writeFileSync(join(__dirname, "e2e-result.png"), png, "base64");
  } catch (_) {}
} finally {
  await driver.quit();
}
