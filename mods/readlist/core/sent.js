// The second source: files Claude Code agents send the person with their SendUserFile tool,
// added to the list without the agent running rl. Off until the person turns it on (the `f`
// menu's Sources, or `herdr-app do readlist.claude-files`). Pure functions and scripts,
// shared by the mod and the node tests. See docs/design.md 7, increment 6.
//
// Finding an agent's session, the way herdr-artifacts and herdr-shelf do: `hc get <t>
// --json` gives the terminal's foreground pid; Claude Code keeps `sessions/<pid>.json` (with
// the session id) in its config folder for each running copy, and the session's transcript
// is `projects/<folder>/<session id>.jsonl`. A delivered send shows in the transcript as a
// tool result whose `toolUseResult` lists the `attachments` it delivered (each a `path` and
// a `file_uuid`).
//
// state.json's "claude_files" records the setting and what was handled:
//   { "on": true, "since": "<ISO, when it was turned on>",
//     "sessions": { "<session id>": { "at": "<ISO of the latest send handled>", "seen": <ms> } } }
// Only sends at or after `since` and after the session's `at` are added, so a send is added
// once (also after the person deletes its item), turning it on does not pull in old sends,
// and copies of the mod agree through state.json's compare-and-swap: only the copy whose
// write recorded a send runs rl for it. rl add --if-new leaves a file already on the list
// (added with rl, or sent before) as it is.

// Sessions not seen for this long are forgotten.
export const KEEP_MS = 90 * 86400000;
// A session's `seen` is refreshed at most this often, so a scan with nothing new does not
// write state.json (which would list the folder again).
const SEEN_MS = 86400000;
// Lines longer than this are not a send's result (they are a file someone read, quoted).
const LINE_MAX = 262144;

// Whether an agents() entry is Claude Code running on this machine.
export const isClaudeAgent = (a) => Boolean(a) && !String(a.address ?? "").includes("/") && (a.app === "claude-code" || a.program?.key === "claude");

// The pid `hc get <t> --json` reports for the terminal's foreground program, or null.
export function foregroundPid(stdout) {
  try {
    const pid = JSON.parse(stdout ?? "")?.foreground?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// $1: Claude Code's config folder ("" for ${CLAUDE_CONFIG_DIR:-~/.claude}); then triples
// of terminal address, foreground pid and the transcript's signature from the last scan
// ("" if none). For each terminal with a session: a header `\x1e<address>\t<session
// id>\t<transcript>\t<size:mtime>\t<1 if unchanged>` and, unless unchanged, the transcript's
// lines that may be a send's result. The session file belongs to the pid or a process up
// to two levels below it (a wrapper that starts Claude Code). Missing or unreadable files
// are skipped.
export const SCAN_SCRIPT = [
  'cfg=${1:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}; shift',
  "while [ $# -ge 3 ]; do",
  '  a=$1; p=$2; known=$3; shift 3; s=""',
  '  case $p in "" | *[!0-9]*) continue ;; esac',
  '  kids=$(pgrep -P "$p" 2>/dev/null); grand=""',
  '  for k in $kids; do grand="$grand $(pgrep -P "$k" 2>/dev/null)"; done',
  '  for q in $p $kids $grand; do [ -f "$cfg/sessions/$q.json" ] && { s=$cfg/sessions/$q.json; break; }; done',
  '  [ -n "$s" ] || continue',
  `  sid=$(sed -n 's/.*"sessionId" *: *"\\([0-9A-Za-z_-]*\\)".*/\\1/p' "$s" 2>/dev/null | head -n 1)`,
  '  [ -n "$sid" ] || continue',
  '  t=""',
  '  for f in "$cfg"/projects/*/"$sid".jsonl; do [ -f "$f" ] && { t=$f; break; }; done',
  '  [ -n "$t" ] || continue',
  `  sig=$(stat -c '%s:%Y' -- "$t" 2>/dev/null || stat -f '%z:%m' -- "$t" 2>/dev/null)`,
  '  if [ -n "$sig" ] && [ "$sig" = "$known" ]; then printf "\\036%s\\t%s\\t%s\\t%s\\t1\\n" "$a" "$sid" "$t" "$sig"; continue; fi',
  '  printf "\\036%s\\t%s\\t%s\\t%s\\t0\\n" "$a" "$sid" "$t" "$sig"',
  `  grep -F 'file_uuid' -- "$t" 2>/dev/null | awk 'length($0) < ${LINE_MAX}'`,
  "done",
  "exit 0",
].join("\n");

const iso = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

// The send a transcript line records, or null: { id, at, caption, files }. `files` are the
// absolute paths delivered (relative ones resolved against the line's cwd).
export function parseSendLine(line) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || typeof d !== "object" || d.type !== "user") return null;
  const at = iso(d.timestamp);
  const r = d.toolUseResult;
  const content = d.message?.content;
  if (!at || !r || typeof r !== "object" || !Array.isArray(r.attachments) || !Array.isArray(content)) return null;
  const result = content.find((b) => b && b.type === "tool_result" && typeof b.tool_use_id === "string");
  if (!result || result.is_error) return null;
  const cwd = typeof d.cwd === "string" && d.cwd.startsWith("/") ? d.cwd.replace(/\/+$/, "") : null;
  const files = [];
  for (const a of r.attachments) {
    if (!a || typeof a.path !== "string" || !a.path || !a.file_uuid) continue;
    const p = a.path.startsWith("/") ? a.path : cwd ? `${cwd}/${a.path}` : null;
    if (p && !files.includes(p)) files.push(p);
  }
  if (!files.length) return null;
  const caption = typeof r.caption === "string" && r.caption.trim() ? r.caption.trim() : null;
  return { id: result.tool_use_id, at, caption, files };
}

