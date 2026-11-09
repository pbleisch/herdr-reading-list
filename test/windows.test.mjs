// Windows: the path helpers, the calls the mod makes there (core/helpers.js, core/handlers.js),
// and, on Windows only, the PowerShell 7 scripts themselves: rl.ps1 (the same cases as
// rl.test.sh, plus an item made on macOS), the helper readlist.ps1, the handler runner
// run-handler.ps1 with its ACL checks, and the built-in handler windows.ps1 in dry-run mode.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, realpathSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo, WINDOWS } from "./support.mjs";
import { isWinPath, isAbsPath, isLocalPath, baseName, joinPath } from "../mods/readlist/core/paths.js";
import { helperCall, rlFile, rlSource, DIR_SCRIPT, SCRIPTS } from "../mods/readlist/core/helpers.js";
import { PWSH, PWSH_ARGS, noPwsh } from "../mods/readlist/core/windows.js";
import { chain, actionArgs, runChain, parseTrust, parseCheck, outcome, REFUSED, NOT_HANDLED, THUMB_SECONDS } from "../mods/readlist/core/handlers.js";
import { normalizeItem, itemFile, openAction, typeOf, parseListing, parseStats, STATS_SCRIPT, LIST_SCRIPT } from "../mods/readlist/core/items.js";
import { WINDOWS_RUNS, words } from "../mods/readlist/core/platform.js";
import { parseStat, parseFolder, previewText, CACHE_SCRIPT, TEXT_BYTES, FOLDER_ENTRIES } from "../mods/readlist/core/preview.js";
import { parseInbox } from "../mods/readlist/core/inbox.js";
import { parseRlStatus, rlBanner, installToast, MARK } from "../mods/readlist/core/install.js";
import { parseSendLine, parseScan, LINE_MAX } from "../mods/readlist/core/sent.js";
import { copyPaths, CHUNK_MIB } from "../mods/readlist/core/remote.js";

const MOD = join(repo, "mods/readlist");
const WIN = join(MOD, "bin/windows");
const RL = join(WIN, "rl.ps1");
const HELPER = join(WIN, "readlist.ps1");
const RUN = join(WIN, "run-handler.ps1");
const BUILTIN = join(MOD, "handlers/windows.ps1");
const win = WINDOWS ? {} : { skip: "Windows only: runs the PowerShell 7 scripts" };
const sha16 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ---- everywhere: pure functions ----

test("paths: Windows and POSIX forms, a backslash a separator only in a Windows path", () => {
  assert.ok(isWinPath("C:\\Users\\me") && isWinPath("d:/x") && !isWinPath("\\\\srv\\share\\a") && !isWinPath("\\\\?\\C:\\a") && !isWinPath("/a"));
  assert.ok(isAbsPath("/a") && isAbsPath("C:\\a") && !isAbsPath("a\\b") && !isAbsPath("C:a"));
  assert.ok(isLocalPath("C:\\a", "windows") && !isLocalPath("/a", "windows") && isLocalPath("/a", "macos") && !isLocalPath("C:\\a", "linux"));
  assert.equal(baseName("C:\\Users\\me\\plan.md"), "plan.md");
  assert.equal(baseName("C:/Users/me/dir/"), "dir");
  assert.equal(baseName("/home/me/a\\b.md"), "a\\b.md", "a backslash is part of a POSIX name");
  assert.equal(baseName("/home/me/"), "me");
  assert.equal(joinPath("C:\\h", "mods/readlist", "bin/rl"), "C:\\h\\mods\\readlist\\bin\\rl");
  assert.equal(joinPath("C:/h/", "x"), "C:\\h\\x");
  assert.equal(joinPath("/h", "mods/readlist"), "/h/mods/readlist");
  assert.equal(joinPath("/h"), "/h");
});

test("helperCall: macOS and Linux run exactly the sh scripts and programs they ran before", () => {
  for (const p of ["macos", "linux"]) {
    assert.deepEqual(helperCall(p, "/h/mods/readlist", "dir"), { command: "sh", args: ["-c", DIR_SCRIPT, "readlist"] });
    assert.deepEqual(helperCall(p, "/h/mods/readlist", "list", ["/l/items"]), { command: "sh", args: ["-c", LIST_SCRIPT, "readlist", "/l/items"] });
    assert.deepEqual(helperCall(p, "/h/mods/readlist", "stats", ["/a", "/b"]), { command: "sh", args: ["-c", STATS_SCRIPT, "readlist", "/a", "/b"] });
    assert.deepEqual(helperCall(p, "/h/mods/readlist", "cache", ["s", "d", "o", "i", "800", "sh", "r"]), { command: "sh", args: ["-c", CACHE_SCRIPT, "readlist", "s", "d", "o", "i", "800", "sh", "r"] });
    assert.deepEqual(helperCall(p, "/h/mods/readlist", "mkdir", ["/c/x"]), { command: "mkdir", args: ["-p", "/c/x"] });
    assert.deepEqual(helperCall(p, "/h/mods/readlist", "rm-item", ["/l/items/0123456789abcdef.json"]), { command: "rm", args: ["-f", "--", "/l/items/0123456789abcdef.json"] });
  }
  // Every helper has an sh script there; "posix" (another machine) is the same.
  for (const op of Object.keys(SCRIPTS)) assert.equal(helperCall("posix", "/m", op, []).args[1], SCRIPTS[op]);
  assert.equal(rlFile("macos", "/h/mods/readlist"), "/h/mods/readlist/bin/rl");
  assert.equal(rlSource("linux", "/h/mods/readlist"), "/h/mods/readlist/bin/rl");
  assert.throws(() => helperCall("macos", "/m", "nope"));
});

