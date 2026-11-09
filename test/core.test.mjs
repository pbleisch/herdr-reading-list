import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListing, normalizeItem, typeOf, openAction, itemFile } from "../mods/readlist/core/items.js";
import { parseState, serializeState, isRead, isDone, applyAction, prune, rowsFor, counts, ago, who } from "../mods/readlist/core/state.js";
import { addToSidebar, BLOCK } from "../layout/add-to-sidebar.mjs";

const item = (over = {}) => ({
  v: 1,
  id: "0123456789abcdef",
  path: "/tmp/plan.md",
  url: null,
  title: "plan.md",
  note: "why",
  kind: "review",
  added_at: "2026-11-08T18:00:00Z",
  adds: 1,
  by: { terminal: "t7", app: "claude-code", name: "fix", space: "sp1", tab: "tb1", cwd: "/tmp", from: null },
  size: 10,
  mtime: "2026-11-08T17:59:00Z",
  done_at: null,
  ...over,
});
const norm = (over) => normalizeItem(item(over));

test("parseListing reads records and skips broken or foreign ones", () => {
  const out = [
    JSON.stringify(item()),
    "{not json",
    JSON.stringify({ v: 2, id: "0123456789abcdee" }),
    JSON.stringify(item({ id: "short" })),
    JSON.stringify(item({ id: "1111111111111111", path: "relative.md" })),
    JSON.stringify(item({ id: "2222222222222222", path: null, url: "https://x.dev/a" })),
    JSON.stringify(item({ id: "3333333333333333", path: null, url: "file:///etc/passwd" })),
  ].map((s) => "\x1e" + s + "\n").join("");
  const items = parseListing(out);
  assert.deepEqual(items.map((i) => i.id).sort(), ["0123456789abcdef", "2222222222222222"]);
});

test("parseListing keeps the later add when two files share an id", () => {
  const out = "\x1e" + JSON.stringify(item({ note: "old" })) + "\x1e" + JSON.stringify(item({ note: "new", added_at: "2026-11-08T19:00:00Z" }));
  assert.equal(parseListing(out)[0].note, "new");
});

test("normalizeItem fills defaults", () => {
  const i = norm({ title: "", note: "  ", kind: "weird", adds: 0, by: null });
  assert.equal(i.title, "plan.md");
  assert.equal(i.note, null);
  assert.equal(i.kind, "review");
  assert.equal(i.adds, 1);
  assert.equal(i.by.terminal, null);
  assert.equal(norm({ path: null, url: "https://herdr.dev/mods", title: null }).title, "herdr.dev/mods");
  assert.equal(norm({ added_at: "yesterday" }), null);
});

test("typeOf picks the icon from the extension and the file kind", () => {
  assert.equal(typeOf(norm()), "md");
  assert.equal(typeOf(norm({ path: "/a/b.PNG" })), "image");
  assert.equal(typeOf(norm({ path: "/a/index.html" })), "html");
  assert.equal(typeOf(norm({ path: "/a/x.pdf" })), "pdf");
  assert.equal(typeOf(norm({ path: "/a/x.ts" })), "code");
  assert.equal(typeOf(norm({ path: "/a/build" }), "d"), "folder");
  assert.equal(typeOf(norm({ path: "/a/x.bin" })), "file");
  assert.equal(typeOf(norm({ path: null, url: "https://x.dev" })), "url");
});

test("openAction never opens what could run", () => {
  assert.deepEqual(openAction(norm(), "f"), { how: "open", target: "/tmp/plan.md" });
  assert.equal(openAction(norm(), "x").how, "reveal");
  assert.equal(openAction(norm(), "-").how, "missing");
  assert.equal(openAction(norm(), null).how, "missing");
  for (const p of ["/a/Tool.app", "/a/run.command", "/a/x.sh", "/a/x.pkg", "/a/x.webloc", "/a/x.py", "/a/x.jar", "/a/x.terminal"]) {
    assert.equal(openAction(norm({ path: p }), p.endsWith(".app") ? "d" : "f").how, "reveal", p);
  }
  assert.equal(openAction(norm({ path: "/a/folder" }), "d").how, "open");
  assert.equal(openAction(norm({ path: "/a/Thing.bundle" }), "d").how, "reveal");
  assert.deepEqual(openAction(norm({ path: null, url: "https://x.dev/a" }), null), { how: "url", target: "https://x.dev/a" });
});

test("itemFile only names an item file under the list folder", () => {
  assert.equal(itemFile("/l/rl/", "0123456789abcdef"), "/l/rl/items/0123456789abcdef.json");
  for (const id of ["../state", "0123456789ABCDEF", "", "0123456789abcdef/..", null]) assert.throws(() => itemFile("/l", id), String(id));
  assert.throws(() => itemFile("", "0123456789abcdef"));
  assert.throws(() => itemFile(undefined, "0123456789abcdef"));
});

test("parseState tolerates junk and keeps only valid times", () => {
  assert.deepEqual(parseState(null), { v: 1, items: {} });
  assert.deepEqual(parseState("{oops"), { v: 1, items: {} });
  const s = parseState(JSON.stringify({ v: 1, items: { a: { read_at: "2026-11-08T18:00:00Z", done_at: "no", x: 1 }, b: 3 } }));
  assert.deepEqual(s, { v: 1, items: { a: { read_at: "2026-11-08T18:00:00Z" } } });
  assert.deepEqual(parseState(serializeState(s)), s);
});

