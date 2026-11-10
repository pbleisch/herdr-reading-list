// Reading list: files and URLs agents and tools put up for the person to read (rl add).
// Watches $READING_LIST_DIR (default ~/.local/state/reading-list): items/<id>.json are
// the producers', state.json (read and done) is the person's, written only here, and
// anything put in inbox/ (or dropped on the list) is added with rl. Every other machine
// Herdr reaches is listed every 15 s (its own folder there); its files are fetched into
// the cache to be opened or drawn (core/remote.js).
// Lives in the left sidebar under Agents (props {role: "sidebar"}), in a pane, or as the
// popup (mod.open:readlist: cmd-shift-i on macOS, ctrl-shift-i on Linux and Windows). Props {role: "viewer"} is the preview-only pane
// `v` opens; props {menu} is a filter menu one of the others opened. When the person turns
// it on, files Claude Code agents here send with SendUserFile are added too (core/sent.js).
// Opening, revealing, the Space preview and thumbnails go to action handlers: the
// platform's built-in one, and first the person's own when they turned it on
// (core/handlers.js).
// The small programs it runs here are sh scripts on macOS and Linux and, on Windows, the
// PowerShell 7 helper in bin/windows (core/helpers.js); on other machines, sh scripts.
// See docs/design.md in the herdr-reading-list repo.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, TextView, Editor, EditorState, InputState, Input } from "gpui-base";
import { exec, hc, readTextFile, writeTextFile, watchFolder, nextCommand, agents, spaces, panes, focused, machines, theme, settings, layout, props, notify, appHome, run, shared, setShared, openOverlay, closeOverlay, window as appWindow } from "herdr";
import { parseListing, parseStats, typeOf, openAction, itemFile, itemKey } from "./core/items.js";
import { WIDE, TEXT_BYTES, THUMB, parseStat, previewKind, previewShown, thumbSize, cacheName, previewText, stripThreads, parseFolder, copyText } from "./core/preview.js";
import { platformOf, words, noQuickLook } from "./core/platform.js";
import { TIMEOUT_MS, THUMB_SECONDS, TRUST_FILE, userHandler, chain, checkCall, runChain, token, outcome, parseTrust, serializeTrust, parseCheck, handlerState, handlerBanner } from "./core/handlers.js";
import { helperCall, rlFile, rlSource } from "./core/helpers.js";
import { joinPath } from "./core/paths.js";
import { noPwsh, NEEDS_PWSH } from "./core/windows.js";
import { parseState, serializeState, applyAction, prune, rowsFor, counts, ago, who, isRead, isDone, isChanged, withInbox } from "./core/state.js";
import { NO_FILTER, applyFilters, filterRows, isFiltered, options, labelFor } from "./core/filters.js";
import { BURST_MS, arrivalKey, arrivals, claim, owners, quiet, quietIds, toastFor, toastAction } from "./core/arrival.js";
import { parseInbox, inboxPlan } from "./core/inbox.js";
import { isClaudeAgent, foregroundPid, parseScan, sentPlan, sentOn, setSent, sentAddArgs } from "./core/sent.js";
import { viewerPane, newPane, selectedId, takesCommand, splitTarget } from "./core/viewer.js";
import { findMatches, firstFrom, step, matchLabel, wrapRows, rowOf, segments } from "./core/search.js";
import { NAME } from "./core/name.js";
import { INSTALL_RL_TEXT_SCRIPT, parseRlStatus, rlBanner, installToast } from "./core/install.js";
import { POLL_MS, POLL_TIMEOUT_MS, ASK_MS, POLL_SCRIPT, BASE64_SCRIPT, parsePoll, afterPoll, syncMachines, pollPaths, unstated, mergeItems, onMachine, listedMachines, isOffline, safeName, copyPaths, parseMeta, isStale, fetchRoute, needsAsk, fetchedLabel, sizeLabel, remoteBanner } from "./core/remote.js";

// This mod's folder under the app home (core/name.js).
const MOD = `mods/${NAME}`;
const ICONS = `${MOD}/icons`;
// The rl that ships with the mod (core/helpers.js rlFile): the drop folder runs it, and
// "Install rl" copies it to ~/.local/bin (core/install.js). Other machines get the POSIX one.
const RL = `${MOD}/bin/rl`;
// localStorage: the rl banner state the person dismissed with "Not now", here and (a map
// machine -> state) for other machines.
const RL_DISMISSED = "readlist.rl-dismissed";
const RL_DISMISSED_REMOTE = "readlist.rl-dismissed-remote";
const ICON = { md: "file-text", text: "file-text", code: "file-code", html: "app-window", image: "image", pdf: "book-open", folder: "folder", url: "link", file: "file" };
const ROW = 46, HEAD = 30, RAIL_ROW = 28;
const KEYS = {
  down: "down", j: "down", up: "up", k: "up", home: "top", g: "top", end: "bottom", "shift-g": "bottom",
  enter: "open", space: "preview", r: "read", d: "done", u: "undo", "shift-d": "delete", tab: "view",
  p: "pane", o: "reveal", c: "copy", "/": "find", f: "filter", v: "viewer", "shift-r": "refresh",
};
// Search in the viewer (core/search.js): its text size and row height, and a monospace
// character's width as a share of the size (a little over most code fonts' 0.6), which sets
// how many characters a row holds.
const SEARCH_FONT = 12, SEARCH_LINE = 18, MONO_WIDTH = 0.62;
// The preview's height when it shows below the list (a narrow pane, after `p`): half the
// pane, at most BELOW.
const BELOW = 260;
// Cached images and thumbnails: hidden, so writing them does not reload the mod (row 17).
const CACHE = `${MOD}/.cache/local`;
// Copies of other machines' files, and images made from them (core/remote.js copyPaths).
const REMOTE_CACHE = `${MOD}/.cache`;

// Shared values (docs/design.md 4.4): the arrival claims, ids not to toast (dropped by the
// person), the unread count, the item selected last, the viewer pane, and a filter menu's pick.
const TOASTED = "readlist.toasted", QUIET = "readlist.quiet", UNREAD = "readlist.unread";
const SELECTED = "readlist.selected", VIEWER = "readlist.viewer", PICK = "readlist.pick";
const KEYBOARD = "readlist.keyboard";
// Bumped when the person turns their handler on or off, so every copy checks it again.
const HANDLER = "readlist.handler";
const DOUBLE_MS = 500;

const MENU_TITLE = { space: "Space", agent: "Agent", type: "Type", unread: "Show", sources: "Also add", actions: "Actions" };
const ALL = { space: "All spaces", agent: "All agents", type: "All types" };
const MENU_ROW = 29, MENU_HEAD = 25;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// ISO time with milliseconds, so a quick done-then-undone keeps its order.
const nowIso = () => new Date().toISOString();

