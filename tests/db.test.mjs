import { test } from "node:test";
import assert from "node:assert";
import "fake-indexeddb/auto";

const db = await import("../src/storage/db.js");

test("sessions and messages persist, export/import, delete cascades", async () => {
  const s = await db.createSession({ title: "T", model: "claude-opus-4-8" });
  assert.ok(s.id);

  await db.addMessage({ sessionId: s.id, role: "user", content: "hallo" });
  await db.addMessage({ sessionId: s.id, role: "assistant", content: [{ type: "text", text: "yo" }] });

  const msgs = await db.getMessages(s.id);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[1].content[0].text, "yo");

  const list = await db.listSessions();
  assert.ok(list.find((x) => x.id === s.id));

  // updateSession bumps updatedAt and keeps fields
  const renamed = await db.updateSession(s.id, { title: "Neu", pinned: 1 });
  assert.equal(renamed.title, "Neu");
  assert.equal(renamed.pinned, 1);

  // export round-trips messages
  const exp = await db.exportAll();
  const exported = exp.sessions.find((x) => x.id === s.id);
  assert.equal(exported.messages.length, 2);

  // delete cascades to messages
  await db.deleteSession(s.id);
  assert.equal((await db.getMessages(s.id)).length, 0);
  assert.ok(!(await db.getSession(s.id)));

  // import restores
  await db.importAll(exp);
  assert.equal((await db.getMessages(s.id)).length, 2);
});

test("listSessions orders pinned first then recent", async () => {
  const a = await db.createSession({ title: "A" });
  const b = await db.createSession({ title: "B" });
  await db.updateSession(a.id, { pinned: 1 });
  const list = await db.listSessions();
  const ai = list.findIndex((x) => x.id === a.id);
  const bi = list.findIndex((x) => x.id === b.id);
  assert.ok(ai < bi, "pinned session should sort before unpinned");
});
