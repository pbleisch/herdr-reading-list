import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeItem, openAction } from "../mods/readlist/core/items.js";
import { previewKind, noThumb } from "../mods/readlist/core/preview.js";
import {
  MISSING, XDG_OPEN_SCRIPT, REVEAL_SCRIPT, SUSHI_SCRIPT, LINUX_RUNS,
  platformOf, words, fileUri, parentOf, openCommand, sushiCommand, quickLook, noQuickLook, thumbnails,
} from "../mods/readlist/core/platform.js";

const item = (over = {}) => normalizeItem({
  v: 1, id: "0123456789abcdef", path: "/tmp/plan.md", url: null, title: "plan.md", note: null,
  kind: "review", added_at: "2026-11-08T18:00:00Z", adds: 1, by: {}, done_at: null, ...over,
});

// ---- choosing per platform ----

test("platformOf reads Herdr's window().platform, macOS when unknown", () => {
  assert.equal(platformOf({ platform: "linux" }), "linux");
  assert.equal(platformOf({ platform: "windows" }), "windows");
  assert.equal(platformOf({ platform: "macos" }), "macos");
  assert.equal(platformOf({}), "macos");
  assert.equal(platformOf(undefined), "macos");
});

test("words keep macOS's names and name Linux's", () => {
  assert.deepEqual(words("macos"), { files: "Finder", here: "this Mac", look: "Quick Look" });
  assert.equal(words("linux").files, "the file manager");
  assert.equal(words("linux").here, "this computer");
  assert.equal(words("nope").files, "Finder");
});

test("openCommand: macOS runs open exactly as before", () => {
  assert.deepEqual(openCommand("macos", "open", "/a/b c.md"), { command: "open", args: ["/a/b c.md"] });
  assert.deepEqual(openCommand("macos", "reveal", "/a/b c.md"), { command: "open", args: ["-R", "/a/b c.md"] });
});

test("openCommand: Linux opens with xdg-open and reveals through the file manager", () => {
  assert.deepEqual(openCommand("linux", "open", "/a/b c.md"), { command: "sh", args: ["-c", XDG_OPEN_SCRIPT, "readlist", "/a/b c.md"] });
  assert.deepEqual(openCommand("linux", "reveal", "/a/it's.md"),
    { command: "sh", args: ["-c", REVEAL_SCRIPT, "readlist", "/a/it's.md", "['file:///a/it%27s.md']", "/a"] });
});

test("openCommand: Windows has none yet", () => {
  assert.equal(openCommand("windows", "open", "/a"), null);
  assert.equal(openCommand("windows", "reveal", "/a"), null);
});

