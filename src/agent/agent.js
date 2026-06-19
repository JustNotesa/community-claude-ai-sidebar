// The agent loop. Runs inside the sidebar document (persistent while the
// sidebar is open), so there is no service-worker lifetime to fight.
//
// Flow per turn:
//   provider.streamTurn() -> assistant content (text + tool_use)
//   if stop_reason == "tool_use": execute each tool, append tool_result blocks
//   repeat until end_turn / step cap / spend cap / abort.

import { providerForSettings } from "../provider/provider.js";
import { SYSTEM_PROMPT, buildTools } from "./tools.js";
import { MAX_AGENT_STEPS } from "../util/constants.js";
import { contentScriptMain } from "../content/content.js";

const api = typeof browser !== "undefined" ? browser : chrome;

// ---- Browser/tab helpers --------------------------------------------------

function originPattern(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch (_) {
    return null;
  }
}

export async function hasHostAccess(url) {
  const origin = originPattern(url);
  if (!origin) return false;
  try {
    return await api.permissions.contains({ origins: [origin] });
  } catch (_) {
    return false;
  }
}

async function ensureContent(tabId) {
  // Try a ping (timeout-safe — a navigating page can leave sendMessage hanging).
  try {
    const r = await Promise.race([
      api.tabs.sendMessage(tabId, { type: "claude-content", action: "ping" }),
      new Promise((res) => setTimeout(() => res(null), 1500)),
    ]);
    if (r && r.ok) return;
  } catch (_) {
    /* not injected yet */
  }
  // Inject the content script by FUNCTION (not files) — executeScript({files})
  // is unreliable in Firefox here. The function must be self-contained.
  await api.scripting.executeScript({ target: { tabId }, func: contentScriptMain });
}

// Messaging is timeout-guarded so a navigation/teardown can never hang the agent.
function send(tabId, action, args = {}, timeoutMs = 12000) {
  return Promise.race([
    api.tabs.sendMessage(tabId, { type: "claude-content", action, args }),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("Inhalts-Skript antwortet nicht (Seite hat navigiert?).")), timeoutMs)
    ),
  ]);
}

// ---- Tool execution -------------------------------------------------------

export async function executeTool(name, input, ctx) {
  const { tabId } = ctx;
  switch (name) {
    case "read_page": {
      const tab = await api.tabs.get(tabId);
      if (!(await hasHostAccess(tab.url)))
        return { content: `Kein Zugriff auf ${tab.url}. Der Nutzer muss den Agenten für diese Seite freigeben.`, is_error: true };
      await ensureContent(tabId);
      const snap = await send(tabId, "snapshot", { include_text: input.include_text !== false });
      return { content: formatSnapshot(snap) };
    }
    case "click":
    case "type":
    case "select":
    case "scroll": {
      const before = await api.tabs.get(tabId);
      await ensureContent(tabId);
      let r;
      try {
        r = await send(tabId, name, input);
      } catch (_) {
        r = { ok: true }; // a navigation may swallow the reply — treat as done
      }
      if (!r?.ok) return { content: r?.error || "Aktion fehlgeschlagen.", is_error: true };

      // If the action navigated (or the page is loading), wait for the new page.
      await new Promise((res) => setTimeout(res, 350));
      const tab = await api.tabs.get(tabId);
      if (tab.url !== before.url || tab.status === "loading") {
        await waitForLoad(tabId, 8000);
      }
      // Re-inject (the content script is gone after a navigation) and snapshot.
      await ensureContent(tabId);
      try {
        const snap = await send(tabId, "snapshot", { include_text: false });
        return { content: `OK.\n\nNeuer Seitenzustand:\n${formatSnapshot(snap)}` };
      } catch (e) {
        return { content: `Aktion ausgeführt. Seite noch nicht lesbar (${e.message}). Bitte read_page erneut aufrufen.` };
      }
    }
    case "navigate": {
      if (input.action === "url") {
        if (!/^https?:\/\//i.test(input.url || ""))
          return { content: "Nur http(s)-URLs sind erlaubt.", is_error: true };
        await api.tabs.update(tabId, { url: input.url });
      } else if (input.action === "back") await api.tabs.goBack(tabId);
      else if (input.action === "forward") await api.tabs.goForward(tabId);
      else if (input.action === "reload") await api.tabs.reload(tabId);
      await waitForLoad(tabId);
      return { content: `Navigation (${input.action}) abgeschlossen.` };
    }
    case "open_tab": {
      if (!/^https?:\/\//i.test(input.url || ""))
        return { content: "Nur http(s)-URLs sind erlaubt.", is_error: true };
      const created = await api.tabs.create({ url: input.url, active: input.active !== false });
      return {
        content:
          `Neuer Tab geöffnet [tab ${created.id}]: ${input.url}\n` +
          `Diesen Tab mit read_tab (tab_id ${created.id}) lesen. ` +
          `click/type/navigate wirken weiterhin auf den ursprünglichen Tab.`,
      };
    }
    case "list_tabs": {
      const tabs = await api.tabs.query({});
      const list = tabs
        .filter((t) => /^https?:/.test(t.url || ""))
        .map((t) => `[tab ${t.id}]${t.active ? " (aktiv)" : ""} ${t.title} — ${t.url}`)
        .join("\n");
      return { content: list || "Keine Web-Tabs offen." };
    }
    case "read_tab": {
      const tab = await api.tabs.get(input.tab_id);
      if (!tab) return { content: "Tab nicht gefunden.", is_error: true };
      if (!(await hasHostAccess(tab.url)))
        return { content: `Kein Zugriff auf ${tab.url}.`, is_error: true };
      await ensureContent(input.tab_id);
      const snap = await api.tabs.sendMessage(input.tab_id, {
        type: "claude-content",
        action: "snapshot",
        args: { include_text: true },
      });
      return { content: formatSnapshot(snap) };
    }
    case "wait": {
      await new Promise((r) => setTimeout(r, Math.min(Math.max(input.ms || 0, 0), 10000)));
      return { content: "Gewartet." };
    }
    case "screenshot": {
      const tab = await api.tabs.get(tabId);
      try {
        const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        const base64 = dataUrl.split(",")[1];
        return {
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
            { type: "text", text: "Screenshot der sichtbaren Seite." },
          ],
        };
      } catch (e) {
        // With <all_urls> as a required permission, captureVisibleTab works on
        // any http(s) page. It can still fail on protected browser pages
        // (about:, addons.mozilla.org, view-source:, the PDF viewer …).
        return {
          content:
            "Screenshot auf dieser Seite nicht möglich (" + (e?.message || e) + "). Geschützte " +
            "Browser-Seiten (z. B. about:, Add-on-Seiten) lassen keine Screenshots zu.",
          is_error: true,
        };
      }
    }
    default:
      return { content: `Unbekanntes Tool: ${name}`, is_error: true };
  }
}

function formatSnapshot(snap) {
  if (!snap || !snap.ok) return snap?.error || "Seite konnte nicht gelesen werden.";
  let out = `# ${snap.title}\n${snap.url}\n\nInteraktive Elemente (${snap.elementCount}):\n${snap.snapshot}`;
  if (snap.text) out += `\n\nSeitentext:\n${snap.text}`;
  return out;
}

function waitForLoad(tabId, timeout = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      api.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    api.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeout);
  });
}

