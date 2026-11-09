// Action handlers: the programs that open, reveal, preview and thumbnail an item. The mod's
// built-in ones (handlers/macos.sh, handlers/linux.sh) and, only after the person turns it
// on, their own program at <app home>/readlist/handler, tried first. bin/run-handler checks
// the person's handler and runs any handler; these are the pure functions around it, shared
// by the mod and the node tests. See README "Your own handler" and docs/design.md 4.7.
//
// A handler is called with argv, never through a shell string:
//   HANDLER ACTION [ARG...] -- ITEM
// ITEM, the only item data it gets, is always the last argument, right after `--`: an
// absolute path with its folders resolved (or, for open-url, an http or https URL).
//   open -- PATH                          open in its app (Enter)
//   reveal -- PATH                        show in the file manager (o; Enter on a file that could run)
//   open-url -- URL                       open a link (Enter on a link)
//   preview -- PATH                       a preview window (Space); prints a token on stdout
//   preview-close TOKEN same|other -- PATH
//                                         the preview it opened (TOKEN from preview) is done:
//                                         `same` is Space again on that item (close it; exit 0
//                                         when it did, else the mod shows it again), `other` is
//                                         Space on another item (close it, or keep its window
//                                         for the next preview)
//   thumbnail SIZE OUT -- PATH            write a PNG about SIZE px wide to OUT, in a folder
//                                         of its own the handler may also use for scratch
// Exit 0: done. Exit NOT_HANDLED (10): the next handler tries (the person's, then the
// built-in, then the mod's own fallback: the in-pane preview for Space, the type's icon for
// a thumbnail, the browser for a link). Anything else: failed; the first line of stderr is
// shown in a toast. Each run has a time limit (TIMEOUT_MS, THUMB_SECONDS).

import { platformOf } from "./platform.js";

export const NOT_HANDLED = 10;
// The runner refused to run the person's handler (not turned on for this file, changed,
// unsafe permissions); stderr says why. The built-in one runs instead.
export const REFUSED = 11;
export const ACTIONS = ["open", "reveal", "open-url", "preview", "preview-close", "thumbnail"];
export const TIMEOUT_MS = 15000;
export const THUMB_SECONDS = 30;

// Where the person's handler and their opt-in live, under the app home (outside the mod's
// folder, so reinstalling the mod keeps them).
export const USER_DIR = "readlist";
export const USER_HANDLER = `${USER_DIR}/handler`;
export const TRUST_FILE = `${USER_DIR}/trust.json`;
// The program that checks the person's handler and runs any handler (bin/run-handler in
// the mod's folder; run with sh, so a lost execute bit does not matter).
export const RUNNER = "bin/run-handler";

// The built-in handler for a platform, a file in the mod's handlers/ (null: none yet).
export function builtinFile(platform) {
  const p = platformOf({ platform });
  return p === "macos" ? "macos.sh" : p === "linux" ? "linux.sh" : null;
}

// The opt-in record (trust.json): { v: 1, handler: { path, sha256, at } | null }. The path
// is the real path the handler resolved to and sha256 its contents when the person turned
// it on. Anything else reads as off.
export function parseTrust(text) {
  let raw = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
  const h = raw?.v === 1 ? raw.handler : null;
  if (!h || typeof h.path !== "string" || !h.path.startsWith("/") || !/^[0-9a-f]{64}$/.test(h.sha256 ?? "")) return null;
  return { path: h.path, sha256: h.sha256, at: typeof h.at === "string" ? h.at : null };
}

export const serializeTrust = (handler) => JSON.stringify({ v: 1, handler: handler ?? null }, null, 2) + "\n";

// The handlers to try, first to last: { who: "user" | "builtin", command, args, tag? }. The
// item's kind, the item and the action's argv follow `args`. `home` is the app home, `trust`
// the opt-in record (the person's handler is tried only with one), `mod` the mod's folder
// under the home. The person's carries a tag (from its hash) for the thumbnails it makes.
export function chain(platform, home, trust, mod) {
  const out = [];
  const run = `${home}/${mod}/${RUNNER}`;
  if (trust) out.push({ who: "user", tag: trust.sha256.slice(0, 12), command: "sh", args: [run, "user", `${home}/${USER_HANDLER}`, trust.path, trust.sha256] });
  const file = builtinFile(platform);
  if (file) out.push({ who: "builtin", command: "sh", args: [run, "builtin", `${home}/${mod}/handlers/${file}`] });
  return out;
}

// The argv after a handler's `args` for an action on an item: kind ("path" or "url"), the
// item, the action and its arguments. null when the item may not go to a handler: a path
// that is not absolute, a link that is not http or https, a NUL byte anywhere.
export function actionArgs(action, item, extra = []) {
  if (!ACTIONS.includes(action) || typeof item !== "string" || item.includes("\0")) return null;
  if (extra.some((a) => typeof a !== "string" || a.includes("\0"))) return null;
  const kind = action === "open-url" ? "url" : "path";
  if (kind === "url" ? !/^https?:\/\/[^\s]+$/i.test(item) : !item.startsWith("/")) return null;
  return [kind, item, action, ...extra];
}

