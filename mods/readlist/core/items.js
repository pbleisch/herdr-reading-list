// Item files: parsing what the folder holds, what type an item is, and how Enter opens it.
// Pure functions, shared by the mod and the node tests. See docs/design.md 3.2 and 4.5.

import { LINUX_RUNS, WINDOWS_RUNS } from "./platform.js";
import { isAbsPath, isWinPath, baseName, joinPath } from "./paths.js";

const ID = /^[0-9a-f]{16}$/;
const KINDS = new Set(["review", "fyi", "result"]);

// The listing the mod reads in one exec: each item file's text after a \x1e.
export const LIST_SCRIPT = 'for f in "$1"/*.json; do [ -f "$f" ] || continue; printf "\\036"; cat "$f"; done';

// For each path argument, one line: d (folder), x (executable file), f (file), - (missing).
// (Windows: bin/windows/readlist.ps1 `stat`, `stats` and `list` stand for these three.)
export const STAT_SCRIPT = 'for p; do if [ -d "$p" ]; then echo d; elif [ -x "$p" ]; then echo x; elif [ -e "$p" ]; then echo f; else echo -; fi; done';

// STAT_SCRIPT's letter and the mtime (epoch seconds, 0 if unknown) for each path argument,
// one `k mtime` line each, or `-`. GNU stat first: BSD stat rejects -c, while GNU stat -f
// prints file-system data.
export const STATS_SCRIPT = 'for p; do if [ -d "$p" ]; then k=d; elif [ -x "$p" ]; then k=x; elif [ -e "$p" ]; then k=f; else echo -; continue; fi; ' +
  'm=$(stat -c %Y -- "$p" 2>/dev/null || stat -f %m -- "$p" 2>/dev/null); echo "$k ${m:-0}"; done';

// STATS_SCRIPT's output for `paths`: { fs: path -> letter, mt: path -> mtime or null }.
export function parseStats(stdout, paths) {
  const lines = (stdout ?? "").split("\n");
  const fs = {}, mt = {};
  paths.forEach((p, n) => {
    const [k, m] = (lines[n] ?? "").trim().split(/\s+/);
    fs[p] = k === "d" || k === "x" || k === "f" ? k : "-";
    mt[p] = fs[p] !== "-" && Number(m) > 0 ? Number(m) : null;
  });
  return { fs, mt };
}

// The file an item lives in, as rl writes it; throws on anything that isn't a list id, so a
// delete can only ever remove items/<16 hex>.json under the list folder (items\<16 hex>.json
// on Windows).
export function itemFile(dir, id) {
  if (!isAbsPath(dir) || !ID.test(id)) throw new Error(`not a list item: ${id}`);
  return isWinPath(dir) ? joinPath(dir, `items/${id}.json`) : `${dir.replace(/\/+$/, "")}/items/${id}.json`;
}

const str = (v) => (typeof v === "string" ? v : null);
const time = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

// One item from its parsed JSON, or null if it isn't a v1 item. Unknown fields are dropped.
// Its path is absolute in either form: /... (macOS, Linux) or C:\... (Windows).
export function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== 1 || !ID.test(raw.id ?? "")) return null;
  const path = str(raw.path);
  const url = str(raw.url);
  if (path ? !isAbsPath(path) : !(url && /^https?:\/\/[^/\s]+/i.test(url))) return null;
  const added = time(raw.added_at);
  if (!added) return null;
  const by = raw.by && typeof raw.by === "object" ? raw.by : {};
  const base = path ? baseName(path) || path : url.replace(/^https?:\/\//i, "");
  return {
    id: raw.id,
    path: path || null,
    url: path ? null : url,
    title: str(raw.title)?.trim() || base,
    note: str(raw.note)?.trim() || null,
    kind: KINDS.has(raw.kind) ? raw.kind : "review",
    added_at: added,
    adds: Number.isInteger(raw.adds) && raw.adds > 0 ? raw.adds : 1,
    by: {
      terminal: str(by.terminal),
      app: str(by.app),
      name: str(by.name),
      space: str(by.space),
      tab: str(by.tab),
      cwd: str(by.cwd),
      from: str(by.from),
    },
    size: Number.isFinite(raw.size) ? raw.size : null,
    mtime: time(raw.mtime),
    done_at: time(raw.done_at),
  };
}

