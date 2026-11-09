// The second source (core/sent.js): files Claude Code agents sent with SendUserFile, read
// from synthetic session transcripts in a scratch Claude Code folder, and added with rl to
// a scratch READING_LIST_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCAN_SCRIPT, SENT_ADD_SCRIPT, KEEP_MS, isClaudeAgent, foregroundPid, parseSendLine, parseScan, parseSent, sentOn, setSent, sentPlan, sentAddArgs, sentFrom } from "../mods/readlist/core/sent.js";
import { parseState, serializeState, applyAction, prune, withInbox } from "../mods/readlist/core/state.js";

import { repo, posix } from "./support.mjs";
const RL = join(repo, "mods/readlist/bin/rl");
const sh = (script, ...args) => execFileSync("sh", ["-c", script, "t", ...args], { encoding: "utf8" });
const scratch = (name) => realpathSync(mkdtempSync(join(tmpdir(), name)));

// One transcript line: the result of a SendUserFile call that delivered `files`.
const sendLine = ({ id = "toolu_01", at = "2026-11-09T10:00:00.000Z", files = ["/w/report.md"], caption = "The report.", cwd = "/w", error = false } = {}) => JSON.stringify({
  parentUuid: "p1",
  isSidechain: false,
  type: "user",
  message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: `${files.length} files delivered to user.`, ...(error ? { is_error: true } : {}) }] },
  uuid: "u1",
  timestamp: at,
  cwd,
  sessionId: "s1",
  toolUseResult: { caption, display: "render", attachments: files.map((path, n) => ({ path, size: 10, isImage: false, file_uuid: `f-${id}-${n}` })) },
});
// Other lines a transcript has, some mentioning file_uuid without being a send's result.
const noise = [
  JSON.stringify({ type: "assistant", timestamp: "2026-11-09T09:59:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "SendUserFile", input: { files: ["report.md"] } }] } }),
  JSON.stringify({ type: "user", timestamp: "2026-11-09T09:59:30.000Z", message: { role: "user", content: [{ tool_use_id: "toolu_09", type: "tool_result", content: "grep found file_uuid in a log" }] }, toolUseResult: { stdout: "file_uuid" } }),
  '{"type":"user","file_uuid": broken json',
];

// ---- parsing ----

test("parseSendLine reads a delivered send and nothing else", () => {
  assert.deepEqual(parseSendLine(sendLine()), { id: "toolu_01", at: "2026-11-09T10:00:00.000Z", caption: "The report.", files: ["/w/report.md"] });
  // Relative paths resolve against the line's folder; duplicates and entries without a file_uuid go.
  const rel = JSON.parse(sendLine({ files: ["out/a.png", "/abs/b.png", "/abs/b.png"], caption: "  " }));
  rel.toolUseResult.attachments.push({ path: "/abs/c.png" });
  assert.deepEqual(parseSendLine(JSON.stringify(rel)), { id: "toolu_01", at: "2026-11-09T10:00:00.000Z", caption: null, files: ["/w/out/a.png", "/abs/b.png"] });
  assert.equal(parseSendLine(sendLine({ error: true })), null, "a failed send");
  assert.equal(parseSendLine(sendLine({ files: [] })), null, "nothing delivered");
  assert.equal(parseSendLine(sendLine({ at: "yesterday" })), null, "no time");
  assert.equal(parseSendLine(sendLine({ files: ["rel.md"], cwd: null })), null, "relative path without a folder");
  for (const line of noise) assert.equal(parseSendLine(line), null);
  assert.equal(parseSendLine(""), null);
  assert.equal(parseSendLine("null"), null);
});

test("parseScan splits sessions, keeps each send once, oldest first, and survives garbage", () => {
  const out = [
    "\x1et1\ts1\t/c/projects/x/s1.jsonl\t100:5\t0\n",
    sendLine({ id: "b", at: "2026-11-09T11:00:00.000Z" }) + "\n",
    noise.join("\n") + "\n",
    sendLine({ id: "a", at: "2026-11-09T10:00:00.000Z" }) + "\n",
    sendLine({ id: "a", at: "2026-11-09T10:00:00.000Z" }) + "\n",
    "\x1et2\ts2\t/c/projects/y/s2.jsonl\t7:9\t1\n",
    "\x1et3\ts1\t/c/projects/x/s1.jsonl\t100:5\t0\n", // the same session in another terminal
    "\x1ebroken header\n",
  ].join("");
  const scan = parseScan(out);
  assert.deepEqual(scan.map((s) => [s.address, s.session, s.sig, s.same]), [["t1", "s1", "100:5", false], ["t2", "s2", "7:9", true]]);
  assert.deepEqual(scan[0].sends.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(scan[1].sends, []);
  assert.deepEqual(parseScan(""), []);
  assert.deepEqual(parseScan(null), []);
});

test("isClaudeAgent and foregroundPid", () => {
  assert.equal(isClaudeAgent({ address: "t1", app: "claude-code", program: { key: "claude" } }), true);
  assert.equal(isClaudeAgent({ address: "t2", app: null, program: { key: "claude" } }), true);
  assert.equal(isClaudeAgent({ address: "t3", app: "codex", program: { key: "codex" } }), false);
  assert.equal(isClaudeAgent({ address: "devbox/t1", app: "claude-code" }), false, "another machine's");
  assert.equal(foregroundPid('{"address":"t1","foreground":{"name":"claude","pid":4242}}'), 4242);
  assert.equal(foregroundPid('{"address":"t1","foreground":null}'), null);
  assert.equal(foregroundPid("not json"), null);
});

// ---- the setting and the record ----

const T0 = Date.parse("2026-11-09T10:00:00Z");
const on = (since = "2026-11-09T09:00:00.000Z", sessions = {}) => ({ on: true, since, sessions });
const session = (sends, over = {}) => ({ address: "t1", session: "s1", transcript: "/c/s1.jsonl", sig: "1:1", same: false, sends, ...over });
const send = (id, at, files = [`/w/${id}.md`]) => ({ id, at, caption: `about ${id}`, files });

test("the setting is off by default and survives every state write", () => {
  assert.equal(sentOn(parseState(null)), false);
  assert.equal(sentOn(parseState('{"v":1,"items":{},"claude_files":{"on":"yes","since":"x"}}')), false, "broken is off");
  let s = setSent(parseState(null), true, "2026-11-09T09:00:00.000Z");
  assert.equal(sentOn(s), true);
  s = { ...s, claude_files: { ...s.claude_files, sessions: { s1: { at: "2026-11-09T09:30:00.000Z", seen: T0 } } } };
  s = applyAction(s, "0123456789abcdef", "read", "2026-11-09T10:00:00Z");
  s = withInbox(s, { "a.png": 5 });
  s = withInbox(s, {});
  s = prune(s, [], Date.parse("2027-06-01T00:00:00Z"));
  const back = parseState(serializeState(s));
  assert.deepEqual(back.claude_files, { on: true, since: "2026-11-09T09:00:00.000Z", sessions: { s1: { at: "2026-11-09T09:30:00.000Z", seen: T0 } } });
  // Off keeps what was handled, so on again does not add those sends twice.
  const off = setSent(back, false, "2026-11-10T00:00:00.000Z");
  assert.equal(sentOn(off), false);
  assert.deepEqual(Object.keys(off.claude_files.sessions), ["s1"]);
  assert.equal(setSent(off, true, "2026-11-11T00:00:00.000Z").claude_files.since, "2026-11-11T00:00:00.000Z");
  assert.deepEqual(parseSent({ on: true, since: "2026-11-09T00:00:00Z", sessions: { a: { at: "bad", seen: 1 }, b: null } }).sessions, {});
});

test("sentPlan does nothing while off", () => {
  const plan = sentPlan([session([send("a", "2026-11-09T09:30:00.000Z")])], undefined, T0);
  assert.deepEqual(plan.todo, []);
  assert.equal(plan.changed, false);
  assert.equal(sentPlan([session([send("a", "2026-11-09T09:30:00.000Z")])], { on: false, since: null, sessions: {} }, T0).changed, false);
});

test("sentPlan adds each send once, only since the setting went on", () => {
  const sends = [send("old", "2026-11-09T08:00:00.000Z"), send("a", "2026-11-09T09:30:00.000Z"), send("b", "2026-11-09T09:45:00.000Z")];
  const plan = sentPlan([session(sends), session([], { address: "t2", session: "s2" })], on(), T0);
  assert.deepEqual(plan.todo.map((t) => [t.address, t.send.id]), [["t1", "a"], ["t1", "b"]]);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.record.sessions, { s1: { at: "2026-11-09T09:45:00.000Z", seen: T0 } }, "a session with no sends is not recorded");
  // The same transcript again: nothing to add, nothing to write.
  const again = sentPlan([session(sends)], plan.record, T0 + 60000);
  assert.deepEqual(again.todo, []);
  assert.equal(again.changed, false);
  // A later send in the same session: only it.
  const later = sentPlan([session([...sends, send("c", "2026-11-09T10:05:00.000Z")])], plan.record, T0 + 120000);
  assert.deepEqual(later.todo.map((t) => t.send.id), ["c"]);
  assert.equal(later.record.sessions.s1.at, "2026-11-09T10:05:00.000Z");
});

test("sentPlan keeps a session's record fresh once a day and forgets old ones", () => {
  const rec = on("2026-11-01T00:00:00.000Z", {
    s1: { at: "2026-11-09T09:00:00.000Z", seen: T0 - 2 * 86400000 },
    gone: { at: "2026-08-01T00:00:00.000Z", seen: T0 - KEEP_MS - 1 },
  });
  const plan = sentPlan([session([send("a", "2026-11-09T09:00:00.000Z")])], rec, T0);
  assert.deepEqual(plan.todo, []);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.record.sessions, { s1: { at: "2026-11-09T09:00:00.000Z", seen: T0 } });
});

test("sentAddArgs gives four arguments per file", () => {
  const todo = [{ address: "t1", session: "s1", send: { id: "a", at: "x", caption: null, files: ["/a.md", "/b.png"] } }];
  assert.deepEqual(sentAddArgs(todo), ["t1", sentFrom("t1"), "", "/a.md", "t1", sentFrom("t1"), "", "/b.png"]);
});

// ---- the scripts, end to end ----

// A scratch Claude Code folder: sessions/<pid>.json and projects/<folder>/<session>.jsonl.
function claudeHome() {
  const cfg = scratch("rl-claude-");
  mkdirSync(join(cfg, "sessions"));
  mkdirSync(join(cfg, "projects/-w"), { recursive: true });
  return cfg;
}
const sessionFile = (cfg, pid, sid) => writeFileSync(join(cfg, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: "/w", kind: "interactive", status: "idle" }));

