# herdr-reading-list

A reading list for [Herdr](https://herdr.dev). Your agents and tools put files (markdown they
wrote, screenshots, HTML reports, PDFs, folders) or URLs on the list with one command, `rl add`,
and a note saying why. The list shows who added each item, previews it in place, and opens it in its
macOS app when you press Enter.

![Reading list](preview.png)

**macOS only.** Opening, Quick Look, thumbnails and "show in Finder" use macOS tools (`open`,
`qlmanage`).

## Install

Ask your Herdr agent:

> add herdr.dev/mods/pbleisch/herdr-reading-list

It reads [RECIPE.md](RECIPE.md) and the files, copies `mods/readlist` into your Herdr home
(`~/.config/herdr-app/mods/readlist`), merges `keys.json` into yours where the key is free, and
checks the mod. To do it by hand, copy the `mods/readlist` folder there yourself, add the key in
`keys.json` to your own `keys.json`, and run `herdr-app check ~/.config/herdr-app/mods/readlist`.

What the mod does on your Mac: it runs programs (`sh` scripts, `open`, `qlmanage` for Quick Look
and thumbnails, and its own `rl`), reads the files on the list wherever they are, and writes only
its list folder, its own `.cache/` and, when you press Install rl, `~/.local/bin/rl`. It does not
use the network (a URL item opens in your browser).

Then open it:

- `cmd-shift-i` opens the list as a popup over the window (`mod.open:readlist`);
- `herdr-app do pane.split '{"direction":"right","mod":"readlist"}'` opens it as a pane;
- or add a block with `{"mod": "readlist", "props": {"role": "sidebar"}}` to your layout, for
  example under the agents list in the left sidebar.

### Install rl

`rl` is the command agents use to add items. It ships inside the mod (`mods/readlist/bin/rl`, POSIX
`sh`, no dependencies). While it is not on your PATH, the list shows a banner with an **Install rl**
button (also `herdr-app do readlist.install-rl`): it copies `rl` to `~/.local/bin/rl`, tells you if
`~/.local/bin` is not on your PATH, and never replaces a different program called `rl`. "Not now"
hides the banner.

Agents without `rl` can still add items by writing a small JSON file; see
[skill/reading-list/SKILL.md](skill/reading-list/SKILL.md).

### Teach your agents

[skill/reading-list/SKILL.md](skill/reading-list/SKILL.md) is a skill for coding agents: when to
add something (only what you should read), the `rl` commands, and the no-install fallback. Copy the
`skill/reading-list` folder into your agent's skills folder (for Claude Code,
`~/.claude/skills/reading-list`), or paste its text into your agent instructions.

## Use

```sh
rl add docs/plan.md --note "Revised rollout plan; section 3 changed"   # prints the item id
rl add https://example.com/report --kind fyi     # fyi: no toast
rl ls                 # open items; --unread, --done, --all, --json
rl done docs/plan.md  # you have handled it
rl rm docs/plan.md    # take it off the list
```

The list lives in `~/.local/state/reading-list/` (`$READING_LIST_DIR` overrides it): one JSON file
per item in `items/`, and your read and done state in `state.json`. Adding the same path again
replaces the item (new note, unread again, moved to the top). Inside a Herdr terminal, `rl` records
which agent added the item; elsewhere `--from NAME`, or your user name and the calling program.

Anything put in the list folder's `inbox/` (a screenshot tool's output folder, a browser
download) becomes an item from "inbox"; dropping files onto the list adds them too.

New items post a toast ("Reading list: plan.md", or "3 new on your reading list" for a burst); `fyi`
items and files you dropped do not. Clicking the toast focuses the list or opens the popup.

### Keys

In the list:

| Key | Does |
|---|---|
| click, `j` / `k`, arrows, `g` / `G` | select (selecting never opens anything) |
| Enter, double-click | open in its app; marks it read |
| Space | Quick Look panel (again closes it) |
| `p` | show or hide the preview in the pane |
| `v` | a preview pane on the right of the window that follows the selection |
| `o` | show in Finder |
| `c` | copy the path or URL |
| `r` | read / unread |
| `d` | done (Tab shows the Done view, where `d` or `u` brings it back) |
| Shift-D | delete the item from the list (like `rl rm`; the file stays) |
| `/` | filter by title, note and path |
| `f` | filter menu: space, agent, type, unread only |

Each key is also a command (`herdr-app do readlist.open`, `readlist.down`, ...) you can bind in
`keys.json`. Global: `cmd-shift-i` opens the popup.

In a pane 520 px or wider, the selected item's preview shows beside the list: markdown rendered,
text and code highlighted, images, a Quick Look thumbnail of HTML, PDF and anything else Quick Look
can draw, a folder's entries. Narrower, `p` shows it below the list. A read item whose file changed
since shows a "changed" chip. Executable items (apps, scripts) are shown in Finder, never opened.

## Uninstall

```sh
rm -rf ~/.config/herdr-app/mods/readlist
```

Then remove the `cmd-shift-i` line from your `~/.config/herdr-app/keys.json` and any `readlist`
block from your layouts. If you installed `rl`, delete `~/.local/bin/rl`. Your list stays in
`~/.local/state/reading-list/` until you delete that folder too.

## Develop

```sh
npm test          # node tests for mods/readlist/core and the scripts; rl under sh and dash
bin/install-dev   # copy the mod into Herdr, merge keys, link rl, add the list to a cloned layout
```

`bin/install-dev` copies `mods/readlist` to `~/.config/herdr-app/mods/readlist` (a copy: a
symlinked mod neither hot-reloads nor writes) and checks it, merges `keys.json` where keys are free
(`bin/merge-keys.mjs`), links `~/.local/bin/rl` to the checkout's `mods/readlist/bin/rl`, and
(optional) clones the shown layout as `<name>-readlist` with the list under Agents in the left
sidebar (`layout/add-to-sidebar.mjs`) and switches to it; `ctrl-shift-l` switches back.
`--no-layout` skips the layout step, `--no-link` the link. `bin/rl` is a link to the mod's `rl`.

[docs/design.md](docs/design.md) has the design. MIT licence; the icons are
[Lucide](https://lucide.dev) (ISC, see `mods/readlist/icons/LICENSE`).