test("helperCall: Windows runs readlist.ps1 with pwsh -File, every argument its own, plus the scripts' built-in numbers", () => {
  const m = "C:\\h\\mods\\readlist";
  const call = (op, args) => helperCall("windows", m, op, args);
  const pre = [...PWSH_ARGS, `${m}\\bin\\windows\\readlist.ps1`];
  assert.equal(PWSH, "pwsh");
  assert.ok(PWSH_ARGS.includes("-NoProfile") && PWSH_ARGS.at(-1) === "-File");
  assert.deepEqual(call("dir", []), { command: "pwsh", args: [...pre, "dir"] });
  assert.deepEqual(call("stats", ["C:\\a b.md", "$(x)"]).args.slice(pre.length), ["stats", "C:\\a b.md", "$(x)"]);
  assert.deepEqual(call("head", ["C:\\a"]).args.slice(pre.length), ["head", "C:\\a", String(TEXT_BYTES)]);
  assert.deepEqual(call("listdir", ["C:\\a"]).args.slice(pre.length), ["listdir", "C:\\a", String(FOLDER_ENTRIES)]);
  assert.deepEqual(call("scan", ["", "t1", "42", ""]).args.slice(pre.length), ["scan", "", String(LINE_MAX), "t1", "42", ""]);
  assert.deepEqual(call("chunks", ["m", "/r", "C:\\o", "1", "2", "C:\\meta", ""]).args.slice(-1), [String(CHUNK_MIB)]);
  assert.deepEqual(call("cache", ["s", "d", "o", "i", "copy"]).args.slice(pre.length), ["cache", "s", "d", "o", "i", "copy"]);
  assert.deepEqual(call("cache", ["s", "d", "o", "i", "800", "pwsh", "-File", "r"]).args.slice(pre.length), ["cache", "s", "d", "o", "i", "800", String(THUMB_SECONDS), "pwsh", "-File", "r"]);
  assert.deepEqual(call("rm-item", ["C:\\l\\items\\0123456789abcdef.json"]).args.slice(pre.length), ["rm-item", "C:\\l\\items\\0123456789abcdef.json"]);
  assert.equal(rlFile("windows", m), `${m}\\bin\\windows\\rl.ps1`);
  assert.equal(rlSource("windows", m), `${m}\\bin\\windows`);
  assert.ok(noPwsh("cannot start pwsh: program not found") && !noPwsh("exit 1"));
});

test("Windows items: C:\\ paths are items, files that could run are revealed, never opened", () => {
  const i = normalizeItem({ v: 1, id: "0123456789abcdef", path: "C:\\Users\\me\\docs\\plan.md", added_at: "2026-11-09T00:00:00Z" });
  assert.equal(i.title, "plan.md");
  assert.equal(typeOf(i, "f"), "md");
  assert.equal(normalizeItem({ v: 1, id: "0123456789abcdef", path: "docs\\plan.md", added_at: "2026-11-09T00:00:00Z" }), null);
  assert.equal(normalizeItem({ v: 1, id: "0123456789abcdef", path: "\\\\srv\\share\\a.md", added_at: "2026-11-09T00:00:00Z" }), null, "a network path is not an item");
  assert.equal(itemFile("C:\\l", "0123456789abcdef"), "C:\\l\\items\\0123456789abcdef.json");
  assert.throws(() => itemFile("C:\\l", "..\\x"));
  const at = (name) => openAction({ path: `C:\\d\\${name}` }, "f", "windows").how;
  for (const name of ["setup.exe", "run.bat", "run.cmd", "x.ps1", "pkg.msi", "app.lnk", "a.vbs", "a.js", "a.hta", "a.scr", "a.reg", "a.chm", "disk.iso", "x.URL", "a.wsf", "a.com", "a.cpl"]) assert.equal(at(name), "reveal", name);
  for (const name of ["plan.md", "a.pdf", "a.png", "notes.txt", "a.html"]) assert.equal(at(name), "open", name);
  assert.equal(openAction({ path: "/d/a.js" }, "f", "macos").how, "open", "macOS keeps opening scripts that do not run there");
  assert.equal(openAction({ path: "/d/a.lnk" }, "f", "linux").how, "open");
  assert.ok(WINDOWS_RUNS.has("lnk") && WINDOWS_RUNS.has("js"));
  assert.equal(words("windows").files, "Explorer");
  assert.equal(copyPaths("devbox", "0123456789abcdef", "C:\\a\\b.pdf").copy, "remote/devbox/0123456789abcdef/copy/b.pdf");
});

test("Windows handlers: only C:\\ paths go to a handler, and no argument starts with -", () => {
  assert.deepEqual(actionArgs("open", "C:\\a b\\c.md", [], "windows"), ["path", "C:\\a b\\c.md", "open"]);
  assert.equal(actionArgs("open", "/a.md", [], "windows"), null);
  assert.equal(actionArgs("open", "\\\\srv\\share\\a.md", [], "windows"), null);
  assert.equal(actionArgs("open", "C:\\a.md", [], "macos"), null, "macOS takes only /...");
  assert.equal(actionArgs("preview-close", "C:\\a.md", ["-x:1", "same"], "windows"), null);
  assert.deepEqual(actionArgs("preview-close", "/a.md", ["-1", "same"]), ["path", "/a.md", "preview-close", "-1", "same"], "unchanged elsewhere");
  const sha = "a".repeat(64);
  assert.deepEqual(parseTrust(`{"v":1,"handler":{"path":"C:\\\\h\\\\handler.ps1","sha256":"${sha}"}}`, "windows").path, "C:\\h\\handler.ps1");
  assert.equal(parseTrust(`{"v":1,"handler":{"path":"/h/handler","sha256":"${sha}"}}`, "windows"), null);
  assert.equal(parseTrust(`{"v":1,"handler":{"path":"C:\\\\h","sha256":"${sha}"}}`), null, "macOS reads only /... paths, as before");
  assert.deepEqual(parseCheck(`ok\tC:\\h\\handler.ps1\t${sha}\n`, "windows"), { state: "ok", path: "C:\\h\\handler.ps1", sha256: sha });
  assert.equal(parseCheck(`ok\tC:\\h\\handler.ps1\t${sha}\n`).state, "refused");
});

test("Windows rl banner and toasts say what Install rl does to PATH", () => {
  assert.match(rlBanner({ state: "missing" }, "windows").text, /adds that folder to your PATH/);
  assert.equal(rlBanner({ state: "offpath", path: "~\\.local\\bin\\rl.ps1" }, "windows").button, "install");
  assert.equal(rlBanner({ state: "ok" }, "windows"), null);
  assert.equal(rlBanner({ state: "offpath" }).button, null, "macOS and Linux unchanged");
  const t = installToast("installed\t~\\.local\\bin\\rl.ps1\t1\t~\\.local\\bin\\rl.ps1\t1", null, "windows");
  assert.equal(t.level, "success");
  assert.match(t.body, /Added ~\\\.local\\bin to your PATH/);
  assert.equal(installToast("same\t~\\.local\\bin\\rl.ps1\t1\t~\\.local\\bin\\rl.ps1\t0", null, "windows").level, "info");
  assert.equal(installToast("other\t~\\.local\\bin\\rl.ps1\t1\t\t0", null, "windows").level, "warning");
  assert.match(installToast("installed\t~/.local/bin/rl\t1\t~/.local/bin/rl").body, /^Installed rl at ~\/\.local\/bin\/rl\.$/, "macOS and Linux unchanged");
});

