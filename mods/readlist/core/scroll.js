// Scrolling in the viewer pane. TextView and Editor scroll only under the wheel, with no way
// to move them from code, so the viewer lays the item's text out at full height in a clipped
// box and moves it up by an offset it keeps itself: the wheel, the trackpad, the keys below
// and search (core/search.js) all set that offset. Pure functions, shared by the mod and the
// node tests. See docs/design.md 4.3.
//
// `v` is { offset, view, content }: how far the text is scrolled, the box's height and the
// text's full height, all in the pane's pixels.

// A key's scroll: lines, pages, half pages, or to an end. Space pages like `less`.
export const SCROLL_KEYS = {
  j: "line", down: "line", k: "-line", up: "-line",
  space: "page", pagedown: "page", "shift-space": "-page", pageup: "-page",
  "ctrl-d": "half", "ctrl-u": "-half",
  g: "top", home: "top", "shift-g": "bottom", end: "bottom",
};

// How far a line scrolls (j, k, the arrows), and how much of the last page a page keeps.
export const LINE = 40;

export const maxOffset = (v) => Math.max(0, (v.content || 0) - (v.view || 0));

export const clampOffset = (offset, v) => Math.min(maxOffset(v), Math.max(0, Number.isFinite(offset) ? offset : 0));

// The offset after key `k`, or null when it is not a scroll key.
export function keyOffset(k, v, line = LINE) {
  const what = SCROLL_KEYS[k];
  if (!what) return null;
  const view = v.view || 0;
  const page = Math.max(line, view - line);
  const by = { line, "-line": -line, page, "-page": -page, half: view / 2, "-half": -view / 2 }[what];
  if (what === "top") return 0;
  if (what === "bottom") return maxOffset(v);
  return clampOffset((v.offset || 0) + by, v);
}

// The offset after a wheel or trackpad move of `dy` (GPUI's sign: negative moves the text up).
export const wheelOffset = (dy, v) => clampOffset((v.offset || 0) - (Number(dy) || 0), v);

// The offset that puts the span [top, bottom) in the middle of the box.
export const centerOffset = (top, bottom, v) => clampOffset((top + bottom) / 2 - (v.view || 0) / 2, v);

// Rows of height `h` after `pad` px: the ones the box shows (half-open, clamped to `count`).
export function visibleRows(v, h, count, pad = 0) {
  const start = Math.max(0, Math.floor(((v.offset || 0) - pad) / h));
  const end = Math.min(count, Math.max(start, Math.ceil(((v.offset || 0) + (v.view || 0) - pad) / h)));
  return { start: Math.min(start, count), end };
}

// The scrollbar thumb: { top, height } within the box, or null when the text fits.
export const MIN_THUMB = 24;
export function thumb(v) {
  const view = v.view || 0, content = v.content || 0;
  if (view <= 0 || content <= view + 0.5) return null;
  const height = Math.min(view, Math.max(MIN_THUMB, (view * view) / content));
  const top = (view - height) * (clampOffset(v.offset, v) / maxOffset(v));
  return { top, height };
}

// A click on the scrollbar's track at `y` (in the box): a page toward it, or null on the thumb.
export function trackOffset(y, v) {
  const t = thumb(v);
  if (!t || (y >= t.top && y < t.top + t.height)) return null;
  return keyOffset(y < t.top ? "pageup" : "pagedown", v);
}
