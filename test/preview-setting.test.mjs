import test from "node:test";
import assert from "node:assert/strict";
import { previewMode, withPreviewMode } from "../mods/readlist/core/preview-setting.js";

test("Space preview defaults to the built-in viewer and reads the system choice", () => {
  assert.equal(previewMode(null), "builtin");
  assert.equal(previewMode("{}"), "builtin");
  assert.equal(previewMode('{"readlist":{"space_preview":"system"}}'), "system");
  assert.equal(previewMode('{"readlist":{"space_preview":"other"}}'), "builtin");
});

test("saving the Space choice preserves other Herdr and Reading list settings", () => {
  const before = '{"zoom":1.25,"sounds":{"enabled":false},"readlist":{"other":"kept"}}';
  const system = withPreviewMode(before, "system");
  assert.deepEqual(JSON.parse(system), {
    zoom: 1.25, sounds: { enabled: false }, readlist: { other: "kept", space_preview: "system" },
  });
  assert.equal(previewMode(system), "system");
  assert.equal(previewMode(withPreviewMode(system, "builtin")), "builtin");
  assert.throws(() => withPreviewMode("not JSON", "system"));
  assert.throws(() => withPreviewMode("{}", "invalid"));
});
