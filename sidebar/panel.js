// Sidebar controller. Runs the whole show: session management, rendering,
// streaming the agent loop, the action timeline, confirmations and settings.

import * as db from "../src/storage/db.js";
import { runAgent, hasHostAccess } from "../src/agent/agent.js";
import { renderMarkdown } from "../src/ui/markdown.js";
import { providerForSettings } from "../src/provider/provider.js";
import { startBridge, stopBridge } from "../src/bridge/bridge.js";
import { MODELS, DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/util/constants.js";

const api = typeof browser !== "undefined" ? browser : chrome;
const $ = (id) => document.getElementById(id);

const state = {
  settings: { ...DEFAULT_SETTINGS },
  session: null, // {id,title,...}
  history: [], // Anthropic messages for replay
  running: false,
  abort: null,
  activeTab: null,
  pendingImage: null, // { data: base64, mediaType } attached to the next message
};

// ---------- helpers ----------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const messagesEl = () => $("messages");
function scrollDown() {
  const m = messagesEl();
  m.scrollTop = m.scrollHeight;
}
function status(msg) {
  $("statusbar").textContent = msg || "";
}
function summarize(obj, n = 80) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------- settings ----------
async function loadSettings() {
  const got = await api.storage.local.get(SETTINGS_KEY);
  state.settings = { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] || {}) };
}
async function saveSettings() {
  await api.storage.local.set({ [SETTINGS_KEY]: state.settings });
}
function populateModelSelect(sel) {
  sel.innerHTML = "";
  for (const m of MODELS) {
    const o = el("option", null, m.label);
    o.value = m.id;
    sel.appendChild(o);
  }
  sel.value = state.settings.model;
}

// ---------- sessions ----------
async function refreshSessions() {
  const list = await db.listSessions();
  const ul = $("session-list");
  ul.innerHTML = "";
  if (!list.length) ul.appendChild(el("li", "empty", "Noch keine Chats."));
  for (const s of list) {
    const li = el("li");
    if (state.session && s.id === state.session.id) li.classList.add("active");
    const pin = el("span", "s-act", s.pinned ? "★" : "☆");
    pin.title = "Anpinnen";
    pin.onclick = async (e) => {
      e.stopPropagation();
      await db.updateSession(s.id, { pinned: s.pinned ? 0 : 1 });
      refreshSessions();
    };
    const title = el("span", "s-title", s.title);
    title.onclick = () => selectSession(s.id);
    const ren = el("span", "s-act", "✎");
    ren.title = "Umbenennen";
    ren.onclick = async (e) => {
      e.stopPropagation();
      const t = prompt("Chat umbenennen:", s.title);
      if (t) {
        await db.updateSession(s.id, { title: t });
        refreshSessions();
      }
    };
    const del = el("span", "s-act", "🗑");
    del.title = "Löschen";
    del.onclick = async (e) => {
      e.stopPropagation();
      if (confirm(`Chat „${s.title}“ löschen?`)) {
        await db.deleteSession(s.id);
        if (state.session && state.session.id === s.id) await newSession();
        refreshSessions();
      }
    };
    li.append(pin, title, ren, del);
    ul.appendChild(li);
  }
}

async function newSession() {
  state.session = await db.createSession({ model: state.settings.model });
  state.history = [];
  renderMessages();
  await refreshSessions();
}

// If the conversation ends on an assistant turn that has unanswered tool_use
// blocks, append matching is_error tool_result blocks. The Anthropic API rejects
// a history where a tool_use is not immediately followed by its tool_result.
async function repairHistory() {
  const h = state.history;
  if (!h.length) return;
  const last = h[h.length - 1];
  if (last.role !== "assistant" || !Array.isArray(last.content)) return;
  const toolUses = last.content.filter((b) => b.type === "tool_use");
  if (!toolUses.length) return;
  const results = toolUses.map((tu) => ({
    type: "tool_result",
    tool_use_id: tu.id,
    content: "Abgebrochen.",
    is_error: true,
  }));
  h.push({ role: "user", content: results });
  if (state.session) {
    await db.addMessage({ sessionId: state.session.id, role: "user", content: results });
  }
}

