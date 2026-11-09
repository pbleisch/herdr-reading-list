import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, utimesSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeItem, STATS_SCRIPT, parseStats } from "../mods/readlist/core/items.js";
import { parseState, serializeState, applyAction, isChanged, prune, withInbox, rowsFor } from "../mods/readlist/core/state.js";
import { NO_FILTER, applyFilters, filterRows, isFiltered, textMatches, options, labelFor, keyOf } from "../mods/readlist/core/filters.js";
import { arrivalKey, arrivals, claim, owners, quiet, quietIds, toastFor, toastAction, CLAIM_MS, CLAIM_MAX, QUIET_MS } from "../mods/readlist/core/arrival.js";
import { INBOX_SCRIPT, ADD_SCRIPT, parseInbox, inboxPlan, SETTLE_S } from "../mods/readlist/core/inbox.js";
import { viewerPane, newPane, selectedId, takesCommand, splitTarget } from "../mods/readlist/core/viewer.js";
import { mergeKeys, forPlatform } from "../bin/merge-keys.mjs";

const repo = new URL("..", import.meta.url).pathname;
let n = 0;
const item = (over = {}) => normalizeItem({
  v: 1,
  id: (n++).toString(16).padStart(16, "0"),
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
const sh = (script, ...args) => execFileSync("sh", ["-c", script, "t", ...args], { encoding: "utf8" });

// ---- arrival ----

test("arrivals: nothing on a copy's first listing, then new ids and re-adds, never fyi", () => {
  const a = item(), b = item({ kind: "fyi" });
  assert.deepEqual(arrivals(null, [a, b]), []);
  const seen = new Set([a, b].map(arrivalKey));
  const c = item();
  const again = { ...a, added_at: "2026-11-08T19:00:00Z" };
  const fyiAgain = { ...b, added_at: "2026-11-08T19:00:00Z" };
  assert.deepEqual(arrivals(seen, [again, fyiAgain, c]).map((i) => i.id), [a.id, c.id]);
  assert.deepEqual(arrivals(seen, [a, b]), []);
});

test("claim takes only free keys; owners tells mine, theirs and missing", () => {
  let map = claim(undefined, ["k1", "k2"], "A", 1000);
  map = claim(map, ["k2", "k3"], "B", 1001);
  assert.equal(map.k1.by, "A");
  assert.equal(map.k2.by, "A");
  assert.equal(map.k3.by, "B");
  assert.deepEqual(owners(map, ["k1", "k3", "k4"], "A"), { mine: ["k1"], theirs: ["k3"], missing: ["k4"] });
  assert.deepEqual(owners("junk", ["k1"], "A"), { mine: [], theirs: [], missing: ["k1"] });
});

test("claim race: a stale write drops a claim, which is claimed again by whoever looks", () => {
  // A and B both read the empty map; A claims k1, then B writes its own map over it.
  const fromA = claim({}, ["k1"], "A", 1);
  const fromB = claim({}, ["k1", "k2"], "B", 2);
  let shared = fromA;
  shared = fromB;
  assert.deepEqual(owners(shared, ["k1"], "A"), { mine: [], theirs: ["k1"], missing: [] });
  assert.deepEqual(owners(shared, ["k1", "k2"], "B").mine, ["k1", "k2"]);
  // B claims k3 from a map that does not have it; A's later stale write loses it again.
  const before = shared;
  shared = claim(before, ["k3"], "B", 3);
  shared = claim(before, ["k9"], "A", 4);
  assert.deepEqual(owners(shared, ["k3"], "B").missing, ["k3"]);
  shared = claim(shared, ["k3"], "B", 5);
  assert.deepEqual(owners(shared, ["k3"], "B").mine, ["k3"]);
});

test("claim drops old and excess claims and junk", () => {
  const map = { old: { by: "A", at: 0 }, bad: "x", fresh: { by: "A", at: CLAIM_MS } };
  assert.deepEqual(Object.keys(claim(map, [], "A", CLAIM_MS + 10)), ["fresh"]);
  const many = Object.fromEntries(Array.from({ length: CLAIM_MAX + 50 }, (_, i) => [`k${i}`, { by: "A", at: 1000 + i }]));
  const kept = claim(many, ["new"], "B", 5000);
  assert.equal(Object.keys(kept).length, CLAIM_MAX + 1);
  assert.ok(kept[`k${CLAIM_MAX + 49}`] && !kept.k0 && kept.new);
});

test("quiet keeps dropped ids for a minute", () => {
  let q = quiet(undefined, ["a"], 1000);
  q = quiet(q, ["b"], 1000 + QUIET_MS - 1);
  assert.deepEqual([...quietIds(q, 1000 + QUIET_MS - 1)].sort(), ["a", "b"]);
  assert.deepEqual([...quietIds(q, 1000 + QUIET_MS)], ["b"]);
  assert.deepEqual(Object.keys(quiet(q, [], 1000 + QUIET_MS)), ["b"]);
});

test("toastFor names one arrival and collapses a burst", () => {
  const a = item({ title: "plan.md", note: "Revised rollout" });
  assert.deepEqual(toastFor([a], []), { title: "Reading list: plan.md", body: "Claude Code t7 (ended): Revised rollout" });
  const live = [{ address: "t7", program: { name: "claude" }, status: "idle" }];
  assert.equal(toastFor([a], live).body, "claude t7: Revised rollout");
  assert.equal(toastFor([item({ note: null, by: { from: "inbox" } })], []).body, "Added by inbox");
  const five = ["a", "b", "c", "d", "e"].map((t) => item({ title: t }));
  assert.deepEqual(toastFor(five, []), { title: "5 new on your reading list", body: "a, b, c and 2 more" });
  assert.deepEqual(toastFor(five.slice(0, 2), []), { title: "2 new on your reading list", body: "a, b" });
});

test("toastAction focuses a list pane, never the viewer, else opens the popup", () => {
  const panes = [{ pane: "p1", mod: "files" }, { pane: "p2", mod: "readlist" }, { pane: "p3", mod: "readlist" }];
  assert.deepEqual(toastAction(panes), { name: "pane.focus", args: { pane: "p2" } });
  assert.deepEqual(toastAction(panes, "p2"), { name: "pane.focus", args: { pane: "p3" } });
  assert.deepEqual(toastAction(panes.slice(0, 2), "p2"), { name: "mod.open", args: { name: "readlist" } });
});

// ---- filters ----

const sample = () => [
  item({ title: "plan.md", note: "Rollout", path: "/p/docs/plan.md", by: { terminal: "t7", space: "sp1" } }),
  item({ title: "shot.png", note: null, path: "/p/shot.png", by: { terminal: "t9", space: "sp2" } }),
  item({ title: "report", path: null, url: "https://x.dev/r", by: { from: "cron" } }),
  item({ title: "inbox.pdf", path: "/i/inbox.pdf", by: { from: "inbox" }, added_at: "2026-11-08T19:00:00Z" }),
];

test("applyFilters by space, agent, type and text", () => {
  const items = sample();
  const ids = (f) => applyFilters(items, { ...NO_FILTER, ...f }).map((i) => i.title);
  assert.deepEqual(ids({}), ["plan.md", "shot.png", "report", "inbox.pdf"]);
  assert.deepEqual(ids({ space: "sp2" }), ["shot.png"]);
  assert.deepEqual(ids({ space: "" }), ["report", "inbox.pdf"]);
  assert.deepEqual(ids({ agent: "t:t7" }), ["plan.md"]);
  assert.deepEqual(ids({ agent: "f:inbox" }), ["inbox.pdf"]);
  assert.deepEqual(ids({ type: "image" }), ["shot.png"]);
  assert.deepEqual(ids({ type: "url" }), ["report"]);
  assert.deepEqual(ids({ text: "ROLL" }), ["plan.md"]);
  assert.deepEqual(ids({ text: "docs plan" }), ["plan.md"]);
  assert.deepEqual(ids({ text: "x.dev" }), ["report"]);
  assert.deepEqual(ids({ text: "plan shot" }), []);
  assert.deepEqual(ids({ space: "sp1", text: "shot" }), []);
  // A folder's type comes from the file kind, looked up by item key.
  assert.deepEqual(applyFilters(items, { ...NO_FILTER, type: "folder" }, { [items[1].id]: "d" }).map((i) => i.title), ["shot.png"]);
});

test("textMatches ignores case and blank text", () => {
  const i = item({ title: "Plan", note: "Section 3" });
  assert.ok(textMatches(i, "  "));
  assert.ok(textMatches(i, "section PLAN"));
  assert.ok(textMatches(i, "/tmp/plan"));
  assert.ok(!textMatches(i, "section 4"));
});

test("filterRows drops read rows and the Read header when unread only", () => {
  const items = sample();
  const state = applyAction(parseState(null), items[0].id, "read", "2026-11-09T00:00:00Z");
  const rows = rowsFor(items, state, "list");
  assert.ok(rows.some((r) => r.type === "head"));
  const unread = filterRows(rows, true);
  assert.ok(unread.every((r) => r.type === "item" && !r.read));
  assert.equal(unread.length, 3);
  assert.equal(filterRows(rows, false), rows);
});

test("isFiltered", () => {
  assert.equal(isFiltered(NO_FILTER), false);
  assert.equal(isFiltered({ ...NO_FILTER, text: "  " }), false);
  assert.equal(isFiltered({ ...NO_FILTER, space: "" }), true);
  assert.equal(isFiltered({ ...NO_FILTER, unread: true }), true);
});

test("options count, name and order the choices", () => {
  const items = sample();
  const spaces = [{ id: "sp1", name: "web" }];
  assert.deepEqual(options(items, "space", { spaces }), [
    { value: "", label: "No space", count: 2 },
    { value: "sp2", label: "Closed space", count: 1 },
    { value: "sp1", label: "web", count: 1 },
  ]);
  const agents = options(items, "agent", { agents: [{ address: "t7", program: { name: "claude" } }] });
  assert.deepEqual(agents.map((o) => o.label), ["claude t7", "cron", "inbox", "terminal t9 (ended)"]);
  assert.deepEqual(options(items, "type").map((o) => o.value), ["image", "url", "md", "pdf"]);
  // A chosen value no item has any more stays, with 0.
  assert.deepEqual(options(items, "type", { chosen: "html" }).at(-1), { value: "html", label: "HTML", count: 0 });
  assert.equal(labelFor("agent", "t:t3"), "t3");
  assert.equal(labelFor("agent", "f:"), "Unknown");
  assert.equal(keyOf(items[2], "agent"), "f:cron");
});

// ---- changed since read ----

test("read records the file's mtime; changed when the file moves on", () => {
  const i = item();
  let s = applyAction(parseState(null), i.id, "read", "2026-11-09T00:00:00Z", 1700000000);
  assert.equal(s.items[i.id].seen_mtime, 1700000000);
  assert.equal(isChanged(i, s, 1700000000), false);
  assert.equal(isChanged(i, s, 1700000500), true);
  assert.equal(isChanged(i, s, null), false);
  // Survives a save and a reload.
  s = parseState(serializeState(s));
  assert.equal(isChanged(i, s, 1700000500), true);
  // Reading again (Enter, r) takes the new mtime; unread forgets it.
  s = applyAction(s, i.id, "read", "2026-11-09T01:00:00Z", 1700000500);
  assert.equal(isChanged(i, s, 1700000500), false);
  s = applyAction(s, i.id, "unread", "2026-11-09T02:00:00Z");
  assert.equal(s.items[i.id].seen_mtime, undefined);
  // A re-add makes it unread: no chip then, it is new again.
  const read = applyAction(parseState(null), i.id, "read", "2026-11-09T00:00:00Z", 1700000000);
  assert.equal(isChanged({ ...i, added_at: "2026-11-10T00:00:00Z" }, read, 1700000500), false);
  // Read before this increment (no seen_mtime): no chip.
  assert.equal(isChanged(i, applyAction(parseState(null), i.id, "read", "2026-11-09T00:00:00Z"), 1700000500), false);
});

test("STATS_SCRIPT and parseStats give kind and mtime per path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-stats-"));
  writeFileSync(join(dir, "a b.md"), "x");
  utimesSync(join(dir, "a b.md"), 1700000000, 1700000000);
  writeFileSync(join(dir, "run.sh"), "x");
  chmodSync(join(dir, "run.sh"), 0o755);
  const paths = [join(dir, "a b.md"), dir, join(dir, "nope"), join(dir, "run.sh")];
  const st = parseStats(sh(STATS_SCRIPT, ...paths), paths);
  assert.deepEqual(paths.map((p) => st.fs[p]), ["f", "d", "-", "x"]);
  assert.equal(st.mt[paths[0]], 1700000000);
  assert.equal(st.mt[paths[2]], null);
  assert.deepEqual(parseStats("", ["/a"]), { fs: { "/a": "-" }, mt: { "/a": null } });
});

