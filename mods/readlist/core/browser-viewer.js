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

// Only types this viewer covers switch with the person's preference.
export function spacePreviewRoute(item, mode) {
  return mode === "system" || !browserViewerType(item) ? "system" : "browser";
}

export function viewerFailureNotice(result) {
  const message = String(result?.stderr ?? "").trim().replace(/^readlist:\s*/, "");
  return message ? `Couldn't open browser viewer: ${message}. Preview is shown in the pane.` : null;
}