test("files Claude Code sends from Windows: C:\\ paths, relative ones against a C:\\ folder", () => {
  const line = (cwd, path) => JSON.stringify({ type: "user", timestamp: "2026-11-09T00:00:00Z", cwd, toolUseResult: { attachments: [{ path, file_uuid: "u" }] }, message: { content: [{ type: "tool_result", tool_use_id: "x" }] } });
  assert.deepEqual(parseSendLine(line("C:\\work\\x", "out\\a.md")).files, ["C:\\work\\x\\out\\a.md"]);
  assert.deepEqual(parseSendLine(line("C:\\", "a.md")).files, ["C:\\a.md"]);
  assert.deepEqual(parseSendLine(line("C:\\w", "D:\\b.md")).files, ["D:\\b.md"]);
  assert.deepEqual(parseSendLine(line("/w/x/", "a.md")).files, ["/w/x/a.md"], "POSIX unchanged");
  assert.equal(parseSendLine(line("/", "a.md")), null, "POSIX unchanged");
});

test("the Windows rl files carry the mark, and the shims run rl.ps1 next to them", () => {
  for (const f of ["rl.ps1", "rl.cmd", "rl"]) assert.ok(readFileSync(join(WIN, f), "utf8").includes(MARK), f);
  assert.match(readFileSync(join(WIN, "rl.cmd"), "utf8"), /\r\n/, "rl.cmd has CRLF line ends");
  assert.match(readFileSync(join(WIN, "rl.cmd"), "utf8"), /-File "%~dp0rl\.ps1" %\*/);
  assert.match(readFileSync(join(WIN, "rl"), "utf8"), /-File "\$\(dirname -- "\$0"\)\/rl\.ps1" "\$@"/);
});

// ---- Windows only: the PowerShell scripts ----

const scratchRoots = [];
const scratch = (name) => {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), name)));
  scratchRoots.push(d);
  return d;
};
after(() => { for (const d of scratchRoots) rmSync(d, { recursive: true, force: true }); });

const baseEnv = () => {
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID;
  delete env.READLIST_DRY_RUN;
  return env;
};
// pwsh -File SCRIPT ARGS: { status, stdout, stderr }, UTF-8.
const ps = (file, args, env = {}, opts = {}) => {
  const r = spawnSync("pwsh", [...PWSH_ARGS, file, ...args], { encoding: "utf8", env: { ...baseEnv(), ...env }, timeout: 60000, ...opts });
  if (r.error) throw r.error;
  return r;
};
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

