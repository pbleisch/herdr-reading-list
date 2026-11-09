import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeItem } from "../mods/readlist/core/items.js";

const repo = new URL("..", import.meta.url).pathname;
const skill = readFileSync(join(repo, "skill/reading-list/SKILL.md"), "utf8");

test("the skill's zero-install item is one the mod and rl read", () => {
  const example = JSON.parse(skill.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.ok(normalizeItem(example), "the mod accepts the example");

  // Written by hand the way the skill says, for a real file: rl lists it, with rl's own id.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rl-skill-")));
  const file = join(home, "plan.md");
  writeFileSync(file, "# Plan\n");
  const id = execFileSync("sh", ["-c", 'printf "%s" "$1" | shasum -a 256 | cut -c1-16', "t", file], { encoding: "utf8" }).trim();
  const items = join(home, "list/items");
  mkdirSync(items, { recursive: true });
  writeFileSync(join(items, `.${id}.tmp`), JSON.stringify({ ...example, id, path: file, added_at: new Date().toISOString().slice(0, 19) + "Z" }));
  renameSync(join(items, `.${id}.tmp`), join(items, `${id}.json`));
  const env = { ...process.env, READING_LIST_DIR: join(home, "list") };
  delete env.HC_TERMINAL_ID;
  const rl = join(repo, "mods/readlist/bin/rl");
  assert.match(execFileSync(rl, ["ls"], { encoding: "utf8", env }), new RegExp(`^${id}  unread  review  Rollout plan  ${file}`));
  // rl add of the same file replaces the hand-written item.
  assert.equal(execFileSync(rl, ["add", file], { encoding: "utf8", env }).trim(), id);
  assert.equal(JSON.parse(readFileSync(join(items, `${id}.json`), "utf8")).adds, 2);
});
