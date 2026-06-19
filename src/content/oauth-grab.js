// Content script injected ONLY on Anthropic's OAuth callback page. It reads the
// authorization code+state (from the URL query, falling back to the displayed
// "code#state" text on the page) and hands it to the extension via a runtime
// message. The sidebar exchanges it for tokens and closes this tab — so the
// subscription login completes without the user copy/pasting the code.
(() => {
  const api =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome) ||
    null;
  if (!api || !api.runtime) return;

  // A Claude OAuth code is "<code>#<state>", both long url-safe base64 strings.
  const CODE_RE = /[A-Za-z0-9_-]{16,}#[A-Za-z0-9_-]{16,}/;

  function fromUrl() {
    try {
      const q = new URL(location.href).searchParams;
      const code = q.get("code");
      const state = q.get("state");
      if (code) return state ? `${code}#${state}` : code;
    } catch (_) {}
    return null;
  }
  function fromDom() {
    const t =
      (document.body && (document.body.innerText || document.body.textContent)) || "";
    const m = t.match(CODE_RE);
    return m ? m[0] : null;
  }

  let sent = false;
  function grab() {
    if (sent) return true;
    const pasted = fromUrl() || fromDom();
    if (pasted) {
      sent = true;
      try {
        api.runtime.sendMessage({ type: "oauth-code", pasted });
      } catch (_) {}
      return true;
    }
    return false;
  }

  // The code may render a moment after load — retry briefly, then give up.
  if (!grab()) {
    let tries = 0;
    const iv = setInterval(() => {
      if (grab() || ++tries > 20) clearInterval(iv);
    }, 250);
  }
})();
