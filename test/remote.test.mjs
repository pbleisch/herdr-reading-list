import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeItem, itemKey } from "../mods/readlist/core/items.js";
import { parseState, applyAction, isRead, isChanged, prune, who } from "../mods/readlist/core/state.js";
import { keyOf } from "../mods/readlist/core/filters.js";
import { arrivalKey } from "../mods/readlist/core/arrival.js";
import { STAT1_SCRIPT, parseStat } from "../mods/readlist/core/preview.js";
import { MARK, INSTALL_RL_TEXT_SCRIPT, installToast } from "../mods/readlist/core/install.js";
import {
  RS, POLL_SCRIPT, BASE64_SCRIPT, DECODE_SCRIPT, CHUNKS_SCRIPT, PRUNE_COPIES_SCRIPT, BASE64_MAX, ASK_BYTES, CHUNK_MIB,
  NEW_MACHINE, statLine, parsePoll, afterPoll, syncMachines, pollPaths, unstated, mergeItems, onMachine, listedMachines,
  isOffline, safeName, copyPaths, parseMeta, isStale, fetchRoute, needsAsk, fetchedLabel, sizeLabel, remoteBanner,
} from "../mods/readlist/core/remote.js";

import { repo, posix } from "./support.mjs";
const rl = join(repo, "mods/readlist/bin/rl");

let n = 1;
const raw = (over = {}) => ({
  v: 1,
  id: (n++).toString(16).padStart(16, "0"),
  path: "/home/you/docs/plan.md",
  url: null,
  title: "plan.md",
  note: "why",
  kind: "review",
  added_at: "2026-11-08T18:00:00Z",
  adds: 1,
  by: { terminal: "t3", app: "claude-code", name: "fix", space: "sp1", tab: "tb1", cwd: "/home/you", from: null },
  size: 10,
  mtime: "2026-11-08T17:59:00Z",
  ...over,
});
const item = (over) => normalizeItem(raw(over));

const sh = (script, args = [], env = {}) => execFileSync("sh", ["-c", script, "t", ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...env } });
const scratch = (name) => realpathSync(mkdtempSync(join(tmpdir(), `rl-remote-${name}-`)));

// ---- the poll: one exec, split on the record separator ----

const pollOutput = (records, { head = "dir\t/home/you/.local/state/reading-list\nrl\tmissing\t\n", end = true } = {}) =>
  head.replace(/\n$/, "") + records.map((r) => RS + r).join("") + (end ? RS + "end\n" : "");

test("parsePoll splits the header, stat lines and item records", () => {
  const a = raw(), b = raw({ path: "/home/you/shot.png", title: "shot.png" });
  const out = pollOutput([JSON.stringify(a, null, 2), "{broken", JSON.stringify(b)], {
    head: "dir\t/home/you/rl\nrl\tok\t~/.local/bin/rl\nf 1794200000 1200\n-\n",
  });
  const p = parsePoll(out, ["/home/you/docs/plan.md", "/gone"]);
  assert.equal(p.ok, true);
  assert.equal(p.dir, "/home/you/rl");
  assert.deepEqual(p.rl, { state: "ok", path: "~/.local/bin/rl" });
  assert.deepEqual(p.stats, {
    "/home/you/docs/plan.md": { kind: "f", mtime: 1794200000, size: 1200 },
    "/gone": { kind: "-", mtime: null, size: null },
  });
  assert.deepEqual(p.items.map((i) => i.title).sort(), ["plan.md", "shot.png"]);
});

test("parsePoll refuses output cut short or not from the poll", () => {
  const rec = JSON.stringify(raw());
  assert.equal(parsePoll(pollOutput([rec], { end: false })).ok, false, "no end record: cut short");
  assert.equal(parsePoll("").ok, false);
  assert.equal(parsePoll("some error\n").ok, false);
  assert.equal(parsePoll("garbage" + RS + "end\n").ok, false, "no header");
  const empty = parsePoll(pollOutput([]));
  assert.equal(empty.ok, true, "an empty list is a whole listing");
  assert.deepEqual(empty.items, []);
});

