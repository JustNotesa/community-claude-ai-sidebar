// Tests the content script's page-action logic against a REAL browser DOM via
// Playwright/Chromium (faithful getClientRects, native value setters, events).

import { test } from "node:test";
import assert from "node:assert";
import { chromium } from "playwright";
import { contentScriptMain } from "../src/content/content.js";

const HTML = `<!doctype html><html><body>
  <h1>Test-Seite</h1>
  <a href="https://example.com">Beispiel öffnen</a>
  <button id="b1">Klick mich</button>
  <label for="email">E-Mail-Adresse</label>
  <input id="email" type="text" />
  <textarea id="ta" aria-label="Notizen"></textarea>
  <select id="sel"><option value="a">Alpha</option><option value="b">Beta</option></select>
</body></html>`;

const refOf = (snapshot, needle) => {
  const line = snapshot.split("\n").find((l) => l.includes(needle));
  if (!line) return null;
  const m = line.match(/^\[(\d+)\]/);
  return m ? Number(m[1]) : null;
};

test("snapshot + click + type + select against a real DOM", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(HTML);
    await page.evaluate(contentScriptMain);

    // Instrument events on the page.
    await page.evaluate(() => {
      window.__ev = { click: 0, input: 0, change: 0 };
      document.getElementById("b1").addEventListener("click", () => window.__ev.click++);
      document.getElementById("email").addEventListener("input", () => window.__ev.input++);
      document.getElementById("sel").addEventListener("change", () => window.__ev.change++);
    });

    // 1) snapshot must surface the interactive elements with accessible names
    const snap = await page.evaluate(() =>
      window.__claudeAgent.handle("snapshot", { include_text: true })
    );
    assert.ok(snap.ok, "snapshot ok");
    assert.ok(/link "Beispiel öffnen"/.test(snap.snapshot), snap.snapshot);
    assert.ok(/button "Klick mich"/.test(snap.snapshot), snap.snapshot);
    assert.ok(/textbox "E-Mail-Adresse"/.test(snap.snapshot), snap.snapshot);
    assert.ok(snap.text.includes("Test-Seite"), "includes page text");

    // 2) click
    const bRef = refOf(snap.snapshot, "Klick mich");
    const clickRes = await page.evaluate((ref) => window.__claudeAgent.handle("click", { ref }), bRef);
    assert.ok(clickRes.ok, JSON.stringify(clickRes));
    assert.equal(await page.evaluate(() => window.__ev.click), 1);

    // 3) type into the email field (native setter + input event)
    const eRef = refOf(snap.snapshot, "E-Mail-Adresse");
    const typeRes = await page.evaluate(
      (ref) => window.__claudeAgent.handle("type", { ref, text: "max@example.com" }),
      eRef
    );
    assert.ok(typeRes.ok, JSON.stringify(typeRes));
    assert.equal(await page.evaluate(() => document.getElementById("email").value), "max@example.com");
    assert.ok((await page.evaluate(() => window.__ev.input)) >= 1, "input event fired");

    // 4) select an option by label
    const sRef = refOf(snap.snapshot, "combobox");
    const selRes = await page.evaluate(
      (ref) => window.__claudeAgent.handle("select", { ref, value: "Beta" }),
      sRef
    );
    assert.ok(selRes.ok, JSON.stringify(selRes));
    assert.equal(await page.evaluate(() => document.getElementById("sel").value), "b");
    assert.equal(await page.evaluate(() => window.__ev.change), 1);

    // 5) stale ref after removing an element
    await page.evaluate(() => document.getElementById("b1").remove());
    const stale = await page.evaluate((ref) => window.__claudeAgent.handle("click", { ref }), bRef);
    assert.equal(stale.ok, false, "click on removed element should fail gracefully");
  } finally {
    await browser.close();
  }
});
