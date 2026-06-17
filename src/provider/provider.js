// Pluggable provider layer.
//
// Today we ship a single provider (Anthropic API key). The registry exists so
// future backends — a local proxy, an OAuth/session login, OpenRouter, Ollama —
// can be added without touching the agent loop or the UI: each just implements
// { id, label, validateConfig, streamTurn, estimateCost }.

import { anthropicProvider } from "./anthropic.js";
import { subscriptionProvider } from "./oauth.js";
import { AUTH_METHODS } from "../util/constants.js";

const registry = new Map();

export function registerProvider(p) {
  registry.set(p.id, p);
}

export function getProvider(id = "anthropic") {
  return registry.get(id) || registry.get("anthropic");
}

export function listProviders() {
  return [...registry.values()];
}

/** Pick the provider for the user's chosen auth method. */
export function providerForSettings(settings) {
  return getProvider(
    settings?.authMethod === AUTH_METHODS.SUBSCRIPTION ? "subscription" : "anthropic"
  );
}

registerProvider(anthropicProvider);
registerProvider(subscriptionProvider);
