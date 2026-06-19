// Verify the screenshot-result UI in real Firefox: seed a chat whose tool_result
// carries an image block, render it, confirm a clickable thumbnail appears, then
// click it and confirm the full-size lightbox opens. Screenshots are written to
// tests/ for visual inspection.

import { Builder, By } from "selenium-webdriver";
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

const driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();

try {
  await driver.manage().window().setRect({ width: 400, height: 720 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1000);
  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(800);

  // Seed a session + a 3-message exchange ending in a screenshot tool_result.
  // The image is drawn in-page on a canvas so it reads as a real screenshot.
  const seeded = await driver.executeAsyncScript(`
    const cb = arguments[arguments.length - 1];
    const c = document.createElement('canvas');
    c.width = 320; c.height = 220;
    const g = c.getContext('2d');
    g.fillStyle = '#1f6feb'; g.fillRect(0, 0, 320, 220);
    g.fillStyle = '#ffffff'; g.fillRect(16, 16, 288, 40);
    g.fillStyle = '#d97757'; g.fillRect(16, 72, 180, 28);
    g.fillStyle = '#ffffff'; g.font = 'bold 22px sans-serif';
    g.fillText('SCREENSHOT', 24, 150);
    g.font = '14px sans-serif';
    g.fillText('beispiel.de — sichtbare Seite', 24, 180);
    const b64 = c.toDataURL('image/png').split(',')[1];

    const req = indexedDB.open('claude-firefox', 1);
    req.onsuccess = () => {
      const db = req.result;
      const now = Date.now();
      const t = db.transaction(['sessions', 'messages'], 'readwrite');
      t.objectStore('sessions').put({
        id: 'demo-1', title: 'screenshot test', model: 'claude-opus-4-8',
        pinned: 0, createdAt: now, updatedAt: now,
      });
      const M = t.objectStore('messages');
      M.put({ id: 'm1', sessionId: 'demo-1', role: 'user',
        content: 'Mach einen Screenshot der Seite.', usage: null, ts: now + 1 });
      M.put({ id: 'm2', sessionId: 'demo-1', role: 'assistant', usage: null, ts: now + 2,
        content: [
          { type: 'text', text: 'Ich mache einen Screenshot.' },
          { type: 'tool_use', id: 'tu1', name: 'screenshot', input: {} },
        ] });
      M.put({ id: 'm3', sessionId: 'demo-1', role: 'user', usage: null, ts: now + 3,
        content: [{
          type: 'tool_result', tool_use_id: 'tu1', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
            { type: 'text', text: 'Screenshot der sichtbaren Seite.' },
          ],
        }] });
      t.oncomplete = () => cb('ok');
      t.onerror = () => cb('err:' + (t.error && t.error.message));
    };
    req.onerror = () => cb('open-err:' + (req.error && req.error.message));
  `);
  console.log("SEED", seeded);

  // Close the auto-opened settings/usage overlays.
  await driver.executeScript(`
    for (const id of ['settings', 'usage']) {
      const o = document.getElementById(id);
      if (o) o.hidden = true;
    }
  `);
  await driver.sleep(200);

  // Open the drawer and select the seeded session → renders the messages.
  await driver.findElement(By.id("btn-sessions")).click();
  await driver.sleep(500);
  await driver.findElement(By.css("#session-list .s-title")).click();
  await driver.sleep(700);

  const thumbs = await driver.findElements(By.css(".tool-shot"));
  console.log("THUMBNAILS", thumbs.length);
  writeFileSync(join(__dirname, "shot-1-thumbnail.png"), await driver.takeScreenshot(), "base64");

  if (!thumbs.length) throw new Error("no .tool-shot thumbnail rendered");

  // Click the thumbnail → lightbox opens.
  await thumbs[0].click();
  await driver.sleep(500);
  const lb = await driver.executeScript(`
    const ov = document.getElementById('lightbox');
    const img = document.getElementById('lightbox-img');
    return { exists: !!ov, visible: ov && !ov.hidden, hasSrc: !!(img && img.src && img.src.length > 100) };
  `);
  console.log("LIGHTBOX", JSON.stringify(lb));
  writeFileSync(join(__dirname, "shot-2-lightbox.png"), await driver.takeScreenshot(), "base64");

  if (!lb.exists || !lb.visible || !lb.hasSrc) throw new Error("lightbox did not open with the image");

  // Click the close button → lightbox dismisses.
  await driver.findElement(By.css(".lightbox-close")).click();
  await driver.sleep(300);
  const closed = await driver.executeScript(`return document.getElementById('lightbox').hidden;`);
  console.log("CLOSED", closed);
  if (!closed) throw new Error("close button did not dismiss the lightbox");

  console.log("RESULT PASS — thumbnail renders, opens full-size, and closes.");
  await driver.quit();
} catch (err) {
  console.error("RESULT FAIL", err && err.message);
  try { writeFileSync(join(__dirname, "shot-fail.png"), await driver.takeScreenshot(), "base64"); } catch {}
  await driver.quit();
  process.exit(1);
}
