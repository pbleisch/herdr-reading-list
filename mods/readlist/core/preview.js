// In-pane previews: what the preview shows for an item, where its cached image goes, and
// the shell scripts that make it. Pure functions and constants, shared by the mod and the
// node tests. See docs/design.md 4.2 and 4.5.

import { typeOf } from "./items.js";
import { THUMB_SECONDS } from "./handlers.js";
import { baseName } from "./paths.js";

// Under this width (logical px) the pane is narrow: the preview is hidden until `p`, and
// shown below the list. At or above it, the list is on the left and the preview on the right.
export const WIDE = 520;

// The most text read into the pane.
export const TEXT_BYTES = 512 * 1024;

// Images GPUI draws itself; these are copied into the cache as they are. Other images
// (HEIC, TIFF, PSD, ...) get a thumbnail from a handler like HTML and PDF do.
const DRAWN = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

// EditorState looks up Syntect syntax by file extension. Every value here is an
// extension in the installed syntax set; "txt" deliberately requests plain text.
const LANG = {
  js: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", jsx: "js",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "yaml",
  rs: "rs", go: "go", py: "py", rb: "rb", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp",
  java: "java", kt: "txt", kts: "txt", swift: "txt",
  sh: "sh", zsh: "zsh", bash: "bash", fish: "fish",
  css: "css", scss: "css", sql: "sql", lua: "lua", zig: "txt", xml: "xml",
  mk: "mk", diff: "diff", patch: "diff", ini: "txt", cfg: "txt", conf: "txt", env: "txt",
  proto: "txt", graphql: "txt", gql: "txt", cs: "cs", php: "php", r: "r",
  tf: "txt", hcl: "txt", nix: "txt", vue: "html", svelte: "html",
  gradle: "gradle", ps1: "txt", bat: "bat", cmd: "cmd", el: "el", ex: "txt", exs: "txt",
  erl: "erl", hs: "hs", ml: "ml", scala: "scala", dart: "txt", jl: "txt", pl: "pl", m: "m",
  txt: "txt", log: "txt", csv: "txt", tsv: "txt", rst: "rst", org: "txt", adoc: "txt",
};
const NAME_LANG = { dockerfile: "txt", containerfile: "txt", makefile: "makefile", gnumakefile: "makefile" };

export function shebangLanguage(firstLine) {
  const line = (firstLine ?? "").split(/\r?\n/, 1)[0];
  if (!line.startsWith("#!")) return null;
  let parts = line.slice(2).trim().split(/\s+/);
  let command = parts.shift()?.split(/[\\/]/).pop()?.toLowerCase();
  if (command === "env") {
    parts = parts.filter((p) => p !== "-S" && p !== "--");
    command = parts.find((p) => !p.startsWith("-"))?.split(/[\\/]/).pop()?.toLowerCase();
  }
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(command ?? "")) return "py";
  if (["node", "nodejs", "deno", "bun"].includes(command)) return "js";
  if (command === "ruby") return "rb";
  if (command === "perl") return "pl";
  if (["sh", "bash", "zsh", "fish"].includes(command)) return command;
  return null;
}