async function selectSession(id) {
  const s = await db.getSession(id);
  if (!s) return;
  state.session = s;
  const msgs = await db.getMessages(id);
  state.history = msgs.map((m) => ({ role: m.role, content: m.content }));
  renderMessages();
  $("drawer").hidden = true;
  await refreshSessions();
}

// ---------- rendering ----------
function renderMessages() {
  const m = messagesEl();
  m.innerHTML = "";
  if (!state.history.length) {
    m.appendChild(
      el(
        "div",
        "empty",
        "Frag Claude etwas über die aktuelle Seite, oder gib eine Aufgabe — Claude kann lesen, klicken, tippen und navigieren."
      )
    );
    return;
  }
  for (const msg of state.history) renderHistoryMessage(msg);
  scrollDown();
}

function renderHistoryMessage(msg) {
  const m = messagesEl();
  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      addUserBubble(msg.content);
    } else if (Array.isArray(msg.content)) {
      if (msg.content.some((b) => b.type === "tool_result")) {
        for (const b of msg.content) {
          if (b.type === "tool_result") {
            const line = el("div", "tool " + (b.is_error ? "err" : "ok"));
            line.appendChild(el("div", "res", contentToText(b.content)));
            m.appendChild(line);
          }
        }
      } else {
        addUserBubble(msg.content); // text and/or attached image
      }
    }
    return;
  }
  // assistant
  const { bubble, body } = createAssistantBubble();
  let text = "";
  for (const b of msg.content) {
    if (b.type === "text") text += b.text;
    else if (b.type === "thinking" && b.thinking) {
      const d = el("details", "thinking");
      d.appendChild(el("summary", null, "Gedankengang"));
      d.appendChild(document.createTextNode(b.thinking));
      bubble.appendChild(d);
    } else if (b.type === "tool_use") {
      addToolChip(bubble, b.name, b.input);
    }
  }
  body.innerHTML = renderMarkdown(text);
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join(" ");
  return String(content ?? "");
}

function addUserBubble(content) {
  const wrap = el("div", "msg user");
  const bubble = el("div", "bubble");
  if (typeof content === "string") {
    bubble.textContent = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b.type === "image") {
        const img = document.createElement("img");
        img.className = "bubble-img";
        img.src = `data:${b.source.media_type};base64,${b.source.data}`;
        bubble.appendChild(img);
      } else if (b.type === "text") {
        bubble.appendChild(el("div", null, b.text));
      }
    }
  }
  wrap.appendChild(bubble);
  messagesEl().appendChild(wrap);
}

function createAssistantBubble() {
  const wrap = el("div", "msg assistant");
  const bubble = el("div", "bubble");
  const body = el("div", "body");
  bubble.appendChild(body);
  wrap.appendChild(bubble);
  messagesEl().appendChild(wrap);
  return { wrap, bubble, body };
}

function addToolChip(bubble, name, args) {
  const tool = el("div", "tool");
  const head = el("div", "head");
  head.appendChild(el("span", "ico", "🔧"));
  head.appendChild(el("span", "name", name));
  head.appendChild(el("span", "args", summarize(args, 60)));
  tool.appendChild(head);
  bubble.appendChild(tool);
  return tool;
}

