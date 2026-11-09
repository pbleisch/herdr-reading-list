// Arrival: which items are new since a copy last looked, which copy toasts them, and what
// the toast says. Pure functions, shared by the mod and the node tests. See docs/design.md 4.4.
//
// Every copy of the mod (the sidebar block, a pane, the popup) sees the same arrivals. Each
// claims them in shared("readlist.toasted"), a map of arrival key -> { by: copy, at: ms },
// adding only keys nobody holds. Copies may race and one write may replace another's, so a
// copy toasts only what the map still says is its own when its burst ends; a key nobody
// holds by then is claimed again.

import { NAME } from "./name.js";
import { who } from "./state.js";
import { itemKey } from "./items.js";

// Arrivals within this long of the first one collapse into one toast.
export const BURST_MS = 2500;
// Claims are kept this long (shared values persist, so the map is kept small).
export const CLAIM_MS = 3600000;
export const CLAIM_MAX = 200;
// A dropped file's id stays quiet (no toast: the person put it there) this long.
export const QUIET_MS = 60000;

// An arrival is an item (its key) at an added_at: a re-add is a new arrival.
export const arrivalKey = (item) => `${itemKey(item)}@${item.added_at}`;

// The items that arrived since the listing whose keys are `seen` (null on a copy's first
// listing, when nothing counts as new). Items added with --kind fyi are listed, never toasted.
export function arrivals(seen, items) {
  if (!seen) return [];
  return items.filter((i) => i.kind !== "fyi" && !seen.has(arrivalKey(i)));
}

const entries = (map) => (map && typeof map === "object" ? Object.entries(map) : []);

// The claim map with `keys` claimed by `copy` where nobody holds them, old claims dropped.
export function claim(map, keys, copy, nowMs) {
  const kept = entries(map)
    .filter(([, v]) => v && typeof v.at === "number" && typeof v.by === "string" && nowMs - v.at < CLAIM_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, CLAIM_MAX);
  const next = Object.fromEntries(kept);
  for (const k of keys) if (!next[k]) next[k] = { by: copy, at: nowMs };
  return next;
}

// Splits `keys` by who holds them in the claim map now.
export function owners(map, keys, copy) {
  const out = { mine: [], missing: [], theirs: [] };
  const m = map && typeof map === "object" ? map : {};
  for (const k of keys) {
    const by = m[k]?.by;
    if (by === copy) out.mine.push(k);
    else if (typeof by === "string") out.theirs.push(k);
    else out.missing.push(k);
  }
  return out;
}

// shared("readlist.quiet"): item key -> ms. Adds `ids` (keys) and drops old entries.
export function quiet(map, ids, nowMs) {
  const next = Object.fromEntries(entries(map).filter(([, at]) => typeof at === "number" && nowMs - at < QUIET_MS));
  for (const id of ids) next[id] = nowMs;
  return next;
}

export const quietIds = (map, nowMs) => new Set(entries(map).filter(([, at]) => typeof at === "number" && nowMs - at < QUIET_MS).map(([id]) => id));

// The toast for a burst of arrivals: one names the item and who added it, several collapse.
export function toastFor(items, agents) {
  if (items.length === 1) {
    const i = items[0];
    const by = who(i, agents).label;
    return { title: `Reading list: ${i.title}`, body: i.note ? `${by}: ${i.note}` : `Added by ${by}` };
  }
  const names = items.slice(0, 3).map((i) => i.title).join(", ");
  const more = items.length > 3 ? ` and ${items.length - 3} more` : "";
  return { title: `${items.length} new on your reading list`, body: names + more };
}

// What clicking the toast does: focus a reading-list pane if there is one (not `skip`, the
// viewer, which shows no list), else open the popup.
export function toastAction(panes, skip = null) {
  const pane = panes.find((p) => p.mod === NAME && p.pane !== skip);
  return pane ? { name: "pane.focus", args: { pane: pane.pane } } : { name: "mod.open", args: { name: NAME } };
}
