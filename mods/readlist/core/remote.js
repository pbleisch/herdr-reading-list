// Remote machines: listing another machine's reading list in one exec, the state of each
// machine (online, offline, its last listing), and fetching a local copy of a remote file
// into the cache. Pure functions and shell scripts, shared by the mod and the node tests.
// See docs/design.md 4.6.

import { parseListing, itemKey } from "./items.js";
import { RL_STATUS_SCRIPT, parseRlStatus } from "./install.js";

// How often each remote machine is listed while a copy of the mod is alive.
export const POLL_MS = 15000;
// A poll that takes longer than this counts as the machine not answering.
export const POLL_TIMEOUT_MS = 20000;
// The most bytes the base64 route fetches: base64 makes 4 characters of 3 bytes, plus a
// newline every 76, and exec keeps 8 MiB of output.
export const BASE64_MAX = 5 * 1024 * 1024;
// Above this, a fetch asks first.
export const ASK_BYTES = 50 * 1024 * 1024;
// `hc exec` keeps 8 MB of output: larger files come in chunks of this many MiB.
export const CHUNK_MIB = 7;
// A second Enter within this long fetches a file over ASK_BYTES.
export const ASK_MS = 15000;

// Between the poll's header and each item file, and after the last one.
export const RS = "\n\x1e\n";
const END = "end";

// Run on a remote machine with the paths of its items as arguments: one call lists the
// machine's reading list, says whether rl is there, and stats each path. Writes nothing.
//   dir<TAB>the list folder
//   rl<TAB>RL_STATUS_SCRIPT's line
//   one stat line per path: `k mtime size` (k: d folder, x executable, f file), or `-`
// then each item file after a record-separator line, and a last record "end" (so output
// cut short never looks like items were taken off).
export const POLL_SCRIPT = [
  'd=${READING_LIST_DIR:-$HOME/.local/state/reading-list}',
  '[ -d "$d" ] && d=$(cd "$d" && pwd -P)',
  'printf "dir\\t%s\\n" "$d"',
  'printf "rl\\t"',
  `(\n${RL_STATUS_SCRIPT}\n)`,
  'for p; do if [ -d "$p" ]; then k=d; elif [ -x "$p" ]; then k=x; elif [ -e "$p" ]; then k=f; else echo -; continue; fi',
  '  s=$(stat -c "%Y %s" -- "$p" 2>/dev/null || stat -f "%m %z" -- "$p" 2>/dev/null); echo "$k ${s:-0 0}"; done',
  'for f in "$d"/items/*.json; do [ -f "$f" ] || continue; printf "\\n\\036\\n"; cat "$f"; done',
  `printf "\\n\\036\\n${END}\\n"`,
].join("\n");

// One stat line (`k mtime size`, or `-`) as { kind, mtime, size }.
export function statLine(line) {
  const [kind, mtime, size] = (line ?? "").trim().split(/\s+/);
  if (kind !== "d" && kind !== "x" && kind !== "f") return { kind: "-", mtime: null, size: null };
  return { kind, mtime: Number(mtime) > 0 ? Number(mtime) : null, size: Number.isFinite(Number(size)) ? Number(size) : null };
}

// POLL_SCRIPT's output for `paths`: { ok, dir, rl, stats: path -> {kind, mtime, size}, items }.
// ok is false when the output is not a whole listing (cut short, or not this script's).
export function parsePoll(stdout, paths = []) {
  const parts = (stdout ?? "").split(RS);
  if (parts.length < 2 || parts.at(-1).trim() !== END) return { ok: false };
  const head = parts[0].split("\n");
  if (!head[0]?.startsWith("dir\t") || !head[1]?.startsWith("rl\t")) return { ok: false };
  const stats = {};
  paths.forEach((p, n) => { stats[p] = statLine(head[2 + n]); });
  const items = parseListing(parts.slice(1, -1).map((r) => "\x1e" + r).join(""));
  return { ok: true, dir: head[0].slice(4), rl: parseRlStatus(head[1].slice(3)), stats, items };
}

// Items listed on `machine` (null: this one), marked with it.
export const onMachine = (items, machine) => items.map((i) => ({ ...i, machine: machine ?? null }));

// ---- each remote machine's state ----
//
// { status, items, stats, dir, rl, ok_at, error }
//   status  "waiting" (not listed yet), "online" (the last poll answered), "offline", or
//           "unsupported" (it has no sh, so no rl and no list: Windows)
//   items   its items from the last poll that answered (kept while it is offline)
//   stats   path -> { kind, mtime, size } from that poll
//   ok_at   ms of that poll, null before one answered

export const NEW_MACHINE = Object.freeze({ status: "waiting", items: [], stats: {}, dir: null, rl: null, ok_at: null, error: null });

