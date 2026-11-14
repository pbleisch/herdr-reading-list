// State and path rules for browsing one folder item. Parts only come from a listing;
// none may escape the item's root. Symlinks are rejected by SAFE_PATH_SCRIPT too.
import { joinPath } from "./paths.js";

export const FOLDER_DEPTH = 12;
export const FOLDER_ENTRIES = 200;

export const safePart = (name) => typeof name === "string" && name.length > 0 && name !== "." && name !== ".."
  && !/[\/\\\r\n\t\0]/.test(name);

export function folderPath(root, parts = []) {
  // The extra part is a file within the deepest browsable folder.
  if (!parts.every(safePart) || parts.length > FOLDER_DEPTH + 1) return null;
  if (root === "/") return `/${parts.join("/")}`;
  return joinPath(root, ...parts);
}

// A separate cache id for every file, including same-named files in different subfolders.
export function folderFileId(id, path) {
  let a = 2166136261, b = 16777619;
  for (const c of `${id}\0${path}`) {
    const n = c.codePointAt(0);
    a = Math.imul(a ^ n, 16777619);
    b = Math.imul(b ^ n, 2246822519);
  }
  return [a, b].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

// The list treats a folder's children as items for its existing filters and actions.
// Their metadata comes from the containing list item; type and path come from the entry.
export function folderItems(root, parts, entries) {
  return entries.flatMap((entry) => {
    const path = folderPath(root.path, [...parts, entry.name]);
    return path ? [{ ...root, id: folderFileId(root.id, path), path, title: entry.name,
      note: null, done_at: null, folderRoot: root.path, folderKind: entry.dir ? "d" : "f" }] : [];
  });
}

// A folder's entries ($1), with hidden names when $2 is 1. Exclude symlinks and names
// that cannot be represented by the line protocol. Sort before applying the entry cap.
export const LIST_DIR_SCRIPT = [
  'dir=$1; hidden=${2:-0}; nl="\n"; tab="\t"',
  '{ for p in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do',
  '  [ -e "$p" ] || continue; [ -L "$p" ] && continue',
  '  name=${p##*/}; case $name in *"$nl"*|*"$tab"*) continue;; esac',
  '  case $name in .*) [ "$hidden" = 1 ] || continue;; esac',
  '  if [ -d "$p" ]; then printf "d\\t%s\\n" "$name"; else printf "f\\t%s\\n" "$name"; fi',
  `done; } | LC_ALL=C sort | head -n ${FOLDER_ENTRIES + 1}`,
].join("\n");

// Every browsed component must stay below the item's root and must not be a symlink.
export const SAFE_PATH_SCRIPT = [
  'root=$1; path=$2; [ -d "$root" ] && [ ! -L "$root" ] || exit 1',
  'if [ "$root" = / ]; then case $path in /*) ;; *) exit 1;; esac',
  'else case $path in "$root"|"$root"/*) ;; *) exit 1;; esac; fi',
  'rel=${path#"$root"}; rel=${rel#/}; cur=$root',
  'set -f; old=$IFS; IFS=/; set -- $rel; IFS=$old',
  'for part; do case $part in ""|.|..) exit 1;; esac; cur="$cur/$part"; [ -L "$cur" ] && exit 1; done',
  '[ -e "$path" ] || exit 1; printf "ok\\n"',
].join("\n");

export function parseFolder(stdout) {
  const lines = (stdout ?? "").split("\n").filter(Boolean);
  const entries = lines.slice(0, FOLDER_ENTRIES).flatMap((l) => {
    const m = /^([df])\t([^\t/\\\r\n]+)$/.exec(l);
    return m && m[2] !== "." && m[2] !== ".." ? [{ name: m[2], dir: m[1] === "d" }] : [];
  });
  return { entries, more: lines.length > FOLDER_ENTRIES };
}
