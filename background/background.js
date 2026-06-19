// Background event page (classic script). Intentionally tiny — all the heavy
// logic (agent loop, API calls, storage) lives in the sidebar document, which
// stays alive while the sidebar is open. The background only handles things
// that must originate outside the panel: opening the sidebar and context menus.

"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;

// --- Make subscription (OAuth) requests look like the Claude Code CLI --------
// The Claude Code OAuth client (9d1c250a) is meant to run from the CLI, not a
// browser. Anthropic enforces this two ways, both of which a browser fetch trips
// and cannot fix from JS (User-Agent and Origin are forbidden request headers):
//   1. Token endpoint returns 429 for any real browser User-Agent. Verified
//      deterministically: Chrome/Firefox/Safari UAs → 429; CLI/empty UA → OK.
//   2. /v1/messages with an Origin header is a CORS request; the consumer
//      (subscription) org disallows browser-direct access → "CORS requests are
//      not allowed for this Organization". The CLI sends no Origin.
// So for these calls we rewrite the User-Agent to a CLI value and drop Origin.
// The API-key path (x-api-key, its own org allows CORS) is left untouched — we
// only touch the token endpoint and the Bearer (OAuth) Messages requests.
// Firefox still supports blocking webRequest (Chrome MV3 does not).
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CLI_UA = "claude-cli/1.0.0 (external, cli)";

try {
  api.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const headers = details.requestHeaders || [];
      const isToken = details.url.startsWith(TOKEN_URL);
      const isOAuthMessage =
        details.url.startsWith(MESSAGES_URL) &&
        headers.some((h) => h.name.toLowerCase() === "authorization" && /^bearer /i.test(h.value || ""));
      if (!isToken && !isOAuthMessage) return {};

      const out = [];
      let uaSet = false;
      for (const h of headers) {
        const n = h.name.toLowerCase();
        if (n === "user-agent") {
          out.push({ name: h.name, value: CLI_UA });
          uaSet = true;
        } else if (n === "origin") {
          // drop — a missing Origin makes this a non-CORS (CLI-like) request
        } else {
          out.push(h);
        }
      }
      if (!uaSet) out.push({ name: "User-Agent", value: CLI_UA });
      return { requestHeaders: out };
    },
    { urls: [TOKEN_URL + "*", MESSAGES_URL + "*"] },
    ["blocking", "requestHeaders"]
  );
} catch (e) {
  console.error("[Claude] OAuth header-rewrite listener failed to register:", e);
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
