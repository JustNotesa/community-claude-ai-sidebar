// Background event page (classic script). Intentionally tiny — all the heavy
// logic (agent loop, API calls, storage) lives in the sidebar document, which
// stays alive while the sidebar is open. The background only handles things
// that must originate outside the panel: opening the sidebar and context menus.

"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;

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
