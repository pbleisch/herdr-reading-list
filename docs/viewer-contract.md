# Reading list viewer contract (v4)

The browser frontend in `mods/readlist/viewer/shell.html`, `shell.css` and `shell.js` is host independent. It uses no CDN, remote script, Herdr API or browser extension. A host supplies these routes under one unguessable session URL prefix:

| Route | Meaning |
| --- | --- |
| `GET shell`, `shell.css`, `shell.js` | Trusted viewer frontend. |
| `GET state` | JSON `{revision, title, kind, document, superseded}`. `kind` is `markdown`, `html`, `pdf`, `video`, `image`, `gltf` or `null`; `document` is a relative URL or `null`. Increment `revision` whenever selection changes. `superseded` is true when the page asking (`?client=`) is not the newest viewer page. |
| `GET version` | JSON `{build, pid}`. The launcher compares this with the installed viewer build and the private session file before reusing a host. |
| `POST heartbeat`, `POST goodbye` | Viewer presence. The browser host uses it to avoid opening another surface and, on macOS, to return focus when the viewer window closes. |
| `GET pages`, `pages.js` | Trusted view of the selected PDF's pages stacked at the window's width, for the tile renderer. |
| `GET/HEAD document/<path>` | The selected file. Markdown is returned as rendered HTML; Markdown, HTML and `.gltf` also expose their allowed local resources. The shell checks document availability with HEAD before loading it in the frame, and shows an error if rendering fails. PDF, video, images and glTF support byte-range requests. |
| `GET pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` | Bundled PDF.js runtime, served by the browser host. A future host may map these URLs to its own local asset handler. |
| `GET three/three.min.js`, `gltf-view.js`, `image-controls.js` | Bundled Three.js module and trusted viewer controls. No CDN or network runtime is used. |
| `GET poster` | Optional JPEG derived from the selected video if FFmpeg is installed. Missing FFmpeg or a failed extraction returns 404. |
| `POST open-default` | Opens the selected video in its default application. The request carries no path. |

Each frontend page names itself with a random `client` query parameter on `state`, `heartbeat` and
`goodbye`. The page whose first request came last is the viewer; an older page sees `superseded`,
clears itself and calls `window.close()` (its frame changes pages with `location.replace`, so its
history holds one entry and the browser lets it close). A superseded page's `goodbye` is ignored.

The browser host also accepts `POST select` with `{file: absoluteLocalPath, returnTo?, raise?}`, `POST surface` with `{bundle}` and `POST close`, which answers `{open}`: whether a viewer page was showing the selection (it spoke in the last 10 s). Space again on the viewer's item clears it only then; after the person closed the window, the same Space opens it again.
`returnTo` is the pid of the app the selection came from and `raise: true` asks for a new window
even when a viewer page is alive (on macOS with Chrome, every open: a window behind others cannot
bring itself forward). `surface` records the bundle id of the app window the launcher opened
(`com.google.Chrome`), or null for the system browser. On macOS, when the viewer page says
`goodbye` and no page says hello within 600 ms (a reload), the host asks macOS for the active app
and, only if it is still that browser, activates `returnTo` (`osascript -l JavaScript`,
`NSRunningApplication.activateWithOptions`, no Apple Events). These are host control routes, not frontend routes. `close` clears the selection; Space on the same item leaves the browser surface blank and available for reuse. A future Herdr WebView host can load the same `shell` frontend, implement these routes, set its `document` URL to the WebView's local resource handler, and push selection changes by incrementing `revision`. It must enforce the same resource and document isolation rules. Browser launch, the loopback server, state file and browser heartbeat handling stay outside the frontend.

## Current behavior and later layers

### The built-in preview

