// Content script (classic, injected on demand). It is the extension's "hands
// and eyes" on a page: it builds a numbered ref-snapshot of interactive
// elements and performs clicks / typing / scrolling on them.
//
// Injected via scripting.executeScript; guarded so re-injection is harmless.

// Injected via scripting.executeScript({ func: contentScriptMain }) — must stay
// SELF-CONTAINED (no imports / no outer references) so it serializes correctly.
// Firefox's executeScript({files}) proved unreliable here ("Unable to load
// script"), so we inject the function source directly instead.
export function contentScriptMain() {
  if (window.__claudeAgentInstalled) return;
  window.__claudeAgentInstalled = true;

  const api =
    (typeof browser !== "undefined" && browser) ||
    (typeof chrome !== "undefined" && chrome) ||
    null;
  const MSG = "claude-content";
  const state = { refs: new Map() };

  const INTERACTIVE = [
    "a[href]", "button", "input", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=textbox]", "[role=checkbox]",
    "[role=radio]", "[role=tab]", "[role=menuitem]", "[role=combobox]",
    "[contenteditable=true]", "[contenteditable='']", "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function isVisible(el) {
    if (!el || !el.getClientRects) return false;
    if (el.disabled) return false;
    const rects = el.getClientRects();
    if (!rects.length) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0")
      return false;
    if (el.type === "hidden") return false;
    return true;
  }

  function accName(el) {
    const aria = el.getAttribute && el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = el.getAttribute && el.getAttribute("aria-labelledby");
    if (labelledby) {
      const txt = labelledby
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .trim();
      if (txt) return txt;
    }
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab && lab.textContent.trim()) return lab.textContent.trim();
    }
    const closestLabel = el.closest && el.closest("label");
    if (closestLabel && closestLabel.textContent.trim()) return closestLabel.textContent.trim();
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && (el.placeholder || el.value || el.name))
      return (el.placeholder || el.name || "").trim();
    if (el.alt) return el.alt.trim();
    if (el.title) return el.title.trim();
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return text.slice(0, 100);
  }

  function roleOf(el) {
    const explicit = el.getAttribute && el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "disclosure";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (["checkbox", "radio", "button", "submit", "reset"].includes(t)) return t;
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return "element";
  }

  // Traverse the document plus any open shadow roots.
  function collect(root, acc) {
    let nodes;
    try {
      nodes = root.querySelectorAll(INTERACTIVE);
    } catch (_) {
      nodes = [];
    }
    for (const el of nodes) {
      if (isVisible(el)) acc.push(el);
    }
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) {
      if (el.shadowRoot) collect(el.shadowRoot, acc);
    }
  }

  function snapshot({ include_text = true } = {}) {
    state.refs.clear();
    const els = [];
    collect(document, els);
    const lines = [];
    let ref = 1;
    for (const el of els.slice(0, 200)) {
      state.refs.set(ref, el);
      const role = roleOf(el);
      const name = accName(el).replace(/\s+/g, " ").trim();
      let extra = "";
      if (el.value !== undefined && ["textbox", "combobox"].includes(role))
        extra = ` value=${JSON.stringify((el.value || "").slice(0, 60))}`;
      if (el.checked !== undefined && ["checkbox", "radio"].includes(role))
        extra = el.checked ? " checked" : " unchecked";
      lines.push(`[${ref}] ${role} ${JSON.stringify(name)}${extra}`);
      ref++;
    }
    const out = {
      ok: true,
      url: location.href,
      title: document.title,
      elementCount: lines.length,
      snapshot: lines.join("\n"),
    };
    if (include_text) {
      out.text = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 8000);
    }
    return out;
  }

  function elByRef(ref) {
    const el = state.refs.get(Number(ref));
    if (!el || !el.isConnected) throw new Error(`Ref [${ref}] ist nicht mehr gültig — bitte read_page erneut aufrufen.`);
    return el;
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function typeInto(el, text, { submit = false, clear = true } = {}) {
    el.focus();
    if (el.isContentEditable) {
      if (clear) el.textContent = "";
      document.execCommand && document.execCommand("insertText", false, text);
      if (!el.textContent) el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    } else {
      setNativeValue(el, clear ? text : (el.value || "") + text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (submit) {
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      const form = el.form || el.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        try { form.requestSubmit(); } catch (_) { /* ignore */ }
      }
    }
    return { ok: true };
  }

  function waitSettled(timeout = 4000) {
    return new Promise((resolve) => {
      const start = Date.now();
      let quietTimer = null;
      const done = () => {
        if (quietTimer) clearTimeout(quietTimer);
        obs.disconnect();
        resolve();
      };
      const obs = new MutationObserver(() => {
        if (quietTimer) clearTimeout(quietTimer);
        if (Date.now() - start > timeout) return done();
        quietTimer = setTimeout(done, 400);
      });
      try {
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      } catch (_) {
        return resolve();
      }
      quietTimer = setTimeout(done, 600);
      setTimeout(done, timeout);
    });
  }

  // --- Visual "AI cursor": an orange pointer that travels to the target plus a
  // click ripple + brief outline, so the user can SEE where the agent acts
  // (like Claude for Chrome). pointer-events:none, never part of the snapshot. ---
  function ensureCursor() {
    let c = document.getElementById("__claude_ai_cursor");
    if (c) return c;
    c = document.createElement("div");
    c.id = "__claude_ai_cursor";
    c.setAttribute("aria-hidden", "true");
    c.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;" +
      "transition:left .35s cubic-bezier(.22,1,.36,1),top .35s cubic-bezier(.22,1,.36,1),opacity .2s;" +
      "filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));will-change:left,top;";
    c.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M4 2.2l6.4 15.8 2.4-6.5 6.5-2.4L4 2.2z" fill="#d97757" stroke="#ffffff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    (document.body || document.documentElement).appendChild(c);
    return c;
  }
  function aiCursorTo(el) {
    const c = ensureCursor();
    const r = el.getBoundingClientRect();
    c.style.opacity = "1";
    c.style.left = r.left + Math.min(r.width / 2, 10) + "px";
    c.style.top = r.top + Math.min(r.height / 2, 8) + "px";
  }
  function aiRipple(el) {
    const r = el.getBoundingClientRect();
    const ring = document.createElement("div");
    ring.setAttribute("aria-hidden", "true");
    ring.style.cssText =
      "position:fixed;left:" + (r.left + r.width / 2) + "px;top:" + (r.top + r.height / 2) + "px;" +
      "width:10px;height:10px;border:2px solid #d97757;border-radius:50%;z-index:2147483646;" +
      "pointer-events:none;transform:translate(-50%,-50%);";
    (document.body || document.documentElement).appendChild(ring);
    try {
      ring.animate(
        [{ width: "10px", height: "10px", opacity: 0.9 }, { width: "54px", height: "54px", opacity: 0 }],
        { duration: 520, easing: "ease-out" }
      ).onfinish = () => ring.remove();
    } catch (_) {
      setTimeout(() => ring.remove(), 520);
    }
    const prevOutline = el.style.outline, prevOffset = el.style.outlineOffset;
    el.style.outline = "2px solid #d97757";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 650);
  }
  const aiSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function showAction(el) {
    try {
      aiCursorTo(el);
      await aiSleep(380);
      aiRipple(el);
      await aiSleep(120);
    } catch (_) {
      /* visual only — never block the action */
    }
  }

  async function handle(action, args) {
    try {
      switch (action) {
        case "snapshot":
          return snapshot(args);
        case "click": {
          const el = elByRef(args.ref);
          el.scrollIntoView({ block: "center", behavior: "instant" });
          await showAction(el);
          el.click();
          // Respond immediately — a navigation would tear down this context and
          // the reply would be lost. The caller waits for the page to settle.
          return { ok: true };
        }
        case "type": {
          const el = elByRef(args.ref);
          el.scrollIntoView({ block: "center", behavior: "instant" });
          await showAction(el);
          const r = typeInto(el, args.text ?? "", args); // may submit + navigate
          return r;
        }
        case "select": {
          const el = elByRef(args.ref);
          el.scrollIntoView({ block: "center", behavior: "instant" });
          await showAction(el);
          let matched = false;
          for (const opt of el.options || []) {
            if (opt.value === args.value || opt.textContent.trim() === args.value) {
              el.value = opt.value;
              matched = true;
              break;
            }
          }
          if (!matched) return { ok: false, error: `Option "${args.value}" nicht gefunden.` };
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }
        case "scroll": {
          if (args.ref) {
            elByRef(args.ref).scrollIntoView({ block: "center", behavior: "instant" });
          } else if (args.direction === "top") window.scrollTo({ top: 0 });
          else if (args.direction === "bottom") window.scrollTo({ top: document.body.scrollHeight });
          else window.scrollBy({ top: args.direction === "up" ? -window.innerHeight * 0.8 : window.innerHeight * 0.8 });
          await waitSettled(1500);
          return { ok: true };
        }
        case "ping":
          return { ok: true };
        default:
          return { ok: false, error: `Unbekannte Aktion: ${action}` };
      }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  if (api && api.runtime && api.runtime.onMessage) {
    api.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== MSG) return undefined;
      return handle(msg.action, msg.args || {}); // Promise -> Firefox resolves it for sendMessage
    });
  }

  // Test/automation handle. In the extension's isolated content-script world this
  // property is invisible to the page; when injected into a plain page (e.g. by
  // Playwright) it lets tests drive the exact same logic.
  window.__claudeAgent = { handle, snapshot };
}
