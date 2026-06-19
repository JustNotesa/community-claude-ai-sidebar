// Login-free probe: does an extension-origin fetch to the OAuth token host
// (platform.claude.com) get a CORS-bypass, or is it blocked → "NetworkError"?
//
// It loads the built xpi into a throwaway Firefox profile, opens the extension's
// own page (moz-extension://<uuid>/sidebar/panel.html) so fetch() runs with the
// extension's origin + granted host permissions + the background webRequest
// listener, then fires dummy token/messages requests and reports status vs throw.
//
// Run: MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 node tests/ff-oauth-probe.mjs <xpiPath>

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = process.argv[2] || join(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";
const MARIONETTE_PORT = "2829";

const profileDir = mkdtempSync(join(tmpdir(), "ff-oauth-probe-"));
writeFileSync(
  join(profileDir, "user.js"),
  [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [GECKO_ID]: UUID }))});`,
    `user_pref("xpinstall.signatures.required", false);`,
    `user_pref("browser.shell.checkDefaultBrowser", false);`,
    `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
    "",
  ].join("\n")
);

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.addArguments("-no-remote", "-headless", "-profile", profileDir);
const service = new firefox.ServiceBuilder().addArguments("--marionette-port", MARIONETTE_PORT);

const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxService(service)
  .setFirefoxOptions(options)
  .build();

const IDLE_MS = Number(process.env.IDLE_MS || 50000);
try {
  await driver.manage().setTimeouts({ script: IDLE_MS + 60000 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1500);

  // Open the extension's OWN page so fetch() runs in the extension origin.
  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(800);

  const results = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    const IDLE_MS = arguments[0];
    async function probe(label, url, opts) {
      try {
        const r = await fetch(url, opts);
        let body = "";
        try { body = (await r.text()).slice(0, 120); } catch {}
        return { label, ok: true, status: r.status, body };
      } catch (e) {
        return { label, ok: false, err: e.name + ": " + e.message };
      }
    }
    const token = (label) => probe(label, "https://platform.claude.com/v1/oauth/token",
      { method: "POST", credentials: "omit", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
          code: "dummy", redirect_uri: "https://console.anthropic.com/oauth/code/callback", state: "x", code_verifier: "y" }).toString() });
    (async () => {
      const out = [];
      // t0: background event page is freshly loaded (blocking listener present)
      out.push(await token("TOKEN @ t0 (bg fresh)"));
      // wait out the event-page idle timeout (~30s) so the bg listener unloads,
      // mimicking the real flow where login takes seconds/minutes
      await new Promise(r => setTimeout(r, IDLE_MS));
      out.push(await token("TOKEN @ t" + Math.round(IDLE_MS/1000) + "s (bg may be unloaded)"));
      done(out);
    })();
  `, IDLE_MS);

  console.log("\n=== OAuth fetch probe (extension origin) ===");
  for (const r of results) {
    if (r.ok) console.log(`  ✅ ${r.label}\n     HTTP ${r.status}  ${r.body.replace(/\s+/g, " ")}`);
    else console.log(`  ❌ ${r.label}\n     THREW ${r.err}`);
  }
  console.log("");
} catch (e) {
  console.error("HARNESS ERROR:", e && (e.stack || e));
} finally {
  try { await driver.quit(); } catch {}
  process.exit(0);
}