test("fileUri percent-encodes everything a D-Bus string or a URI would trip on", () => {
  assert.equal(fileUri("/home/me/plan.md"), "file:///home/me/plan.md");
  assert.equal(fileUri("/home/me/a b/it's (1)!.md"), "file:///home/me/a%20b/it%27s%20%281%29%21.md");
  assert.equal(fileUri("/x/100%/#?.md"), "file:///x/100%25/%23%3F.md");
  assert.equal(fileUri("/x/back\\slash\"q"), "file:///x/back%5Cslash%22q");
  assert.equal(fileUri("/x/héllo"), "file:///x/h%C3%A9llo");
  assert.doesNotMatch(fileUri("/a'b\\c"), /['\\]/);
});

test("parentOf is the folder a path is in", () => {
  assert.equal(parentOf("/a/b/c.md"), "/a/b");
  assert.equal(parentOf("/a/b/"), "/a");
  assert.equal(parentOf("/top"), "/");
});

test("openAction reveals Linux launchers on Linux only", () => {
  for (const e of ["desktop", "AppImage", "run", "deb", "flatpakref"]) {
    assert.equal(openAction(item({ path: `/a/x.${e}` }), "f", "linux").how, "reveal", e);
    assert.equal(openAction(item({ path: `/a/x.${e}` }), "f").how, "open", `${e} on macOS`);
  }
  assert.ok(LINUX_RUNS.has("desktop"));
  assert.equal(openAction(item({ path: "/a/x.command" }), "f", "linux").how, "reveal");
  assert.equal(openAction(item({ path: "/a/x.md" }), "f", "linux").how, "open");
  assert.equal(openAction(item({ path: "/a/x.md" }), "x", "linux").how, "reveal");
});

test("previewKind: thumbnails on macOS, the type's icon elsewhere", () => {
  for (const p of ["/a/x.pdf", "/a/index.html", "/a/x.heic", "/a/x.key"]) {
    assert.deepEqual(previewKind(item({ path: p }), "f"), { how: "thumb" }, p);
    assert.deepEqual(previewKind(item({ path: p }), "f", "macos"), { how: "thumb" }, p);
    assert.deepEqual(previewKind(item({ path: p }), "f", "linux"), { how: "icon" }, p);
  }
  // Images GPUI draws are still copied and shown on Linux.
  assert.deepEqual(previewKind(item({ path: "/a/x.png" }), "f", "linux"), { how: "image", ext: "png" });
  assert.deepEqual(previewKind(item(), "f", "linux"), { how: "markdown" });
  assert.deepEqual(noThumb(), { how: "thumb" });
  assert.deepEqual(noThumb("linux"), { how: "icon" });
  assert.equal(thumbnails("macos"), true);
  assert.equal(thumbnails("linux"), false);
});

test("quickLook picks Space's preview window", () => {
  assert.equal(quickLook("macos", null), "qlmanage");
  assert.equal(quickLook("macos", "no-sushi"), "qlmanage");
  assert.equal(quickLook("linux", null), "sushi");
  assert.equal(quickLook("linux", "no-sushi"), "pane");
  assert.equal(quickLook("linux", "no-gdbus"), "pane");
  assert.equal(quickLook("windows", null), "pane");
});

test("noQuickLook says what is missing in one line", () => {
  assert.match(noQuickLook("linux", "no-sushi"), /GNOME Sushi/);
  assert.match(noQuickLook("linux", "no-gdbus"), /gdbus/);
  assert.match(noQuickLook("windows", null), /no quick preview/);
  for (const m of [noQuickLook("linux", "no-sushi"), noQuickLook("linux", "no-gdbus"), noQuickLook("windows")]) assert.doesNotMatch(m, /\n/);
});

test("sushiCommand passes the URI as a D-Bus string and the close flag", () => {
  assert.deepEqual(sushiCommand("/a/b c.md", false), { command: "sh", args: ["-c", SUSHI_SCRIPT, "readlist", "'file:///a/b%20c.md'", "false"] });
  assert.equal(sushiCommand("/a", true).args[4], "true");
});

// ---- the Linux scripts, against stand-in programs ----

// A folder of stand-in programs; `PATH` is it alone, or it then the system's.
function stubs(progs) {
  const dir = mkdtempSync(join(tmpdir(), "rl-plat-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(progs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { dir, bin, log: join(dir, "log") };
}
const run = (script, args, path) => {
  const started = Date.now();
  const r = spawnSync("/bin/sh", ["-c", script, "readlist", ...args], { encoding: "utf8", env: { PATH: path, HOME: tmpdir() }, timeout: 15000 });
  return { ...r, ms: Date.now() - started };
};
const sys = "/usr/bin:/bin";

test("XDG_OPEN_SCRIPT says xdg-open is missing and never crashes", () => {
  const s = stubs({});
  const r = run(XDG_OPEN_SCRIPT, ["/a/b.md"], s.bin);
  assert.equal(r.status, MISSING);
  assert.match(r.stderr, /xdg-open is not installed \(it comes with xdg-utils\)/);
});

test("XDG_OPEN_SCRIPT opens the path as one argument", () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$#" "$1" > '${s.log}'\n`);
  chmodSync(join(s.bin, "xdg-open"), 0o755);
  const r = run(XDG_OPEN_SCRIPT, ["/a/b c; rm -rf x.md"], `${s.bin}:${sys}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.log, "utf8"), "1\n/a/b c; rm -rf x.md\n");
});

test("XDG_OPEN_SCRIPT passes on xdg-open's failure and message", () => {
  const silent = stubs({ "xdg-open": "exit 3" });
  let r = run(XDG_OPEN_SCRIPT, ["/a/b.md"], `${silent.bin}:${sys}`);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /xdg-open found no program to open it with/);
  const loud = stubs({ "xdg-open": "echo 'gio: no such app' >&2; exit 4" });
  r = run(XDG_OPEN_SCRIPT, ["/a/b.md"], `${loud.bin}:${sys}`);
  assert.equal(r.status, 4);
  assert.equal(r.stderr.trim(), "gio: no such app");
});

test("XDG_OPEN_SCRIPT returns while an opener that stays running keeps going", () => {
  const s = stubs({ "xdg-open": "sleep 6" });
  const r = run(XDG_OPEN_SCRIPT, ["/a/b.md"], `${s.bin}:${sys}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < 5500, `took ${r.ms} ms`);
});

test("REVEAL_SCRIPT asks the file manager over D-Bus to show the item", () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "gdbus"), `#!/bin/sh\nfor a; do printf '%s\\n' "$a"; done > '${s.log}'\n`);
  chmodSync(join(s.bin, "gdbus"), 0o755);
  const [path, arr, parent] = openCommand("linux", "reveal", "/a/b c.md").args.slice(3);
  const r = run(REVEAL_SCRIPT, [path, arr, parent], `${s.bin}:${sys}`);
  assert.equal(r.status, 0, r.stderr);
  const args = readFileSync(s.log, "utf8").split("\n");
  assert.ok(args.includes("org.freedesktop.FileManager1.ShowItems"));
  assert.ok(args.includes("--session"));
  assert.ok(args.includes("['file:///a/b%20c.md']"));
  assert.ok(args.includes("''"));
});

