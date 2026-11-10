# Reading list

A list of files and links that agents and tools put up for the person to read. An agent runs
`rl add plan.md --note "why"`; the item appears at the top of the list with a toast, showing what
it is, the note and who added it. The person walks the list with the keyboard, sees a preview of
the selected item beside the list (rendered markdown, highlighted code, images, and on macOS Quick
Look thumbnails of HTML and PDF), opens it in its default app with Enter, and marks it done. Agents on
other machines Herdr reaches add to that machine's own list, which shows here too: their files
are previewed in place or fetched into a local copy to open. When the person turns it on, files
Claude Code agents send them with their SendUserFile tool arrive on the list too, without the agent
running `rl`. It lives in a pane, in the left sidebar, or as a popup on `cmd-shift-i`
(`ctrl-shift-i` on Linux and Windows).
`skill/reading-list/SKILL.md` is an agent skill that teaches agents when and how to add.

![Reading list](preview.png)

| Platform | Support |
|---|---|
| macOS | Full: `open`, Finder (`open -R`), the Quick Look panel and thumbnails (`qlmanage`). |
| Linux | Supported: `xdg-open`, the file manager through the freedesktop `FileManager1` D-Bus call (`gdbus`), else `xdg-open` on the folder; the Space preview window needs GNOME Sushi, else the in-pane preview; no thumbnails (other types show their icon). |
| Windows | Supported, with PowerShell 7 (`pwsh`): the default app (the shell's association), Explorer (`explorer /select,`), the Space preview window in the QuickLook app or PowerToys Peek when installed, else the in-pane preview; images drawn in the pane, other types show their icon. `rl` is `rl.ps1` (with `rl.cmd` and a Git Bash shim); the list lives in `%LOCALAPPDATA%\reading-list`. |

Each action (open, reveal, the Space preview window, thumbnails) is a handler, a program run with
the item as a separate argument: one built in per platform, and in front of it, only once the
person turns it on, their own `~/.config/herdr-app/readlist/handler` (`handler.ps1` on Windows).

## What you see

All colors are `theme()` names, so it follows the person's theme; sizes are logical pixels.

- **Header** (41 high, 16 side padding): "Reading list" in 11.5 medium `dim`, then the unread count
  as a chip (10.5 semibold `accent` text on `accent` at 15% alpha, 16 high, 5 radius). On the right:
  in a pane 520 or wider, four filter chips ("All spaces", "All agents", "All types" each with a
  chevron, and "Unread"; 22 high, 6 radius, 1px `border`, 11 `dim`; a chip that is on gets an
  `accent` border at 40% and `accent` fill at 10%), then a "Done" link (11 `dim`, "Done 3" when
  there are done items, "Back to list" in the Done view). Narrower, one filter icon (14) instead of
  the chips; the filters that are on show as removable chips under the header.
- **Install banner** (only while `rl` can't be run from a terminal): a box under the header (14
  side margin, 8 radius, `raised` fill, 1px `border`, 12 text): "Agents add to this list with rl,
  which is not installed." with an **Install rl** button (24 high, `solid` fill, `solid_foreground`
  medium text) and a "Not now" link. Other states: "The rl on your PATH (…) is another program."
  (with the button), "rl is in ~/.local/bin, which is not on your PATH…" (no button). On Windows
  each text ends "Install rl copies it to ~\.local\bin and adds that folder to your PATH.", and the
  off-PATH state has the button too (it adds the folder to PATH). When `rl`
  is fine here, the same box speaks for the first other machine without it: "rl is not installed
  on devbox, so agents there cannot add to this list." with **Install rl on devbox**.
- **List** (rows 46 high, 8 radius, 8 side padding; group heads 30 high): unread items first,
  newest first, then a "Read  2" head and the read ones. Each row: a 16 type icon (markdown and
  text, code, HTML, image, PDF, folder, link, file), the title (13; unread `foreground` medium,
  read `muted`), the age ("now", "5m", "3h", "2d"; 11 `dim`), an unread dot (7, `accent`), and a
  second line (11 `dim`) "note · who" (the agent's program and terminal, "(ended)" when it has
  gone, or the `--from` name). A "changed" chip (`accent`) on a read item whose file changed since;
  "×3" when added three times; "gone · …" when the file has moved. Another machine's item has a
  chip with the machine's name (`muted`), an "offline" chip (`blocked`) while that machine does not
  answer, and "copy from devbox, fetched 18:42" at the end of its second line once a copy was
  fetched. The selected row is `selected` (`raised` when the list has no keyboard); hover is `hover`.
