// Live presentation of open_tab in a VISIBLE Firefox window (no screenshot).
// Launches a real Firefox with the built extension, opens the sidebar, calls
// open_tab through the real executeTool path so new tabs appear in the tab bar,
// then KEEPS THE WINDOW OPEN so you can watch/interact. Ctrl-C (or stopping the
// background task) closes it.
//
// Run: MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 node tests/ff-opentab-live.mjs

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
options.setPreference("xpinstall.signatures.required", false);

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();

async function shutdown() {
  try { await driver.quit(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await driver.manage().window().setRect({ width: 1280, height: 860 });
  await driver.manage().setTimeouts({ script: 25000 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1500);

  // Open an extension page, then drive open_tab through the SAME executeTool path
  // the in-sidebar agent uses. active:true so you SEE each tab open.
  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(1200);

  const res = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const agent = await import('/src/agent/agent.js');
      await agent.executeTool('open_tab', { url: 'https://example.org/' }, {});
      await new Promise(r => setTimeout(r, 900));
      await agent.executeTool('open_tab', { url: 'https://developer.mozilla.org/' }, {});
      const tabs = await browser.tabs.query({});
      done({ tabCount: tabs.length });
    })().catch(e => done({ error: String((e && e.stack) || e) }));
  `);
  console.log("open_tab result:", JSON.stringify(res));

  // Open the extension sidebar so the full Claude UI is visible next to the tabs.
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript(`
    try {
      const id = [...SidebarController.sidebars.keys()].find(k => /sidebar-action/.test(k));
      if (id) SidebarController.show(id);
    } catch (e) { /* sidebar optional */ }
  `);

  console.log("Firefox is open — watch the window. Tab bar shows the newly opened tabs.");
  // Keep-alive so the window stays open until the task is stopped.
  setInterval(() => console.log("still alive @", process.uptime().toFixed(0) + "s"), 30000);
  await new Promise(() => {});
} catch (e) {
  console.error("ERROR:", e);
  await shutdown();
}