test("rl.ps1: add, re-add, --if-new, errors, URLs and folders, as the POSIX rl", win, () => {
  const s = scratch("rl-win-");
  const list = join(s, "list");
  const env = { READING_LIST_DIR: list };
  const rl = (...a) => ps(RL, a, env);
  mkdirSync(join(s, "docs/sub dir"), { recursive: true });
  writeFileSync(join(s, "docs/sub dir/plan.md"), "# Rollout plan\r\n\r\nbody\r\n");
  // A junction (no admin rights needed) stands for the POSIX test's symlink.
  spawnSync("cmd", ["/c", "mklink", "/J", join(s, "link"), join(s, "docs")]);
  const real = join(s, "docs/sub dir/plan.md");
  const note = 'say "hi" \\ back\nsecond\tline é -x:1';
  let r = rl("add", join(s, "link", "sub dir", "..", "sub dir", "PLAN.md"), "--note", note);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  assert.equal(id, sha16(real), "id is sha256 of the real path (junction resolved, on-disk case)");
  const f = join(list, "items", `${id}.json`);
  const o = json(f);
  assert.equal(o.path, real);
  assert.equal(o.title, "Rollout plan");
  assert.equal(o.note, note, "note survives quotes, backslash, newline, tab, UTF-8 and -x:1");
  assert.deepEqual([o.v, o.kind, o.adds, o.size, o.url, o.done_at], [1, "review", 1, 24, null, null]);
  assert.match(o.added_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(o.mtime, /Z$/);
  assert.match(o.by.from, /^.+@.+$/);
  assert.deepEqual(Object.keys(o), ["v", "id", "path", "url", "title", "note", "kind", "added_at", "adds", "by", "size", "mtime", "done_at"]);
  assert.ok(!readFileSync(f, "utf8").includes("\r"), "LF line ends, as the POSIX rl writes");
  assert.deepEqual(readdirSync(join(list, "items")).filter((n) => n.startsWith(".")), [], "no temp files left");

  r = rl("add", real, "--kind", "fyi", "--title", "Plan v2", "--from", "ci job");
  assert.equal(r.stdout.trim(), id);
  assert.deepEqual((({ adds, note, kind, title, by }) => [adds, note, kind, title, by.from])(json(f)), [2, null, "fyi", "Plan v2", "ci job"]);
  const before = readFileSync(f, "utf8");
  assert.equal(rl("add", real, "--if-new", "--note", "other").stdout.trim(), id);
  assert.equal(readFileSync(f, "utf8"), before, "--if-new leaves that item unchanged");

  assert.equal(rl("add", join(s, "nope.md")).status, 1);
  assert.equal(rl("add", join(s, "docs"), "--kind", "weird").status, 1);
  assert.equal(rl("add").status, 1);
  assert.equal(rl("frob").status, 2);

  const uid = rl("add", "https://herdr.dev/mods", "--kind", "result").stdout.trim();
  assert.equal(uid, sha16("https://herdr.dev/mods"));
  assert.deepEqual((({ path, url, title, size }) => [path, url, title, size])(json(join(list, "items", `${uid}.json`))), [null, "https://herdr.dev/mods", "herdr.dev/mods", null]);
  const did = rl("add", join(s, "docs") + "\\").stdout.trim();
  assert.deepEqual((({ path, title, size }) => [path, title, size])(json(join(list, "items", `${did}.json`))), [join(s, "docs"), "docs", null]);

  // rl.cmd and in-process PowerShell give the same ids.
  const viaCmd = spawnSync("cmd", ["/c", join(WIN, "rl.cmd"), "add", real, "--note", "via cmd"], { encoding: "utf8", env: { ...baseEnv(), ...env } });
  assert.equal(viaCmd.stdout.trim(), id, viaCmd.stderr);
  const inProc = spawnSync("pwsh", ["-NoProfile", "-Command", `& '${RL}' add '${real}'`], { encoding: "utf8", env: { ...baseEnv(), ...env } });
  assert.equal(inProc.stdout.trim(), id, inProc.stderr);
  assert.equal(json(f).by.from.endsWith("@pwsh"), true, "in PowerShell, the caller is pwsh");
});

test("rl.ps1: attribution from hc get, and the fallback when it fails", win, () => {
  const s = scratch("rl-win-hc-");
  const env = { READING_LIST_DIR: join(s, "list") };
  mkdirSync(join(s, "bin"));
  writeFileSync(join(s, "hc.json"), JSON.stringify({ address: "t9", argv: ["zsh", '--name "name":"evil"'], cwd: "C:\\work\\x", foreground: { cwd: "C:\\elsewhere", name: "claude.exe" }, labels: { "herdr.space": "sp1", "herdr.tab": "tb1", other: "x" }, name: "fix-login", status: { app: "claude-code", state: "working" } }));
  writeFileSync(join(s, "bin/hc.cmd"), `@echo off\r\nif "%1 %2 %3"=="get t9 --json" (type "${join(s, "hc.json")}" & exit /b 0)\r\nexit /b 1\r\n`);
  writeFileSync(join(s, "a.md"), "x");
  const PATH = `${join(s, "bin")};${process.env.PATH}`;
  let r = ps(RL, ["add", join(s, "a.md")], { ...env, PATH, HC_TERMINAL_ID: "t9" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(json(join(s, "list/items", `${r.stdout.trim()}.json`)).by, { terminal: "t9", app: "claude-code", name: "fix-login", space: "sp1", tab: "tb1", cwd: "C:\\work\\x", from: null });
  r = ps(RL, ["add", join(s, "a.md")], { ...env, PATH, HC_TERMINAL_ID: "t404" });
  const by = json(join(s, "list/items", `${r.stdout.trim()}.json`)).by;
  assert.deepEqual([by.terminal, typeof by.from], [null, "string"]);
});

test("rl.ps1: ls with the person's state, done and rm, as the POSIX rl", win, () => {
  const s = scratch("rl-win-ls-");
  const list = join(s, "list");
  const env = { READING_LIST_DIR: list };
  const rl = (...a) => ps(RL, a, env);
  writeFileSync(join(s, "plan.md"), "# Plan\n");
  const id = rl("add", join(s, "plan.md")).stdout.trim();
  const uid = rl("add", "https://herdr.dev/mods").stdout.trim();
  const did = rl("add", s).stdout.trim();
  assert.equal(rl("ls").stdout.trim().split("\n").length, 3);
  writeFileSync(join(list, "state.json"), JSON.stringify({ v: 1, items: { [uid]: { read_at: "2099-01-01T00:00:00.000Z" }, [did]: { done_at: "2099-01-01T00:00:00.000Z" } } }));
  assert.equal(rl("ls", "--unread").stdout.slice(0, 16), id);
  assert.equal(rl("ls", "--done").stdout.slice(0, 16), did);
  assert.equal(rl("ls", "--all").stdout.trim().split("\n").length, 3);
  const line = rl("ls").stdout.split("\n").find((l) => l.startsWith(uid));
  assert.equal(line, `${uid}  read    review  herdr.dev/mods  https://herdr.dev/mods`);
  const all = JSON.parse(rl("ls", "--json", "--all").stdout);
  assert.ok(all.length === 3 && all.every((i) => i.v === 1));
  assert.equal(rl("done", join(s, "plan.md")).stdout.trim(), id);
  const f = join(list, "items", `${id}.json`);
  assert.deepEqual([typeof json(f).done_at, json(f).title], ["string", "Plan"]);
  assert.deepEqual(rl("ls", "--done").stdout.trim().split("\n").map((l) => l.slice(0, 16)).sort(), [id, did].sort());
  rl("add", join(s, "plan.md"));
  assert.equal(json(f).done_at, null, "re-add clears done");
  assert.equal(rl("done", "ffffffffffffffff").status, 1);
  assert.equal(rl("rm", uid).stdout.trim(), uid);
  rmSync(join(s, "plan.md"));
  assert.equal(rl("rm", join(s, "plan.md")).stdout.trim(), id, "rm by the path of a deleted file");
  assert.equal(rl("rm", join(s, "plan.md")).status, 1);
  rl("rm", did);
  assert.equal(rl("ls", "--json", "--all").stdout, "[]\n");
  assert.equal(rl("ls", "--all").stdout, "");
});

test("rl.ps1: an item made on macOS lists, is marked done byte for byte, and is removed", win, () => {
  const s = scratch("rl-win-mac-");
  const list = join(s, "list");
  mkdirSync(join(list, "items"), { recursive: true });
  const id = sha16("/Users/me/notes/plan.md");
  // Exactly what the POSIX rl writes (bin/rl write_item).
  const mac = `{
  "v": 1,
  "id": "${id}",
  "path": "/Users/me/notes/plan.md",
  "url": null,
  "title": "Plan \\u00e9 \\"q\\"",
  "note": "line one\\nline two",
  "kind": "result",
  "added_at": "2026-11-01T10:00:00Z",
  "adds": 3,
  "by": {
    "terminal": "t4",
    "app": "claude-code",
    "name": "fix",
    "space": "s1",
    "tab": "b2",
    "cwd": "/Users/me/notes",
    "from": null
  },
  "size": 120,
  "mtime": "2026-11-01T09:59:00Z",
  "done_at": null
}
`;
  writeFileSync(join(list, "items", `${id}.json`), mac);
  const rl = (...a) => ps(RL, a, { READING_LIST_DIR: list });
  assert.equal(rl("ls").stdout, `${id}  unread  result  Plan é "q"  /Users/me/notes/plan.md\n`);
  assert.equal(rl("ls", "--json").stdout, `[\n${mac}]\n`, "--json passes the file through as it is");
  assert.equal(rl("done", id).stdout.trim(), id);
  const after = readFileSync(join(list, "items", `${id}.json`), "utf8");
  const doneAt = after.match(/"done_at": "([^"]+)"/)[1];
  assert.equal(after, mac.replace('"done_at": null', `"done_at": "${doneAt}"`), "done changes done_at and nothing else");
  assert.ok(normalizeItem(JSON.parse(after)), "the mod still reads it");
  assert.equal(rl("rm", id).stdout.trim(), id);
  assert.equal(rl("ls", "--all").stdout, "");
});

test("readlist.ps1: the list folder, listing, stats, head, folders and the inbox", win, () => {
  const s = scratch("rl-win-help-");
  const h = (...a) => ps(HELPER, a, { READING_LIST_DIR: join(s, "list") });
  const dir = h("dir").stdout.trim();
  assert.equal(dir, join(s, "list"));
  assert.ok(existsSync(join(dir, "items")) && existsSync(join(dir, "inbox")));
  writeFileSync(join(s, "a.md"), "# A\n");
  const id = ps(RL, ["add", join(s, "a.md"), "--note", "é"], { READING_LIST_DIR: dir }).stdout.trim();
  writeFileSync(join(dir, "items", ".x.tmp"), "junk");
  const items = parseListing(h("list", join(dir, "items")).stdout);
  assert.deepEqual(items.map((i) => [i.id, i.note]), [[id, "é"]]);
  const paths = [s, join(s, "a.md"), join(s, "nope"), "/Users/x", "\\\\srv\\share\\a"];
  const st = parseStats(h("stats", ...paths).stdout, paths);
  assert.deepEqual(paths.map((p) => st.fs[p]), ["d", "f", "-", "-", "-"], "POSIX and network paths are never touched");
  assert.ok(st.mt[join(s, "a.md")] > 1e9);
  assert.equal(h("stat", join(s, "a.md"), s, join(s, "nope")).stdout, "f\nd\n-\n");
  const one = parseStat(h("stat1", join(s, "a.md")).stdout);
  assert.deepEqual([one.kind, one.size], ["f", 4]);
  writeFileSync(join(s, "bin.dat"), Buffer.from([0x41, 0, 0x42]));
  const head = h("head", join(s, "bin.dat"), "2");
  assert.equal(head.stdout, "A\0");
  assert.equal(previewText(head.stdout, 3), null, "binary is refused");
  mkdirSync(join(s, "sub"));
  writeFileSync(join(s, ".hidden"), "");
  const folder = parseFolder(h("listdir", s, "200").stdout);
  assert.deepEqual(folder.entries.find((e) => e.name === "sub"), { name: "sub", dir: true });
  assert.ok(folder.entries.some((e) => e.name === ".hidden"), "the preview lists hidden entries, as ls -A");
  writeFileSync(join(dir, "inbox", "shot.png"), "png");
  writeFileSync(join(dir, "inbox", ".partial"), "");
  writeFileSync(join(dir, "inbox", "desktop.ini"), "");
  spawnSync("attrib", ["+h", "+s", join(dir, "inbox", "desktop.ini")]);
  const inbox = parseInbox(h("inbox", join(dir, "inbox")).stdout);
  assert.deepEqual(inbox.map((e) => e.name), ["shot.png"]);
  assert.ok(inbox[0].mtime > 1e9);
});

test("readlist.ps1: add and sent-add run rl.ps1 with argv; hostile notes stay data", win, () => {
  const s = scratch("rl-win-add-");
  const list = join(s, "list");
  const h = (...a) => ps(HELPER, a, { READING_LIST_DIR: list, HC_TERMINAL_ID: "t1" });
  writeFileSync(join(s, "a.md"), "a");
  writeFileSync(join(s, "b & c's.txt"), "b");
  let r = h("add", RL, "inbox", join(s, "a.md"), join(s, "nope.md"));
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), sha16(join(s, "a.md")));
  assert.match(r.stderr, /no such file or folder/);
  assert.equal(json(join(list, "items", `${sha16(join(s, "a.md"))}.json`)).by.from, "inbox", "the app's HC_TERMINAL_ID is dropped");
  const evil = '$(New-Item PWNED) `whoami` ; & -x:1 "q" %PATH%';
  r = h("sent-add", RL, "t7", "Claude Code t7", evil, join(s, "b & c's.txt"), "t7", "Claude Code t7", "", join(s, "gone.md"));
  assert.equal(r.status, 0, r.stderr);
  const o = json(join(list, "items", `${r.stdout.trim()}.json`));
  assert.deepEqual([o.note, o.kind, o.path], [evil, "result", join(s, "b & c's.txt")]);
  assert.ok(!existsSync(join(s, "PWNED")) && !existsSync(join(repo, "PWNED")));
  assert.equal(h("add", join(s, "missing-rl.ps1"), "inbox", join(s, "a.md")).status, 127);
});