test("statLine reads kind, mtime and size", () => {
  assert.deepEqual(statLine("x 5 7"), { kind: "x", mtime: 5, size: 7 });
  assert.deepEqual(statLine("d 0 0"), { kind: "d", mtime: null, size: 0 });
  assert.deepEqual(statLine(undefined), { kind: "-", mtime: null, size: null });
});

test("POLL_SCRIPT lists a folder in one run, stats paths, and writes nothing", posix, () => {
  const home = scratch("poll");
  // No list folder yet: an empty, whole listing, and nothing made.
  let p = parsePoll(sh(POLL_SCRIPT, [], { HOME: home }));
  assert.equal(p.ok, true);
  assert.deepEqual(p.items, []);
  assert.equal(existsSync(join(home, ".local/state/reading-list")), false);
  assert.equal(p.rl.state, "missing");

  const dir = join(home, "list");
  mkdirSync(join(dir, "items"), { recursive: true });
  const doc = join(home, "my notes.md");
  writeFileSync(doc, "# hi\n");
  const a = raw({ path: doc }), b = raw({ path: join(home, "gone.png") });
  writeFileSync(join(dir, "items", `${a.id}.json`), JSON.stringify(a, null, 2) + "\n");
  writeFileSync(join(dir, "items", `${b.id}.json`), JSON.stringify(b));
  writeFileSync(join(dir, "items", `.${a.id}.123.tmp`), "{half");
  const paths = [doc, join(home, "gone.png"), home];
  p = parsePoll(sh(POLL_SCRIPT, paths, { HOME: home, READING_LIST_DIR: dir }), paths);
  assert.equal(p.ok, true);
  assert.equal(p.dir, dir);
  assert.deepEqual(p.items.map((i) => i.id).sort(), [a.id, b.id].sort());
  assert.equal(p.stats[doc].kind, "f");
  assert.equal(p.stats[doc].size, 5);
  assert.equal(p.stats[doc].mtime, Math.floor(statSync(doc).mtimeMs / 1000));
  assert.equal(p.stats[join(home, "gone.png")].kind, "-");
  assert.equal(p.stats[home].kind, "d");
});

test("STAT1_SCRIPT gives kind, mtime and size", posix, () => {
  const home = scratch("stat");
  const f = join(home, "a b.txt");
  writeFileSync(f, "hello");
  assert.deepEqual(parseStat(sh(STAT1_SCRIPT, [f])), { kind: "f", mtime: Math.floor(statSync(f).mtimeMs / 1000), size: 5 });
  assert.deepEqual(parseStat(sh(STAT1_SCRIPT, [join(home, "nope")])), { kind: "-" });
});

// ---- each machine's state: online, offline, back ----

test("afterPoll keeps a machine's items while it does not answer, and recovers", () => {
  const listing = { ok: true, dir: "/home/you/rl", rl: { state: "ok", path: "" }, stats: { "/home/you/docs/plan.md": { kind: "f", mtime: 9, size: 1 } }, items: [item()] };
  let m = afterPoll(undefined, listing, 1000);
  assert.equal(m.status, "online");
  assert.equal(m.items.length, 1);
  assert.equal(m.ok_at, 1000);

  const off = afterPoll(m, null, 16000, "machine unreachable");
  assert.equal(off.status, "offline");
  assert.equal(off.error, "machine unreachable");
  assert.deepEqual(off.items, m.items, "offline, not deleted");
  assert.equal(off.ok_at, 1000);
  assert.equal(afterPoll(off, { ok: false }, 31000).status, "offline", "a listing cut short does not count");
  assert.deepEqual(afterPoll(off, { ok: false }, 31000).items, m.items);

  const back = afterPoll(off, { ...listing, items: [] }, 46000);
  assert.equal(back.status, "online");
  assert.deepEqual(back.items, [], "back online, its listing is the truth again");

  const first = afterPoll(undefined, null, 1000, "no route");
  assert.equal(first.status, "offline");
  assert.deepEqual(first.items, []);
  assert.equal(first.ok_at, null);
});

