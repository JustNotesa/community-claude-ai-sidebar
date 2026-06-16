// Tests the agent orchestration end-to-end with a stubbed Anthropic API and a
// stubbed WebExtension environment — no real key, no real browser. Validates:
// stream -> tool_use -> execute (read_page path) -> tool_result -> loop -> done.

import { test } from "node:test";
import assert from "node:assert";

function makeSSE(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    { status: 200 }
  );
}

const turn1 = [
  { type: "message_start", message: { usage: { input_tokens: 5 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Ich lese die Seite." } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "read_page" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 1 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } },
  { type: "message_stop" },
];
const turn2 = [
  { type: "message_start", message: { usage: { input_tokens: 20 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fertig: Das ist eine Testseite." } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
  { type: "message_stop" },
];

let fetchCalls = 0;
let lastBody = null;
globalThis.fetch = async (_url, opts) => {
  fetchCalls++;
  lastBody = JSON.parse(opts.body);
  return makeSSE(fetchCalls === 1 ? turn1 : turn2);
};

globalThis.browser = {
  tabs: {
    get: async () => ({ id: 1, url: "https://example.com/", windowId: 1, title: "Example" }),
    query: async () => [{ id: 1, url: "https://example.com/", active: true, title: "Example" }],
    update: async () => {},
    goBack: async () => {},
    goForward: async () => {},
    reload: async () => {},
    sendMessage: async (_id, msg) => {
      if (msg.action === "ping") return { ok: true };
      if (msg.action === "snapshot")
        return { ok: true, url: "https://example.com/", title: "Example", elementCount: 1, snapshot: '[1] button "OK"', text: "Hallo Welt" };
      return { ok: true };
    },
    onUpdated: { addListener() {}, removeListener() {} },
    captureVisibleTab: async () => "data:image/png;base64,AAAA",
  },
  scripting: { executeScript: async () => [{ result: true }] },
  permissions: { contains: async () => true },
};

const { runAgent } = await import("../src/agent/agent.js");

test("agent loop streams, runs read_page, and finishes", async () => {
  const history = [{ role: "user", content: "Was steht auf der Seite?" }];
  let text = "";
  const toolNames = [];
  let done = null;
  let err = null;

  await runAgent({
    history,
    settings: { apiKey: "sk-ant-test", model: "claude-opus-4-8", effort: "high" },
    tabId: 1,
    cb: {
      onTurnStart() {},
      onText: (t) => (text += t),
      onThinking() {},
      onAssistant: async () => {},
      onToolResultsPersist: async () => {},
      onToolUse: (tu) => toolNames.push(tu.name),
      onToolResult: () => {},
      onUsage: () => {},
      confirm: async () => true,
      onDone: (r) => (done = r),
      onError: (e) => (err = e),
    },
    signal: new AbortController().signal,
  });

  assert.equal(err, null, err && err.message);
  assert.equal(done, "fertig");
  assert.equal(fetchCalls, 2, "should loop for a second turn after the tool");
  assert.deepEqual(toolNames, ["read_page"]);
  assert.ok(text.includes("Fertig"), text);

  // History: user, assistant(turn1 w/ tool_use), user(tool_result), assistant(turn2)
  assert.equal(history.length, 4);
  assert.equal(history[1].role, "assistant");
  assert.ok(history[1].content.some((b) => b.type === "tool_use"));
  assert.equal(history[2].role, "user");
  assert.equal(history[2].content[0].type, "tool_result");

  // Request shape: effort sent for Opus, correct auth header path (body has model + tools)
  assert.equal(lastBody.model, "claude-opus-4-8");
  assert.ok(Array.isArray(lastBody.tools) && lastBody.tools.length > 0);
});

test("abort during tools still answers every tool_use (valid history)", async () => {
  fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return makeSSE(turn1); // a turn that ends with a read_page tool_use
  };
  const ctrl = new AbortController();
  const history = [{ role: "user", content: "x" }];
  await runAgent({
    history,
    settings: { apiKey: "sk-ant-test", model: "claude-opus-4-8" },
    tabId: 1,
    cb: {
      onTurnStart() {},
      onText() {},
      onThinking() {},
      onAssistant: async () => {},
      onToolResultsPersist: async () => {},
      onToolUse: () => ctrl.abort(), // abort the moment the tool is announced
      onToolResult() {},
      onUsage() {},
      confirm: async () => true,
      onDone() {},
      onError() {},
    },
    signal: ctrl.signal,
  });

  // History must end with a user message carrying the tool_result for the
  // aborted tool_use — never a dangling tool_use.
  const last = history[history.length - 1];
  assert.equal(last.role, "user");
  assert.ok(Array.isArray(last.content));
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].is_error, true);
});
