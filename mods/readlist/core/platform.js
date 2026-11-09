// What differs between the platforms Herdr runs on: how a file is opened, shown in the file
// manager and quick-previewed, whether the pane gets thumbnails, and the words for it.
// macOS uses `open`, `open -R` and Quick Look (`qlmanage`); Linux uses `xdg-open`, the
// freedesktop FileManager1 D-Bus call and GNOME Sushi, each optional with a fallback or a clear
// message. Windows is not supported yet. Pure functions and constants, shared by the mod and
// the node tests. See docs/design.md 4.5.

// The platform from Herdr's window() (`linux`, `macos` or `windows`). Anything else is taken
// as macOS, which is what the mod did before it knew about other platforms.
export function platformOf(win) {
  const p = win?.platform;
  return p === "linux" || p === "windows" ? p : "macos";
}

// The words that name the platform's things in toasts and the pane.
const WORDS = {
  macos: { files: "Finder", here: "this Mac", look: "Quick Look" },
  linux: { files: "the file manager", here: "this computer", look: "the quick preview" },
  windows: { files: "Explorer", here: "this computer", look: "the quick preview" },
};
export const words = (platform) => WORDS[platform] ?? WORDS.macos;

// File types Linux desktops run or install rather than show when opened, on top of the ones
// in core/items.js RUNS (docs/design.md 8).
export const LINUX_RUNS = new Set(["desktop", "appimage", "run", "bin", "deb", "rpm", "snap", "flatpak", "flatpakref", "flatpakrepo"]);

// A file:// URI for an absolute path, every byte that is not unreserved percent-encoded, so
// it also goes inside a D-Bus string literal ('...') as it is.
export function fileUri(path) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `file://${path.split("/").map(enc).join("/")}`;
}

// The folder a path is in ("/" for a top-level one).
export function parentOf(path) {
  const p = path.replace(/\/+$/, "");
  const at = p.lastIndexOf("/");
  return at > 0 ? p.slice(0, at) : "/";
}

// Exit code of the Linux scripts when a program they need is not installed; their stderr
// then says which one.
export const MISSING = 127;

// Runs xdg-open "$1" in the background and waits up to 3 s for it: a desktop's opener may
// stay running as long as the app it started, which would outlive exec's 30 s limit. Exits
// with xdg-open's status (and its message) when it finished within that time, else 0.
// stderr goes through a file so exec does not wait on a pipe the opener keeps open.
export const XDG_OPEN_SCRIPT = [
  'command -v xdg-open >/dev/null 2>&1 || { echo "xdg-open is not installed (it comes with xdg-utils)" >&2; exit 127; }',
  'e=$(mktemp) || exit 1',
  'xdg-open "$1" >/dev/null 2>"$e" </dev/null & p=$!',
  'n=0; while kill -0 "$p" 2>/dev/null && [ $n -lt 30 ]; do sleep 0.1; n=$((n + 1)); done',
  'if kill -0 "$p" 2>/dev/null; then rm -f "$e"; exit 0; fi',
  'wait "$p"; s=$?',
  'if [ -s "$e" ]; then cat "$e" >&2; elif [ $s = 3 ]; then echo "xdg-open found no program to open it with" >&2; fi',
  'rm -f "$e"; exit $s',
].join("\n");

// Shows $1 selected in the file manager: the freedesktop FileManager1 ShowItems call ($2 is
// the D-Bus array of its URI), else xdg-open on its folder ($3). The call needs gdbus and a
// file manager that answers it (Nautilus, Dolphin, Nemo, Caja, Thunar...).
export const REVEAL_SCRIPT = [
  'if command -v gdbus >/dev/null 2>&1 && gdbus call --session --timeout 5 --dest org.freedesktop.FileManager1 \\',
  '  --object-path /org/freedesktop/FileManager1 --method org.freedesktop.FileManager1.ShowItems "$2" "\'\'" >/dev/null 2>&1; then exit 0; fi',
  'command -v xdg-open >/dev/null 2>&1 || { echo "no file manager answered, and xdg-open is not installed (it comes with xdg-utils)" >&2; exit 127; }',
  'e=$(mktemp) || exit 1',
  'xdg-open "$3" >/dev/null 2>"$e" </dev/null & p=$!',
  'n=0; while kill -0 "$p" 2>/dev/null && [ $n -lt 30 ]; do sleep 0.1; n=$((n + 1)); done',
  'if kill -0 "$p" 2>/dev/null; then rm -f "$e"; exit 0; fi',
  'wait "$p"; s=$?; cat "$e" >&2; rm -f "$e"; exit $s',
].join("\n");

// GNOME Sushi (Nautilus's previewer, started by D-Bus on demand) shows $1, a D-Bus string of
// the file's URI; $2 is "true" to close it instead when it is already showing. Tries the
// current interface, then the older one. Prints `no-gdbus` or `no-sushi` (exit 127) when
// there is no previewer.
export const SUSHI_SCRIPT = [
  'command -v gdbus >/dev/null 2>&1 || { echo no-gdbus; exit 127; }',
  'call() { gdbus call --session --timeout 5 --dest org.gnome.NautilusPreviewer --object-path /org/gnome/NautilusPreviewer --method "$@" >/dev/null 2>&1; }',
  'call org.gnome.NautilusPreviewer2.ShowFile "$1" "\'\'" "$2" && exit 0',
  'call org.gnome.NautilusPreviewer.ShowFile "$1" 0 "$2" && exit 0',
  'echo no-sushi; exit 127',
].join("\n");

// The exec call that opens (how "open") or reveals (how "reveal") a file, or null where the
// platform has none. macOS: `open` and `open -R`, the path as one argument.
export function openCommand(platform, how, path) {
  if (platform === "macos") return { command: "open", args: how === "reveal" ? ["-R", path] : [path] };
  if (platform !== "linux") return null;
  if (how === "reveal") return { command: "sh", args: ["-c", REVEAL_SCRIPT, "readlist", path, `['${fileUri(path)}']`, parentOf(path)] };
  return { command: "sh", args: ["-c", XDG_OPEN_SCRIPT, "readlist", path] };
}

// The exec call that shows (or, `close`, toggles off) the quick preview of a file on Linux.
export function sushiCommand(path, close) {
  return { command: "sh", args: ["-c", SUSHI_SCRIPT, "readlist", `'${fileUri(path)}'`, close ? "true" : "false"] };
}

// Space on a platform without a quick preview: why, in one line, for the toast.
export function noQuickLook(platform, reason) {
  if (platform !== "linux") return "There is no quick preview on this platform yet; the preview here shows the file.";
  if (reason === "no-gdbus") return "Space's preview window needs gdbus and GNOME Sushi; showing the preview here instead.";
  return "Space's preview window needs GNOME Sushi (the sushi package); showing the preview here instead.";
}

// What Space does: "qlmanage" (macOS Quick Look), "sushi" (Linux, until it turns out to be
// missing), or "pane" (show the in-pane preview).
export function quickLook(platform, sushiMissing) {
  if (platform === "macos") return "qlmanage";
  if (platform === "linux" && !sushiMissing) return "sushi";
  return "pane";
}

// Whether the pane makes thumbnails (Quick Look). Elsewhere a file with no drawn preview
// shows its type's icon.
export const thumbnails = (platform) => platform === "macos";
