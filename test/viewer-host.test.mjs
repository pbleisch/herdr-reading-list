import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHost, gltfManifestFor } from "../mods/readlist/viewer/host.mjs";
import { browserViewerType, spacePreviewRoute, viewerFailureNotice } from "../mods/readlist/core/browser-viewer.js";
import { folderItems } from "../mods/readlist/core/folder.js";
import { typeOf } from "../mods/readlist/core/items.js";
import { fitScale, clampZoom, rotateQuarter, installImageControls } from "../mods/readlist/viewer/image-controls.js";

const runFile = promisify(execFile);
const hostScript = fileURLToPath(new URL("../mods/readlist/viewer/host.mjs", import.meta.url));
const rlScript = fileURLToPath(new URL("../mods/readlist/bin/rl", import.meta.url));

test("rl preview --browser opens Markdown through the installed viewer", { skip: process.platform === "win32" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-markdown-cli-"));
  const app = path.join(dir, "app");
  const viewer = path.join(app, "mods/readlist/viewer");
  const file = path.join(dir, "reading notes.md");
  await fs.mkdir(path.dirname(viewer), { recursive: true });
  await fs.cp(path.dirname(hostScript), viewer, { recursive: true });
  await fs.writeFile(file, "# Notes\n\n- [x] read\n");
  let pid;
  t.after(async () => {
    if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ } }
    await fs.rm(dir, { recursive: true, force: true });
  });
  await runFile("sh", [rlScript, "preview", "--browser", "--", file], {
    env: { ...process.env, HERDR_APP_HOME: app, READLIST_VIEWER_NO_BROWSER: "1" }, timeout: 15000,
  });
  const session = JSON.parse(await fs.readFile(path.join(app, "readlist/viewer/session.json"), "utf8"));
  pid = session.pid;
  const base = `http://127.0.0.1:${session.port}/${session.token}/`;
  assert.equal((await (await fetch(base + "state")).json()).kind, "markdown");
  assert.match(await (await fetch(base + "document/reading%20notes.md")).text(), /<h1 id="notes">Notes<\/h1>/);
});