test("SCAN_SCRIPT finds each terminal's transcript and its sends, and skips what is missing or broken", posix, () => {
  const cfg = claudeHome();
  sessionFile(cfg, 900001, "aaaa-1111");
  const t1 = join(cfg, "projects/-w/aaaa-1111.jsonl");
  writeFileSync(t1, [noise[0], sendLine({ id: "x1" }), noise[1], noise[2], "x".repeat(300000) + "file_uuid"].join("\n") + "\n");
  sessionFile(cfg, 900002, "bbbb-2222"); // no transcript
  writeFileSync(join(cfg, "sessions", "900003.json"), "{ not json"); // broken session file
  const out = sh(SCAN_SCRIPT, cfg, "t1", "900001", "", "t2", "900002", "", "t3", "900003", "", "t4", "900004", "", "t5", "not-a-pid", "");
  const scan = parseScan(out);
  assert.equal(scan.length, 1);
  assert.equal(scan[0].address, "t1");
  assert.equal(scan[0].session, "aaaa-1111");
  assert.equal(scan[0].transcript, t1);
  assert.match(scan[0].sig, /^\d+:\d+$/);
  assert.deepEqual(scan[0].sends.map((s) => s.id), ["x1"]);
  // Unchanged since the last scan: the header only.
  const same = sh(SCAN_SCRIPT, cfg, "t1", "900001", scan[0].sig);
  assert.equal(same.split("\n").filter(Boolean).length, 1);
  assert.equal(parseScan(same)[0].same, true);
  // Grown: read again.
  appendFileSync(t1, sendLine({ id: "x2", at: "2026-11-09T10:10:00.000Z" }) + "\n");
  assert.deepEqual(parseScan(sh(SCAN_SCRIPT, cfg, "t1", "900001", scan[0].sig))[0].sends.map((s) => s.id), ["x1", "x2"]);
  // No Claude Code folder at all.
  assert.equal(sh(SCAN_SCRIPT, join(cfg, "missing"), "t1", "900001", ""), "");
});

