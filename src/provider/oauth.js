// Claude subscription provider — logs in with the user's Claude (Pro/Max)
// account via the Claude Code OAuth flow and calls /v1/messages with a Bearer
// token. No API key, no per-token billing.
//
// Flow (PKCE, manual paste): the OAuth client's redirect_uri is a fixed
// Anthropic callback page that DISPLAYS a code, so we open the authorize URL in
// a tab, the user copies the shown code and pastes it back; we exchange it for
// tokens and auto-refresh thereafter.
//
// Endpoint/param values come from constants.OAUTH and are MUST-TEST until the
// research pass confirms them.

import { ANTHROPIC_VERSION, OAUTH, OAUTH_KEY, CLAUDE_CODE_SYSTEM } from "../util/constants.js";
import { buildBody, streamMessages } from "./anthropic.js";

const api = (typeof browser !== "undefined" && browser) || (typeof chrome !== "undefined" && chrome);
const PKCE_KEY = "claude.oauth.pkce";

// ---- token storage --------------------------------------------------------
async function loadTokens() {
  const g = await api.storage.local.get(OAUTH_KEY);
  return g[OAUTH_KEY] || null;
}
async function saveTokens(t) {
  await api.storage.local.set({ [OAUTH_KEY]: t });
}
async function logout() {
  await api.storage.local.remove(OAUTH_KEY);
}

// ---- PKCE -----------------------------------------------------------------
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}
async function challengeOf(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
}

// ---- login flow -----------------------------------------------------------
/** Build the authorize URL and stash the PKCE verifier/state for the exchange. */
async function startLogin() {
  const verifier = randomToken();
  const state = randomToken();
  const code_challenge = await challengeOf(verifier);
  const url = new URL(OAUTH.authorizeUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", OAUTH.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH.redirectUri);
  url.searchParams.set("scope", OAUTH.scopes);
  url.searchParams.set("code_challenge", code_challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  await api.storage.local.set({ [PKCE_KEY]: { verifier, state } });
  return url.toString();
}

/** Exchange the pasted code (often "code#state") for tokens. */
async function exchangeCode(pasted) {
  const g = await api.storage.local.get(PKCE_KEY);
  const pkce = g[PKCE_KEY];
  if (!pkce) throw new Error("Kein Login gestartet — bitte zuerst „Anmelden“ klicken.");
  const [code, stateFromCode] = String(pasted).trim().split("#");
  // Form-urlencoded, matching the official browser extension's token exchange
  // (the API expects application/x-www-form-urlencoded here, not JSON).
  const res = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OAUTH.clientId,
      code,
      redirect_uri: OAUTH.redirectUri,
      state: stateFromCode || pkce.state,
      code_verifier: pkce.verifier,
    }),
  });
  if (!res.ok) {
    let d = `HTTP ${res.status}`;
    try {
      d = JSON.stringify(await res.json());
    } catch (_) {}
    throw new Error(`Token-Tausch fehlgeschlagen: ${d}`);
  }
  const data = await res.json();
  await saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  });
  await api.storage.local.remove(PKCE_KEY);
  return true;
}

async function refresh(refresh_token) {
  const res = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: OAUTH.clientId, refresh_token }),
  });
  if (!res.ok) throw new Error("Token-Refresh fehlgeschlagen — bitte erneut anmelden.");
  const data = await res.json();
  const t = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
  };
  await saveTokens(t);
  return t;
}

async function getValidToken(force = false) {
  let t = await loadTokens();
  if (!t || !t.access_token) throw new Error("Nicht angemeldet.");
  if (force || (t.expires_at && Date.now() > t.expires_at - 60_000)) {
    t = await refresh(t.refresh_token);
  }
  return t.access_token;
}

// ---- request --------------------------------------------------------------
function bearerHeaders(token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": OAUTH.betaHeader,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

export const subscriptionProvider = {
  id: "subscription",
  label: "Claude-Abo (Login)",
  async validateConfig() {
    const t = await loadTokens();
    return t?.access_token
      ? { ok: true }
      : { ok: false, error: "Bitte mit deinem Claude-Konto anmelden (Einstellungen → Anmelden)." };
  },
  async streamTurn({ system, messages, tools, settings, signal, onText, onThinking }) {
    // Subscription tokens are scoped to Claude Code — prepend its identity as the
    // first system block (MUST-TEST: confirm requirement with the research pass).
    const sys = [
      { type: "text", text: CLAUDE_CODE_SYSTEM },
      { type: "text", text: system },
    ];
    const body = buildBody(settings, { system: sys, messages, tools });
    const token = await getValidToken();
    try {
      return await streamMessages({ headers: bearerHeaders(token), body, signal, onText, onThinking });
    } catch (e) {
      if (e.status === 401) {
        const fresh = await getValidToken(true);
        return streamMessages({ headers: bearerHeaders(fresh), body, signal, onText, onThinking });
      }
      throw e;
    }
  },
  estimateCost: () => 0, // covered by the subscription, no per-token cost shown
  // exposed for the settings UI:
  oauth: { startLogin, exchangeCode, loadTokens, logout },
};
