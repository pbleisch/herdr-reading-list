// The person's read and done state (state.json, written by the mod only), and the
// rows the list shows. Pure functions, shared by the mod and the node tests.
// See docs/design.md 4.3.
//
// state.json: { "v": 1, "items": { "<key>": { "read_at"?, "done_at"?, "undone_at"?, "seen_mtime"? } },
//               "inbox"?: { "<name>": mtime }, "claude_files"?: { ... } }
// An item is read when read_at is at or after its added_at (re-adding makes it unread
// again). It is done when the latest done mark - the item's own done_at (rl done) or
// the state's - is at or after both added_at and the state's undone_at. The mod sets
// done_at or undone_at and clears the other, so the latest action wins. seen_mtime is the
// file's mtime (epoch seconds) when it was read, so a row can say "changed" after that.
// "inbox" is the drop folder's record (core/inbox.js), "claude_files" the setting and record
// of the files Claude Code agents sent (core/sent.js). An item's key is its id, or
// `<machine>/<id>` for another machine's item (core/items.js itemKey).

import { itemKey } from "./items.js";
import { parseSent } from "./sent.js";

const ms = (t) => (t ? Date.parse(t) : NaN);
const at = (t) => (Number.isNaN(ms(t)) ? -Infinity : ms(t));

export function parseState(text) {
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const items = raw && raw.v === 1 && raw.items && typeof raw.items === "object" ? raw.items : {};
  const clean = {};
  for (const [key, e] of Object.entries(items)) {
    if (!e || typeof e !== "object") continue;
    const entry = {};
    for (const f of ["read_at", "done_at", "undone_at"]) if (typeof e[f] === "string" && !Number.isNaN(ms(e[f]))) entry[f] = e[f];
    if (Number.isFinite(e.seen_mtime)) entry.seen_mtime = e.seen_mtime;
    clean[key] = entry;
  }
  const state = { v: 1, items: clean };
  const inbox = raw && raw.v === 1 && raw.inbox && typeof raw.inbox === "object" ? raw.inbox : null;
  if (inbox) {
    const kept = Object.fromEntries(Object.entries(inbox).filter(([, m]) => Number.isFinite(m)));
    if (Object.keys(kept).length) state.inbox = kept;
  }
  if (raw && raw.v === 1 && raw.claude_files) state.claude_files = parseSent(raw.claude_files);
  return state;
}

// The state with the drop folder's record replaced (an empty record is left out).
export function withInbox(state, inbox) {
  const next = { ...state };
  if (Object.keys(inbox).length) next.inbox = inbox;
  else delete next.inbox;
  return next;
}

export const serializeState = (state) => JSON.stringify(state, null, 2) + "\n";

export function isRead(item, state) {
  const e = state.items[itemKey(item)];
  return Boolean(e?.read_at) && at(e.read_at) >= at(item.added_at);
}

export function isDone(item, state) {
  const e = state.items[itemKey(item)] ?? {};
  const done = Math.max(at(item.done_at), at(e.done_at));
  return done > -Infinity && done >= at(item.added_at) && done >= at(e.undone_at);
}

// Read, and the file changed (its mtime now, epoch seconds) since it was read.
export function isChanged(item, state, mtime) {
  const seen = state.items[itemKey(item)]?.seen_mtime;
  return Number.isFinite(seen) && Number.isFinite(mtime) && mtime > 0 && mtime !== seen && isRead(item, state);
}

// The next state after an action on one item (its key): "read", "unread", "done" or "undone".
// `mtime` is the file's mtime when read (epoch seconds), if known. The input state is
// not changed.
export function applyAction(state, id, action, now, mtime) {
  const entry = { ...(state.items[id] ?? {}) };
  if (action === "read") {
    entry.read_at = now;
    if (Number.isFinite(mtime) && mtime > 0) entry.seen_mtime = mtime;
    else delete entry.seen_mtime;
  } else if (action === "unread") {
    delete entry.read_at;
    delete entry.seen_mtime;
  } else if (action === "done") {
    entry.done_at = now;
    delete entry.undone_at;
  } else if (action === "undone") {
    entry.undone_at = now;
    delete entry.done_at;
  } else throw new Error(`unknown action ${action}`);
  return { ...state, items: { ...state.items, [id]: entry } };
}