// SCAN_SCRIPT's output: [{ address, session, transcript, sig, same, sends }], sends oldest
// first. A session listed twice (two terminals showing one session) is kept once.
export function parseScan(stdout) {
  const out = [];
  const sessions = new Set();
  for (const chunk of (stdout ?? "").split("\x1e")) {
    const nl = chunk.indexOf("\n");
    const head = (nl < 0 ? chunk : chunk.slice(0, nl)).split("\t");
    if (head.length < 5 || !head[0] || !head[1]) continue;
    const [address, session, transcript, sig, same] = head;
    if (sessions.has(session)) continue;
    sessions.add(session);
    const sends = [];
    const ids = new Set();
    for (const line of nl < 0 ? [] : chunk.slice(nl + 1).split("\n")) {
      const s = line.trim() ? parseSendLine(line) : null;
      if (!s || ids.has(s.id)) continue;
      ids.add(s.id);
      sends.push(s);
    }
    sends.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    out.push({ address, session, transcript, sig, same: same === "1", sends });
  }
  return out;
}

// state.json's "claude_files", cleaned: { on, since, sessions }. Absent or broken is off.
export function parseSent(raw) {
  const on = Boolean(raw && typeof raw === "object" && raw.on === true && iso(raw.since));
  const sessions = {};
  const had = raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {};
  for (const [sid, e] of Object.entries(had)) {
    if (e && typeof e === "object" && iso(e.at) && Number.isFinite(e.seen)) sessions[sid] = { at: e.at, seen: e.seen };
  }
  return { on, since: on ? raw.since : null, sessions };
}

export const sentOn = (state) => Boolean(state?.claude_files?.on);

// The state with the setting turned on (since `now`) or off. The sessions' record stays,
// so turning it off and on again does not add a send twice.
export function setSent(state, on, now) {
  const had = parseSent(state.claude_files);
  return { ...state, claude_files: { on, since: on ? now : null, sessions: had.sessions } };
}

const ms = (t) => Date.parse(t);

// What to do about a scan (parseScan) given the record: { todo: [{ address, session, send }]
// to add now, oldest first, record: the next "claude_files", changed: whether it differs }.
export function sentPlan(scan, record, nowMs) {
  const rec = parseSent(record);
  const sessions = {};
  for (const [sid, e] of Object.entries(rec.sessions)) if (nowMs - e.seen <= KEEP_MS) sessions[sid] = e;
  let changed = Object.keys(sessions).length !== Object.keys(rec.sessions).length;
  const todo = [];
  if (!rec.on) return { todo, record: rec, changed: false };
  const since = ms(rec.since);
  for (const s of scan) {
    if (!s.sends.length) continue;
    const had = sessions[s.session];
    const mark = had ? ms(had.at) : -Infinity;
    const fresh = s.sends.filter((x) => ms(x.at) > mark && ms(x.at) >= since);
    for (const send of fresh) todo.push({ address: s.address, session: s.session, send });
    const latest = s.sends.reduce((m, x) => (ms(x.at) > ms(m) ? x.at : m), s.sends[0].at);
    if (!had || ms(latest) > mark || nowMs - had.seen > SEEN_MS) {
      sessions[s.session] = { at: had && mark >= ms(latest) ? had.at : latest, seen: nowMs };
      changed = true;
    }
  }
  todo.sort((a, b) => ms(a.send.at) - ms(b.send.at));
  return { todo, record: { on: rec.on, since: rec.since, sessions }, changed };
}

// Who the list says added a sent file when its terminal cannot be looked up.
export const sentFrom = (address) => `Claude Code ${address}`;

// Adds sent files with the rl at $1, then for each file four arguments: the terminal's
// address (rl looks it up, as for an agent running rl there), the --from fallback, the note
// (the send's caption, may be empty) and the path. Files that are gone are skipped; a file
// already on the list stays as it is (--if-new). Prints each id rl printed.
export const SENT_ADD_SCRIPT = [
  "unset HC_TERMINAL_ID",
  'rl=$1; shift; st=0',
  '[ -f "$rl" ] || { echo "the mod\'s rl is missing: $rl" >&2; exit 127; }',
  'while [ $# -ge 4 ]; do',
  '  if [ -e "$4" ]; then',
  '    if out=$(HC_TERMINAL_ID=$1 sh "$rl" add --if-new --kind result --from "$2" --note "$3" -- "$4" 2>&1); then printf "%s\\n" "$out"; else printf "%s\\n" "$out" >&2; st=1; fi',
  "  fi",
  "  shift 4",
  "done",
  "exit $st",
].join("\n");

// SENT_ADD_SCRIPT's arguments for a plan's todo.
export function sentAddArgs(todo) {
  return todo.flatMap((t) => t.send.files.flatMap((f) => [t.address, sentFrom(t.address), t.send.caption ?? "", f]));
}
