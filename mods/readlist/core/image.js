// Images in the preview: their pixel size from the first bytes of the file, the rectangle
// they fill in the view, and the background drawn behind them. Pure, for node tests.

// How much of the file the size is read from (core/helpers.js HEAD64_SCRIPT): a JPEG's frame
// header can follow large metadata.
export const IMAGE_HEAD_BYTES = 65536;

// The backgrounds `b` cycles through (shared("readlist.image-bg")): a checkerboard, so
// transparency shows, then plain dark and light gray.
export const IMAGE_BACKGROUNDS = ["checker", "dark", "light"];
export const IMAGE_BACKGROUND_LABEL = { checker: "Checker", dark: "Dark", light: "Light" };
export const IMAGE_GRAYS = { dark: "#2b2d31", light: "#d4d6da" };
// The checkerboard is drawn from square tiles in the mod (images/checker-*.png), this many
// logical px each.
export const CHECKER_TILE = 256;

export function imageBackground(value) {
  return IMAGE_BACKGROUNDS.includes(value) ? value : "checker";
}

export function nextImageBackground(value) {
  return IMAGE_BACKGROUNDS[(IMAGE_BACKGROUNDS.indexOf(imageBackground(value)) + 1) % IMAGE_BACKGROUNDS.length];
}

// The tiles that cover a view `width` by `height`: their top-left corners.
export function checkerTiles(width, height) {
  const tiles = [];
  for (let y = 0; y < height; y += CHECKER_TILE) for (let x = 0; x < width; x += CHECKER_TILE) tiles.push({ x, y });
  return tiles;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Bytes from base64 text (the mod engine has no atob); whitespace and padding are skipped.
export function fromBase64(text) {
  const clean = String(text ?? "").replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0, value = 0, n = 0;
  for (const char of clean) {
    value = (value << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const i32le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));
const sized = (width, height) => (width > 0 && height > 0 ? { width, height } : null);

// { width, height } in pixels for a PNG, GIF, JPEG, WebP or BMP, from its first bytes;
// null for anything else (SVG, a cut-off header). JPEG orientation is not applied.
export function imageSize(bytes) {
  const b = bytes;
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && ascii(b, 12, 4) === "IHDR") return sized(u32be(b, 16), u32be(b, 20));
  if (ascii(b, 0, 4) === "GIF8") return sized(u16le(b, 6), u16le(b, 8));
  if (ascii(b, 0, 2) === "BM") return sized(i32le(b, 18), Math.abs(i32le(b, 22)));
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 " && b.length >= 30) return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    if (chunk === "VP8L" && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (chunk === "VP8X" && b.length >= 30) return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the first start-of-frame marker (SOF0..SOF15 but DHT, JPG, DAC).
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return sized(u16be(b, i + 7), u16be(b, i + 5));
      }
      i += 2 + u16be(b, i + 2);
    }
  }
  return null;
}

// Where an image of `size` px fits (contained, centered) in a `view` of logical px, scaled by
// `zoom` around the center and moved by `pan`: { left, top, width, height }. Without a size,
// the whole view, as the image element fills it.
export function fittedRect(view, size, zoom = 1, pan = { x: 0, y: 0 }) {
  const fit = size ? Math.min(view.width / size.width, view.height / size.height) : 1;
  const width = size ? size.width * fit * zoom : view.width * zoom;
  const height = size ? size.height * fit * zoom : view.height * zoom;
  return { left: Math.round((view.width - width) / 2 + pan.x), top: Math.round((view.height - height) / 2 + pan.y),
    width: Math.round(width), height: Math.round(height) };
}