test("REVEAL_SCRIPT falls back to opening the folder, then says what is missing", () => {
  const s = stubs({ gdbus: "exit 1" });
  writeFileSync(join(s.bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${s.log}'\n`);
  chmodSync(join(s.bin, "xdg-open"), 0o755);
  let r = run(REVEAL_SCRIPT, ["/a/b c.md", "['file:///a/b%20c.md']", "/a"], `${s.bin}:${sys}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.log, "utf8"), "/a\n");
  const none = stubs({});
  r = run(REVEAL_SCRIPT, ["/a/b.md", "['file:///a/b.md']", "/a"], none.bin);
  assert.equal(r.status, MISSING);
  assert.match(r.stderr, /no file manager answered, and xdg-open is not installed/);
});

test("SUSHI_SCRIPT shows the file in GNOME Sushi", () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "gdbus"), `#!/bin/sh\nfor a; do printf '%s\\n' "$a"; done >> '${s.log}'\n`);
  chmodSync(join(s.bin, "gdbus"), 0o755);
  const r = run(SUSHI_SCRIPT, sushiCommand("/a/b c.md", true).args.slice(3), `${s.bin}:${sys}`);
  assert.equal(r.status, 0, r.stderr);
  const args = readFileSync(s.log, "utf8").split("\n");
  assert.ok(args.includes("org.gnome.NautilusPreviewer2.ShowFile"));
  assert.ok(args.includes("'file:///a/b%20c.md'"));
  assert.equal(args[args.indexOf("'file:///a/b%20c.md'") + 2], "true");
});

test("SUSHI_SCRIPT tries the older interface before giving up", () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "gdbus"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${s.log}'\ncase "$*" in *NautilusPreviewer.ShowFile*) exit 0;; esac\nexit 1\n`);
  chmodSync(join(s.bin, "gdbus"), 0o755);
  const r = run(SUSHI_SCRIPT, ["'file:///a'", "false"], `${s.bin}:${sys}`);
  assert.equal(r.status, 0);
  assert.match(readFileSync(s.log, "utf8"), /NautilusPreviewer\.ShowFile 'file:\/\/\/a' 0 false/);
});

test("SUSHI_SCRIPT says when there is no Sushi or no gdbus", () => {
  const none = stubs({ gdbus: "echo 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown' >&2; exit 1" });
  let r = run(SUSHI_SCRIPT, ["'file:///a'", "false"], `${none.bin}:${sys}`);
  assert.equal(r.status, MISSING);
  assert.equal(r.stdout.trim(), "no-sushi");
  r = run(SUSHI_SCRIPT, ["'file:///a'", "false"], stubs({}).bin);
  assert.equal(r.status, MISSING);
  assert.equal(r.stdout.trim(), "no-gdbus");
});

test("the Linux scripts parse under every shell the tests run", () => {
  for (const script of [XDG_OPEN_SCRIPT, REVEAL_SCRIPT, SUSHI_SCRIPT]) {
    const r = spawnSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    if (existsSync("/bin/dash") || existsSync("/usr/bin/dash")) {
      const d = spawnSync("dash", ["-n", "-c", script], { encoding: "utf8" });
      assert.equal(d.status, 0, d.stderr);
    }
  }
});