test("readlist.ps1: cache copies images, asks a handler for thumbnails, and prunes", win, () => {
  const s = scratch("rl-win-cache-");
  const cache = join(s, "cache");
  const id = "0123456789abcdef";
  writeFileSync(join(s, "a.png"), "png1");
  let r = ps(HELPER, ["cache", join(s, "a.png"), cache, join(cache, `${id}-1-4.png`), id, "copy"]);
  assert.equal(r.status, 0, r.stderr);
  writeFileSync(join(cache, `${id}-0-1.png`), "old");
  writeFileSync(join(s, "a.png"), "png22");
  r = ps(HELPER, ["cache", join(s, "a.png"), cache, join(cache, `${id}-2-5.png`), id, "copy"]);
  assert.deepEqual(readdirSync(cache), [`${id}-2-5.png`], "older images of the item go");
  // A stand-in handler (node): made, not handled, failed, too slow.
  const fake = join(s, "fake.mjs");
  writeFileSync(fake, `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2), mode = a[0], out = a.at(-1);
if (a.slice(1).join(" ") !== ["path", a[2], "thumbnail", "800", out].join(" ")) { console.error("bad args " + a.join("|")); process.exit(3); }
if (mode === "made") writeFileSync(out, "PNG");
else if (mode === "pass") process.exit(10);
else if (mode === "fail") { console.error("no luck"); process.exit(2); }
else if (mode === "slow") setTimeout(() => {}, 60000);
`);
  const thumb = (mode, secs = "28") => ps(HELPER, ["cache", join(s, "a.pdf"), cache, join(cache, `${id}-3-3-800.png`), id, "800", secs, process.execPath, fake, mode]);
  writeFileSync(join(s, "a.pdf"), "pdf");
  r = thumb("pass");
  assert.equal(r.status, NOT_HANDLED);
  r = thumb("fail");
  assert.equal(r.status, 2);
  assert.equal(outcome({ code: r.status, stderr: r.stderr }).message, "no luck");
  const t0 = Date.now();
  r = thumb("slow", "2");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /took over 2 s/);
  assert.ok(Date.now() - t0 < 20000);
  r = thumb("made");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(cache, `${id}-3-3-800.png`), "utf8"), "PNG");
  assert.deepEqual(readdirSync(cache).filter((n) => n.startsWith(".")), [], "no scratch folders left");
  writeFileSync(join(cache, "fedcba9876543210-1-1.png"), "x");
  ps(HELPER, ["prune", cache, id]);
  assert.deepEqual(readdirSync(cache), [`${id}-3-3-800.png`]);
});

