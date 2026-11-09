// The viewer: `v` opens a preview-only reading-list pane on the right (props {role:
// "viewer"}) that shows whatever is selected in any copy, through shared("readlist.selected").
// `v` again closes it. Pure functions, shared by the mod and the node tests. See
// docs/design.md 4.2.
//
// shared("readlist.viewer") holds { pane } of the viewer the last `v` opened; it is only a
// hint: the pane is looked up in panes() each time, so a viewer closed by hand is noticed.

import { NAME } from "./name.js";

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