export const ext = (path) => {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

// Whether the preview is shown: the person's `p` choice if they made one, else by width.
export function previewShown(width, choice) {
  if (typeof choice === "boolean") return choice;
  return (width ?? 0) >= WIDE;
}

// What the preview draws for an item, given its STAT line (`kind mtime size`, or `-`):
// { how: "url" | "missing" | "markdown" | "html" | "text" | "image" | "model" | "thumb" | "folder", lang?, ext? }.
// HTML draws as text (readableHtml), so a long page scrolls like markdown does. "thumb"
// asks the handlers for a thumbnail (core/handlers.js); when none makes one, the preview
// shows the type's icon.
export function previewKind(item, fsKind, firstLine) {
  if (item.url) return { how: "url" };
  if (!fsKind || fsKind === "-") return { how: "missing" };
  if (fsKind === "d") return { how: "folder" };
  const e = ext(item.path);
  const name = baseName(item.path).toLowerCase();
  const type = typeOf(item, fsKind);
  if (type === "md") return { how: "markdown" };
  if (type === "html") return { how: "html" };
  if (type === "code" || type === "text") return { how: "text", lang: NAME_LANG[name] ?? (name === ".env" || name.startsWith(".env.") ? "txt" : LANG[e]) };
  if (!e && (fsKind === "f" || fsKind === "x")) {
    if (firstLine === undefined) return { how: "shebang" };
    const lang = shebangLanguage(firstLine);
    if (lang) return { how: "text", lang };
  }
  if (type === "gltf") return { how: "model" };
  if (type === "image" && DRAWN.has(e)) return { how: "image", ext: e };
  return THUMB;
}

// A code file that Herdr can show only as plain text, so the pane can say why.
export const plainCodeFallback = (item, fsKind, lang) => lang === "txt" && typeOf(item, fsKind) === "code";

// A file with no drawn preview: a thumbnail from a handler.
export const THUMB = Object.freeze({ how: "thumb" });

// Thumbnail width in pixels for a preview this many logical pixels wide: two pixels per
// point for Retina, in two steps so a resize does not remake every thumbnail.
export function thumbSize(width) {
  return (width ?? 0) * 2 > 800 ? 1600 : 800;
}

// The cached image for an item at a given file version, relative to the cache folder. The
// version (mtime and size) is in the name, so a changed file gets a new image and image()
// never shows a stale one. Thumbnails also carry their size, and the person's handler's
// tag when it was asked first (core/handlers.js chain), so turning it on or off, or
// confirming a new version, makes them again.
export function cacheName(id, stat, kind, size, tag = "") {
  const v = `${stat.mtime}-${stat.size}`;
  return kind.how === "image" ? `${id}-${v}.${kind.ext}` : `${id}-${v}-${size}${tag ? `-${tag}` : ""}.png`;
}

// One line about a path: `kind mtime size`, kind d (folder), x (executable), f (file); or
// `-` when it is missing. GNU stat first: BSD stat rejects -c, while GNU stat -f prints
// file-system data (and succeeds), so the other order breaks on Linux.
export const STAT1_SCRIPT = 'p=$1; if [ ! -e "$p" ]; then echo -; exit 0; fi; ' +
  'if [ -d "$p" ]; then k=d; elif [ -x "$p" ]; then k=x; else k=f; fi; ' +
  'm=$(stat -c "%Y %s" -- "$p" 2>/dev/null || stat -f "%m %z" -- "$p" 2>/dev/null); echo "$k ${m:-0 0}"';

export function parseStat(line) {
  const [kind, mtime, size] = (line ?? "").trim().split(/\s+/);
  if (kind !== "d" && kind !== "x" && kind !== "f") return { kind: "-" };
  return { kind, mtime: Number(mtime) || 0, size: Number(size) || 0 };
}

// The first TEXT_BYTES of a file ($1); previewText says when the file was longer.
export const HEAD_SCRIPT = `head -c ${TEXT_BYTES} -- "$1"`;


// Puts an image for $1 at $3 (inside the cache folder $2), and removes the item's older
// images ($4 is the item id). $5 is "copy", or the thumbnail size; then the rest is the
// handler to ask (core/handlers.js chain: its command and args), run as
// `... path SRC thumbnail SIZE OUT` with OUT in a fresh folder of its own and stopped after
// THUMB_SECONDS (its pid only; the watchdog's output is closed so exec does not wait, and
// the shell's "Terminated" notice is kept out of the message).
// Exits 10 when the handler did not handle it, so the next one can be asked with the same
// arguments. Several copies of the mod may make the same image at once, so each works in
// its own hidden temporary folder and renames the result into place.
export const CACHE_SCRIPT = [
  'set -u; src=$1; dir=$2; out=$3; id=$4; how=$5; shift 5',
  'mkdir -p "$dir" && t=$(mktemp -d "$dir/.make.XXXXXX") || exit 1',
  's=0',
  'if [ -f "$out" ]; then :',
  'elif [ "$how" = copy ]; then cp "$src" "$t/copy" && mv "$t/copy" "$out"',
  'else mkdir "$t/h" || exit 1',
  '  "$@" path "$src" thumbnail "$how" "$t/h/thumb.png" >/dev/null 2>"$t/err" </dev/null & h=$!',
  `  ( sleep ${THUMB_SECONDS}; kill "$h" 2>/dev/null ) >/dev/null 2>&1 </dev/null & w=$!`,
  '  wait "$h" 2>/dev/null; s=$?; kill "$w" 2>/dev/null; wait "$w" 2>/dev/null',
  '  if [ $s = 0 ]; then [ -f "$t/h/thumb.png" ] && mv "$t/h/thumb.png" "$out"',
  '  elif [ $s = 10 ]; then rm -rf "$t"; exit 10',
  `  elif [ $s -gt 128 ] && [ ! -s "$t/err" ]; then echo "the handler took over ${THUMB_SECONDS} s" > "$t/err"; fi`,
  'fi',
  'if [ ! -f "$out" ]; then',
  '  if [ -s "$t/err" ]; then cat "$t/err" >&2; else echo "the handler made no thumbnail" >&2; fi',
  '  rm -rf "$t"; [ $s = 0 ] && exit 1; exit $s',
  'fi',
  'rm -rf "$t"',
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

// HTML for TextView.html, which draws the text and its structure but no CSS or scripts: the
// <body>'s content with comments and the elements that hold no text to read (scripts,
// styles, inline SVG, ...) left out, so their source does not show as text.
const NOT_TEXT = ["head", "script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "select"];
export function readableHtml(html) {
  let s = (html ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  for (const tag of NOT_TEXT) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, "gi"), "");
  }
  const body = /<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(s);
  return (body ? body[1] : s.replace(/<!doctype[^>]*>|<\/?html\b[^>]*>/gi, "")).trim();
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "\u2014", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
  times: "×", rarr: "→", larr: "←", uarr: "↑", darr: "↓", deg: "°", euro: "€", pound: "£" };
const BLOCK = "address|article|aside|blockquote|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|thead|tfoot|tr|ul";

// The text of HTML, as a person reads it: what search in the viewer looks through and
// shows. Blocks and <br> start lines, table cells are spaced apart, entities decoded,
// runs of spaces made one and blank lines at most one.
export function htmlText(html) {
  const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  const text = readableHtml(html)
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(new RegExp(`</?(?:${BLOCK})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/t[dh]\s*>/gi, "  ")
    .replace(/<[^>]*>/g, "");
  return decode(text)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// What `c` copies: the path, or the URL.
export const copyText = (item) => item.path ?? item.url;