test("syncMachines polls ready machines, marks unavailable ones offline, drops removed ones", () => {
  const online = afterPoll(NEW_MACHINE, { ok: true, dir: "/d", rl: null, stats: {}, items: [item()] }, 1);
  const before = new Map([["devbox", online], ["gone", online]]);
  const { remote, poll } = syncMachines(before, [
    { name: null, layout: "ready" },
    { name: "devbox", layout: "unavailable" },
    { name: "spare", layout: "ready" },
    { name: "slow", layout: "loading" },
  ]);
  assert.deepEqual([...remote.keys()], ["devbox", "spare", "slow"]);
  assert.deepEqual(poll, ["spare"]);
  assert.equal(remote.get("devbox").status, "offline");
  assert.equal(remote.get("devbox").items.length, 1);
  assert.equal(remote.get("spare").status, "waiting");
  // Unchanged machines keep their object, so the mod can tell nothing changed.
  const again = syncMachines(remote, [{ name: "devbox", layout: "unavailable" }, { name: "spare", layout: "ready" }]);
  assert.equal(again.remote.get("devbox"), remote.get("devbox"));
  assert.equal(syncMachines(remote, [{ name: "devbox", layout: "ready" }]).remote.get("devbox").status, "offline", "offline until a poll answers");
});

test("a machine without sh is unsupported, not offline, and is left alone until it reconnects", () => {
  const win = afterPoll(undefined, null, 1, "cannot start sh: program not found");
  assert.equal(win.status, "unsupported");
  let { remote, poll } = syncMachines(new Map([["winbox", win]]), [{ name: "winbox", layout: "ready" }]);
  assert.deepEqual(poll, []);
  ({ remote } = syncMachines(remote, [{ name: "winbox", layout: "unavailable" }]));
  ({ poll } = syncMachines(remote, [{ name: "winbox", layout: "ready" }]));
  assert.deepEqual(poll, ["winbox"], "tried again after it reconnects");
  assert.equal(isOffline(new Map([["winbox", win]]), { machine: "winbox" }), false);
});

test("pollPaths and unstated: the next poll stats the last listing's files", () => {
  const a = item({ path: "/a" }), b = item({ path: "/b" }), u = item({ path: null, url: "https://x.dev" });
  const e = afterPoll(NEW_MACHINE, { ok: true, dir: "/d", rl: null, stats: { "/a": { kind: "f", mtime: 1, size: 1 } }, items: [a, b, u] }, 1);
  assert.deepEqual(pollPaths(e), ["/a", "/b"]);
  assert.deepEqual(unstated(e), ["/b"]);
  assert.deepEqual(pollPaths(undefined), []);
});

test("mergeItems keys remote items by machine, so equal ids on two machines stay apart", () => {
  const here = item({ path: "/same" });
  const there = { ...here };
  const remote = new Map([["devbox", afterPoll(NEW_MACHINE, { ok: true, dir: "/d", rl: null, stats: { "/same": { kind: "x", mtime: 7, size: 3 } }, items: [there] }, 1)]]);
  const m = mergeItems([here], { fs: { "/same": "f" }, mt: { "/same": 5 } }, remote);
  assert.deepEqual(m.items.map(itemKey), [here.id, `devbox/${here.id}`]);
  assert.equal(m.items[1].machine, "devbox");
  assert.deepEqual(m.fs, { [here.id]: "f", [`devbox/${here.id}`]: "x" });
  assert.deepEqual(m.mt, { [here.id]: 5, [`devbox/${here.id}`]: 7 });
  assert.equal(isOffline(remote, m.items[1]), false);
  assert.equal(isOffline(new Map([["devbox", { ...remote.get("devbox"), status: "offline" }]]), m.items[1]), true);
  assert.equal(isOffline(remote, m.items[0]), false, "this machine's items are never offline");
});

