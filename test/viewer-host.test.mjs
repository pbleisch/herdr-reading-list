import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost } from "../mods/readlist/viewer/host.mjs";

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
