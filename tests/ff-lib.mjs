// Shared helpers for the persistent, per-session-controllable Firefox window.
//
// Model: ONE live Firefox (the keeper). Each Claude session gets its OWN
// Firefox container (contextual identity) with its own colour, and its open
// tab URLs are persisted to .ff-containers.json so they can be reopened
// ("taken with it") whenever the session — or the whole window — is reopened.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SESSION_FILE = join(__dirname, ".ff-session.json"); // WebDriver handle
export const REGISTRY_FILE = join(__dirname, ".ff-containers.json"); // per-session containers+tabs

// Distinct container colours, handed out in order so each session looks different.
export const PALETTE = ["purple", "turquoise", "orange", "pink", "green", "blue", "red", "yellow"];
const ICON = "fingerprint";

// ---- WebDriver handle (port + webdriver-session id) -----------------------
export function saveHandle(handle) {
  writeFileSync(SESSION_FILE, JSON.stringify(handle, null, 2));
}
export function loadHandle() {
  return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
}

// ---- Per-session registry --------------------------------------------------
export function loadRegistry() {
  try { return JSON.parse(readFileSync(REGISTRY_FILE, "utf8")); } catch { return {}; }
}
export function saveRegistry(reg) {
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
}
/** Get or create a session's entry, assigning it the next distinct colour. */
export function sessionEntry(reg, sessionId) {
  if (!reg[sessionId]) {
    const color = PALETTE[Object.keys(reg).length % PALETTE.length];
    reg[sessionId] = {
      container: `Claude-${String(sessionId).slice(0, 6)}`,
      color,
      icon: ICON,
      userContextId: null,
      tabs: [],
    };
  }
  return reg[sessionId];
}

// ---- Firefox chrome-context operations ------------------------------------
// `exec(script, ...args)` runs a chrome-context script (caller sets chrome ctx).

/** Ensure the contextual identity exists; returns (and stores) its userContextId. */
export async function ensureContainer(exec, entry) {
  const uc = await exec(
    `const [name, color, icon] = arguments;
     const { ContextualIdentityService } = ChromeUtils.importESModule("resource://gre/modules/ContextualIdentityService.sys.mjs");
     let id = ContextualIdentityService.getPublicIdentities().find(i => i.name === name);
     if (!id) id = ContextualIdentityService.create(name, icon, color);
     return id.userContextId;`,
    entry.container, entry.color, entry.icon
  );
  entry.userContextId = uc;
  return uc;
}

export async function openInContainer(exec, url, userContextId) {
  await exec(
    `const [url, uc] = arguments;
     gBrowser.selectedTab = gBrowser.addTab(url, {
       userContextId: uc,
       triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
     });`,
    url, userContextId
  );
}

/** How many live tabs exist per userContextId, e.g. {"6":3}. */
export async function liveCounts(exec) {
  return await exec(`
    const m = {};
    for (const t of gBrowser.tabs) { const u = t.getAttribute("usercontextid"); if (u) m[u] = (m[u] || 0) + 1; }
    return m;
  `);
}

/** Reopen a session's persisted tabs (used on window/session reopen). */
export async function restoreSession(exec, entry) {
  await ensureContainer(exec, entry);
  for (const url of entry.tabs) await openInContainer(exec, url, entry.userContextId);
  return entry.tabs.length;
}
