// Self-contained check of the in-addon per-conversation container + tab memory.
// Launches its OWN clean Firefox, loads the built extension, exercises the real
// extension code for TWO conversations, prints a verdict, and quits.
// Run: node tests/ff-feature-check.mjs

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";

const options = new firefox.Options();
options.addArguments("-headless");
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
options.setPreference("xpinstall.signatures.required", false);
options.setPreference("privacy.userContext.enabled", true);

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
try {
  await driver.manage().setTimeouts({ script: 45000 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1200);
  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(800);

  const r = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      try {
        const db = await import('/src/storage/db.js');
        const containers = await import('/src/util/containers.js');
        const agent = await import('/src/agent/agent.js');
        const open = (url, s) => agent.executeTool('open_tab', { url, active: false }, { session: s });
        const inCS = async (cs) => (await browser.tabs.query({})).filter((t) => t.cookieStoreId === cs).length;

        const A = await db.createSession({ title: 'Konv-A' });
        await open('https://example.com/', A);
        await open('https://example.net/', A);
        const B = await db.createSession({ title: 'Konv-B' });
        await open('https://example.org/', B);
        await wait(1500);

        const Ad = await db.getSession(A.id), Bd = await db.getSession(B.id);
        const csA = Ad.cookieStoreId, csB = Bd.cookieStoreId;

        const rep = {
          A_remembered: (Ad.tabs || []).length,
          B_remembered: (Bd.tabs || []).length,
          containersDistinct: !!csA && !!csB && csA !== csB,
          A_open: await inCS(csA), B_open: await inCS(csB),
          A_missing: (await containers.missingTabs(A.id)).length,
          B_missing: (await containers.missingTabs(B.id)).length,
        };
        rep.A_stats = await containers.sessionTabStats(A.id); // expect {open:2,missing:0}
        rep.A_shown = await containers.showSessionTabs(A.id);  // expect 2

        for (const t of await browser.tabs.query({})) {
          if (t.cookieStoreId === csA) { try { await browser.tabs.remove(t.id); } catch (e) {} }
        }
        await wait(400);
        rep.A_missing_afterClose = (await containers.missingTabs(A.id)).length;
        rep.B_missing_afterClose = (await containers.missingTabs(B.id)).length;
        rep.A_reopened = await containers.restoreSessionTabs(A.id);
        await wait(1200);
        rep.A_open_final = await inCS(csA);
        rep.B_open_final = await inCS(csB);
        rep.A_missing_final = (await containers.missingTabs(A.id)).length;

        const ok =
          rep.A_remembered === 2 && rep.B_remembered === 1 && rep.containersDistinct &&
          rep.A_open === 2 && rep.B_open === 1 && rep.A_missing === 0 && rep.B_missing === 0 &&
          rep.A_missing_afterClose === 2 && rep.B_missing_afterClose === 0 &&
          rep.A_reopened === 2 && rep.A_open_final === 2 && rep.B_open_final === 1 &&
          rep.A_missing_final === 0 &&
          rep.A_stats.open === 2 && rep.A_stats.missing === 0 && rep.A_shown === 2;
        done({ ok, ...rep });
      } catch (e) { done({ error: String((e && e.stack) || e) }); }
    })();
  `);

  console.log(JSON.stringify(r, null, 2));
  console.log(r.ok ? "PASS ✅" : "FAIL ❌");
  if (!r.ok) process.exitCode = 1;
} finally {
  await driver.quit();
}
