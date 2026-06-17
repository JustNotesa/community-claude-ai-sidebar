// Background event page (classic script). Intentionally tiny — all the heavy
// logic (agent loop, API calls, storage) lives in the sidebar document, which
// stays alive while the sidebar is open. The background only handles things
// that must originate outside the panel: opening the sidebar and context menus.

"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;

// --- User-Agent rewrite for Anthropic OAuth/API calls -----------------------
// Anthropic's OAuth token endpoint rejects requests carrying a real browser
// User-Agent with HTTP 429: the Claude Code OAuth client (9d1c250a) is meant to
// run from the CLI, not a browser. Verified empirically — Chrome/Firefox/Safari
// UAs → 429, a CLI-style or empty UA → accepted. fetch() can't set User-Agent
// (forbidden header), so rewrite it here for exactly these endpoints. Firefox
// still supports blocking webRequest (Chrome MV3 does not).
const UA_REWRITE_URLS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://api.anthropic.com/v1/messages",
];
const CLI_UA = "claude-cli/1.0.0 (external, cli)";

try {
  api.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const headers = details.requestHeaders || [];
      let found = false;
      for (const h of headers) {
        if (h.name.toLowerCase() === "user-agent") {
          h.value = CLI_UA;
          found = true;
        }
      }
      if (!found) headers.push({ name: "User-Agent", value: CLI_UA });
      return { requestHeaders: headers };
    },
    { urls: UA_REWRITE_URLS },
    ["blocking", "requestHeaders"]
  );
} catch (e) {
  console.error("[Claude] UA-rewrite listener failed to register:", e);
}

// Toolbar button toggles the sidebar (the click is a valid user gesture).
api.action.onClicked.addListener(async () => {
  try {
    if (api.sidebarAction.toggle) await api.sidebarAction.toggle();
    else await api.sidebarAction.open();
  } catch (e) {
    console.error("[Claude] Sidebar toggle failed:", e);
  }
});

// Context menus: send the current page / selection to the sidebar.
api.runtime.onInstalled.addListener(() => {
  api.contextMenus.create({
    id: "claude-summarize-page",
    title: "Mit Claude zusammenfassen",
    contexts: ["page"],
  });
  api.contextMenus.create({
    id: "claude-explain-selection",
    title: "Claude: „%s“ erklären",
    contexts: ["selection"],
  });
});

api.contextMenus.onClicked.addListener(async (info, tab) => {
  let prompt = "";
  if (info.menuItemId === "claude-summarize-page") {
    prompt = "Fasse die aktuelle Seite zusammen.";
  } else if (info.menuItemId === "claude-explain-selection") {
    prompt = `Erkläre diesen Ausschnitt aus der Seite:\n\n"${info.selectionText || ""}"`;
  }
  if (!prompt) return;

  // Stash a pending prompt; the sidebar picks it up on load / via storage change.
  await api.storage.local.set({
    "claude.pending": { prompt, tabId: tab?.id, url: tab?.url, ts: Date.now() },
  });
  try {
    await api.sidebarAction.open();
  } catch (e) {
    // open() may require a user gesture; the menu click usually qualifies.
    console.warn("[Claude] Could not open sidebar:", e);
  }
});
