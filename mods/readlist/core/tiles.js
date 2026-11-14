// Pure state for the HTML tile preview in the pane.
import { isAbsPath } from "./paths.js";
export const TILE_HEIGHT = 512;

export function tileCaptureOrder(height, offset = 0) {
  const count = Math.ceil(height / TILE_HEIGHT);
  const first = Math.max(0, Math.min(count - 1, Math.floor(offset / TILE_HEIGHT)));
  return Array.from({ length: count }, (_, i) => i).sort((a, b) =>
    Math.abs(a - first) - Math.abs(b - first) || (a < first ? 1 : 0) - (b < first ? 1 : 0));
}

export function darkBackground(color) {
  const hex = /^#([0-9a-f]{6})/i.exec(color ?? "");
  if (!hex) return true;
  const rgb = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
  return (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 < 128;
}

export function tileFallback(error) {
  if (/Chrome, Chromium, or Edge was not found/.test(error ?? "")) return "Chrome, Chromium, or Edge is unavailable. Showing the text preview.";
  if (/WebSocket is not defined/.test(error ?? "")) return "Node.js lacks WebSocket support. Showing the text preview.";
  if (/\bnode\b.*(?:not found|ENOENT)|ENOENT.*\bnode\b/i.test(error ?? "")) return "Node.js is unavailable. Showing the text preview.";
  return "HTML rendering failed. Showing the text preview.";
}

export function tileSlots(result, offset, view) {
  if (!(result?.height > 0) || !(view > 0)) return [];
  const first = Math.max(0, Math.floor(offset / TILE_HEIGHT));
  const last = Math.min(Math.ceil(result.height / TILE_HEIGHT), Math.ceil((offset + view) / TILE_HEIGHT));
  const ready = new Map(result.tiles?.map((tile) => [tile.y, tile]) ?? []);
  return Array.from({ length: Math.max(0, last - first) }, (_, i) => {
    const y = (first + i) * TILE_HEIGHT;
    return { y, height: Math.min(TILE_HEIGHT, result.height - y), file: ready.get(y)?.file ?? null };
  });
}

export function tileLinkAt(links, x, y) {
  return links?.find((link) => isAbsPath(link.target)
    && x >= link.x && x < link.x + link.width && y >= link.y && y < link.y + link.height) ?? null;
}

export function followTileLink(nav, link, offset) {
  if (!link) return { nav, jump: null };
  if (link.target === nav.file) return { nav, jump: Number.isFinite(link.anchorY) ? link.anchorY : null };
  return { nav: { ...nav, file: link.target, history: [...nav.history, { file: nav.file, offset }] }, jump: 0 };
}

export function backTileLink(nav) {
  if (!nav?.history?.length) return null;
  const previous = nav.history.at(-1);
  return { nav: { ...nav, file: previous.file, history: nav.history.slice(0, -1) }, offset: previous.offset };
}