// ---------- the send / run flow ----------
async function send(text) {
  if (state.running || (!text.trim() && !state.pendingImage)) return;
  if (!(await isReady())) {
    openSettings();
    status("Bitte zuerst anmelden bzw. einen API-Key hinterlegen.");
    return;
  }
  if (!state.session) await newSession();

  // Heal any dangling tool_use (e.g. a previous run was stopped) so the history
  // is valid before we add the new user turn.
  await repairHistory();

  // user message — string, or an array with an attached image (+ optional text)
  let content;
  if (state.pendingImage) {
    content = [
      { type: "image", source: { type: "base64", media_type: state.pendingImage.mediaType, data: state.pendingImage.data } },
    ];
    if (text.trim()) content.push({ type: "text", text });
  } else {
    content = text;
  }
  state.history.push({ role: "user", content });
  await db.addMessage({ sessionId: state.session.id, role: "user", content });
  addUserBubble(content);
  state.pendingImage = null;
  renderAttachPreview();
  // Title from first message
  if (state.history.filter((h) => h.role === "user").length === 1) {
    const title = (text.trim() || "Bild").slice(0, 40);
    await db.updateSession(state.session.id, { title });
    refreshSessions();
  }
  scrollDown();

  setRunning(true);
  state.abort = new AbortController();
  const tabId = state.activeTab?.id;

  let current = null; // current assistant bubble refs
  let curText = "";
  let thinkingBox = null;
  const chips = new Map(); // tool_use id -> chip DOM (kept out of persisted data)

  const cb = {
    onTurnStart() {
      current = createAssistantBubble();
      curText = "";
      thinkingBox = null;
      scrollDown();
    },
    onText(delta) {
      curText += delta;
      current.body.innerHTML = renderMarkdown(curText);
      scrollDown();
    },
    onThinking(delta) {
      if (!thinkingBox) {
        thinkingBox = el("details", "thinking");
        thinkingBox.appendChild(el("summary", null, "Gedankengang"));
        thinkingBox._txt = document.createTextNode("");
        thinkingBox.appendChild(thinkingBox._txt);
        current.bubble.insertBefore(thinkingBox, current.body);
      }
      thinkingBox._txt.textContent += delta;
    },
    onToolUse(block) {
      chips.set(block.id, addToolChip(current.bubble, block.name, block.input));
      scrollDown();
    },
    onToolResult(block, res, isErr) {
      const chip = chips.get(block.id);
      if (!chip) return;
      chip.classList.add(isErr ? "err" : "ok");
      const text = res === "abgelehnt" ? "Abgelehnt" : contentToText(res?.content ?? res);
      const r = el("div", "res", summarize(text, 240));
      chip.appendChild(r);
      scrollDown();
    },
    async onAssistant(content, usage) {
      await db.addMessage({ sessionId: state.session.id, role: "assistant", content, usage });
    },
    async onToolResultsPersist(results) {
      await db.addMessage({ sessionId: state.session.id, role: "user", content: results });
    },
    onUsage(usage, cost, total) {
      status(`Lauf-Kosten ~$${total.toFixed(4)} · ${usage.output_tokens || 0} Output-Tokens`);
    },
    onDone(reason) {
      setRunning(false);
      if (reason && reason !== "fertig") status(`Beendet: ${reason}`);
    },
    onError(err) {
      setRunning(false);
      const wrap = el("div", "msg assistant");
      const b = el("div", "bubble");
      const p = el("p", null, "⚠ " + (err.message || String(err)));
      p.style.color = "var(--danger)";
      b.appendChild(p);
      wrap.appendChild(b);
      messagesEl().appendChild(wrap);
      scrollDown();
    },
  };

  await runAgent({ history: state.history, settings: state.settings, tabId, cb, signal: state.abort.signal });
}

function setRunning(on) {
  state.running = on;
  $("btn-send").hidden = on;
  $("btn-stop").hidden = !on;
  $("input").disabled = on;
}

// ---------- active tab / permissions ----------
async function updateTabBar() {
  let tab;
  try {
    [tab] = await api.tabs.query({ active: true, currentWindow: true });
  } catch (_) {
    tab = null;
  }
  state.activeTab = tab;
  const dot = $("access-dot");
  const grant = $("btn-grant");
  $("tab-title").textContent = tab?.title || "—";
  const isWeb = tab && /^https?:/.test(tab.url || "");
  if (!isWeb) {
    dot.className = "dot";
    grant.hidden = true;
    return;
  }
  const ok = await hasHostAccess(tab.url);
  dot.className = "dot " + (ok ? "on" : "off");
  dot.title = ok ? "Zugriff erteilt" : "Kein Seitenzugriff";
  grant.hidden = ok;
}

