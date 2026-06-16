(() => {
  const a = (typeof browser !== "undefined" && browser) || (typeof chrome !== "undefined" && chrome) || null;
  if (a && a.runtime && a.runtime.onMessage) {
    a.runtime.onMessage.addListener((m) => (m && m.action === "ping" ? Promise.resolve({ ok: true, probe: true }) : undefined));
  }
})();
