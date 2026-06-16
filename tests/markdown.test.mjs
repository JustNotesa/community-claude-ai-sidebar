import { test } from "node:test";
import assert from "node:assert";
import { renderMarkdown } from "../src/ui/markdown.js";

test("escapes raw HTML", () => {
  const out = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!out.includes("<script>"));
  assert.ok(out.includes("&lt;script&gt;"));
});

test("formats bold, code, headings, lists", () => {
  const out = renderMarkdown("# Title\n\n**bold** and `code`\n\n- a\n- b");
  assert.ok(out.includes("<strong>bold</strong>"), out);
  assert.ok(out.includes("<code>code</code>"), out);
  assert.ok(out.includes("<li>a</li>"), out);
  assert.ok(/<h[3-6]>/.test(out), out);
});

test("renders fenced code blocks", () => {
  const out = renderMarkdown("```js\nconst x = 1;\n```");
  assert.ok(out.includes("<pre"), out);
  assert.ok(out.includes("const x = 1;"), out);
});

test("only linkifies http(s) URLs", () => {
  const out = renderMarkdown("[ok](https://a.com) and [bad](javascript:alert(1))");
  assert.ok(out.includes('href="https://a.com"'), out);
  assert.ok(!out.includes('href="javascript'), out);
});
