// Action handlers: the interface (core/handlers.js), the runner that checks the person's
// handler (bin/run-handler), and the built-in handlers (handlers/macos.sh, linux.sh), run
// against stand-in programs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { posix, WINDOWS } from "./support.mjs";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync, realpathSync, rmSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOT_HANDLED, REFUSED, ACTIONS, RUNNER, USER_HANDLER, TRUST_FILE,
  builtinFile, chain, checkCall, userHandler, actionArgs, runChain, token, shortError, outcome,
  parseTrust, serializeTrust, parseCheck, handlerState, handlerBanner,
} from "../mods/readlist/core/handlers.js";
import { CACHE_SCRIPT } from "../mods/readlist/core/preview.js";
import { THUMB_SECONDS } from "../mods/readlist/core/handlers.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOD = join(repo, "mods/readlist");
const RUN = join(MOD, RUNNER);
const MACOS = join(MOD, "handlers/macos.sh");
const LINUX = join(MOD, "handlers/linux.sh");
const SYS = "/usr/bin:/bin";

// The runner refuses a handler under a folder others can write (Linux's /tmp is one), so
// the trust tests need a private folder: the repo's test/.tmp (git-ignored), else the
// system's temporary folder when that is private (macOS).
const scratchRoots = [];
function privateBase() {
  for (const make of [() => { mkdirSync(join(repo, "test/.tmp"), { recursive: true, mode: 0o755 }); return mkdtempSync(join(repo, "test/.tmp/h-")); }, () => mkdtempSync(join(tmpdir(), "rl-h-"))]) {
    const dir = realpathSync(make());
    scratchRoots.push(dir);
    chmodSync(dir, 0o755);
    const probe = join(dir, "probe");
    writeFileSync(probe, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(probe, 0o755);
    if (spawnSync("sh", [RUN, "check", probe], { encoding: "utf8" }).stdout.startsWith("ok\t")) return dir;
  }
  return null;
}
const BASE = WINDOWS ? null : privateBase();
const needsPrivate = BASE ? {} : { skip: "no folder here that only this user can write (the runner would refuse every handler)" };
after(() => {
  for (const d of scratchRoots) rmSync(d, { recursive: true, force: true });
  try {
    if (readdirSync(join(repo, "test/.tmp")).length === 0) rmSync(join(repo, "test/.tmp"), { recursive: true });
  } catch {
    // Not made.
  }
});

let n = 0;
// An app home with the person's handler at readlist/handler: `body` is its shell code; the
// handler logs its argv (one per line, NUL-separated) to `log`.
function home(body = 'printf "%s\\0" "$@" > "$LOG"') {
  const dir = join(BASE, `home${n++}`);
  mkdirSync(join(dir, "readlist"), { recursive: true, mode: 0o755 });
  chmodSync(dir, 0o755);
  chmodSync(join(dir, "readlist"), 0o755);
  const log = join(dir, "log");
  const handler = join(dir, USER_HANDLER);
  writeFileSync(handler, `#!/bin/sh\nLOG='${log}'\n${body}\n`, { mode: 0o755 });
  chmodSync(handler, 0o755);
  return { dir, handler, log, argv: () => readFileSync(log, "utf8").split("\0").slice(0, -1) };
}
const sh = (args, opts = {}) => spawnSync("sh", args, { encoding: "utf8", env: { PATH: SYS, HOME: tmpdir(), ...opts.env }, timeout: 20000 });
const check = (handler) => parseCheck(sh([RUN, "check", handler]).stdout);

// ---- the interface ----

test("actionArgs: the item is the last argument, after --, and only an absolute path or an http(s) link", () => {
  assert.deepEqual(actionArgs("open", "/a/b c.md"), ["path", "/a/b c.md", "open"]);
  assert.deepEqual(actionArgs("thumbnail", "/a.pdf", ["800", "/c/h/thumb.png"]), ["path", "/a.pdf", "thumbnail", "800", "/c/h/thumb.png"]);
  assert.deepEqual(actionArgs("open-url", "https://x.dev/a?b=1"), ["url", "https://x.dev/a?b=1", "open-url"]);
  assert.equal(actionArgs("open", "relative.md"), null);
  assert.equal(actionArgs("open", "-rf"), null);
  assert.equal(actionArgs("open", "/a\0b"), null);
  assert.equal(actionArgs("open-url", "javascript:alert(1)"), null);
  assert.equal(actionArgs("open-url", "file:///etc/passwd"), null);
  assert.equal(actionArgs("open-url", "https://x.dev/a b"), null);
  assert.equal(actionArgs("delete", "/a"), null);
  assert.equal(actionArgs("preview-close", "/a", ["1", 2]), null);
  assert.deepEqual(ACTIONS, ["open", "reveal", "open-url", "preview", "preview-close", "thumbnail"]);
});

test("chain: the built-in handler per platform, the person's first only when turned on", () => {
  const trust = { path: "/h/readlist/handler", sha256: "a".repeat(64) };
  assert.equal(builtinFile("macos"), "macos.sh");
  assert.equal(builtinFile("linux"), "linux.sh");
  assert.equal(builtinFile("windows"), "windows.ps1");
  const off = chain("macos", "/h", null, "mods/readlist");
  assert.deepEqual(off, [{ who: "builtin", command: "sh", args: ["/h/mods/readlist/bin/run-handler", "builtin", "/h/mods/readlist/handlers/macos.sh"] }]);
  const on = chain("linux", "/h", trust, "mods/readlist");
  assert.deepEqual(on.map((h) => h.who), ["user", "builtin"]);
  assert.deepEqual(on[0].args, ["/h/mods/readlist/bin/run-handler", "user", "/h/readlist/handler", trust.path, trust.sha256]);
  assert.equal(on[0].tag, "aaaaaaaaaaaa");
  assert.equal(on[1].args[2], "/h/mods/readlist/handlers/linux.sh");
  // Windows: both through run-handler.ps1 with pwsh -File, every argument its own.
  const PS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
  const wtrust = { path: "C:\\h\\readlist\\handler.ps1", sha256: "a".repeat(64) };
  assert.deepEqual(chain("windows", "C:\\h", null, "mods/readlist"),
    [{ who: "builtin", command: "pwsh", args: [...PS, "C:\\h\\mods\\readlist\\bin\\windows\\run-handler.ps1", "builtin", "C:\\h\\mods\\readlist\\handlers\\windows.ps1"] }]);
  const won = chain("windows", "C:\\h", wtrust, "mods/readlist");
  assert.deepEqual(won.map((h) => [h.who, h.command]), [["user", "pwsh"], ["builtin", "pwsh"]]);
  assert.deepEqual(won[0].args.slice(PS.length + 1), ["user", "C:\\h\\readlist\\handler.ps1", wtrust.path, wtrust.sha256]);
  assert.equal(userHandler("windows"), "readlist/handler.ps1");
  assert.equal(userHandler("macos"), USER_HANDLER);
  assert.deepEqual(checkCall("macos", "/h", "mods/readlist"), { command: "sh", args: ["/h/mods/readlist/bin/run-handler", "check", "/h/readlist/handler"] });
  assert.deepEqual(checkCall("windows", "C:\\h", "mods/readlist"), { command: "pwsh", args: [...PS, "C:\\h\\mods\\readlist\\bin\\windows\\run-handler.ps1", "check", "C:\\h\\readlist\\handler.ps1"] });
  assert.equal(USER_HANDLER, "readlist/handler");
  assert.equal(TRUST_FILE, "readlist/trust.json");
});

test("an item's title and note never reach a handler; only its path does", () => {
  const evil = { path: "/a/plan.md", title: "$(touch /tmp/pwned)", note: "`rm -rf ~`; echo hi" };
  for (const h of chain("macos", "/h", { path: "/h/readlist/handler", sha256: "b".repeat(64) }, "mods/readlist")) {
    const argv = [...h.args, ...actionArgs("open", evil.path)];
    assert.ok(!argv.includes(evil.title) && !argv.includes(evil.note));
    assert.equal(argv.at(-2), evil.path);
  }
});

test("outcome: done, not handled, refused, failed; errors are one short line", () => {
  assert.equal(outcome({ code: 0, stdout: "123\n", stderr: "" }).status, "ok");
  assert.equal(outcome({ code: NOT_HANDLED, stdout: "", stderr: "" }).status, "pass");
  assert.equal(outcome({ code: REFUSED, stdout: "", stderr: "readlist: /h changed since you turned it on\n" }).status, "refused");
  assert.equal(outcome({ code: REFUSED, stdout: "", stderr: "my own error\n" }).status, "failed", "11 from the handler itself is a failure");
  assert.deepEqual(outcome({ code: 1, stdout: "", stderr: "\n  first problem  \nsecond\n" }), { status: "failed", stdout: "", message: "first problem" });
  assert.equal(outcome({ code: 4, stdout: "", stderr: "" }).message, "it exited with 4");
  assert.equal(outcome(null).message, "it could not start");
  assert.equal(shortError("x".repeat(500), 1).length, 160);
  assert.equal(shortError("readlist: refused here", 11), "refused here");
  assert.equal(token("4242\n"), "4242");
  assert.equal(token("a b\n"), "");
  assert.equal(token("$(rm -rf /)"), "");
  assert.equal(token(""), "");
});

test("runChain: not handled falls through to the next handler, a failure stops", async () => {
  const list = chain("macos", "/h", { path: "/h/readlist/handler", sha256: "c".repeat(64) }, "mods/readlist");
  const calls = [];
  const fake = (codes) => async (command, args) => {
    const who = args[1] === "user" ? "user" : "builtin";
    calls.push(who);
    return { code: codes[who], stdout: who === "builtin" ? "77\n" : "", stderr: codes[who] === REFUSED ? "readlist: it changed\n" : codes[who] ? `${who} broke\n` : "" };
  };
  let r = await runChain(list, "preview", "/a.md", { exec: fake({ user: NOT_HANDLED, builtin: 0 }) });
  assert.deepEqual(calls, ["user", "builtin"]);
  assert.deepEqual(r, { status: "ok", stdout: "77\n", message: "", who: "builtin" });
  calls.length = 0;
  r = await runChain(list, "open", "/a.md", { exec: fake({ user: 0, builtin: 0 }) });
  assert.deepEqual(calls, ["user"]);
  assert.equal(r.who, "user");
  calls.length = 0;
  r = await runChain(list, "open", "/a.md", { exec: fake({ user: 1, builtin: 0 }) });
  assert.deepEqual(calls, ["user"], "a failing handler is not followed by another one");
  assert.deepEqual([r.status, r.message], ["failed", "user broke"]);
  calls.length = 0;
  const refused = [];
  r = await runChain(list, "open", "/a.md", { exec: fake({ user: REFUSED, builtin: 0 }), onRefused: (m) => refused.push(m) });
  assert.deepEqual(calls, ["user", "builtin"]);
  assert.deepEqual(refused, ["it changed"]);
  assert.equal(r.who, "builtin");
  calls.length = 0;
  const passed = [];
  r = await runChain(list, "thumbnail", "/a.pdf", { exec: fake({ user: NOT_HANDLED, builtin: NOT_HANDLED }), extra: () => ["800", "/o.png"], onPass: (h) => passed.push(h.who) });
  assert.deepEqual([r.status, passed], ["pass", ["user", "builtin"]]);
  calls.length = 0;
  r = await runChain(list, "preview-close", "/a.md", { exec: fake({ user: 0, builtin: 0 }), only: "builtin", extra: () => ["77", "same"] });
  assert.deepEqual(calls, ["builtin"]);
  calls.length = 0;
  r = await runChain(list, "preview", "/a.md", { exec: fake({ user: NOT_HANDLED, builtin: 0 }), skip: (h) => h.who === "builtin" });
  assert.deepEqual([calls, r.status], [["user"], "pass"]);
  calls.length = 0;
  r = await runChain(list, "open", "relative", { exec: fake({ user: 0, builtin: 0 }) });
  assert.deepEqual([calls, r.status], [[], "failed"], "a bad item never runs anything");
  r = await runChain(list, "open", "/a", { exec: async () => { throw new Error("spawn sh ENOENT"); } });
  assert.deepEqual([r.status, r.message], ["failed", "spawn sh ENOENT"], "a handler that cannot start is an error, not a crash");
});

test("opt-in: off unless trust.json names the file and its hash; on/off/changed/moved/gone/refused", () => {
  const sha = "d".repeat(64);
  assert.equal(parseTrust(null), null);
  assert.equal(parseTrust("not json"), null);
  assert.equal(parseTrust('{"v":1,"handler":null}'), null);
  assert.equal(parseTrust('{"v":1,"handler":{"path":"relative","sha256":"' + sha + '"}}'), null);
  assert.equal(parseTrust('{"v":1,"handler":{"path":"/h","sha256":"short"}}'), null);
  const t = { path: "/h/readlist/handler", sha256: sha, at: "2026-11-09T00:00:00.000Z" };
  assert.deepEqual(parseTrust(serializeTrust(t)), t);
  assert.equal(parseTrust(serializeTrust(null)), null);
  const ok = { state: "ok", path: t.path, sha256: sha };
  assert.deepEqual(handlerState(null, ok), { state: "off" });
  assert.deepEqual(handlerState(t, ok), { state: "on", path: t.path });
  assert.deepEqual(handlerState(t, { ...ok, sha256: "e".repeat(64) }), { state: "changed", path: t.path });
  assert.deepEqual(handlerState(t, { ...ok, path: "/elsewhere" }), { state: "moved", path: "/elsewhere", was: t.path });
  assert.deepEqual(handlerState(t, { state: "missing" }), { state: "missing" });
  assert.deepEqual(handlerState(t, { state: "refused", why: "x" }), { state: "refused", why: "x" });
  assert.equal(handlerBanner({ state: "on" }, "/h"), null);
  assert.equal(handlerBanner({ state: "off" }, "/h"), null);
  assert.deepEqual(handlerBanner({ state: "changed", path: "/h/r" }, "/h/r"),
    { text: "Your handler /h/r changed since you turned it on, so the list uses its built-in actions until you confirm it.", confirm: true });
  assert.equal(handlerBanner({ state: "moved", path: "/b", was: "/a" }, "/h").confirm, true);
  assert.match(handlerBanner({ state: "refused", why: "it is group-writable" }, "/h").text, /^Your handler \/h is not used: it is group-writable\.$/);
  assert.equal(handlerBanner({ state: "missing" }, "/h").confirm, false);
  assert.deepEqual(parseCheck("ok\t/h/x\t" + sha + "\n"), { state: "ok", path: "/h/x", sha256: sha });
  assert.deepEqual(parseCheck("missing\n"), { state: "missing" });
  assert.deepEqual(parseCheck("refused\twhy not\n"), { state: "refused", why: "why not" });
  assert.deepEqual(parseCheck(""), { state: "refused", why: "it could not be checked" });
});

// ---- the runner: checks before the person's handler runs ----

test("run-handler check: a private executable passes, with its real path and hash", { ...needsPrivate, ...posix }, () => {
  const h = home();
  const c = check(h.handler);
  assert.equal(c.state, "ok");
  assert.equal(c.path, h.handler);
  assert.equal(c.sha256.length, 64);
  assert.deepEqual(check(join(h.dir, "readlist/none")), { state: "missing" });
  assert.deepEqual(check(join(h.dir, "nofolder/handler")), { state: "missing" });
});

test("run-handler runs the person's handler with argv, the path resolved, nothing interpolated", { ...needsPrivate, ...posix }, () => {
  const h = home();
  const c = check(h.handler);
  const items = join(h.dir, "items");
  mkdirSync(items);
  symlinkSync(items, join(h.dir, "via-link"));
  const hostile = [
    "$(touch PWNED).md", "`touch PWNED`.md", "a; touch PWNED.md", "it's \"quoted\".md", "new\nline.md",
    "-- --version", " lead and trail ", "*", "back\\slash", "héllo wörld.md",
  ];
  for (const name of hostile) {
    const r = sh([RUN, "user", h.handler, c.path, c.sha256, "path", join(h.dir, "via-link", name), "open"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(h.argv(), ["open", "--", join(items, name)], name);
  }
  assert.ok(!existsSync(join(h.dir, "PWNED")) && !existsSync("PWNED") && !existsSync(join(items, "PWNED")));
  const r = sh([RUN, "user", h.handler, c.path, c.sha256, "path", "/tmp/a.pdf", "thumbnail", "800", "/c/h/thumb.png"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.argv(), ["thumbnail", "800", "/c/h/thumb.png", "--", `${realpathSync("/tmp")}/a.pdf`]);
  sh([RUN, "user", h.handler, c.path, c.sha256, "url", "https://x.dev/$(id)", "open-url"]);
  assert.deepEqual(h.argv(), ["open-url", "--", "https://x.dev/$(id)"]);
});

test("run-handler refuses a link that is not http(s) and a path that is not absolute", { ...needsPrivate, ...posix }, () => {
  const h = home();
  const c = check(h.handler);
  for (const [kind, item] of [["url", "javascript:alert(1)"], ["url", "file:///etc/passwd"], ["path", "relative.md"], ["path", "-rf"], ["kind", "/a"]]) {
    const r = sh([RUN, "user", h.handler, c.path, c.sha256, kind, item, "open"]);
    assert.notEqual(r.status, 0, item);
    assert.ok(!existsSync(h.log), `${item} reached the handler`);
  }
});

test("run-handler refuses the person's handler once it changed, and runs nothing", { ...needsPrivate, ...posix }, () => {
  const h = home();
  const c = check(h.handler);
  appendFileSync(h.handler, "echo extra\n");
  const r = sh([RUN, "user", h.handler, c.path, c.sha256, "path", "/a.md", "open"]);
  assert.equal(r.status, REFUSED);
  assert.match(r.stderr, /^readlist: .*handler changed since you turned it on\n$/);
  assert.ok(!existsSync(h.log));
  assert.equal(outcome({ code: r.status, stderr: r.stderr }).status, "refused");
  assert.equal(handlerState({ path: c.path, sha256: c.sha256 }, check(h.handler)).state, "changed");
});

test("run-handler refuses when the location now leads to another file", { ...needsPrivate, ...posix }, () => {
  const h = home();
  const a = join(h.dir, "readlist/a"), b = join(h.dir, "readlist/b");
  writeFileSync(a, readFileSync(h.handler), { mode: 0o755 });
  writeFileSync(b, readFileSync(h.handler), { mode: 0o755 });
  chmodSync(a, 0o755);
  chmodSync(b, 0o755);
  rmSync(h.handler);
  symlinkSync(a, h.handler);
  const c = check(h.handler);
  assert.equal(c.path, a, "a link is followed to its file");
  rmSync(h.handler);
  symlinkSync(b, h.handler);
  const r = sh([RUN, "user", h.handler, c.path, c.sha256, "path", "/a.md", "open"]);
  assert.equal(r.status, REFUSED);
  assert.match(r.stderr, /now leads to .*\/b, not the .*\/a you turned on/);
  assert.equal(handlerState({ path: c.path, sha256: c.sha256 }, check(h.handler)).state, "moved");
  assert.ok(!existsSync(h.log));
});

test("run-handler refuses bad ownership and permissions, and links to such files", { ...needsPrivate, ...posix }, () => {
  const refused = (path, re) => {
    const c = check(path);
    assert.equal(c.state, "refused", `${path}: ${JSON.stringify(c)}`);
    assert.match(c.why, re);
    const r = sh([RUN, "user", path, path, "f".repeat(64), "path", "/a.md", "open"]);
    assert.equal(r.status, REFUSED);
  };
  // Group- and world-writable files.
  let h = home();
  chmodSync(h.handler, 0o775);
  refused(h.handler, /not yours alone/);
  chmodSync(h.handler, 0o757);
  refused(h.handler, /not yours alone/);
  // Not executable.
  chmodSync(h.handler, 0o644);
  refused(h.handler, /not executable/);
  // In a folder others can write, or below one.
  h = home();
  chmodSync(join(h.dir, "readlist"), 0o777);
  refused(h.handler, /can be changed by another user/);
  chmodSync(join(h.dir, "readlist"), 0o755);
  chmodSync(h.dir, 0o775);
  refused(h.handler, /can be changed by another user/);
  chmodSync(h.dir, 0o755);
  // A link to a file another user (root) owns.
  h = home();
  rmSync(h.handler);
  symlinkSync("/bin/sh", h.handler);
  refused(h.handler, /not yours alone/);
  // A link to a fine file in a folder others can write.
  h = home();
  const open = join(h.dir, "open");
  mkdirSync(open);
  chmodSync(open, 0o777);
  writeFileSync(join(open, "x"), "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(join(open, "x"), 0o755);
  rmSync(h.handler);
  symlinkSync(join(open, "x"), h.handler);
  refused(h.handler, /can be changed by another user/);
  // A link that goes nowhere, a loop, a folder.
  h = home();
  rmSync(h.handler);
  symlinkSync(join(h.dir, "nothing"), h.handler);
  refused(h.handler, /does not exist/);
  h = home();
  rmSync(h.handler);
  symlinkSync(h.handler, h.handler);
  refused(h.handler, /loop of links/);
  h = home();
  rmSync(h.handler);
  mkdirSync(h.handler);
  refused(h.handler, /not a regular file/);
});

test("run-handler runs a built-in handler from the mod with sh, without the person's checks", posix, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rl-h-")));
  const log = join(dir, "log");
  const file = join(dir, "builtin.sh");
  writeFileSync(file, `printf '%s\\n' "$@" > '${log}'\n`, { mode: 0o666 });
  const r = sh([RUN, "builtin", file, "path", `${dir}/x/../a b.md`, "reveal"]);
  assert.equal(r.status, 1, "a folder that is gone is an error");
  mkdirSync(join(dir, "x"));
  const ok = sh([RUN, "builtin", file, "path", `${dir}/x/../a b.md`, "reveal"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(log, "utf8"), `reveal\n--\n${dir}/a b.md\n`);
  rmSync(dir, { recursive: true, force: true });
});

test("a handler that passes falls through to the built-in one, end to end", { ...needsPrivate, ...posix }, async () => {
  const h = home('case $1 in reveal) exit 10;; *) printf "%s\\0" "$@" > "$LOG";; esac');
  const c = check(h.handler);
  const blog = join(h.dir, "builtin.log");
  const modDir = join(h.dir, "mods/readlist");
  mkdirSync(join(modDir, "handlers"), { recursive: true });
  mkdirSync(join(modDir, "bin"));
  writeFileSync(join(modDir, RUNNER), readFileSync(RUN));
  writeFileSync(join(modDir, "handlers/macos.sh"), `printf '%s\\n' "$@" > '${blog}'\n`);
  const list = chain("macos", h.dir, { path: c.path, sha256: c.sha256 }, "mods/readlist");
  const exec = (command, args) => promisify(execFile)(command, args, { env: { PATH: SYS } }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
  const target = join(h.dir, "note.md");
  let r = await runChain(list, "open", target, { exec });
  assert.equal(r.who, "user");
  assert.deepEqual(h.argv(), ["open", "--", target]);
  assert.ok(!existsSync(blog));
  r = await runChain(list, "reveal", target, { exec });
  assert.equal(r.who, "builtin");
  assert.equal(readFileSync(blog, "utf8"), `reveal\n--\n${target}\n`);
  // Changed: refused, the built-in one opens, and the person's never runs.
  rmSync(h.log);
  appendFileSync(h.handler, "\n");
  const refused = [];
  r = await runChain(list, "open", target, { exec, onRefused: (m) => refused.push(m) });
  assert.equal(r.who, "builtin");
  assert.match(refused[0], /changed since you turned it on/);
  assert.ok(!existsSync(h.log));
  // Turned off: only the built-in one is in the chain.
  assert.deepEqual(chain("macos", h.dir, parseTrust(serializeTrust(null)), "mods/readlist").map((x) => x.who), ["builtin"]);
});

// ---- the built-in handlers: the same commands as before ----

function stubs(progs) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rl-stub-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(progs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { dir, bin, log: join(dir, "log"), args: () => readFileSync(join(dir, "log"), "utf8").split("\n").slice(0, -1) };
}
const logArgs = (log) => `for a; do printf '%s\\n' "$a"; done >> '${log}'`;
const handler = (file, args, path) => {
  const started = Date.now();
  const r = spawnSync("/bin/sh", [file, ...args], { encoding: "utf8", env: { PATH: path, HOME: tmpdir() }, timeout: 15000 });
  return { ...r, ms: Date.now() - started };
};

test("macOS: open, open -R and qlmanage exactly as before", posix, () => {
  const s = stubs({});
  for (const p of ["open", "qlmanage"]) writeFileSync(join(s.bin, p), `#!/bin/sh\necho ${p} >> '${s.log}'\n${logArgs(s.log)}\n`, { mode: 0o755 });
  writeFileSync(join(s.bin, "osascript"), "#!/bin/sh\n", { mode: 0o755 });
  const path = "/a/b c; $(x).md";
  let r = handler(MACOS, ["open", "--", path], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  r = handler(MACOS, ["reveal", "--", path], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  r = handler(MACOS, ["preview", "--", path], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\n$/, "prints Quick Look's pid as the token");
  // The panel runs in the background: give it a moment to log.
  for (let i = 0; i < 50 && s.args().length < 8; i++) spawnSync("sleep", ["0.05"]);
  assert.deepEqual(s.args(), ["open", path, "open", "-R", path, "qlmanage", "-p", path]);
  assert.equal(handler(MACOS, ["open-url", "--", "https://x.dev"], SYS).status, NOT_HANDLED);
  assert.equal(handler(MACOS, ["open", path], SYS).status, 2, "no -- separator: refused");
});

test("macOS: preview brings the Quick Look panel to the front without holding up its token", posix, () => {
  const s = stubs({ qlmanage: "exec sleep 30" });
  // The activator stays running as long as it likes: the handler returns at once anyway.
  writeFileSync(join(s.bin, "osascript"), `#!/bin/sh\n${logArgs(s.log)}\nexec sleep 5\n`, { mode: 0o755 });
  const r = handler(MACOS, ["preview", "--", "/a/b.md"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
  const pid = r.stdout.trim();
  assert.match(pid, /^\d+$/);
  const logged = () => (existsSync(s.log) ? s.args() : []);
  for (let i = 0; i < 50 && logged().length < 4; i++) spawnSync("sleep", ["0.05"]);
  const a = logged();
  spawnSync("kill", [pid]);
  assert.deepEqual([a[0], a[1], a[2], a.at(-1)], ["-l", "JavaScript", "-e", pid], "osascript is given Quick Look's pid");
  const script = a.slice(3, -1).join("\n");
  assert.match(script, /runningApplicationWithProcessIdentifier\(pid\)/);
  assert.match(script, /activateWithOptions/);
  assert.doesNotMatch(script, /System Events|Application\(/, "no Apple Events, so no Automation prompt");
});

test("macOS: preview still gives its token when osascript is missing", posix, () => {
  const s = stubs({ qlmanage: "exec /bin/sleep 30" });
  const r = handler(MACOS, ["preview", "--", "/a/b.md"], s.bin);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\n$/);
  spawnSync("kill", [r.stdout.trim()]);
});

test("macOS: preview-close kills that pid only while it is Quick Look", posix, () => {
  const sleeper = () => spawnSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim();
  const alive = (pid) => spawnSync("kill", ["-0", pid]).status === 0;
  const ql = stubs({ ps: 'echo " /System/Library/Frameworks/QuickLook.framework/Resources/qlmanage"' });
  let pid;
  for (const how of ["same", "other"]) {
    pid = sleeper();
    const r = handler(MACOS, ["preview-close", pid, how, "--", "/a.md"], `${ql.bin}:${SYS}`);
    assert.equal(r.status, 0, r.stderr);
    for (let i = 0; i < 40 && alive(pid); i++) spawnSync("sleep", ["0.05"]);
    assert.ok(!alive(pid), how);
  }
  const other = stubs({ ps: 'echo "/bin/sleep"' });
  pid = sleeper();
  assert.equal(handler(MACOS, ["preview-close", pid, "same", "--", "/a.md"], `${other.bin}:${SYS}`).status, 1);
  assert.ok(alive(pid), "another program is left running");
  spawnSync("kill", [pid]);
  assert.equal(handler(MACOS, ["preview-close", "1; kill 1", "same", "--", "/a.md"], `${ql.bin}:${SYS}`).status, 1, "a token that is not a pid");
  assert.equal(handler(MACOS, ["preview-close", "", "same", "--", "/a.md"], `${ql.bin}:${SYS}`).status, 1);
});

test("macOS: thumbnail runs qlmanage -t into its own folder and moves the PNG to OUT", posix, () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "qlmanage"), `#!/bin/sh\n${logArgs(s.log)}\nwhile [ $# -gt 1 ]; do [ "$1" = -o ] && d=$2; shift; done\necho png > "$d/$(basename "$1").png"\n`, { mode: 0o755 });
  const out = join(s.dir, "h");
  mkdirSync(out);
  const r = handler(MACOS, ["thumbnail", "800", join(out, "thumb.png"), "--", "/a/page one.html"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(out, "thumb.png"), "utf8"), "png\n");
  assert.deepEqual(readdirSync(out), ["thumb.png"], "its scratch folder is gone");
  const a = s.args();
  assert.deepEqual([a[0], a[1], a[2], a[3], a[5]], ["-t", "-s", "800", "-o", "/a/page one.html"]);
  assert.ok(a[4].startsWith(`${out}/ql.`));
});

test("macOS: a Quick Look thumbnail that never returns is stopped and says so", posix, () => {
  const s = stubs({ qlmanage: "exec sleep 600" });
  const fast = join(s.dir, "macos.sh");
  const text = readFileSync(MACOS, "utf8").replace("sleep 20\n", "sleep 1\n");
  assert.notEqual(text, readFileSync(MACOS, "utf8"));
  writeFileSync(fast, text);
  mkdirSync(join(s.dir, "h"));
  const r = handler(fast, ["thumbnail", "800", join(s.dir, "h/thumb.png"), "--", "/a/x.bin"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trim(), "Quick Look has no thumbnail for this file");
  assert.ok(r.ms < 8000, `took ${r.ms} ms`);
});

// A file:// URI the way the Linux branch made it in JavaScript (core/platform.js fileUri).
const fileUri = (path) => `file://${path.split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/")}`;

test("Linux: reveal asks the file manager over D-Bus with the same URI as before", posix, () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "gdbus"), `#!/bin/sh\n${logArgs(s.log)}\n`, { mode: 0o755 });
  for (const path of ["/a/b c.md", "/home/me/a b/it's (1)!.md", "/x/100%/#?.md", "/x/back\\slash\"q", "/x/héllo", "/x/~a-b_c.d", "/x/\nnew", "/x/$(id)"]) {
    rmSync(s.log, { force: true });
    const r = handler(LINUX, ["reveal", "--", path], `${s.bin}:${SYS}`);
    assert.equal(r.status, 0, r.stderr);
    const args = s.args();
    assert.deepEqual(args, ["call", "--session", "--timeout", "5", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1",
      "--method", "org.freedesktop.FileManager1.ShowItems", `['${fileUri(path)}']`, "''"], path);
    assert.doesNotMatch(args[10].slice(2, -2), /['\\]/);
  }
});

test("Linux: reveal falls back to xdg-open on the folder, then says what is missing", posix, () => {
  const s = stubs({ gdbus: "exit 1" });
  writeFileSync(join(s.bin, "xdg-open"), `#!/bin/sh\n${logArgs(s.log)}\n`, { mode: 0o755 });
  let r = handler(LINUX, ["reveal", "--", "/a/b c.md"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.args(), ["/a"]);
  r = handler(LINUX, ["reveal", "--", "/a/b.md"], stubs({}).bin);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /no file manager answered, and xdg-open is not installed/);
});

test("Linux: open runs xdg-open with the path as one argument, as before", posix, () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$#" "$1" > '${s.log}'\n`, { mode: 0o755 });
  const r = handler(LINUX, ["open", "--", "/a/b c; rm -rf x.md"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(s.log, "utf8"), "1\n/a/b c; rm -rf x.md\n");
});

test("Linux: open says xdg-open is missing, and passes on its failure and message", posix, () => {
  let r = handler(LINUX, ["open", "--", "/a/b.md"], stubs({}).bin);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /xdg-open is not installed \(it comes with xdg-utils\)/);
  r = handler(LINUX, ["open", "--", "/a/b.md"], `${stubs({ "xdg-open": "exit 3" }).bin}:${SYS}`);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /xdg-open found no program to open it with/);
  r = handler(LINUX, ["open", "--", "/a/b.md"], `${stubs({ "xdg-open": "echo 'gio: no such app' >&2; exit 4" }).bin}:${SYS}`);
  assert.equal(r.status, 4);
  assert.equal(r.stderr.trim(), "gio: no such app");
  r = handler(LINUX, ["open", "--", "/a/b.md"], `${stubs({ "xdg-open": "exit 10" }).bin}:${SYS}`);
  assert.equal(r.status, 1, "an opener's 10 is not taken as not handled");
});

test("Linux: open returns while an opener that stays running keeps going", posix, () => {
  const r = handler(LINUX, ["open", "--", "/a/b.md"], `${stubs({ "xdg-open": "sleep 6" }).bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.ms < 5500, `took ${r.ms} ms`);
});

test("Linux: Space shows the file in GNOME Sushi; Space again on it closes it", posix, () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "gdbus"), `#!/bin/sh\n${logArgs(s.log)}\n`, { mode: 0o755 });
  let r = handler(LINUX, ["preview", "--", "/a/b c.md"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.args().slice(-4), ["org.gnome.NautilusPreviewer2.ShowFile", "'file:///a/b%20c.md'", "''", "false"]);
  r = handler(LINUX, ["preview-close", "", "same", "--", "/a/b c.md"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.args().slice(-4), ["org.gnome.NautilusPreviewer2.ShowFile", "'file:///a/b%20c.md'", "''", "true"]);
  const before = s.args().length;
  r = handler(LINUX, ["preview-close", "", "other", "--", "/a/b c.md"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0);
  assert.equal(s.args().length, before, "another item: Sushi keeps its window for the next file");
});

test("Linux: Sushi's older interface is tried before giving up", posix, () => {
  const s = stubs({});
  writeFileSync(join(s.bin, "gdbus"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${s.log}'\ncase "$*" in *NautilusPreviewer.ShowFile*) exit 0;; esac\nexit 1\n`, { mode: 0o755 });
  const r = handler(LINUX, ["preview", "--", "/a"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 0);
  assert.match(readFileSync(s.log, "utf8"), /NautilusPreviewer\.ShowFile 'file:\/\/\/a' 0 false/);
});

test("Linux: no Sushi or no gdbus is not handled, with the reason the toast shows", posix, () => {
  const none = stubs({ gdbus: "echo 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown' >&2; exit 1" });
  let r = handler(LINUX, ["preview", "--", "/a"], `${none.bin}:${SYS}`);
  assert.equal(r.status, NOT_HANDLED);
  assert.equal(shortError(r.stderr), "Space's preview window needs GNOME Sushi (the sushi package)");
  r = handler(LINUX, ["preview", "--", "/a"], stubs({}).bin);
  assert.equal(r.status, NOT_HANDLED);
  assert.equal(shortError(r.stderr), "Space's preview window needs gdbus and GNOME Sushi");
});

test("Linux: Sushi that does not answer is a failure, not missing, so Space asks again", posix, () => {
  const s = stubs({ gdbus: "echo 'Error: Timeout was reached' >&2; exit 1" });
  let r = handler(LINUX, ["preview", "--", "/a"], `${s.bin}:${SYS}`);
  assert.equal(r.status, 1);
  assert.equal(shortError(r.stderr), "GNOME Sushi did not answer");
  const nobus = stubs({ gdbus: "echo 'Error connecting: Cannot autolaunch D-Bus without X11 $DISPLAY' >&2; exit 1" });
  r = handler(LINUX, ["preview", "--", "/a"], `${nobus.bin}:${SYS}`);
  assert.equal(r.status, NOT_HANDLED, "no session bus: no Sushi this session");
});

test("Linux: no thumbnails and no link opener: not handled", posix, () => {
  assert.equal(handler(LINUX, ["thumbnail", "800", "/o/thumb.png", "--", "/a.pdf"], SYS).status, NOT_HANDLED);
  assert.equal(handler(LINUX, ["open-url", "--", "https://x.dev"], SYS).status, NOT_HANDLED);
});

// ---- thumbnails through CACHE_SCRIPT ----

test("CACHE_SCRIPT asks a handler for a thumbnail: made, not handled, failed, too slow", posix, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rl-pv-")));
  const cache = join(dir, ".cache");
  const id = "0123456789abcdef";
  const make = (body, script = CACHE_SCRIPT) => {
    const f = join(dir, `h${n++}.sh`);
    writeFileSync(f, body);
    return (out) => spawnSync("sh", ["-c", script, "readlist", join(dir, "a.pdf"), cache, join(cache, out), id, "800", "sh", f], { encoding: "utf8", timeout: 20000 });
  };
  // Made: the argv, and the PNG moved into place.
  // The handler is given as its command and args, then `path SRC thumbnail SIZE OUT`, as
  // chain's entries take it (bin/run-handler then makes it `thumbnail SIZE OUT -- SRC`).
  let r = make(`printf '%s\\n' "$@" > '${dir}/argv'; echo png > "$5"`)(`${id}-1-1-800.png`);
  assert.equal(r.status, 0, r.stderr);
  const argv = readFileSync(join(dir, "argv"), "utf8").split("\n");
  assert.deepEqual(argv.slice(0, 4), ["path", join(dir, "a.pdf"), "thumbnail", "800"]);
  assert.match(argv[4], /\/\.cache\/\.make\.[^/]+\/h\/thumb\.png$/);
  assert.equal(argv.length, 6);
  assert.deepEqual(readdirSync(cache), [`${id}-1-1-800.png`]);
  // Not handled: 10, nothing left behind.
  r = make("exit 10")(`${id}-2-1-800.png`);
  assert.equal(r.status, NOT_HANDLED);
  assert.deepEqual(readdirSync(cache), [`${id}-1-1-800.png`]);
  // Failed: its message; or a handler that said done but made nothing.
  r = make("echo 'cannot draw this' >&2; exit 3")(`${id}-3-1-800.png`);
  assert.deepEqual([r.status, r.stderr], [3, "cannot draw this\n"]);
  r = make("exit 0")(`${id}-3-1-800.png`);
  assert.deepEqual([r.status, r.stderr], [1, "the handler made no thumbnail\n"]);
  // Too slow: stopped by the watchdog.
  const started = Date.now();
  r = make("exec sleep 600", CACHE_SCRIPT.replace(`sleep ${THUMB_SECONDS};`, "sleep 1;"))(`${id}-4-1-800.png`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /took over/);
  assert.ok(Date.now() - started < 8000);
  assert.deepEqual(readdirSync(cache), [`${id}-1-1-800.png`], "no temporary folder left");
  rmSync(dir, { recursive: true, force: true });
});

test("CACHE_SCRIPT makes a real Quick Look thumbnail through the built-in handler (macOS)", { skip: posix.skip ?? process.platform !== "darwin" }, () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rl-pv-")));
  const cache = join(dir, ".cache");
  const src = join(dir, "page one.html");
  writeFileSync(src, "<h1 style='color:red'>Hello</h1>");
  const out = join(cache, "0123456789abcdef-1-1-800.png");
  const [h] = chain("macos", "/x", null, "mods/readlist");
  const r = spawnSync("sh", ["-c", CACHE_SCRIPT, "readlist", src, cache, out, "0123456789abcdef", "800", h.command, RUN, "builtin", MACOS], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(out));
  assert.deepEqual(readdirSync(cache), ["0123456789abcdef-1-1-800.png"]);
  rmSync(dir, { recursive: true, force: true });
});

test("the handler scripts parse under sh and dash", posix, () => {
  for (const file of [RUN, MACOS, LINUX]) {
    const r = spawnSync("/bin/sh", ["-n", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    if (existsSync("/bin/dash") || existsSync("/usr/bin/dash")) {
      const d = spawnSync("dash", ["-n", file], { encoding: "utf8" });
      assert.equal(d.status, 0, d.stderr);
    }
  }
  const r = spawnSync("sh", ["-n", "-c", CACHE_SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
