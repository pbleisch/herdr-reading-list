// The small programs the mod runs on this machine, by name: on macOS and Linux each is an sh
// script (the *_SCRIPT constants) run as `sh -c SCRIPT readlist ARG...`, or a plain program;
// on Windows each is an operation of bin/windows/readlist.ps1 run with pwsh, with the same
// arguments (and a few more the scripts have built in). Every argument is its own argv entry
// either way; none is ever read as code. Pure functions, shared by the mod and the node tests.

import { LIST_SCRIPT, STAT_SCRIPT, STATS_SCRIPT } from "./items.js";
import { STAT1_SCRIPT, HEAD_SCRIPT, LIST_DIR_SCRIPT, CACHE_SCRIPT, PRUNE_SCRIPT, TEXT_BYTES, FOLDER_ENTRIES } from "./preview.js";
import { INBOX_SCRIPT, ADD_SCRIPT } from "./inbox.js";
import { SCAN_SCRIPT, SENT_ADD_SCRIPT, LINE_MAX } from "./sent.js";
import { RL_STATUS_SCRIPT, INSTALL_RL_SCRIPT } from "./install.js";
import { DECODE_SCRIPT, CHUNKS_SCRIPT, PRUNE_COPIES_SCRIPT, CHUNK_MIB } from "./remote.js";
import { THUMB_SECONDS } from "./handlers.js";
import { joinPath } from "./paths.js";
import { PWSH, PWSH_ARGS, WIN_HELPER, WIN_RL, WIN_DIR } from "./windows.js";

// Makes the list folder (and items/, inbox/) and prints its real path.
export const DIR_SCRIPT = 'd=${READING_LIST_DIR:-$HOME/.local/state/reading-list}; mkdir -p "$d/items" "$d/inbox" && cd "$d" && pwd -P';

export const SCRIPTS = {
  dir: DIR_SCRIPT,
  list: LIST_SCRIPT,
  stat: STAT_SCRIPT,
  stats: STATS_SCRIPT,
  stat1: STAT1_SCRIPT,
  head: HEAD_SCRIPT,
  listdir: LIST_DIR_SCRIPT,
  cache: CACHE_SCRIPT,
  prune: PRUNE_SCRIPT,
  "prune-copies": PRUNE_COPIES_SCRIPT,
  inbox: INBOX_SCRIPT,
  add: ADD_SCRIPT,
  "sent-add": SENT_ADD_SCRIPT,
  scan: SCAN_SCRIPT,
  "rl-status": RL_STATUS_SCRIPT,
  "install-rl": INSTALL_RL_SCRIPT,
  decode: DECODE_SCRIPT,
  chunks: CHUNKS_SCRIPT,
};

// The rl the mod runs (the drop folder, sent files) and installs: the POSIX script, or on
// Windows rl.ps1 (installed with the rl.cmd and Git Bash shims in its folder).
export const rlFile = (platform, modDir) => joinPath(modDir, platform === "windows" ? WIN_RL : "bin/rl");
export const rlSource = (platform, modDir) => (platform === "windows" ? joinPath(modDir, WIN_DIR) : `${modDir}/bin/rl`);

// The call for helper `op` with `args` on `platform`, run here: { command, args } for exec.
// `modDir` is the mod's folder (absolute). mkdir and rm-item are plain programs elsewhere.
export function helperCall(platform, modDir, op, args = []) {
  if (platform !== "windows") {
    if (op === "mkdir") return { command: "mkdir", args: ["-p", ...args] };
    if (op === "rm-item") return { command: "rm", args: ["-f", "--", ...args] };
    if (!(op in SCRIPTS)) throw new Error(`no helper ${op}`);
    return { command: "sh", args: ["-c", SCRIPTS[op], "readlist", ...args] };
  }
  let a = args;
  if (op === "head") a = [...args, String(TEXT_BYTES)];
  else if (op === "listdir") a = [...args, String(FOLDER_ENTRIES)];
  else if (op === "chunks") a = [...args, String(CHUNK_MIB)];
  else if (op === "scan") a = [args[0] ?? "", String(LINE_MAX), ...args.slice(1)];
  else if (op === "cache" && args[4] !== "copy") a = [...args.slice(0, 5), String(THUMB_SECONDS), ...args.slice(5)];
  return { command: PWSH, args: [...PWSH_ARGS, joinPath(modDir, WIN_HELPER), op, ...a] };
}