- **Preview**: in a pane 520 or wider it fills the right of the list (the list takes 42% of the
  width, 300 to 460), separated by a 1px `border`, on `background`. A header (14 side padding, 1px `border` under it) with the title (medium), the
  path or URL (11 `dim`; `devbox:/path` for another machine's, with "on devbox" or "copy from devbox,
  fetched 18:42; edits to the copy stay on this Mac" (Linux: "this computer") under it) and the note (11.5 `muted`), then
  the body: markdown rendered (`TextView.markdown`),
  text and code in a read-only editor with highlighting, images, a Quick Look thumbnail for HTML,
  PDF and anything else Quick Look draws (on Linux, where there are no thumbnails: the type's icon,
  48 `muted`, centered, over "No thumbnail for this type here. Enter opens it; Space shows it in
  GNOME Sushi." in 12 `dim`), a folder's entries, a link's URL, "gone" for a missing
  file. Narrower, the preview is hidden until `p`, then shows below the list (half the pane, at
  most 260).
- **Key hints** (24 high, 10.5 `dim`) at the bottom while the list has the keyboard: "↵ open  ␣ look
  p preview  v viewer  o reveal  c copy  / find  f filter  r read  d done  tab done", and "R
  refresh" when other machines are connected.
- **Backgrounds**: `background` in a pane, `chrome` with a top `border` in the sidebar, `popover`
  in the popup. Under 160 wide (a collapsed sidebar) it becomes a rail: a bookmark icon with the
  unread count, and one icon per item.
- **Empty**: "Nothing to read. Agents add files with rl add <path> --note "why", or drop files
  here." (12 `dim`).

## How it behaves

- **Arrival**: the mod watches the list folder (`watchFolder`), so an `rl add` shows at once. New
  items post one toast ("Reading list: plan.md" with "who: note", or "3 new on your reading list"
  for a burst within 2.5 s); `--kind fyi` items and files the person dropped don't toast. Only one
  copy of the mod toasts each arrival. Clicking the toast focuses a reading-list pane, else opens
  the popup.
- **Keys** (while the list has the keyboard; a click on it gives it the keyboard): click or
  `j`/`k`/arrows/`g`/`G`/Home/End select (selecting never opens); Enter or a double-click opens in
  the default app and marks read (the popup then closes); Space toggles the macOS Quick Look panel,
  on Linux GNOME Sushi (doesn't mark read; without Sushi it shows or hides the in-pane preview as
  `p` does, or in the rail opens the `v` pane, with a one-time toast saying Sushi is missing); `p`
  preview in the pane; `v` opens a preview-only pane on the right of the
  window that follows the selection of any copy (`v` again closes it); `o` reveals in Finder (the
  file manager on Linux); `c`
  copies the path or URL (with a toast); `r` read/unread; `d` done (Tab switches to the Done view,
  where `d` or `u` brings it back); Shift-D deletes the item file (no undo); `/` opens a filter box
  (title, note, path; Enter or Down back to the list, Esc clears); `f` opens the filter menu (a
  250-wide popup with sections Space, Agent, Type and Show (All items / Unread only), each option with its count, a check on the chosen one, and in the list view a last section "Also add" with
  one entry, "Files Claude Code sends", checked while that source is on, then "Actions" with "Built-in"
  and "Your handler", the one in use checked; `j`/`k`, Enter); Shift-R lists
  this machine and every other one again now. Each is also a command,
  `readlist.<down|up|top|bottom|open|preview|pane|reveal|copy|read|done|undo|delete|view|find|filter|viewer|focus|install-rl|refresh|claude-files|handler>`,
  which only the copy that had the keyboard last acts on (else the sidebar's).
- **Search in the viewer** (while the `v` pane has the keyboard; a click on it gives it the
  keyboard): `/` opens a search bar under the pane's header (26 high, a search icon, the prompt
  "Find in this item: Enter, then n / Shift-N", an x). Enter goes to the first match after the
  current one (from the top when there is none; an empty prompt repeats the search) and the body
  turns into the item's text drawn row by row in the code font (12, 18-high rows, long lines
  wrapped; markdown as its source) with every match on `selection` and the current one on `accent`
  in `accent_foreground`, scrolled to the middle; the bar says "3 of 12" (11 `dim`), "no matches"
  (`blocked`) or "3 of 12 · wrapped". `n`/Shift-N go to the next/previous match, wrapping; Esc closes
  the search and the preview draws as before. Literal text, case-insensitive unless the query has
  an uppercase letter. Images, thumbnails, folders and links show "Nothing to search in this
  preview." in the bar. The search ends when the selection moves to another item, and follows the
  item's text when its file changes. The list's `/` filter and its other keys are unchanged.
- **Opening**: files open with `open` (Linux: `xdg-open`); executable items (`.app`, scripts,
  `.command`, anything with an execute bit, installers, and on Linux `.desktop`, `.AppImage`, `.run`,
  `.deb`, `.rpm`, `.snap`, `.flatpak`...) are revealed in Finder or the file manager instead, with a
  toast saying why. Links open in the browser. A missing program (`xdg-open`, `gdbus`) gets an
  error toast naming it.
- **Re-adding** the same path makes it unread and moves it to the top; `adds` counts.
- **Drop folder**: anything put in the list folder's `inbox/`, or dropped onto the list, is added
  (from "inbox" or "dropped"); the file stays where it is.
- **Files Claude Code sends** (off until turned on with the `f` menu's "Files Claude Code sends" or
  `readlist.claude-files`, which toggles it and toasts the new setting): for each Claude Code agent
  on this computer in `agents()`, `hc get <t> --json` gives the terminal's foreground pid; Claude Code's
  `sessions/<pid>.json` (in `$CLAUDE_CONFIG_DIR` or `~/.claude`; the pid's children and
  grandchildren are tried too) gives the session id, and `projects/*/<session id>.jsonl` is the
  transcript. One `sh` script reads every transcript's lines containing `file_uuid` (skipping
  lines over 256 KiB, and skipping a transcript whose size and mtime are unchanged since this
  copy last read it); the mod keeps the tool results whose `toolUseResult.attachments` list
  delivered files. Each delivered file is added with the mod's `rl add --if-new --kind result`,
  the send's caption as the note, the agent's terminal looked up as for an agent running `rl`, and
  "Claude Code t7" as the `--from` fallback. Only sends made since the setting was turned on are
  added, and each once: `state.json`'s `claude_files` keeps, per session, the time of the latest
  send handled, and a file already on the list (added with `rl`, or sent before) is left as it is.
  A file that is gone, a missing or malformed session file or transcript, or an agent without a
  session is skipped quietly. It reads transcripts when a Claude Code agent comes, goes or changes
  state and every 30 s, while a copy of the list is shown; sends of a session that ended while no
  copy was shown are not added. Agents on other machines are not read.
