// Verifies the usage feature end-to-end with the REAL logged-in token: runs on
// the persistent claude-ff-profile (where the human login stored claude.oauth),
// opens panel.html, clicks the "Nutzung" button (→ openUsage → refreshLimits probe)
// and reads back the rendered limits + the toolbar ring fill.
// Run: MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 node e2e/screenshot-usage-live.js
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";
const profileDir = join(homedir(), "claude-ff-profile");
const OUT = join(__dirname, "../web-ext-artifacts");

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.addArguments("-no-remote", "-profile", profileDir);
options.windowSize({ width: 480, height: 900 }); // sidebar-ish width
const service = new firefox.ServiceBuilder().addArguments("--marionette-port", "2832");

const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxService(service)
  .setFirefoxOptions(options)
  .build();
const out = {};
try {
  await driver.manage().setTimeouts({ script: 60000 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1500);
  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(2500);

  const info = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const api = (typeof browser !== "undefined" && browser) || chrome;
      const g = await api.storage.local.get("claude.oauth");
      const loggedIn = !!(g["claude.oauth"] && g["claude.oauth"].access_token);
      const btn = document.getElementById("btn-usage");
      if (btn) btn.click(); // openUsage() → refreshLimits() probe
      done({ loggedIn });
    })().catch((e) => done({ error: String(e) }));
  `);
  out.loggedIn = info.loggedIn;

  await driver.sleep(7000); // wait for the max_tokens:1 probe to return + render
  out.context = await driver.executeScript(
    "return (document.getElementById('usage-context-val')||{}).textContent;"
  );
  out.windows = await driver.executeScript(`
    return [...document.querySelectorAll('#usage-windows .usage-block')].map(b => ({
      label: (b.querySelector('.usage-row-head span') || {}).textContent,
      pct: (b.querySelector('.pct') || {}).textContent,
      detail: (b.querySelector('.usage-sub') || {}).textContent || "",
    }));
  `);
  out.ringDash = await driver.executeScript(
    "var a=document.querySelector('#btn-usage .arc'); return a && a.getAttribute('stroke-dasharray');"
  );
  out.btnTitle = await driver.executeScript(
    "return (document.getElementById('btn-usage')||{}).title;"
  );
  writeFileSync(join(OUT, "shot-usage-live.png"), await driver.takeScreenshot(), "base64");
} catch (e) {
  out.error = String((e && e.stack) || e);
} finally {
  console.log("RESULT " + JSON.stringify(out, null, 2));
  await driver.quit();
}
