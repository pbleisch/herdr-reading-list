// Reading list: files and URLs agents and tools put up for the person to read (rl add).
// Watches $READING_LIST_DIR (default ~/.local/state/reading-list): items/<id>.json are
// the producers', state.json (read and done) is the person's, written only here, and
// anything put in inbox/ (or dropped on the list) is added with rl.
// Lives in the left sidebar under Agents (props {role: "sidebar"}), in a pane, or as the
// popup (mod.open:readlist, cmd-shift-i). Props {role: "viewer"} is the preview-only pane
// `v` opens; props {menu} is a filter menu one of the others opened.
// See docs/design.md in the herdr-reading-list repo.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, TextView, Editor, EditorState, InputState, Input } from "gpui-base";
import { exec, readTextFile, writeTextFile, watchFolder, nextCommand, agents, spaces, panes, focused, theme, settings, layout, props, notify, appHome, run, shared, setShared, openOverlay, closeOverlay } from "herdr";
import { LIST_SCRIPT, STAT_SCRIPT, STATS_SCRIPT, parseListing, parseStats, typeOf, openAction, itemFile } from "./core/items.js";
import { WIDE, STAT1_SCRIPT, HEAD_SCRIPT, LIST_DIR_SCRIPT, CACHE_SCRIPT, PRUNE_SCRIPT, parseStat, previewKind, previewShown, thumbSize, cacheName, previewText, stripThreads, parseFolder, copyText } from "./core/preview.js";
import { parseState, serializeState, applyAction, prune, rowsFor, counts, ago, who, isRead, isDone, isChanged, withInbox } from "./core/state.js";
import { NO_FILTER, applyFilters, filterRows, isFiltered, options, labelFor } from "./core/filters.js";
import { BURST_MS, arrivalKey, arrivals, claim, owners, quiet, quietIds, toastFor, toastAction } from "./core/arrival.js";
import { INBOX_SCRIPT, ADD_SCRIPT, parseInbox, inboxPlan } from "./core/inbox.js";
import { viewerPane, newPane, selectedId, takesCommand, splitTarget } from "./core/viewer.js";
import { NAME } from "./core/name.js";
import { RL_STATUS_SCRIPT, INSTALL_RL_SCRIPT, parseRlStatus, rlBanner, installToast } from "./core/install.js";

// This mod's folder under the app home (core/name.js).
const MOD = `mods/${NAME}`;
const ICONS = `${MOD}/icons`;
// The rl that ships with the mod: the drop folder runs it, and "Install rl" copies it to
// ~/.local/bin (core/install.js).
const RL = `${MOD}/bin/rl`;
// localStorage: the rl banner state the person dismissed with "Not now".
const RL_DISMISSED = "readlist.rl-dismissed";
const ICON = { md: "file-text", text: "file-text", code: "file-code", html: "app-window", image: "image", pdf: "book-open", folder: "folder", url: "link", file: "file" };
const ROW = 46, HEAD = 30, RAIL_ROW = 28;
const KEYS = {
  down: "down", j: "down", up: "up", k: "up", home: "top", g: "top", end: "bottom", "shift-g": "bottom",
  enter: "open", space: "preview", r: "read", d: "done", u: "undo", "shift-d": "delete", tab: "view",
  p: "pane", o: "reveal", c: "copy", "/": "find", f: "filter", v: "viewer",
};
// The preview's height when it shows below the list (a narrow pane, after `p`): half the
// pane, at most BELOW.
const BELOW = 260;
// Cached images and thumbnails: hidden, so writing them does not reload the mod (row 17).
const CACHE = `${MOD}/.cache/local`;

// Shared values (docs/design.md 4.4): the arrival claims, ids not to toast (dropped by the
// person), the unread count, the item selected last, the viewer pane, and a filter menu's pick.
const TOASTED = "readlist.toasted", QUIET = "readlist.quiet", UNREAD = "readlist.unread";
const SELECTED = "readlist.selected", VIEWER = "readlist.viewer", PICK = "readlist.pick";
const KEYBOARD = "readlist.keyboard";

// Quick Look in the background, so the panel outlives exec's 30 s limit; prints its pid.
const PREVIEW_SCRIPT = 'qlmanage -p "$1" >/dev/null 2>&1 </dev/null & echo $!';
// Closes the panel this mod opened: kills that pid only while it is still qlmanage.
const CLOSE_SCRIPT = 'case "$(ps -o comm= -p "$1" 2>/dev/null)" in *qlmanage) kill "$1";; *) exit 1;; esac';
const DOUBLE_MS = 500;

