import { test } from "node:test";
import assert from "node:assert/strict";
import { posix } from "./support.mjs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeItem } from "../mods/readlist/core/items.js";
import {
  WIDE, TEXT_BYTES, STAT1_SCRIPT, HEAD_SCRIPT, CACHE_SCRIPT, PRUNE_SCRIPT,
  previewShown, previewKind, plainCodeFallback, shebangLanguage, thumbSize, cacheName, parseStat, previewText, stripThreads, copyText,
} from "../mods/readlist/core/preview.js";
import { FOLDER_ENTRIES, LIST_DIR_SCRIPT, SAFE_PATH_SCRIPT, parseFolder, folderItems } from "../mods/readlist/core/folder.js";

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
  assert.deepEqual(previewKind(item({ path: "/a/x.log" }), "f"), { how: "text", lang: "txt" });
  assert.deepEqual(previewKind(item({ path: "/a/x.PNG" }), "f"), { how: "image", ext: "png" });
  assert.deepEqual(previewKind(item({ path: "/a/x.heic" }), "f"), { how: "thumb" });
  assert.deepEqual(previewKind(item({ path: "/a/index.html" }), "f"), { how: "html" });
  assert.deepEqual(previewKind(item({ path: "/a/page.HTM" }), "f"), { how: "html" });
  assert.deepEqual(previewKind(item({ path: "/a/x.pdf" }), "f"), { how: "thumb" });
  assert.deepEqual(previewKind(item({ path: "/a/x.key" }), "f"), { how: "thumb" });
  assert.deepEqual(previewKind(item({ path: "/a/run.sh" }), "x"), { how: "text", lang: "sh" });
  assert.deepEqual(previewKind(item({ path: "/a/dir" }), "d"), { how: "folder" });
  assert.deepEqual(previewKind(item(), "-"), { how: "missing" });
  assert.deepEqual(previewKind(item({ path: null, url: "https://x.dev" }), null), { how: "url" });
});

test("code names and extensions select installed syntax names or a deliberate plain text fallback", () => {
  const cases = {
    "Dockerfile": "txt", "Containerfile": "txt", "Makefile": "makefile", "GNUmakefile": "makefile", "build.mk": "mk",
    "change.diff": "diff", "change.patch": "diff", "app.ini": "txt", "app.cfg": "txt", "app.conf": "txt",
    ".env": "txt", ".env.local": "txt", "app.env": "txt", "api.proto": "txt", "query.graphql": "txt", "query.gql": "txt",
    "app.cs": "cs", "page.php": "php", "model.r": "r", "main.tf": "txt", "main.hcl": "txt", "config.nix": "txt",
    "page.vue": "html", "page.svelte": "html", "app.kts": "txt", "build.gradle": "gradle", "setup.ps1": "txt",
    "run.bat": "bat", "run.cmd": "cmd", "run.fish": "fish", "init.el": "el", "app.ex": "txt", "app.exs": "txt",
    "worker.erl": "erl", "main.hs": "hs", "main.ml": "ml", "main.scala": "scala", "main.dart": "txt",
    "main.jl": "txt", "main.pl": "pl", "main.m": "m", "data.csv": "txt", "data.tsv": "txt",
    "app.ts": "js", "view.tsx": "js", "config.toml": "yaml", "main.scss": "css", "main.swift": "txt", "main.zig": "txt",
  };
  for (const [name, lang] of Object.entries(cases)) {
    assert.deepEqual(previewKind(item({ path: `/a/${name}` }), "f"), { how: "text", lang }, name);
  }
});

