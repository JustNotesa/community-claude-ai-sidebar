// Diagnostic: do TWO conversations keep their tabs separate, and do the counts
// add up? Drives the real extension code in the live keeper.
// Run: node tests/ff-containers.mjs

import selenium from "selenium-webdriver";
import httpMod from "selenium-webdriver/http/index.js";
import commandMod from "selenium-webdriver/lib/command.js";
import { loadHandle } from "./ff-lib.mjs";

const { WebDriver, Session, Capabilities } = selenium;
const { Executor, HttpClient } = httpMod;
const { Command } = commandMod;

const info = loadHandle();
const executor = new Executor(new HttpClient(info.url));
executor.defineCommand("setContext", "POST", "/session/:sessionId/moz/context");
const driver = new WebDriver(new Session(info.sessionId, new Capabilities()), executor);
const setContext = (ctx) => driver.execute(new Command("setContext").setParameter("context", ctx));

try {
  await setContext("content");
  await driver.manage().setTimeouts({ script: 45000 });
  await driver.switchTo().newWindow("tab");
  await driver.get(`moz-extension://${info.uuid}/sidebar/panel.html`);
  await driver.sleep(1200);

  const result = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      try {
        const db = await import('/src/storage/db.js');
        const containers = await import('/src/util/containers.js');
        const agent = await import('/src/agent/agent.js');

        const A = await db.createSession({ title: 'Konv-A' });
        await agent.executeTool('open_tab', { url: 'https://example.com/', active: false }, { session: A });
        await agent.executeTool('open_tab', { url: 'https://example.net/', active: false }, { session: A });
        const B = await db.createSession({ title: 'Konv-B' });
        await agent.executeTool('open_tab', { url: 'https://developer.mozilla.org/', active: false }, { session: B });
        await wait(1800);

        const Ad = await db.getSession(A.id), Bd = await db.getSession(B.id);
        const csA = Ad.cookieStoreId, csB = Bd.cookieStoreId;
        const inCS = async (cs) => (await browser.tabs.query({})).filter((t) => t.cookieStoreId === cs).length;

        const report = {
          A_tabs: Ad.tabs, B_tabs: Bd.tabs,
          containersDistinct: csA !== csB, csA, csB,
          A_open: await inCS(csA), B_open: await inCS(csB),         // expect 2, 1
          A_missing_open: (await containers.missingTabs(A.id)).length, // expect 0
          B_missing_open: (await containers.missingTabs(B.id)).length, // expect 0
        };

        // Close ONLY A's tabs.
        for (const t of await browser.tabs.query({})) {
          if (t.cookieStoreId === csA) { try { await browser.tabs.remove(t.id); } catch (e) {} }
        }
        await wait(500);
        report.A_missing_afterCloseA = (await containers.missingTabs(A.id)).length; // expect 2
        report.B_missing_afterCloseA = (await containers.missingTabs(B.id)).length; // expect 0 (isolated!)

        const reopened = await containers.restoreSessionTabs(A.id);
        await wait(1500);
        report.A_reopened = reopened;                 // expect 2
        report.A_open_final = await inCS(csA);        // expect 2
        report.B_open_final = await inCS(csB);        // expect 1 (untouched)

        done(report);
      } catch (e) { done({ error: String((e && e.stack) || e) }); }
    })();
  `);

  console.log(JSON.stringify(result, null, 2));
  await setContext("chrome");
  await driver.execute(new Command("setContext").setParameter("context", "content"));
} catch (e) {
  console.error("ERROR:", e && (e.message || e));
  process.exitCode = 1;
}