test("state, arrivals, filters and who use the machine-qualified key", () => {
  const [i] = onMachine([item({ path: "/p" })], "devbox");
  const k = `devbox/${i.id}`;
  assert.equal(itemKey(i), k);
  assert.equal(arrivalKey(i), `${k}@${i.added_at}`);
  let st = applyAction(parseState(null), k, "read", "2026-11-08T19:00:00Z", 42);
  assert.equal(isRead(i, st), true);
  assert.equal(isRead({ ...i, machine: null }, st), false, "the same id here is another item");
  assert.equal(isChanged(i, st, 43), true);
  assert.equal(keyOf(i, "space"), "devbox/sp1");
  assert.equal(keyOf(i, "agent"), "t:devbox/t3");
  assert.equal(who(i, [{ address: "devbox/t3", program: { name: "claude" }, status: "idle" }]).label, "claude devbox/t3");
  assert.equal(who(i, []).label, "Claude Code devbox/t3 (ended)");
});

test("prune keeps an unlisted machine's entries until that machine is listed", () => {
  const old = "2026-01-01T00:00:00Z";
  const st = { v: 1, items: { aaaaaaaaaaaaaaaa: { read_at: old }, "devbox/bbbbbbbbbbbbbbbb": { read_at: old } } };
  const now = Date.parse("2026-11-09T00:00:00Z");
  assert.deepEqual(Object.keys(prune(st, [], now).items), ["devbox/bbbbbbbbbbbbbbbb"], "devbox not listed: kept");
  assert.deepEqual(Object.keys(prune(st, [], now, undefined, listedMachines(new Map([["devbox", { ok_at: 1 }]]))).items), []);
  assert.deepEqual(Object.keys(prune(st, [], now, undefined, listedMachines(new Map([["devbox", { ok_at: null }]]))).items), ["devbox/bbbbbbbbbbbbbbbb"]);
});

// ---- local copies: paths, staleness, labels ----

test("copyPaths keeps the file name under the machine and item, and safeName cleans names", () => {
  const id = "0123456789abcdef";
  assert.deepEqual(copyPaths("devbox", id, "/home/you/My Report.pdf"), {
    dir: `remote/devbox/${id}`,
    copy: `remote/devbox/${id}/copy/My Report.pdf`,
    meta: `remote/devbox/${id}/meta`,
    thumbs: `remote/devbox/${id}/thumbs`,
  });
  assert.equal(copyPaths("devbox", id, "/home/you/folder/").copy, `remote/devbox/${id}/copy/folder`);
  assert.equal(copyPaths("devbox", id, "/").copy, `remote/devbox/${id}/copy/file`);
  assert.equal(safeName("a/../b c"), "a_.._b_c");
  assert.equal(safeName(".."), "_..");
  assert.equal(safeName(""), "_");
  assert.throws(() => copyPaths("devbox", "../../x", "/p"));
});

test("isStale: no copy, or the remote mtime or size changed", () => {
  const meta = parseMeta('{"mtime":100,"size":5,"at":1794200000000}');
  assert.deepEqual(meta, { mtime: 100, size: 5, at: 1794200000000 });
  assert.equal(isStale(meta, { mtime: 100, size: 5 }), false);
  assert.equal(isStale(meta, { mtime: 101, size: 5 }), true);
  assert.equal(isStale(meta, { mtime: 100, size: 6 }), true);
  assert.equal(isStale(null, { mtime: 100, size: 5 }), true);
  assert.equal(parseMeta("{half"), null);
  assert.equal(parseMeta('{"mtime":null,"size":5,"at":1}'), null);
});