test("the full viewer uses the highlighted editor for standalone and browsed code files", () => {
  const path = "/samples/code/web/app.js";
  const standalone = item({ path });
  const [browsed] = folderItems(item({ path: "/samples" }), ["code", "web"], [{ name: "app.js", dir: false }]);
  assert.equal(browsed.path, path);
  assert.deepEqual(previewKind(standalone, "f"), { how: "text", lang: "js" });
  assert.deepEqual(previewKind(browsed, browsed.folderKind), { how: "text", lang: "js" });
  assert.equal(plainCodeFallback(standalone, "f", "js"), false);
  assert.equal(plainCodeFallback(browsed, browsed.folderKind, "js"), false);
  assert.equal(plainCodeFallback(item({ path: "/samples/code/main.swift" }), "f", "txt"), true);
  assert.equal(plainCodeFallback(item({ path: "/samples/notes.txt" }), "f", "txt"), false);

  // Load the full-pane method with a stand-in native Editor; the old plain-row
  // path fails this check without needing the GPUI runtime in the Node tests.
  const source = readFileSync(new URL("../mods/readlist/main.js", import.meta.url), "utf8");
  const method = source.match(/  viewerBody\(item, pv, t\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(method, "viewerBody is present");
  const view = { flex_1() { return this; }, min_h() { return this; } };
  const code = {};
  const Editor = { new(state) { assert.equal(state, code); return view; } };
  const viewerBody = new Function("Editor", "itemKey", `return ({${method}}).viewerBody;`)(Editor, (i) => i.id);
  const pane = { rowsBody() { assert.fail("full code preview used plain rows"); } };
  for (const codeItem of [standalone, browsed]) {
    assert.equal(viewerBody.call(pane, codeItem, { how: "text", text: "const x = 1;", code }, {}), view);
  }
});

test("extensionless shebangs use the bounded text read", () => {
  const cases = {
    "#!/usr/bin/python3.12\nprint('hi')": "py", "#!/usr/bin/env node\nconsole.log(1)": "js",
    "#!/usr/bin/env -S deno run\n": "js", "#!/usr/bin/env bun\n": "js",
    "#!/bin/bash\necho hi": "bash", "#!/bin/sh\necho hi": "sh", "#!/usr/bin/env zsh\n": "zsh",
    "#!/usr/bin/env ruby\nputs 1": "rb", "#!/usr/bin/perl\nprint 1": "pl",
  };
  const script = item({ path: "/a/script" });
  assert.deepEqual(previewKind(script, "f"), { how: "shebang" });
  for (const [content, lang] of Object.entries(cases)) {
    assert.equal(shebangLanguage(content), lang);
    assert.deepEqual(previewKind(script, "f", content), { how: "text", lang });
  }
  assert.deepEqual(previewKind(script, "f", "just text"), { how: "thumb" });
  assert.equal(shebangLanguage("first\n#!/bin/bash"), null);
  assert.equal(shebangLanguage("#!/usr/bin/env unknown"), null);
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
  assert.deepEqual(parseFolder("d\tsub\nf\t.hidden\nf\ta.md\nf\tb.txt\n"), {
    entries: [{ name: "sub", dir: true }, { name: ".hidden", dir: false }, { name: "a.md", dir: false }, { name: "b.txt", dir: false }],
    more: false,
  });
  const dir = mkdtempSync(join(tmpdir(), "rl-pv-"));
  for (let n = 0; n <= FOLDER_ENTRIES; n++) writeFileSync(join(dir, `f${n}`), "");
  mkdirSync(join(dir, "zz"));
  writeFileSync(join(dir, ".secret"), "");
  symlinkSync(join(dir, "f0"), join(dir, "link"));
  const f = parseFolder(sh(LIST_DIR_SCRIPT, dir, "0"));
  assert.equal(f.entries.length, FOLDER_ENTRIES);
  assert.equal(f.more, true);
  assert.deepEqual(f.entries[0], { name: "zz", dir: true });
  assert.ok(!f.entries.some((e) => e.name === ".secret" || e.name === "link"));
  assert.deepEqual(parseFolder(sh(LIST_DIR_SCRIPT, dir, "1")).entries.slice(0, 2), [
    { name: "zz", dir: true }, { name: ".secret", dir: false },
  ]);
});

test("SAFE_PATH_SCRIPT keeps browsing inside the root and rejects symlinks", posix, () => {
  const root = mkdtempSync(join(tmpdir(), "rl-safe-"));
  const sub = join(root, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "a.txt"), "ok");
  symlinkSync(tmpdir(), join(root, "away"));
  assert.equal(sh(SAFE_PATH_SCRIPT, root, join(sub, "a.txt")).trim(), "ok");
  assert.throws(() => sh(SAFE_PATH_SCRIPT, root, join(root, "away")));
  assert.throws(() => sh(SAFE_PATH_SCRIPT, root, join(root, "away", "elsewhere")));
  assert.throws(() => sh(SAFE_PATH_SCRIPT, root, join(root, "..", "outside")));
  const alias = join(mkdtempSync(join(tmpdir(), "rl-safe-link-")), "root");
  symlinkSync(root, alias);
  assert.throws(() => sh(SAFE_PATH_SCRIPT, alias, join(alias, "sub", "a.txt")));
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