// exec's error when the machine has no `sh` (Windows): it has no list; it is not down.
export const noShell = (error) => /cannot start sh\b|program not found/i.test(error ?? "");

// The machine's state after a poll: `parsed` is parsePoll's result, or null when the exec
// failed (the machine did not answer); `error` says why.
export function afterPoll(prev, parsed, nowMs, error = null) {
  const was = prev ?? NEW_MACHINE;
  if (!parsed?.ok && noShell(error)) return { ...NEW_MACHINE, status: "unsupported", error };
  if (!parsed?.ok) return { ...was, status: "offline", error: error ?? "no answer" };
  return { status: "online", items: onMachine(parsed.items, null), stats: parsed.stats, dir: parsed.dir, rl: parsed.rl, ok_at: nowMs, error: null };
}

// The remote machines' states after machines() changed: machines no longer there are
// dropped, ones whose layout is unavailable are offline (their items kept), new ones wait
// for their first poll. A machine without sh is not polled again until it reconnects.
// Returns { remote, poll }: the new map and the machines to poll.
export function syncMachines(remote, list) {
  const next = new Map();
  const poll = [];
  for (const m of list ?? []) {
    if (!m?.name) continue;
    const was = remote.get(m.name) ?? NEW_MACHINE;
    if (m.layout === "unavailable") next.set(m.name, was.status === "offline" ? was : { ...was, status: "offline", error: "not connected" });
    else {
      next.set(m.name, was);
      if (m.layout === "ready" && was.status !== "unsupported") poll.push(m.name);
    }
  }
  return { remote: next, poll };
}

// The paths a machine's next poll stats: its items' paths, from the last listing.
export const pollPaths = (entry) => [...new Set((entry?.items ?? []).filter((i) => i.path).map((i) => i.path))];

// Paths in the listing the poll did not stat (new items): worth a second poll at once.
export const unstated = (entry) => pollPaths(entry).filter((p) => !entry.stats[p]);

// Every item: this machine's, then each remote machine's, marked with its machine; and
// the STAT kind and mtime of each, by item key.
export function mergeItems(local, localStats, remote) {
  const items = onMachine(local, null);
  const fs = {}, mt = {};
  for (const i of items) if (i.path) {
    fs[i.id] = localStats.fs[i.path];
    mt[i.id] = localStats.mt[i.path] ?? null;
  }
  for (const [name, e] of remote) {
    for (const raw of e.items) {
      const i = { ...raw, machine: name };
      items.push(i);
      if (!i.path) continue;
      const st = e.stats[i.path];
      if (st) {
        fs[itemKey(i)] = st.kind;
        mt[itemKey(i)] = st.mtime;
      }
    }
  }
  return { items, fs, mt };
}

// The machines whose listing this copy has (polled at least once): only their state.json
// entries may be pruned (core/state.js prune).
export const listedMachines = (remote) => new Set([...remote].filter(([, e]) => e.ok_at !== null).map(([n]) => n));

// The chip a remote row shows: "offline" while its machine does not answer.
export const isOffline = (remote, item) => Boolean(item.machine) && remote.get(item.machine)?.status === "offline";

// ---- local copies of remote files ----
//
// Under the mod's cache folder (hidden, so writing it does not reload the mod):
//   remote/<machine>/<id>/copy/<file name>   the copy (its own name, so `open` picks the app)
//   remote/<machine>/<id>/meta               {"mtime", "size", "at"} of the copy
//   remote/<machine>/<id>/thumbs/            images and thumbnails made from it

// A machine's name as one safe folder name.
export function safeName(name) {
  const s = String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return s === "" || s === "." || s === ".." ? `_${s}` : s;
}

// The folders and files of an item's copy, relative to the cache folder.
export function copyPaths(machine, id, path) {
  if (!/^[0-9a-f]{16}$/.test(id ?? "")) throw new Error(`not a list item: ${id}`);
  let name = (path ?? "").replace(/\/+$/, "").split("/").pop() || "file";
  if (name === "." || name === "..") name = "file";
  const dir = `remote/${safeName(machine)}/${id}`;
  return { dir, copy: `${dir}/copy/${name}`, meta: `${dir}/meta`, thumbs: `${dir}/thumbs` };
}

export function parseMeta(text) {
  try {
    const m = JSON.parse(text ?? "");
    return Number.isFinite(m?.mtime) && Number.isFinite(m?.size) && Number.isFinite(m?.at) ? { mtime: m.mtime, size: m.size, at: m.at } : null;
  } catch {
    return null;
  }
}

// Whether the copy (its meta) is out of date for the remote file's stat: no copy yet, or
// the file's mtime or size changed since it was fetched.
export const isStale = (meta, stat) => !meta || meta.mtime !== stat.mtime || meta.size !== stat.size;