test("fetchRoute, needsAsk, fetchedLabel and sizeLabel", () => {
  assert.equal(fetchRoute(BASE64_MAX), "base64");
  assert.equal(fetchRoute(BASE64_MAX + 1), "chunks");
  assert.equal(needsAsk(ASK_BYTES), false);
  assert.equal(needsAsk(ASK_BYTES + 1), true);
  const at = new Date(2026, 10, 9, 8, 5).getTime();
  assert.equal(fetchedLabel("devbox", at, at + 3600000), "copy from devbox, fetched 08:05");
  assert.equal(fetchedLabel("devbox", at, at + 2 * 86400000), "copy from devbox, fetched 2026-11-09 08:05");
  assert.equal(sizeLabel(12), "12 B");
  assert.equal(sizeLabel(2048), "2.0 KiB");
  assert.equal(sizeLabel(60 * 1024 * 1024), "60.0 MiB");
});

// ---- fetching: the scripts run here with a stand-in machine ----

// A binary file with every byte value, a size that is not a multiple of anything.
const binary = (size) => Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + (i >> 8)) % 256));

test("BASE64_SCRIPT then DECODE_SCRIPT make an exact copy and its meta", posix, () => {
  const home = scratch("b64");
  const src = join(home, "pic.png");
  const data = binary(70001);
  writeFileSync(src, data);
  const text = sh(BASE64_SCRIPT, [src]);
  const cache = join(home, "cache");
  const p = copyPaths("devbox", "0123456789abcdef", src);
  mkdirSync(join(cache, p.dir), { recursive: true });
  const tmp = join(cache, p.dir, ".b64.x");
  writeFileSync(tmp, text);
  sh(DECODE_SCRIPT, [tmp, join(cache, p.copy), String(data.length), "1794200000", join(cache, p.meta)]);
  assert.deepEqual(readFileSync(join(cache, p.copy)), data);
  assert.equal(existsSync(tmp), false, "the base64 text is removed");
  const meta = parseMeta(readFileSync(join(cache, p.meta), "utf8"));
  assert.equal(meta.mtime, 1794200000);
  assert.equal(meta.size, data.length);
  assert.ok(Math.abs(meta.at - Date.now()) < 5000);
  assert.deepEqual(readdirSync(join(cache, p.dir, "copy")), ["pic.png"], "no part file left");
});

test("DECODE_SCRIPT refuses a copy of the wrong size", posix, () => {
  const home = scratch("b64bad");
  writeFileSync(join(home, "in"), Buffer.from("abc").toString("base64"));
  assert.throws(() => sh(DECODE_SCRIPT, [join(home, "in"), join(home, "out/x"), "4", "1", join(home, "meta")]), /got 3 of 4 bytes/);
  assert.equal(existsSync(join(home, "out/x")), false);
  assert.equal(existsSync(join(home, "meta")), false);
});

// A stand-in `hc`: `hc exec --on M --timeout T -- argv...` runs argv here, and fails when
// FAIL_HC is set; scp copies the local path after `host:`.
function fakeTools(home) {
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "hc"), '#!/bin/sh\n[ -n "${FAIL_HC:-}" ] && exit 1\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n');
  writeFileSync(join(bin, "scp"), '#!/bin/sh\nfor a; do :; done; dst=$a\nfor a; do case $a in *:/*) src=${a#*:};; esac; done\ncp "$src" "$dst"\n');
  chmodSync(join(bin, "hc"), 0o755);
  chmodSync(join(bin, "scp"), 0o755);
  return `${bin}:/usr/bin:/bin`;
}

test("CHUNKS_SCRIPT fetches a file in chunks through hc exec", posix, () => {
  const home = scratch("chunks");
  const PATH = fakeTools(home);
  const size = CHUNK_MIB * 1048576 * 2 + 12345;
  const data = binary(size);
  const src = join(home, "big file.bin");
  writeFileSync(src, data);
  const out = join(home, "cache/copy/big file.bin");
  sh(CHUNKS_SCRIPT, ["devbox", src, out, String(size), "77", join(home, "cache/meta"), ""], { PATH });
  assert.ok(readFileSync(out).equals(data));
  assert.equal(parseMeta(readFileSync(join(home, "cache/meta"), "utf8")).size, size);
});

