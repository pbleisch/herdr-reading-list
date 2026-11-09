# herdr-reading-list design

Written before the build (2026-11-08, herdr-app 0.1.13, hc 0.1.18) and kept up to date with it, with the open calls in section 9 settled. "Row 12" and the like refer to the API facts table in the appendix; A.1 to A.3 refer to the research done first (the existing mods read, the search for prior art, and the Quick Look thumbnail spike), which is not part of this repo.

## 1. Goals and non-goals

Goals:

- Any agent, script or tool can put a file (or a URL) on the person's reading list with one command,
  with a note saying why, and the list records who added it.
- The person sees new items arrive (count, toast), walks the list with the keyboard, previews an item
  in place, and opens it in its macOS app with Enter.
- Read, unread and done state per item; filter by space, by agent, by type, or unread only.
- Works for files on other machines (remote spaces), fetching a local copy before opening.
- Hands a markdown or HTML item to a document-review mod for commenting, bound to the agent that
  added it (later; section 5).

Non-goals:

- Commenting, annotations or editing (the review mod's job).
- A full HTML renderer in this mod (Quick Look thumbnail in the pane; the review mod or the browser for
  full fidelity).
- Syncing read state between people or machines; the list is one person's.
- Replacing Herdr's own "agent finished" toasts.
- Changing shipped layouts or mods (no badge in the tab bar or status bar; see 4.4).

## 2. Shape

```
 agent / tool / orchestrator               reading-list mod (Herdr.app, this Mac)
 ------------------------                   --------------------------------------
 rl add docs/plan.md --note "..."           watchFolder(~/.local/state/reading-list/items)
   -> hc get $HC_TERMINAL_ID (who, space)     -> read new item files, toast, count
   -> write items/<id>.json (tmp + mv)       list + preview + open + done
                                             state.json (read/done), CAS writes
 on a remote machine (server): same command,   poll: hc exec --on server cat items/*.json
 same folder in that machine's home          fetch a copy into the cache before opening
```

Two pieces, one folder format:

- **`rl`**, a POSIX `sh` script (no node or python needed, so it runs on any remote Linux box too).
- **The mod**, which never writes the producer's files; it keeps the person's state in its own file.

## 3. Producer interface

### 3.1 Command

```text
rl add <path|url> [--note TEXT] [--title TEXT] [--from NAME] [--kind review|fyi|result]
rl ls [--unread | --done | --all] [--json]   what is on the list here (default: not done)
rl done <path|url|id>                mark done (for a tool that knows the person handled it)
rl rm <path|url|id>                  take it off the list (the producer withdrawing it)
```

- `<path>` is resolved to an absolute real path (`cd "$(dirname)" && pwd -P`), must exist, and may be
  a file or a folder (a folder opens in Finder). A `http(s)://` URL is stored as is.
- Prints the item id and exits 0; prints a reason and exits 1 for a missing file. It never needs
  the app, so it works when Herdr is closed, from cron, or over ssh.
- `--show` (later; not in increment 1) additionally opens the reading-list pane beside the caller
  (`herdr-app do pane.split '{"direction":"right","pane":...,"mod":"readlist"}'`), the way herdr-md's
  `mdh open` does (A.1); without it the item arrives quietly with a toast.
- `--kind` is a hint for the pane (icon and sort); `review` is the default for agents.
- `rl` reads JSON (an existing item, `hc get`, `state.json`) with a small awk flattener, so it needs
  nothing beyond POSIX `sh`, `awk`, `sed` and `shasum`/`sha256sum`. Tested under macOS `sh` and dash.

Getting `rl`: it ships inside the mod as `mods/readlist/bin/rl`. While `rl` is not on PATH, the
list shows a banner with an Install rl button (also `herdr-app do readlist.install-rl`) that copies
it to `~/.local/bin/rl`. It never replaces another program called `rl` or a link, updates an older
copy of this one, and says when `~/.local/bin` is not on PATH or another `rl` comes first
(`mods/readlist/core/install.js`).

Zero-install fallback, for an agent on a machine without `rl`: write the same JSON file (3.2) into
the items folder with any file tool, using a temp name and a rename. `skill/reading-list/SKILL.md`
spells it out for agents.

### 3.2 File format and location

One folder per machine (section 9, call 2):

```text
~/.local/state/reading-list/            ($READING_LIST_DIR overrides)
  items/<id>.json                        one per item, written by producers only
  inbox/                                 drop folder: anything put here becomes an item
  state.json                             the person's read/done state, written by the mod only
                                         (this Mac only)
```

An item file:

```json
{
  "v": 1,
  "id": "3f2a9c1e5b7d4a60",
  "path": "/Users/you/proj/x/docs/plan.md",
  "url": null,
  "title": "plan.md",
  "note": "Revised rollout plan; section 3 changed after your comments.",
  "kind": "review",
  "added_at": "2026-11-08T18:42:11Z",
  "adds": 2,
  "by": {
    "terminal": "t7",
    "app": "claude-code",
    "name": "fix-login",
    "space": "sp2e53...",
    "tab": "tb91...",
    "cwd": "/Users/you/proj/x",
    "from": null
  },
  "size": 18234,
  "mtime": "2026-11-08T18:42:05Z",
  "done_at": null
}
```

- Writes are atomic: the script writes `items/.<id>.<pid>.tmp` and `mv`s it over `items/<id>.json`.
  The mod ignores dotfiles. No file is ever appended to, so there are no torn lines, no 1 MiB log to
  compact, and no lock.
- `title` defaults to the file name, or the first `# ` heading for markdown.
- `size` and `mtime` let the pane notice the file changed after the person read it.
- `done_at` is set by `rl done` (the producer's "the person has handled this"); `add` writes `null`,
  so a re-add brings a done item back. The person's own done marks live in `state.json` (4.3).
- The mod ignores files it cannot read as a v1 item (bad JSON, a relative path, a URL that is not
  `http(s)`), so a broken producer cannot break the list.

### 3.3 Who added it

`rl` fills `by` from the environment, never from arguments it cannot check:

- Inside an hc terminal (`$HC_TERMINAL_ID` set, row 11): `hc get "$HC_TERMINAL_ID" --json` gives
  the terminal's `name`, `cwd`, its `herdr.space` / `herdr.tab` labels and `status.app` (row 12).
- Outside hc (cron, a git hook, a CI script): `terminal` is null and `from` is `--from NAME`, else
  `$USER@$(basename "$PPID"'s command)`.
- The pane resolves `by.terminal` against live `agents()` (row 10) to show the agent's program icon,
  live status and space name; if that terminal has ended, it shows the snapshot from the file with
  "(ended)".
- A remote item's terminal is local to that machine; the pane shows it as `server/t7`, the address form
  Herdr uses for remote terminals (AGENTS.md:158-160).

### 3.4 De-duplication

- `id` = first 16 hex characters of `sha256(real path)` (or of the URL), computed by `rl` with
  `shasum -a 256` (macOS) or `sha256sum` (Linux). The mod engine has no hashing (row 30), which is
  why the producer owns ids. Ids are per machine, so the mod keys items as `(machine, id)`.
- Adding the same path again replaces the item file: new note, new `added_at`, `adds` + 1, `by`
  becomes the latest adder. The pane shows it as unread again and moves it to the top (re-adding is
  how an agent says "look again").
- Two agents adding the same file at once: last rename wins; both runs exit 0. Nothing is lost that
  matters (the note of the earlier one is replaced; the toast shows the later adder).

### 3.5 The drop folder

Any file, folder or symlink that appears in `inbox/` becomes an item: the mod (local) runs `rl add`
on it with `from: "inbox"`. Files stay where they are; the item points at them. Useful for tools that
can only write files (a screenshot tool, a browser download) and for the person dragging things in
from Finder. Dropping a file onto the pane itself (`on_drop`, row 20) does the same without the
folder, with `from: "dropped"` and no toast (the person put it there; `shared("readlist.quiet")`).

- Hidden names and browsers' partial downloads (`.crdownload`, `.part`, `.download`, ...) are
  skipped, and an entry newer than a second waits until it settles.
- `state.json`'s `inbox` records each entry's name and mtime when it is added. An entry is added
  once, and again only when it is replaced (a new mtime); an item deleted with Shift-D does not come
  back while its file stays in the folder. Copies of the mod agree through that file's
  compare-and-swap: only the copy whose write recorded an entry runs `rl` for it.
- The mod runs its own copy of `rl` (`mods/readlist/bin/rl`, with `sh`, so a copy that lost its
  execute bit still works), with `HC_TERMINAL_ID` unset; the drop folder works before `rl` is
  installed.

### 3.6 Multiple spaces and machines

- **Spaces:** one list per machine, not per space. Each item carries its space id, so the pane
  filters by space instead of keeping separate lists (an agent's output often matters outside the
  space it ran in).
- **Machines:** each machine has its own folder in its own home. The local folder is watched; each
  connected machine in `machines()` (row 9) whose layout is `ready` is polled (4.6).

## 4. The pane

### 4.1 How it shows

- **Home: the left sidebar, under Agents.** A `readlist` block below the `agents` block in the
  sidebar's list column. Shipped layouts are read-only, so the install clones the active layout
  (`layout.clone`), adds the block to the clone with `layout/add-to-sidebar.mjs`, and switches to
  it. The block is drawn for the sidebar's width (about 268 px) and, like the shipped sidebar mods,
  as a compact rail when the sidebar is narrower than 160 px (an icon per item and an unread dot).
- **A mod pane** (`pane.split {direction: "right", mod: "readlist"}`, row 2) also works, as a
  pane beside an agent or as its own tab, with the same list. Saved with its tab.
- **A popup** for a quick look from anywhere: `mod.open:readlist` on `cmd-shift-i` (`ctrl-shift-i`
  on Linux and Windows, free in Herdr's shipped keys there; increment 3,
  the repo's `keys.json`, merged by the install only where the key is free). The popup is the same
  mod drawn in a compact layout (no side preview; `p` shows it below the list); it takes the
  keyboard when it opens, and Enter opens the item, saves the read mark, then closes the popup.
- **The viewer**: `v` in any copy opens a preview-only pane (props `{role: "viewer"}`) by splitting
  the current tab's last pane to the right, or closes it if it is open. It shows the item selected
  last in any copy (`shared("readlist.selected")`), with the same renderer as the in-pane preview,
  never opens an app and never marks read. `shared("readlist.viewer")` keeps its pane id, checked
  against `panes()`, so a viewer closed by hand is noticed.
- Several copies can be alive (the sidebar block, a pane, the popup). They share `state.json`, so
  they agree; only one toasts (4.4).

### 4.2 Layout

In the sidebar (increment 1): a header row ("Reading list", the unread count as an accent chip,
"Done" on the right, all styled like the Agents header above it), then one 46 px row per item:
type icon, title (medium weight while unread), relative time and a `x2` chip on the first line;
note and who added it on the second; an accent dot while unread. Read items follow under a "Read"
header. While the list holds the keyboard a hint line shows the keys. Under 160 px it becomes a
rail: a bookmark icon with the unread count, then one icon per item with its unread dot.

Wide pane (increment 2: list on the left, preview on the right; the filters are increment 3):

```text
+- Reading list  4 unread / 9 ------------- [All spaces v] [All agents v] [Unread] [Done] -+
| > * [md]  plan.md                         claude t7 * idle  - x   2m |  # Rollout plan    |
|           Revised rollout plan; section 3 changed after...           |                    |
|   * [img] login-before-after.png          codex t12           x  14m |  ## 1. Scope       |
|           Screenshot of the fixed login form                         |  We ship the new   |
|   * [htm] coverage/index.html             server/t3 (ended)      server  1h |  login behind a    |
|           Coverage after the refactor                                |  flag first...     |
|   * [pdf] invoice-2026-10.pdf             inbox                    1h |                    |
|     [md]  notes/standup.md                standup-bot              3h |  ## 2. Rollout     |
|           Yesterday's summary                                        |  ...               |
|  ---- read ----                                                      |                    |
|     [url] github.com/x/y/pull/42          claude t7               1d |  [Open] [Review]   |
+-----------------------------------------------------------------------+--------------------+
| Enter open . Space Quick Look . r read . d done . R review . o reveal . / filter |
+-------------------------------------------------------------------------------------------+
```

Narrow pane (under 520 px, from `on_size_change`, which includes the sidebar): the preview is
hidden until `p`, then shows below the list at half the pane's height (at most 260 px) with a
one-line header, since the row above already shows the note. `p` in a wide pane hides it. The
preview follows the selection, never marks an item read and never opens an app; a copy remembers
the `p` choice until the mod reloads.

- **Row:** type icon (from the extension; `svg()` icons in the mod folder), title, note (one line,
  full on hover), who (program icon + address + live status dot, row 10), machine chip for remote
  items, relative time, unread dot. A `[x2]` chip when `adds > 1`.
- **Sort:** unread first, newest `added_at` first; read items below a divider; done items only in
  the Done view.
- **Header:** counts, filters (space, agent, type), Unread toggle, Done view. In a wide copy each
  filter is a chip that opens its menu; in a narrow one a filter icon opens one menu with all of them
  (also `f`), and the filters that are on show as chips under the header, each with an x. The menus
  are popups of this mod (props `{menu, target}`) that send the pick back through
  `shared("readlist.pick")`. Filters and the `/` text are per copy, in memory. Space names come
  from `spaces()`, agents from `who` (3.3), types from the icon's type.
- **Changed chip:** a read item whose file's mtime differs from `seen_mtime` (4.3). The list
  re-stats its files every 30 s, since items' files are outside the watched folder.

### 4.3 Keys and actions

Keys work while the pane has the keyboard (`focusable`, row 19; a click on the list gives it the
keyboard). A click on a row selects it and gives the list the keyboard; moving through the list
never opens anything. A double-click opens, like Enter. Each key is also a mod command, so `keys.json` can bind it
globally and scripts can drive it: `herdr-app do readlist.<command>` with `down`, `up`, `top`,
`bottom`, `open`, `preview`, `pane`, `reveal`, `copy`, `read`, `done`, `undo`, `delete`, `view`,
`find`, `filter`, `viewer`, `focus`, `install-rl` or `refresh`. A command reaches every shown copy; only the copy that had
the keyboard last acts on it (`shared("readlist.keyboard")`, cleared when that copy closes), else
the sidebar's.

Increment 1 has `j`/`k` and arrows, `g`/`G` and Home/End, Enter, Space (the Quick Look panel), `r`,
`d`, `u`, Shift-D (delete) and Tab (switches between the list and the Done view); increment 2 adds
`p`, `o` and `c`; increment 3 adds `/`, `f` and `v`; increment 4 adds Shift-R. The full set:

| Key | Action |
|---|---|
| `j` / `k`, arrows | move |
| Enter | open in the default app (5); marks read |
| Space | macOS Quick Look panel (`qlmanage -p`, row 29), a toggle like Finder's; does not mark read. A link has no Quick Look: a notice says Enter opens it |
| `p` | show or hide the preview in the pane (4.2) |
| `o` | reveal in Finder (`open -R`); a link has nothing to reveal: a notice says so |
| Shift-R | list this machine and every other machine again now (4.6) |
| `r` | toggle read / unread |
| `d` | done (hidden; Done view lists it); in the Done view `d` or `u` brings it back |
| Shift-D | delete: removes the item file (on its machine), as `rl rm` does, in the list and the Done view; selection moves to the next item. No confirmation; `rl add` puts it back. Not while its machine is offline |
| Tab | switch between the list and the Done view |
| `a` | go to the agent that added it (`agent.focus {terminal}`) |
| `c` | copy the path (a link's URL), with a short notice |
| `/` | filter box (title, note, path; every word must match). Enter or Down goes back to the list keeping the filter, Esc clears it |
| `f` | the filter menu: space, agent, type, unread only |
| `v` | open or close the viewer pane on the right (4.1) |

State lives in `state.json`, written with `writeTextFile` and compare-and-swap (rows 6-7), retried
on a stale read:

```json
{ "v": 1, "items": { "<id>": { "read_at": "...", "done_at": "...", "undone_at": "...", "seen_mtime": 1794205354 } },
  "inbox": { "<name>": 1794205592 } }
```

Local items are keyed by id; remote ones are keyed `<machine>/<id>`, the address form Herdr uses
(`core/items.js` `itemKey`). The mod writes times with milliseconds (`toISOString()`).

- **Read** when `read_at` is at or after the item's `added_at`, so a re-add makes it unread again.
- **Done** when the latest done mark, the item's own `done_at` (`rl done`) or the state's, is at or
  after both `added_at` and the state's `undone_at`. The mod sets `done_at` or `undone_at` and
  clears the other, so the person's latest action wins over their earlier ones.
- `rl ls` applies the same rules, comparing times to the second.
- Entries for items no longer on the list (`rl rm`) are pruned once their last mark is 30 days old;
  a remote machine's entries only once this copy has that machine's listing, so an offline
  machine's items keep their state.
- `seen_mtime` is the file's mtime (epoch seconds) when it was read (Enter, `r`), so a row can say
  "changed" when the file changed since; marking unread forgets it. `inbox` is the drop folder's
  record (3.5).

### 4.4 Arrival: toast and count

- New or re-added items (seen through the watch or a poll) post one toast:
  `notify({title: "Reading list: plan.md", body: "claude t7: Revised rollout plan...",
  action})` (row 21). The action focuses an existing reading-list pane found through `panes()`
  (row 3), else opens the popup (`mod.open`). Several arrivals within a few seconds collapse into
  one toast ("3 new on your reading list").
- Only one copy toasts: copies claim each arrival (`<id>@<added_at>`) through
  `shared("readlist.toasted")` (row 23) before posting. That key changes once per arrival, so the
  cost of re-rendering every mod is small. A copy's first listing claims nothing (items already
  there are not news). Copies may race and one write may replace another's, so when its burst
  window (2.5 s) ends a copy toasts only the arrivals the map still gives to it, and claims again
  any that nobody holds. Claims are kept an hour, at most 200 (`core/arrival.js`).
- **The count:** in the pane's own header row (the mod cannot set its pane title, row 32). The
  unread count is also published as `shared("readlist.unread")`, so a personal status-bar or
  tab-bar clone could show a badge later; this design does not clone or change shipped mods.
- Items added with `--kind fyi` are listed but do not toast.

### 4.5 Preview and open, per type (macOS; Linux below)

| Type | In-pane preview | Enter (open) |
|---|---|---|
| Markdown (`.md`, `.markdown`) | `TextView.markdown`, scrollable, links open through `on_link_click` (row 13); omd's thread block stripped | default app (`open`); later, Review in the review mod (5) |
| Plain text, code, JSON, CSV, logs | readonly `Editor` with the extension's language (row 14), first 1 MiB (row 5) | default app |
| Images (PNG, JPEG, GIF, SVG, WebP) | `image()` of a copy in the mod's cache (rows 15-17), scaled to the pane | Preview (default app) |
| Other images (HEIC, TIFF, PSD) | Quick Look thumbnail (row 28) | default app |
| HTML | Quick Look thumbnail at the pane's width, which keeps the CSS (A.3); a "Basic" toggle uses `TextView.html` (no CSS) | default browser (`open`); later, the review mod's full render (5) |
| PDF | Quick Look thumbnail of page 1 | Preview |
| Office, Keynote, video, anything with a Quick Look generator | Quick Look thumbnail | default app |
| Folder | its listing (`ls`), first 200 entries | Finder |
| URL | the URL and note | `cx.open_url` (row 22) |
| Missing file | "gone" chip; the item stays until done | disabled |

- Thumbnails and image copies go to `mods/readlist/.cache/<machine>/` (`local` for this Mac) as
  `<id>-<mtime>-<size>.<ext>` for a copied image and `<id>-<mtime>-<size>-<px>.png` for a thumbnail
  (hidden, so writing them does not reload the mod, row 17), made with
  `qlmanage -t -s <px> -o <tmp> <path>` in a private temporary folder and renamed into place, so the
  sidebar and a pane making the same image at once do not collide. `<px>` is 800 or 1600 (two
  pixels per point of the preview's width, in two steps). Made on demand for the selected item, one
  at a time per copy (the latest selection wins), and kept until the item's file changes; making a
  new version removes the item's older ones, and items that leave the list lose theirs.
- Text and markdown previews read the first 512 KiB with `head -c` (a file with a NUL byte gets a
  Quick Look thumbnail instead); a folder lists its first 200 entries, folders first.
- Open is `exec("open", [path])`. Quick Look is `qlmanage -p "$1"` started in the background by
  `sh -c` (path as `$1`), so the panel is not tied to the `exec` call and its 30 s limit (rows 26b
  and 29); the mod keeps the pid and Space again kills that pid, only while it is still `qlmanage`.
  Quick Look only draws a preview, so it is safe for every type, executables included. Enter on
  executable types (`.app`, `.command`, scripts) reveals in Finder instead of opening, as herdr-md
  does for every non-markdown file. The rule (`core/items.js` `openAction`), checked again at the
  moment of opening: reveal any file with an execute bit, any folder whose name has an extension (bundles), and a fixed list of types macOS
  would run or install (`.app`, `.command`, `.terminal`, `.pkg`, `.dmg`, `.webloc`, `.fileloc`,
  `.jar`, shell and script files, ...). Paths always go to `open` as one argument, never through a
  shell string.
- Sizes from `on_size_change` are zoomed pixels; divide by `settings().zoom` before choosing a
  thumbnail size (herdr-md's note).

**Linux.** `core/platform.js` picks the commands from `window().platform`; macOS keeps the calls
above unchanged, and every Linux program is optional (checked with `command -v`; when missing, the
script exits 127 and says what to install, and the mod shows that in a toast).

- Open is `xdg-open "$1"` in the background with its stderr in a temporary file; the script waits
  up to 3 s for its exit status and then returns, so an opener that stays running with its app is
  not killed by `exec`'s limit.
- Reveal (`o`, and Enter on an item that could run) is the freedesktop
  `org.freedesktop.FileManager1.ShowItems(['file:///...'], '')` call through `gdbus`, answered by
  Nautilus, Dolphin, Nemo, Caja, Thunar and others; else `xdg-open` on the item's folder. The
  reveal-instead-of-open rule adds Linux launchers and packages (`.desktop`, `.AppImage`, `.run`,
  `.bin`, `.deb`, `.rpm`, `.snap`, `.flatpak`, `.flatpakref`, `.flatpakrepo`).
- Space is GNOME Sushi: `org.gnome.NautilusPreviewer2.ShowFile(uri, '', close)` (the older
  `org.gnome.NautilusPreviewer.ShowFile(uri, 0, close)` second), D-Bus starting Sushi on demand;
  Space again on the same item passes `close` true. With no Sushi (`ServiceUnknown`) or no
  `gdbus`, a one-time toast says so and Space shows or hides the in-pane preview instead (in the
  narrow rail, the `v` pane).
- Thumbnails: none. Images GPUI draws are copied into the cache and shown as on macOS; HTML, PDF,
  other images and binary files show their type's icon with "Enter opens it".
- Paths reach D-Bus as GVariant string literals with every byte that is not unreserved
  percent-encoded, so no path can end the literal.

### 4.6 Remote items

Items on another machine (a named machine in `machines()`, layout `ready`; `core/remote.js`):

- **Listing:** every 15 s while a copy of the mod is alive, and on Shift-R, one
  `exec("sh", ["-c", POLL_SCRIPT, "readlist", ...paths], {on: m})` (row 8) per machine. It prints
  `dir<TAB>` the list folder (`$READING_LIST_DIR` or `~/.local/state/reading-list` in that
  machine's environment), `rl<TAB>` the `rl` status line (as here, 3.1), a stat line
  (`kind mtime size`) for each path of the last listing, then each `items/*.json` after a
  record-separator line (`\n\036\n`), and a last record `end`. The mod splits on the separator
  line. Output without the `end` record (cut at 8 MiB, killed) is not a listing. New items' files
  are stat-ed by one more poll at once, so steady state is one exec per machine per poll. The poll
  writes nothing; a machine with no list folder lists nothing. No `watchFolder` remotely (row 4).
  The poll times out after 20 s.
- **Offline:** a poll that fails (the exec rejects, times out or ends early) marks the machine
  offline; its items stay from the last poll that answered, with an "offline" chip, until a poll
  answers again. A machine whose layout is `unavailable` is offline the same way. A machine that is
  gone from `machines()` is dropped. A machine without `sh` (Windows: exec says "cannot start sh")
  is "unsupported", not offline, and is not polled again until it reconnects. All of this is in
  memory, per copy: after a restart an offline machine shows nothing until it answers.
- **Preview text:** `readTextFile(path, {on: m})` (row 5) up to 1 MiB (the first 512 KiB shown, as
  here); larger, or text `readTextFile` cannot read, through `head` on that machine. Folders are
  listed there.
- **Open, Space, `o`, image, thumbnail:** fetch a local copy first, into
  `mods/readlist/.cache/remote/<machine>/<id>/copy/<name>` (keeps the original file name so `open`
  picks the right app; under the app home so `image()` loads it), with
  `.cache/remote/<machine>/<id>/meta` (`{"mtime", "size", "at"}`); images and thumbnails made from
  the copy go to `.../<id>/thumbs/` as in 4.5. Up to 5 MiB, herdr-workbench's route (row 26):
  `base64` there through `exec(..., {on})`, the text written here with `writeTextFile`, decoded
  with `base64 -d`. Larger, a local `sh` runs `hc exec --on m -- sh -c 'dd ... skip=N count=7'`
  in 7 MiB chunks (checked: `hc exec` passes bytes through unchanged but keeps only the first
  8 MB of output), else `scp` to the machine's ssh target from `hc machine ls`. Every route checks
  the copy's size against the stat there before moving it into place. Then everything in 4.5 runs
  on the copy. Copies of items no longer listed are removed after each poll.
- The row and preview say "copy from server, fetched 18:42"; the copy is fetched again when the
  file's mtime or size changes there (a poll's stat, or the stat taken before each open). Files
  over 50 MiB ask first: Enter (Space, `o`) says the size, and a second press within 15 s fetches;
  the preview shows the size instead of fetching. Edits to the copy do not go back; the preview
  says so.
- **`rl` there:** the poll's status line drives the same banner as here (3.1), worded for the
  machine: "rl is not installed on server, ..." with **Install rl on server**, which reads the
  mod's `rl` here and runs `INSTALL_RL_TEXT_SCRIPT` there with the text as an argument (a temporary
  file, then the same rules: never over another program or a link, `~/.local/bin/rl`). "Not now"
  is kept per machine.
- Shift-D removes the item file on its machine (`rm` through `exec(..., {on})`, the folder from the
  poll), then lists that machine again. The drop folder (3.5) is this Mac's only.

## 5. Hand-off to a review mod

Not built; it waits for a document-review mod (a pane that shows a markdown or HTML file and lets
the person comment on it, bound to an agent) to exist. For a markdown or HTML item, a Review key
(chosen then; Shift-R lists the machines again, 4.6) or a Review button would open that mod beside
the agent that added it, with that agent bound:

```js
run("pane.split", { direction: "right", pane: agentPane ?? readlistPane,
                    mod: "<review mod>", props: { file: item.path, agent: item.by.terminal } });
```

- `agentPane` comes from `agents().find(a => a.address === item.by.terminal).pane` (row 10); if the
  agent has ended, the review opens beside the reading-list pane, unbound.
- The reading list marks the item read. It does not track comments; the review mod owns those.
- Until then, nothing shows for it.

## 6. Repository and packaging

```text
herdr-reading-list/            laid out like a herdr-app home, so it can be shared on herdr.dev
  mods/readlist/main.js, mod.json, icons/*.svg
  mods/readlist/core/          pure logic (item parse, sort, filters, state merge), node-testable
  mods/readlist/bin/rl         the POSIX sh producer; travels with the mod
  keys.json                    cmd-shift-i (macOS) / ctrl-shift-i (Linux) open the popup (each platform merges its own, only where free)
  RECIPE.md, preview.png       the herdr.dev brief and screenshot
  skill/reading-list/SKILL.md  for agents: when to add, the rl commands, the zero-install fallback
  bin/rl                       a link to mods/readlist/bin/rl
  bin/install-dev              copies the mod, merges keys.json, links rl, adds the sidebar block
  layout/add-to-sidebar.mjs    optional: puts the readlist block under agents in a cloned layout
  test/                        node tests for core/, shell tests for rl (scratch READING_LIST_DIR)
```

`mod.json`: `{"place": "none", "focusable": true, "overlay": {"width": 560, "height": 480}}`.

## 7. Increments

Each one is useful on its own.

1. **Producer and local list.** `rl add|ls|done|rm`, the item format, ids and de-duplication,
   attribution from `hc get`; the mod pane with the list, keyboard navigation, Enter to open, read
   and done state in `state.json`, live updates through `watchFolder`. Done when an agent's
   `rl add` shows up in the pane without a reload and Enter opens it in the right app.
2. **Previews.** Markdown and text in the pane; images through the cache; Quick Look thumbnails for
   HTML, PDF and the rest; reveal, copy path, Quick Look panel. Rows 17 and 29 get checked in the
   live app first.
3. **Arrival and filters.** Toast with single-copy claim, the popup on a key, filters by space,
   agent and type, the "changed since read" chip, drop folder and drag-and-drop, and the `v`
   viewer pane.
4. **Remote machines.** Polling remote folders, the fetch-to-cache path (row 26 checked first),
   offline handling, installing `rl` on a remote machine (section 9, call 5).
5. **Review hand-off.** The Review action, once a document-review mod exists (section 5).
6. **Agent conventions and a second source.** The skill text for agents (`skill/`, written with the
   publishing step); an orchestrating agent posting its reports and its workers posting their
   deliverables (section 9, call 4). Optionally, list the files Claude Code
   agents already send with their `SendUserFile` tool, found in the session transcript the way
   herdr-artifacts and herdr-shelf find it (A.1, A.2), so those arrive without any agent learning
   `rl`.

## 8. Risks and things to check first

- The image cache under `mods/readlist/.cache/` follows herdr-md, which ships it (row 17); checked
  in herdr-app 0.1.14 at the start of increment 2 (row 17).
- Install the dev copy as a copy, not a symlink (herdr-md: a symlinked mod neither hot-reloads nor
  writes).
- `qlmanage` is a developer tool Apple keeps but does not document as an API; if a macOS release
  changes it, previews fall back to the icon plus Open. The thumbnail size limit and the time for a
  large PDF are not measured yet.
- Agents over-posting: a chatty agent can flood the list. Mitigation: `--kind fyi` does not toast,
  toasts collapse, and the skill text says to add only what the person should read.
- Polling remote machines costs one `hc exec` per machine per 15 s while the mod is alive (timers
  run while hidden, AGENTS.md:795-800). If that proves noisy, poll only while a copy is shown.
- Paths with spaces or quotes go through `exec` argument arrays and `"$1"` in `sh -c`, never through
  string concatenation.
- Trust: any local process can add items, and an item path can point anywhere. The mod only reads
  and opens (it never executes an item); opening an `.app` or a script with `open` would run it, so
  Enter on executable types reveals them in Finder instead (4.5).

## 9. Settled calls

| # | Question | Decision |
|---|---|---|
| 1 | Name of the mod and command | Mod folder `readlist`, command `rl`, repo `herdr-reading-list`. Herdr has no naming rule for mods: published repos are conventionally `herdr-<name>`, mod folders a plain name. |
| 2 | Where the list lives | `~/.local/state/reading-list/` on each machine, `$READING_LIST_DIR` overrides. |
| 3 | How it opens | A block in the left sidebar under Agents (a cloned layout), a pane on demand, and a popup on `cmd-shift-i` in increment 3. |
| 4 | Do orchestrating agents post to it | At first only reports that need the person's decision; widen once the list has proved useful. |
| 5 | How `rl` gets onto PATH | `rl` ships inside the mod (`mods/readlist/bin/rl`). On this Mac the mod's Install rl action (a banner while `rl` is missing, and `readlist.install-rl`) copies it to `~/.local/bin`, never over another program; the dev install links it there instead. On another machine, the banner's Install rl on <machine> copies it to `~/.local/bin` there through `exec(..., {on})` (4.6). The JSON protocol (3.1) is the fallback. |
| 6 | Share it on herdr.dev | Yes: a public repo laid out like a herdr-app home, with `RECIPE.md`, `preview.png` and the `herdr-mod` topic. |

## Appendix: API facts this design relies on

Sources: the installed `~/.config/herdr-app/AGENTS.md` (written by the app on every start),
`~/.config/herdr-app/herdr.d.ts`, `~/.config/herdr-app/gpui-kit.d.ts`, `herdr-app --skill`,
`hc --skill`, `hc <cmd> --help`, `herdr-app commands`. These files are local and regenerated per app
version, so they have no stable URL; line numbers below are for herdr-app 0.1.13. The public mirror
of the same guide is the Herdr docs at https://herdr.dev (mods index: https://herdr.dev/mods).
An earlier spike for another mod (checked against 0.1.12) is cited where it already
verified something by spike.

Key: **V-types** = in a generated `.d.ts`; **V-docs** = in the installed `AGENTS.md`, `--skill` or
`--help`; **V-spike** = observed here (A.3) or in an earlier spike; **V-mod** = a published mod
relies on it in code that ships (A.1); **Assumed** = not verified;
the design says what happens if it is wrong.

| # | Fact | Status | Where |
|---|---|---|---|
| 1 | A mod is `mods/<name>/main.js` (a `View`) + `mod.json`; `"place": "none"` plus an `overlay` entry makes `mod.open` open it as a popup; hot reload; `herdr-app check` | V-docs | AGENTS.md:772-799, 821-828 |
| 2 | Mod pane beside terminals: `pane.split {direction, pane?, mod, props}`, saved with its tab; `tab.new {mod, props}` | V-docs | AGENTS.md:125-130, 541-555 |
| 3 | `panes()` lists mod panes with `mod` set and `terminal: null`, so a mod can find a pane showing itself | V-types | herdr.d.ts:183-207 |
| 4 | `watchFolder(dir)`: changed paths in batches, local only, recursive on macOS; a batch with the root means "reload all" | V-types | herdr.d.ts:404-414; AGENTS.md:982-990 |
| 5 | `readTextFile(path, {on})`: UTF-8 up to 1 MiB, here or on another machine; null if absent | V-types | herdr.d.ts:23-25 |
| 6 | `writeTextFile(path, text, expected)`: compare-and-swap, local only | V-types | herdr.d.ts:26-28 |
| 7 | `writeTextFile` works outside `~/.config/herdr-app` | V-spike | an earlier spike |
| 8 | `exec(cmd, args, {cwd, on})`: user's env and PATH, 30 s limit, 8 MiB output, no stdin; `on` runs it on that machine | V-types | herdr.d.ts:10-13 |
| 9 | `machines()`: name (null = this Mac) and layout state; `spaces()[i].machine` | V-types | herdr.d.ts:132-137, 111-130 |
| 10 | `agents()`: address, pane, space, tab, status, `app`, `program`; `terminals()` = `hc ls --json`; `render` re-runs when they change | V-types | herdr.d.ts:157-181, 214-217; AGENTS.md:868-871 |
| 11 | `$HC_TERMINAL_ID` is set in every hc terminal | V-docs | `hc --skill` line 10; `herdr-app --skill` |
| 12 | `hc get <t> --json` gives `cwd`, `name`, `labels` (incl. `herdr.space`, `herdr.tab`), and `status.app` | V-spike | ran `hc get $HC_TERMINAL_ID --json` here: labels `herdr.space`, `herdr.tab`, `status.app: "claude-code"` |
| 13 | `TextView.markdown(id, text)` (`.scrollable()`, `.selectable()`, `.on_link_click()`); `TextView.html` has no CSS | V-types | gpui-kit.d.ts:20701-20710 |
| 14 | Readonly `EditorState`/`Editor` code view with syntax highlighting | V-types, V-docs | AGENTS.md:921-925; shipped `mods/files/main.js:141` |
| 15 | `image(path)`: full colour PNG, JPEG, SVG "and other GPUI image formats"; path resolves against the app home | V-types | gpui-kit.d.ts:20284-20290; AGENTS.md:801-804 |
| 16 | `image()` does not load files outside the app home | V-mod (herdr-md `main.js:83`: "The app only loads images from its own folder") | Design copies or thumbnails into a cache under the app home |
| 17 | Images load from a hidden folder under `mods/<name>/` (herdr-md's `.cache/`) or from `appHome()/cache/<mod>/` (herdr-workbench); writes to hidden files do not reload the mod | V-spike (0.1.14), V-mod, V-docs (AGENTS.md:789-791) | Increment 2, with the dev install: a probe build logged each `init` to `.cache/probe.log`; writing, copying and renaming files under `mods/readlist/.cache/` added no `init` (and the probe's own write did not loop), while touching `main.js` added one. `image("mods/readlist/.cache/local/<name>.png")` drew copied PNGs and Quick Look thumbnails of HEIC, HTML and PDF in the pane. |
| 18 | `list(...)` / `uniform_list(...)` virtual lists; `scroll_to_item` | V-types | gpui-kit.d.ts:20296-20363, 21305 |
| 19 | Keyboard: `cx.focus_handle()`, `.track_focus(h).on_key_down(...)`; `"focusable": true` lets `pane.go` reach the pane | V-docs, V-types | AGENTS.md:781-785, 912-913; herdr.d.ts:395-402 |
| 20 | `.on_drop((e) => e.paths)` receives files dropped from Finder | V-docs, V-types | AGENTS.md:914-916; gpui-kit.d.ts:783 |
| 21 | `notify({title, body, level, action: {name, args}})`; clicking runs the command | V-types | herdr.d.ts:370-379; AGENTS.md:991 |
| 22 | `cx.open_url` accepts only absolute `http(s)` URLs | V-types | gpui-kit.d.ts:330-343 |
| 23 | `shared(key)` / `setShared(key, v)`: persisted, seen by every mod, setting re-renders all | V-types | herdr.d.ts:389-393 |
| 24 | `localStorage` is per mod copy | V-docs | AGENTS.md:997 |
| 25 | `hc exec --on m <argv>` prints exactly what the program wrote; `hc file read --on m` (text); `hc put <t> <file>` sends a local file to a terminal's machine | V-docs | `hc exec --help`, `hc file --help`, `hc put --help` |
| 26 | Remote binary fetch: `exec("sh", ["-c", 'base64 < "$1"', ...], {on})`, text written locally, then decoded with `base64 -d`; the runtime writes a `Uint8Array` as an empty file, so bytes cannot be written directly | V-mod (herdr-workbench `mods/t3-files/viewer.js:50-71`, 6 MB cap); V-spike (increment 4: a 230 KB PNG fetched byte-exact; `exec` keeps 8 MiB, so this route stops at 5 MiB) | Larger files: `hc exec --on m` is binary-safe (V-spike: random bytes, same SHA-256) but keeps only the first 8 MB of output, so the mod fetches 7 MiB `dd` chunks (a 60 MiB file in about 4 s), else `scp` |
| 26b | A program started by `exec` dies when the call ends; long-lived helpers use `hc run --bg --no-parent --rm` | V-mod (herdr-workbench `serve.js:32-45`) | Applies to the Quick Look panel (row 29) |
| 27 | `open <path>` opens in the default app; `open -R` reveals in Finder; `open -a <App>` | Assumed (standard macOS, not run) | |
| 28 | `qlmanage -t -s N -o dir files...` thumbnails md, HTML (with CSS), PDF page 1 and images | V-spike | A.3 |
| 29 | `qlmanage -p <file>` shows the Quick Look panel and stays open past `exec`'s 30 s limit | V-spike (0.1.13, again 0.1.14) | the mod starts it with `sh -c 'qlmanage -p "$1" ... & echo $!'`: the panel (816x849 window) was on screen, still open after 35 s, closed by killing the pid; the item stayed unread. Increment 2 rechecked it through `herdr-app do readlist.preview`: the window list showed an on-screen 816x849 `qlmanage` window frontmost, Herdr stayed the active app (so the next Space reaches the list), and the second `readlist.preview` ended the process. `screencapture` run from an agent's shell does not capture the panel's pixels, so that look is not in the screenshots |
| 30 | No `Intl`, `TextEncoder`, `structuredClone` in the mod engine | V-spike | hashing and relative times by hand, so ids come from the producer |
| 31 | `herdr-app check` runs `init` and one `render` only | V-docs | AGENTS.md:54-58 |
| 32 | A mod cannot set its own pane header title (so no badge in the header) | **Assumed** | `PaneInfo.title` is "the mod's name" (herdr.d.ts:190); the count goes in the pane's own top row |