async function grantAccess() {
  const tab = state.activeTab;
  if (!tab || !/^https?:/.test(tab.url || "")) return;
  try {
    const u = new URL(tab.url);
    const granted = await api.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
    if (granted) updateTabBar();
  } catch (e) {
    status("Berechtigung konnte nicht angefragt werden: " + e.message);
  }
}

// ---------- pending context from background ----------
async function checkPending() {
  const got = await api.storage.local.get("claude.pending");
  const p = got["claude.pending"];
  if (p && p.prompt && Date.now() - p.ts < 60000) {
    await api.storage.local.remove("claude.pending");
    $("input").value = p.prompt;
    autoGrow();
    if (state.settings.apiKey) {
      const t = $("input").value;
      $("input").value = "";
      send(t);
    }
  }
}

// ---------- composer auto-grow ----------
function autoGrow() {
  const ta = $("input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
}

// ---------- image attachment ----------
function loadImageAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const max = 1536; // downscale to keep tokens/size sane
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/png");
        resolve({ data: dataUrl.split(",")[1], mediaType: "image/png" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function attachImage(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) return;
  try {
    state.pendingImage = await loadImageAttachment(file);
    renderAttachPreview();
  } catch (_) {
    status("Bild konnte nicht geladen werden.");
  }
}

function renderAttachPreview() {
  const box = $("attach-preview");
  box.innerHTML = "";
  if (!state.pendingImage) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const thumb = el("div", "thumb");
  const img = document.createElement("img");
  img.src = `data:${state.pendingImage.mediaType};base64,${state.pendingImage.data}`;
  const rm = el("button", "rm", "×");
  rm.title = "Entfernen";
  rm.onclick = () => {
    state.pendingImage = null;
    renderAttachPreview();
  };
  thumb.append(img, rm);
  box.appendChild(thumb);
}

// ---------- settings overlay ----------
function openSettings() {
  $("set-apikey").value = state.settings.apiKey || "";
  populateModelSelect($("set-model"));
  $("set-model").value = state.settings.model;
  $("set-effort").value = state.settings.effort;
  $("set-thinking").checked = !!state.settings.thinking;
  $("set-allsites").checked = !!state.settings.allowAllSites;
  $("set-vision").checked = !!state.settings.visionScreenshots;
  $("set-spend").value = state.settings.spendLimitUSD || 0;
  $("set-bridge").checked = !!state.settings.bridgeEnabled;
  $("set-bridge-token").value = state.settings.bridgeToken || "";
  $("settings").hidden = false;
}

// Start/stop the MCP bridge based on the current settings.
function applyBridge() {
  if (state.settings.bridgeEnabled && state.settings.bridgeToken) {
    startBridge({
      url: state.settings.bridgeUrl || "ws://127.0.0.1:8765",
      token: state.settings.bridgeToken,
      onStatus: (s) => {
        const map = {
          connected: "verbunden ✓",
          connecting: "verbinde …",
          reconnecting: "neu verbinden …",
          off: "getrennt",
          error: "Fehler (läuft der MCP-Server?)",
        };
        const el = document.getElementById("bridge-status");
        if (el) el.textContent = map[s] || s;
      },
    });
  } else {
    stopBridge();
  }
}

/** Is the active provider usable (e.g. API key present)? */
async function isReady() {
  try {
    const p = providerForSettings(state.settings);
    const v = await p.validateConfig(state.settings);
    return v.ok;
  } catch (_) {
    return false;
  }
}

async function applySettings() {
  state.settings.apiKey = $("set-apikey").value.trim();
  state.settings.model = $("set-model").value;
  state.settings.effort = $("set-effort").value;
  state.settings.thinking = $("set-thinking").checked;
  state.settings.visionScreenshots = $("set-vision").checked;
  state.settings.spendLimitUSD = parseFloat($("set-spend").value) || 0;
  state.settings.bridgeEnabled = $("set-bridge").checked;
  state.settings.bridgeToken = $("set-bridge-token").value.trim();

  // "Auf allen Seiten erlauben" — request/revoke <all_urls> once (this runs in a
  // user-gesture handler, so permissions.request is allowed).
  const wantAll = $("set-allsites").checked;
  if (wantAll && !state.settings.allowAllSites) {
    try {
      state.settings.allowAllSites = await api.permissions.request({ origins: ["<all_urls>"] });
    } catch (_) {
      state.settings.allowAllSites = false;
    }
    $("set-allsites").checked = state.settings.allowAllSites;
  } else if (!wantAll && state.settings.allowAllSites) {
    try {
      await api.permissions.remove({ origins: ["<all_urls>"] });
    } catch (_) {}
    state.settings.allowAllSites = false;
  }

  await saveSettings();
  $("model-select").value = state.settings.model;
  $("settings").hidden = true;
  status("Einstellungen gespeichert.");
  updateTabBar();
  applyBridge();
}

// ---------- export / import ----------
async function exportData() {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `claude-chats-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function importData() {
  $("import-file").click();
}

// ---------- wire up ----------
function bind() {
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = $("input").value;
    $("input").value = "";
    autoGrow();
    send(t);
  });
  $("input").addEventListener("input", autoGrow);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });
  // Image attachment: 📎 button, file picker, and paste (Ctrl+V).
  $("btn-attach").addEventListener("click", () => $("image-file").click());
  $("image-file").addEventListener("change", (e) => {
    attachImage(e.target.files[0]);
    e.target.value = "";
  });
  $("input").addEventListener("paste", (e) => {
    for (const it of e.clipboardData?.items || []) {
      if (it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          attachImage(f);
        }
        break;
      }
    }
  });
  $("btn-stop").addEventListener("click", () => {
    state.abort?.abort();
    setRunning(false);
    status("Abgebrochen.");
  });
  $("btn-new").addEventListener("click", newSession);
  $("btn-sessions").addEventListener("click", () => {
    const d = $("drawer");
    d.hidden = !d.hidden;
    if (!d.hidden) refreshSessions();
  });
  $("btn-settings").addEventListener("click", openSettings);
  $("btn-save-settings").addEventListener("click", applySettings);
  $("btn-close-settings").addEventListener("click", () => ($("settings").hidden = true));
  $("btn-grant").addEventListener("click", grantAccess);
  $("model-select").addEventListener("change", async (e) => {
    state.settings.model = e.target.value;
    await saveSettings();
  });
  $("btn-export").addEventListener("click", exportData);
  $("btn-import").addEventListener("click", importData);
  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await db.importAll(data);
      await refreshSessions();
      status("Import abgeschlossen.");
    } catch (err) {
      status("Import fehlgeschlagen: " + err.message);
    }
    e.target.value = "";
  });

  // Active-tab tracking
  api.tabs.onActivated.addListener(updateTabBar);
  api.tabs.onUpdated.addListener((id, info) => {
    if (info.status === "complete" || info.title) updateTabBar();
  });
  // Pending context pushed by background while sidebar is open
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes["claude.pending"]?.newValue) checkPending();
  });
}

async function init() {
  await loadSettings();
  populateModelSelect($("model-select"));
  bind();
  await updateTabBar();
  const sessions = await db.listSessions();
  if (sessions.length) await selectSession(sessions[0].id);
  else await newSession();
  await refreshSessions();
  await checkPending();
  if (!(await isReady())) openSettings();
  applyBridge();
}

init();