- **Handlers**: every action runs `sh mods/readlist/bin/run-handler` with separate arguments,
  which runs the handler as `ACTION [ARG...] -- ITEM` (ITEM an absolute path with its folders
  resolved, or an http(s) link for `open-url`; nothing else from the item): `open`, `reveal`,
  `open-url`, `preview` (prints a token), `preview-close TOKEN same|other`, `thumbnail SIZE OUT`.
  Exit 0 done, 10 not handled (the next handler, then the mod's fallback: the browser, the in-pane
  preview, the type's icon), else an error whose first stderr line is toasted. 15 s per action,
  30 s per thumbnail, one try each; a thumbnail that failed or that no handler made is not asked
  for again until the file or the handlers change. The built-in ones are `handlers/macos.sh`
  (`open`, `open -R`, `qlmanage -p` with its pid as the token and `kill` of that pid only while it
  is `qlmanage`, `qlmanage -t`) and `handlers/linux.sh` (`xdg-open`, the FileManager1 call, GNOME
  Sushi; `other` keeps Sushi's window; no thumbnails), picked by `window().platform`.
  The person's own `~/.config/herdr-app/readlist/handler` is tried first only after they turn it
  on (the `f` menu's Actions, `readlist.handler`); that records its real path and SHA-256 in
  `~/.config/herdr-app/readlist/trust.json`. `run-handler` checks it before every run and exits 11
  ("readlist: why") instead when it changed, now leads elsewhere, is not a regular executable file
  owned by the person, is writable by group or others, or is below a folder (or a link's folder)
  another user owns or group or others can write; the built-in handler then acts, a toast says why
  once, and a banner under the header (styled like the rl banner) gives the path with **Use it**
  (confirm the file as it is now, for changed or moved) and "Turn off". While it is on and used, the
  key hints end with "your handler" (`accent`, right-aligned).
  On Windows the runner is `bin/windows/run-handler.ps1` (pwsh), the built-in handler
  `handlers/windows.ps1` (`Process.Start` with the shell's association, `explorer.exe
  /select,"PATH"`, `QuickLook.exe PATH` or `PowerToys.Peek.UI.exe PATH` with the token `quicklook`
  or `peek`, QuickLook run again on `same` to close it; open refuses the types that could run and
  any type in `PATHEXT`; `READLIST_DRY_RUN=1` prints `would: ...` instead), and the person's handler
  is `readlist\handler.ps1`, run in a pwsh of its own and stopped with everything it started after
  12 s (28 s for a thumbnail). It is refused unless it is a `.ps1` file owned by the person (or
  Administrators, or SYSTEM) that no other account (Everyone, Users, Authenticated Users, any user
  or group but the person, SYSTEM, Administrators, TrustedInstaller) may write, append to, delete,
  re-permission or take; its folder must not let others add, delete or rename entries, and no
  folder above it (or above a link or junction on the way) may let others write into it, delete
  from it or change it (creating new folders, which Windows lets every user do at a drive's root,
  is fine).
- **Install rl**: the button (or `readlist.install-rl`) copies the mod's `bin/rl` to
  `~/.local/bin/rl` and toasts the result: installed, updated an older copy, already this version,
  `~/.local/bin` not on PATH, another `rl` first on PATH, or "another program called rl; left as it
  is". It never overwrites another program or a link. "Not now" hides the banner in that copy until
  the state changes. The status is checked on start and every 30 s. On Windows it copies `rl.ps1`,
  `rl.cmd` and `rl` (the Git Bash shim) from `bin/windows` to `~\.local\bin` and, when that folder
  is not on PATH, appends `%USERPROFILE%\.local\bin` to the person's own PATH (HKCU\Environment,
  the other entries kept unexpanded) and tells running programs; the toast says programs started
  before then find `rl` after a restart. The status reads PATH afresh from the registry.
- **Times** refresh every 30 s, when files are also re-checked for the "changed" chip.
- **Other machines** (each named machine in `machines()` whose layout is ready): listed every 15 s
  while a copy of the mod is alive, and on Shift-R, with one `exec(..., {on})` per machine that
  prints the list folder there (`$READING_LIST_DIR` or `~/.local/state/reading-list/` in that
  machine's environment), whether `rl` is there, a stat line for each file of the last listing,
  and every item file after a record-separator line, ending with an "end" record. Nothing is
  written there. Their items are keyed `<machine>/<id>` in `state.json`. Text and markdown
  previews are read there (`readTextFile(path, {on})`, up to 1 MiB, else `head` there); folders are
  listed there. For an image, thumbnail, Enter, Space or `o` the file is fetched into
  `.cache/remote/<machine>/<id>/copy/<its name>` (with a `meta` of its mtime, size and fetch
  time) and everything runs on the copy; it is fetched again when the file's mtime or size
  changes there. Up to 5 MiB it comes as base64 through `exec` and is decoded here; larger, in
  7 MiB chunks through `hc exec --on` (whose output stops at 8 MB), else with `scp`; the size is
  checked either way. Over 50 MiB, Enter (or Space, `o`) says the size and fetches on a second
  press within 15 s; the preview says so instead of fetching. A machine that stops answering keeps
  its items, marked offline, until it answers again; state for its items is not pruned meanwhile.
  Another machine without `sh` (Windows, as another machine) has no list here and is not polled
  again until it reconnects.
  Shift-D removes the item file on its machine. **Install rl on devbox** sends the mod's `rl` as
  an argument and installs it to `~/.local/bin` there, with the same rules as here.

## Built from

- `mods/readlist/` (the mod, `NAME` in `core/name.js`): `main.js` is one `View` for every role,
  chosen by props: none (a pane), `{role: "sidebar"}` (a layout block), the popup
  (`mod.json` `{"place": "none", "focusable": true, "overlay": {"width": 560, "height": 480}}`,
  opened by `mod.open:readlist`), `{role: "viewer"}` (the `v` pane), `{menu, target}` (a filter
  menu). `core/*.js` are pure functions and shell scripts, node-tested: `items.js` (parse, types,
  open action), `state.js` (read/done state), `filters.js`, `arrival.js` (toast claims),
  `inbox.js`, `preview.js`, `viewer.js`, `search.js` (search in the viewer: matches, smart case,
  next/previous, rows), `install.js`, `remote.js` (the poll, each machine's
  online/offline state, local copies), `sent.js` (files Claude Code agents sent: the transcript
  scan, the record of what was added). `icons/` are Lucide SVGs (ISC).
- `mods/readlist/bin/rl`: the producer, POSIX `sh` and `awk`. Writes `items/<id>.json` atomically
  (temp file, `mv`); id = first 16 hex of SHA-256 of the real path or URL; fills `by` from
  `hc get $HC_TERMINAL_ID --json` inside a Herdr terminal. `--if-new` leaves an item already on the
  list as it is.
- `mods/readlist/bin/windows/`: Windows (PowerShell 7). `rl.ps1` is the same producer (same
  commands, item JSON byte for byte, id rule; the real path has the drive letter upper case, each
  name as on disk and links and junctions resolved, e.g. `C:\Users\me\plan.md`; default list folder
  `%LOCALAPPDATA%\reading-list`), `rl.cmd` runs it from cmd.exe and other programs, `rl` from Git
  Bash. `readlist.ps1` is one script whose operations stand for the `sh` scripts in `core/*.js`
  (`core/helpers.js` maps each; same arguments and output shapes). `run-handler.ps1` checks and
  runs handlers; `common.ps1` is shared by the last two.
- `skill/reading-list/SKILL.md`: the agent skill (frontmatter `name` and `description`): when to
  add (deliverables, reports, results, decisions; not routine progress), the kinds, a useful note,
  `--from`, and the no-install JSON fallback.
- The list folder: `$READING_LIST_DIR` or `~/.local/state/reading-list/`: `items/`, `inbox/`,
  `state.json` (per item `read_at`, `done_at`, `undone_at`, `seen_mtime`, the inbox entries added,
  and `claude_files`: `on`, `since` and per session the latest send handled; written only by the
  mod with `writeTextFile`'s compare-and-swap).
- `mods/readlist/handlers/`: the built-in action handlers, `macos.sh` and `linux.sh` (POSIX `sh`);
  `mods/readlist/bin/run-handler`: checks the person's handler and runs any handler with the item
  as one argument; `core/handlers.js`: the interface, the order handlers are tried in, the
  opt-in record.
- `herdr`: `exec` (`sh -c` scripts and `sh` files with arguments, on Windows `pwsh -File` with
  arguments, with a `timeout`; with `on` for
  other machines), `window` (`platform`: `macos`, `linux` or `windows`; `core/handlers.js` picks
  the built-in handler from it), `hc` (`machine ls`, for `scp`'s target), `machines`, `readTextFile`,
  `writeTextFile`, `watchFolder`, `nextCommand`, `agents`, `spaces`, `panes`, `focused`, `theme`,
  `settings`, `layout`, `props`, `notify` (with an `action`), `appHome`, `run` (`pane.split`,
  `pane.close`, `pane.focus`), `shared`/`setShared` (`readlist.toasted`, `.quiet`, `.unread`,
  `.selected`, `.viewer`, `.pick`, `.keyboard`), `openOverlay`/`closeOverlay`, `localStorage`.
  `gpui-base`: `v_virtual_list`, `Scrollbar`, `TextView.markdown`, `EditorState`/`Editor`,
  `InputState`/`Input`.
- `keys.json`: `"global": {"cmd-shift-i": "mod.open:readlist", "ctrl-shift-i": "mod.open:readlist"}`.
  Merge only your platform's: `cmd-shift-i` on macOS, `ctrl-shift-i` on Linux and Windows (free in
  Herdr's shipped keys there).
- Programs it runs: `sh`, `open`, `qlmanage` (macOS), `xdg-open`, `gdbus` (Linux, both optional), `stat`, `head`, `ls`, `cp`, `mv`, `rm`, `ps`/`kill`, `pgrep`, `grep`, `awk`, `sed`
  (only the Quick Look panel or thumbnail it started), `base64`, `hc`, `scp` and `shasum` (through
  `rl`), `id`, `find`, `readlink`, `sha256sum` or `shasum`, `od` (handlers), and the person's own
  handler once they turn it on; on other machines, through Herdr, `sh`, `cat`, `stat`, `head`, `ls`, `base64`, `dd`, `rm`
  and `cp`/`mv` (installing `rl`). On Windows, here: `pwsh` (its scripts in `bin/windows` and
  `handlers/windows.ps1`), `explorer.exe`, `QuickLook.exe` or `PowerToys.Peek.UI.exe` when
  installed, `hc`, `scp`, and the person's handler once they turn it on. No network beyond Herdr's
  own connections and `scp`.

## Watch out

- `image()` loads only from the app home: images and thumbnails are copied into the mod's hidden
  `.cache/` (one file per item and file version; hidden, so writing there doesn't reload the mod),
  and pruned when items go.
- `qlmanage -p` must run in the background (`& echo $!`) or `exec`'s 30 s limit kills the panel;
  closing it kills only that pid, and only while it is still `qlmanage`.
- Every shown copy gets every `readlist.<command>`; without the "keyboard owner" in shared state,
  `j` would move every copy at once. Commands reach shown copies only.
- Several copies see the same arrival: claim in shared state and toast only what is still yours
  after the burst, or the person gets two toasts.
- Install the mod as a copy, not a symlink (a symlinked mod neither hot-reloads nor writes).
- The `rl` in the mod may lose its execute bit when copied by a tool: the mod runs it with `sh`.
- A copy installed under another folder name must change `core/name.js` and the `readlist` in
  `keys.json` and in commands.
- A handler is run with argv, the item last after `--`; never put item data in a shell string. A
  handler's own `exit 10` means "not handled", so a built-in handler maps a program's status 10 to
  1. Kill a background program by its pid and `wait "$pid" 2>/dev/null` (also for a killed
  watchdog), or the shell's "Terminated" notice becomes the first line of the error.
- The person's handler is trusted only as confirmed: check ownership, permissions, every folder
  above it and the hash right before each run, in the same `sh` that then `exec`s it. Test
  folders under Linux's `/tmp` fail those checks (it is world-writable), as they should.
- Pick commands by `window().platform`, and keep each Linux program optional: check with
  `command -v` and print what to install. Text previews read the first 512 KiB; folders show
  200 entries.
- Windows has no `sh`: every helper there is an operation of `bin/windows/readlist.ps1`, run as
  `pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File SCRIPT OP ARG...`, never
  `-Command` (which joins its arguments into code). `pwsh -File` splits an argument like `-x:1` in
  `$args`, so the scripts read their arguments from `[Environment]::GetCommandLineArgs()` after
  `-File <script>`; a handler's arguments before `--` never start with `-`. Inside PowerShell, a
  literal `--` in a command is the end-of-parameters marker and vanishes: pass it in a splatted
  array. Write stdout as UTF-8 bytes with LF (the console's code page is not UTF-8), and give rl's
  item files LF too. A file name cannot hold `:` (it names an alternate data stream): paths with
  one are refused. Temporary folders may be 8.3 short names (`RUNNER~1`): resolve names with Win32
  matching. Files an elevated program makes are owned by Administrators.
- `xdg-open` may keep running as long as the app it started: run it in the background with its
  output in a file, wait up to 3 s for its exit status, and return; else `exec`'s 30 s limit kills
  the app with it.
- D-Bus arguments for `gdbus call` are GVariant text: pass `['file:///...']` and `'file:///...'`
  with every byte of the path that is not unreserved percent-encoded (a `'` included), so a path
  can never break out of the literal. `FileManager1.ShowItems` takes `(as, s)`; Sushi's
  `NautilusPreviewer2.ShowFile` takes `(s uri, s window handle, b close if shown)`, the older
  `NautilusPreviewer.ShowFile` `(s, i, b)`. An uninstalled service fails at once with
  `ServiceUnknown`.
- `stat -f` on Linux prints file-system data and succeeds: try GNU `stat -c` first, BSD `stat -f`
  after.
- `exec` keeps 8 MiB of output and `hc exec` 8 MB: base64 only up to 5 MiB, chunks above that,
  and check the size of every copy.
- `qlmanage -t` never returns for a file Quick Look has no thumbnail for: stop it after 20 s (by
  its pid), or the preview waits for `exec`'s timeout.
- A poll whose output lacks the final "end" record (cut short) is not a listing: keep the items.
- The review hand-off (`R`) is not built; nothing shows for it.
- Claude Code transcripts grow to tens of MB and `readTextFile` stops at 1 MiB: read them with
  `grep` in a script, never in the mod. A transcript also holds lines that merely mention
  `file_uuid` (a file the agent read, a command's output): only a `user` line whose
  `toolUseResult.attachments` carry a `file_uuid` is a delivered send.
- Writing `state.json` lists the folder again (it is watched): the transcript scan writes only when
  it added something, saw a new session, or a session's record is a day old.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/readlist` passes.
- `rl add <a markdown file> --note hi` in a Herdr terminal shows the item at the top of an open
  list within a second, with a toast "Reading list: <title>" naming the agent, and the unread chip
  goes up by one.
- In a pane wider than 520 the selected markdown item is rendered beside the list; `j` moves the
  selection and the preview follows; Enter opens the file in its app and the item moves under
  "Read".
- `d` moves it to the Done view (Tab), and `d` there brings it back; `rl ls --done` agrees.
- `cmd-shift-i` (`ctrl-shift-i` on Linux and Windows) opens the popup; Esc closes it.
- With no `rl` on PATH the banner shows; Install rl puts `~/.local/bin/rl` in place (mode 755) and
  says so; with a different file already at `~/.local/bin/rl` it leaves it and says so.
- A file copied into `~/.local/state/reading-list/inbox/` appears as an item from "inbox".
- With no handler turned on, Enter, Space and `o` do what the platform table says. A handler at
  `~/.config/herdr-app/readlist/handler` that opens `.md` files and exits 10 otherwise, turned on
  from the `f` menu, opens a markdown item its way and anything else as before; editing the handler
  shows the banner and the built-in action runs until **Use it**; `chmod g+w` on it is refused (on
  Windows: `readlist\handler.ps1`; `icacls handler.ps1 /grant *S-1-5-32-545:(W)` is refused).
- On Windows: `rl add`, `rl ls`, `rl done`, `rl rm` work from PowerShell, cmd.exe and Git Bash,
  and an item file made on macOS lists and is marked done unchanged but for `done_at`; Enter opens
  a PDF in its default app, `o` selects it in Explorer, Enter on a `.exe`, `.ps1` or `.lnk` selects
  it in Explorer instead; Space opens QuickLook or Peek when installed, else the in-pane preview.
- With "Files Claude Code sends" off, a Claude Code agent's SendUserFile adds nothing. Turned on, a
  file the agent sends next appears as a `result` item with the caption as its note, naming that
  agent; sending a file that is already on the list leaves its item as it is.
