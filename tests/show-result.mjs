// Present + verify the chat-row actions in real Firefox.
// Loads the extension, seeds two chat sessions, opens the chat drawer, then
// drives BOTH new behaviours — the two-click "Löschen" confirm and the in-place
// rename — proving they work, and leaves the window open for live inspection.

import { Builder, By, Key } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";

process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.setPreference("extensions.webextensions.uuids", JSON.stringify({ [GECKO_ID]: UUID }));
options.setPreference("xpinstall.signatures.required", false);

const shot = (driver, name) =>
  driver.takeScreenshot().then((png) => {
    writeFileSync(join(__dirname, name), png, "base64");
    console.log("SHOT", name);
  });

// Find the <li> whose .s-title currently reads `title`.
const rowByTitle = async (driver, title) => {
  for (const li of await driver.findElements(By.css("#session-list li"))) {
    const t = await li.findElements(By.css(".s-title"));
    if (t.length && (await t[0].getText()).trim() === title) return li;
  }
  return null;
};
const titles = async (driver) =>
  Promise.all(
    (await driver.findElements(By.css("#session-list .s-title"))).map((e) => e.getText())
  );

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
try {
  await driver.manage().window().setRect({ width: 400, height: 720 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1000);

  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(800);

  // Seed two chat sessions straight into IndexedDB (same origin/store as app).
  const seeded = await driver.executeAsyncScript(`
    const cb = arguments[arguments.length - 1];
    const req = indexedDB.open('claude-firefox', 1);
    req.onsuccess = () => {
      const db = req.result;
      const now = Date.now();
      const t = db.transaction('sessions', 'readwrite');
      const s = t.objectStore('sessions');
      s.put({ id:'demo-1', title:'suche nach google', model:'claude-opus-4-8', pinned:0, createdAt:now, updatedAt:now });
      s.put({ id:'demo-2', title:'wetter morgen',     model:'claude-opus-4-8', pinned:0, createdAt:now, updatedAt:now-1 });
      t.oncomplete = () => cb('ok');
      t.onerror = () => cb('err:' + (t.error && t.error.message));
    };
    req.onerror = () => cb('open-err:' + (req.error && req.error.message));
  `);
  console.log("SEED", seeded);

  await driver.executeScript(`
    for (const id of ['settings', 'usage']) {
      const o = document.getElementById(id); if (o) o.hidden = true;
    }
  `);
  await driver.sleep(200);

  await driver.findElement(By.id("btn-sessions")).click(); // open drawer + refresh
  await driver.sleep(600);
  await shot(driver, "delete-button-fixed.png");

  // --- Verify in-place rename on "suche nach google" -> "google-suche fertig" ---
  // Open the editor, set the new value (visible in the screenshot), then fire the
  // Enter keydown the handler listens for. Robust to screenshot-induced blur:
  // whether blur or Enter commits first, the saved value is the same. (Marionette
  // key synthesis to content is unreliable on an unfocused macOS window, so we
  // drive the field's own commit path directly.)
  let row = await rowByTitle(driver, "suche nach google");
  if (!row) throw new Error("rename row not found");
  await row.findElement(By.css('[title="Umbenennen"]')).click();
  await driver.sleep(150);
  await driver.executeScript(
    `const inp = document.querySelector('#session-list .s-edit');
     if (inp) inp.value = arguments[0];`,
    "google-suche fertig"
  );
  await shot(driver, "rename-editing.png"); // inline field showing the new title
  await driver.executeScript(
    `const inp = document.querySelector('#session-list .s-edit');
     if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`
  );
  await driver.sleep(500);
  const afterTitles = await titles(driver);
  console.log("RENAME", {
    titles: afterTitles,
    ok: afterTitles.includes("google-suche fertig") ? "OK" : "FAIL",
  });
  await shot(driver, "rename-after.png");

  // --- Verify the two-click delete on "wetter morgen" ---
  const before = (await driver.findElements(By.css("#session-list li"))).length;
  row = await rowByTitle(driver, "wetter morgen");
  const del = await row.findElement(By.css(".s-del"));
  await del.click(); // arm
  await driver.sleep(400);
  console.log("ARMED_LABEL", (await del.getText()).trim());
  await del.click(); // delete
  await driver.sleep(600);
  const after = (await driver.findElements(By.css("#session-list li"))).length;
  console.log("DELETE", { before, after, ok: before - after === 1 ? "OK" : "FAIL" });
  await shot(driver, "delete-after.png");

  console.log("BROWSER_OPEN — leaving Firefox open; stop this task to close it.");
  setInterval(() => {
    driver.getTitle().catch(() => {});
  }, 5000);
} catch (err) {
  console.error("ERR", err && err.message);
  await driver.quit();
  process.exit(1);
}
