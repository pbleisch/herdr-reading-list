import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { cacheKey, mapCapturedLinks, pruneCache, touchEntry } from "../mods/readlist/viewer/tile-cache.mjs";
import { browserBinary, tileKind } from "../mods/readlist/viewer/render.mjs";
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

test("captured links map only to HTML and Markdown pages in the viewer host's manifest", () => {
  const prefix = "http://127.0.0.1:8000/token/document/";
  const files = new Map([["page 2.html", { mime: "text/html", target: "/local/page 2.html" }],
    ["notes.md", { mime: "text/markdown", target: "/local/notes.md" }],
    ["image.png", { mime: "image/png", target: "/local/image.png" }]]);
  const links = ["page%202.html#section", "notes.md", "image.png", "secret.html", "bad%XX.html"]
    .map((name) => ({ href: prefix + name, x: 1, y: 2, width: 3, height: 4 }));
  links.push({ href: "https://example.com/", x: 1, y: 2, width: 3, height: 4 });
  assert.deepEqual(mapCapturedLinks(links, prefix, files).map((link) => link.target), ["/local/page 2.html", "/local/notes.md"]);
});

test("tiles cover HTML, Markdown and PDF, by extension", () => {
  for (const [file, kind] of [["/a/page.HTML", "html"], ["/a/page.xhtml", "html"], ["/a/notes.md", "markdown"], ["/a/notes.mkd", "markdown"],
    ["/a/paper.pdf", "pdf"], ["/a/photo.png", null], ["/a/clip.mp4", null], ["/a/model.glb", null]]) {
    assert.equal(tileKind(file), kind, file);
  }
});

test("appearance and renderer failures select the text fallback", () => {
  assert.equal(darkBackground("#101010"), true);
  assert.equal(darkBackground("#eeeeee"), false);
  assert.match(tileFallback("Chrome, Chromium, or Edge was not found"), /unavailable/);
  assert.match(tileFallback("WebSocket is not defined"), /Node.js lacks WebSocket/);
  assert.match(tileFallback("node: command not found"), /Node.js is unavailable/);
  assert.match(tileFallback("Chrome crashed"), /rendering failed/i);
  // A PDF has no text preview: the interactive viewer is the way on.
  assert.equal(tileFallback("Chrome crashed", "pdf"), "PDF rendering failed. Enter opens the interactive viewer.");
  assert.equal(tileFallback("Chrome crashed", "markdown"), "Markdown rendering failed. Showing the text preview.");
  assert.match(tileFallback("Chrome, Chromium, or Edge was not found", "pdf"), /unavailable\. Enter opens/);
});

// End to end through headless Chrome on macOS when it is installed (CI's Linux runners often
// cannot start Chrome's sandbox): Markdown and a two-page PDF become tiles, with the PDF's
// page count reported.
const browser = process.platform === "darwin" && await browserBinary().then(() => true, () => false);
test("Markdown and PDF render to tiles through the viewer host", { skip: !browser && "needs macOS with Chrome, Chromium or Edge", timeout: 120000 }, async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const run = promisify(execFile);
  const script = fileURLToPath(new URL("../mods/readlist/viewer/render.mjs", import.meta.url));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-tiles-e2e-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cache = path.join(dir, "cache");
  const md = path.join(dir, "notes.md");
  await fs.writeFile(md, "# Notes\n\n" + "A line of text.\n\n".repeat(80) + "[more](more.md)\n");
  await fs.writeFile(path.join(dir, "more.md"), "# More\n");
  const render = async (file) => JSON.parse((await run(process.execPath, [script, file, cache, "600", "1", "light"], { timeout: 110000 })).stdout);
  const notes = await render(md);
  assert.equal(notes.kind, "markdown");
  assert.ok(notes.height > 512 && notes.tiles.length === Math.ceil(notes.height / 512));
  assert.deepEqual(notes.links.map((link) => link.target), [await fs.realpath(path.join(dir, "more.md"))]);
  // A minimal two-page PDF, written by hand with a correct cross-reference table.
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>"];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => { const at = body.length; body += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdf = path.join(dir, "paper.pdf");
  await fs.writeFile(pdf, body);
  const paper = await render(pdf);
  assert.equal(paper.kind, "pdf");
  assert.deepEqual([paper.pages, paper.shown], [2, 2]);
  // Two pages 576 px wide at 300x400 points, with the gaps: about 1580 px.
  assert.ok(paper.height > 1500 && paper.height < 1650, String(paper.height));
  assert.equal(paper.tiles.length, Math.ceil(paper.height / 512));
});
