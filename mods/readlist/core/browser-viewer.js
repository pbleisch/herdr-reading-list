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

// Where Space shows an item: "system" (the platform's preview window), "window" (the
// preview window inside Herdr: Markdown, HTML and PDF as rendered tiles, images drawn) or
// "browser" (the interactive browser viewer, for video and glTF, which tiles cannot show).
// Only types the built-in viewer covers switch with the person's preference.
export function spacePreviewRoute(item, mode) {
  const type = browserViewerType(item);
  if (mode === "system" || !type) return "system";
  return type === "video" || type === "gltf" ? "browser" : "window";
}

// The Herdr preview window: an overlay window of this mod (props {role: "window"}),
// opened under one key so it reopens where the person last dropped it.
export const WINDOW_KEY = "readlist-preview";
export const WINDOW_SIZE = { width: 820, height: 0.85 };

// What a key does in the preview window: Esc and Space close it (Space toggles it, as in the
// list), Enter opens the interactive browser viewer. Scrolling keys are handled apart.
export function windowAction(keystroke) {
  if (keystroke === "escape" || keystroke === "space") return "close";
  if (keystroke === "enter") return "interactive";
  return null;
}

// Space in the list while a preview window is open (shared("readlist.window") is
// {overlay, id}): "toggle" closes it (Space again on its item), "replace" shows another item
// in it, "close" closes it before another kind of preview opens, null when none is open.
export function windowPlan(open, key, route) {
  if (!open?.overlay) return null;
  if (open.id === key && route === "window") return "toggle";
  return route === "window" ? "replace" : "close";
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
