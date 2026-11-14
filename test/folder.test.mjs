import { test } from "node:test";
import assert from "node:assert/strict";
import { FOLDER_DEPTH, safePart, folderPath, folderFileId, folderItems } from "../mods/readlist/core/folder.js";
import { NO_FILTER, applyFilters, filterRows, textMatches } from "../mods/readlist/core/filters.js";

test("folder paths reject traversal and depth beyond the browsing limit", () => {
  assert.equal(folderPath("/root", ["sub", "a.txt"]), "/root/sub/a.txt");
  assert.equal(folderPath("/", ["sub"]), "/sub");
  for (const name of ["", ".", "..", "a/b", "a\\b", "a\nfile", "a\tfile"]) assert.equal(safePart(name), false);
  assert.equal(folderPath("/root", [".."]), null);
  assert.equal(folderPath("/root", Array(FOLDER_DEPTH + 1).fill("a")) !== null, true);
  assert.equal(folderPath("/root", Array(FOLDER_DEPTH + 2).fill("a")), null);
});

test("files with the same name in different subfolders have different cache ids", () => {
  const a = folderFileId("0123456789abcdef", "/root/a/file.pdf");
  const b = folderFileId("0123456789abcdef", "/root/b/file.pdf");
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});

test("folder rows use the list's space, agent, type, text and unread filters", () => {
  const root = { id: "0123456789abcdef", path: "/root", title: "Root", note: "root note",
    added_at: "2026-11-08T18:00:00Z", by: { space: "s1", terminal: null, from: "agent" } };
  const items = folderItems(root, [], [
    { name: "sub", dir: true }, { name: "plan.md", dir: false }, { name: "chart.png", dir: false },
  ]);
  assert.deepEqual(items.map((i) => i.path), ["/root/sub", "/root/plan.md", "/root/chart.png"]);
  assert.equal(items.every((i) => i.folderRoot === root.path), true);
  assert.equal(items.every((i) => i.done_at === null), true);
  assert.deepEqual(applyFilters(items, { ...NO_FILTER, type: "folder" }).map((i) => i.title), ["sub"]);
  assert.deepEqual(applyFilters(items, { ...NO_FILTER, type: "md", space: "s1", agent: "f:agent" }).map((i) => i.title), ["plan.md"]);
  assert.deepEqual(applyFilters(items, { ...NO_FILTER, text: "root chart" }).map((i) => i.title), ["chart.png"]);
  assert.equal(textMatches(items[1], "root note"), false, "the root note does not match every child");
  assert.deepEqual(filterRows(items.map((item, n) => ({ type: "item", item, read: n === 0 })), true)
    .map((r) => r.item.title), ["plan.md", "chart.png"]);
});
