// Message from the Node viewer command, suitable for a toast in the mod.
import { typeOf } from "./items.js";
import { baseName } from "./paths.js";

const BROWSER_IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic", "heif", "bmp"]);
export function browserViewerType(item) {
  if (!item?.path) return null;
  const type = typeOf(item);
  const name = baseName(item.path);
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (type === "md" && ["md", "markdown", "mdown", "mkd"].includes(extension)) return "markdown";
  if (["html", "pdf", "video", "gltf"].includes(type)) return type;
  return type === "image" && BROWSER_IMAGES.has(extension) ? "image" : null;
}

// Where Space shows an item: "window", the built-in preview inside Herdr (any file: pages as
// rendered tiles, images, video posters, 3D stills, text, thumbnails), or "system", the
// platform's preview window, as the person chose in the `f` menu. A link has no file to show.
export function spacePreviewRoute(item, mode) {
  return mode === "system" || !item?.path ? "system" : "window";
}

// The Herdr preview window: an overlay window of this mod (props {role: "window"}),
// opened under one key so it reopens where the person last dropped it.
export const WINDOW_KEY = "readlist-preview";
export const WINDOW_HEIGHT = 0.85;
// Its width in px: by default 70% of the Herdr window, kept between 640 and 1280 px so a very
// wide window does not make lines too long to read. `[` / `]` change it by 15%, between 480 px
// and the Herdr window's width, and the choice is kept (shared("readlist.window-width")).
export const WINDOW_WIDTH = { share: 0.7, min: 640, max: 1280, least: 480, step: 1.15 };

// The Herdr window's width in logical px from its window.json ({bounds: [x, y, w, h]}), or null.
export function herdrWidth(text) {
  try {
    const width = JSON.parse(text ?? "null")?.bounds?.[2];
    return Number.isFinite(width) && width > 0 ? width : null;
  } catch {
    return null;
  }
}

// The width to open the window at: the kept one, else the default; a share of the window
// when its size is unknown.
export function windowWidth(saved, herdr) {
  const most = herdr ? Math.round(herdr * 0.98) : Infinity;
  if (Number.isFinite(saved) && saved > 0) return Math.round(Math.max(WINDOW_WIDTH.least, Math.min(most, saved)));
  if (!herdr) return WINDOW_WIDTH.share;
  return Math.round(Math.min(most, Math.max(WINDOW_WIDTH.min, Math.min(WINDOW_WIDTH.max, herdr * WINDOW_WIDTH.share))));
}

// One step wider (dir 1) or narrower (-1) from the window's measured width, or null when it
// cannot change.
export function resizedWidth(current, dir, herdr) {
  if (!(current > 0)) return null;
  const most = herdr ? Math.round(herdr * 0.98) : Infinity;
  const next = Math.round(Math.max(WINDOW_WIDTH.least, Math.min(most, dir > 0 ? current * WINDOW_WIDTH.step : current / WINDOW_WIDTH.step)));
  return Math.abs(next - current) < 2 ? null : next;
}

// A key that resizes the window: `]` / `[` always, `=` / `+` / `-` too unless an image shows
// (there they zoom it). 1 wider, -1 narrower, null otherwise.
export function windowResizeKey(keystroke, image = false) {
  if (keystroke === "]") return 1;
  if (keystroke === "[") return -1;
  if (image) return null;
  if (keystroke === "=" || keystroke === "+" || keystroke === "shift-=") return 1;
  return keystroke === "-" ? -1 : null;
}

// What a key does in the built-in preview (the window, the docked `v` pane and the `rl preview`
// pane): Enter opens the file in its default app, Space in the interactive browser viewer, q in
// the platform's preview window, o shows it in the file manager, Esc closes the window or pane,
// or hides the docked preview.
// Scrolling, search, width and image keys are handled apart.
export const SURFACE_KEYS = { enter: "open", space: "interactive", q: "system", o: "reveal", escape: "close" };
export function windowAction(keystroke) {
  return SURFACE_KEYS[keystroke] ?? null;
}

// Space in the list while a preview window is open (shared("readlist.window") is
// {overlay, id, held}): "toggle" closes it (Space again on its item), "replace" shows another
// item in it, "close" closes it before another kind of preview opens, null when none is open.
// A window that only holds a note for its item (`held`: a large file on another machine not
// fetched yet) is filled by Space rather than closed.
export function windowPlan(open, key, route) {
  if (!open?.overlay) return null;
  if (open.id === key && route === "window") return open.held ? "replace" : "toggle";
  return route === "window" ? "replace" : "close";
}

// The window follows the list's selection, as the docked preview does: when a list copy's
// selection moves to `key` while the window is open, whether the window should show it now.
// Not while it reopens at another width, and not when it already shows that item.
export function windowFollows(open, key) {
  return Boolean(open?.overlay) && open.overlay !== "resizing" && typeof key === "string" && key !== "" && key !== open.id;
}

// Keys in the window and the docked preview that move the list's selection, which the
// preview then follows: Shift-J the next item, Shift-K the previous one. They run the list's
// `down` / `up` commands, which the copy that had the keyboard last acts on.
export const LIST_KEYS = { "shift-j": "down", "shift-k": "up" };
export function listStep(keystroke) {
  return LIST_KEYS[keystroke] ?? null;
}

// A note over a PDF drawn in part.
export function pagesNote(result) {
  return result?.pages > result?.shown
    ? `Showing the first ${result.shown} of ${result.pages} pages. Enter opens all of them in the interactive viewer.`
    : null;
}

export function viewerFailureNotice(result) {
  const message = String(result?.stderr ?? "").trim().replace(/^readlist:\s*/, "");
  return message ? `Couldn't open browser viewer: ${message}. Preview is shown in the pane.` : null;
}
