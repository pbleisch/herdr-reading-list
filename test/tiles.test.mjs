import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheKey, mapCapturedLinks, pruneCache, touchEntry } from "../mods/readlist/viewer/tile-cache.mjs";
import { darkBackground, tileFallback, tileCaptureOrder, tileSlots, tileLinkAt, followTileLink, backTileLink } from "../mods/readlist/core/tiles.js";

test("tile cache key follows file and asset bytes, width, scale and appearance", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-tile-key-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "index.html"), css = path.join(dir, "style.css");
  await fs.writeFile(file, '<link href="style.css"><h1>Hi</h1>');
  await fs.writeFile(css, "body{color:red}");
  const files = new Map([["index.html", { target: file }], ["style.css", { target: css }]]);
  const first = await cacheKey(file, files, 600, 2, false);
  assert.equal(first, await cacheKey(file, new Map([...files].reverse()), 600, 2, false));
  for (const args of [[601, 2, false], [600, 1, false], [600, 2, true]]) {
    assert.notEqual(first, await cacheKey(file, files, ...args));
  }
  // Same size and restored mtime still invalidate the key: bytes are authoritative.
  const before = await fs.stat(css);
  await fs.writeFile(css, "body{color:tan}");
  await fs.utimes(css, before.atime, before.mtime);
  assert.notEqual(first, await cacheKey(file, files, 600, 2, false));
  await fs.writeFile(file, '<link href="style.css"><h1>Ho</h1>');
  assert.notEqual(first, await cacheKey(file, files, 600, 2, false));
});

test("tile cache evicts least recently used entries and keeps active entry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-tile-evict-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const names = ["a".repeat(20), "b".repeat(20), "c".repeat(20)];
  for (const [index, name] of names.entries()) {
    const dir = path.join(root, name);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "tile.png"), Buffer.alloc(10));
    await fs.utimes(dir, new Date(1000 + index * 1000), new Date(1000 + index * 1000));
  }
  await touchEntry(path.join(root, names[0]));
  await pruneCache(root, [names[2]], 20);
  assert.deepEqual((await fs.readdir(root)).sort(), [names[0], names[2]]);
});

test("tile mapping exposes ready images, placeholders, and local link hit targets", () => {
  assert.deepEqual(tileCaptureOrder(4 * 512, 1100), [2, 3, 1, 0]);
  const tiles = tileSlots({ height: 1200, tiles: [{ file: "tile-000.png", y: 0, height: 512 }] }, 400, 800);
  assert.deepEqual(tiles.map((tile) => tile.file), ["tile-000.png", null, null]);
  const links = [{ x: 20, y: 520, width: 80, height: 20, target: "/local/page.html", anchorY: null }];
  const link = tileLinkAt(links, 30, 525);
  assert.equal(tileLinkAt(links, 19, 525), null);
  assert.equal(tileLinkAt([{ ...links[0], target: "https://example.com/" }], 30, 525), null);
  const nav = { id: "item", file: "/local/index.html", history: [] };
  const followed = followTileLink(nav, link, 480);
  assert.equal(followed.nav.file, "/local/page.html");
  assert.deepEqual(backTileLink(followed.nav), { nav, offset: 480 });
  assert.equal(followTileLink(nav, { ...link, target: nav.file, anchorY: 900 }, 0).jump, 900);
});

test("captured links map only to HTML in the viewer host's manifest", () => {
  const prefix = "http://127.0.0.1:8000/token/document/";
  const files = new Map([["page 2.html", { mime: "text/html", target: "/local/page 2.html" }],
    ["image.png", { mime: "image/png", target: "/local/image.png" }]]);
  const links = ["page%202.html#section", "image.png", "secret.html", "bad%XX.html"]
    .map((name) => ({ href: prefix + name, x: 1, y: 2, width: 3, height: 4 }));
  links.push({ href: "https://example.com/", x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(mapCapturedLinks(links, prefix, files).map((link) => link.target), ["/local/page 2.html"]);
});

test("appearance and renderer failures select the text fallback", () => {
  assert.equal(darkBackground("#101010"), true);
  assert.equal(darkBackground("#eeeeee"), false);
  assert.match(tileFallback("Chrome, Chromium, or Edge was not found"), /unavailable/);
  assert.match(tileFallback("WebSocket is not defined"), /Node.js lacks WebSocket/);
  assert.match(tileFallback("node: command not found"), /Node.js is unavailable/);
  assert.match(tileFallback("Chrome crashed"), /rendering failed/i);
});
