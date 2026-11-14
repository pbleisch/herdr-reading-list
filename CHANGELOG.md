# Changelog

What changed for people who use the reading list. The version is the `version` in `package.json`.

## 0.2.0

A built-in viewer, folder browsing and a preview command. Everything that was there before works
as it did when Node.js or a browser is missing.

### Added

- **Built-in viewer on Space.** Space on a Markdown, HTML, PDF, video, image or glTF item now
  opens it in one reusable browser window instead of the platform's preview window. It needs
  Node.js 20 or newer and a browser; without them Space shows the preview in the pane.
  - Markdown: headings, lists, tables, task lists, links, images and code blocks; raw HTML is shown
    as text.
  - HTML: the page with its local stylesheets, images and fonts; scripts and network requests are
    off.
  - PDF: page navigation, zoom, search across pages, selectable text and copy.
  - Video (`.mp4`, `.m4v`, `.webm`, `.mov`): the browser's player with seeking, and Open in default
    app when the browser cannot decode it.
  - Images: fit, actual size, zoom, pan and rotate.
  - glTF models (`.glb`, `.gltf`): orbit, pan, zoom and Reset view.
- **Space preview setting.** In the `f` menu, **Space preview** chooses between **Built-in viewer**
  (the default) and **System preview** (Quick Look, GNOME Sushi, QuickLook or PowerToys Peek). It
  is stored as `"readlist": {"space_preview": "builtin" | "system"}` in Herdr's `settings.json`
  and applies from the next Space press, in every copy of the list.
- **Local HTML drawn in the pane.** The preview beside the list shows a local HTML file as the
  styled page (image tiles made by a headless Chrome, Chromium or Edge) instead of bare text. Tiles
  appear as they finish, follow the pane's width and the theme, and scroll with the wheel and the
  keys. A click on a link to another local page opens it in the pane; **Back**, Backspace or
  Alt-Left returns. Without a browser the text preview stays, with a note saying why.
- **Folder browsing.** Enter on a folder item lists its contents in the reading list. Enter or
  Right enters a subfolder, Left or Backspace goes up, `.` or **Show hidden** shows hidden entries.
  Entries preview, open, filter and mark read or done like items. Browsing stays inside the
  item's folder and does not follow symlinks.
- **`rl preview [--pane|--browser] -- PATH`.** Shows a local file in a Reading list preview pane,
  or in the built-in viewer, without adding it to the list. Other mods can call it.
- **Image controls in the pane.** Fit, zoom and keyboard pan for images; a rendered poster for
  local glTF models.
- **Video and 3D models as types.** They have their own entries in the `f` menu's Type filter.
- **More code previews.** Many more file types get an in-pane code preview (see the table in the
  README), as do `Makefile`, `Dockerfile`, `.env` files and extensionless scripts with a `#!` line.

### Changed

- Text and code in the `v` pane are syntax highlighted, like the preview beside the list. They
  scroll with the wheel or the trackpad; the pane's scroll keys still move markdown, HTML and
  search results.
- Space on a folder no longer opens a preview window; it says to browse the folder with Enter.

### Fixed

- The `f` filter menu no longer collapses to a thin strip: it takes the height of its rows.

### Good to know

- The built-in viewer runs a small web server on `127.0.0.1` only, with a random token in every
  address, and serves only the previewed file and the local files it refers to. See
  [docs/viewer-contract.md](docs/viewer-contract.md) and the README's Install section for what the
  mod runs and writes.
- The mod now bundles Marked, PDF.js and Three.js (their licences are under
  `mods/readlist/viewer/`). Nothing is loaded from the network.

## 0.1.0

The first public version: the list in a pane, the sidebar or a popup; `rl add`, `ls`, `done` and
`rm`; in-pane previews; the `v` viewer pane with scrolling and search; filters; arrival toasts; the
`inbox/` drop folder; other machines' lists; files Claude Code sends; your own action handler;
macOS, Linux and Windows.