// ---- the inbox ----

test("state keeps the inbox record through actions and prune", () => {
  let s = withInbox(parseState(null), { "a.png": 5 });
  s = applyAction(s, "0123456789abcdef", "read", "2026-11-09T00:00:00Z");
  s = prune(s, [], Date.parse("2027-01-01T00:00:00Z"));
  assert.deepEqual(s.inbox, { "a.png": 5 });
  assert.deepEqual(parseState(serializeState(s)).inbox, { "a.png": 5 });
  assert.equal(parseState('{"v":1,"items":{},"inbox":{"x":"bad"}}').inbox, undefined);
  assert.equal("inbox" in withInbox(s, {}), false);
});

test("inboxPlan adds new and replaced entries once, waits for fresh ones, forgets gone ones", () => {
  const now = 1000;
  const entries = [{ name: "new.png", mtime: 900 }, { name: "same.pdf", mtime: 800 }, { name: "replaced.md", mtime: 950 }, { name: "writing.mov", mtime: now }];
  const handled = { "same.pdf": 800, "replaced.md": 700, "gone.txt": 600, "writing.mov": 10 };
  const plan = inboxPlan(entries, handled, now);
  assert.deepEqual(plan.todo.map((e) => e.name), ["new.png", "replaced.md"]);
  assert.equal(plan.wait, true);
  assert.deepEqual(plan.inbox, { "new.png": 900, "same.pdf": 800, "replaced.md": 950, "writing.mov": 10 });
  assert.equal(plan.changed, true);
  // Once written, the same listing has nothing to do.
  const again = inboxPlan(entries.slice(0, 3), plan.inbox, now + SETTLE_S + 5);
  assert.deepEqual(again.todo, []);
  assert.equal(again.changed, true); // writing.mov's old record goes with the file
  assert.equal(inboxPlan(entries.slice(0, 3), again.inbox, now + 9).changed, false);
});

