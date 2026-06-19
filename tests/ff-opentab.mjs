// Live proof of the open_tab tool: loads the built extension into a real
// (non-headless) Firefox, calls executeTool('open_tab', …) from the extension
// page so it actually opens new tabs, then screenshots the whole window
// (chrome context) so the tab bar shows the newly opened tabs.
//
// Run: MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 node tests/ff-opentab.mjs

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const out = join(__dirname, "_opentab.png");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
options.setPreference("xpinstall.signatures.required", false);

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
try {
  await driver.manage().window().setRect({ width: 1100, height: 760 });
  await driver.manage().setTimeouts({ script: 25000 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1500);

  // Load an extension page so we can import the agent modules and call the tool
  // through the SAME executeTool path the in-sidebar agent uses.
  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(1500);

  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const tools = await import('/src/agent/tools.js');
      const agent = await import('/src/agent/agent.js');
      const names = tools.buildTools({}).map(t => t.name);
      const schema = tools.buildTools({}).find(t => t.name === 'open_tab');
      const r1 = await agent.executeTool('open_tab', { url: 'https://example.org/' }, {});
      const r2 = await agent.executeTool('open_tab', { url: 'https://example.com/' }, {});
      // a rejected non-http url must error
      const rBad = await agent.executeTool('open_tab', { url: 'ftp://nope/' }, {});
      const tabs = await browser.tabs.query({});
      done({
        registered: names.includes('open_tab'),
        names,
        hasSchema: !!schema,
        r1: r1 && r1.content,
        r2: r2 && r2.content,
        rejectedNonHttp: !!(rBad && rBad.is_error),
        tabCount: tabs.length,
        tabUrls: tabs.map(t => t.url),
      });
    })().catch(e => done({ error: String((e && e.stack) || e) }));
  `);

  console.log(JSON.stringify(result, null, 2));

  await driver.sleep(2000); // let the tabs render
  await driver.setContext(firefox.Context.CHROME);
  const png = await driver.takeScreenshot();
  writeFileSync(out, png, "base64");
  console.log("screenshot ->", out);

  if (result.error) process.exitCode = 1;
  if (!result.registered || result.tabCount < 3 || !result.rejectedNonHttp) {
    console.error("FAIL: open_tab did not behave as expected");
    process.exitCode = 1;
  } else {
    console.log("PASS: open_tab registered, opened tabs, rejected non-http");
  }
} finally {
  await driver.quit();
}
