// Tiny dependency-free IndexedDB wrapper for PERSISTENT chat sessions.
//
// This is the headline improvement over Claude-for-Chrome: chats are stored
// durably in IndexedDB (plus `unlimitedStorage`) so they survive reloads,
// restarts and tab switches — they never silently disappear.
//
// Two object stores:
//   sessions  { id, title, model, pinned, createdAt, updatedAt }
//   messages  { id, sessionId, role, content, ts, usage? }
//
// `content` is stored verbatim as the Anthropic content array (text blocks,
// tool_use, tool_result, thinking...) so we can replay an exact conversation
// to the API on the next turn.

const DB_NAME = "claude-firefox";
const DB_VERSION = 1;

let _dbPromise = null;

function open() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const s = db.createObjectStore("sessions", { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
        s.createIndex("pinned", "pinned");
      }
      if (!db.objectStoreNames.contains("messages")) {
        const m = db.createObjectStore("messages", { keyPath: "id" });
        m.createIndex("sessionId", "sessionId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

function tx(storeNames, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(storeNames, mode);
        let result;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        result = fn(t);
      })
  );
}

const reqToPromise = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

// ---- Sessions -------------------------------------------------------------

export async function createSession({ title = "Neuer Chat", model } = {}) {
  const now = Date.now();
  const session = { id: uuid(), title, model, pinned: 0, createdAt: now, updatedAt: now };
  await tx("sessions", "readwrite", (t) => t.objectStore("sessions").put(session));
  return session;
}

export async function getSession(id) {
  return tx("sessions", "readonly", (t) => reqToPromise(t.objectStore("sessions").get(id)));
}

export async function listSessions() {
  const all = await tx("sessions", "readonly", (t) =>
    reqToPromise(t.objectStore("sessions").getAll())
  );
  // Pinned first, then most-recently-updated.
  return all.sort((a, b) => b.pinned - a.pinned || b.updatedAt - a.updatedAt);
}

export async function updateSession(id, patch) {
  const cur = await getSession(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await tx("sessions", "readwrite", (t) => t.objectStore("sessions").put(next));
  return next;
}

export async function touchSession(id) {
  return updateSession(id, {});
}

export async function deleteSession(id) {
  return tx(["sessions", "messages"], "readwrite", (t) => {
    t.objectStore("sessions").delete(id);
    const idx = t.objectStore("messages").index("sessionId");
    const cursorReq = idx.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur) {
        cur.delete();
        cur.continue();
      }
    };
  });
}

// ---- Messages -------------------------------------------------------------

export async function addMessage({ sessionId, role, content, usage = null }) {
  const msg = { id: uuid(), sessionId, role, content, usage, ts: Date.now() };
  await tx("messages", "readwrite", (t) => t.objectStore("messages").put(msg));
  await touchSession(sessionId);
  return msg;
}

export async function updateMessage(id, patch) {
  const cur = await tx("messages", "readonly", (t) =>
    reqToPromise(t.objectStore("messages").get(id))
  );
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await tx("messages", "readwrite", (t) => t.objectStore("messages").put(next));
  return next;
}

export async function getMessages(sessionId) {
  const all = await tx("messages", "readonly", (t) =>
    reqToPromise(t.objectStore("messages").index("sessionId").getAll(IDBKeyRange.only(sessionId)))
  );
  return all.sort((a, b) => a.ts - b.ts);
}

// ---- Export / Import ------------------------------------------------------

export async function exportAll() {
  const sessions = await listSessions();
  const out = { version: 1, exportedAt: Date.now(), sessions: [] };
  for (const s of sessions) {
    out.sessions.push({ ...s, messages: await getMessages(s.id) });
  }
  return out;
}

export async function importAll(data) {
  if (!data || !Array.isArray(data.sessions)) throw new Error("Ungültiges Backup-Format");
  for (const s of data.sessions) {
    const { messages = [], ...session } = s;
    await tx("sessions", "readwrite", (t) => t.objectStore("sessions").put(session));
    for (const m of messages) {
      await tx("messages", "readwrite", (t) => t.objectStore("messages").put(m));
    }
  }
}
