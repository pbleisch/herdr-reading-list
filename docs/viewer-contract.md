# Reading list viewer contract (v1)

The browser frontend in `mods/readlist/viewer/shell.html`, `shell.css` and `shell.js` is host independent. It uses no CDN, remote script, Herdr API or browser extension. A host supplies these routes under one unguessable session URL prefix:

| Route | Meaning |
| --- | --- |
| `GET shell`, `shell.css`, `shell.js` | Trusted viewer frontend. |
| `GET state` | JSON `{revision, title, document}`. `document` is a relative URL or `null`. Increment `revision` whenever selection changes. |
| `POST heartbeat`, `POST goodbye` | Viewer presence. The browser host uses it to avoid opening another surface. |
| `GET document/<path>` | The selected HTML document and its allowed local resources. |

The browser host also accepts `POST select` with `{file: absoluteLocalPath}` and `POST close`. These are host control routes, not frontend routes. `close` clears the selection; Space on the same item leaves the browser surface blank and available for reuse. A future Herdr WebView host can load the same `shell` frontend, implement the four frontend routes, set its `document` URL to the WebView's local resource handler, and push selection changes by incrementing `revision`. It must enforce the same resource and document isolation rules. Browser launch, the loopback server, state file and browser heartbeat handling stay outside the frontend.

## Current behavior and later layers

Space on a local HTML item (`.html`, `.htm`, `.xhtml`) opens or updates one local viewer surface. The person's opted-in Space handler retains first choice. The viewer needs Node.js 20 or newer and a browser. The launcher uses a Chrome app window on macOS when installed, an Edge app window on Windows when installed, or a Chromium app window on Linux when installed; otherwise it opens the system browser URL. If launch fails, Space shows the existing native TextView preview. Other file types still use their existing handlers and native preview. Enter continues to reveal executable files and application bundles according to `core/items.js`; opening the viewer neither marks an item read nor changes Enter.

The renderer result for this increment is either `{document: relativeUrl}` or a native fallback. PDF, video, still-image controls and glTF renderers are later layers for the trusted shell. A future `rl preview -- FILE` is a transient request, separate from `rl add`: it should make no list item, read-state change, toast or upload, and should reuse this selection path after validating the local file. It is not a command in this increment. URL and remote CLI requests remain out of scope.

For a remote reading-list item, Space uses the existing local-copy path and its confirmation for large files. Only the selected file is copied today; its sibling CSS, images and fonts are not. Those references show as missing until a bounded asset-copy protocol exists. Local HTML may reference nested local resources under the selected file's real parent directory. The host discovers references in HTML and CSS, follows linked HTML under that directory, caps the manifest at 256 files and 64 MiB total with 16 MiB per file, and serves no other path. Unsupported or missing resources return an error. This intentionally does not support dynamic pages, CDNs or arbitrary JavaScript.

## Safety boundary

The HTTP host binds only `127.0.0.1`, requires a random 256-bit session token on every route, rejects unexpected Host headers, and keeps the token in a user-only session file. Requested files must be in the current reference manifest. Canonical paths and symlinks must stay under the selected document's real parent directory. A new selection replaces the manifest. Responses use `nosniff`, no-store and a no-referrer policy.

The selected document is untrusted. It loads inside `<iframe sandbox="">`, which gives it an opaque origin and no scripts, forms, popups or top-level navigation. Its CSP disallows scripts, network fetches, frames and objects while allowing local CSS, images and fonts. External resources cannot load during rendering. The trusted shell has a separate CSP and never inserts item text as HTML. A clicked link may navigate within the sandboxed frame; linked local HTML is available only if referenced in the manifest. Browser support for CSP navigation directives varies, so external link clicks should not be treated as a secure offline browsing mode. Only preview documents from sources you trust to *view* in your browser. The host is intended to protect the viewer shell and local files from a hostile document, not to make a malicious browser engine safe.

## Acceptance corpus

| Case | macOS | Linux | Windows |
| --- | --- | --- | --- |
| CSS, local PNG/SVG, WOFF/WOFF2, nested relative paths | HTTP and browser rendering | HTTP and browser rendering | HTTP and browser rendering |
| Relative linked HTML and missing resource | Link stays in confined document area; missing resource is reported | Same | Same |
| `..`, encoded traversal, absolute path, external URL and escaping symlink | No resource outside selected parent served | Same | Same |
| Scripts, network requests, forms and top navigation | Inert by sandbox/CSP | Same | Same |
| No Node or browser | Native TextView fallback | Same | Same |
| Repeated Space and a different HTML selection | One reused viewer surface | Same | Same |

The Node HTTP tests exercise the resource policy on macOS. Browser rendering, Linux and Windows launch paths need platform checks; their launch commands are implemented but were not exercised here. The in-pane preview and Enter rule are covered by the existing tests.