test("open replaces a recorded host from an older build before selecting PDF", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-viewer-restart-"));
  const sessionDir = path.join(dir, "session");
  const sessionFile = path.join(sessionDir, "session.json");
  const html = path.join(dir, "old.html");
  const pdf = path.join(dir, "new.pdf");
  await fs.writeFile(html, "<p>old</p>");
  await fs.writeFile(pdf, "%PDF-1.7\n");
  const started = new Set();
  t.after(async () => {
    for (const pid of started) { try { process.kill(pid, "SIGTERM"); } catch { /* already stopped */ } }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const open = (file) => runFile(process.execPath, [hostScript, "open", sessionDir, file],
    { env: { ...process.env, READLIST_VIEWER_NO_BROWSER: "1" }, timeout: 15000 });
  assert.equal((await open(html)).stdout, "viewer\n");
  const old = JSON.parse(await fs.readFile(sessionFile, "utf8"));
  started.add(old.pid);
  const oldBase = `http://127.0.0.1:${old.port}/${old.token}/`;
  const version = await (await fetch(oldBase + "version")).json();
  assert.equal(version.build, old.build);
  assert.equal(version.pid, old.pid);
  delete old.build; // An earlier host's session has no build field.
  await fs.writeFile(sessionFile, JSON.stringify(old));

  assert.equal((await open(pdf)).stdout, "viewer\n");
  const fresh = JSON.parse(await fs.readFile(sessionFile, "utf8"));
  started.delete(old.pid);
  started.add(fresh.pid);
  assert.notEqual(fresh.pid, old.pid);
  assert.equal(fresh.build, version.build);
  const freshBase = `http://127.0.0.1:${fresh.port}/${fresh.token}/`;
  assert.equal((await (await fetch(freshBase + "state")).json()).kind, "pdf");
  assert.equal((await (await fetch(freshBase + "version")).json()).pid, fresh.pid);
});

test("viewer command failures retain the host's explanation", () => {
  assert.equal(viewerFailureNotice({ code: 1, stderr: "readlist: Viewer host did not start\n" }),
    "Couldn't open browser viewer: Viewer host did not start. Preview is shown in the pane.");
  assert.equal(viewerFailureNotice({ code: 1, stderr: "" }), null);
});

test("open refuses to stop a PID that is not the recorded viewer host", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-viewer-verify-"));
  const token = "a".repeat(64);
  const server = createServer((_req, res) => { res.writeHead(200); res.end("ok"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, "session.json"), JSON.stringify({ port: server.address().port, token, pid: process.pid }));
  const pdf = path.join(dir, "sample.pdf");
  await fs.writeFile(pdf, "%PDF-1.7\n");
  await assert.rejects(runFile(process.execPath, [hostScript, "open", dir, pdf], { timeout: 15000 }),
    /recorded process cannot be verified for restart/);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/${token}/health`)).status, 200);
});

test("HTML viewer serves referenced local resources and confines every request", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-viewer-test-"));
  const root = path.join(dir, "site");
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "index.html"), `<!doctype html><title>Test</title><link rel="stylesheet" href="assets/site.css"><img src="assets/picture.png"><a href="page.html">Next</a><img src="missing.png"><script src="assets/evil.js"></script>`);
  await fs.writeFile(path.join(root, "page.html"), "<p>Linked page</p>");
  await fs.writeFile(path.join(root, "assets", "site.css"), '@font-face { font-family: demo; src: url("demo.woff2") } body { background: url(picture.png) }');
  await fs.writeFile(path.join(root, "assets", "picture.png"), Buffer.from([137, 80, 78, 71]));
  await fs.writeFile(path.join(root, "assets", "demo.woff2"), Buffer.from([119, 79, 70, 50]));
  await fs.writeFile(path.join(root, "assets", "evil.js"), "alert(1)");
  await fs.writeFile(path.join(root, "private.html"), "private, unreferenced");
  await fs.writeFile(path.join(dir, "outside.png"), "outside");
  if (process.platform !== "win32") await fs.symlink(path.join(dir, "outside.png"), path.join(root, "assets", "escape.png"));
  await fs.appendFile(path.join(root, "index.html"), '<img src="assets/escape.png"><img src="../outside.png">');

  const host = await createHost();
  t.after(async () => {
    await new Promise((resolve) => host.server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const get = (route) => fetch(host.base + route);
  const select = await fetch(host.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: path.join(root, "index.html") }) });
  assert.equal(select.status, 200);
  const state = await (await get("state")).json();
  assert.equal(state.document, "document/index.html");
  assert.equal(state.kind, "html");

  for (const name of ["index.html", "page.html", "assets/site.css", "assets/picture.png", "assets/demo.woff2"]) {
    assert.equal((await get(`document/${name}`)).status, 200, name);
  }
  const doc = await get("document/index.html");
  assert.match(doc.headers.get("content-security-policy"), /script-src 'none'/);
  assert.equal(doc.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await get("shell")).status, 200);
  assert.equal((await get("shell.css")).status, 200);
  assert.equal((await get("shell.js")).status, 200);
  for (const name of ["private.html", "missing.png", "assets/evil.js", "assets/escape.png", "../outside.png", "%2e%2e/outside.png", "%2foutside.png", "assets/%5cescape.png"]) {
    assert.notEqual((await get(`document/${name}`)).status, 200, name);
  }
  const wrongHost = await new Promise((resolve, reject) => {
    const req = request(host.base + "document/index.html", { headers: { Host: "other.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.once("error", reject);
    req.end();
  });
  assert.equal(wrongHost, 403);
  assert.notEqual((await fetch(`http://127.0.0.1:${host.port}/wrong/document/index.html`)).status, 200);

  await fetch(host.base + "close", { method: "POST" });
  assert.equal((await get("document/index.html")).status, 404);
});

test("Markdown viewer renders GFM while confining links, images and raw HTML", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-markdown-test-"));
  const root = path.join(dir, "docs");
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "guide.md"), [
    "# Guide", "", "- [x] ready", "", "| Key | Value |", "| --- | --- |", "| a | b |", "",
    "```js", "const answer = 42;", "```", "", "[Next](next.markdown#details)",
    "![Diagram](assets/picture.png)", "![Remote](https://example.invalid/evil.png)",
    "[Outside](../outside.md) [Remote](https://example.invalid/)",
    "<script>alert('bad')</script>", '<img src="https://example.invalid/evil.png">',
  ].join("\n"));
  await fs.writeFile(path.join(root, "next.markdown"), "# Details\n\n[Guide](guide.md#guide)\n");
  await fs.writeFile(path.join(root, "assets/picture.png"), "picture");
  await fs.writeFile(path.join(root, "secret.md"), "not linked");
  await fs.writeFile(path.join(dir, "outside.md"), "outside");
  if (process.platform !== "win32") await fs.symlink(path.join(dir, "outside.md"), path.join(root, "escape.md"));
  await fs.appendFile(path.join(root, "guide.md"), "\n[Escape](escape.md)\n");
  const host = await createHost();
  t.after(async () => {
    await new Promise((resolve) => host.server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const get = (route) => fetch(host.base + route);
  const select = await fetch(host.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: path.join(root, "guide.md") }) });
  assert.equal(select.status, 200);
  assert.equal((await (await get("state")).json()).kind, "markdown");
  const response = await get("document/guide.md");
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(response.headers.get("content-security-policy"), /script-src 'none'/);
  const html = await response.text();
  for (const pattern of [/<h1 id="guide">Guide<\/h1>/, /type="checkbox"/, /<table>/, /<pre><code class="language-js">const answer = 42;/,
    /href="next.markdown#details"/, /src="assets\/picture.png"/, /&lt;script&gt;/, /&lt;img src=/]) assert.match(html, pattern);
  assert.doesNotMatch(html, /<script>|<img src="https:|href="https:|href="\.\.\/outside|href="escape.md"/);
  assert.equal((await get("document/next.markdown")).status, 200);
  assert.equal((await get("document/assets/picture.png")).status, 200);
  for (const name of ["secret.md", "escape.md", "../outside.md", "%2e%2e/outside.md", "assets/missing.png"]) {
    assert.notEqual((await get(`document/${name}`)).status, 200, name);
  }
  await fetch(host.base + "close", { method: "POST" });
  assert.equal((await get("document/guide.md")).status, 404);
});