// How to fetch a file of `size` bytes: "base64" through exec, else "chunks" (hc exec).
export const fetchRoute = (size) => (size <= BASE64_MAX ? "base64" : "chunks");

// Whether fetching needs the person's yes first.
export const needsAsk = (size) => size > ASK_BYTES;

const pad = (n) => String(n).padStart(2, "0");

// "copy from devbox, fetched 18:42" (local time; the day too when not today).
export function fetchedLabel(machine, atMs, nowMs = Date.now()) {
  const d = new Date(atMs);
  const now = new Date(nowMs);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const when = sameDay ? hm : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  return `copy from ${machine}, fetched ${when}`;
}

// "12.4 MiB"
export function sizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// Run on the remote machine: the file $1 as base64 text.
export const BASE64_SCRIPT = 'base64 < "$1"';

// Shared tail of the fetch scripts: checks the part file $t has $size bytes, moves it to
// $out and writes $meta. The meta's `at` is ms.
const FINISH = [
  'n=$(wc -c < "$t" | tr -d " ")',
  '[ "$n" = "$size" ] || { rm -f "$t"; echo "got $n of $size bytes" >&2; exit 1; }',
  'mv -f "$t" "$out" || exit 1',
  'printf \'{"mtime":%s,"size":%s,"at":%s000}\\n\' "$mtime" "$size" "$(date +%s)" > "$meta.$$" && mv -f "$meta.$$" "$meta"',
];

// Run here after the base64 text was written to $1: decodes it into $2 (the copy), checks
// it has $3 bytes, and writes the meta ($4 mtime, $5 meta file). Removes $1.
export const DECODE_SCRIPT = [
  'set -u; in=$1; out=$2; size=$3; mtime=$4; meta=$5',
  'mkdir -p "${out%/*}" || exit 1; t="$out.part.$$"',
  'base64 -d < "$in" > "$t"; ok=$?; rm -f "$in"',
  '[ $ok = 0 ] || { rm -f "$t"; echo "could not decode the copy" >&2; exit 1; }',
  ...FINISH,
].join("\n");

// Run here for a file over BASE64_MAX: $1 machine, $2 remote path, $3 the copy, $4 size,
// $5 mtime, $6 meta file, $7 the machine's ssh target (or ""). Fetches CHUNK_MIB at a time
// with `hc exec` (binary-safe, 8 MB of output per call); if that fails, with scp.
export const CHUNKS_SCRIPT = [
  'set -u; m=$1; src=$2; out=$3; size=$4; mtime=$5; meta=$6; target=$7',
  'mkdir -p "${out%/*}" || exit 1; t="$out.part.$$"; : > "$t" || exit 1',
  'i=0; ok=1',
  'while [ $((i * 1048576)) -lt "$size" ]; do',
  `  hc exec --on "$m" --timeout 600 -- sh -c 'dd if="$1" bs=1048576 skip="$2" count=${CHUNK_MIB} 2>/dev/null' rl "$src" "$i" >> "$t" 2>/dev/null || { ok=0; break; }`,
  `  i=$((i + ${CHUNK_MIB}))`,
  'done',
  'if [ $ok = 1 ] && [ "$(wc -c < "$t" | tr -d " ")" = "$size" ]; then :',
  'elif [ -n "$target" ] && scp -q -o BatchMode=yes -- "$target:$src" "$t" 2>/dev/null; then :',
  'else rm -f "$t"; echo "could not fetch it from $m" >&2; exit 1; fi',
  ...FINISH,
].join("\n");

// Removes the copies of `$1`'s items not listed any more ($2...: the ids kept).
export const PRUNE_COPIES_SCRIPT = [
  'dir=$1; shift; [ -d "$dir" ] || exit 0',
  'for d in "$dir"/*; do [ -d "$d" ] || continue; n=${d##*/}; keep=0',
  '  for id; do [ "$n" = "$id" ] && { keep=1; break; }; done',
  '  [ $keep = 1 ] || rm -rf "$d"',
  'done',
].join("\n");

// ---- rl on a remote machine ----

// The banner for a remote machine whose rl cannot be used there, or null:
// { machine, text, button } (button "install" or null). The first such machine shows,
// skipping those in `dismissed` (machine -> the state the person dismissed).
export function remoteBanner(remote, dismissed = {}) {
  for (const [name, e] of remote) {
    if (e.status !== "online" || !e.rl || dismissed[name] === e.rl.state) continue;
    if (e.rl.state === "missing") return { machine: name, text: `rl is not installed on ${name}, so agents there cannot add to this list.`, button: "install" };
    if (e.rl.state === "other") return { machine: name, text: `The rl on ${name}'s PATH (${e.rl.path}) is another program.`, button: "install" };
    if (e.rl.state === "offpath") return { machine: name, text: `On ${name}, rl is in ~/.local/bin, which is not on PATH there.`, button: null };
  }
  return null;
}
