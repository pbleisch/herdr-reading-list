import { test } from "node:test";
import assert from "node:assert/strict";
import { posix } from "./support.mjs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeItem } from "../mods/readlist/core/items.js";
import {
  WIDE, TEXT_BYTES, FOLDER_ENTRIES, STAT1_SCRIPT, HEAD_SCRIPT, LIST_DIR_SCRIPT, CACHE_SCRIPT, PRUNE_SCRIPT,
  previewShown, previewKind, thumbSize, cacheName, parseStat, previewText, stripThreads, parseFolder, copyText,
} from "../mods/readlist/core/preview.js";

const item = (over = {}) => normalizeItem({
  v: 1, id: "0123456789abcdef", path: "/tmp/plan.md", url: null, title: "plan.md", note: null,
  kind: "review", added_at: "2026-11-08T18:00:00Z", adds: 1, by: {}, done_at: null, ...over,
});
const sh = (script, ...args) => execFileSync("sh", ["-c", script, "readlist", ...args], { encoding: "utf8" });

test("previewShown follows the width until the person presses p", () => {
  assert.equal(previewShown(WIDE - 1, null), false);
  assert.equal(previewShown(WIDE, null), true);
  assert.equal(previewShown(268, true), true);
  assert.equal(previewShown(900, false), false);
  assert.equal(previewShown(undefined, null), false);
});

test("previewKind picks how each type previews", () => {
  assert.deepEqual(previewKind(item(), "f"), { how: "markdown" });
  assert.deepEqual(previewKind(item({ path: "/a/x.ts" }), "f"), { how: "text", lang: "js" });
  assert.deepEqual(previewKind(item({ path: "/a/x.log" }), "f"), { how: "text", lang: "log" });
  assert.deepEqual(previewKind(item({ path: "/a/x.PNG" }), "f"), { how: "image", ext: "png" });
  assert.deepEqual(previewKind(item({ path: "/a/x.heic" }), "f"), { how: "thumb" });
  assert.deepEqual(previewKind(item({ path: "/a/index.html" }), "f"), { how: "thumb" });
  assert.deepEqual(previewKind(item({ path: "/a/x.pdf" }), "f"), { how: "thumb" });
  assert.deepEqual(previewKind(item({ path: "/a/x.key" }), "f"), { how: "thumb" });
  assert.deepEqual(previewKind(item({ path: "/a/run.sh" }), "x"), { how: "text", lang: "bash" });
  assert.deepEqual(previewKind(item({ path: "/a/dir" }), "d"), { how: "folder" });
  assert.deepEqual(previewKind(item(), "-"), { how: "missing" });
  assert.deepEqual(previewKind(item({ path: null, url: "https://x.dev" }), null), { how: "url" });
});

test("thumbSize has two steps, Retina pixels", () => {
  assert.equal(thumbSize(268), 800);
  assert.equal(thumbSize(400), 800);
  assert.equal(thumbSize(401), 1600);
});

test("cacheName keys the file version and keeps an image's extension", () => {
  const st = { kind: "f", mtime: 1700000000, size: 42 };
  assert.equal(cacheName("0123456789abcdef", st, { how: "image", ext: "jpg" }, 800), "0123456789abcdef-1700000000-42.jpg");
  assert.equal(cacheName("0123456789abcdef", st, { how: "thumb" }, 1600), "0123456789abcdef-1700000000-42-1600.png");
  // Made with the person's handler asked first: its tag, so turning it on or off makes them again.
  assert.equal(cacheName("0123456789abcdef", st, { how: "thumb" }, 800, "0a1b2c3d4e5f"), "0123456789abcdef-1700000000-42-800-0a1b2c3d4e5f.png");
  assert.equal(cacheName("0123456789abcdef", st, { how: "image", ext: "png" }, 800, "0a1b2c3d4e5f"), "0123456789abcdef-1700000000-42.png");
});