test("a long Markdown report paints its canvas in the sandboxed frame and reports a failed load", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-markdown-report-"));
  const file = path.join(dir, "M3 verification.md");
  const line = '| `C:\\UE\\UE_5.4.4\\Engine\\Build\\BatchFiles\\Build.bat` | `gh-axi api /repos/EpicGames/UnrealEngine/git/ref/tags/5.4.4-release` | Pinned candidate replay completed with a long row of results. |';
  const report = ["# M3 engine verification on wpc", "", "| File | Command | Outcome |", "| --- | --- | --- |",
    ...Array.from({ length: 250 }, () => line), "", "[0055](details.md)"].join("\n");
  assert.ok(Buffer.byteLength(report) > 40 * 1024);
  await fs.writeFile(file, report);
  const host = await createHost();
  t.after(async () => {
    await new Promise((resolve) => host.server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const select = await fetch(host.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });
  assert.equal(select.status, 200);
  const route = host.base + "document/M3%20verification.md";
  const head = await fetch(route, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "text/html; charset=utf-8");
  const html = await (await fetch(route)).text();
  assert.match(html, /:root\{[^}]*background:Canvas;color:CanvasText/);
  assert.match(html, /<h1 id="m3-engine-verification-on-wpc">M3 engine verification on wpc<\/h1>/);
  assert.match(html, /<table>/);
  await fs.unlink(file);
  assert.equal((await fetch(route, { method: "HEAD" })).status, 400);
  for (const extension of ["mdown", "mkd"]) {
    const alternate = path.join(dir, `notes.${extension}`);
    await fs.writeFile(alternate, "# Also Markdown\n");
    const result = await fetch(host.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: alternate }) });
    assert.equal(result.status, 200);
    assert.equal((await (await fetch(host.base + "state")).json()).kind, "markdown");
    assert.match(await (await fetch(host.base + `document/notes.${extension}`)).text(), /<h1 id="also-markdown">Also Markdown<\/h1>/);
  }
});