test("CHUNKS_SCRIPT falls back to scp, and fails cleanly without it", posix, () => {
  const home = scratch("scp");
  const PATH = fakeTools(home);
  const data = binary(1000);
  const src = join(home, "f.bin");
  writeFileSync(src, data);
  const out = join(home, "cache/copy/f.bin");
  sh(CHUNKS_SCRIPT, ["devbox", src, out, "1000", "1", join(home, "cache/meta"), "you@devbox"], { PATH, FAIL_HC: "1" });
  assert.ok(readFileSync(out).equals(data));
  const out2 = join(home, "cache2/copy/f.bin");
  assert.throws(() => sh(CHUNKS_SCRIPT, ["devbox", src, out2, "1000", "1", join(home, "cache2/meta"), ""], { PATH, FAIL_HC: "1" }), /could not fetch it from devbox/);
  assert.deepEqual(readdirSync(join(home, "cache2/copy")), [], "no part file left");
});

test("PRUNE_COPIES_SCRIPT removes the copies of items no longer listed", posix, () => {
  const home = scratch("prune");
  for (const id of ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]) mkdirSync(join(home, id, "copy"), { recursive: true });
  sh(PRUNE_COPIES_SCRIPT, [home, "aaaaaaaaaaaaaaaa"]);
  assert.deepEqual(readdirSync(home), ["aaaaaaaaaaaaaaaa"]);
  sh(PRUNE_COPIES_SCRIPT, [join(home, "missing")]);
});

// ---- rl on another machine ----

test("INSTALL_RL_TEXT_SCRIPT installs rl from its text, and leaves no temporary file", posix, () => {
  const home = scratch("install");
  const tmp = join(home, "tmp");
  mkdirSync(tmp);
  const run = () => sh(INSTALL_RL_TEXT_SCRIPT, [readFileSync(rl, "utf8")], { HOME: home, TMPDIR: tmp, PATH: `${join(home, ".local/bin")}:/usr/bin:/bin` });
  assert.equal(run(), "installed\t~/.local/bin/rl\t1\t~/.local/bin/rl\n");
  assert.deepEqual(readFileSync(join(home, ".local/bin/rl")), readFileSync(rl));
  assert.equal(statSync(join(home, ".local/bin/rl")).mode & 0o777, 0o755);
  assert.equal(run().split("\t")[0], "same");
  assert.deepEqual(readdirSync(tmp), []);
});

test("installToast names the other machine", () => {
  assert.deepEqual(installToast("installed\t~/.local/bin/rl\t1\t~/.local/bin/rl\n", "devbox"), { body: "Installed rl at devbox:~/.local/bin/rl.", level: "success" });
  assert.match(installToast("installed\t~/.local/bin/rl\t0\t\n", "devbox").body, /not on PATH on devbox/);
  assert.equal(installToast("error\tcould not write ~/.local/bin/rl\n", "devbox").body, "Couldn't install rl on devbox: could not write ~/.local/bin/rl");
});

test("remoteBanner shows the first answering machine without rl, unless dismissed", () => {
  const on = (rlState) => ({ ...NEW_MACHINE, status: "online", ok_at: 1, rl: { state: rlState, path: "~/bin/rl" } });
  const remote = new Map([["ok", on("ok")], ["down", { ...on("missing"), status: "offline" }], ["devbox", on("missing")], ["spare", on("other")]]);
  assert.deepEqual(remoteBanner(remote), { machine: "devbox", text: "rl is not installed on devbox, so agents there cannot add to this list.", button: "install" });
  assert.equal(remoteBanner(remote, { devbox: "missing" }).machine, "spare");
  assert.equal(remoteBanner(remote, { devbox: "missing", spare: "other" }), null);
  assert.equal(remoteBanner(new Map([["m", on("offpath")]])).button, null);
});

test("the mod's rl carries the mark the remote install checks", () => {
  assert.ok(readFileSync(rl, "utf8").includes(MARK));
});
