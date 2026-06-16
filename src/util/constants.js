// Central configuration shared across the extension (sidebar context, ES module).

/** Anthropic Messages API endpoint. */
export const API_URL = "https://api.anthropic.com/v1/messages";

/** API version header value (stable). */
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Models offered in the picker.
 * Pricing is USD per 1M tokens (input / output) — used by the cost estimator.
 * Context is the input context window.
 */
// `effort` / `adaptiveThinking` mark which knobs the model accepts. Sending
// output_config.effort to Haiku 4.5 returns a 400, so we gate on these flags.
export const MODELS = [
  { id: "claude-opus-4-8",   label: "Opus 4.8",   inPrice: 5, outPrice: 25, context: 1_000_000, effort: true,  adaptiveThinking: true },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", inPrice: 3, outPrice: 15, context: 1_000_000, effort: true,  adaptiveThinking: true },
  { id: "claude-haiku-4-5",  label: "Haiku 4.5",  inPrice: 1, outPrice: 5,  context:   200_000, effort: false, adaptiveThinking: false },
];

export const DEFAULT_MODEL = "claude-opus-4-8";

/** Max output tokens per response. We always stream, so we can be generous. */
export const MAX_TOKENS = 8000;

/** Hard cap on agent-loop iterations (tool round-trips) before we stop and ask. */
export const MAX_AGENT_STEPS = 30;

/** Authentication methods (pluggable provider selection). */
export const AUTH_METHODS = { API_KEY: "apikey", SUBSCRIPTION: "subscription" };

/**
 * Claude subscription (OAuth) — same flow Claude Code uses (Pro/Max login).
 * NOTE: values below follow the widely-used Claude Code OAuth client; they are
 * VERIFIED/corrected by the research pass before shipping. Subscription auth
 * via a third-party tool is a grey area vs. Anthropic's ToS — surfaced to the user.
 */
export const OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scopes: "org:create_api_key user:profile user:inference",
  betaHeader: "oauth-2025-04-20",
};

/** Some subscription tokens require the Claude Code identity as the first system block. */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** storage.local key holding the OAuth token bundle {access_token, refresh_token, expires_at}. */
export const OAUTH_KEY = "claude.oauth";

/** Keys used in browser.storage.local for settings. */
export const SETTINGS_KEY = "claude.settings";

/** Default settings written on first run. */
export const DEFAULT_SETTINGS = {
  authMethod: "apikey", // AUTH_METHODS.API_KEY | AUTH_METHODS.SUBSCRIPTION
  apiKey: "",
  model: DEFAULT_MODEL,
  thinking: false,          // adaptive thinking on/off (Opus 4.8 supports adaptive only)
  effort: "high",           // low | medium | high | xhigh | max
  allowAllSites: false,     // grant <all_urls> once instead of per-site prompts
  spendLimitUSD: 0,         // 0 = no limit; otherwise stop a run when estimated cost exceeds this
  visionScreenshots: false, // allow the screenshot tool to send images to the model
  bridgeEnabled: false,     // "Mit Claude verbinden" — connect to the local MCP bridge
  bridgeUrl: "ws://127.0.0.1:8765",
  bridgeToken: "",          // shared secret printed by the MCP server
};

/**
 * Runtime message types passed between sidebar <-> background <-> content script.
 * Keeping them in one place avoids typos across contexts.
 */
export const MSG = {
  // background -> sidebar (and sidebar polls on load)
  PENDING_CONTEXT: "pending-context",
  // content script command envelope (sidebar/background -> content)
  CONTENT: "claude-content",
};