test("STAT1_SCRIPT and parseStat describe a path", posix, () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-pv-"));
  writeFileSync(join(dir, "a b.md"), "hello");
  assert.deepEqual({ ...parseStat(sh(STAT1_SCRIPT, join(dir, "a b.md"))), mtime: 0 }, { kind: "f", mtime: 0, size: 5 });
  assert.ok(parseStat(sh(STAT1_SCRIPT, join(dir, "a b.md"))).mtime > 1600000000);
  assert.equal(parseStat(sh(STAT1_SCRIPT, dir)).kind, "d");
  assert.deepEqual(parseStat(sh(STAT1_SCRIPT, join(dir, "nope"))), { kind: "-" });
  assert.deepEqual(parseStat("garbage"), { kind: "-" });
});

test("previewText reads text, refuses binary, says when it was cut", posix, () => {
  assert.equal(previewText("# hi\n", 5), "# hi\n");
  assert.equal(previewText("a\0b", 3), null);
  assert.match(previewText("abc", TEXT_BYTES + 1), /first 512 KiB of 513 KiB/);
  const dir = mkdtempSync(join(tmpdir(), "rl-pv-"));
  writeFileSync(join(dir, "big.txt"), "x".repeat(TEXT_BYTES + 10));
  assert.equal(sh(HEAD_SCRIPT, join(dir, "big.txt")).length, TEXT_BYTES);
});

test("stripThreads drops omd's comment threads", () => {
  const md = "# T\n\nThe quick <!-- omd-start:t1 -->brown fox<!-- omd-end:t1 --> jumps.\n\n<!-- omd-threads\nt1: [{\"by\":\"x\"}]\n-->\n";
  assert.equal(stripThreads(md), "# T\n\nThe quick brown fox jumps.\n");
  assert.equal(stripThreads("plain <!-- other -->"), "plain <!-- other -->");
});

test("parseFolder lists folders first and caps the entries", posix, () => {
  assert.deepEqual(parseFolder("b.txt\nsub/\na.md\n.hidden\n"), {
    entries: [{ name: "sub", dir: true }, { name: ".hidden", dir: false }, { name: "a.md", dir: false }, { name: "b.txt", dir: false }],
    more: false,
  });
  const dir = mkdtempSync(join(tmpdir(), "rl-pv-"));
  for (let n = 0; n <= FOLDER_ENTRIES; n++) writeFileSync(join(dir, `f${n}`), "");
  mkdirSync(join(dir, "zz"));
  const f = parseFolder(sh(LIST_DIR_SCRIPT, dir));
  assert.equal(f.entries.length, FOLDER_ENTRIES);
  assert.equal(f.more, true);
});

test("CACHE_SCRIPT copies an image and replaces the item's older versions", posix, () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-pv-"));
  const cache = join(dir, ".cache", "local");
  const src = join(dir, "shot one.png");
  writeFileSync(src, "png");
  const id = "0123456789abcdef";
  sh(CACHE_SCRIPT, src, cache, join(cache, `${id}-1-3.png`), id, "copy");
  sh(CACHE_SCRIPT, src, cache, join(cache, `${id}-2-3.png`), id, "copy");
  writeFileSync(join(cache, "fedcba9876543210-1-1.png"), "");
  assert.deepEqual(readdirSync(cache).sort(), [`${id}-2-3.png`, "fedcba9876543210-1-1.png"]);
  sh(PRUNE_SCRIPT, cache, id);
  assert.deepEqual(readdirSync(cache), [`${id}-2-3.png`]);
});

test("CACHE_SCRIPT is safe when two copies of the mod make one image at once", posix, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-pv-"));
  const cache = join(dir, ".cache");
  const src = join(dir, "a.png");
  writeFileSync(src, "x".repeat(1 << 20));
  const id = "0123456789abcdef";
  const out = join(cache, `${id}-1-1.png`);
  const run = () => promisify(execFile)("sh", ["-c", CACHE_SCRIPT, "readlist", src, cache, out, id, "copy"]);
  await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(readdirSync(cache), [`${id}-1-1.png`]);
});

// Thumbnails through a handler: test/handlers.test.mjs.

test("copyText is the path, or the URL", () => {
  assert.equal(copyText(item()), "/tmp/plan.md");
  assert.equal(copyText(item({ path: null, url: "https://x.dev/a" })), "https://x.dev/a");
});