test("INBOX_SCRIPT lists entries with mtimes; parseInbox skips hidden and partial ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-inbox-"));
  writeFileSync(join(dir, "shot one.png"), "x");
  utimesSync(join(dir, "shot one.png"), 1700000000, 1700000000);
  writeFileSync(join(dir, ".DS_Store"), "x");
  writeFileSync(join(dir, "movie.mov.crdownload"), "x");
  mkdirSync(join(dir, "folder"));
  symlinkSync(join(dir, "shot one.png"), join(dir, "link.png"));
  symlinkSync(join(dir, "nothing"), join(dir, "dangling"));
  const got = parseInbox(sh(INBOX_SCRIPT, dir)).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(got.map((e) => e.name), ["folder", "link.png", "shot one.png"]);
  assert.equal(got.find((e) => e.name === "shot one.png").mtime, 1700000000);
  assert.deepEqual(parseInbox(sh(INBOX_SCRIPT, join(dir, "missing"))), []);
  assert.deepEqual(parseInbox("12\ta\0garbage\0\tb\0"), [{ name: "a", mtime: 12 }]);
});

test("ADD_SCRIPT adds through rl, prints ids, and reports failures", () => {
  const home = mkdtempSync(join(tmpdir(), "rl-add-"));
  const list = join(home, "list");
  const rl = join(repo, "mods/readlist/bin/rl");
  writeFileSync(join(home, "a.md"), "# A\n");
  // No rl on PATH: the mod runs its own copy.
  const env = { ...process.env, PATH: "/usr/bin:/bin", READING_LIST_DIR: list, HC_TERMINAL_ID: "t99" };
  const out = execFileSync("sh", ["-c", ADD_SCRIPT, "t", rl, "inbox", join(home, "a.md")], { encoding: "utf8", env });
  const id = out.trim();
  assert.match(id, /^[0-9a-f]{16}$/);
  const saved = JSON.parse(readFileSync(join(list, "items", `${id}.json`), "utf8"));
  assert.equal(saved.by.from, "inbox");
  assert.equal(saved.by.terminal, null);
  let failed = null;
  try {
    execFileSync("sh", ["-c", ADD_SCRIPT, "t", rl, "dropped", join(home, "a.md"), join(home, "nope")], { encoding: "utf8", env, stdio: "pipe" });
  } catch (e) {
    failed = e;
  }
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout.trim(), id);
  assert.match(failed.stderr, /no such file/);
});