export default class ReadingList extends View {
  init(_props, cx) {
    // Tells this copy's claims and menu picks from the other copies'.
    this.copy = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    this.handle = cx.focus_handle();
    // "macos", "linux" or "windows" (core/platform.js).
    this.platform = platformOf(appWindow());
    if (props()?.menu) {
      this.at = Math.max(0, this.menuRows().filter((r) => !r.head).findIndex((r) => r.on));
      this.handle.focus();
      cx.timer.after(300, () => this.handle.focus());
      // While it is open the menu takes the reading list's commands (j, k, Enter bound in
      // keys.json, herdr-app do), then hands them back to the copy that opened it.
      this.before = shared(KEYBOARD) ?? null;
      setShared(KEYBOARD, { copy: this.copy });
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          if (takesCommand(shared(KEYBOARD), this.copy, null, c) && this.menuKey(c)) cx.notify();
        }
      });
      return;
    }
    // Every item (this machine's and the others'), and each one's STAT kind and mtime by
    // item key (core/remote.js mergeItems). `local` and `localSt` are this machine's.
    this.items = [];
    this.fs = {};
    this.mt = {};
    this.local = [];
    this.localSt = { fs: {}, mt: {} };
    // Other machines: name -> their state (core/remote.js), the ones being listed now, and
    // the copies fetched (item key -> ms), being fetched (key -> promise).
    this.remote = new Map();
    this.polling = new Set();
    this.fetched = new Map();
    this.fetching = new Map();
    this.metaRead = new Set();
    // What arrived since each source's last listing (null: here; else a machine name).
    this.seen = new Map();
    this.state = parseState(null);
    this.view = "list";
    this.sel = null;
    this.error = null;
    this.loaded = false;
    // The preview: `choice` is the person's `p` (null until they press it; the popup starts
    // with it off), `pv` what it shows, `gen` counts reloads so the selected item's preview
    // follows file changes.
    this.choice = this.popup() ? false : null;
    this.pv = null;
    this.gen = 0;
    // Filters (in memory, per copy) and the `/` box.
    this.f = { ...NO_FILTER };
    this.finding = false;
    this.typing = false;
    this.input = InputState.new({ placeholder: "Filter by title, note or path" });
    this.input.on("change", (_e, cx) => { this.f = { ...this.f, text: this.input.value() }; cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; if (!this.f.text) this.finding = false; cx.notify(); });
    // Arrivals waiting for their burst to end (arrival key -> item).
    this.pending = new Map();
    this.reclaims = 0;
    // Files Claude Code agents sent (core/sent.js): each agent's transcript as last read
    // (address -> { sig, session, sends }), and the agents' addresses and states then.
    this.sentCache = new Map();
    this.agentKey = "";
    // The person's handler (core/handlers.js handlerState), the reason the built-in handler
    // gave for not showing a preview window (then Space uses the pane), the thumbnails no
    // handler made (cache name -> the preview to show instead, so a failure is not tried
    // again until the file or the handlers change), and the last refusal toasted.
    this.hs = { state: "off" };
    this.noLook = null;
    this.thumbFailed = new Map();
    this.refusedSaid = null;
    this.scroll = VirtualListScrollHandle.new();
    if (this.role() === "viewer") this.initSearch();
    cx.spawn(async (cx) => {
      try {
        const r = await this.helper("dir");
        if (r.code !== 0) throw new Error(r.stderr.trim() || "cannot create the reading-list folder");
        this.dir = r.stdout.trim();
      } catch (e) {
        this.error = this.platform === "windows" && noPwsh(String(e?.message ?? e)) ? NEEDS_PWSH : String(e?.message ?? e);
        cx.notify();
        return;
      }
      await this.reload(cx);
      this.watch(cx);
    });
    this.checkRl(cx);
    this.checkHandler(cx);
    // Other machines: listed now and every POLL_MS while this copy is alive.
    this.pollAll(cx);
    cx.timer.every(POLL_MS, (cx) => this.pollAll(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        // A command reaches every shown copy: only the one the person uses acts on it.
        const c = await nextCommand();
        if (takesCommand(shared(KEYBOARD), this.copy, this.role(), c)) this.act(c, cx);
      }
    });
    if (this.popup()) {
      this.focus();
      cx.timer.after(300, () => this.handle.focus());
    }
    // Relative times ("5m") move on, and files changed since they were read get their
    // "changed" chip (items' files are outside the watched folder).
    cx.timer.every(30000, (cx) => {
      if (this.dir) this.reload(cx);
      else cx.notify();
      // rl may have been installed (or removed) from a terminal; the person's handler edited.
      this.checkRl(cx);
      this.checkHandler(cx);
      this.scanSent(cx);
    });
    // An agent's send usually ends or pauses its turn: read the transcripts again when a
    // Claude Code agent comes or goes or changes state.
    cx.timer.every(3000, (cx) => {
      const key = agents().filter(isClaudeAgent).map((a) => `${a.address}:${a.status}`).join(" ");
      if (key === this.agentKey) return;
      this.agentKey = key;
      this.scanSent(cx);
    });
  }

  role() {
    return props()?.role ?? null;
  }

  // The mod's folder, absolute, in this platform's form.
  modDir() {
    return joinPath(appHome(), MOD);
  }

  // Runs helper `op` (core/helpers.js) with `args`: here, or with `on` on another machine
  // (always an sh script there). Resolves with exec's result.
  helper(op, args = [], options = undefined) {
    const on = options?.on ?? null;
    const c = helperCall(on ? "posix" : this.platform, this.modDir(), op, args);
    return options === undefined ? exec(c.command, c.args) : exec(c.command, c.args, options);
  }

  // A file in the list folder.
  file(name) {
    return joinPath(this.dir, name);
  }

  // Whether rl is installed and on PATH here, for the banner (core/install.js).
  checkRl(cx) {
    cx.spawn(async (cx) => {
      const r = await this.helper("rl-status").catch(() => null);
      const status = parseRlStatus(r?.stdout);
      if (status.state === this.rl?.state && status.path === this.rl?.path) return;
      this.rl = status;
      cx.notify();
    });
  }

  // "Install rl" (the banner's button, readlist.install-rl): copies the mod's rl to
  // ~/.local/bin here (on Windows also putting that folder on the person's PATH, as the
  // banner says), or on `machine`, never over another program, and says how it went.
  // `installing` is the machine being installed on ("" here), or null.
  installRl(cx, machine = null) {
    if (this.installing != null) return;
    this.installing = machine ?? "";
    cx.spawn(async (cx) => {
      const failed = (e) => ({ stdout: "", stderr: String(e?.message ?? e) });
      let r;
      if (machine) {
        // The file is here: its text goes to the other machine as an argument.
        const text = await readTextFile(joinPath(appHome(), RL)).catch(() => null);
        r = text
          ? await exec("sh", ["-c", INSTALL_RL_TEXT_SCRIPT, "readlist", text], { on: machine }).catch(failed)
          : { stdout: "error\tthe mod's rl is missing", stderr: "" };
      } else r = await this.helper("install-rl", [rlSource(this.platform, this.modDir())]).catch(failed);
      this.installing = null;
      notify({ title: "Reading list", ...installToast(r.stdout || r.stderr, machine, this.platform) });
      if (machine) this.poll(machine, cx);
      else this.checkRl(cx);
      cx.notify();
    });
  }

  rlDismissed() {
    try {
      return localStorage.getItem(RL_DISMISSED);
    } catch {
      return null;
    }
  }

  dismissRl() {
    try {
      localStorage.setItem(RL_DISMISSED, this.rl?.state ?? "");
    } catch {
      // No storage: the banner just stays.
    }
  }

  // Machine -> the rl state the person dismissed there.
  remoteDismissed() {
    try {
      const v = JSON.parse(localStorage.getItem(RL_DISMISSED_REMOTE) ?? "{}");
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  dismissRemoteRl(machine) {
    try {
      const state = this.remote.get(machine)?.rl?.state ?? "";
      localStorage.setItem(RL_DISMISSED_REMOTE, JSON.stringify({ ...this.remoteDismissed(), [machine]: state }));
    } catch {
      // No storage: the banner just stays.
    }
  }

  // Gives this copy the keyboard, and the commands with it (core/viewer.js takesCommand).
  focus() {
    this.handle.focus();
    this.own();
  }

  own() {
    if (this.role() !== "viewer" && shared(KEYBOARD)?.copy !== this.copy) setShared(KEYBOARD, { copy: this.copy });
  }

  // The copy is going (the popup closed, its pane or block removed): hand commands back.
  async close() {
    if (shared(KEYBOARD)?.copy === this.copy) setShared(KEYBOARD, props()?.menu ? this.before : null);
  }

  // The cmd-shift-i (ctrl-shift-i on Linux and Windows) popup (an overlay that is not a filter menu).
  popup() {
    return Boolean(props()?.overlay) && !props()?.menu;
  }

  watch(cx) {
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(this.dir);
          await this.reload(cx);
        }
      } catch {
        // No watch (unlikely on macOS): poll instead.
        cx.timer.every(5000, (cx) => this.reload(cx));
      }
    });
  }

  // Reads every item file and state.json; one reload at a time, and one more if
  // something changed meanwhile.
  async reload(cx) {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    try {
      do {
        this.again = false;
        const [list, stateText] = await Promise.all([
          this.helper("list", [this.file("items")]),
          readTextFile(this.file("state.json")),
        ]);
        const items = parseListing(list.stdout);
        const paths = items.filter((i) => i.path).map((i) => i.path);
        let st = { fs: {}, mt: {} };
        if (paths.length) st = parseStats((await this.helper("stats", paths)).stdout, paths);
        const ids = items.map((i) => i.id).sort().join(" ");
        if (ids !== this.ids) {
          this.ids = ids;
          this.helper("prune", [joinPath(appHome(), CACHE), ...items.map((i) => i.id)]).catch(() => {});
        }
        this.local = onMachine(items, null);
        this.localSt = st;
        this.merge();
        this.gen++;
        const wasOn = sentOn(this.state);
        this.state = parseState(stateText);
        if (sentOn(this.state) && !wasOn) this.scanSent(cx);
        this.error = null;
        this.loaded = true;
        this.arrived(null, this.local, cx);
        this.publish();
      } while (this.again);
    } catch (e) {
      this.error = String(e?.message ?? e);
    } finally {
      this.loading = false;
    }
    cx.notify();
    this.takeInbox(cx);
  }

  // Every item, this machine's and the others' (core/remote.js mergeItems).
  merge() {
    const m = mergeItems(this.local, this.localSt, this.remote);
    this.items = m.items;
    this.fs = m.fs;
    this.mt = m.mt;
  }

  // ---- other machines (core/remote.js, docs/design.md 4.6) ----

  // Lists every machine whose layout is ready; marks unreachable ones offline (their items
  // stay) and forgets removed ones.
  pollAll(cx) {
    const { remote, poll } = syncMachines(this.remote, machines());
    const changed = remote.size !== this.remote.size || [...remote].some(([n, e]) => this.remote.get(n) !== e);
    this.remote = remote;
    if (changed) {
      this.merge();
      this.publish();
      cx.notify();
    }
    for (const name of poll) this.poll(name, cx);
  }

  // One exec on `name` lists its items, says whether rl is there and stats the files from
  // the last listing. A machine that does not answer keeps its items, marked offline; a
  // listing with files not stat-ed yet is followed by one more poll at once.
  async poll(name, cx, again = false) {
    if (this.polling.has(name)) return;
    this.polling.add(name);
    let entry;
    try {
      const paths = pollPaths(this.remote.get(name));
      let parsed = null, error = null;
      try {
        const r = await exec("sh", ["-c", POLL_SCRIPT, "readlist", ...paths], { on: name, timeout: POLL_TIMEOUT_MS });
        parsed = parsePoll(r.stdout, paths);
        if (!parsed.ok) error = r.stderr.trim() || `the listing ended early (exit ${r.code})`;
      } catch (e) {
        error = String(e?.message ?? e);
      }
      // Removed from Herdr meanwhile.
      if (!this.remote.has(name)) return;
      entry = afterPoll(this.remote.get(name), parsed, Date.now(), error);
      this.remote.set(name, entry);
    } finally {
      this.polling.delete(name);
    }
    this.merge();
    if (entry.status === "online") {
      const items = onMachine(entry.items, name);
      this.arrived(name, items, cx);
      const ids = items.map((i) => i.id).sort().join(" ");
      if (ids !== this.remoteIds?.get(name)) {
        (this.remoteIds ??= new Map()).set(name, ids);
        this.helper("prune-copies", [joinPath(appHome(), `${REMOTE_CACHE}/remote/${safeName(name)}`), ...items.map((i) => i.id)]).catch(() => {});
      }
      this.seedFetched(items, cx);
      if (!again && unstated(entry).length) this.poll(name, cx, true);
    }
    this.publish();
    cx.notify();
  }

  // The rows' "copy from <machine>, fetched HH:MM" for copies fetched before this copy of
  // the mod started: read from each item's meta once.
  seedFetched(items, cx) {
    const todo = items.filter((i) => i.path && !this.metaRead.has(itemKey(i)));
    if (!todo.length) return;
    for (const i of todo) this.metaRead.add(itemKey(i));
    cx.spawn(async (cx) => {
      const metas = await Promise.all(todo.map((i) => this.copyMeta(i)));
      let any = false;
      todo.forEach((i, n) => {
        if (metas[n] && !this.fetched.has(itemKey(i))) {
          this.fetched.set(itemKey(i), metas[n].at);
          any = true;
        }
      });
      if (any) cx.notify();
    });
  }

  // R: lists this machine and every other one again now.
  refresh(cx) {
    if (this.dir) this.reload(cx);
    this.pollAll(cx);
  }

  // The file's stat on its machine: { kind, mtime, size }. Rejects when it doesn't answer.
  async statOn(item) {
    const r = await this.helper("stat1", [item.path], { on: item.machine ?? null, timeout: POLL_TIMEOUT_MS });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `stat exited ${r.code}`);
    return parseStat(r.stdout);
  }

  copyMeta(item) {
    const p = copyPaths(item.machine, item.id, item.path);
    return readTextFile(joinPath(appHome(), `${REMOTE_CACHE}/${p.meta}`)).then(parseMeta, () => null);
  }

  // The machine's ssh target (hc machine ls), for scp; null if unknown.
  async sshTarget(machine) {
    const r = await hc(["machine", "ls", "--json"]).catch(() => null);
    try {
      return JSON.parse(r?.stdout ?? "").machines.find((m) => m.name === machine)?.target ?? null;
    } catch {
      return null;
    }
  }

  // A local copy of a remote item's file, fetched when there is none or the file changed
  // there (`st` is its stat there). Resolves with the copy's absolute path. Up to
  // BASE64_MAX the file comes as base64 through exec; above, in chunks through hc exec,
  // else with scp. Each fetch checks the size it got. `loud`: the person asked for it
  // (Enter, Space, o), so a slow fetch says it started.
  fetchCopy(item, st, loud = false) {
    const key = itemKey(item);
    if (this.fetching.has(key)) return this.fetching.get(key);
    const root = joinPath(appHome(), REMOTE_CACHE);
    const p = copyPaths(item.machine, item.id, item.path);
    const out = joinPath(root, p.copy), meta = joinPath(root, p.meta);
    const job = (async () => {
      const had = await this.copyMeta(item);
      if (!isStale(had, st)) {
        this.fetched.set(key, had.at);
        return out;
      }
      const args = [String(st.size), String(st.mtime ?? 0), meta];
      let r;
      if (fetchRoute(st.size) === "base64") {
        const b = await exec("sh", ["-c", BASE64_SCRIPT, "readlist", item.path], { on: item.machine, timeout: 120000 });
        if (b.code !== 0) throw new Error(b.stderr.trim() || `base64 exited ${b.code}`);
        const mk = await this.helper("mkdir", [joinPath(root, p.dir)]);
        if (mk.code !== 0) throw new Error(mk.stderr.trim() || "cannot make the cache folder");
        const tmp = joinPath(root, `${p.dir}/.b64.${Math.random().toString(36).slice(2)}`);
        await writeTextFile(tmp, b.stdout, null);
        r = await this.helper("decode", [tmp, out, ...args]);
      } else {
        if (loud) notify({ title: "Reading list", body: `Fetching ${item.title} (${sizeLabel(st.size)}) from ${item.machine}…`, level: "info", timeout: 4000 });
        const target = (await this.sshTarget(item.machine)) ?? "";
        r = await this.helper("chunks", [item.machine, item.path, out, args[0], args[1], meta, target], { timeout: 600000 });
      }
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      this.fetched.set(key, (await this.copyMeta(item))?.at ?? Date.now());
      return out;
    })();
    this.fetching.set(key, job);
    const done = () => this.fetching.delete(key);
    job.then(done, done);
    return job;
  }

  // Enter, Space or o on another machine's file: its local copy, fetched if needed, as
  // { path, st }; null (after saying why) when there is none to use. A file over
  // ASK_BYTES is fetched only on a second press within ASK_MS.
  async copyFor(item, press) {
    const where = item.machine;
    let st;
    try {
      st = await this.statOn(item);
    } catch (e) {
      notify({ title: "Reading list", body: `${where} is not answering: ${String(e?.message ?? e)}`, level: "warning" });
      return null;
    }
    if (st.kind === "-") {
      notify({ title: "Reading list", body: `${item.title} is gone from ${where}: ${item.path}`, level: "warning" });
      return null;
    }
    if (st.kind === "d") {
      notify({ title: "Reading list", body: `${item.title} is a folder on ${where}; the preview lists it, and c copies its path.`, level: "info" });
      return null;
    }
    const key = itemKey(item);
    if (needsAsk(st.size) && isStale(await this.copyMeta(item), st)) {
      if (!(this.ask?.key === key && Date.now() - this.ask.at < ASK_MS)) {
        this.ask = { key, at: Date.now() };
        notify({ title: "Reading list", body: `${item.title} is ${sizeLabel(st.size)} on ${where}. Press ${press} again to fetch a copy.`, level: "info" });
        return null;
      }
      this.ask = null;
    }
    try {
      return { path: await this.fetchCopy(item, st, true), st };
    } catch (e) {
      notify({ title: "Reading list", body: `Couldn't fetch ${item.title} from ${where}: ${String(e?.message ?? e)}`, level: "error" });
      return null;
    }
  }

  // The unread count, for a badge elsewhere (docs/design.md 4.4). Every copy computes the
  // same number, so only a change is written.
  publish() {
    const n = counts(this.items, this.state).unread;
    if (shared(UNREAD) !== n) setShared(UNREAD, n);
  }

  // New and re-added items since this copy's last listing of `source` (null: here, else a
  // machine): claim them, and toast what this copy still holds when the burst ends
  // (core/arrival.js).
  arrived(source, items, cx) {
    const seen = this.seen.get(source) ?? null;
    this.seen.set(source, new Set(items.map(arrivalKey)));
    const fresh = arrivals(seen, items);
    if (!fresh.length) return;
    setShared(TOASTED, claim(shared(TOASTED), fresh.map(arrivalKey), this.copy, Date.now()));
    for (const i of fresh) this.pending.set(arrivalKey(i), i);
    this.burst(cx, BURST_MS);
  }

  burst(cx, ms) {
    if (this.burstTimer) return;
    this.burstTimer = cx.timer.after(ms, (cx) => this.flush(cx));
  }

  flush(cx) {
    this.burstTimer = null;
    const now = Date.now();
    const keys = [...this.pending.keys()];
    const { mine, missing, theirs } = owners(shared(TOASTED), keys, this.copy);
    for (const k of theirs) this.pending.delete(k);
    if (missing.length && this.reclaims < 3) {
      // Another copy's write replaced ours: claim again, and look once more shortly.
      this.reclaims++;
      setShared(TOASTED, claim(shared(TOASTED), missing, this.copy, now));
      this.burst(cx, 300);
      return;
    }
    this.reclaims = 0;
    this.pending.clear();
    const hush = quietIds(shared(QUIET), now);
    const listed = new Map(this.items.map((i) => [arrivalKey(i), i]));
    const items = mine.map((k) => listed.get(k)).filter((i) => i && !hush.has(itemKey(i)) && !isRead(i, this.state) && !isDone(i, this.state));
    if (!items.length) return;
    notify({ ...toastFor(items, agents()), level: "info", action: toastAction(panes(), viewerPane(shared(VIEWER), panes())) });
  }

  // The drop folder: adds new or replaced entries with rl, each by one copy only (the one
  // whose state.json write recorded it; core/inbox.js).
  async takeInbox(cx) {
    if (!this.dir) return;
    if (this.inboxBusy) {
      this.inboxAgain = true;
      return;
    }
    this.inboxBusy = true;
    try {
      do {
        this.inboxAgain = false;
        const r = await this.helper("inbox", [this.file("inbox")]);
        const entries = parseInbox(r.stdout);
        const path = this.file("state.json");
        let todo = [];
        let wait = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          const text = await readTextFile(path);
          const st = parseState(text);
          const plan = inboxPlan(entries, st.inbox, Date.now() / 1000);
          wait = plan.wait;
          if (!plan.changed) break;
          try {
            await writeTextFile(path, serializeState(withInbox(st, plan.inbox)), text);
            todo = plan.todo;
            break;
          } catch {
            // Another copy wrote first: read again (it may have taken these entries).
          }
        }
        if (todo.length) await this.add(todo.map((e) => joinPath(this.dir, "inbox", e.name)), "inbox");
        if (wait && !this.settleTimer) this.settleTimer = cx.timer.after(1500, (cx) => { this.settleTimer = null; this.takeInbox(cx); });
      } while (this.inboxAgain);
    } catch (e) {
      notify({ title: "Reading list", body: `Couldn't read the inbox folder: ${String(e?.message ?? e)}`, level: "warning" });
    } finally {
      this.inboxBusy = false;
    }
  }

  // Runs rl add on `paths`; returns the ids it printed.
  async add(paths, from) {
    const r = await this.helper("add", [rlFile(this.platform, this.modDir()), from, ...paths]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    if (r.code !== 0) notify({ title: "Reading list", body: `Couldn't add to the list: ${r.stderr.trim()}`, level: "error" });
    return r.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{16}$/.test(l));
  }

  // ---- files Claude Code agents sent (core/sent.js) ----

  // Reads the transcripts of the Claude Code agents here and adds the files they sent since
  // the person turned this on, each by one copy only (the one whose state.json write
  // recorded the send). One scan at a time, and one more if asked meanwhile.
  scanSent(cx) {
    if (this.role() === "viewer" || !this.dir || !sentOn(this.state)) return;
    if (this.sentBusy) {
      this.sentAgain = true;
      return;
    }
    this.sentBusy = true;
    cx.spawn(async () => {
      try {
        do {
          this.sentAgain = false;
          await this.scanSentOnce();
        } while (this.sentAgain);
      } catch (e) {
        console.log(`readlist: reading Claude Code transcripts failed: ${String(e?.message ?? e)}`);
      } finally {
        this.sentBusy = false;
      }
    });
  }

  async scanSentOnce() {
    const claude = agents().filter(isClaudeAgent);
    for (const address of this.sentCache.keys()) if (!claude.some((a) => a.address === address)) this.sentCache.delete(address);
    if (!claude.length) return;
    const pids = await Promise.all(claude.map((a) => hc(["get", a.address, "--json"]).then((r) => foregroundPid(r.stdout), () => null)));
    const args = [];
    claude.forEach((a, n) => {
      if (pids[n]) args.push(a.address, String(pids[n]), this.sentCache.get(a.address)?.sig ?? "");
    });
    if (!args.length) return;
    const r = await this.helper("scan", ["", ...args]);
    const scan = [];
    for (const s of parseScan(r.stdout)) {
      const had = this.sentCache.get(s.address);
      if (s.same && had?.session !== s.session) {
        // Unchanged, but not the session this copy read last: read it in full next time.
        this.sentCache.delete(s.address);
        this.sentAgain = true;
        continue;
      }
      const sends = s.same ? had.sends : s.sends;
      this.sentCache.set(s.address, { sig: s.sig, session: s.session, sends });
      scan.push({ ...s, sends });
    }
    const path = this.file("state.json");
    let todo = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const text = await readTextFile(path);
      const st = parseState(text);
      const plan = sentPlan(scan, st.claude_files, Date.now());
      if (!plan.changed) break;
      try {
        await writeTextFile(path, serializeState({ ...st, claude_files: plan.record }), text);
        todo = plan.todo;
        break;
      } catch {
        // Another copy wrote first: read again (it may have taken these sends).
      }
    }
    if (!todo.length) return;
    const a = await this.helper("sent-add", [rlFile(this.platform, this.modDir()), ...sentAddArgs(todo)]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    if (a.code !== 0) notify({ title: "Reading list", body: `Couldn't add a file Claude Code sent: ${a.stderr.trim()}`, level: "warning" });
  }

  // The f menu's "Files Claude Code sends" (readlist.claude-files): turns the source on or off.
  toggleSent(cx) {
    if (!this.dir) return;
    const path = this.file("state.json");
    cx.spawn(async (cx) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const text = await readTextFile(path);
        const st = parseState(text);
        const on = !sentOn(st);
        const next = setSent(st, on, nowIso());
        try {
          await writeTextFile(path, serializeState(next), text);
        } catch {
          // Another copy wrote first: read again.
          continue;
        }
        this.state = next;
        notify({
          title: "Reading list",
          body: on ? "Files your Claude Code agents send you are added to the list from now on." : "Files Claude Code agents send are no longer added.",
          level: "info",
          timeout: 4000,
        });
        if (on) this.scanSent(cx);
        cx.notify();
        return;
      }
      notify({ title: "Reading list", body: "Couldn't save the setting; try again.", level: "warning" });
    });
  }

  // Files dropped onto the list: added from "dropped", without a toast (the person put them
  // there), and the first one selected.
  dropped(paths, cx) {
    if (!paths?.length || !this.dir) return;
    cx.spawn(async (cx) => {
      const ids = await this.add(paths, "dropped");
      if (!ids.length) return;
      setShared(QUIET, quiet(shared(QUIET), ids, Date.now()));
      this.view = "list";
      this.wantSel = ids[0];
      await this.reload(cx);
    });
  }

  // Applies an action to state.json with compare-and-swap, retrying on a stale read. `id`
  // is the item's key (core/items.js itemKey).
  // Resolves once it is saved (or given up), so the popup can close after it.
  mark(id, action, cx, mtime) {
    this.state = applyAction(this.state, id, action, nowIso(), mtime);
    cx.notify();
    const path = this.file("state.json");
    return new Promise((resolve) => cx.spawn(async (cx) => {
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const text = await readTextFile(path);
          const next = prune(applyAction(parseState(text), id, action, nowIso(), mtime), this.items.map(itemKey), Date.now(), undefined, listedMachines(this.remote));
          try {
            await writeTextFile(path, serializeState(next), text);
            this.state = next;
            this.publish();
            cx.notify();
            return;
          } catch {
            // Another copy wrote first: read again.
          }
        }
        notify({ title: "Reading list", body: "Couldn't save the read state; try again.", level: "warning" });
      } finally {
        resolve();
      }
    }));
  }

  // Enter: opens the item and marks it read; true when it opened. Another machine's file
  // opens from its local copy.
  async open(item, cx) {
    let kind = null, mtime = null;
    if (item.path && item.machine) {
      const c = await this.copyFor(item, "Enter");
      if (!c) return false;
      const act = openAction({ ...item, path: c.path }, c.st.kind, this.platform);
      const r = await this.launch(act.how, act.target, cx);
      if (!r.ok) {
        notify({ title: "Reading list", body: `Couldn't open ${item.title}: ${r.message}`, level: "error" });
        return false;
      }
      if (act.how === "reveal") notify({ title: "Reading list", body: `${item.title} could run, so its copy is shown in ${words(this.platform).files} instead of opened.`, level: "info" });
      await this.mark(itemKey(item), "read", cx, c.st.mtime);
      return true;
    }
    if (item.path) {
      const r = await this.helper("stats", [item.path]).catch(() => null);
      const st = parseStats(r?.stdout ?? "", [item.path]);
      kind = st.fs[item.path];
      mtime = st.mt[item.path];
    }
    const act = openAction(item, kind, this.platform);
    if (act.how === "missing") {
      notify({ title: "Reading list", body: `${item.title} is gone: ${item.path}`, level: "warning" });
      return false;
    }
    if (act.how === "url") {
      // An http(s) link goes to the handlers first (the built-in ones pass it on); any
      // other link, and one no handler took, opens through Herdr in the browser.
      const r = /^https?:\/\//i.test(act.target) ? await this.runAction("open-url", act.target, {}, cx) : { status: "pass" };
      if (r.status === "failed") {
        notify({ title: "Reading list", body: `Couldn't open ${item.title}: ${r.message}`, level: "error" });
        return false;
      }
      if (r.status === "pass") cx.open_url(act.target);
    } else {
      const r = await this.launch(act.how, act.target, cx);
      if (!r.ok) {
        notify({ title: "Reading list", body: `Couldn't open ${item.title}: ${r.message}`, level: "error" });
        return false;
      }
      if (act.how === "reveal") notify({ title: "Reading list", body: `${item.title} could run, so it's shown in ${words(this.platform).files} instead of opened.`, level: "info" });
    }
    await this.mark(itemKey(item), "read", cx, mtime);
    return true;
  }

  // Opens (how "open") or reveals (how "reveal") a file through the handlers: { ok } or
  // { ok: false, message } for the toast.
  async launch(how, path, cx) {
    const r = await this.runAction(how, path, {}, cx);
    if (r.status === "ok") return { ok: true };
    return { ok: false, message: r.status === "pass" ? "this platform is not supported yet" : r.message };
  }

  // ---- action handlers (core/handlers.js) ----

  trustPath() {
    return joinPath(appHome(), TRUST_FILE);
  }

  handlerPath() {
    return joinPath(appHome(), userHandler(this.platform));
  }

  // The handlers to try now, first to last: the person's while trust.json says it is on
  // (bin/run-handler refuses it unless it is still the file they turned on), then the
  // platform's built-in one.
  async handlers() {
    const trust = parseTrust(await readTextFile(this.trustPath()).catch(() => null), this.platform);
    return chain(this.platform, appHome(), trust, MOD);
  }

  // Runs `action` on `item` (a path; a link for open-url) through the handlers in turn
  // until one handles it: { status: "ok" | "failed" | "pass", stdout, message, who }. Each
  // handler runs once, with a time limit; nothing is tried again. `extra(h)` gives the
  // action's arguments, `only` limits it to one handler ("user" or "builtin"), `list` is
  // the handlers to use (default: handlers()).
  async runAction(action, item, { extra = () => [], only = null, list = null } = {}, cx) {
    return runChain(list ?? (await this.handlers()), action, item, {
      exec: (command, args) => exec(command, args, { timeout: TIMEOUT_MS }),
      extra,
      only,
      platform: this.platform,
      // The built-in handler said it has no preview window here (no Sushi): not asked again.
      skip: (h) => action === "preview" && h.who === "builtin" && Boolean(this.noLook),
      onRefused: (message) => this.refused(message, cx),
      onPass: (h, message) => {
        if (action === "preview" && h.who === "builtin") this.noLook = { reason: /^it exited with \d+$/.test(message) ? "" : message };
      },
    });
  }

  // bin/run-handler would not run the person's handler (it changed, moved, or is not safe):
  // the built-in one acts instead. Says so once per reason, and checks it again for the
  // banner.
  refused(message, cx) {
    if (this.refusedSaid !== message) {
      this.refusedSaid = message;
      notify({ title: "Reading list", body: `Your handler was not run: ${message}. The built-in action ran instead.`, level: "warning", timeout: 8000 });
    }
    if (cx) this.checkHandler(cx);
  }

  // Which handler the list uses (this.hs), for the banner, the menu and the key hints.
  checkHandler(cx) {
    cx.spawn(async (cx) => {
      const trust = parseTrust(await readTextFile(this.trustPath()).catch(() => null), this.platform);
      let check = null;
      if (trust) {
        const c = checkCall(this.platform, appHome(), MOD);
        const r = await exec(c.command, c.args, { timeout: TIMEOUT_MS }).catch(() => null);
        check = r?.code === 0 ? parseCheck(r.stdout, this.platform) : { state: "refused", why: "it could not be checked" };
      }
      const hs = handlerState(trust, check);
      if (JSON.stringify(hs) === JSON.stringify(this.hs)) return;
      this.hs = hs;
      this.thumbFailed.clear();
      if (hs.state === "on") this.refusedSaid = null;
      // The previews follow: thumbnails may come from another handler now.
      this.gen++;
      cx.notify();
    });
  }

  // readlist.handler, the f menu's Actions and the banner: turns the person's handler on
  // (`want` true: the file as it is now, after its check passes), or off (false). null
  // toggles: off when it is on (or gone, or refused), on when it is off or changed.
  setHandler(want, cx) {
    if (this.settingHandler) return;
    this.settingHandler = true;
    cx.spawn(async (cx) => {
      const say = (body, level = "info") => notify({ title: "Reading list", body, level, timeout: 8000 });
      try {
        const path = this.trustPath();
        const text = await readTextFile(path).catch(() => null);
        const trust = parseTrust(text, this.platform);
        const c = checkCall(this.platform, appHome(), MOD);
        const r = await exec(c.command, c.args, { timeout: TIMEOUT_MS }).catch(() => null);
        const check = r?.code === 0 ? parseCheck(r.stdout, this.platform) : { state: "refused", why: "it could not be checked" };
        const hs = handlerState(trust, check);
        const on = want ?? !["on", "missing", "refused"].includes(hs.state);
        if (on && hs.state === "on") return;
        if (!on && !trust) return;
        if (on && check.state === "missing") return say(`There is no handler at ${this.handlerPath()}. The README's "Your own handler" says how to write one.`, "warning");
        if (on && check.state !== "ok") return say(`Your handler was not turned on: ${check.why}.`, "warning");
        const next = on ? { path: check.path, sha256: check.sha256, at: nowIso() } : null;
        try {
          await writeTextFile(path, serializeTrust(next), text);
        } catch (e) {
          return say(`Couldn't save the setting: ${String(e?.message ?? e)}`, "warning");
        }
        say(on ? `Enter, Space, o and thumbnails now ask your handler first: ${check.path}` : "Your handler is off; the list uses its built-in actions.");
        setShared(HANDLER, Date.now());
        this.handlerSeen = shared(HANDLER);
        this.checkHandler(cx);
      } finally {
        this.settingHandler = false;
        cx.notify();
      }
    });
  }

  // Opens an item; the popup then closes (Enter opens and closes it, docs/design.md 4.1).
  openAndClose(item, cx) {
    cx.spawn(async (cx) => {
      if ((await this.open(item, cx)) && this.popup()) closeOverlay(props().overlay);
    });
  }

  // Space: a preview window from a handler, a toggle like Finder's: the macOS Quick Look
  // panel, GNOME Sushi on Linux, the QuickLook app or PowerToys Peek on Windows, or what the
  // person's handler shows. Without one (none installed, a handler that passes) the in-pane
  // preview instead. Never marks read and never
  // runs anything (both only draw a preview).
  async preview(item, cx) {
    const list = await this.handlers();
    if (!list.some((h) => !(h.who === "builtin" && this.noLook))) return this.previewHere(item, cx);
    const key = itemKey(item);
    // The preview window open now: Space again on its item closes it (and shows it again
    // when there was nothing to close); on another item, its handler is told first.
    const open = this.quicklook;
    this.quicklook = null;
    if (open) {
      const same = open.id === key;
      const r = await this.runAction("preview-close", open.path, { only: open.who, list, extra: () => [open.token, same ? "same" : "other"] }, cx);
      if (same && r.status === "ok") return;
    }
    if (!item.path) {
      notify({ title: "Reading list", body: this.platform === "macos" ? "Quick Look has no preview for a link; Enter opens it." : "A link has no preview window; Enter opens it.", level: "info" });
      return;
    }
    // Another machine's file: the preview window shows its local copy.
    let path = item.path;
    if (item.machine) {
      const c = await this.copyFor(item, "Space");
      if (!c) return;
      path = c.path;
    } else {
      const st = await this.helper("stat", [item.path]).catch(() => null);
      if (st?.stdout.trim() !== "d" && st?.stdout.trim() !== "f" && st?.stdout.trim() !== "x") {
        notify({ title: "Reading list", body: `${item.title} is gone: ${item.path}`, level: "warning" });
        return;
      }
    }
    const r = await this.runAction("preview", path, { list }, cx);
    if (r.status === "pass") return this.previewHere(item, cx);
    if (r.status !== "ok") {
      notify({ title: "Reading list", body: `Couldn't preview ${item.title}: ${r.message}`, level: "error" });
      return;
    }
    this.quicklook = { id: key, path, who: r.who, token: token(r.stdout) };
  }

  // Space without a preview window: shows or hides the in-pane preview (as `p` does), or in
  // the narrow rail opens the viewer pane (as `v`). The first time, a toast says why.
  previewHere(item, cx) {
    if (!this.lookHinted) {
      this.lookHinted = true;
      notify({ title: "Reading list", body: noQuickLook(this.noLook?.reason), level: "info", timeout: 6000 });
    }
    if (this.rail()) return this.toggleViewer({ item }, cx);
    this.choice = !previewShown(this.width, this.choice);
  }

  // The in-pane preview of `item`, at most one being made at a time; the latest selection
  // wins, and what the pane showed stays until the new one is ready.
  wantPreview(item, width, cx) {
    const size = thumbSize(width);
    const k = itemKey(item);
    // Another machine's item: made again when its file changes there (the poll's mtime),
    // a copy is fetched, or the machine goes offline or comes back.
    const version = item.machine ? `${this.mt[k]}|${this.fetched.get(k)}|${isOffline(this.remote, item)}` : this.gen;
    const key = `${k}|${item.added_at}|${size}|${version}`;
    if (key === this.pvKey) return;
    this.pvKey = key;
    this.pvWant = { item, size };
    if (this.pvBusy) return;
    this.pvBusy = true;
    cx.spawn(async (cx) => {
      try {
        let key;
        do {
          key = this.pvKey;
          const { item, size } = this.pvWant;
          let pv;
          try {
            pv = await this.loadPreview(item, size, cx);
          } catch (e) {
            pv = { id: itemKey(item), how: "error", error: String(e?.message ?? e) };
          }
          if (key === this.pvKey) this.setPreview(pv);
          else pv.code?.release();
          cx.notify();
        } while (key !== this.pvKey);
      } finally {
        this.pvBusy = false;
      }
    });
  }

  setPreview(pv) {
    if (this.pv?.code && this.pv.code !== pv?.code) this.pv.code.release();
    this.pv = pv;
  }

  // What the preview shows for `item`. Another machine's text is read there (up to 1 MiB
  // through readTextFile); its images and thumbnails are made from a local copy.
  async loadPreview(item, size, cx) {
    const key = itemKey(item);
    const base = { id: key };
    if (item.url) return { ...base, how: "url" };
    const on = item.machine ?? null;
    let st;
    try {
      st = await this.statOn(item);
    } catch (e) {
      if (on) return { ...base, how: "offline", error: String(e?.message ?? e) };
      throw e;
    }
    let kind = previewKind(item, st.kind);
    const run = async (op, args, where = null) => {
      const r = await this.helper(op, args, { on: where, timeout: 60000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      return r.stdout;
    };
    if (kind.how === "missing" || kind.how === "url") return { ...base, how: kind.how };
    if (kind.how === "folder") return { ...base, how: "folder", folder: parseFolder(await run("listdir", [item.path], on)) };
    if (kind.how === "markdown" || kind.how === "text") {
      let raw;
      if (on && st.size <= 1024 * 1024) {
        // Rejects on text it cannot read as UTF-8: then the head, as here.
        raw = await readTextFile(item.path, { on }).catch(() => undefined);
        if (raw === null) return { ...base, how: "missing" };
        if (typeof raw === "string" && raw.length > TEXT_BYTES) raw = raw.slice(0, TEXT_BYTES);
      }
      if (typeof raw !== "string") raw = await run("head", [item.path], on);
      const text = previewText(raw, st.size);
      if (text === null) kind = THUMB;
      else if (kind.how === "markdown") return { ...base, how: "markdown", text: stripThreads(text) };
      else {
        const t = theme();
        return { ...base, how: "text", text, code: EditorState.new({ language: kind.lang, readonly: true, value: text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } }) };
      }
    }
    // An image GPUI draws is copied as it is; anything else gets a thumbnail from the first
    // handler that makes one, else its type's icon.
    const list = kind.how === "thumb" ? await this.handlers() : [];
    const name = cacheName(item.id, st, kind, size, list.find((h) => h.who === "user")?.tag ?? "");
    const failedKey = `${key}|${name}`;
    if (this.thumbFailed.has(failedKey)) return { ...base, ...this.thumbFailed.get(failedKey) };
    let src = item.path, dir = joinPath(appHome(), CACHE), rel = CACHE;
    if (on) {
      // Over ASK_BYTES, the copy waits for the person's Enter.
      if (needsAsk(st.size) && isStale(await this.copyMeta(item), st)) return { ...base, how: "big", size: st.size };
      src = await this.fetchCopy(item, st);
      const p = copyPaths(on, item.id, item.path);
      dir = joinPath(appHome(), `${REMOTE_CACHE}/${p.thumbs}`);
      rel = `${REMOTE_CACHE}/${p.thumbs}`;
    }
    const image = { ...base, how: "image", src: `${rel}/${name}`, thumb: kind.how === "thumb" };
    if (kind.how === "image") {
      await run("cache", [src, dir, joinPath(dir, name), item.id, "copy"]);
      return image;
    }
    let result = { how: "icon", type: typeOf(item, st.kind) };
    for (const h of list) {
      const r = await this.helper("cache", [src, dir, joinPath(dir, name), item.id, String(size), h.command, ...h.args], { timeout: (THUMB_SECONDS + 15) * 1000 })
        .catch((e) => ({ code: null, stdout: "", stderr: String(e?.message ?? e) }));
      const o = outcome(r);
      if (o.status === "ok") return image;
      if (o.status === "refused") this.refused(o.message, cx);
      else if (o.status === "failed") {
        result = { how: "error", error: o.message };
        break;
      }
    }
    // Not made: remembered until the file, its size here or the handlers change.
    if (this.thumbFailed.size > 500) this.thumbFailed.clear();
    this.thumbFailed.set(failedKey, result);
    return { ...base, ...result };
  }

  // o: show the item in Finder or the file manager (another machine's: its local copy).
  // Revealing never opens or runs anything.
  async reveal(item, cx) {
    const files = words(this.platform).files;
    if (!item.path) {
      notify({ title: "Reading list", body: `A link has no file to show in ${files}; Enter opens it.`, level: "info" });
      return;
    }
    let path = item.path;
    if (item.machine) {
      const c = await this.copyFor(item, "o");
      if (!c) return;
      path = c.path;
    }
    const r = await this.launch("reveal", path, cx);
    if (!r.ok) notify({ title: "Reading list", body: `Couldn't show ${item.title} in ${files}: ${r.message}`, level: "error" });
  }

  // Shift-D: take the item off the list, as `rl rm` does (removes its file, on its machine).
  remove(item, cx) {
    const key = itemKey(item);
    const dir = item.machine ? this.remote.get(item.machine)?.dir : this.dir;
    if (!dir) return;
    if (isOffline(this.remote, item)) {
      notify({ title: "Reading list", body: `Can't remove ${item.title} while ${item.machine} is not answering.`, level: "warning" });
      return;
    }
    this.items = this.items.filter((i) => itemKey(i) !== key);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.helper("rm-item", [itemFile(dir, item.id)], { on: item.machine ?? null }).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: "Reading list", body: `Couldn't remove ${item.title}: ${r.stderr.trim()}`, level: "error" });
      if (item.machine) await this.poll(item.machine, cx);
      else if (r.code !== 0) await this.reload(cx);
    });
  }

  // Selects an item and tells the viewer (shared("readlist.selected")).
  select(id) {
    this.sel = id;
    if (id && selectedId(shared(SELECTED)) !== id) setShared(SELECTED, { id, at: Date.now() });
  }

  // v: opens the viewer pane on the right, or closes it (core/viewer.js).
  toggleViewer(cur, cx) {
    const was = shared(VIEWER);
    // The same toggle may reach a copy twice (a key and its command): once is enough.
    if (typeof was?.at === "number" && Date.now() - was.at < 400) return;
    const open = viewerPane(was, panes());
    if (open) {
      run("pane.close", { pane: open });
      setShared(VIEWER, { pane: null, at: Date.now() });
      return;
    }
    if (this.role() === "viewer") return;
    if (cur) setShared(SELECTED, { id: itemKey(cur.item), at: Date.now() });
    const before = panes();
    const f = focused();
    const at = splitTarget(before, f?.tab, f?.pane ?? before.find((p) => p.focused)?.pane);
    run("pane.split", { direction: "right", ...(at ? { pane: at } : {}), mod: NAME, props: { role: "viewer" } });
    const opened = Date.now();
    // The new pane shows in panes() a moment after the split.
    const find = (tries) => {
      const pane = newPane(before, panes());
      if (pane || tries === 0) setShared(VIEWER, { pane, at: opened });
      else cx.timer.after(100, (cx) => find(tries - 1));
    };
    setShared(VIEWER, { pane: null, at: opened });
    find(20);
    // The list keeps the keyboard, so moving through it moves the viewer.
    this.handle.focus();
  }

  rail() {
    if (this.role() === "sidebar") return (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
    return (this.width ?? Infinity) < 160;
  }

  // The items of the current view before filters: what the filter menus offer.
  pool() {
    return this.items.filter((i) => (this.view === "done") === isDone(i, this.state));
  }

  rows() {
    const rows = rowsFor(applyFilters(this.items, this.f, this.fs), this.state, this.view);
    return filterRows(rows, this.f.unread && this.view === "list");
  }

  // Opens a filter menu (a popup of this mod with props {menu}) for `dims`.
  openMenu(dims) {
    const pool = this.pool();
    const ctx = { fs: this.fs, spaces: spaces(), agents: agents() };
    const sections = dims.map((dim) => dim === "unread"
      ? { dim, title: MENU_TITLE.unread, value: this.f.unread, options: [{ value: false, label: "All items" }, { value: true, label: "Unread only" }] }
      : dim === "sources"
        ? { dim, title: MENU_TITLE.sources, value: sentOn(this.state), options: [{ value: true, label: "Files Claude Code sends" }] }
      : dim === "actions"
        ? { dim, title: MENU_TITLE.actions, value: this.hs.state === "on", options: [{ value: false, label: "Built-in" }, { value: true, label: "Your handler" }] }
        : { dim, title: MENU_TITLE[dim], value: this.f[dim], options: [{ value: null, label: ALL[dim] }, ...options(pool, dim, { ...ctx, chosen: this.f[dim] })] });
    const rows = sections.reduce((n, s) => n + s.options.length, 0);
    const height = Math.min(440, 12 + sections.length * MENU_HEAD + rows * MENU_ROW);
    openOverlay({ mod: NAME, kind: "popup", width: 250, height, props: { menu: sections, target: this.copy } });
  }

  // A pick from a filter menu this copy opened.
  takePick(cx) {
    const pk = shared(PICK);
    if (!pk || pk.target !== this.copy || pk.n === this.pickN) return;
    this.pickN = pk.n;
    if (pk.dim === "sources") this.toggleSent(cx);
    else if (pk.dim === "actions") this.setHandler(Boolean(pk.value), cx);
    else if (pk.dim in this.f) this.f = { ...this.f, [pk.dim]: pk.dim === "unread" ? Boolean(pk.value) : pk.value ?? null };
  }

  clearFilters() {
    this.f = { ...NO_FILTER };
    this.input.set_value("");
    this.finding = false;
  }

  // One action, from a key or a `readlist.<action>` command (keys.json, herdr-app do).
  act(name, cx) {
    if (this.role() === "viewer") {
      if (name === "viewer") this.toggleViewer(null, cx);
      else if (name === "focus") this.handle.focus();
      else return false;
      cx.notify();
      return true;
    }
    const rows = this.rows();
    const items = rows.filter((r) => r.type === "item");
    const at = Math.max(0, items.findIndex((r) => itemKey(r.item) === this.sel));
    const cur = items[at];
    const move = (n) => {
      const next = items[Math.max(0, Math.min(items.length - 1, n))];
      if (!next) return;
      this.select(itemKey(next.item));
      this.scroll.scroll_to_item(rows.indexOf(next));
    };
    const after = () => { const r = items[at + 1] ?? items[at - 1]; return r ? itemKey(r.item) : null; };
    switch (name) {
      case "down": move(at + 1); break;
      case "up": move(at - 1); break;
      case "top": move(0); break;
      case "bottom": move(items.length - 1); break;
      case "open": if (cur) this.openAndClose(cur.item, cx); break;
      // A copy fetched from another machine shows in its row once these finish.
      case "preview": if (cur) cx.spawn(async (cx) => { await this.preview(cur.item, cx); cx.notify(); }); break;
      case "read":
        if (cur) this.mark(itemKey(cur.item), cur.read && this.view === "list" ? "unread" : "read", cx, cur.item.path ? this.mt[itemKey(cur.item)] : null);
        break;
      case "undo":
      case "done":
        if (name === "undo" && this.view !== "done") return false;
        if (cur) {
          this.mark(itemKey(cur.item), this.view === "done" ? "undone" : "done", cx);
          this.select(after());
        }
        break;
      case "delete":
        if (cur) {
          this.select(after());
          this.remove(cur.item, cx);
        }
        break;
      case "pane":
        this.choice = !previewShown(this.width, this.choice);
        // The list may have shrunk under the preview: keep the selection in view.
        if (cur) this.scroll.scroll_to_item(rows.indexOf(cur));
        break;
      case "reveal": if (cur) cx.spawn(async (cx) => { await this.reveal(cur.item, cx); cx.notify(); }); break;
      case "copy":
        if (cur) {
          cx.write_to_clipboard(copyText(cur.item));
          notify({ title: "Reading list", body: `Copied ${copyText(cur.item)}`, level: "info", timeout: 2500 });
        }
        break;
      case "view": this.view = this.view === "done" ? "list" : "done"; this.sel = null; break;
      case "find":
        if (this.rail()) return false;
        // Again with nothing typed: the box goes.
        if (this.finding && !this.f.text && !this.typing) {
          this.finding = false;
          break;
        }
        this.finding = true;
        this.input.focus();
        break;
      case "filter":
        if (this.rail()) return false;
        this.openMenu(["space", "agent", "type", ...(this.view === "list" ? ["unread", "sources", "actions"] : [])]);
        break;
      case "viewer": this.toggleViewer(cur, cx); break;
      case "focus": this.focus(); break;
      case "install-rl": this.installRl(cx); break;
      case "refresh": this.refresh(cx); break;
      case "claude-files": this.toggleSent(cx); break;
      case "handler": this.setHandler(null, cx); break;
      default: return false;
    }
    cx.notify();
    return true;
  }

  keys(e, cx) {
    const k = e.keystroke;
    this.own();
    if (this.typing) {
      // The `/` box has the keyboard: Esc clears and leaves it, Enter or Down goes back to
      // the list with the filter kept. Everything else is typing.
      if (k === "escape") {
        this.input.set_value("");
        this.f = { ...this.f, text: "" };
        this.finding = false;
      } else if (k !== "down" && k !== "enter") return;
      this.handle.focus();
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (k === "escape" && this.f.text && !this.popup()) {
      this.input.set_value("");
      this.f = { ...this.f, text: "" };
      this.finding = false;
      cx.stop_propagation();
      cx.notify();
      return;
    }
    if (this.act(KEYS[k], cx)) cx.stop_propagation();
  }

  // ---- filter menu (props {menu, target}) ----

  menuRows() {
    return (props().menu ?? []).flatMap((s) => [
      { head: true, title: s.title },
      ...s.options.map((o) => ({ dim: s.dim, value: o.value, label: o.label, count: o.count, on: o.value === s.value })),
    ]);
  }

  // A key or command in the menu: move, pick or close. True when handled.
  menuKey(k) {
    const choices = this.menuRows().filter((r) => !r.head);
    const at = Math.min(this.at ?? 0, choices.length - 1);
    if (k === "down" || k === "j") this.at = (at + 1) % choices.length;
    else if (k === "up" || k === "k") this.at = (at + choices.length - 1) % choices.length;
    else if (k === "enter" || k === "space" || k === "open" || k === "preview") this.pick(choices[at]);
    else if (k === "escape") closeOverlay(props().overlay);
    else return false;
    return true;
  }

  pick(r) {
    setShared(PICK, { target: props().target, dim: r.dim, value: r.value, n: Date.now() });
    closeOverlay(props().overlay);
  }

  renderMenu(cx) {
    const t = theme();
    const rows = this.menuRows();
    const choices = rows.filter((r) => !r.head);
    const at = Math.min(this.at ?? 0, choices.length - 1);
    return v_flex().id("rl-menu").track_focus(this.handle).size_full().p(5).bg(t.popover).text_size(12.8).overflow_y_scrollbar()
      .on_key_down((e, cx) => {
        if (!this.menuKey(e.keystroke)) return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(rows.map((r, n) => {
        if (r.head) return div().h(MENU_HEAD).flex_none().px(8).pt(7).text_size(11).text_color(t.dim).child(r.title);
        const i = choices.indexOf(r);
        return h_flex().id(`rl-menu-${n}`).h(MENU_ROW).flex_none().px(8).gap(9).rounded(7).items_center().cursor_pointer()
          .text_color(t.foreground)
          .when(i === at, (el) => el.bg(t.hover))
          .hover((el) => el.bg(t.hover))
          .on_click(() => this.pick(r))
          .child(div().flex_1().min_w(0).truncate().child(r.label))
          .when(typeof r.count === "number", (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(r.count))))
          .child(div().w(14).flex_none().when(r.on, (el) => el.child(svg(`${ICONS}/check.svg`).size(14).text_color(t.foreground))));
      }));
  }

  // ---- the preview (beside or below the list, or the whole viewer pane) ----

  previewBody(item, how, t) {
    const message = (text) => div().p(14).text_size(12).text_color(t.dim).child(text);
    const pv = this.pv?.id === itemKey(item) ? this.pv : null;
    if (!pv) return message("Loading preview…");
    if (how === "full" && this.sr && this.sr.pv === pv) return this.searchBody(pv, t);
    switch (pv.how) {
      case "url":
        return v_flex().p(14).gap(8).text_size(12)
          .child(div().id(`rl-url-${itemKey(item)}`).text_color(t.accent).cursor_pointer().hover((s) => s.underline())
            .on_click((_e, cx) => cx.open_url(item.url)).child(item.url))
          .child(div().text_color(t.dim).child("A link: Enter opens it in the browser."));
      case "missing":
        return v_flex().p(14).gap(8).items_start()
          .child(div().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("gone"))
          .child(div().text_size(12).text_color(t.dim).child("Nothing is at this path any more. d marks it done; Shift-D takes it off the list."));
      case "markdown":
        return div().flex_1().min_h(0).px(14).py(8).child(TextView.markdown(`rl-md-${itemKey(item)}`, pv.text).scrollable(true).selectable(true).size_full()
          .on_link_click((url, cx) => { if (/^https?:\/\//i.test(url)) cx.open_url(url); }));
      case "text":
        return Editor.new(pv.code).flex_1().min_h(0);
      case "image":
        return div().flex_1().min_h(0).p(12).child(image(pv.src).size_full());
      case "icon":
        return v_flex().flex_1().min_h(0).p(14).gap(12).items_center().justify_center()
          .child(svg(`${ICONS}/${ICON[pv.type] ?? "file"}.svg`).size(48).text_color(t.muted))
          .child(div().text_size(12).text_color(t.dim).child(this.platform === "linux" && !this.noLook
            ? "No thumbnail for this type here. Enter opens it; Space shows it in GNOME Sushi."
            : "No thumbnail for this type here. Enter opens it."));
      case "offline":
        return v_flex().p(14).gap(8).items_start()
          .child(div().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("offline"))
          .child(div().text_size(12).text_color(t.dim).child(`${item.machine} is not answering. Its items stay listed from the last time it did; R tries again.`));
      case "big":
        return message(`${item.title} is ${sizeLabel(pv.size)} on ${item.machine}. Enter fetches a copy (it asks first) and opens it; the preview shows here after that.`);
      case "folder":
        return v_flex().id(`rl-folder-${itemKey(item)}`).flex_1().min_h(0).overflow_y_scrollbar().px(10).py(6)
          .children(pv.folder.entries.map((e) => h_flex().h(22).px(4).gap(7).items_center().flex_none()
            .child(svg(`${ICONS}/${e.dir ? "folder" : "file"}.svg`).size(13).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().text_size(12).child(e.name))))
          .when(pv.folder.entries.length === 0, (el) => el.child(message("An empty folder.")))
          .when(pv.folder.more, (el) => el.child(div().p(4).text_size(11).text_color(t.dim).child(`First ${pv.folder.entries.length} entries; Enter opens the folder in ${words(this.platform).files}.`)));
      default:
        return message(`Can't preview this: ${pv.error}`);
    }
  }

  // `how`: "side" (right of the list), "below" (under it) or "full" (the viewer pane).
  previewPane(item, how, t) {
    const roomy = how !== "below";
    const k = itemKey(item);
    const where = item.machine && item.path ? `${item.machine}:${item.path}` : item.path ?? item.url;
    // Another machine's file: where the preview comes from.
    const source = !item.machine || !item.path ? null
      : this.fetched.has(k) ? `${fetchedLabel(item.machine, this.fetched.get(k))}; edits to the copy stay on ${words(this.platform).here}`
      : `on ${item.machine}`;
    return v_flex().id("rl-preview").min_w(0).min_h(0).bg(t.background)
      .when(how === "side", (el) => el.flex_1().h_full().border_l(1).border_color(t.border))
      .when(how === "full", (el) => el.flex_1().size_full())
      .when(how === "below", (el) => el.h(Math.round(Math.min(BELOW, (this.height ?? 2 * BELOW) / 2))).flex_none().border_t(1).border_color(t.border))
      .child(v_flex().px(14).pt(roomy ? 10 : 8).pb(roomy ? 8 : 6).gap(2).flex_none().border_b(1).border_color(t.border)
        .child(div().truncate().font_medium().child(item.title))
        // Below the list, the row above already shows the note: keep the header short.
        .when(roomy, (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(where)))
        .when(Boolean(source), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(source)))
        .when(roomy && Boolean(item.note), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(item.note))))
      .when(how === "full" && this.sBar?.id === k, (el) => el.child(this.searchBar(t)))
      .child(this.previewBody(item, how, t));
  }

  sized(el) {
    return el.on_size_change((size, cx) => {
      this.width = size.width / (settings().zoom ?? 1);
      this.height = size.height / (settings().zoom ?? 1);
      cx.notify();
    });
  }

  renderViewer(cx) {
    const t = theme();
    const item = this.viewerItem();
    if (item) this.wantPreview(item, this.width ?? 0, cx);
    this.followSearch(item);
    return this.sized(v_flex().id("readlist-viewer").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_size(13))
      .on_mouse_down("left", () => { if (!this.sTyping) this.handle.focus(); })
      .on_key_down((e, cx) => {
        if (!this.viewerKey(e.keystroke, cx)) return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(item ? this.previewPane(item, "full", t)
        : div().p(16).text_size(12).text_color(t.dim).child(this.loaded
          ? "Select an item in the reading list to show it here. v closes this pane."
          : ""));
  }

  // ---- search in the viewer (core/search.js, docs/design.md 4.3) ----

  // `sr` is the search on now: { id, pv, query, matches, index, wrapped } (the item key and
  // the preview searched); `sBar` the search bar, shown for item `id`, with `note` instead of
  // the prompt when there is nothing to search. `sJump` asks the next frame to scroll to the
  // current match.
  initSearch() {
    this.sr = null;
    this.sBar = null;
    this.sTyping = false;
    this.sJump = false;
    this.sScroll = VirtualListScrollHandle.new();
    this.sInput = InputState.new({ placeholder: "Find in this item: Enter, then n / Shift-N" });
    this.sInput.on("submit", (_e, cx) => { this.runSearch(); cx.notify(); });
    this.sInput.on("focus", (_e, cx) => { this.sTyping = true; cx.notify(); });
    this.sInput.on("blur", (_e, cx) => { this.sTyping = false; cx.notify(); });
  }

  // The item the viewer shows: the one selected last in any copy.
  viewerItem() {
    const id = selectedId(shared(SELECTED));
    return this.items.find((i) => itemKey(i) === id) ?? null;
  }

  // The text a preview draws, to search; null when it draws none (an image, a folder, ...).
  searchText(pv) {
    return pv && (pv.how === "markdown" || pv.how === "text") && typeof pv.text === "string" ? pv.text : null;
  }

  // A key in the viewer: true when handled. While the prompt has the keyboard, Esc closes the
  // search and everything else is typing (Enter arrives as the prompt's submit).
  viewerKey(k, cx) {
    if (this.sTyping) {
      if (k !== "escape") return false;
      this.closeSearch();
      return true;
    }
    if (k === "/") {
      this.openSearch();
      return true;
    }
    if ((k === "n" || k === "shift-n") && this.sr) {
      this.stepSearch(k === "n" ? 1 : -1);
      return true;
    }
    if (k === "escape" && this.sBar) {
      this.closeSearch();
      return true;
    }
    return this.act(KEYS[k], cx);
  }

  // `/`: the prompt, empty (Enter on it repeats the search on now), or a note when the
  // preview has no text.
  openSearch() {
    const item = this.viewerItem();
    if (!item) return;
    const id = itemKey(item);
    const pv = this.pv?.id === id ? this.pv : null;
    if (!pv) this.sBar = { id, note: "The preview is still loading." };
    else if (this.searchText(pv) === null) this.sBar = { id, note: "Nothing to search in this preview." };
    else {
      this.sBar = { id };
      this.sInput.set_value("");
      this.sInput.focus();
      return;
    }
    this.sr = null;
  }

  // Enter in the prompt: goes to the first match after the current one (from the top when
  // there is none) and marks them all; an empty prompt repeats the search on now.
  runSearch() {
    const item = this.viewerItem();
    const id = item ? itemKey(item) : null;
    const pv = id && this.pv?.id === id ? this.pv : null;
    const text = this.searchText(pv);
    const query = this.sInput.value() || (this.sr?.id === id ? this.sr.query : "");
    this.handle.focus();
    if (text === null || !query) {
      this.closeSearch();
      return;
    }
    const cur = this.sr?.id === id ? this.sr.matches[this.sr.index] : null;
    const matches = findMatches(text, query);
    const at = firstFrom(matches, cur ? cur.start + 1 : 0);
    this.sr = { id, pv, query, matches, index: at?.index ?? -1, wrapped: at?.wrapped ?? false };
    this.sBar = { id };
    this.sInput.set_value(query);
    this.sJump = true;
  }

  // n and Shift-N: the next or previous match, wrapping.
  stepSearch(dir) {
    const at = step(this.sr.matches, this.sr.index, dir);
    if (!at) return;
    this.sr = { ...this.sr, index: at.index, wrapped: at.wrapped };
    this.sJump = true;
  }

  // Esc: the bar goes and the preview draws as before.
  closeSearch() {
    this.sr = null;
    this.sBar = null;
    this.sInput.set_value("");
    this.handle.focus();
  }

  // Each frame: a search ends when the selection moves to another item, and follows the
  // shown item's text when its preview is made again (the file changed, or a reload),
  // staying on the match at or after the one it was on.
  followSearch(item) {
    const id = item ? itemKey(item) : null;
    if (this.sBar && this.sBar.id !== id) {
      this.sr = null;
      this.sBar = null;
      this.sInput.set_value("");
      return;
    }
    const pv = id && this.pv?.id === id ? this.pv : null;
    if (!this.sr || !pv || pv === this.sr.pv) return;
    const text = this.searchText(pv);
    if (text === null) {
      this.sr = null;
      this.sBar = { id, note: "Nothing to search in this preview." };
      return;
    }
    const cur = this.sr.matches[this.sr.index];
    const matches = findMatches(text, this.sr.query);
    const at = firstFrom(matches, cur ? cur.start : 0);
    this.sr = { ...this.sr, pv, matches, index: at?.index ?? -1, wrapped: false };
  }

  searchBar(t) {
    const note = this.sBar.note;
    const sr = this.sr;
    return h_flex().id("rl-search-bar").mx(14).mt(8).mb(2).h(26).px(7).gap(6).flex_none().items_center().rounded(6)
      .border(1).border_color(this.sTyping ? t.accent : t.border).bg(t.background)
      .child(svg(`${ICONS}/search.svg`).size(12).flex_none().text_color(t.dim))
      .child(note
        ? div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(note)
        : Input.new(this.sInput).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
      .when(Boolean(sr), (el) => el.child(div().flex_none().text_size(11).text_color(sr.matches.length ? t.dim : t.blocked)
        .child(matchLabel(sr.matches, sr.index, sr.wrapped))))
      .child(div().id("rl-search-x").flex_none().cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.closeSearch(); cx.notify(); })
        .tooltip("Close the search (Esc)")
        .child(svg(`${ICONS}/x.svg`).size(12)));
  }

  // The shown item's text while a search is on: drawn here, row by row in the code font, so
  // every match can be marked and the current one scrolled to (markdown shows as its source).
  searchBody(pv, t) {
    const sr = this.sr;
    const text = pv.text;
    const cols = Math.floor(((this.width ?? 400) - 28 - 14) / (SEARCH_FONT * MONO_WIDTH));
    if (this.sRows?.text !== text || this.sRows.cols !== cols) this.sRows = { text, cols, rows: wrapRows(text, cols) };
    const rows = this.sRows.rows;
    if (this.sJump && sr.index >= 0) {
      this.sScroll.scroll_to_item(rowOf(rows, sr.matches[sr.index].start), "center");
      this.sJump = false;
    }
    const font = settings().font_family;
    const row = (r) => h_flex().h(SEARCH_LINE).flex_none().overflow_hidden().whitespace_nowrap()
      .when(typeof font === "string" && font.length > 0, (el) => el.font_family(String(font)))
      .text_size(SEARCH_FONT).text_color(t.foreground)
      .children(segments(text, r, sr.matches, sr.index).map((s) => div().flex_none()
        .when(s.mark === "match", (el) => el.bg(t.selection).rounded(2))
        .when(s.mark === "current", (el) => el.bg(t.accent).text_color(t.accent_foreground).rounded(2))
        .child(s.text)));
    return div().id("rl-search").relative().flex_1().min_h(0)
      .child(v_virtual_list("rl-search-rows", rows.length, SEARCH_LINE, (index) => String(index),
        (range) => rows.slice(range.start, range.end).map(row))
        .track_scroll(this.sScroll)
        .size_full()
        .px(14)
        .py(6))
      .child(Scrollbar.vertical("rl-search-rows").absolute().inset_0());
  }

  render(cx) {
    if (props()?.menu) return this.renderMenu(cx);
    if (this.role() === "viewer") return this.renderViewer(cx);
    this.takePick(cx);
    // Another copy turned the person's handler on or off.
    if (shared(HANDLER) !== this.handlerSeen) {
      this.handlerSeen = shared(HANDLER);
      this.checkHandler(cx);
    }
    const t = theme();
    const rail = this.rail();
    const sidebar = this.role() === "sidebar";
    const popup = this.popup();
    const rows = this.rows();
    const n = counts(this.items, this.state);
    const items = rows.filter((r) => r.type === "item");
    if (this.wantSel && this.items.some((i) => itemKey(i) === this.wantSel)) {
      if (items.some((r) => itemKey(r.item) === this.wantSel)) this.select(this.wantSel);
      this.wantSel = null;
    }
    if (!items.some((r) => itemKey(r.item) === this.sel)) this.sel = items[0] ? itemKey(items[0].item) : null;
    const focused = this.handle.is_focused() || this.typing;
    const now = Date.now();
    const live = agents();
    const width = this.width ?? 0;
    const wide = width >= WIDE;
    const filtered = isFiltered(this.f);

    const icon = (r, size) => {
      const type = typeOf(r.item, r.item.path ? this.fs[itemKey(r.item)] : null);
      const gone = r.item.path && this.fs[itemKey(r.item)] === "-";
      return svg(`${ICONS}/${ICON[type]}.svg`).size(size).flex_none().text_color(gone ? t.dim : r.read ? t.muted : t.foreground);
    };
    const dot = (r) => div().size(7).flex_none().rounded(4).when(!r.read, (el) => el.bg(t.accent));
    const chip = (text, color) => div().flex_none().px(5).h(15).rounded(4).bg(color + "26").text_size(10).font_semibold().text_color(color).flex().items_center().child(text);

    const itemRow = (r) => {
      const i = r.item;
      const on = itemKey(i) === this.sel;
      const k = itemKey(i);
      const gone = i.path && this.fs[k] === "-";
      if (rail) {
        return h_flex().h(RAIL_ROW).px(8).gap(4).items_center().justify_center()
          .when(on && focused, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .child(icon(r, 15))
          .child(dot(r));
      }
      const by = who(i, live);
      const offline = isOffline(this.remote, i);
      const copied = i.machine && this.fetched.has(k) ? fetchedLabel(i.machine, this.fetched.get(k), now) : null;
      const meta = [i.note, by.label, copied].filter(Boolean).join(" · ");
      const changed = !gone && i.path && isChanged(i, this.state, this.mt[k]);
      return h_flex().h(ROW).px(8).gap(9).rounded(8).items_center().cursor_pointer()
        .when(on, (el) => el.bg(focused ? t.selected : t.raised))
        .hover((s) => s.bg(t.hover))
        .child(icon(r, 16))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().flex_1().min_w(0).truncate().text_color(r.read ? t.muted : t.foreground).when(!r.read, (el) => el.font_medium()).child(i.title))
            .when(Boolean(changed), (el) => el.child(chip("changed", t.accent)))
            .when(Boolean(i.machine), (el) => el.child(chip(i.machine, t.muted)))
            .when(offline, (el) => el.child(chip("offline", t.blocked)))
            .when(i.adds > 1, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`×${i.adds}`)))
            .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(i.added_at, now))))
          .child(div().truncate().text_size(11).text_color(t.dim).child(gone ? `gone · ${meta}` : meta)))
        .child(dot(r));
    };
    const headRow = (r) => rail
      ? h_flex().h(RAIL_ROW).items_center().justify_center().child(div().w(20).h(1).bg(t.border))
      : h_flex().h(HEAD).px(8).pt(8).items_center().gap(6).text_size(11).font_medium().text_color(t.dim)
      .child(r.label).child(String(r.count));

    const sizes = rows.map((r) => (rail ? RAIL_ROW : r.type === "head" ? HEAD : ROW));
    const list = v_flex().id("rl-body").relative().flex_1().min_h(0)
      .child(v_virtual_list("rl-rows", rows.length, sizes,
        (index) => (rows[index].type === "head" ? `head-${rows[index].label}` : itemKey(rows[index].item)),
        (range) => rows.slice(range.start, range.end).map((r) => (r.type === "head" ? headRow(r) : itemRow(r))))
        .track_scroll(this.scroll)
        .size_full()
        .px(rail ? 0 : 8)
        .on_item_click((key, cx) => {
          const row = rows.find((r) => r.type === "item" && itemKey(r.item) === key);
          if (!row) return;
          // A click selects; a double-click opens. Moving through the list never opens.
          const now = Date.now();
          const double = (this.press?.count >= 2 && now - this.press.at < DOUBLE_MS) || (this.lastClick?.key === key && now - this.lastClick.at < DOUBLE_MS);
          this.lastClick = double ? null : { key, at: now };
          this.press = null;
          this.select(key);
          this.focus();
          if (double) this.openAndClose(row.item, cx);
          cx.notify();
        }))
      .child(Scrollbar.vertical("rl-rows").absolute().inset_0());

    const empty = () => {
      if (this.error) return `Can't read the reading list: ${this.error}`;
      if (!this.loaded) return "";
      if (filtered && this.pool().length) return "Nothing matches the filters.";
      if (this.view === "done") return "Nothing done yet. Press d on an item to put it here.";
      return 'Nothing to read. Agents add files with rl add <path> --note "why", or drop files here.';
    };

    const link = (id, text, on, click) => div().id(id).flex_none().text_size(11).text_color(on ? t.foreground : t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { click(); cx.notify(); })
      .child(text);
    const toggle = link("rl-view", this.view === "done" ? "Back to list" : n.done ? `Done ${n.done}` : "Done", this.view === "done",
      () => { this.view = this.view === "done" ? "list" : "done"; this.sel = null; });

    // A filter chip in a wide header: what is chosen (or "All ..."), opening its menu.
    const filterChip = (dim) => {
      const on = this.f[dim] !== null;
      const label = on ? (options(this.pool(), dim, { fs: this.fs, spaces: spaces(), agents: live, chosen: this.f[dim] }).find((o) => o.value === this.f[dim])?.label ?? labelFor(dim, this.f[dim], spaces())) : ALL[dim];
      return h_flex().id(`rl-f-${dim}`).flex_none().max_w(130).h(22).pl(8).pr(5).gap(3).rounded(6).items_center().cursor_pointer()
        .border(1).border_color(on ? t.accent + "66" : t.border).when(on, (el) => el.bg(t.accent + "1a"))
        .text_size(11).text_color(on ? t.foreground : t.dim)
        .hover((s) => s.text_color(t.foreground).bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => this.openMenu([dim]))
        .child(div().min_w(0).truncate().child(label))
        .child(svg(`${ICONS}/chevron-down.svg`).size(12).flex_none().text_color(t.dim));
    };
    const unreadChip = h_flex().id("rl-f-unread").flex_none().h(22).px(8).rounded(6).items_center().cursor_pointer()
      .border(1).border_color(this.f.unread ? t.accent + "66" : t.border).when(this.f.unread, (el) => el.bg(t.accent + "1a"))
      .text_size(11).text_color(this.f.unread ? t.foreground : t.dim)
      .hover((s) => s.text_color(t.foreground).bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { this.f = { ...this.f, unread: !this.f.unread }; cx.notify(); })
      .child("Unread");
    const menuDims = ["space", "agent", "type", ...(this.view === "list" ? ["unread", "sources", "actions"] : [])];
    const filterIcon = div().id("rl-filter").flex_none().cursor_pointer().text_color(filtered ? t.accent : t.dim)
      .hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => this.openMenu(menuDims))
      .tooltip("Filter by space, agent or type")
      .child(svg(`${ICONS}/list-filter.svg`).size(14));

    const countChip = div().px(5).h(16).rounded(5).bg(t.accent + "26").text_size(10.5).font_semibold().text_color(t.accent).flex().items_center().child(String(n.unread));
    const title = this.view === "done" ? "Reading list · done" : "Reading list";
    const header = rail
      ? v_flex().h(44).flex_none().items_center().justify_center().gap(2)
        .child(svg(`${ICONS}/bookmark.svg`).size(14).text_color(n.unread ? t.foreground : t.dim))
        .child(div().text_size(10.5).text_color(n.unread ? t.accent : t.dim).child(String(n.unread)))
      : h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between().gap(8)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().text_size(11.5).font_medium().text_color(t.dim).truncate().child(title))
          .when(this.view === "list" && n.unread > 0, (el) => el.child(countChip)))
        .child(h_flex().gap(wide ? 6 : 12).items_center().flex_none()
          .when(wide, (el) => el.child(filterChip("space")).child(filterChip("agent")).child(filterChip("type")).when(this.view === "list", (el) => el.child(unreadChip)))
          .when(!wide, (el) => el.child(filterIcon))
          .child(toggle));

    // In a narrow copy, the filters that are on, each with an x to clear it.
    const active = [
      ...["space", "agent", "type"].filter((d) => this.f[d] !== null).map((d) => ({ d, label: options(this.pool(), d, { fs: this.fs, spaces: spaces(), agents: live, chosen: this.f[d] }).find((o) => o.value === this.f[d])?.label ?? labelFor(d, this.f[d], spaces()) })),
      ...(this.f.unread && this.view === "list" ? [{ d: "unread", label: "Unread only" }] : []),
    ];
    const activeRow = h_flex().px(14).pb(6).flex_none().gap(5).flex_wrap()
      .children(active.map((a) => h_flex().id(`rl-on-${a.d}`).max_w(200).h(20).pl(7).pr(4).gap(3).rounded(6).items_center().cursor_pointer()
        .bg(t.accent + "1a").text_size(11).text_color(t.foreground)
        .hover((s) => s.bg(t.accent + "33"))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.f = { ...this.f, [a.d]: a.d === "unread" ? false : null }; cx.notify(); })
        .tooltip("Clear this filter")
        .child(div().min_w(0).truncate().child(a.label))
        .child(svg(`${ICONS}/x.svg`).size(11).flex_none().text_color(t.dim))));

    // While rl can't be used from a terminal here, or on another machine that answers: what
    // is wrong, and the Install button. This machine's comes first.
    const localBanner = !rail && this.rl ? rlBanner(this.rl, this.platform) : null;
    const banner = localBanner && this.rlDismissed() !== this.rl.state ? { ...localBanner, machine: null }
      : !rail ? remoteBanner(this.remote, this.remoteDismissed()) : null;
    const showBanner = Boolean(banner);
    const bannerRow = () => v_flex().id("rl-banner").mx(14).mb(8).px(10).py(9).gap(8).flex_none().rounded(8)
      .border(1).border_color(t.border).bg(t.raised).text_size(12)
      .child(div().text_color(t.foreground).child(banner.text))
      .child(h_flex().gap(12).items_center()
        .when(Boolean(banner.button), (el) => el.child(div().id("rl-install").flex_none().h(24).px(10).rounded(6).flex().items_center().cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).font_medium().hover((s) => s.opacity(0.9))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.installRl(cx, banner.machine); cx.notify(); })
          .tooltip(banner.machine ? `Copy this list's rl to ~/.local/bin on ${banner.machine}` : this.platform === "windows" ? "Copy this list's rl to ~\\.local\\bin and add that folder to your PATH" : "Copy this list's rl to ~/.local/bin")
          .child(this.installing === (banner.machine ?? "") ? "Installing…" : banner.machine ? `Install rl on ${banner.machine}` : "Install rl")))
        .child(link("rl-not-now", "Not now", false, () => (banner.machine ? this.dismissRemoteRl(banner.machine) : this.dismissRl()))));

    // The person's handler is turned on but not used (changed, moved, gone, refused): why,
    // with its path, and the buttons to confirm it as it is now or turn it off.
    const hb = !rail ? handlerBanner(this.hs, this.handlerPath()) : null;
    const handlerRow = () => v_flex().id("rl-handler-banner").mx(14).mb(8).px(10).py(9).gap(8).flex_none().rounded(8)
      .border(1).border_color(t.border).bg(t.raised).text_size(12)
      .child(div().text_color(t.foreground).child(hb.text))
      .child(h_flex().gap(12).items_center()
        .when(hb.confirm, (el) => el.child(div().id("rl-handler-use").flex_none().h(24).px(10).rounded(6).flex().items_center().cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).font_medium().hover((s) => s.opacity(0.9))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.setHandler(true, cx); cx.notify(); })
          .tooltip("Run your handler as it is now")
          .child("Use it")))
        .child(link("rl-handler-off", "Turn off", false, () => this.setHandler(false, cx))));

    // The `/` box.
    const findRow = h_flex().mx(14).mb(6).h(26).px(7).gap(6).flex_none().items_center().rounded(6)
      .border(1).border_color(this.typing ? t.accent : t.border).bg(t.background)
      .child(svg(`${ICONS}/search.svg`).size(12).flex_none().text_color(t.dim))
      .child(Input.new(this.input).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
      .child(div().id("rl-find-x").flex_none().cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.input.set_value(""); this.f = { ...this.f, text: "" }; this.finding = false; this.handle.focus(); cx.notify(); })
        .child(svg(`${ICONS}/x.svg`).size(12)));

    // The preview: beside the list in a wide pane, below it in a narrow one (after `p`).
    // The popup is compact: no preview until `p`, and then below the list.
    const side = wide && !popup;
    const selRow = items.find((r) => itemKey(r.item) === this.sel);
    const showPreview = !rail && Boolean(selRow) && previewShown(width, this.choice);
    const listW = Math.round(Math.max(300, Math.min(460, width * 0.42)));
    if (showPreview) this.wantPreview(selRow.item, side ? width - listW : width, cx);

    const keyHints = this.view === "done"
      ? (wide ? ["↵ open", "␣ look", "p preview", "v viewer", "o reveal", "c copy", "/ find", "f filter", "d not done", "tab list"] : ["↵ open", "␣ look", "v view", "/ find", "d not done"])
      : (wide ? ["↵ open", "␣ look", "p preview", "v viewer", "o reveal", "c copy", "/ find", "f filter", "r read", "d done", "tab done", ...(this.remote.size ? ["R refresh"] : [])] : ["↵ open", "␣ look", "v view", "/ find", "r read", "d done"]);
    const hints = h_flex().h(24).px(16).flex_none().items_center().gap(10).text_size(10.5).text_color(t.dim).overflow_hidden()
      .children(keyHints.map((s) => div().flex_none().child(s)))
      // Which actions run: said only when it is the person's own handler.
      .when(this.hs.state === "on", (el) => el.child(div().flex_1()).child(div().id("rl-handler-on").flex_none().text_color(t.accent)
        .tooltip(`Enter, Space, o and thumbnails ask ${this.hs.path} first`).child("your handler")));

    const filtersEmpty = rows.length === 0 && filtered && !rail && this.pool().length > 0;

    return this.sized(v_flex()
      .id("readlist")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      // In the sidebar it matches the agents list above it; in a pane, the pane's card;
      // in the popup, the popover.
      .when(sidebar, (el) => el.bg(t.chrome).border_t(1).border_color(t.border))
      .when(popup, (el) => el.bg(t.popover))
      .when(!sidebar && !popup, (el) => el.bg(t.background))
      .text_size(13))
      .on_mouse_down("left", (e) => {
        this.press = { count: e.click_count, at: Date.now() };
        if (!this.typing) this.focus();
      })
      .on_key_down((e, cx) => this.keys(e, cx))
      .on_drop((e, cx) => this.dropped(e.paths, cx))
      .child(header)
      .when(Boolean(hb), (el) => el.child(handlerRow()))
      .when(showBanner, (el) => el.child(bannerRow()))
      .when(!rail && !wide && active.length > 0, (el) => el.child(activeRow))
      .when(!rail && (this.finding || Boolean(this.f.text)), (el) => el.child(findRow))
      .when(rows.length === 0 && !rail, (el) => el.child(v_flex().px(16).gap(6).items_start().text_size(12).text_color(t.dim)
        .child(div().child(empty()))
        .when(filtersEmpty, (el) => el.child(link("rl-clear", "Clear filters", false, () => this.clearFilters())))))
      .when(showPreview && side, (el) => el.child(h_flex().flex_1().min_h(0)
        .child(v_flex().w(listW).flex_none().h_full().min_h(0).child(list))
        .child(this.previewPane(selRow.item, "side", t))))
      .when(!(showPreview && side), (el) => el.child(list))
      .when(showPreview && !side, (el) => el.child(this.previewPane(selRow.item, "below", t)))
      .when(focused && !rail && rows.length > 0, (el) => el.child(hints));
  }
}
