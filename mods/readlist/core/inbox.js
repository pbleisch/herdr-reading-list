// The drop folder (inbox/ next to items/): anything put there becomes an item, added with
// rl as from "inbox"; files dropped onto the pane are added the same way, from "dropped".
// Pure functions and scripts, shared by the mod and the node tests. See docs/design.md 3.5.
//
// state.json's "inbox" maps each entry's name to the mtime it was added at, so an entry is
// added once (again only when it is replaced), a deleted item does not come back while its
// file stays, and copies of the mod agree through state.json's compare-and-swap: only the
// copy whose write recorded an entry runs rl for it.

// Entries in $1, each `mtime<TAB>name` and a NUL. Hidden names are left out; so are
// symlinks to nothing.
export const INBOX_SCRIPT = 'cd -- "$1" 2>/dev/null || exit 0; for f in *; do [ -e "$f" ] || continue; ' +
  'm=$(stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f" 2>/dev/null); printf "%s\\t%s\\0" "${m:-0}" "$f"; done';

// Runs `rl add --from $2` on each further argument, with the rl at $1 (the copy inside
// the mod, so the drop folder works before rl is installed); prints each new id, one per
// line. The app's environment is not an hc terminal, so the adder is the --from name.
export const ADD_SCRIPT = [
  "unset HC_TERMINAL_ID",
  'rl=$1; from=$2; shift 2; st=0',
  '[ -f "$rl" ] || { echo "the mod\'s rl is missing: $rl" >&2; exit 127; }',
  'for p; do if out=$(sh "$rl" add --from "$from" -- "$p" 2>&1); then printf "%s\\n" "$out"; else printf "%s\\n" "$out" >&2; st=1; fi; done',
  "exit $st",
].join("\n");

// Downloads still being written, by their browsers' temporary names.
const PARTIAL = /\.(crdownload|part|partial|download|opdownload|tmp)$/i;
// An entry this new (seconds) may still be being written: wait for it to settle.
export const SETTLE_S = 1;

export function parseInbox(stdout) {
  const out = [];
  for (const rec of (stdout ?? "").split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 1) continue;
    const name = rec.slice(tab + 1);
    if (!name || name.startsWith(".") || name.includes("/") || PARTIAL.test(name)) continue;
    out.push({ name, mtime: Number(rec.slice(0, tab)) || 0 });
  }
  return out;
}

// What to do about the inbox's `entries` given state.json's record of them:
// { todo: entries to add now, wait: some entry is still settling, inbox: the record to
// write, changed: whether it differs from `handled` }.
export function inboxPlan(entries, handled, nowS) {
  const had = handled && typeof handled === "object" ? handled : {};
  const todo = [];
  let wait = false;
  const inbox = {};
  for (const e of entries) {
    if (had[e.name] === e.mtime) inbox[e.name] = e.mtime;
    else if (nowS - e.mtime < SETTLE_S) {
      wait = true;
      if (e.name in had) inbox[e.name] = had[e.name];
    } else {
      todo.push(e);
      inbox[e.name] = e.mtime;
    }
  }
  const changed = Object.keys(inbox).length !== Object.keys(had).length || Object.entries(inbox).some(([k, v]) => had[k] !== v);
  return { todo, wait, inbox, changed };
}