// ---- the viewer ----

test("viewerPane finds the open viewer; newPane finds the split", () => {
  const before = [{ pane: "p1", mod: undefined }, { pane: "p2", mod: "readlist" }];
  const after = [...before, { pane: "p3", mod: "readlist" }];
  assert.equal(newPane(before, after), "p3");
  assert.equal(newPane(before, before), null);
  assert.equal(viewerPane({ pane: "p3" }, after), "p3");
  assert.equal(viewerPane({ pane: "p3" }, before), null); // closed by hand
  assert.equal(viewerPane({ pane: "p1" }, after), null); // not a reading-list pane
  assert.equal(viewerPane(null, after), null);
  assert.equal(selectedId({ id: "abc", at: 1 }), "abc");
  assert.equal(selectedId("abc"), null);
});

test("splitTarget is the tab's last pane, else the focused one", () => {
  const panes = [{ pane: "a", tab: "t1" }, { pane: "b", tab: "t2" }, { pane: "c", tab: "t1" }];
  assert.equal(splitTarget(panes, "t1", "a"), "c");
  assert.equal(splitTarget(panes, "t9", "a"), "a");
  assert.equal(splitTarget([], undefined, null), null);
});

test("takesCommand: the copy with the keyboard acts, else the sidebar; focus goes to any", () => {
  assert.equal(takesCommand({ copy: "A" }, "A", null, "open"), true);
  assert.equal(takesCommand({ copy: "A" }, "B", "sidebar", "open"), false);
  assert.equal(takesCommand(null, "B", "sidebar", "open"), true);
  assert.equal(takesCommand(null, "C", null, "open"), false);
  assert.equal(takesCommand({ copy: "A" }, "C", null, "focus"), true);
});