// ---- The loop -------------------------------------------------------------

/**
 * @param history  array of Anthropic message objects {role, content}
 * @param cb       callbacks: onText, onThinking, onAssistant, onToolUse,
 *                 onToolResult, confirm(name,input)->bool, onUsage, onDone, onError
 */
export async function runAgent({ history, settings, tabId, cb, signal }) {
  const provider = providerForSettings(settings);
  const valid = await provider.validateConfig(settings);
  if (!valid.ok) {
    cb.onError(new Error(valid.error));
    return;
  }
  const tools = buildTools(settings);
  let totalCost = 0;

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      if (signal?.aborted) return cb.onDone("abgebrochen");

      cb.onTurnStart && cb.onTurnStart();
      const turn = await provider.streamTurn({
        system: SYSTEM_PROMPT,
        messages: history,
        tools,
        settings,
        signal,
        onText: cb.onText,
        onThinking: cb.onThinking,
      });

      history.push({ role: "assistant", content: turn.content });
      await cb.onAssistant(turn.content, turn.usage);

      const cost = provider.estimateCost(settings.model, turn.usage);
      totalCost += cost;
      cb.onUsage && cb.onUsage(turn.usage, cost, totalCost, turn.rateLimits);

      if (settings.spendLimitUSD > 0 && totalCost >= settings.spendLimitUSD) {
        return cb.onDone(`Ausgabelimit erreicht (~$${totalCost.toFixed(3)}).`);
      }

      const toolUses = turn.content.filter((b) => b.type === "tool_use");
      if (turn.stop_reason !== "tool_use" || toolUses.length === 0) {
        return cb.onDone("fertig");
      }

      const results = [];
      let aborted = false;
      for (const tu of toolUses) {
        cb.onToolUse && cb.onToolUse(tu);

        // On abort, still emit a tool_result for every tool_use so the message
        // history stays valid (each tool_use MUST be answered).
        if (signal?.aborted) {
          aborted = true;
          results.push({ type: "tool_result", tool_use_id: tu.id, content: "Abgebrochen.", is_error: true });
          continue;
        }

        let res;
        try {
          res = await executeTool(tu.name, tu.input || {}, { tabId });
        } catch (e) {
          res = { content: String(e?.message || e), is_error: true };
        }
        const block = { type: "tool_result", tool_use_id: tu.id, content: res.content };
        if (res.is_error) block.is_error = true;
        results.push(block);
        cb.onToolResult && cb.onToolResult(tu, res, res.is_error);
      }

      const userMsg = { role: "user", content: results };
      history.push(userMsg);
      await cb.onToolResultsPersist(results);
      if (aborted || signal?.aborted) return cb.onDone("abgebrochen");
    }
    cb.onDone(`Schrittlimit (${MAX_AGENT_STEPS}) erreicht.`);
  } catch (e) {
    if (e?.name === "AbortError") return cb.onDone("abgebrochen");
    cb.onError(e);
  }
}