test("readlist.ps1: remote copies decode with their meta, prune, and rm-item removes only item files", win, () => {
  const s = scratch("rl-win-remote-");
  const out = join(s, "remote/devbox/0123456789abcdef/copy/a b.bin");
  const meta = join(s, "remote/devbox/0123456789abcdef/meta");
  const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
  writeFileSync(join(s, "b64"), bytes.toString("base64").replace(/(.{4})/g, "$1\n"));
  let r = ps(HELPER, ["decode", join(s, "b64"), out, "7", "1700000000", meta]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(out), bytes);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(meta, "utf8"))), ["mtime", "size", "at"]);
  assert.ok(!existsSync(join(s, "b64")));
  writeFileSync(join(s, "b64"), bytes.toString("base64"));
  r = ps(HELPER, ["decode", join(s, "b64"), out, "9", "1", meta]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /got 7 of 9 bytes/);
  mkdirSync(join(s, "remote/devbox/fedcba9876543210"), { recursive: true });
  ps(HELPER, ["prune-copies", join(s, "remote/devbox"), "0123456789abcdef"]);
  assert.deepEqual(readdirSync(join(s, "remote/devbox")), ["0123456789abcdef"]);
  mkdirSync(join(s, "list/items"), { recursive: true });
  writeFileSync(join(s, "list/items/0123456789abcdef.json"), "{}");
  writeFileSync(join(s, "other.json"), "{}");
  assert.equal(ps(HELPER, ["rm-item", join(s, "other.json")]).status, 2);
  assert.ok(existsSync(join(s, "other.json")));
  assert.equal(ps(HELPER, ["rm-item", itemFile(join(s, "list"), "0123456789abcdef")]).status, 0);
  assert.ok(!existsSync(join(s, "list/items/0123456789abcdef.json")));
});

test("readlist.ps1: chunks fetch a big file through hc exec, binary-safe", win, () => {
  const s = scratch("rl-win-chunks-");
  const src = Buffer.alloc(3 * 1048576 + 5);
  for (let i = 0; i < src.length; i++) src[i] = (i * 7) & 255;
  writeFileSync(join(s, "src.bin"), src);
  // A stand-in hc: `exec --on M --timeout T -- sh -c SCRIPT rl SRC CHUNK`, served from src.bin
  // (1 MiB per chunk here, as the helper asks for 1).
  mkdirSync(join(s, "bin"));
  writeFileSync(join(s, "hc.mjs"), `import { readFileSync } from "node:fs";
const a = process.argv.slice(2);
const i = Number(a.at(-1)), b = readFileSync(${JSON.stringify(join(s, "src.bin"))});
process.stdout.write(b.subarray(i * 1048576, (i + 1) * 1048576));
`);
  writeFileSync(join(s, "bin/hc.cmd"), `@"${process.execPath}" "${join(s, "hc.mjs")}" %*\r\n`);
  const out = join(s, "copy/big.bin"), meta = join(s, "meta");
  const r = ps(HELPER, ["chunks", "devbox", "/srv/big.bin", out, String(src.length), "1700000000", meta, "", "1"], { PATH: `${join(s, "bin")};${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(out).equals(src));
  assert.equal(JSON.parse(readFileSync(meta, "utf8")).size, src.length);
});

test("readlist.ps1: rl-status and install-rl use ~\\.local\\bin and a stand-in PATH, never the real one", win, () => {
  const s = scratch("rl-win-inst-");
  const env = { USERPROFILE: s, READLIST_TEST_USER_PATH_FILE: join(s, "userpath.txt"), PATH: process.env.PATH };
  writeFileSync(join(s, "userpath.txt"), "%SystemRoot%\\x;C:\\Tools");
  const h = (...a) => ps(HELPER, a, env);
  assert.equal(parseRlStatus(h("rl-status").stdout).state, "missing");
  let r = h("install-rl", WIN);
  const [result, dest, on, , added] = r.stdout.trim().split("\t");
  assert.deepEqual([result, dest, on, added], ["installed", "~\\.local\\bin\\rl.ps1", "1", "1"], r.stderr);
  assert.equal(readFileSync(join(s, "userpath.txt"), "utf8"), "%SystemRoot%\\x;C:\\Tools;%USERPROFILE%\\.local\\bin", "appended, the others kept unexpanded");
  assert.deepEqual(readdirSync(join(s, ".local/bin")).sort(), ["rl", "rl.cmd", "rl.ps1"]);
  assert.equal(parseRlStatus(h("rl-status").stdout).state, "ok");
  assert.equal(h("install-rl", WIN).stdout.split("\t")[0], "same");
  assert.equal(readFileSync(join(s, "userpath.txt"), "utf8").split(";").length, 3, "PATH is added to once");
  appendFileSync(join(s, ".local/bin/rl.cmd"), "rem older\r\n");
  assert.equal(h("install-rl", WIN).stdout.split("\t")[0], "updated");
  writeFileSync(join(s, ".local/bin/rl.cmd"), "@echo another rl\r\n");
  assert.equal(h("install-rl", WIN).stdout.split("\t")[0], "other");
  assert.equal(readFileSync(join(s, ".local/bin/rl.cmd"), "utf8"), "@echo another rl\r\n", "another program is left as it is");
  // The installed rl works from its new home.
  rmSync(join(s, ".local/bin/rl.cmd"));
  h("install-rl", WIN);
  writeFileSync(join(s, "x.md"), "x");
  const viaCmd = spawnSync("cmd", ["/c", join(s, ".local/bin/rl.cmd"), "add", join(s, "x.md")], { encoding: "utf8", env: { ...baseEnv(), READING_LIST_DIR: join(s, "list") } });
  assert.equal(viaCmd.stdout.trim(), sha16(join(s, "x.md")), viaCmd.stderr);
});

test("readlist.ps1: scan finds a terminal's Claude Code transcript and its send lines", win, async () => {
  const s = scratch("rl-win-scan-");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    mkdirSync(join(s, "sessions"));
    mkdirSync(join(s, "projects/C--work"), { recursive: true });
    writeFileSync(join(s, "sessions", `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: "abc-123" }));
    const send = JSON.stringify({ type: "user", timestamp: "2026-11-09T00:00:00Z", cwd: "C:\\work", toolUseResult: { attachments: [{ path: "out.md", file_uuid: "u1" }] }, message: { content: [{ type: "tool_result", tool_use_id: "s1" }] } });
    writeFileSync(join(s, "projects/C--work/abc-123.jsonl"), `{"type":"assistant"}\n${send}\n${"x".repeat(100)}file_uuid\n`);
    const r = ps(HELPER, ["scan", s, "50", "t3", String(child.pid), "", "t4", "notapid", ""]);
    assert.equal(r.status, 0, r.stderr);
    const scan = parseScan(r.stdout);
    assert.equal(scan.length, 1);
    assert.deepEqual([scan[0].address, scan[0].session, scan[0].same], ["t3", "abc-123", false]);
    const r2 = ps(HELPER, ["scan", s, String(LINE_MAX), "t3", String(child.pid), ""]);
    assert.deepEqual(parseScan(r2.stdout)[0].sends.map((x) => x.files), [["C:\\work\\out.md"]]);
    const again = parseScan(ps(HELPER, ["scan", s, String(LINE_MAX), "t3", String(child.pid), scan[0].sig]).stdout);
    assert.equal(again[0].same, true);
  } finally {
    child.kill();
  }
});

