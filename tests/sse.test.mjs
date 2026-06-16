import { test } from "node:test";
import assert from "node:assert";
import { parseSSE } from "../src/provider/anthropic.js";

// Build a ReadableStream of SSE bytes, chunked oddly to exercise the buffering.
function sseStream(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      const end = Math.min(i + 7, bytes.length); // tiny chunks straddle event boundaries
      c.enqueue(bytes.slice(i, end));
      i = end;
    },
  });
}

test("parseSSE assembles streamed text + tool_use input + usage", async () => {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hallo " } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Welt" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "click" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"ref":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: " 12}" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];

  let streamed = "";
  const r = await parseSSE(sseStream(events), { onText: (t) => (streamed += t) });

  assert.equal(streamed, "Hallo Welt");
  assert.equal(r.stop_reason, "tool_use");

  const textBlock = r.content.find((b) => b.type === "text");
  assert.equal(textBlock.text, "Hallo Welt");

  const toolBlock = r.content.find((b) => b.type === "tool_use");
  assert.equal(toolBlock.id, "tu_1");
  assert.equal(toolBlock.name, "click");
  assert.deepEqual(toolBlock.input, { ref: 12 });

  assert.equal(r.usage.output_tokens, 5);
  assert.equal(r.usage.input_tokens, 10);
});
