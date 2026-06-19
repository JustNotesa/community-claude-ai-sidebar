// Per-conversation Firefox containers + tab memory.
//
// Each chat session gets its OWN contextual identity (a coloured Firefox
// container), so the tabs the agent opens for a conversation are visually
// grouped and unmistakable. The opened URLs are remembered on the session
// record (IndexedDB) so they can be reopened ("taken with it") whenever the
// conversation — or the whole browser — is reopened.
//
// Degrades gracefully: if the contextualIdentities API is unavailable (e.g.
// permission not granted), tabs still open and are still remembered — just
// without a dedicated colour.

import * as db from "../storage/db.js";

const api =
  (typeof browser !== "undefined" && browser) || (typeof chrome !== "undefined" && chrome) || null;

// Valid Firefox container colours; handed out deterministically per session.
const COLORS = ["purple", "turquoise", "green", "orange", "pink", "blue", "red", "yellow"];
const ICON = "fingerprint";

function colorFor(sessionId) {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

const hasContainers = () => !!(api.contextualIdentities && api.contextualIdentities.create);

/**
 * Ensure this session has a contextual identity; returns { cookieStoreId, color }
 * or null if containers are unavailable. The id/colour are stored on the session.
 */
export async function ensureSessionContainer(sessionId) {
  if (!hasContainers()) return null;
  const s = await db.getSession(sessionId);
  if (!s) return null;

  if (s.cookieStoreId) {
    try {
      await api.contextualIdentities.get(s.cookieStoreId); // still exists?
      return { cookieStoreId: s.cookieStoreId, color: s.containerColor };
    } catch (_) {
      /* identity was removed — recreate below */
    }
  }

  const color = colorFor(sessionId);
  const name = `Claude · ${String(s.title || sessionId.slice(0, 4)).slice(0, 24)}`;
  const ident = await api.contextualIdentities.create({ name, color, icon: ICON });
  await db.updateSession(sessionId, { cookieStoreId: ident.cookieStoreId, containerColor: color });
  return { cookieStoreId: ident.cookieStoreId, color };
}

// Normalise stored tabs to { url, tabId }. Older records stored bare URL
// strings; treat those as "url with unknown tab".
function normTabs(s) {
  const raw = Array.isArray(s?.tabs) ? s.tabs : [];
  return raw.map((e) =>
    typeof e === "string" ? { url: e, tabId: null } : { url: e.url, tabId: e.tabId ?? null }
  );
}

/**
 * Remember a tab the agent opened (keyed by URL, but we track the live TAB ID so
 * redirects don't fool us into thinking the tab is gone). Updates the id if the
 * URL was already remembered.
 */
export async function recordSessionTab(sessionId, url, tabId = null) {
  const s = await db.getSession(sessionId);
  if (!s) return;
  const tabs = normTabs(s);
  tabs.push({ url, tabId }); // one entry per opened tab (identity = live tab id)
  await db.updateSession(sessionId, { tabs });
}

/** Forget one remembered URL. */
export async function forgetSessionTab(sessionId, url) {
  const s = await db.getSession(sessionId);
  if (!s) return;
  await db.updateSession(sessionId, { tabs: normTabs(s).filter((t) => t.url !== url) });
}

/**
 * This session's remembered tabs that are NOT currently open — i.e. tabs that
 * were open before and have since been closed. Identity is the live tab id, so
 * a tab whose URL redirected still counts as open.
 */
export async function missingTabs(sessionId) {
  const s = await db.getSession(sessionId);
  const tabs = normTabs(s);
  if (!tabs.length || !api) return [];
  const open = await api.tabs.query({});
  const openIds = new Set(open.map((t) => t.id));
  return tabs.filter((t) => t.tabId == null || !openIds.has(t.tabId));
}

/**
 * Reopen ONLY the tabs that are currently closed, into this session's container.
 * Already-open tabs are left alone (no duplicates, no incremental adds).
 * Returns the number reopened.
 */
export async function restoreSessionTabs(sessionId) {
  const s = await db.getSession(sessionId);
  const tabs = normTabs(s);
  if (!tabs.length || !api) return 0;

  const openIds = new Set((await api.tabs.query({})).map((t) => t.id));
  const closed = tabs.filter((t) => t.tabId == null || !openIds.has(t.tabId)); // refs into `tabs`
  if (!closed.length) return 0;

  const container = await ensureSessionContainer(sessionId);
  let opened = 0;
  for (const entry of closed) {
    const props = { url: entry.url, active: false }; // background — don't steal focus
    if (container?.cookieStoreId) props.cookieStoreId = container.cookieStoreId;
    try {
      const created = await api.tabs.create(props);
      entry.tabId = created.id; // update in place so it isn't reopened again
      opened++;
    } catch (_) {
      /* ignore a single failed tab */
    }
  }
  await db.updateSession(sessionId, { tabs });
  return opened;
}

/** Counts for this session: how many of its tabs are currently open vs closed. */
export async function sessionTabStats(sessionId) {
  const s = await db.getSession(sessionId);
  const tabs = normTabs(s);
  if (!tabs.length || !api) return { open: 0, missing: 0 };
  const openIds = new Set((await api.tabs.query({})).map((t) => t.id));
  let open = 0, missing = 0;
  for (const t of tabs) (t.tabId != null && openIds.has(t.tabId) ? open++ : missing++);
  return { open, missing };
}

/**
 * Bring this session's currently-open tabs to the foreground: focus their
 * window and highlight (multi-select) them, so they're easy to find among many
 * other tabs. Returns how many were revealed.
 */
export async function showSessionTabs(sessionId) {
  const s = await db.getSession(sessionId);
  const tabs = normTabs(s);
  if (!tabs.length || !api) return 0;
  const byId = new Map((await api.tabs.query({})).map((t) => [t.id, t]));
  const mine = tabs.map((t) => byId.get(t.tabId)).filter(Boolean);
  if (!mine.length) return 0;

  const windowId = mine[0].windowId;
  const indices = mine.filter((t) => t.windowId === windowId).map((t) => t.index);
  try { await api.windows.update(windowId, { focused: true }); } catch (_) {}
  try {
    await api.tabs.highlight({ windowId, tabs: indices });
  } catch (_) {
    try { await api.tabs.update(mine[0].id, { active: true }); } catch (_) {}
  }
  return mine.length;
}