// The person's handler on Windows: a private scratch home (the user's temporary folder is
// private on Windows), the handler at readlist\handler.ps1 logging its argv as JSON.
let hn = 0;
function home(body = null) {
  const base = scratch("rl-win-h-");
  const dir = join(base, `home${hn++}`);
  mkdirSync(join(dir, "readlist"), { recursive: true });
  const log = join(dir, "log.json");
  const handler = join(dir, "readlist", "handler.ps1");
  writeFileSync(handler, body ?? `[IO.File]::WriteAllText('${log}', (ConvertTo-Json -Compress @($args)))\n`);
  return { dir, handler, log, argv: () => JSON.parse(readFileSync(log, "utf8")) };
}
const run = (...a) => ps(RUN, a);
const check = (handler) => parseCheck(run("check", handler).stdout, "windows");
const icacls = (path, ...a) => {
  const r = spawnSync("icacls", [path, ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
};

test("run-handler.ps1 check: a private .ps1 passes with its real path and hash; missing; not .ps1; a folder", win, () => {
  const h = home();
  const c = check(h.handler);
  assert.equal(c.state, "ok", JSON.stringify(c));
  assert.equal(c.path, h.handler);
  assert.equal(c.sha256, createHash("sha256").update(readFileSync(h.handler)).digest("hex"));
  assert.deepEqual(check(join(h.dir, "readlist/none.ps1")), { state: "missing" });
  writeFileSync(join(h.dir, "readlist/handler.exe"), "MZ");
  assert.match(check(join(h.dir, "readlist/handler.exe")).why, /not a PowerShell script/);
  mkdirSync(join(h.dir, "readlist/dir.ps1"));
  assert.match(check(join(h.dir, "readlist/dir.ps1")).why, /not a regular file/);
});

test("run-handler.ps1 runs the person's handler with argv, the folders resolved, nothing interpolated", win, () => {
  const h = home();
  const c = check(h.handler);
  const items = join(h.dir, "items");
  mkdirSync(items);
  spawnSync("cmd", ["/c", "mklink", "/J", join(h.dir, "via-link"), items]);
  const hostile = ["$(New-Item PWNED).md", "`whoami`.md", "a; New-Item PWNED.md", "it's.md", "a & b.md", "%PATH%.md", "^caret.md", "-- --version", " lead", "héllo wörld.md", "x -y=1.md"];
  for (const name of hostile) {
    const r = run("user", h.handler, c.path, c.sha256, "path", join(h.dir, "via-link", name), "open");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(h.argv(), ["open", "--", join(items, name)], name);
  }
  assert.ok(!existsSync(join(h.dir, "PWNED")) && !existsSync(join(items, "PWNED")) && !existsSync(join(repo, "PWNED")));
  let r = run("user", h.handler, c.path, c.sha256, "path", join(h.dir, "a.pdf"), "thumbnail", "800", join(h.dir, "c h", "thumb.png"));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.argv(), ["thumbnail", "800", join(h.dir, "c h", "thumb.png"), "--", join(h.dir, "a.pdf")]);
  run("user", h.handler, c.path, c.sha256, "url", "https://x.dev/$(id)?a=1&b=2", "open-url");
  assert.deepEqual(h.argv(), ["open-url", "--", "https://x.dev/$(id)?a=1&b=2"]);
  rmSync(h.log);
  for (const [kind, item, extra] of [["url", "javascript:alert(1)"], ["url", "file:///C:/x"], ["path", "relative.md"], ["path", "/Users/x/a.md"], ["path", "\\\\srv\\share\\a.md"], ["path", "-rf"], ["path", `${join(h.dir, "a.md")}:stream`], ["kind", "C:\\a"], ["path", join(h.dir, "a.md"), "-x:1"]]) {
    r = run("user", h.handler, c.path, c.sha256, kind, item, "preview-close", ...(extra ? [extra, "same"] : []));
    assert.notEqual(r.status, 0, item);
    assert.ok(!existsSync(h.log), `${item} reached the handler`);
  }
});

test("run-handler.ps1 refuses the handler once it changed or the location leads elsewhere", win, () => {
  const h = home();
  const c = check(h.handler);
  appendFileSync(h.handler, "# more\n");
  let r = run("user", h.handler, c.path, c.sha256, "path", join(h.dir, "a.md"), "open");
  assert.equal(r.status, REFUSED);
  assert.match(r.stderr, /^readlist: .*handler\.ps1 changed since you turned it on\r?\n$/);
  assert.equal(outcome({ code: r.status, stderr: r.stderr }).status, "refused");
  assert.ok(!existsSync(h.log));
  // readlist\ as a junction to folder a, then to folder b.
  const g = home();
  for (const x of ["a", "b"]) {
    mkdirSync(join(g.dir, x));
    writeFileSync(join(g.dir, x, "handler.ps1"), readFileSync(g.handler));
  }
  rmSync(join(g.dir, "readlist"), { recursive: true });
  spawnSync("cmd", ["/c", "mklink", "/J", join(g.dir, "readlist"), join(g.dir, "a")]);
  const ca = check(g.handler);
  assert.equal(ca.path, join(g.dir, "a", "handler.ps1"), "a junction is followed");
  spawnSync("cmd", ["/c", "rmdir", join(g.dir, "readlist")]);
  spawnSync("cmd", ["/c", "mklink", "/J", join(g.dir, "readlist"), join(g.dir, "b")]);
  r = run("user", g.handler, ca.path, ca.sha256, "path", join(g.dir, "a.md"), "open");
  assert.equal(r.status, REFUSED);
  assert.match(r.stderr, /now leads to .*\\b\\handler\.ps1, not the .*\\a\\handler\.ps1 you turned on/);
});

test("run-handler.ps1 refuses a handler or folder other users can write (Everyone, Users, Authenticated Users)", win, () => {
  const refused = (h, re) => {
    const c = check(h.handler);
    assert.equal(c.state, "refused", JSON.stringify(c));
    assert.match(c.why, re);
    const r = run("user", h.handler, h.handler, "f".repeat(64), "path", join(h.dir, "a.md"), "open");
    assert.equal(r.status, REFUSED);
    assert.ok(!existsSync(h.log));
  };
  let h = home();
  icacls(h.handler, "/grant", "*S-1-5-32-545:(W)");
  refused(h, /not yours alone .*can be changed by .*Users/);
  h = home();
  icacls(h.handler, "/grant", "*S-1-1-0:(M)");
  refused(h, /can be changed by Everyone/);
  h = home();
  icacls(join(h.dir, "readlist"), "/grant", "*S-1-5-11:(AD)");
  refused(h, /readlist can be changed by .*Authenticated Users/);
  h = home();
  icacls(join(h.dir, "readlist"), "/grant", "*S-1-1-0:(DC)");
  refused(h, /can be changed by Everyone/);
  h = home();
  icacls(h.dir, "/grant", "*S-1-5-11:(OI)(CI)(M)");
  refused(h, /can be changed by .*Authenticated Users/);
  // The same handler, once the grant is gone, passes again.
  icacls(h.dir, "/remove:g", "*S-1-5-11");
  icacls(join(h.dir, "readlist"), "/remove:g", "*S-1-5-11");
  icacls(h.handler, "/remove:g", "*S-1-5-11");
  assert.equal(check(h.handler).state, "ok");
});

test("run-handler.ps1 stops a handler that takes too long, with everything it started", win, () => {
  const h = home(`[IO.File]::WriteAllText('PIDFILE', [string]$PID); Start-Process -NoNewWindow pwsh -ArgumentList '-NoProfile','-Command','Start-Sleep 120'; Start-Sleep 120\n`);
  writeFileSync(h.handler, readFileSync(h.handler, "utf8").replace("PIDFILE", join(h.dir, "pid")));
  const c = check(h.handler);
  const t0 = Date.now();
  const r = run("user", h.handler, c.path, c.sha256, "path", join(h.dir, "a.md"), "open");
  const took = Date.now() - t0;
  assert.equal(r.status, 124);
  assert.match(r.stderr, /your handler took over 12 s/);
  assert.ok(took > 11000 && took < 30000, `took ${took} ms`);
  const pid = Number(readFileSync(join(h.dir, "pid"), "utf8"));
  assert.notEqual(spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid)), true, "the handler is gone");
});