// A preview token as the mod keeps it: a short word (Quick Look's pid), else empty.
export const token = (stdout) => {
  const t = (stdout ?? "").split("\n")[0].trim();
  return /^[\w.:-]{1,64}$/.test(t) ? t : "";
};

// One short line for a toast from a handler's stderr.
export function shortError(stderr, code) {
  const line = (stderr ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const text = line.replace(/^readlist: /, "") || (code === null || code === undefined ? "it could not start" : `it exited with ${code}`);
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

// What a handler run came to: "ok", "pass" (not handled), "refused" (the runner would not
// run the person's handler) or "failed", with stdout and a short message.
export function outcome(r) {
  if (!r) return { status: "failed", stdout: "", message: "it could not start" };
  if (r.code === 0) return { status: "ok", stdout: r.stdout ?? "", message: "" };
  if (r.code === NOT_HANDLED) return { status: "pass", stdout: r.stdout ?? "", message: shortError(r.stderr, r.code) };
  if (r.code === REFUSED && /^readlist: /m.test(r.stderr ?? "")) return { status: "refused", stdout: "", message: shortError(r.stderr, r.code) };
  return { status: "failed", stdout: r.stdout ?? "", message: shortError(r.stderr, r.code) };
}

// Runs `action` on `item` through `list` (from chain) in turn until one handles it:
// { status: "ok" | "failed" | "pass", stdout, message, who }. Each handler runs once,
// through `exec(command, args)` (Herdr's, with a time limit), and nothing is tried again.
// `extra(h)` gives the action's arguments for a handler, `only` limits it to one ("user" or
// "builtin"), `skip(h)` leaves one out. `onRefused(message)` hears when bin/run-handler
// would not run the person's handler (the next one runs instead), `onPass(h, message)`
// when a handler passed.
export async function runChain(list, action, item, { exec, extra = () => [], only = null, skip = () => false, onRefused = () => {}, onPass = () => {} }) {
  for (const h of list) {
    if ((only && h.who !== only) || skip(h)) continue;
    const args = actionArgs(action, item, extra(h));
    if (!args) return { status: "failed", stdout: "", message: action === "open-url" ? "only http and https links go to a handler" : "not an absolute path", who: h.who };
    const r = await exec(h.command, [...h.args, ...args]).catch((e) => ({ code: null, stdout: "", stderr: String(e?.message ?? e) }));
    const o = outcome(r);
    if (o.status === "refused") onRefused(o.message);
    else if (o.status === "pass") onPass(h, o.message);
    else return { ...o, who: h.who };
  }
  return { status: "pass", stdout: "", message: "", who: null };
}

// `run-handler check`'s output: { state: "ok", path, sha256 } | { state: "missing" } |
// { state: "refused", why }.
export function parseCheck(stdout) {
  const [state, a, b] = (stdout ?? "").replace(/\n$/, "").split("\t");
  if (state === "ok" && a?.startsWith("/") && /^[0-9a-f]{64}$/.test(b ?? "")) return { state: "ok", path: a, sha256: b };
  if (state === "missing") return { state: "missing" };
  return { state: "refused", why: a || "it could not be checked" };
}

// Which handler the list uses, from the opt-in record and a check of the file now:
// "off" (built-in), "on" (the person's), or why the person's is not used: "changed" (its
// contents), "moved" (the location now leads to another file), "missing", "refused".
export function handlerState(trust, check) {
  if (!trust) return { state: "off" };
  if (!check) return { state: "on", path: trust.path };
  if (check.state === "missing") return { state: "missing" };
  if (check.state === "refused") return { state: "refused", why: check.why };
  if (check.path !== trust.path) return { state: "moved", path: check.path, was: trust.path };
  if (check.sha256 !== trust.sha256) return { state: "changed", path: check.path };
  return { state: "on", path: trust.path };
}

// The pane's line about a handler that is turned on but not used (null otherwise): the
// text, and whether the person can confirm the file as it is now.
export function handlerBanner(hs, location) {
  const builtin = "so the list uses its built-in actions";
  switch (hs?.state) {
    case "changed": return { text: `Your handler ${hs.path} changed since you turned it on, ${builtin} until you confirm it.`, confirm: true };
    case "moved": return { text: `Your handler ${location} now leads to ${hs.path}, not the ${hs.was} you turned on, ${builtin} until you confirm it.`, confirm: true };
    case "missing": return { text: `Your handler ${location} is gone, ${builtin}.`, confirm: false };
    case "refused": return { text: `Your handler ${location} is not used: ${hs.why}.`, confirm: false };
    default: return null;
  }
}
