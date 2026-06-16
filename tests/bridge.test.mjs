// Integration test for the MCP bridge server: speaks real MCP JSON-RPC over the
// server's stdio, and simulates the Firefox extension over WebSocket.

import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "../mcp-bridge/server.js");
const PORT = 8700 + Math.floor(Math.random() * 90); // random, avoids clashes across runs
const TOKEN = "test-token";

const rpc = (child, obj) => child.stdin.write(JSON.stringify(obj) + "\n");

test("MCP server: tools/list, NO_EXTENSION soft error, and a tool round-trip", async () => {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, CLAUDE_BRIDGE_TOKEN: TOKEN, CLAUDE_BRIDGE_PORT: String(PORT) },
    stdio: ["pipe", "pipe", "ignore"],
  });

  const responses = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && responses.has(m.id)) {
        responses.get(m.id)(m);
        responses.delete(m.id);
      }
    }
  });
  const waitFor = (id, ms = 5000) =>
    new Promise((res, rej) => {
      responses.set(id, res);
      setTimeout(() => rej(new Error(`timeout waiting for id ${id}`)), ms);
    });

  try {
    await new Promise((r) => setTimeout(r, 900)); // let the WS server bind

    rpc(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await waitFor(1);
    rpc(child, { jsonrpc: "2.0", method: "notifications/initialized" });

    // tools/list — registration via the MCP SDK works
    rpc(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const list = await waitFor(2);
    const names = list.result.tools.map((t) => t.name);
    for (const n of ["read_page", "click", "type", "navigate", "list_tabs", "screenshot"]) {
      assert.ok(names.includes(n), `tool ${n} should be registered (got ${names.join(",")})`);
    }

    // tools/call with no extension connected -> soft error
    rpc(child, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_tabs", arguments: {} } });
    const noext = await waitFor(3);
    assert.equal(noext.result.isError, true);
    assert.match(noext.result.content[0].text, /nicht verbunden|Bridge/i);

    // connect a fake extension, authenticate, and do a real round-trip
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("ws open failed"));
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && msg.tool) ws.send(JSON.stringify({ id: msg.id, content: `[fake] ${msg.tool}`, isError: false }));
    };
    ws.send(JSON.stringify({ type: "hello", token: TOKEN }));
    await new Promise((r) => setTimeout(r, 300));

    rpc(child, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_tabs", arguments: {} } });
    const ok = await waitFor(4);
    assert.equal(ok.result.isError, false);
    assert.equal(ok.result.content[0].text, "[fake] list_tabs");

    // wrong token must be rejected
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const rejected = await new Promise((res) => {
      bad.onopen = () => bad.send(JSON.stringify({ type: "hello", token: "wrong" }));
      bad.onclose = () => res(true);
      bad.onerror = () => res(true);
      setTimeout(() => res(false), 2000);
    });
    assert.ok(rejected, "wrong token should be closed");

    ws.close();
  } finally {
    child.kill("SIGTERM");
  }
});