Space on a local file opens the mod as a Herdr overlay window (`openOverlay({kind: "window", key:
"readlist-preview"})`, props `{role: "window", file, title}`); `v` shows the same preview docked
and `rl preview` as a pane. Markdown, HTML and PDF are drawn as tiles by `render.mjs`, with the
same host, manifest and document CSP as below; Markdown goes through the host's rendered-Markdown
document route, and PDF through the trusted `pages` view, which lays out every page (at most 100)
and draws page canvases only around the tile being captured. Images use the mod's image renderer,
a local video an FFmpeg frame (`video-poster.mjs`), glTF a still (`render-model.mjs`). The window
takes the keyboard; Space calls `host.mjs open` (the browser surface) and closes the window. Its
width (70 % of Herdr's within 640-1280 px, or the one last chosen with `[` / `]`) sets the tile
width, so a resize draws the page again at the new width. Without tiles, it shows the text (none
for PDF).

### Page tiles

The built-in preview renders a local HTML selection with the same `manifestFor`
allowlist and `createHost` document route as the browser viewer. A separate headless installed
Chrome, Chromium or Edge captures 512 CSS-pixel-high PNG tiles at the pane width and 2× scale.
The renderer uses the document CSP from this host, which disables scripts and network resources;
the pane displays screenshots and never runs document code. It reports the layout and links first,
then atomically updates a progress file after each completed tile. The mod polls that file and
shows ready tiles without waiting for the final one, with placeholders for missing tiles. The
visible tiles are captured first, beginning at the current scroll position. A width change is debounced and a theme change requests a
new render. The theme is derived from `theme().background`.

The tile cache is under `appHome()/readlist-tile-cache/render`, outside the watched `mods/` tree.
Its key hashes the selected path, selected HTML and every allowed local asset's bytes, width,
scale and appearance. Successful uses update entry recency; the renderer evicts the least recently
used entries above 256 MiB. A single render exceeding that limit fails back to the text preview.
The mod shows only visible tiles. A captured link can open another allowed local HTML page in the
same pane; fragment links scroll within the page. Back or Backspace returns to the previous page.
Remote items retain the existing text preview and local-copy rules. When the browser binary or
rendering is unavailable, a brief note accompanies the existing HTML TextView preview. The tiles
are images; Space in the built-in preview opens the selectable, searchable browser viewer.

By default, Space on a local file opens the built-in preview above. Space there on a local Markdown (`.md`, `.markdown`, `.mdown`, `.mkd`), HTML (`.html`, `.htm`, `.xhtml`), PDF (`.pdf`), video (`.mp4`, `.m4v`, `.webm`, `.mov`), glTF (`.glb`, `.gltf`) or browser image (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif`, `.heic`, `.heif`, `.bmp`) opens or updates one local viewer surface. In the list's `f` menu, **Space preview → System preview** routes these types to the platform handler instead (Quick Look, GNOME Sushi, QuickLook or PowerToys Peek). Herdr stores the choice at `readlist.space_preview` in its live `settings.json`; `builtin` is the default and `system` selects the platform. Each Space press reads that value, so edits apply without a restart and every copy uses the same choice. TIFF and PSD always retain the platform handler. The person's opted-in Space handler retains first choice. The viewer needs Node.js 20 or newer and a browser. The launcher uses a Chrome app window on macOS when installed, an Edge app window on Windows when installed, or a Chromium app window on Linux when installed; otherwise it opens the system browser URL. If launch fails, the built-in preview says why and stays open. With System preview, a platform handler that passes falls back to the built-in preview window. Enter continues to reveal executable files and application bundles according to `core/items.js`; opening the viewer neither marks an item read nor changes Enter.

Markdown is rendered by locally bundled Marked with GFM headings, lists, tables, task lists, links, images and fenced code blocks. Raw HTML is escaped and shown as text. Code blocks retain their language class but do not use a separate syntax-highlighting runtime. The output loads in the same scriptless, sandboxed frame as HTML. Relative links and images are included only when the resolved real file stays below the selected Markdown file's real parent folder and fits the document manifest limits. Linked Markdown pages are rendered by the same route. Remote URLs, data URLs, missing files and path escapes are rendered without active links or images. `rl preview --browser` uses this route too; its native `--pane` preview remains available when the browser viewer cannot open.

The PDF renderer uses a local PDF.js worker and canvas, with page navigation, zoom, text search across pages, selectable text and a copy button. PDF JavaScript evaluation and XFA are disabled. The video renderer uses the browser's native controls; the host streams byte ranges for seeking. If decoding fails, the shell offers Open in default app and requests an optional FFmpeg poster. FFmpeg is never needed to play a supported video. The image renderer offers fit, actual size, bounded zoom by buttons, wheel, keys or pinch, pan by drag or arrows, and quarter-turn rotation. Browser decoding determines which HEIC/HEIF images work. SVG is loaded only as an inert `<img>`. The glTF renderer uses locally bundled Three.js, with orbit, pan, zoom, reset, animation playback and a generated room environment for PBR lighting. It reports unavailable WebGL and model load errors.

### Transient previews from other mods

`rl preview [--pane|--browser] -- FILE` accepts one existing local file. Both
launchers canonicalize it, including the final symlink, before passing it on.
They refuse URLs, folders and remote machine requests. No item is written and
no read state, toast or remote copy is made. The default `--pane` calls
`herdr-app do pane.split` with one JSON argument:

```json
{"direction":"right","mod":"readlist","props":{"role":"preview","file":"/absolute/local/file.pdf"}}
```

The preview role makes a transient item only in memory and shows it with the
built-in preview: page tiles, images, video frames, model stills, text and the
other formats. It does not subscribe to list arrivals
or take list keyboard commands. A live preview pane owns a shared file request;
when another split arrives, the new pane passes its file to the old one and
closes, retaining one preview pane. Its header names the file and offers the
preview's buttons (Enter, Space for the browser viewer, `q`, `o`) and Close. Space uses the same installed
`viewer/host.mjs open` path as a list item, including the allowlist and reused
browser session. `--browser` calls that host directly, so it needs Node.js and
a browser but no open Herdr window.

The CLI returns 0 when the handoff succeeds, 1 when the file, viewer or Herdr
window is unavailable or the target is refused, and 2 for syntax errors.
Pane handoff success does not guarantee that the asynchronous native renderer
can draw every format; the pane displays its result. A mod calls
`exec("rl", ["preview", "--", path])`, using separated arguments on macOS and
Linux; Windows uses the installed PowerShell launcher (`rl.ps1` or `rl.cmd`)
with the same argument boundary. The path must never be interpolated into a
shell command.

The pane retains its `image()` path with Fit, zoom and keyboard pan. For local glTF it asks the existing headless browser capture path for one poster at 2× scale, cached by the model and allowed asset bytes under `appHome()/readlist-model-cache`; the browser viewer supplies interaction. The angle ring was deferred because each angle requires another WebGL capture and cache entry. A missing headless browser or WebGL context leaves a clear poster fallback. Remote `.gltf` items use their native thumbnail path because the local copy lacks sibling assets; a remote `.glb` can use the browser viewer as a single self-contained file.

The bundled runtimes are Marked 18.2.0, MIT, under `mods/readlist/viewer/marked`; Mozilla PDF.js (`pdfjs-dist` 4.10.38), Apache-2.0, under `mods/readlist/viewer/pdfjs`; and Three.js 0.187.0, MIT, under `mods/readlist/viewer/three`. PDF.js and Marked are the packages' own builds (`pdf.min.mjs`, `pdf.worker.min.mjs`, `marked.esm.js`). Three.js publishes no minified module, so `three/three.min.js` is a minified esbuild bundle of only what `gltf-view.js` uses from the core, GLTFLoader, OrbitControls and RoomEnvironment. `mods/readlist/viewer/VENDORED.md` lists each file's source, checksum and the commands that reproduce it. The viewer loads no CDN or remote script.

For a remote reading-list item, Space uses the existing local-copy path and its confirmation for large files. Only the selected file is copied today; its sibling CSS, images, fonts, Markdown pages or glTF assets are not. Those references show as missing until a bounded asset-copy protocol exists. Local HTML and Markdown may reference nested local resources under the selected file's real parent directory. The host discovers references in HTML, CSS and Markdown, follows linked documents under that directory, caps the manifest at 256 files and 64 MiB total with 16 MiB per file, and serves no other path. For `.gltf`, it parses the declared buffer and image URIs. Data URIs are self-contained; local `.bin`, PNG, JPEG, WebP and AVIF references are allowed only below the selected file's real parent directory, with the same file and total caps. External URLs, path escapes, escaping symlinks, missing assets and unsupported asset extensions reject glTF selection. Markdown instead renders refused references inert. `.glb`, image, PDF and video selections expose only the selected file. Unsupported or missing resources return an error. HTML intentionally does not support dynamic pages, CDNs or arbitrary JavaScript.

## Safety boundary

The HTTP host binds only `127.0.0.1`, requires a random 256-bit session token on every route, rejects unexpected Host headers, and keeps the token in a user-only session file. Requested files must be in the current reference manifest. Canonical paths and symlinks must stay under the selected document's real parent directory. A new selection replaces the manifest. Responses use `nosniff`, no-store and a no-referrer policy.

The session file records a hash of the host, shell, image/model controls and bundled PDF.js and Three.js files. When the installed build differs from a running host, the launcher verifies the recorded PID's command before stopping it and starts the installed host. A failed restart reports the host's error in the mod and leaves the native in-pane preview available.

The selected HTML or rendered Markdown document is untrusted. It loads inside `<iframe sandbox="">`, which gives it an opaque origin and no scripts, forms, popups or top-level navigation. Its CSP disallows scripts, network fetches, frames and objects while allowing local CSS, images and fonts. External resources cannot load during rendering. PDF.js runs only as trusted bundled code, with PDF evaluation and XFA disabled; a PDF is passed as data, never embedded as an active browser document. The trusted shell has a separate CSP and never inserts item text as HTML. A clicked HTML link may navigate within the sandboxed frame; linked local HTML is available only if referenced in the manifest. Browser support for CSP navigation directives varies, so external link clicks should not be treated as a secure offline browsing mode. Only preview documents from sources you trust to *view* in your browser. The host is intended to protect the viewer shell and local files from a hostile document, not to make a malicious browser engine safe.

## Acceptance corpus

| Case | macOS | Linux | Windows |
| --- | --- | --- | --- |
| CSS, local PNG/SVG, WOFF/WOFF2, nested relative paths | HTTP and browser rendering | HTTP and browser rendering | HTTP and browser rendering |
| Relative linked HTML and missing resource | Link stays in confined document area; missing resource is reported | Same | Same |
| `..`, encoded traversal, absolute path, external URL and escaping symlink | No resource outside selected parent served | Same | Same |
| Scripts, network requests, forms and top navigation | Inert by sandbox/CSP | Same | Same |
| Markdown headings, tables, task lists, local images and links | Rendered inside the sandboxed frame; only manifest files load | Same | Same |
| Markdown raw HTML, remote resources and escaping references | Raw HTML escaped; remote and escaping references inert | Same | Same |
| No Node or browser | Native TextView fallback | Same | Same |
| Repeated open and a different HTML selection | One viewer window: a new one in front, the old one closes | One reused viewer surface | One reused viewer surface |
| Viewer window or Quick Look closes while it is the active app | Herdr is active again; not after a switch elsewhere | Not handled | Not handled |
| Space on a file | Herdr preview window (tiles, image, video frame, model still, text); Space there opens the viewer | Same | Same |
| PDF pages, zoom, find and copy | Bundled PDF.js in reused surface | Same | Same |
| Video seek and unsupported codec | Byte ranges; native controls or default-app fallback | Same | Same |
| Browser still image and inert SVG | Fit, actual size, zoom, pan, rotate; SVG cannot run scripts | Same | Same |
| `.glb`, `.gltf` and confined assets | Orbit, pan, zoom, reset; undeclared or escaping assets unavailable | Same | Same |
| No WebGL or headless browser | Clear model viewer or poster fallback | Same | Same |

The Node HTTP tests exercise the resource policy, type routing, byte ranges and image control state on macOS. A local headless Chrome run captured `.glb` and `.gltf` posters, including a locally referenced buffer. Linux and Windows launch paths need platform checks; their launch commands are implemented but were not exercised here. The in-pane preview and Enter rule are covered by the existing tests.
