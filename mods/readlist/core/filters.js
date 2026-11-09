// Filters: by space, by agent, by type, unread only, and the `/` box (title, note, path).
// Pure functions, shared by the mod and the node tests. See docs/design.md 4.2 and 4.3.

import { typeOf, itemKey } from "./items.js";
import { who, byAddress } from "./state.js";

export const NO_FILTER = Object.freeze({ space: null, agent: null, type: null, unread: false, text: "" });

export const TYPE_LABEL = {
  md: "Markdown", text: "Text", code: "Code", html: "HTML", image: "Images", pdf: "PDF",
  folder: "Folders", url: "Links", file: "Other files",
};

// The value an item has for a filter dimension. "" means none: no space recorded (an item
// from the inbox or cron), or no adder at all. Another machine's space and terminal ids
// carry its name (`devbox/sp1`), as Herdr's spaces() and agents() give them.
export function keyOf(item, dim, fsKind) {
  if (dim === "space") return item.by.space ? (item.machine ? `${item.machine}/${item.by.space}` : item.by.space) : "";
  if (dim === "agent") return item.by.terminal ? `t:${byAddress(item)}` : `f:${item.by.from ?? ""}`;
  if (dim === "type") return typeOf(item, fsKind);
  throw new Error(`unknown filter ${dim}`);
}

// Whether every word of the `/` box is in the item's title, note, path or URL (any case).
export function textMatches(item, text) {
  const words = (text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [item.title, item.note, item.path ?? item.url].filter(Boolean).join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

// The items a filter lets through. `fs` maps an item key to its STAT kind letter (for the type).
// The unread toggle is applied to rows (filterRows), since read is the state's business.
export function applyFilters(items, f, fs = {}) {
  return items.filter((i) =>
    (f.space === null || keyOf(i, "space") === f.space) &&
    (f.agent === null || keyOf(i, "agent") === f.agent) &&
    (f.type === null || keyOf(i, "type", i.path ? fs[itemKey(i)] : null) === f.type) &&
    textMatches(i, f.text));
}

// Rows from rowsFor with the unread toggle applied: read items and their header go.
export function filterRows(rows, unread) {
  return unread ? rows.filter((r) => r.type === "item" && !r.read) : rows;
}

export const isFiltered = (f) => f.space !== null || f.agent !== null || f.type !== null || f.unread || Boolean(f.text.trim());

// The choices for one dimension: [{ value, label, count }], most items first, then by
// name. `spaces` and `agents` are herdr's spaces() and agents(), for names. The chosen
// value stays listed (with 0) when no item has it any more, so it can be seen and cleared.
export function options(items, dim, { fs = {}, spaces = [], agents = [], chosen = null } = {}) {
  const seen = new Map();
  const newest = [...items].sort((a, b) => Date.parse(b.added_at) - Date.parse(a.added_at));
  for (const i of newest) {
    const value = keyOf(i, dim, i.path ? fs[itemKey(i)] : null);
    const had = seen.get(value);
    if (had) had.count++;
    else seen.set(value, { value, label: labelOf(i, dim, value, spaces, agents), count: 1 });
  }
  if (chosen !== null && !seen.has(chosen)) seen.set(chosen, { value: chosen, label: labelFor(dim, chosen, spaces), count: 0 });
  return [...seen.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function labelOf(item, dim, value, spaces, agents) {
  if (dim === "agent") return value === "f:" ? "Unknown" : who(item, agents).label;
  return labelFor(dim, value, spaces);
}

// A label from the value alone (an agent's falls back to its address or --from name).
export function labelFor(dim, value, spaces = []) {
  if (dim === "space") {
    if (value === "") return "No space";
    return spaces.find((s) => s.id === value)?.name ?? "Closed space";
  }
  if (dim === "type") return TYPE_LABEL[value] ?? value;
  if (value === "f:") return "Unknown";
  return value.slice(2);
}
