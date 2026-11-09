import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, statSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARK, RL_STATUS_SCRIPT, INSTALL_RL_SCRIPT, parseRlStatus, rlBanner, installToast } from "../mods/readlist/core/install.js";

import { repo, posix } from "./support.mjs";
const rl = join(repo, "mods/readlist/bin/rl");

// A scratch home, and a run of a script there with PATH set to `path` (folders under it).
function scratch() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "rl-install-")));
  const run = (script, dirs, ...args) => execFileSync("sh", ["-c", script, "t", ...args], {
    encoding: "utf8",
    env: { HOME: home, PATH: [...dirs.map((d) => join(home, d)), "/usr/bin", "/bin"].join(":") },
  });
  return { home, run };
}

test("the mod's rl carries the mark", () => {
  assert.ok(readFileSync(rl, "utf8").includes(MARK));
});

test("RL_STATUS_SCRIPT tells missing, off PATH, ok and another program", posix, () => {
  const { home, run } = scratch();
  assert.deepEqual(parseRlStatus(run(RL_STATUS_SCRIPT, [".local/bin"])), { state: "missing", path: "" });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(join(home, ".local/bin/rl"), readFileSync(rl), { mode: 0o755 });
  assert.deepEqual(parseRlStatus(run(RL_STATUS_SCRIPT, [])), { state: "offpath", path: "~/.local/bin/rl" });
  assert.deepEqual(parseRlStatus(run(RL_STATUS_SCRIPT, [".local/bin"])), { state: "ok", path: "~/.local/bin/rl" });
  mkdirSync(join(home, "other"));
  writeFileSync(join(home, "other/rl"), "#!/bin/sh\necho readline\n", { mode: 0o755 });
  assert.deepEqual(parseRlStatus(run(RL_STATUS_SCRIPT, ["other", ".local/bin"])), { state: "other", path: "~/other/rl" });
  assert.equal(parseRlStatus("garbage").state, "unknown");
});

test("INSTALL_RL_SCRIPT copies, then reports the same file, and updates an older copy", posix, () => {
  const { home, run } = scratch();
  const dest = join(home, ".local/bin/rl");
  let out = run(INSTALL_RL_SCRIPT, [".local/bin"], rl);
  assert.equal(out, "installed\t~/.local/bin/rl\t1\t~/.local/bin/rl\n");
  assert.deepEqual(readFileSync(dest), readFileSync(rl));
  assert.equal(statSync(dest).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(join(home, ".local/bin")), ["rl"], "no temp file left");
  assert.equal(run(INSTALL_RL_SCRIPT, [".local/bin"], rl), "same\t~/.local/bin/rl\t1\t~/.local/bin/rl\n");
  writeFileSync(dest, `#!/bin/sh\n# ${MARK}\necho old\n`);
  assert.equal(run(INSTALL_RL_SCRIPT, [".local/bin"], rl).split("\t")[0], "updated");
  assert.deepEqual(readFileSync(dest), readFileSync(rl));
  // The installed copy works.
  const id = execFileSync(dest, ["add", "https://example.com/a"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin", READING_LIST_DIR: join(home, "list") } });
  assert.match(id.trim(), /^[0-9a-f]{16}$/);
});

test("INSTALL_RL_SCRIPT never replaces another program or a link", posix, () => {
  const { home, run } = scratch();
  const dest = join(home, ".local/bin/rl");
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  writeFileSync(dest, "#!/bin/sh\necho readline\n");
  assert.equal(run(INSTALL_RL_SCRIPT, [".local/bin"], rl).split("\t")[0], "other");
  assert.equal(readFileSync(dest, "utf8"), "#!/bin/sh\necho readline\n");

  const { home: home2, run: run2 } = scratch();
  const old = join(home2, "checkout-rl");
  writeFileSync(old, `#!/bin/sh\n# ${MARK}\necho old checkout\n`);
  mkdirSync(join(home2, ".local/bin"), { recursive: true });
  symlinkSync(old, join(home2, ".local/bin/rl"));
  assert.equal(run2(INSTALL_RL_SCRIPT, [".local/bin"], rl).split("\t")[0], "link");
  assert.equal(readFileSync(old, "utf8"), `#!/bin/sh\n# ${MARK}\necho old checkout\n`, "never writes through the link");

  // A link to this very file is the dev install's: the same.
  const { home: home3, run: run3 } = scratch();
  mkdirSync(join(home3, ".local/bin"), { recursive: true });
  symlinkSync(rl, join(home3, ".local/bin/rl"));
  assert.equal(run3(INSTALL_RL_SCRIPT, [".local/bin"], rl).split("\t")[0], "same");
});

test("INSTALL_RL_SCRIPT says when ~/.local/bin is not on PATH, or another rl comes first", posix, () => {
  const { home, run } = scratch();
  assert.equal(run(INSTALL_RL_SCRIPT, [], rl), "installed\t~/.local/bin/rl\t0\t\n");
  mkdirSync(join(home, "other"));
  writeFileSync(join(home, "other/rl"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(run(INSTALL_RL_SCRIPT, ["other", ".local/bin"], rl), "same\t~/.local/bin/rl\t1\t~/other/rl\n");
  assert.match(run(INSTALL_RL_SCRIPT, [], join(home, "nope")), /^error\tthe mod's rl is missing/);
});

test("banner and toast texts", () => {
  assert.equal(rlBanner({ state: "ok" }), null);
  assert.equal(rlBanner({ state: "unknown" }), null);
  assert.equal(rlBanner({ state: "missing" }).button, "install");
  assert.equal(rlBanner({ state: "other", path: "/opt/bin/rl" }).text, "The rl on your PATH (/opt/bin/rl) is another program.");
  assert.equal(rlBanner({ state: "offpath" }).button, null);
  assert.deepEqual(installToast("installed\t~/.local/bin/rl\t1\t~/.local/bin/rl\n"), { body: "Installed rl at ~/.local/bin/rl.", level: "success" });
  assert.match(installToast("installed\t~/.local/bin/rl\t0\t\n").body, /not on your PATH/);
  assert.equal(installToast("installed\t~/.local/bin/rl\t0\t\n").level, "warning");
  assert.match(installToast("same\t~/.local/bin/rl\t1\t~/other/rl\n").body, /Another rl comes first on PATH \(~\/other\/rl\)/);
  assert.match(installToast("other\t~/.local/bin/rl\t1\t~/.local/bin/rl\n").body, /another program called rl; left as it is/);
  assert.equal(installToast("").level, "error");
});