test("PDF and video route only the selected file and support byte ranges", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-viewer-media-test-"));
  const bytes = Buffer.from("0123456789abcdef");
  for (const name of ["sample.pdf", "sample.mp4", "sample.webm", "sample.mov", "other.pdf"]) {
    await fs.writeFile(path.join(dir, name), bytes);
  }
  await fs.writeFile(path.join(dir, "secret.txt"), "private");
  const host = await createHost();
  t.after(async () => {
    await new Promise((resolve) => host.server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const get = (route, options) => fetch(host.base + route, options);
  const select = (file) => get("select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });

  assert.equal((await select(path.join(dir, "sample.pdf"))).status, 200);
  assert.deepEqual(await (await get("state")).json(), {
    revision: 1, title: "sample.pdf", kind: "pdf", document: "document/sample.pdf",
  });
  const pdf = await get("document/sample.pdf", { headers: { Range: "bytes=2-5" } });
  assert.equal(pdf.status, 206);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(pdf.headers.get("content-range"), "bytes 2-5/16");
  assert.equal(pdf.headers.get("content-length"), "4");
  assert.equal(pdf.headers.get("accept-ranges"), "bytes");
  assert.equal(await pdf.text(), "2345");
  const suffix = await get("document/sample.pdf", { headers: { Range: "bytes=-4" } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), "cdef");
  const head = await get("document/sample.pdf", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "16");
  assert.equal(await head.text(), "");
  for (const range of ["bytes=99-", "bytes=4-2", "bytes=0-1,4-5", "bytes=-0"]) {
    const rejected = await get("document/sample.pdf", { headers: { Range: range } });
    assert.equal(rejected.status, 416, range);
    assert.equal(rejected.headers.get("content-range"), "bytes */16");
  }
  assert.equal((await get("document/other.pdf")).status, 404);
  assert.equal((await get("document/../secret.txt")).status, 404);
  assert.equal((await get("document/%2e%2e/secret.txt")).status, 404);
  assert.equal((await get("pdfjs/pdf.min.mjs")).status, 200);
  assert.equal((await get("pdfjs/pdf.worker.min.mjs")).status, 200);
  assert.equal((await get("pdfjs/LICENSE")).status, 404);
  assert.equal((await select(path.join(dir, "secret.txt"))).status, 400);
  assert.equal((await select("sample.mp4")).status, 400);
  assert.equal((await get("document/sample.pdf")).status, 200);

  for (const [name, mime] of [["sample.mp4", "video/mp4"], ["sample.webm", "video/webm"], ["sample.mov", "video/quicktime"]]) {
    assert.equal(typeOf({ path: name }), "video");
    assert.equal((await select(path.join(dir, name))).status, 200);
    const state = await (await get("state")).json();
    assert.equal(state.kind, "video");
    assert.equal(state.document, `document/${name}`);
    assert.equal((await get("document/sample.pdf")).status, 404);
    const video = await get(`document/${name}`, { headers: { Range: "bytes=8-" } });
    assert.equal(video.status, 206);
    assert.equal(video.headers.get("content-type"), mime);
    assert.equal(await video.text(), "89abcdef");
  }
  assert.equal((await get("document/other.pdf")).status, 404);
});

test("browser routing covers models and decodable images while retaining native-only types", () => {
  for (const [file, kind] of [["a.md", "markdown"], ["a.MARKDOWN", "markdown"], ["a.mdown", "markdown"], ["a.mkd", "markdown"], ["a.glb", "gltf"], ["a.gltf", "gltf"], ["a.SVG", "image"], ["a.avif", "image"], ["a.heic", "image"], ["a.pdf", "pdf"], ["a.html", "html"], ["a.mov", "video"], ["a.tiff", null], ["a.psd", null], ["a.txt", null]]) {
    assert.equal(browserViewerType({ path: `/items/${file}` }), kind, file);
  }
  assert.equal(browserViewerType({ url: "https://example.com" }), null);
  const [child] = folderItems({ id: "1234567890abcdef", path: "/samples", url: null }, ["nested"], [{ name: "notes.md", dir: false }]);
  assert.equal(browserViewerType(child), "markdown", "a browsed folder child uses the same browser viewer");
  assert.equal(typeOf({ path: "a.glb" }), "gltf");
});

test("Space routes covered types according to the preview setting, leaving other types with the system", () => {
  for (const file of ["page.md", "page.html", "page.pdf", "clip.mp4", "model.glb", "photo.png"]) {
    const item = { path: `/items/${file}` };
    assert.equal(spacePreviewRoute(item, "builtin"), "browser", file);
    assert.equal(spacePreviewRoute(item, "system"), "system", file);
  }
  for (const item of [{ path: "/items/report.txt" }, { path: "/items/photo.tiff" }, { url: "https://example.com" }]) {
    assert.equal(spacePreviewRoute(item, "builtin"), "system");
    assert.equal(spacePreviewRoute(item, "system"), "system");
  }
});

test("image fit, bounded zoom and quarter-turn controls", () => {
  assert.equal(fitScale(1000, 500, 500, 500), 0.5);
  assert.equal(fitScale(100, 100, 500, 500), 1);
  assert.equal(clampZoom(0.001), 0.05);
  assert.equal(clampZoom(100), 32);
  assert.equal(rotateQuarter(270), 0);
});

test("image wheel, drag, pinch, rotation and keyboard controls change the visible transform", () => {
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const stage = { clientWidth: 500, clientHeight: 300, setPointerCapture() {}, focus() {} };
    const picture = { naturalWidth: 1000, naturalHeight: 500, style: {}, removeAttribute() {} };
    const controls = Array.from({ length: 6 }, () => ({}));
    const viewer = installImageControls(stage, picture, controls);
    picture.onload();
    assert.equal(controls[5].textContent, "50%");
    let prevented = false;
    stage.onwheel({ deltaY: -1, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(controls[5].textContent, "60%");
    stage.onpointerdown({ pointerId: 1, clientX: 10, clientY: 10 });
    stage.onpointermove({ pointerId: 1, clientX: 30, clientY: 20 });
    assert.match(picture.style.transform, /translate\(20px, 10px\)/);
    stage.onpointerdown({ pointerId: 2, clientX: 40, clientY: 20 });
    stage.onpointermove({ pointerId: 2, clientX: 60, clientY: 20 });
    assert.equal(controls[5].textContent, "60%");
    stage.onpointermove({ pointerId: 2, clientX: 80, clientY: 20 });
    assert.notEqual(controls[5].textContent, "60%");
    controls[4].onclick();
    assert.match(picture.style.transform, /rotate\(90deg\)/);
    stage.onkeydown({ key: "1", preventDefault() {} });
    assert.equal(controls[5].textContent, "100%");
    stage.onkeydown({ key: "f", preventDefault() {} });
    assert.equal(controls[5].textContent, "30%");
    viewer.dispose();
  } finally { globalThis.ResizeObserver = previous; }
});

test("glTF references are confined to declared assets under the model folder", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-gltf-test-"));
  const root = path.join(dir, "model");
  await fs.mkdir(path.join(root, "textures"), { recursive: true });
  const model = path.join(root, "scene.gltf");
  await fs.writeFile(path.join(root, "mesh.bin"), "mesh");
  await fs.writeFile(path.join(root, "textures", "base.png"), "picture");
  await fs.writeFile(path.join(root, "secret.bin"), "unlisted");
  await fs.writeFile(path.join(dir, "outside.bin"), "outside");
  if (process.platform !== "win32") await fs.symlink(path.join(dir, "outside.bin"), path.join(root, "escape.bin"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const write = (buffers, images = []) => fs.writeFile(model, JSON.stringify({ asset: { version: "2.0" }, buffers, images }));
  await write([{ uri: "mesh.bin" }, { uri: "data:application/octet-stream;base64,AA==" }], [{ uri: "textures/base.png" }]);
  const manifest = await gltfManifestFor(model);
  assert.deepEqual([...manifest.files.keys()], ["scene.gltf", "mesh.bin", "textures/base.png"]);
  const host = await createHost();
  t.after(() => new Promise((resolve) => host.server.close(resolve)));
  const select = () => fetch(host.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: model }) });
  assert.equal((await select()).status, 200);
  assert.equal((await (await fetch(host.base + "state")).json()).kind, "gltf");
  assert.equal((await fetch(host.base + "document/mesh.bin")).status, 200);
  assert.equal((await fetch(host.base + "document/textures/base.png")).status, 200);
  assert.equal((await fetch(host.base + "document/secret.bin")).status, 404);
  for (const uri of ["../outside.bin", "https://example.com/data.bin", "/private.bin", "escape.bin", "missing.bin"]) {
    if (uri === "escape.bin" && process.platform === "win32") continue;
    await write([{ uri }]);
    assert.equal((await select()).status, 400, uri);
    assert.equal((await fetch(host.base + "document/secret.bin")).status, 404);
  }
});

test("GLB and still images serve only the selected file", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-viewer-image-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ["scene.glb", "picture.svg", "photo.avif", "secret.png"]) await fs.writeFile(path.join(dir, name), "bytes");
  const host = await createHost();
  t.after(() => new Promise((resolve) => host.server.close(resolve)));
  const select = (file) => fetch(host.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: path.join(dir, file) }) });
  assert.equal((await select("scene.glb")).status, 200);
  assert.equal((await (await fetch(host.base + "state")).json()).kind, "gltf");
  assert.equal((await fetch(host.base + "document/secret.png")).status, 404);
  assert.equal((await select("picture.svg")).status, 200);
  assert.equal((await (await fetch(host.base + "state")).json()).kind, "image");
  const svg = await fetch(host.base + "document/picture.svg");
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.match(svg.headers.get("content-security-policy"), /script-src 'none'/);
  assert.equal((await fetch(host.base + "document/scene.glb")).status, 404);
  assert.equal((await select("photo.avif")).status, 200);
  assert.equal((await fetch(host.base + "three/three.min.js")).status, 200);
  assert.equal((await fetch(host.base + "three/LICENSE")).status, 404);
});
