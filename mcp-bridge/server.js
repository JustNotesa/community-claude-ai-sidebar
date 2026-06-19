// Claude ↔ Firefox MCP bridge.
//
// Claude Code / Claude Desktop spawns this over stdio (MCP). It also runs a
// localhost WebSocket server; the Firefox extension's sidebar connects OUT to
// it, authenticates with a shared token, and executes the tool calls using the
// SAME content-script tooling the in-sidebar agent uses (executeTool).
//
//   Claude ──stdio(MCP)──▶ server.js ──ws://127.0.0.1:8765──▶ Firefox sidebar
//
// IMPORTANT: stdout carries JSON-RPC only. ALL logging goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const log = (...a) => console.error("[bridge]", ...a); // NEVER console.log

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 8765);

// Token: env var wins; else a persisted .token file (auto-created). The user
// copies this token into the Firefox extension's "Bridge-Token" field.
function resolveToken() {
  if (process.env.CLAUDE_BRIDGE_TOKEN) return process.env.CLAUDE_BRIDGE_TOKEN;
  const f = join(__dirname, ".token");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  const t = randomUUID();
  writeFileSync(f, t + "\n", { mode: 0o600 });
  return t;
}
const TOKEN = resolveToken();
log("Bridge token:", TOKEN);
log("Paste this token into the Firefox extension (⚙ → Bridge-Token).");

// ---- WebSocket server: single authenticated extension socket ---------------
let extension = null;
const pending = new Map(); // id -> { resolve, timer }

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("listening", () => log(`WS listening on ws://127.0.0.1:${PORT}`));
wss.on("error", (e) => {
  log("WS server error:", e.message, e.code === "EADDRINUSE" ? `(port ${PORT} in use — set CLAUDE_BRIDGE_PORT)` : "");
  process.exit(1);
});

wss.on("connection", (ws, req) => {
  const origin = req.headers.origin || "";
  const okOrigin = origin === "" || origin === "null" || origin.startsWith("moz-extension://");
  if (!okOrigin) {
    log("reject origin", origin);
    ws.close(1008, "bad origin");
    return;
  }
  let authed = false;
  const authTimer = setTimeout(() => { if (!authed) ws.close(1008, "auth timeout"); }, 5000);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!authed) {
      if (msg.type === "hello" && msg.token === TOKEN) {
        authed = true;
        clearTimeout(authTimer);
        extension = ws;
        ws.send(JSON.stringify({ type: "welcome" }));
        log("extension authenticated, origin:", origin || "(none)");
      } else {
        ws.close(1008, "unauthorized");
      }
      return;
    }
    const p = pending.get(msg.id);
    if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg); }
  });

  ws.on("close", () => { clearTimeout(authTimer); if (extension === ws) extension = null; });
  ws.on("error", (e) => log("ws error", e.message));
});

function callExtension(tool, input, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!extension || extension.readyState !== extension.OPEN) return reject(new Error("NO_EXTENSION"));
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("TIMEOUT")); }, timeoutMs);
    pending.set(id, { resolve, timer });
    extension.send(JSON.stringify({ id, tool, input }));
  });
}

// Map an extension round-trip to an MCP CallToolResult, with image passthrough.
async function runTool(tool, input) {
  try {
    const r = await callExtension(tool, input); // { id, content, isError }
    let blocks;
    if (Array.isArray(r.content)) {
      // e.g. screenshot: [{type:"image", source:{...}}, {type:"text", text}]
      blocks = r.content.map((b) =>
        b.type === "image"
          ? { type: "image", data: b.source?.data, mimeType: b.source?.media_type || "image/png" }
          : { type: "text", text: b.text ?? JSON.stringify(b) }
      );
    } else {
      blocks = [{ type: "text", text: String(r.content ?? "") }];
    }
    return { content: blocks, isError: !!r.isError };
  } catch (e) {
    const text =
      e.message === "NO_EXTENSION"
        ? 'Firefox-Bridge nicht verbunden. Öffne die Claude-Sidebar in Firefox und aktiviere „Mit Claude verbinden".'
        : e.message === "TIMEOUT"
          ? "Die Firefox-Erweiterung hat nicht rechtzeitig geantwortet (ist die Sidebar noch offen?)."
          : `Bridge-Fehler: ${e.message}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}

// ---- MCP server + tools -----------------------------------------------------
const server = new McpServer({ name: "claude-firefox-bridge", version: "0.1.0" });

const T = (name, cfg, map) => server.registerTool(name, cfg, (a) => runTool(name, map ? map(a) : a));

T("read_page", {
  title: "Read page",
  description: "Read the active Firefox tab; returns a numbered snapshot of interactive elements and visible text. Call first and after any page-changing action.",
  inputSchema: { include_text: z.boolean().optional() },
});
T("click", {
  title: "Click element",
  description: "Click an element by its [ref] number from the latest read_page snapshot.",
  inputSchema: { ref: z.number().int() },
});
T("type", {
  title: "Type text",
  description: "Type text into an input/textarea/contenteditable by its [ref]. Never use for passwords or payment fields.",
  inputSchema: { ref: z.number().int(), text: z.string(), submit: z.boolean().optional(), clear: z.boolean().optional() },
});
T("select", {
  title: "Select option",
  description: "Choose an option in a <select> dropdown by its [ref] and the option's visible text or value.",
  inputSchema: { ref: z.number().int(), value: z.string() },
});
T("scroll", {
  title: "Scroll",
  description: "Scroll the page or an element into view.",
  inputSchema: { direction: z.enum(["up", "down", "top", "bottom"]), ref: z.number().int().optional() },
});
T("navigate", {
  title: "Navigate tab",
  description: "Navigate the active tab: open an http(s) URL, or go back/forward/reload.",
  inputSchema: { action: z.enum(["url", "back", "forward", "reload"]), url: z.string().optional() },
});
T("open_tab", {
  title: "Open new tab",
  description: "Open an http(s) URL in a NEW browser tab; the current tab is left untouched. Returns the new tab's id — read it with read_tab. Use navigate to change the current tab instead.",
  inputSchema: { url: z.string(), active: z.boolean().optional() },
});
T("list_tabs", {
  title: "List tabs",
  description: "List open web tabs (id, title, url, active).",
  inputSchema: {},
});
T("read_tab", {
  title: "Read another tab",
  description: "Read another open tab by its id (from list_tabs).",
  inputSchema: { tab_id: z.number().int() },
});
T("wait", {
  title: "Wait",
  description: "Wait a number of milliseconds for the page to settle.",
  inputSchema: { ms: z.number().int() },
});
T("screenshot", {
  title: "Screenshot",
  description: "Capture a PNG of the visible part of the active tab (returned as an image).",
  inputSchema: {},
});

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server connected on stdio");

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
