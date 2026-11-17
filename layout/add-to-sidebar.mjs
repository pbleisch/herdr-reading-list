// Puts the reading list in a layout's left sidebar, as a block right under the agents block,
// and the docked preview (`v`) as a hidden block right after the sidebar, full height.
//
//   node layout/add-to-sidebar.mjs ~/.config/herdr-app/layouts/<clone>.json
//
// Shipped layouts are read-only, so run it on a clone (`herdr-app do layout.clone`);
// bin/install-dev does both. Running it again changes nothing.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BLOCK = {
  id: "readlist",
  type: "block",
  size: { weight: 1 },
  min: 90,
  content: { mod: "readlist", props: { role: "sidebar" } },
};

// The docked preview: the reading list's built-in preview of the selected item, shown and
// hidden by `v` (layout.toggle) and resized by `[` / `]` (layout.resize).
export const VIEWER = {
  id: "readlist-viewer",
  type: "block",
  size: { px: 760 },
  min: 360,
  hidden: true,
  content: { mod: "readlist", props: { role: "viewer" } },
};

function findParent(node, id, parent = null) {
  if (node?.id === id) return parent;
  for (const child of node?.children ?? []) {
    const found = findParent(child, id, node);
    if (found) return found;
  }
  return null;
}

function hasMod(node, mod) {
  if (node?.content?.mod === mod) return true;
  return (node?.children ?? []).some((c) => hasMod(c, mod));
}

function hasId(node, id) {
  return node?.id === id || (node?.children ?? []).some((c) => hasId(c, id));
}

// The layout with the list block added after "agents" in its column and the docked preview
// after the "sidebar" node, each only when missing; the layout itself when nothing was. Throws
// when the list is missing and there is no agents block. Without a "sidebar" node in a row,
// there is no dock (`v` then splits a pane).
export function addToSidebar(layout) {
  const list = !hasMod(layout, "readlist");
  if (list && !findParent(layout, "agents")) throw new Error('no "agents" block in this layout');
  const copy = structuredClone(layout);
  let changed = false;
  if (list) {
    const column = findParent(copy, "agents");
    column.children.splice(column.children.findIndex((c) => c.id === "agents") + 1, 0, structuredClone(BLOCK));
    changed = true;
  }
  const row = hasId(copy, VIEWER.id) ? null : findParent(copy, "sidebar");
  if (row && row.type === "row") {
    row.children.splice(row.children.findIndex((c) => c.id === "sidebar") + 1, 0, structuredClone(VIEWER));
    changed = true;
  }
  return changed ? copy : layout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node layout/add-to-sidebar.mjs <layout.json>");
    process.exit(2);
  }
  const before = JSON.parse(readFileSync(file, "utf8"));
  const after = addToSidebar(before);
  if (after === before) {
    console.log(`${file} already shows the reading list`);
  } else {
    writeFileSync(`${file}.tmp`, JSON.stringify(after, null, 2) + "\n");
    renameSync(`${file}.tmp`, file);
    console.log(`added the reading list (and its docked preview) to ${file}`);
  }
}