test("read: a re-add makes an item unread again", () => {
  const i = norm();
  let s = parseState(null);
  assert.equal(isRead(i, s), false);
  s = applyAction(s, i.id, "read", "2026-11-08T18:05:00.000Z");
  assert.equal(isRead(i, s), true);
  assert.equal(isRead(norm({ added_at: "2026-11-08T18:10:00Z" }), s), false);
  s = applyAction(s, i.id, "unread", "2026-11-08T18:06:00.000Z");
  assert.equal(isRead(i, s), false);
});

test("done: the latest of rl done, the person's done and not-done wins", () => {
  const i = norm();
  let s = parseState(null);
  assert.equal(isDone(i, s), false);
  assert.equal(isDone(norm({ done_at: "2026-11-08T18:01:00Z" }), s), true);
  s = applyAction(s, i.id, "done", "2026-11-08T18:02:00.000Z");
  assert.equal(isDone(i, s), true);
  s = applyAction(s, i.id, "undone", "2026-11-08T18:02:00.500Z");
  assert.equal(isDone(i, s), false);
  assert.equal(s.items[i.id].done_at, undefined);
  // rl done after the person's "not done" makes it done again.
  assert.equal(isDone(norm({ done_at: "2026-11-08T18:03:00Z" }), s), true);
  // A re-add after done brings it back.
  s = applyAction(s, i.id, "done", "2026-11-08T18:04:00.000Z");
  assert.equal(isDone(norm({ added_at: "2026-11-08T18:05:00Z" }), s), false);
});

test("applyAction leaves its input alone and rejects unknown actions", () => {
  const s = parseState(null);
  applyAction(s, "x", "read", "2026-11-08T18:00:00Z");
  assert.deepEqual(s.items, {});
  assert.throws(() => applyAction(s, "x", "explode", "2026-11-08T18:00:00Z"));
});

test("prune drops old entries for items no longer listed", () => {
  const now = Date.parse("2026-12-30T00:00:00Z");
  const s = { v: 1, items: { gone: { read_at: "2026-11-01T00:00:00Z" }, recent: { read_at: "2026-12-29T00:00:00Z" }, listed: { read_at: "2026-11-01T00:00:00Z" } } };
  assert.deepEqual(Object.keys(prune(s, ["listed"], now).items).sort(), ["listed", "recent"]);
  const kept = { v: 1, items: { listed: {} } };
  assert.equal(prune(kept, ["listed"], now), kept);
});

test("rowsFor: unread first, a Read header, done items only in the done view", () => {
  const a = norm({ id: "aaaaaaaaaaaaaaaa", added_at: "2026-11-08T18:00:00Z" });
  const b = norm({ id: "bbbbbbbbbbbbbbbb", added_at: "2026-11-08T19:00:00Z" });
  const c = norm({ id: "cccccccccccccccc", added_at: "2026-11-08T20:00:00Z" });
  const d = norm({ id: "dddddddddddddddd", added_at: "2026-11-08T21:00:00Z", done_at: "2026-11-08T22:00:00Z" });
  let s = applyAction(parseState(null), c.id, "read", "2026-11-08T23:00:00Z");
  const rows = rowsFor([a, b, c, d], s, "list");
  assert.deepEqual(rows.map((r) => (r.type === "head" ? `#${r.label}${r.count}` : r.item.id[0])), ["b", "a", "#Read1", "c"]);
  assert.deepEqual(rowsFor([a, b, c, d], s, "done").map((r) => r.item.id[0]), ["d"]);
  assert.deepEqual(counts([a, b, c, d], s), { unread: 2, open: 3, done: 1 });
  s = applyAction(applyAction(s, a.id, "read", "2026-11-08T23:00:00Z"), b.id, "read", "2026-11-08T23:00:00Z");
  assert.equal(rowsFor([a, b, c], s, "list").some((r) => r.type === "head"), false);
  assert.deepEqual(rowsFor([], s, "list"), []);
});

test("ago", () => {
  const now = Date.parse("2026-11-08T18:00:00Z");
  assert.equal(ago("2026-11-08T17:59:30Z", now), "now");
  assert.equal(ago("2026-11-08T17:55:00Z", now), "5m");
  assert.equal(ago("2026-11-08T15:00:00Z", now), "3h");
  assert.equal(ago("2026-11-06T18:00:00Z", now), "2d");
  assert.equal(ago("2026-10-01T18:00:00Z", now), "5w");
  assert.equal(ago("2026-11-08T18:30:00Z", now), "now");
});

test("who: live agent, ended terminal, or the recorded source", () => {
  const live = [{ address: "t7", status: "working", program: { name: "Claude Code" } }];
  assert.deepEqual(who(norm(), live), { label: "Claude Code t7", status: "working", live: true });
  assert.equal(who(norm(), []).label, "Claude Code t7 (ended)");
  assert.equal(who(norm({ by: { terminal: null, from: "someone@cron" } }), live).label, "someone@cron");
});

test("addToSidebar puts the block under agents, once", () => {
  const layout = {
    id: "root", type: "row",
    children: [{ id: "sidebar", type: "column", children: [{ id: "lists", type: "column", children: [{ id: "spaces" }, { id: "agents" }] }, { id: "footer" }] }],
  };
  const out = addToSidebar(layout);
  assert.deepEqual(out.children[0].children[0].children.map((c) => c.id), ["spaces", "agents", "readlist"]);
  assert.deepEqual(out.children[0].children[0].children[2], BLOCK);
  assert.deepEqual(layout.children[0].children[0].children.map((c) => c.id), ["spaces", "agents"]);
  assert.equal(addToSidebar(out), out);
  assert.throws(() => addToSidebar({ id: "root", children: [] }), /agents/);
});
