// Puts the reading list in a layout's left sidebar, as a block right under the agents block.
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

// The layout with the block added after "agents" in its column, or the layout itself
// when it already shows the reading list. Throws when there is no agents block.
export function addToSidebar(layout) {
  if (hasMod(layout, "readlist")) return layout;
  const copy = structuredClone(layout);
  const column = findParent(copy, "agents");
  if (!column) throw new Error('no "agents" block in this layout');
  const at = column.children.findIndex((c) => c.id === "agents");
  column.children.splice(at + 1, 0, structuredClone(BLOCK));
  return copy;
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
    console.log(`added the reading list under agents in ${file}`);
  }
}
