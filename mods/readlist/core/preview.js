// In-pane previews: what the preview shows for an item, where its cached image goes, and
// the shell scripts that make it. Pure functions and constants, shared by the mod and the
// node tests. See docs/design.md 4.2 and 4.5.

import { typeOf } from "./items.js";

// Under this width (logical px) the pane is narrow: the preview is hidden until `p`, and
// shown below the list. At or above it, the list is on the left and the preview on the right.
export const WIDE = 520;

// The most text read into the pane, and the most folder entries listed.
export const TEXT_BYTES = 512 * 1024;
export const FOLDER_ENTRIES = 200;

// Images GPUI draws itself; these are copied into the cache as they are. Other images
// (HEIC, TIFF, PSD, ...) get a Quick Look thumbnail like HTML and PDF do.
const DRAWN = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

const LANG = { mjs: "js", cjs: "js", ts: "js", tsx: "js", jsx: "js", jsonc: "json", yml: "yaml", toml: "yaml", zsh: "bash", sh: "bash", htm: "html", xhtml: "html" };

export const ext = (path) => {
  const name = (path ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

// Whether the preview is shown: the person's `p` choice if they made one, else by width.
export function previewShown(width, choice) {
  if (typeof choice === "boolean") return choice;
  return (width ?? 0) >= WIDE;
}

// What the preview draws for an item, given its STAT line (`kind mtime size`, or `-`):
// { how: "url" | "missing" | "markdown" | "text" | "image" | "thumb" | "folder", lang?, ext? }.
export function previewKind(item, fsKind) {
  if (item.url) return { how: "url" };
  if (!fsKind || fsKind === "-") return { how: "missing" };
  if (fsKind === "d") return { how: "folder" };
  const e = ext(item.path);
  const type = typeOf(item, fsKind);
  if (type === "md") return { how: "markdown" };
  if (type === "code" || type === "text") return { how: "text", lang: LANG[e] ?? (e || "text") };
  if (type === "image" && DRAWN.has(e)) return { how: "image", ext: e };
  return { how: "thumb" };
}

// Thumbnail width in pixels for a preview this many logical pixels wide: two pixels per
// point for Retina, in two steps so a resize does not remake every thumbnail.
export function thumbSize(width) {
  return (width ?? 0) * 2 > 800 ? 1600 : 800;
}

// The cached image for an item at a given file version, relative to the cache folder. The
// version (mtime and size) is in the name, so a changed file gets a new image and image()
// never shows a stale one. Thumbnails also carry their size.
export function cacheName(id, stat, kind, size) {
  const v = `${stat.mtime}-${stat.size}`;
  return kind.how === "image" ? `${id}-${v}.${kind.ext}` : `${id}-${v}-${size}.png`;
}

// One line about a path: `kind mtime size`, kind d (folder), x (executable), f (file); or
// `-` when it is missing. macOS `stat -f`; Linux `stat -c` as a fallback.
export const STAT1_SCRIPT = 'p=$1; if [ ! -e "$p" ]; then echo -; exit 0; fi; ' +
  'if [ -d "$p" ]; then k=d; elif [ -x "$p" ]; then k=x; else k=f; fi; ' +
  'm=$(stat -f "%m %z" "$p" 2>/dev/null || stat -c "%Y %s" "$p"); echo "$k $m"';

export function parseStat(line) {
  const [kind, mtime, size] = (line ?? "").trim().split(/\s+/);
  if (kind !== "d" && kind !== "x" && kind !== "f") return { kind: "-" };
  return { kind, mtime: Number(mtime) || 0, size: Number(size) || 0 };
}

// The first TEXT_BYTES of a file ($1); previewText says when the file was longer.
export const HEAD_SCRIPT = `head -c ${TEXT_BYTES} -- "$1"`;

// A folder's entries ($1), folders marked with a trailing /; one more than shown, so the
// pane can say there are more.
export const LIST_DIR_SCRIPT = `ls -1Ap -- "$1" | head -n ${FOLDER_ENTRIES + 1}`;

// Puts an image for $1 at $3 (inside the cache folder $2), and removes the item's older
// images ($4 is the item id). $5 is "copy", or the thumbnail size for Quick Look
// (qlmanage -t, row 28). Several copies of the mod may make the same image at once, so
// each works in its own hidden temporary folder and renames the result into place.
export const CACHE_SCRIPT = [
  'set -u; src=$1; dir=$2; out=$3; id=$4; how=$5',
  'mkdir -p "$dir" && t=$(mktemp -d "$dir/.make.XXXXXX") || exit 1',
  'if [ -f "$out" ]; then :',
  'elif [ "$how" = copy ]; then cp "$src" "$t/copy" && mv "$t/copy" "$out"',
  'else qlmanage -t -s "$how" -o "$t" "$src" >/dev/null 2>&1',
  '  f=$(ls "$t" | head -n 1)',
  '  [ -n "$f" ] && mv "$t/$f" "$out"',
  'fi',
  'rm -rf "$t"',
  '[ -f "$out" ] || { echo "Quick Look made no thumbnail" >&2; exit 1; }',
  'for f in "$dir/$id"-*; do [ -e "$f" ] && [ "$f" != "$out" ] && rm -f "$f"; done',
  'exit 0',
].join("\n");

// Removes cached images of items no longer on the list ($2...: the ids kept) from $1.
export const PRUNE_SCRIPT = [
  'dir=$1; shift; [ -d "$dir" ] || exit 0',
  'for f in "$dir"/*; do [ -f "$f" ] || continue; n=${f##*/}; keep=0',
  '  for id; do case $n in "$id"-*) keep=1; break;; esac; done',
  '  [ $keep = 1 ] || rm -f "$f"',
  'done',
].join("\n");

// Text for the pane from HEAD_SCRIPT's output: null when it looks binary.
export function previewText(stdout, size) {
  const text = stdout ?? "";
  if (text.includes("\0")) return null;
  return size > TEXT_BYTES ? `${text}\n\n… (first ${TEXT_BYTES / 1024} KiB of ${Math.ceil(size / 1024)} KiB)` : text;
}

// omd's comment threads (the trailing `<!-- omd-threads ... -->` block and the inline
// `<!-- omd-start:t1 -->` anchors) are for omd, not for reading; the preview drops them.
export function stripThreads(md) {
  return (md ?? "")
    .replace(/\n*<!-- omd-threads\n[\s\S]*?\n-->\s*$/, "\n")
    .replace(/<!--\s*omd-(?:start|end):[A-Za-z0-9_-]+\s*-->/g, "");
}

// A folder listing from LIST_DIR_SCRIPT's output: { entries: [{name, dir}], more }.
export function parseFolder(stdout) {
  const lines = (stdout ?? "").split("\n").filter(Boolean);
  const entries = lines.slice(0, FOLDER_ENTRIES).map((l) => ({ name: l.replace(/\/$/, ""), dir: l.endsWith("/") }));
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { entries, more: lines.length > FOLDER_ENTRIES };
}

// What `c` copies: the path, or the URL.
export const copyText = (item) => item.path ?? item.url;
