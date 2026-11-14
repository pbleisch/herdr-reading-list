// The viewer: `v` opens a preview-only reading-list pane on the right (props {role:
// "viewer"}) that shows whatever is selected in any copy, through shared("readlist.selected").
// `v` again closes it. Pure functions, shared by the mod and the node tests. See
// docs/design.md 4.2.
//
// shared("readlist.viewer") holds { pane } of the viewer the last `v` opened; it is only a
// hint: the pane is looked up in panes() each time, so a viewer closed by hand is noticed.

import { NAME } from "./name.js";
import { baseName } from "./paths.js";

// A transient file uses the list's renderer without becoming a list item. The prefix keeps
// its thumbnail cache separate from real item ids.
export function previewItem(file) {
  let hash = 0xcbf29ce484222325n;
  for (const char of file) hash = BigInt.asUintN(64, (hash ^ BigInt(char.codePointAt(0))) * 0x100000001b3n);
  return { id: `preview-${hash.toString(16).padStart(16, "0")}`, path: file, url: null,
    title: baseName(file), note: null, added_at: "1970-01-01T00:00:00Z" };
}

// A new split is only a handoff when a recorded preview pane is still open. It closes
// after updating the old pane's file, so repeated CLI calls keep the same pane id.
export function previewPanePlan(previous, panes, current) {
  const old = previous?.pane && panes.some((p) => p.pane === previous.pane && p.mod === NAME) ? previous.pane : null;
  return old && old !== current ? { keep: old, close: current } : { keep: current, close: null };
}

// The pane of the open viewer, or null.
export function viewerPane(viewer, panes) {
  const id = viewer && typeof viewer === "object" ? viewer.pane : null;
  return id && panes.some((p) => p.pane === id && p.mod === NAME) ? id : null;
}

// The pane a split made: a reading-list pane in `after` that was not in `before`.
export function newPane(before, after) {
  const had = new Set(before.map((p) => p.pane));
  return after.find((p) => p.mod === NAME && !had.has(p.pane))?.pane ?? null;
}

// shared("readlist.selected"): { id, at } of the item selected last in any copy.
export const selectedId = (sel) => (sel && typeof sel === "object" && typeof sel.id === "string" ? sel.id : null);

// shared("readlist.keyboard"): the copy that had the keyboard last ({ copy }). A
// `readlist.<command>` (keys.json, herdr-app do) reaches every shown copy; only that copy
// acts on it, or the sidebar's when that copy has closed. "focus" goes to whichever copy
// pane.go reached. `viewer` commands toggle once however many copies get them.
export function takesCommand(keyboard, copy, role, command) {
  if (command === "focus") return true;
  const owner = keyboard && typeof keyboard === "object" ? keyboard.copy : null;
  if (owner) return owner === copy;
  return role === "sidebar";
}

// The pane `v` splits to put the viewer on the window's right: the last pane of the tab
// (panes() lists a tab's panes in layout order), else the focused one.
export function splitTarget(panes, tab, focusedPane) {
  const here = panes.filter((p) => p.tab === tab);
  return here.at(-1)?.pane ?? focusedPane ?? null;
}