// The key an item has in state.json and everywhere the mod tells items apart: the id for
// this machine's, `<machine>/<id>` for another machine's (the address form Herdr uses).
export const itemKey = (item) => (item.machine ? `${item.machine}/${item.id}` : item.id);

// Items from LIST_SCRIPT's output. Broken or foreign files are skipped; if two files
// claim one id, the later-added wins.
export function parseListing(stdout) {
  const byId = new Map();
  for (const chunk of (stdout ?? "").split("\x1e")) {
    if (!chunk.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(chunk);
    } catch {
      continue;
    }
    const item = normalizeItem(raw);
    if (!item) continue;
    const had = byId.get(item.id);
    if (!had || Date.parse(item.added_at) >= Date.parse(had.added_at)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

const ext = (path) => {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

const TYPES = {
  md: ["md", "markdown", "mdown", "mkd"],
  image: ["png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "heif", "tif", "tiff", "bmp", "psd", "avif"],
  html: ["html", "htm", "xhtml"],
  pdf: ["pdf"],
  code: ["js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "jsonc", "yaml", "yml", "toml", "rs", "go", "py", "rb", "c", "h", "cc", "cpp", "hpp", "java", "kt", "swift", "sh", "zsh", "bash", "css", "scss", "sql", "lua", "zig", "xml"],
  text: ["txt", "log", "csv", "tsv", "rst", "org", "adoc", "diff", "patch"],
};
const TYPE_OF = new Map(Object.entries(TYPES).flatMap(([t, exts]) => exts.map((e) => [e, t])));

// What the row's icon shows: md, image, html, pdf, code, text, folder, url or file.
// `fsKind` is the STAT_SCRIPT letter when known.
export function typeOf(item, fsKind) {
  if (item.url) return "url";
  if (fsKind === "d") return "folder";
  return TYPE_OF.get(ext(item.path)) ?? "file";
}

// Types macOS would run or install rather than show when opened (docs/design.md 8).
const RUNS = new Set([
  "app", "command", "tool", "terminal", "workflow", "action", "pkg", "mpkg", "dmg", "jar",
  "scpt", "scptd", "applescript", "osax", "prefpane", "saver", "kext", "plugin", "bundle",
  "framework", "xpc", "appex", "webloc", "inetloc", "fileloc", "afploc", "ftploc", "url",
  "mobileconfig", "configprofile", "sh", "bash", "zsh", "csh", "tcsh", "ksh", "fish", "py",
  "pyw", "rb", "pl", "php", "lua", "tcl", "ps1", "bat", "cmd", "exe", "msi", "vbs", "scr",
]);

// How Enter opens an item: { how: "url" | "open" | "reveal" | "missing", target }.
// Executable files, folders with an extension (bundles such as .app) and the types in
// RUNS (on Linux also LINUX_RUNS, on Windows WINDOWS_RUNS) are revealed in the file manager
// instead of opened, so the list never launches anything.
export function openAction(item, fsKind, platform = "macos") {
  if (item.url) return { how: "url", target: item.url };
  if (fsKind === "-" || !fsKind) return { how: "missing", target: item.path };
  if (fsKind === "x") return { how: "reveal", target: item.path };
  const e = ext(item.path);
  if (fsKind === "d") return { how: e ? "reveal" : "open", target: item.path };
  const runs = RUNS.has(e) || (platform === "linux" && LINUX_RUNS.has(e)) || (platform === "windows" && WINDOWS_RUNS.has(e));
  return { how: runs ? "reveal" : "open", target: item.path };
}
