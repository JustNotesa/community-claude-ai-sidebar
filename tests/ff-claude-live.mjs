// Launch a VISIBLE Firefox on a PERSISTENT profile you control, with the
// extension loaded and the sidebar open. Because the profile persists, once you
// log in (API key or Claude subscription) it STAYS logged in across re-launches.
//
// Mechanism (verified against geckodriver docs):
//  - pass `-profile <dir>` as a Firefox arg → geckodriver uses the profile
//    IN PLACE (writes back), unlike Options.setProfile() which only copies.
//  - geckodriver mishandles the randomized Marionette port with -profile, so we
//    pin it with the geckodriver service arg --marionette-port.
//  - profile prefs are written directly to user.js (highest precedence).
//
// Run: MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 node tests/ff-claude-live.mjs

import { Builder } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { saveHandle, loadRegistry, saveRegistry, restoreSession } from "./ff-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const xpi = join(__dirname, "../web-ext-artifacts/community_claude_ai_sidebar-0.1.3.zip");
const GECKO_ID = "claude-for-firefox@specialaddon";
const UUID = "d9b1f1e2-3c4a-4b5c-8d6e-7f8a9b0c1d2e";
const MARIONETTE_PORT = "2828";
const GECKO_PORT = 4445; // fixed geckodriver HTTP port so other sessions can attach

// Persistent, non-hidden profile under $HOME (recommended by geckodriver docs).
const profileDir = join(homedir(), "claude-ff-profile");
mkdirSync(profileDir, { recursive: true });

// Prefs that must survive in-place; user.js wins over geckodriver's own writes.
writeFileSync(
  join(profileDir, "user.js"),
  [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ [GECKO_ID]: UUID }))});`,
    `user_pref("xpinstall.signatures.required", false);`,
    `user_pref("extensions.webextOptionalPermissionPrompts", false);`,
    // Keep extension storage + UUID even though the add-on is loaded temporarily,
    // so the login (storage.local / IndexedDB) survives across re-launches.
    `user_pref("extensions.webextensions.keepStorageOnUninstall", true);`,
    `user_pref("extensions.webextensions.keepUuidOnUninstall", true);`,
    // Allow userChrome.css so we can give this window a distinct accent colour.
    `user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);`,
    // Enable containers (contextual identities) so session tabs get their own colour.
    `user_pref("privacy.userContext.enabled", true);`,
    `user_pref("privacy.userContext.ui.enabled", true);`,
    `user_pref("browser.shell.checkDefaultBrowser", false);`,
    `user_pref("browser.startup.homepage_override.mstone", "ignore");`,
    `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
    "",
  ].join("\n")
);

// Distinct accent so this automated window is unmistakable among your other
// Firefox windows. Applied via userChrome.css (needs the legacy pref above).
const ACCENT = "#7c3aed"; // vivid violet
const ACCENT2 = "#fbbf24"; // amber stripe
mkdirSync(join(profileDir, "chrome"), { recursive: true });
writeFileSync(
  join(profileDir, "chrome", "userChrome.css"),
  `/* Selenium / Claude test window — accent so you can tell it apart */
#navigator-toolbox {
  background-color: ${ACCENT} !important;
  border-bottom: 6px solid ${ACCENT2} !important;
}
#titlebar, #TabsToolbar, #nav-bar, #PersonalToolbar {
  background-color: ${ACCENT} !important;
  background-image: none !important;
}
.tabbrowser-tab[selected] .tab-background {
  background-color: ${ACCENT2} !important;
}
#urlbar, #searchbar { --toolbar-field-background-color: #2e1065 !important; --toolbar-field-color: #fff !important; }
`
);

const options = new firefox.Options();
options.setBinary("/Applications/Firefox.app/Contents/MacOS/firefox");
// -no-remote forces a SEPARATE instance (you already have Firefox running, and
// Firefox is single-instance — without this our window dies into yours).
// -foreground brings the new window to the front. -profile = in-place/persistent.
options.addArguments("-no-remote", "-foreground", "-profile", profileDir);

const service = new firefox.ServiceBuilder()
  .setPort(GECKO_PORT)
  .addArguments("--marionette-port", MARIONETTE_PORT);

const driver = await new Builder()
  .forBrowser("firefox")
  .setFirefoxService(service)
  .setFirefoxOptions(options)
  .build();

async function shutdown() {
  try { await driver.quit(); } catch (_) {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await driver.manage().window().setRect({ width: 1280, height: 860 });
  await driver.manage().setTimeouts({ script: 25000 });

  const sessionId = (await driver.getSession()).getId();
  await driver.installAddon(xpi, true); // unsigned → temporary; storage persists via the profile
  await driver.sleep(1500);

  // Everything below is browser-UI (chrome) work: restore tabs, sidebar.
  await driver.setContext(firefox.Context.CHROME);
  const exec = (s, ...a) => driver.executeScript(s, ...a);

  // "Take the tabs with it": reopen every known session's tabs into its own
  // coloured container, so reopening the window brings each session's tabs back.
  const reg = loadRegistry();
  let restored = 0;
  for (const [sid, entry] of Object.entries(reg)) {
    try { restored += await restoreSession(exec, entry); } catch (e) { console.log("restore failed for", sid, e.message); }
  }
  saveRegistry(reg); // userContextIds may have been refreshed on recreate

  // Open the extension sidebar so you can LOG IN (API key or Claude subscription).
  await exec(`
    try {
      const id = [...SidebarController.sidebars.keys()].find(k => /sidebar-action/.test(k));
      if (id) SidebarController.show(id);
    } catch (e) {}
  `);

  // Back to content context so attaching sessions can drive tabs.
  await driver.setContext(firefox.Context.CONTENT);

  // Persist the WebDriver handle so ANY session can re-attach (see ff-attach.mjs).
  saveHandle({ url: `http://127.0.0.1:${GECKO_PORT}`, sessionId, uuid: UUID, profileDir });
  console.log("session", sessionId, "@ port", GECKO_PORT, "| restored", restored, "tab(s) across", Object.keys(reg).length, "session(s)");

  console.log("READY: persistent profile at", profileDir);
  console.log("Log in via the sidebar — it will persist across re-launches.");
  setInterval(() => console.log("alive @", process.uptime().toFixed(0) + "s"), 30000);
  await new Promise(() => {});
} catch (e) {
  console.error("ERROR:", e && (e.stack || e));
  await shutdown();
}
