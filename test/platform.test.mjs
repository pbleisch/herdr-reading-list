import { test } from "node:test";
import assert from "node:assert/strict";
import { posix } from "./support.mjs";
import { normalizeItem, openAction } from "../mods/readlist/core/items.js";
import { previewKind, THUMB } from "../mods/readlist/core/preview.js";
import { LINUX_RUNS, platformOf, words, noQuickLook } from "../mods/readlist/core/platform.js";

// The actions themselves (open, reveal, Space, thumbnails) are the built-in handlers:
// test/handlers.test.mjs.

const item = (over = {}) => normalizeItem({
  v: 1, id: "0123456789abcdef", path: "/tmp/plan.md", url: null, title: "plan.md", note: null,
  kind: "review", added_at: "2026-11-08T18:00:00Z", adds: 1, by: {}, done_at: null, ...over,
});

test("platformOf reads Herdr's window().platform, macOS when unknown", () => {
  assert.equal(platformOf({ platform: "linux" }), "linux");
  assert.equal(platformOf({ platform: "windows" }), "windows");
  assert.equal(platformOf({ platform: "macos" }), "macos");
  assert.equal(platformOf({}), "macos");
  assert.equal(platformOf(undefined), "macos");
});

test("words keep macOS's names and name Linux's", () => {
  assert.deepEqual(words("macos"), { files: "Finder", here: "this Mac", look: "Quick Look" });
  assert.equal(words("linux").files, "the file manager");
  assert.equal(words("linux").here, "this computer");
  assert.equal(words("nope").files, "Finder");
});

test("openAction reveals Linux launchers on Linux only", () => {
  for (const e of ["desktop", "AppImage", "run", "deb", "flatpakref"]) {
    assert.equal(openAction(item({ path: `/a/x.${e}` }), "f", "linux").how, "reveal", e);
    assert.equal(openAction(item({ path: `/a/x.${e}` }), "f").how, "open", `${e} on macOS`);
  }
  assert.ok(LINUX_RUNS.has("desktop"));
  assert.equal(openAction(item({ path: "/a/x.command" }), "f", "linux").how, "reveal");
  assert.equal(openAction(item({ path: "/a/x.md" }), "f", "linux").how, "open");
  assert.equal(openAction(item({ path: "/a/x.md" }), "x", "linux").how, "reveal");
});

test("previewKind asks the handlers for a thumbnail on every platform", () => {
  for (const p of ["/a/x.pdf", "/a/index.html", "/a/x.heic", "/a/x.key"]) assert.deepEqual(previewKind(item({ path: p }), "f"), { how: "thumb" }, p);
  assert.deepEqual(previewKind(item({ path: "/a/x.png" }), "f"), { how: "image", ext: "png" });
  assert.deepEqual(previewKind(item(), "f"), { how: "markdown" });
  assert.deepEqual(THUMB, { how: "thumb" });
});

test("noQuickLook says why Space shows the preview here, in one line", () => {
  assert.equal(noQuickLook("Space's preview window needs GNOME Sushi (the sushi package)"),
    "Space's preview window needs GNOME Sushi (the sushi package); showing the preview here instead.");
  assert.equal(noQuickLook("Space's preview window needs gdbus and GNOME Sushi"),
    "Space's preview window needs gdbus and GNOME Sushi; showing the preview here instead.");
  assert.match(noQuickLook(null), /no quick preview/);
  assert.match(noQuickLook(""), /no quick preview/);
  for (const m of [noQuickLook("x"), noQuickLook(null)]) assert.doesNotMatch(m, /\n/);
});