test("SCAN_SCRIPT finds the session of a program the terminal's foreground process started", posix, async () => {
  const cfg = claudeHome();
  // A wrapper (the foreground pid) whose child is the program that keeps the session file.
  const wrapper = spawn("sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
  try {
    let child = "";
    for (let i = 0; i < 50 && !child; i++) {
      await new Promise((r) => setTimeout(r, 20));
      child = execFileSync("sh", ["-c", 'pgrep -P "$1" || true', "t", String(wrapper.pid)], { encoding: "utf8" }).trim();
    }
    assert.match(child, /^\d+$/);
    sessionFile(cfg, child, "cccc-3333");
    writeFileSync(join(cfg, "projects/-w/cccc-3333.jsonl"), sendLine({ id: "w1" }) + "\n");
    const scan = parseScan(sh(SCAN_SCRIPT, cfg, "t9", String(wrapper.pid), ""));
    assert.deepEqual(scan.map((s) => [s.address, s.session, s.sends.map((x) => x.id)]), [["t9", "cccc-3333", ["w1"]]]);
  } finally {
    wrapper.kill();
  }
});

test("SENT_ADD_SCRIPT adds sent files as results, skips gone ones, and leaves items already on the list", posix, () => {
  const home = scratch("rl-sent-");
  const list = join(home, "list");
  writeFileSync(join(home, "report.md"), "# Weekly report\n");
  writeFileSync(join(home, "chart.png"), "png");
  writeFileSync(join(home, "plan.md"), "# Plan\n");
  // A stand-in hc that knows terminal t1 (rl looks the adder up the way it does for an agent).
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "hc"), '#!/bin/sh\n[ "$1 $2" = "get t1" ] || exit 1\necho \'{"address":"t1","name":"weekly","cwd":"/w","labels":{"herdr.space":"sp1","herdr.tab":"tb1"},"status":{"app":"claude-code","state":"idle"}}\'\n');
  chmodSync(join(bin, "hc"), 0o755);
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, READING_LIST_DIR: list };
  delete env.HC_TERMINAL_ID;
  // The person (or an agent with rl) already put plan.md on the list.
  const planId = execFileSync(RL, ["add", join(home, "plan.md"), "--note", "from rl"], { encoding: "utf8", env }).trim();
  const planBefore = readFileSync(join(list, "items", `${planId}.json`), "utf8");

  const todo = [
    { address: "t1", session: "s1", send: { id: "a", at: "x", caption: "This week's numbers.", files: [join(home, "report.md"), join(home, "chart.png")] } },
    { address: "t2", session: "s2", send: { id: "b", at: "y", caption: null, files: [join(home, "gone.md"), join(home, "plan.md")] } },
  ];
  const out = execFileSync("sh", ["-c", SENT_ADD_SCRIPT, "t", RL, ...sentAddArgs(todo)], { encoding: "utf8", env });
  const ids = out.trim().split("\n");
  assert.equal(ids.length, 3, "two new files and the one already there; the gone one is skipped");
  assert.equal(ids[2], planId);
  assert.equal(readFileSync(join(list, "items", `${planId}.json`), "utf8"), planBefore, "an item already on the list stays as it was");
  const report = JSON.parse(readFileSync(join(list, "items", `${ids[0]}.json`), "utf8"));
  assert.equal(report.title, "Weekly report");
  assert.equal(report.kind, "result");
  assert.equal(report.note, "This week's numbers.");
  assert.deepEqual([report.by.terminal, report.by.app, report.by.name, report.by.space, report.by.from], ["t1", "claude-code", "weekly", "sp1", sentFrom("t1")]);
  assert.equal(JSON.parse(readFileSync(join(list, "items", `${ids[1]}.json`), "utf8")).note, "This week's numbers.");
  assert.equal(readdirSync(join(list, "items")).length, 3);
  // Sent again (another scan, another copy of the mod): nothing changes.
  const before = readdirSync(join(list, "items")).map((f) => readFileSync(join(list, "items", f), "utf8"));
  execFileSync("sh", ["-c", SENT_ADD_SCRIPT, "t", RL, ...sentAddArgs(todo)], { encoding: "utf8", env });
  assert.deepEqual(readdirSync(join(list, "items")).map((f) => readFileSync(join(list, "items", f), "utf8")), before);
  // Without hc the item still says who sent it.
  const env2 = { ...env, PATH: "/usr/bin:/bin" };
  writeFileSync(join(home, "notes.txt"), "n");
  const nid = execFileSync("sh", ["-c", SENT_ADD_SCRIPT, "t", RL, "t7", sentFrom("t7"), "", join(home, "notes.txt")], { encoding: "utf8", env: env2 }).trim();
  const notes = JSON.parse(readFileSync(join(list, "items", `${nid}.json`), "utf8"));
  assert.deepEqual([notes.by.terminal, notes.by.from, notes.note, notes.kind], [null, "Claude Code t7", null, "result"]);
});

