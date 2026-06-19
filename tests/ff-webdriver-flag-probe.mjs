// Can we hide navigator.webdriver under geckodriver, and is that enough for
// Cloudflare on claude.ai? Launches a visible Firefox with dom.webdriver.enabled=false,
// reads the flag, then loads claude.ai/login and screenshots the result.
// Run: MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 node tests/ff-webdriver-flag-probe.mjs
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "../web-ext-artifacts");

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.addArguments("-no-remote");
options.setPreference("dom.webdriver.enabled", false); // attempt to hide navigator.webdriver
options.setPreference("useAutomationExtension", false);
options.windowSize({ width: 1100, height: 860 });

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
const out = {};
try {
  await driver.get("about:blank");
  out.webdriver_on_blank = await driver.executeScript("return navigator.webdriver;");

  await driver.get("https://claude.ai/login");
  await driver.sleep(6000);
  out.webdriver_on_claude = await driver.executeScript("return navigator.webdriver;");
  out.title = await driver.getTitle();
  out.url = await driver.getCurrentUrl();
  const bodyText = await driver.executeScript(
    "return (document.body && document.body.innerText || '').slice(0, 400);"
  );
  out.challenge =
    /Sicherheitsüberprüfung|kein Bot|Just a moment|Cloudflare|verify you are human|Mensch sind/i.test(
      bodyText
    );
  out.bodyHead = bodyText.replace(/\s+/g, " ").slice(0, 200);
  writeFileSync(join(OUT, "shot-claude-login.png"), await driver.takeScreenshot(), "base64");
} catch (e) {
  out.error = String((e && e.message) || e);
} finally {
  console.log("RESULT " + JSON.stringify(out, null, 2));
  await driver.quit();
}
