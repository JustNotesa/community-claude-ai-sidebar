import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUsageView, formatReset, parseResetDate } from "../src/util/usage.js";

const NOW = Date.parse("2026-06-17T12:00:00Z");

test("context window meter sums input + cache tokens", () => {
  const v = buildUsageView({
    usage: { input_tokens: 100, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 200 },
    model: { context: 1_000_000 },
    now: NOW,
  });
  assert.equal(v.context.used, 24_300);
  assert.equal(v.context.total, 1_000_000);
  assert.equal(v.context.percent, 2);
});

test("subscription: unified utilization headers → plan bars, 5h before 7d", () => {
  const v = buildUsageView({
    rateLimits: {
      "anthropic-ratelimit-unified-7d-utilization": "49",
      "anthropic-ratelimit-unified-7d-reset": "2026-06-20T00:00:00Z",
      "anthropic-ratelimit-unified-5h-utilization": "17",
      "anthropic-ratelimit-unified-5h-reset": "2026-06-17T23:59:00Z",
    },
    now: NOW,
  });
  assert.equal(v.source, "subscription");
  assert.equal(v.windows.length, 2);
  assert.equal(v.windows[0].label, "5-Stunden-Limit");
  assert.equal(v.windows[0].percent, 17);
  assert.equal(v.windows[1].label, "Wöchentlich");
  assert.equal(v.windows[1].percent, 49);
});

test("api-key tier: requests + token headers → used-percent bars", () => {
  const v = buildUsageView({
    rateLimits: {
      "anthropic-ratelimit-requests-limit": "50",
      "anthropic-ratelimit-requests-remaining": "40",
      "anthropic-ratelimit-requests-reset": "2026-06-17T12:01:00Z",
      "anthropic-ratelimit-input-tokens-limit": "500000",
      "anthropic-ratelimit-input-tokens-remaining": "250000",
    },
    now: NOW,
  });
  assert.equal(v.source, "apikey");
  assert.equal(v.windows[0].label, "Anfragen/Min");
  assert.equal(v.windows[0].percent, 20); // 10 of 50 used
  assert.equal(v.windows[1].percent, 50); // half the input tokens used
});

test("no readable headers → empty plan, source none", () => {
  const v = buildUsageView({ rateLimits: {}, now: NOW });
  assert.equal(v.source, "none");
  assert.deepEqual(v.windows, []);
});

test("formatReset: same day → time, later → date", () => {
  // Build now and reset in local time so the assertion is timezone-independent.
  const now = new Date(2026, 5, 17, 8, 0, 0);
  const sameDay = new Date(2026, 5, 17, 23, 59, 0);
  assert.equal(formatReset(sameDay.getTime(), now.getTime()), "Wird 23:59 zurückgesetzt");
  const later = new Date(2026, 5, 20, 0, 0, 0);
  assert.equal(formatReset(later.getTime(), now.getTime()), "Wird 20. Juni zurückgesetzt");
  assert.equal(formatReset("", now.getTime()), "");
});

test("parseResetDate handles unix seconds and ms", () => {
  assert.equal(parseResetDate("1750161540").getTime(), 1750161540 * 1000);
  assert.equal(parseResetDate("1750161540000").getTime(), 1750161540000);
  assert.equal(parseResetDate(""), null);
});