test("windows.ps1 (dry run): Explorer, the default app, QuickLook or Peek; never opens what could run", win, () => {
  const s = scratch("rl-win-builtin-");
  writeFileSync(join(s, "plan.md"), "x");
  const env = { READLIST_DRY_RUN: "1", LOCALAPPDATA: join(s, "local"), ProgramFiles: join(s, "pf"), USERPROFILE: s, PATHEXT: ".COM;.EXE;.BAT;.CMD;.FOO" };
  const b = (...a) => ps(RUN, ["builtin", BUILTIN, ...a], env);
  const p = join(s, "plan.md");
  let r = b("path", p, "open");
  assert.deepEqual([r.status, r.stdout.trim()], [0, `would: open ${p}`]);
  r = b("path", join(s, "x", "..", "plan.md"), "reveal");
  assert.equal(r.stdout.trim(), `would: ${process.env.SystemRoot ?? "C:\\WINDOWS"}\\explorer.exe /select,"${p}"`);
  for (const name of ["setup.exe", "run.bat", "run.cmd", "x.ps1", "pkg.msi", "app.lnk", "a.vbs", "a.js", "a.hta", "thing.foo"]) {
    r = b("path", join(s, name), "open");
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /could run, so it is not opened/, name);
  }
  r = b("path", p, "preview");
  assert.equal(r.status, NOT_HANDLED);
  assert.match(r.stderr, /needs the QuickLook app or PowerToys Peek/);
  const peek = join(s, "local", "PowerToys", "WinUI3Apps", "PowerToys.Peek.UI.exe");
  mkdirSync(join(peek, ".."), { recursive: true });
  writeFileSync(peek, "");
  r = b("path", p, "preview");
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), [`would: ${peek} ${p}`, "peek"]);
  const ql = join(s, "local", "Programs", "QuickLook", "QuickLook.exe");
  mkdirSync(join(ql, ".."), { recursive: true });
  writeFileSync(ql, "");
  r = b("path", p, "preview");
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), [`would: ${ql} ${p}`, "quicklook"], "QuickLook first");
  r = b("path", p, "preview-close", "quicklook", "same");
  assert.deepEqual([r.status, r.stdout.trim()], [0, `would: ${ql} ${p}`], "running it again closes it");
  assert.equal(b("path", p, "preview-close", "quicklook", "other").status, 0);
  assert.equal(b("path", p, "preview-close", "peek", "same").status, 1);
  assert.equal(b("path", p, "thumbnail", "800", join(s, "o.png")).status, NOT_HANDLED);
  assert.equal(b("url", "https://x.dev", "open-url").status, NOT_HANDLED);
});

test("Windows end to end: a handler that passes falls through to the built-in one through runChain", win, async () => {
  const h = home("if ($args[0] -eq 'reveal') { exit 10 }\nexit 0\n");
  const modHome = h.dir;
  const c = check(h.handler);
  // An app home whose mods/readlist is this repo's mod.
  mkdirSync(join(modHome, "mods"));
  spawnSync("cmd", ["/c", "mklink", "/J", join(modHome, "mods", "readlist"), MOD]);
  const list = chain("windows", modHome, { path: c.path, sha256: c.sha256 }, "mods/readlist");
  assert.deepEqual(list.map((x) => x.who), ["user", "builtin"]);
  const exec = (command, args) => promisify(execFile)(command, args, { env: { ...baseEnv(), READLIST_DRY_RUN: "1" } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  writeFileSync(join(modHome, "a.md"), "x");
  const r = await runChain(list, "reveal", join(modHome, "a.md"), { exec, platform: "windows" });
  assert.equal(r.who, "builtin");
  assert.match(r.stdout, /would: .*explorer\.exe \/select,".*a\.md"/);
});
