// Turns raw Anthropic rate-limit response headers + token usage into the data
// the usage panel renders: a context-window meter plus "plan usage" bars.
//
// Two header families exist (see docs):
//   • Subscription / Claude-Abo (OAuth): anthropic-ratelimit-unified-<win>-utilization
//     and -reset, where <win> is "5h", "7d", … and utilization is a 0–100 percent.
//   • API-key tiers: anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-
//     {limit,remaining,reset}.
// We render whichever family the server exposed (cross-origin fetch only sees
// headers listed in Access-Control-Expose-Headers).

const GERMAN_MONTHS = [
  "Jan.", "Feb.", "März", "Apr.", "Mai", "Juni",
  "Juli", "Aug.", "Sept.", "Okt.", "Nov.", "Dez.",
];

const UNIFIED_LABELS = { "5h": "5-Stunden-Limit", "7d": "Wöchentlich" };

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** Parse an RFC-3339 string or unix (s/ms) epoch into a Date, or null. */
export function parseResetDate(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return new Date(n < 1e12 ? n * 1000 : n); // seconds vs milliseconds
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** "Wird 23:59 zurückgesetzt" (today) or "Wird 20. Juni zurückgesetzt" (later). */
export function formatReset(value, now = Date.now()) {
  const d = parseResetDate(value);
  if (!d) return "";
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `Wird ${hh}:${mm} zurückgesetzt`;
  }
  return `Wird ${d.getDate()}. ${GERMAN_MONTHS[d.getMonth()]} zurückgesetzt`;
}

function unifiedWindows(rl, now) {
  const out = [];
  for (const key of Object.keys(rl)) {
    const m = key.match(/^anthropic-ratelimit-unified-(.+)-utilization$/);
    if (!m) continue;
    const id = m[1];
    out.push({
      id,
      label: UNIFIED_LABELS[id] || `Limit (${id})`,
      // The server reports unified utilization as a 0–1 fraction (e.g. 0.17 = 17%;
      // the sibling -fallback-percentage:0.5 confirms the scale), so scale to percent.
      percent: clampPct(Number(rl[key]) * 100),
      detail: formatReset(rl[`anthropic-ratelimit-unified-${id}-reset`], now),
    });
  }
  // 5h first, then 7d, then any others alphabetically.
  const rank = (id) => (id === "5h" ? 0 : id === "7d" ? 1 : 2);
  out.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return out;
}

function tierWindow(rl, prefix, label, now) {
  const limit = Number(rl[`anthropic-ratelimit-${prefix}-limit`]);
  const remaining = Number(rl[`anthropic-ratelimit-${prefix}-remaining`]);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  const reset = formatReset(rl[`anthropic-ratelimit-${prefix}-reset`], now);
  return {
    id: prefix,
    label,
    percent: clampPct((1 - remaining / limit) * 100),
    detail: `${remaining.toLocaleString("de-DE")} / ${limit.toLocaleString("de-DE")} übrig${reset ? " · " + reset : ""}`,
  };
}

function tierWindows(rl, now) {
  const out = [];
  const reqs = tierWindow(rl, "requests", "Anfragen/Min", now);
  if (reqs) out.push(reqs);
  const inTok = tierWindow(rl, "input-tokens", "Input-Tokens/Min", now);
  const outTok = tierWindow(rl, "output-tokens", "Output-Tokens/Min", now);
  if (inTok) out.push(inTok);
  if (outTok) out.push(outTok);
  if (!inTok && !outTok) {
    const tok = tierWindow(rl, "tokens", "Tokens/Min", now);
    if (tok) out.push(tok);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object} [opts.rateLimits] raw header map (lowercased keys)
 * @param {object} [opts.usage] token usage from the last turn
 * @param {object} [opts.model] MODELS entry ({context})
 * @param {number} [opts.now] epoch ms (for testing)
 * @returns {{context: ?object, windows: object[], source: string}}
 */
export function buildUsageView({ rateLimits = {}, usage = null, model = null, now = Date.now() } = {}) {
  let context = null;
  if (usage && model && model.context) {
    const used =
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);
    context = { used, total: model.context, percent: clampPct((used / model.context) * 100) };
  }

  const unified = unifiedWindows(rateLimits, now);
  if (unified.length) return { context, windows: unified, source: "subscription" };

  const tier = tierWindows(rateLimits, now);
  if (tier.length) return { context, windows: tier, source: "apikey" };

  return { context, windows: [], source: "none" };
}
