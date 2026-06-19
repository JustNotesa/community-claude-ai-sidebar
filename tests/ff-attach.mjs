// Re-attach to the ALREADY-RUNNING Firefox started by ff-claude-live.mjs, from
// ANY session — no new browser is launched. Reads the saved WebDriver handle
// (.ff-session.json) and reconstructs a driver (4.45 dropped attachToSession).
//
// Per-session model: pass a session id with -s/--session (or env
// CLAUDE_SESSION_ID). Each session gets its OWN coloured Firefox container, and
// its opened tab URLs are persisted so they reopen when the session/window is
// reopened ("taken with it").
//
// Usage:
//   node tests/ff-attach.mjs                       # health check (handle, #tabs)
//   node tests/ff-attach.mjs tabs                  # ALL tabs + container ids
//   node tests/ff-attach.mjs front                 # bring window to the front
//   node tests/ff-attach.mjs -s <id> open <url>    # open <url> in THIS session's container (+persist)
//   node tests/ff-attach.mjs -s <id> restore       # reopen this session's persisted tabs
//   node tests/ff-attach.mjs -s <id> tabs          # this session's live tabs
//   node tests/ff-attach.mjs -s <id> close         # close this session's tabs (keep them persisted)
//   node tests/ff-attach.mjs -s <id> forget        # drop this session's container + persisted tabs

import { execSync } from "node:child_process";
import selenium from "selenium-webdriver";
import httpMod from "selenium-webdriver/http/index.js"; // ESM needs explicit file
import commandMod from "selenium-webdriver/lib/command.js";
import {
  loadHandle, loadRegistry, saveRegistry, sessionEntry,
  ensureContainer, openInContainer, restoreSession,
} from "./ff-lib.mjs";

const { WebDriver, Session, Capabilities } = selenium;
const { Executor, HttpClient } = httpMod;
const { Command } = commandMod;

// ---- parse args: optional -s <session>, then <action> [arg] ---------------
let sessionId = process.env.CLAUDE_SESSION_ID || null;
const rest = [];
const av = process.argv.slice(2);
for (let i = 0; i < av.length; i++) {
  if (av[i] === "-s" || av[i] === "--session") sessionId = av[++i];
  else rest.push(av[i]);
}
const [action = "health", arg] = rest;

// ---- reconstruct a driver bound to the live session -----------------------
const info = loadHandle();
const executor = new Executor(new HttpClient(info.url));
executor.defineCommand("setContext", "POST", "/session/:sessionId/moz/context");
const driver = new WebDriver(new Session(info.sessionId, new Capabilities()), executor);

const setContext = (ctx) => driver.execute(new Command("setContext").setParameter("context", ctx));
const exec = (s, ...a) => driver.executeScript(s, ...a);
const needSession = () => {
  if (!sessionId) throw new Error(`action "${action}" needs -s <session-id> (or CLAUDE_SESSION_ID)`);
  return sessionId;
};

try {
  if (action === "front") {
    execSync(`osascript -e 'tell application "Firefox" to activate'`);
    console.log("brought to front");

  } else if (action === "open") {
    if (!arg) throw new Error("usage: -s <id> open <url>");
    const reg = loadRegistry();
    const entry = sessionEntry(reg, needSession());
    await setContext("chrome");
    await ensureContainer(exec, entry);
    await openInContainer(exec, arg, entry.userContextId);
    await setContext("content");
    if (!entry.tabs.includes(arg)) entry.tabs.push(arg);
    saveRegistry(reg);
    console.log(`opened in container "${entry.container}" (${entry.color}, #${entry.userContextId}): ${arg}`);

  } else if (action === "restore") {
    const reg = loadRegistry();
    const entry = reg[needSession()];
    if (!entry) throw new Error(`unknown session "${sessionId}"`);
    await setContext("chrome");
    const n = await restoreSession(exec, entry);
    await setContext("content");
    saveRegistry(reg);
    console.log(`restored ${n} tab(s) into container "${entry.container}" (${entry.color})`);

  } else if (action === "close") {
    const reg = loadRegistry();
    const entry = reg[needSession()];
    if (!entry) throw new Error(`unknown session "${sessionId}"`);
    await setContext("chrome");
    await exec(
      `const uc = String(arguments[0]);
       for (const t of [...gBrowser.tabs]) if (t.getAttribute("usercontextid") === uc) gBrowser.removeTab(t);`,
      entry.userContextId
    );
    await setContext("content");
    console.log(`closed live tabs of "${entry.container}" (still persisted: ${entry.tabs.length})`);

  } else if (action === "forget") {
    const reg = loadRegistry();
    const entry = reg[needSession()];
    if (!entry) throw new Error(`unknown session "${sessionId}"`);
    await setContext("chrome");
    await exec(
      `const uc = arguments[0];
       for (const t of [...gBrowser.tabs]) if (t.getAttribute("usercontextid") === String(uc)) gBrowser.removeTab(t);
       try {
         const { ContextualIdentityService } = ChromeUtils.importESModule("resource://gre/modules/ContextualIdentityService.sys.mjs");
         if (uc != null) ContextualIdentityService.remove(uc);
       } catch (e) {}`,
      entry.userContextId
    );
    await setContext("content");
    delete reg[sessionId];
    saveRegistry(reg);
    console.log(`forgot session "${sessionId}" (container + persisted tabs removed)`);

  } else if (action === "tabs") {
    await setContext("chrome");
    let rows = await exec(
      `return gBrowser.tabs.map(t => ({ title: t.label, container: t.getAttribute("usercontextid") || null }));`
    );
    await setContext("content");
    if (sessionId) {
      const reg = loadRegistry();
      const uc = reg[sessionId]?.userContextId;
      rows = rows.filter((r) => r.container === String(uc));
    }
    console.log(JSON.stringify(rows, null, 2));

  } else {
    // health — proves this separate process controls the live window.
    await setContext("content").catch(() => {});
    const handles = await driver.getAllWindowHandles();
    console.log(JSON.stringify({ ok: true, attachedTo: info.url, webdriverSession: info.sessionId, windowTabs: handles.length }, null, 2));
  }
} catch (e) {
  console.error("ATTACH FAILED:", e && (e.message || e));
  process.exitCode = 1;
}
// NOTE: never call driver.quit() — that would close the shared window.
