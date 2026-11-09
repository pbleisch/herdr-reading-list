#!/usr/bin/env node
// Merges the repo's keys.json into the person's Herdr keys.json: adds each key the person
// has not bound in that section, and never replaces one they use (Herdr's rule for a mod's
// keys, AGENTS.md "Layouts and mods other people made", step 4). Writes only when it adds.
//   node bin/merge-keys.mjs <repo keys.json> <person's keys.json>

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

// { merged, added: ["section key"], taken: ["section key -> their action"] }.
export function mergeKeys(person, mine) {
  const merged = structuredClone(person ?? {});
  const added = [], taken = [];
  for (const [section, keys] of Object.entries(mine ?? {})) {
    merged[section] ??= {};
    for (const [key, action] of Object.entries(keys)) {
      const theirs = merged[section][key];
      if (theirs === undefined) {
        merged[section][key] = action;
        added.push(`${section} ${key}`);
      } else if (JSON.stringify(theirs) !== JSON.stringify(action)) {
        taken.push(`${section} ${key} -> ${typeof theirs === "string" ? theirs : JSON.stringify(theirs)}`);
      }
    }
  }
  return { merged, added, taken };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    console.error("usage: node bin/merge-keys.mjs <repo keys.json> <person's keys.json>");
    process.exit(2);
  }
  const { merged, added, taken } = mergeKeys(JSON.parse(readFileSync(to, "utf8")), JSON.parse(readFileSync(from, "utf8")));
  for (const t of taken) console.error(`keys: ${t.split(" -> ")[0]} is already bound (${t.split(" -> ")[1]}); left as it is`);
  if (added.length) {
    writeFileSync(`${to}.tmp`, JSON.stringify(merged, null, 2) + "\n");
    renameSync(`${to}.tmp`, to);
    console.log(`keys: added ${added.join(", ")}`);
  }
}