const DIR_SCRIPT = 'd=${READING_LIST_DIR:-$HOME/.local/state/reading-list}; mkdir -p "$d/items" "$d/inbox" && cd "$d" && pwd -P';

const MENU_TITLE = { space: "Space", agent: "Agent", type: "Type", unread: "Show" };
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
    this.items = [];
    this.fs = {};
    this.mt = {};
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
    this.scroll = VirtualListScrollHandle.new();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", DIR_SCRIPT]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "cannot create the reading-list folder");
        this.dir = r.stdout.trim();
      } catch (e) {
        this.error = String(e?.message ?? e);
        cx.notify();
        return;
      }
      await this.reload(cx);
      this.watch(cx);
    });
    this.checkRl(cx);
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
      // rl may have been installed (or removed) from a terminal.
      this.checkRl(cx);
    });
  }

  role() {
    return props()?.role ?? null;
  }

  // Whether rl is installed and on PATH here, for the banner (core/install.js).
  checkRl(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", RL_STATUS_SCRIPT]).catch(() => null);
      const status = parseRlStatus(r?.stdout);
      if (status.state === this.rl?.state && status.path === this.rl?.path) return;
      this.rl = status;
      cx.notify();
    });
  }

  // "Install rl" (the banner's button, readlist.install-rl): copies the mod's rl to
  // ~/.local/bin, never over another program, and says how it went.
  installRl(cx) {
    if (this.installing) return;
    this.installing = true;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", INSTALL_RL_SCRIPT, "readlist", `${appHome()}/${RL}`]).catch((e) => ({ stdout: "", stderr: String(e) }));
      this.installing = false;
      notify({ title: "Reading list", ...installToast(r.stdout || r.stderr) });
      this.checkRl(cx);
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

  // The cmd-shift-i popup (an overlay that is not a filter menu).
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
          exec("sh", ["-c", LIST_SCRIPT, "readlist", `${this.dir}/items`]),
          readTextFile(`${this.dir}/state.json`),
        ]);
        const items = parseListing(list.stdout);
        const paths = items.filter((i) => i.path).map((i) => i.path);
        let st = { fs: {}, mt: {} };
        if (paths.length) st = parseStats((await exec("sh", ["-c", STATS_SCRIPT, "readlist", ...paths])).stdout, paths);
        const ids = items.map((i) => i.id).sort().join(" ");
        if (ids !== this.ids) {
          this.ids = ids;
          exec("sh", ["-c", PRUNE_SCRIPT, "readlist", `${appHome()}/${CACHE}`, ...items.map((i) => i.id)]).catch(() => {});
        }
        this.items = items;
        this.fs = st.fs;
        this.mt = st.mt;
        this.gen++;
        this.state = parseState(stateText);
        this.error = null;
        this.loaded = true;
        this.arrived(items, cx);
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

  // The unread count, for a badge elsewhere (docs/design.md 4.4). Every copy computes the
  // same number, so only a change is written.
  publish() {
    const n = counts(this.items, this.state).unread;
    if (shared(UNREAD) !== n) setShared(UNREAD, n);
  }

  // New and re-added items since this copy's last listing: claim them, and toast what this
  // copy still holds when the burst ends (core/arrival.js).
  arrived(items, cx) {
    const seen = this.seen;
    this.seen = new Set(items.map(arrivalKey));
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
    const items = mine.map((k) => listed.get(k)).filter((i) => i && !hush.has(i.id) && !isRead(i, this.state) && !isDone(i, this.state));
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
        const r = await exec("sh", ["-c", INBOX_SCRIPT, "readlist", `${this.dir}/inbox`]);
        const entries = parseInbox(r.stdout);
        const path = `${this.dir}/state.json`;
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
        if (todo.length) await this.add(todo.map((e) => `${this.dir}/inbox/${e.name}`), "inbox");
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
    const r = await exec("sh", ["-c", ADD_SCRIPT, "readlist", `${appHome()}/${RL}`, from, ...paths]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    if (r.code !== 0) notify({ title: "Reading list", body: `Couldn't add to the list: ${r.stderr.trim()}`, level: "error" });
    return r.stdout.split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{16}$/.test(l));
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

  // Applies an action to state.json with compare-and-swap, retrying on a stale read.
  // Resolves once it is saved (or given up), so the popup can close after it.
  mark(id, action, cx, mtime) {
    this.state = applyAction(this.state, id, action, nowIso(), mtime);
    cx.notify();
    const path = `${this.dir}/state.json`;
    return new Promise((resolve) => cx.spawn(async (cx) => {
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const text = await readTextFile(path);
          const next = prune(applyAction(parseState(text), id, action, nowIso(), mtime), this.items.map((i) => i.id), Date.now());
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

  // Enter: opens the item and marks it read; true when it opened.
  async open(item, cx) {
    let kind = null, mtime = null;
    if (item.path) {
      const r = await exec("sh", ["-c", STATS_SCRIPT, "readlist", item.path]).catch(() => null);
      const st = parseStats(r?.stdout ?? "", [item.path]);
      kind = st.fs[item.path];
      mtime = st.mt[item.path];
    }
    const act = openAction(item, kind);
    if (act.how === "missing") {
      notify({ title: "Reading list", body: `${item.title} is gone: ${item.path}`, level: "warning" });
      return false;
    }
    if (act.how === "url") cx.open_url(act.target);
    else {
      const r = await exec("open", act.how === "reveal" ? ["-R", act.target] : [act.target]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) {
        notify({ title: "Reading list", body: `Couldn't open ${item.title}: ${r.stderr.trim()}`, level: "error" });
        return false;
      }
      if (act.how === "reveal") notify({ title: "Reading list", body: `${item.title} could run, so it's shown in Finder instead of opened.`, level: "info" });
    }
    await this.mark(item.id, "read", cx, mtime);
    return true;
  }

  // Opens an item; the popup then closes (Enter opens and closes it, docs/design.md 4.1).
  openAndClose(item, cx) {
    cx.spawn(async (cx) => {
      if ((await this.open(item, cx)) && this.popup()) closeOverlay(props().overlay);
    });
  }

  // Space: the macOS Quick Look panel, a toggle like Finder's. Never marks read and never
  // runs anything (Quick Look only draws a preview).
  async preview(item) {
    const open = this.quicklook;
    this.quicklook = null;
    if (open) {
      const r = await exec("sh", ["-c", CLOSE_SCRIPT, "readlist", open.pid]).catch(() => null);
      if (r?.code === 0 && open.id === item.id) return;
    }
    if (!item.path) {
      notify({ title: "Reading list", body: "Quick Look has no preview for a link; Enter opens it.", level: "info" });
      return;
    }
    const st = await exec("sh", ["-c", STAT_SCRIPT, "readlist", item.path]).catch(() => null);
    if (st?.stdout.trim() !== "d" && st?.stdout.trim() !== "f" && st?.stdout.trim() !== "x") {
      notify({ title: "Reading list", body: `${item.title} is gone: ${item.path}`, level: "warning" });
      return;
    }
    const r = await exec("sh", ["-c", PREVIEW_SCRIPT, "readlist", item.path]).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    const pid = r.stdout.trim();
    if (r.code !== 0 || !/^\d+$/.test(pid)) {
      notify({ title: "Reading list", body: `Couldn't preview ${item.title}: ${r.stderr.trim()}`, level: "error" });
      return;
    }
    this.quicklook = { id: item.id, pid };
  }

  // The in-pane preview of `item`, at most one being made at a time; the latest selection
  // wins, and what the pane showed stays until the new one is ready.
  wantPreview(item, width, cx) {
    const size = thumbSize(width);
    const key = `${item.id}|${item.added_at}|${size}|${this.gen}`;
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
            pv = await this.loadPreview(item, size);
          } catch (e) {
            pv = { id: item.id, how: "error", error: String(e?.message ?? e) };
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

  async loadPreview(item, size) {
    const base = { id: item.id };
    if (item.url) return { ...base, how: "url" };
    const st = parseStat((await exec("sh", ["-c", STAT1_SCRIPT, "readlist", item.path])).stdout);
    let kind = previewKind(item, st.kind);
    const run = async (script, ...args) => {
      const r = await exec("sh", ["-c", script, "readlist", ...args], { timeout: 60000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      return r.stdout;
    };
    if (kind.how === "missing" || kind.how === "url") return { ...base, how: kind.how };
    if (kind.how === "folder") return { ...base, how: "folder", folder: parseFolder(await run(LIST_DIR_SCRIPT, item.path)) };
    if (kind.how === "markdown" || kind.how === "text") {
      const text = previewText(await run(HEAD_SCRIPT, item.path), st.size);
      if (text === null) kind = { how: "thumb" };
      else if (kind.how === "markdown") return { ...base, how: "markdown", text: stripThreads(text) };
      else {
        const t = theme();
        return { ...base, how: "text", code: EditorState.new({ language: kind.lang, readonly: true, value: text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } }) };
      }
    }
    const name = cacheName(item.id, st, kind, size);
    const dir = `${appHome()}/${CACHE}`;
    await run(CACHE_SCRIPT, item.path, dir, `${dir}/${name}`, item.id, kind.how === "image" ? "copy" : String(size));
    return { ...base, how: "image", src: `${CACHE}/${name}`, thumb: kind.how === "thumb" };
  }

  // o: show the item in Finder. Revealing never opens or runs anything.
  async reveal(item) {
    if (!item.path) {
      notify({ title: "Reading list", body: "A link has no file to show in Finder; Enter opens it.", level: "info" });
      return;
    }
    const r = await exec("open", ["-R", item.path]).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r.code !== 0) notify({ title: "Reading list", body: `Couldn't show ${item.title} in Finder: ${r.stderr.trim()}`, level: "error" });
  }

  // Shift-D: take the item off the list, as `rl rm` does (removes its file).
  remove(item, cx) {
    this.items = this.items.filter((i) => i.id !== item.id);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("rm", ["-f", "--", itemFile(this.dir, item.id)]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) {
        notify({ title: "Reading list", body: `Couldn't remove ${item.title}: ${r.stderr.trim()}`, level: "error" });
        await this.reload(cx);
      }
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
    if (cur) setShared(SELECTED, { id: cur.item.id, at: Date.now() });
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
      : { dim, title: MENU_TITLE[dim], value: this.f[dim], options: [{ value: null, label: ALL[dim] }, ...options(pool, dim, { ...ctx, chosen: this.f[dim] })] });
    const rows = sections.reduce((n, s) => n + s.options.length, 0);
    const height = Math.min(440, 12 + sections.length * MENU_HEAD + rows * MENU_ROW);
    openOverlay({ mod: NAME, kind: "popup", width: 250, height, props: { menu: sections, target: this.copy } });
  }

  // A pick from a filter menu this copy opened.
  takePick() {
    const pk = shared(PICK);
    if (!pk || pk.target !== this.copy || pk.n === this.pickN) return;
    this.pickN = pk.n;
    if (pk.dim in this.f) this.f = { ...this.f, [pk.dim]: pk.dim === "unread" ? Boolean(pk.value) : pk.value ?? null };
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
    const at = Math.max(0, items.findIndex((r) => r.item.id === this.sel));
    const cur = items[at];
    const move = (n) => {
      const next = items[Math.max(0, Math.min(items.length - 1, n))];
      if (!next) return;
      this.select(next.item.id);
      this.scroll.scroll_to_item(rows.indexOf(next));
    };
    const after = () => (items[at + 1] ?? items[at - 1])?.item.id ?? null;
    switch (name) {
      case "down": move(at + 1); break;
      case "up": move(at - 1); break;
      case "top": move(0); break;
      case "bottom": move(items.length - 1); break;
      case "open": if (cur) this.openAndClose(cur.item, cx); break;
      case "preview": if (cur) cx.spawn(async () => this.preview(cur.item)); break;
      case "read":
        if (cur) this.mark(cur.item.id, cur.read && this.view === "list" ? "unread" : "read", cx, cur.item.path ? this.mt[cur.item.path] : null);
        break;
      case "undo":
      case "done":
        if (name === "undo" && this.view !== "done") return false;
        if (cur) {
          this.mark(cur.item.id, this.view === "done" ? "undone" : "done", cx);
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
      case "reveal": if (cur) cx.spawn(async () => this.reveal(cur.item)); break;
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
        this.openMenu(["space", "agent", "type", ...(this.view === "list" ? ["unread"] : [])]);
        break;
      case "viewer": this.toggleViewer(cur, cx); break;
      case "focus": this.focus(); break;
      case "install-rl": this.installRl(cx); break;
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

  previewBody(item, t) {
    const message = (text) => div().p(14).text_size(12).text_color(t.dim).child(text);
    const pv = this.pv?.id === item.id ? this.pv : null;
    if (!pv) return message("Loading preview…");
    switch (pv.how) {
      case "url":
        return v_flex().p(14).gap(8).text_size(12)
          .child(div().id(`rl-url-${item.id}`).text_color(t.accent).cursor_pointer().hover((s) => s.underline())
            .on_click((_e, cx) => cx.open_url(item.url)).child(item.url))
          .child(div().text_color(t.dim).child("A link: Enter opens it in the browser."));
      case "missing":
        return v_flex().p(14).gap(8).items_start()
          .child(div().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("gone"))
          .child(div().text_size(12).text_color(t.dim).child("Nothing is at this path any more. d marks it done; Shift-D takes it off the list."));
      case "markdown":
        return div().flex_1().min_h(0).px(14).py(8).child(TextView.markdown(`rl-md-${item.id}`, pv.text).scrollable(true).selectable(true).size_full()
          .on_link_click((url, cx) => { if (/^https?:\/\//i.test(url)) cx.open_url(url); }));
      case "text":
        return Editor.new(pv.code).flex_1().min_h(0);
      case "image":
        return div().flex_1().min_h(0).p(12).child(image(pv.src).size_full());
      case "folder":
        return v_flex().id(`rl-folder-${item.id}`).flex_1().min_h(0).overflow_y_scrollbar().px(10).py(6)
          .children(pv.folder.entries.map((e) => h_flex().h(22).px(4).gap(7).items_center().flex_none()
            .child(svg(`${ICONS}/${e.dir ? "folder" : "file"}.svg`).size(13).flex_none().text_color(t.muted))
            .child(div().flex_1().min_w(0).truncate().text_size(12).child(e.name))))
          .when(pv.folder.entries.length === 0, (el) => el.child(message("An empty folder.")))
          .when(pv.folder.more, (el) => el.child(div().p(4).text_size(11).text_color(t.dim).child(`First ${pv.folder.entries.length} entries; Enter opens the folder in Finder.`)));
      default:
        return message(`Can't preview this: ${pv.error}`);
    }
  }

  // `how`: "side" (right of the list), "below" (under it) or "full" (the viewer pane).
  previewPane(item, how, t) {
    const roomy = how !== "below";
    return v_flex().id("rl-preview").min_w(0).min_h(0).bg(t.background)
      .when(how === "side", (el) => el.flex_1().h_full().border_l(1).border_color(t.border))
      .when(how === "full", (el) => el.flex_1().size_full())
      .when(how === "below", (el) => el.h(Math.round(Math.min(BELOW, (this.height ?? 2 * BELOW) / 2))).flex_none().border_t(1).border_color(t.border))
      .child(v_flex().px(14).pt(roomy ? 10 : 8).pb(roomy ? 8 : 6).gap(2).flex_none().border_b(1).border_color(t.border)
        .child(div().truncate().font_medium().child(item.title))
        // Below the list, the row above already shows the note: keep the header short.
        .when(roomy, (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(item.path ?? item.url)))
        .when(roomy && Boolean(item.note), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(item.note))))
      .child(this.previewBody(item, t));
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
    const id = selectedId(shared(SELECTED));
    const item = this.items.find((i) => i.id === id);
    if (item) this.wantPreview(item, this.width ?? 0, cx);
    return this.sized(v_flex().id("readlist-viewer").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_size(13))
      .on_key_down((e, cx) => { if (this.act(KEYS[e.keystroke], cx)) cx.stop_propagation(); })
      .child(item ? this.previewPane(item, "full", t)
        : div().p(16).text_size(12).text_color(t.dim).child(this.loaded
          ? "Select an item in the reading list to show it here. v closes this pane."
          : ""));
  }

  render(cx) {
    if (props()?.menu) return this.renderMenu(cx);
    if (this.role() === "viewer") return this.renderViewer(cx);
    this.takePick();
    const t = theme();
    const rail = this.rail();
    const sidebar = this.role() === "sidebar";
    const popup = this.popup();
    const rows = this.rows();
    const n = counts(this.items, this.state);
    const items = rows.filter((r) => r.type === "item");
    if (this.wantSel && this.items.some((i) => i.id === this.wantSel)) {
      if (items.some((r) => r.item.id === this.wantSel)) this.select(this.wantSel);
      this.wantSel = null;
    }
    if (!items.some((r) => r.item.id === this.sel)) this.sel = items[0]?.item.id ?? null;
    const focused = this.handle.is_focused() || this.typing;
    const now = Date.now();
    const live = agents();
    const width = this.width ?? 0;
    const wide = width >= WIDE;
    const filtered = isFiltered(this.f);

    const icon = (r, size) => {
      const type = typeOf(r.item, r.item.path ? this.fs[r.item.path] : null);
      const gone = r.item.path && this.fs[r.item.path] === "-";
      return svg(`${ICONS}/${ICON[type]}.svg`).size(size).flex_none().text_color(gone ? t.dim : r.read ? t.muted : t.foreground);
    };
    const dot = (r) => div().size(7).flex_none().rounded(4).when(!r.read, (el) => el.bg(t.accent));
    const chip = (text, color) => div().flex_none().px(5).h(15).rounded(4).bg(color + "26").text_size(10).font_semibold().text_color(color).flex().items_center().child(text);

    const itemRow = (r) => {
      const i = r.item;
      const on = i.id === this.sel;
      const gone = i.path && this.fs[i.path] === "-";
      if (rail) {
        return h_flex().h(RAIL_ROW).px(8).gap(4).items_center().justify_center()
          .when(on && focused, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .child(icon(r, 15))
          .child(dot(r));
      }
      const by = who(i, live);
      const meta = [i.note, by.label].filter(Boolean).join(" · ");
      const changed = !gone && i.path && isChanged(i, this.state, this.mt[i.path]);
      return h_flex().h(ROW).px(8).gap(9).rounded(8).items_center().cursor_pointer()
        .when(on, (el) => el.bg(focused ? t.selected : t.raised))
        .hover((s) => s.bg(t.hover))
        .child(icon(r, 16))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(h_flex().gap(6).items_center().min_w(0)
            .child(div().flex_1().min_w(0).truncate().text_color(r.read ? t.muted : t.foreground).when(!r.read, (el) => el.font_medium()).child(i.title))
            .when(Boolean(changed), (el) => el.child(chip("changed", t.accent)))
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
        (index) => (rows[index].type === "head" ? `head-${rows[index].label}` : rows[index].item.id),
        (range) => rows.slice(range.start, range.end).map((r) => (r.type === "head" ? headRow(r) : itemRow(r))))
        .track_scroll(this.scroll)
        .size_full()
        .px(rail ? 0 : 8)
        .on_item_click((key, cx) => {
          const row = rows.find((r) => r.type === "item" && r.item.id === key);
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
    const menuDims = ["space", "agent", "type", ...(this.view === "list" ? ["unread"] : [])];
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

    // While rl can't be used from a terminal here: what is wrong, and the Install button.
    const banner = !rail && this.rl ? rlBanner(this.rl) : null;
    const showBanner = Boolean(banner) && this.rlDismissed() !== this.rl.state;
    const bannerRow = () => v_flex().id("rl-banner").mx(14).mb(8).px(10).py(9).gap(8).flex_none().rounded(8)
      .border(1).border_color(t.border).bg(t.raised).text_size(12)
      .child(div().text_color(t.foreground).child(banner.text))
      .child(h_flex().gap(12).items_center()
        .when(Boolean(banner.button), (el) => el.child(div().id("rl-install").flex_none().h(24).px(10).rounded(6).flex().items_center().cursor_pointer()
          .bg(t.solid).text_color(t.solid_foreground).font_medium().hover((s) => s.opacity(0.9))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.installRl(cx); cx.notify(); })
          .tooltip("Copy this list's rl to ~/.local/bin")
          .child(this.installing ? "Installing…" : "Install rl")))
        .child(link("rl-not-now", "Not now", false, () => this.dismissRl())));

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
    const selRow = items.find((r) => r.item.id === this.sel);
    const showPreview = !rail && Boolean(selRow) && previewShown(width, this.choice);
    const listW = Math.round(Math.max(300, Math.min(460, width * 0.42)));
    if (showPreview) this.wantPreview(selRow.item, side ? width - listW : width, cx);

    const keyHints = this.view === "done"
      ? (wide ? ["↵ open", "␣ look", "p preview", "v viewer", "o reveal", "c copy", "/ find", "f filter", "d not done", "tab list"] : ["↵ open", "␣ look", "v view", "/ find", "d not done"])
      : (wide ? ["↵ open", "␣ look", "p preview", "v viewer", "o reveal", "c copy", "/ find", "f filter", "r read", "d done", "tab done"] : ["↵ open", "␣ look", "v view", "/ find", "r read", "d done"]);
    const hints = h_flex().h(24).px(16).flex_none().items_center().gap(10).text_size(10.5).text_color(t.dim).overflow_hidden()
      .children(keyHints.map((s) => div().flex_none().child(s)));

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
