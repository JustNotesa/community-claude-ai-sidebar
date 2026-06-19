// Does a FREE request expose the subscription usage headers, or only a real
// generation? Launches Firefox on the PERSISTENT profile (where the OAuth login
// lives), opens the extension page so fetch() runs in the extension origin with
// the stored Bearer token + the UA/Origin-rewriting webRequest listener, then
// compares which `anthropic-ratelimit-*` headers come back from:
//   • POST /v1/messages/count_tokens   (free, no quota)
//   • POST /v1/messages  max_tokens:1  (consumes a sliver of quota)
//
// Run: MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 node tests/ff-usage-probe.mjs
import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = process.argv[2] || join(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e"; // pinned in claude-ff-profile
const profileDir = join(homedir(), "claude-ff-profile");

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
options.addArguments("-no-remote", "-headless", "-profile", profileDir);
const service = new firefox.ServiceBuilder().addArguments("--marionette-port", "2830");

const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxService(service)
  .setFirefoxOptions(options)
  .build();

try {
  await driver.manage().setTimeouts({ script: 60000 });
  await driver.installAddon(xpi, true);
  await driver.sleep(1500);
  await driver.get(`moz-extension://${UUID}/sidebar/panel.html`);
  await driver.sleep(1800);

  const out = await driver.executeAsyncScript(`
    const done = arguments[arguments.length - 1];
    (async () => {
      const api = (typeof browser !== "undefined" && browser) || chrome;
      const g = await api.storage.local.get("claude.oauth");
      const tok = g["claude.oauth"] && g["claude.oauth"].access_token;
      if (!tok) return done({ error: "no token in storage.local['claude.oauth'] — not logged in on this profile" });
      const model = (document.getElementById("model-select") || {}).value || "claude-sonnet-4-5";
      const H = {
        "content-type": "application/json",
        authorization: "Bearer " + tok,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-dangerous-direct-browser-access": "true",
      };
      const sys = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }];
      const msgs = [{ role: "user", content: "Hi" }];
      async function probe(label, url, body) {
        try {
          const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) });
          const rl = {};
          r.headers.forEach((v, k) => { if (k.startsWith("anthropic-ratelimit-") || k === "retry-after") rl[k] = v; });
          let snippet = ""; try { snippet = (await r.text()).slice(0, 140); } catch {}
          return { label, status: r.status, headers: rl, body: snippet };
        } catch (e) { return { label, error: e.name + ": " + e.message }; }
      }
      const res = [];
      res.push({ model });
      res.push(await probe("count_tokens", "https://api.anthropic.com/v1/messages/count_tokens",
        { model, system: sys, messages: msgs }));
      res.push(await probe("messages max_tokens:1", "https://api.anthropic.com/v1/messages",
        { model, max_tokens: 1, system: sys, messages: msgs }));
      done(res);
    })().catch((e) => done({ error: String(e && e.message || e) }));
  `);

  console.log("\n=== Usage-header probe ===");
  console.log(JSON.stringify(out, null, 2));
  console.log("");
} catch (e) {
  console.error("HARNESS ERROR:", e && (e.stack || e));
} finally {
  try { await driver.quit(); } catch {}
  process.exit(0);
}