// Drops entries for items no longer on the list (rl rm) whose last mark is older than
// keepMs, so state.json doesn't grow forever. `keys` are the items listed now; another
// machine's entries are only dropped when that machine is in `machines` (its listing is
// known), so an offline machine's items keep their state.
export function prune(state, keys, nowMs, keepMs = 30 * 86400000, machines = new Set()) {
  const listed = new Set(keys);
  let changed = false;
  const items = {};
  for (const [id, e] of Object.entries(state.items)) {
    const last = Math.max(at(e.read_at), at(e.done_at), at(e.undone_at));
    const slash = id.lastIndexOf("/");
    const known = slash < 0 || machines.has(id.slice(0, slash));
    if (known && !listed.has(id) && nowMs - last > keepMs) {
      changed = true;
      continue;
    }
    items[id] = e;
  }
  return changed ? { ...state, items } : state;
}

// The rows to draw for a view ("list" or "done"): { type: "head", label, count } and
// { type: "item", item, read }. The list puts unread items first and read ones under a
// "Read" header, newest first in each; the done view lists done items, latest done first.
export function rowsFor(items, state, view) {
  const newest = (a, b) => at(b.added_at) - at(a.added_at) || itemKey(a).localeCompare(itemKey(b));
  if (view === "done") {
    const doneAt = (i) => Math.max(at(i.done_at), at(state.items[itemKey(i)]?.done_at));
    const done = items.filter((i) => isDone(i, state)).sort((a, b) => doneAt(b) - doneAt(a) || newest(a, b));
    return done.map((item) => ({ type: "item", item, read: true }));
  }
  const open = items.filter((i) => !isDone(i, state));
  const unread = open.filter((i) => !isRead(i, state)).sort(newest);
  const read = open.filter((i) => isRead(i, state)).sort(newest);
  const rows = unread.map((item) => ({ type: "item", item, read: false }));
  if (read.length) {
    if (unread.length) rows.push({ type: "head", label: "Read", count: read.length });
    for (const item of read) rows.push({ type: "item", item, read: true });
  }
  return rows;
}

export function counts(items, state) {
  let unread = 0, open = 0, done = 0;
  for (const i of items) {
    if (isDone(i, state)) done++;
    else {
      open++;
      if (!isRead(i, state)) unread++;
    }
  }
  return { unread, open, done };
}

// "now", "5m", "3h", "2d", "6w" since an ISO time.
export function ago(iso, nowMs) {
  const m = Math.floor((nowMs - at(iso)) / 60000);
  if (!(m >= 1)) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

// The address of the terminal that added an item, as Herdr shows it: `t7` here,
// `devbox/t7` on another machine. Null when no terminal added it.
export const byAddress = (item) => (item.by.terminal ? (item.machine ? `${item.machine}/${item.by.terminal}` : item.by.terminal) : null);

// Who added an item, for the row: the live agent's program and address when its terminal
// is still an agent (`agents` as herdr's agents() gives them), else what the file recorded.
export function who(item, agents) {
  const by = item.by;
  const address = byAddress(item);
  if (address) {
    const live = agents.find((a) => a.address === address);
    if (live) return { label: `${live.program?.name ?? by.app ?? "agent"} ${address}`, status: live.status, live: true };
    const name = by.app === "claude-code" ? "Claude Code" : by.app ?? by.name ?? "terminal";
    return { label: `${name} ${address} (ended)`, status: null, live: false };
  }
  return { label: by.from ?? "unknown", status: null, live: false };
}
