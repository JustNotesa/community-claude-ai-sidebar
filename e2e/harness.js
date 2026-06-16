// E2E harness: runs the real agent loop (the same code the sidebar uses)
// against a real web tab, from an extension-page context. Driven by Selenium.

import { runAgent } from "../src/agent/agent.js";

const api = (typeof browser !== "undefined" && browser) || chrome;
const $ = (id) => document.getElementById(id);

$("run").addEventListener("click", async () => {
  $("result").textContent = "running…";
  const apiKey = $("key").value.trim();
  const task = $("task").value.trim();
  const out = { text: "", thinking: "", tools: [], results: [], done: null, error: null, cost: 0 };
  try {
    // Auto-granted in the test profile (extensions.webextOptionalPermissionPrompts=false).
    await api.permissions.request({ origins: ["<all_urls>"] });
    out.granted = await api.permissions.contains({ origins: ["<all_urls>"] });
    const tabs = await api.tabs.query({ url: ["http://*/*", "https://*/*"] });
    const tab = tabs[0];
    if (!tab) throw new Error("kein Web-Tab gefunden");
    out.tab = tab.url;
    out.grantedTab = await api.permissions.contains({ origins: [new URL(tab.url).origin + "/*"] });

    const history = [{ role: "user", content: task }];
    await runAgent({
      history,
      settings: {
        authMethod: "apikey",
        apiKey,
        model: "claude-opus-4-8",
        effort: "high",
        autoApprove: true,
        spendLimitUSD: 0,
      },
      tabId: tab.id,
      cb: {
        onTurnStart() {},
        onText: (d) => (out.text += d),
        onThinking: (d) => (out.thinking += d),
        onAssistant: async () => {},
        onToolResultsPersist: async () => {},
        onToolUse: (t) => out.tools.push(t.name),
        onToolResult: (t, res, err) =>
          out.results.push({
            tool: t.name,
            err: !!err,
            detail: err ? String(typeof res === "object" ? res?.content : res).slice(0, 200) : undefined,
          }),
        onUsage: (_u, _c, total) => (out.cost = total),
        confirm: async () => true,
        onDone: (r) => (out.done = r),
        onError: (e) => (out.error = e.message || String(e)),
      },
      signal: new AbortController().signal,
    });
  } catch (e) {
    out.error = e.message || String(e);
  }
  window.__e2eResult = out;
  $("result").textContent = JSON.stringify(out, null, 2);
});

window.__e2eReady = true;
