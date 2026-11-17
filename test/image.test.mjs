import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { posix } from "./support.mjs";
import { helperCall } from "../mods/readlist/core/helpers.js";
import { IMAGE_HEAD_BYTES, CHECKER_TILE, imageBackground, nextImageBackground, checkerTiles, fromBase64, imageSize, fittedRect } from "../mods/readlist/core/image.js";

const repoFile = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const bytes = (...parts) => Uint8Array.from(parts.flat());
const pad = (b, n = 64) => Uint8Array.from([...b, ...new Array(Math.max(0, n - b.length)).fill(0)]);
const str = (s) => [...s].map((c) => c.charCodeAt(0));

test("image sizes come from the first bytes of PNG, GIF, JPEG, WebP and BMP", () => {
  assert.deepEqual(imageSize(readFileSync(repoFile("preview.png"))), { width: 1600, height: 1293 });
  assert.deepEqual(imageSize(readFileSync(repoFile("mods/readlist/images/checker-dark.png"))), { width: 512, height: 512 });
  assert.deepEqual(imageSize(pad(bytes(str("GIF89a"), [0x40, 0x01, 0xf0, 0x00]))), { width: 320, height: 240 });
  assert.deepEqual(imageSize(pad(bytes(str("BM"), new Array(16).fill(0), [0x10, 0, 0, 0], [0xf0, 0xff, 0xff, 0xff]))), { width: 16, height: 16 }, "a top-down BMP");
  // JPEG: SOI, an APP0 segment to skip, then SOF0 with height 480 and width 640.
  const jpeg = bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x04, 0, 0], [0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
  assert.deepEqual(imageSize(pad(jpeg)), { width: 640, height: 480 });
  // A DHT segment (0xc4) is not a frame header.
  const dht = bytes([0xff, 0xd8], [0xff, 0xc4, 0x00, 0x04, 0, 0], [0xff, 0xc2, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03]);
  assert.deepEqual(imageSize(pad(dht)), { width: 32, height: 16 });
  const riff = (chunk, body) => pad(bytes(str("RIFF"), [0, 0, 0, 0], str("WEBP"), str(chunk), [0, 0, 0, 0], body), 40);
  assert.deepEqual(imageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01])), { width: 640, height: 480 });
  assert.deepEqual(imageSize(riff("VP8X", [0, 0, 0, 0, 0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00])), { width: 640, height: 480 });
  // VP8L: 14-bit width-1 and height-1 after the 0x2f signature.
  const bits = (640 - 1) | ((480 - 1) << 14);
  assert.deepEqual(imageSize(riff("VP8L", [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff])), { width: 640, height: 480 });
  for (const other of [null, new Uint8Array(4), pad(bytes(str("<svg width='10'"))), pad(bytes([0xff, 0xd8, 0x00]))]) assert.equal(imageSize(other), null);
});

test("base64 decodes as the shell's base64 encodes, wrapped or not", () => {
  const data = readFileSync(repoFile("preview.png")).subarray(0, 300);
  const b64 = data.toString("base64");
  assert.deepEqual(Buffer.from(fromBase64(b64)), data);
  assert.deepEqual(Buffer.from(fromBase64(b64.replace(/(.{76})/g, "$1\n"))), data);
  assert.equal(fromBase64("").length, 0);
});

test("head64 prints the first bytes of an image as one line of base64", posix, () => {
  const file = repoFile("preview.png");
  const c = helperCall("posix", "/m", "head64", [file]);
  const out = execFileSync(c.command, c.args).toString();
  assert.doesNotMatch(out, /\n/);
  assert.equal(fromBase64(out).length, IMAGE_HEAD_BYTES);
  assert.deepEqual(imageSize(fromBase64(out)), { width: 1600, height: 1293 });
  assert.deepEqual(helperCall("windows", "C:\\m", "head64", ["C:\\a.png"]).args.slice(-3), ["head64", "C:\\a.png", String(IMAGE_HEAD_BYTES)]);
});

test("an image fits its view, centered, zoomed and panned; the stage background cycles", () => {
  assert.deepEqual(fittedRect({ width: 800, height: 600 }, { width: 1600, height: 698 }), { left: 0, top: 126, width: 800, height: 349 });
  assert.deepEqual(fittedRect({ width: 800, height: 600 }, { width: 100, height: 300 }), { left: 300, top: 0, width: 200, height: 600 });
  assert.deepEqual(fittedRect({ width: 800, height: 600 }, { width: 100, height: 300 }, 2, { x: 10, y: -20 }), { left: 210, top: -320, width: 400, height: 1200 });
  assert.deepEqual(fittedRect({ width: 800, height: 600 }, null), { left: 0, top: 0, width: 800, height: 600 }, "the whole view while the size is unknown");
  assert.equal(imageBackground(undefined), "checker");
  assert.equal(imageBackground("nonsense"), "checker");
  assert.deepEqual(["checker", "dark", "light", undefined].map(nextImageBackground), ["dark", "light", "checker", "dark"]);
  assert.equal(checkerTiles(600, 300).length, Math.ceil(600 / CHECKER_TILE) * Math.ceil(300 / CHECKER_TILE));
  assert.deepEqual(checkerTiles(0, 300), []);
});

test("a video poster is one PNG frame from FFmpeg, cached by the file, or a clear error without FFmpeg", { skip: process.platform === "win32" }, async (t) => {
  const { promises: fs } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { videoPoster } = await import("../mods/readlist/viewer/video-poster.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-poster-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clip = path.join(dir, "clip.mp4"), cache = path.join(dir, "cache");
  await fs.writeFile(clip, "not really a video");
  // A stand-in for FFmpeg that writes a PNG to the path it is given last.
  const fake = path.join(dir, "ffmpeg");
  await fs.writeFile(fake, `#!/bin/sh\nfor a; do out=$a; done\ncp "${repoFile("preview.png")}" "$out"\n`, { mode: 0o755 });
  const first = await videoPoster(clip, cache, fake);
  assert.match(first.key, /^[a-f0-9]{20}$/);
  assert.equal(first.cached, false);
  assert.deepEqual(imageSize(await fs.readFile(path.join(cache, first.key, "poster.png"))), { width: 1600, height: 1293 });
  assert.deepEqual(await videoPoster(clip, cache, fake), { key: first.key, cached: true });
  await assert.rejects(videoPoster(clip, path.join(dir, "other"), path.join(dir, "no-ffmpeg")), /FFmpeg is not installed/);
  assert.deepEqual(await fs.readdir(path.join(dir, "other")), [], "a failed poster leaves no folder behind");
  await assert.rejects(videoPoster(repoFile("preview.png"), cache, fake), /Unsupported video/);
});