// ---- keys ----

test("mergeKeys adds free keys and never replaces a key in use", () => {
  const mine = { global: { "cmd-shift-i": "mod.open:readlist" } };
  const free = mergeKeys({ global: { "cmd-p": "mod.open:picker" }, terminal: {} }, mine);
  assert.deepEqual(free.added, ["global cmd-shift-i"]);
  assert.equal(free.merged.global["cmd-shift-i"], "mod.open:readlist");
  assert.equal(free.merged.global["cmd-p"], "mod.open:picker");
  const taken = mergeKeys({ global: { "cmd-shift-i": "app.help" } }, mine);
  assert.deepEqual(taken.added, []);
  assert.deepEqual(taken.taken, ["global cmd-shift-i -> app.help"]);
  assert.equal(taken.merged.global["cmd-shift-i"], "app.help");
  assert.deepEqual(mergeKeys({ global: { "cmd-shift-i": "mod.open:readlist" } }, mine).added, []);
  assert.deepEqual(mergeKeys({}, mine).merged, mine);
});

test("forPlatform keeps macOS's cmd key and Linux's and Windows's ctrl key of a pair", () => {
  const keys = { global: { "cmd-shift-i": "mod.open:readlist", "ctrl-shift-i": "mod.open:readlist", "alt-r": "x" }, "mod:readlist": { "ctrl-s": "readlist.save", "cmd-k": "readlist.find" } };
  assert.deepEqual(forPlatform(keys, "darwin"), { global: { "cmd-shift-i": "mod.open:readlist", "alt-r": "x" }, "mod:readlist": { "ctrl-s": "readlist.save", "cmd-k": "readlist.find" } });
  for (const p of ["linux", "win32"]) {
    assert.deepEqual(forPlatform(keys, p), { global: { "ctrl-shift-i": "mod.open:readlist", "alt-r": "x" }, "mod:readlist": { "ctrl-s": "readlist.save", "cmd-k": "readlist.find" } }, p);
  }
  // A cmd and a ctrl key bound to different actions are not a pair: both stay.
  const two = { global: { "cmd-j": "a", "ctrl-j": "b" } };
  assert.deepEqual(forPlatform(two, "linux"), two);
  assert.deepEqual(forPlatform(undefined, "linux"), {});
});

test("the repo's keys.json binds cmd-shift-i on macOS and ctrl-shift-i on Linux and Windows to the popup", () => {
  const keys = JSON.parse(readFileSync(join(repo, "keys.json"), "utf8"));
  assert.deepEqual(keys, { global: { "cmd-shift-i": "mod.open:readlist", "ctrl-shift-i": "mod.open:readlist" } });
  assert.deepEqual(forPlatform(keys, "darwin"), { global: { "cmd-shift-i": "mod.open:readlist" } });
  assert.deepEqual(forPlatform(keys, "linux"), { global: { "ctrl-shift-i": "mod.open:readlist" } });
});
