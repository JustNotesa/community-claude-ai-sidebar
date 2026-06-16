// WebSocket client that connects the sidebar to the local MCP bridge server,
// letting Claude Code / Claude Desktop drive Firefox through the SAME executeTool
// path the in-sidebar agent uses. Runs in the sidebar document (alive while open).

import { executeTool } from "../agent/agent.js";

const api = typeof browser !== "undefined" ? browser : chrome;

let ws = null;
let reconnectTimer = null;
let manualStop = false;
let cfg = { url: "ws://127.0.0.1:8765", token: "", onStatus: () => {} };

function activeTabId() {
  return api.tabs.query({ active: true, currentWindow: true }).then(([t]) => t?.id);
}

export function startBridge({ url, token, onStatus }) {
  cfg = { url: url || "ws://127.0.0.1:8765", token: token || "", onStatus: onStatus || (() => {}) };
  manualStop = false;
  connect();
}

export function stopBridge() {
  manualStop = true;
  clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(1000, "user"); } catch (_) {}
    ws = null;
  }
  cfg.onStatus("off");
}

function scheduleReconnect() {
  if (manualStop) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

function connect() {
  cfg.onStatus("connecting");
  try {
    ws = new WebSocket(cfg.url);
  } catch (_) {
    cfg.onStatus("error");
    return scheduleReconnect();
  }

  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token: cfg.token }));

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === "welcome") return cfg.onStatus("connected");
    if (msg.type === "error") return cfg.onStatus("error");

    // tool command: { id, tool, input }
    if (msg.id && msg.tool) {
      let content = "";
      let isError = false;
      try {
        const tabId = msg.input?.tab_id ?? (await activeTabId());
        if (tabId == null) throw new Error("Kein aktiver Web-Tab.");
        const res = await executeTool(msg.tool, msg.input || {}, { tabId });
        content = res.content; // string OR content-block array (screenshot)
        isError = !!res.is_error;
      } catch (e) {
        content = String(e?.message || e);
        isError = true;
      }
      try { ws.send(JSON.stringify({ id: msg.id, content, isError })); } catch (_) {}
    }
  };

  ws.onclose = () => {
    cfg.onStatus(manualStop ? "off" : "reconnecting");
    scheduleReconnect();
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
}
