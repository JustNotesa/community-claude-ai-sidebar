// Anthropic Messages API client + the API-key provider.
//
// The request/streaming machinery (buildBody, streamMessages, parseSSE) is
// shared with the OAuth/subscription provider — only the auth headers (and an
// optional required system prefix) differ between them.

import { API_URL, ANTHROPIC_VERSION, MAX_TOKENS, MODELS } from "../util/constants.js";

/** Headers for the API-key auth path (direct browser access). */
export function apiKeyHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** Build the request body shared by both providers. */
export function buildBody(settings, { system, messages, tools }) {
  const body = {
    model: settings.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    system,
    messages,
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }
  const model = MODELS.find((m) => m.id === settings.model);
  if (settings.thinking && model?.adaptiveThinking) body.thinking = { type: "adaptive" };
  if (settings.effort && model?.effort) body.output_config = { effort: settings.effort };
  return body;
}

/** USD cost of a usage object for a given model id. */
export function estimateCost(modelId, usage) {
  const m = MODELS.find((x) => x.id === modelId);
  if (!m || !usage) return 0;
  const inTok =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) * 0.1 +
    (usage.cache_creation_input_tokens || 0) * 1.25;
  const outTok = usage.output_tokens || 0;
  return (inTok * m.inPrice + outTok * m.outPrice) / 1_000_000;
}

/**
 * POST to the Messages API and parse the streamed response.
 * @returns {Promise<{content: object[], stop_reason: string, usage: object}>}
 */
export async function streamMessages({ headers, body, signal, onText, onThinking }) {
  const res = await fetch(API_URL, {
    method: "POST",
    credentials: "omit", // never attach the user's cookies to API calls
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      detail = err?.error?.message || detail;
    } catch (_) {
      /* non-JSON */
    }
    const e = new Error(`Anthropic API: ${detail}`);
    e.status = res.status;
    throw e;
  }

  // Capture rate-limit / usage-limit headers for the usage display. Which ones
  // are actually readable depends on the server's Access-Control-Expose-Headers
  // (cross-origin fetch); we keep whatever is exposed and parse it client-side.
  const rateLimits = {};
  res.headers.forEach((value, key) => {
    if (key.startsWith("anthropic-ratelimit-") || key === "retry-after") rateLimits[key] = value;
  });

  const result = await parseSSE(res.body, { onText, onThinking });
  result.rateLimits = rateLimits;
  return result;
}

export async function parseSSE(stream, { onText, onThinking } = {}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const blocks = [];
  let stopReason = null;
  let usage = {};

  const handleEvent = (data) => {
    let evt;
    try {
      evt = JSON.parse(data);
    } catch (_) {
      return;
    }
    switch (evt.type) {
      case "message_start":
        usage = { ...(evt.message?.usage || {}) };
        break;
      case "content_block_start": {
        const cb = evt.content_block || {};
        if (cb.type === "text") blocks[evt.index] = { type: "text", text: "" };
        else if (cb.type === "thinking")
          blocks[evt.index] = { type: "thinking", thinking: "", signature: "" };
        else if (cb.type === "tool_use")
          blocks[evt.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {}, _json: "" };
        else blocks[evt.index] = { ...cb };
        break;
      }
      case "content_block_delta": {
        const b = blocks[evt.index];
        const d = evt.delta || {};
        if (!b) break;
        if (d.type === "text_delta") {
          b.text += d.text;
          onText && onText(d.text);
        } else if (d.type === "thinking_delta") {
          b.thinking += d.thinking;
          onThinking && onThinking(d.thinking);
        } else if (d.type === "signature_delta") {
          b.signature += d.signature || "";
        } else if (d.type === "input_json_delta") {
          b._json += d.partial_json || "";
        }
        break;
      }
      case "content_block_stop": {
        const b = blocks[evt.index];
        if (b && b.type === "tool_use") {
          try {
            b.input = b._json ? JSON.parse(b._json) : {};
          } catch (_) {
            b.input = {};
          }
          delete b._json;
        }
        break;
      }
      case "message_delta":
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        if (evt.usage) usage = { ...usage, ...evt.usage };
        break;
      case "error":
        throw new Error(`Anthropic stream: ${evt.error?.message || "unbekannter Fehler"}`);
      default:
        break;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of chunk.split("\n")) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith("data:")) handleEvent(trimmed.slice(5).trim());
      }
    }
  }

  return { content: blocks.filter(Boolean), stop_reason: stopReason || "end_turn", usage };
}

export const anthropicProvider = {
  id: "anthropic",
  label: "Anthropic API (eigener Key)",
  validateConfig(settings) {
    if (!settings.apiKey || !settings.apiKey.startsWith("sk-ant-")) {
      return { ok: false, error: "Bitte einen gültigen Anthropic-API-Key (sk-ant-…) hinterlegen." };
    }
    return { ok: true };
  },
  streamTurn({ system, messages, tools, settings, signal, onText, onThinking }) {
    const body = buildBody(settings, { system, messages, tools });
    return streamMessages({
      headers: apiKeyHeaders(settings.apiKey),
      body,
      signal,
      onText,
      onThinking,
    });
  },
  estimateCost,
};