test("a scan, a plan and an add, end to end, add each sent file once", posix, () => {
  const cfg = claudeHome();
  const home = scratch("rl-e2e-");
  const list = join(home, "list");
  const env = { ...process.env, PATH: "/usr/bin:/bin", READING_LIST_DIR: list };
  delete env.HC_TERMINAL_ID;
  writeFileSync(join(home, "a.md"), "# A\n");
  writeFileSync(join(home, "b.html"), "<p>b</p>");
  sessionFile(cfg, 900010, "dddd-4444");
  const t = join(cfg, "projects/-w/dddd-4444.jsonl");
  writeFileSync(t, [
    sendLine({ id: "before", at: "2026-11-09T08:00:00.000Z", files: [join(home, "a.md")] }),
    sendLine({ id: "s1", at: "2026-11-09T09:30:00.000Z", files: [join(home, "a.md")], caption: "First draft." }),
  ].join("\n") + "\n");
  let state = setSent(parseState(null), true, "2026-11-09T09:00:00.000Z");
  const round = (now) => {
    const plan = sentPlan(parseScan(sh(SCAN_SCRIPT, cfg, "t1", "900010", "")), state.claude_files, now);
    if (plan.changed) state = { ...state, claude_files: plan.record };
    if (!plan.todo.length) return [];
    return execFileSync("sh", ["-c", SENT_ADD_SCRIPT, "t", RL, ...sentAddArgs(plan.todo)], { encoding: "utf8", env }).trim().split("\n");
  };
  const first = round(T0);
  assert.equal(first.length, 1);
  assert.equal(JSON.parse(readFileSync(join(list, "items", `${first[0]}.json`), "utf8")).note, "First draft.");
  assert.deepEqual(round(T0 + 5000), [], "nothing new");
  // The person deletes the item; the same send does not bring it back.
  execFileSync(RL, ["rm", first[0]], { env });
  assert.deepEqual(round(T0 + 10000), []);
  // A new send of another file, and of the file again: the new file arrives; a.md is not on
  // the list any more, so its re-send (a new send) adds it again.
  appendFileSync(t, sendLine({ id: "s2", at: "2026-11-09T10:30:00.000Z", files: [join(home, "b.html"), join(home, "a.md")], caption: "Both, updated." }) + "\n");
  assert.equal(round(T0 + 15000).length, 2);
  assert.equal(readdirSync(join(list, "items")).length, 2);
});
