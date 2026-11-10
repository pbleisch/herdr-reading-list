// Local browser host for the reading list's HTML viewer. Node 20+ is used only by this
// companion process; the mod's native preview remains available without it.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = new Map(Object.entries({
  ".html": "text/html", ".htm": "text/html", ".xhtml": "text/html",
  ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
}));
const DOCUMENT_EXT = new Set([".html", ".htm", ".xhtml"]);
const MAX_FILE = 16 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_TOTAL = 64 * 1024 * 1024;
const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'";
const DOCUMENT_CSP = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const fileMime = (file) => MIME.get(path.extname(file).toLowerCase());

function references(text, mime) {
  const values = [];
  if (mime === "text/css") {
    for (const match of text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)|@import\s+['"]([^'"]+)['"]/gi)) values.push(match[2] ?? match[3]);
  } else {
    for (const match of text.matchAll(/\b(?:src|href|poster|data)\s*=\s*(['"])(.*?)\1/gi)) values.push(match[2]);
    for (const match of text.matchAll(/\bsrcset\s*=\s*(['"])(.*?)\1/gi)) {
      for (const entry of match[2].split(",")) values.push(entry.trim().split(/\s+/)[0]);
    }
    values.push(...references(text, "text/css"));
  }
  return values;
}

function relativeReference(value, from) {
  if (!value || value.startsWith("/") || value.startsWith("\\") || value.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) return null;
  let url;
  try { url = new URL(value, `http://viewer.invalid/${from}`); } catch { return null; }
  if (url.origin !== "http://viewer.invalid") return null;
  let raw;
  try { raw = decodeURIComponent(value.split(/[?#]/)[0]); } catch { return null; }
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/")) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), raw));
  if (!joined || joined === "." || joined === ".." || joined.startsWith("../")) return null;
  return joined;
}

export async function manifestFor(selected) {
  const real = await fs.realpath(selected);
  const root = path.dirname(real);
  if (!DOCUMENT_EXT.has(path.extname(real).toLowerCase())) throw new Error("Only local HTML files are supported");
  const files = new Map();
  const queue = [path.basename(real)];
  let total = 0;
  while (queue.length && files.size < MAX_FILES) {
    const name = queue.shift();
    if (files.has(name) || !fileMime(name)) continue;
    const candidate = path.resolve(root, ...name.split("/"));
    if (!inside(root, candidate)) continue;
    let target, stat;
    try { target = await fs.realpath(candidate); stat = await fs.stat(target); } catch { continue; }
    if (!inside(root, target) || !stat.isFile() || stat.size > MAX_FILE || total + stat.size > MAX_TOTAL) continue;
    const mime = fileMime(target);
    if (!mime) continue;
    files.set(name, { target, mime });
    total += stat.size;
    if (mime !== "text/html" && mime !== "text/css") continue;
    const content = await fs.readFile(target, "utf8");
    for (const ref of references(content, mime)) {
      const next = relativeReference(ref, name);
      if (next && !files.has(next)) queue.push(next);
    }
  }
  if (!files.has(path.basename(real))) throw new Error("HTML file is too large or unavailable");
  return { root, files, entry: path.basename(real), title: path.basename(real) };
}

function fileName(raw) {
  if (!raw || raw.endsWith("/")) return null;
  const parts = raw.split("/");
  const decoded = [];
  for (const part of parts) {
    let name;
    try { name = decodeURIComponent(part); } catch { return null; }
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) return null;
    decoded.push(name);
  }
  return decoded.join("/");
}

function send(res, status, body = "", type = "text/plain", headers = {}) {
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers });
  res.end(body);
}

async function bodyJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw new Error("Request too large");
  }
  return JSON.parse(body);
}

export async function createHost({ token = randomBytes(32).toString("hex"), port = 0 } = {}) {
  let current = null, revision = 0, clientAt = 0, launchedAt = 0;
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== host) return send(res, 403);
    const raw = (req.url ?? "").split("?")[0];
    const prefix = `/${token}/`;
    if (!raw.startsWith(prefix)) return send(res, 404);
    const route = raw.slice(prefix.length);
    try {
      if (route === "health" && req.method === "GET") return send(res, 200, "ok");
      if (route === "state" && req.method === "GET") {
        const document = current ? `document/${current.entry.split("/").map(encodeURIComponent).join("/")}` : null;
        return send(res, 200, JSON.stringify({ revision, title: current?.title ?? "", document }), "application/json");
      }
      if (route === "heartbeat" && req.method === "POST") { clientAt = Date.now(); return send(res, 204); }
      if (route === "goodbye" && req.method === "POST") { clientAt = 0; launchedAt = 0; return send(res, 204); }
      if (route === "launch-failed" && req.method === "POST") { launchedAt = 0; return send(res, 204); }
      if (route === "close" && req.method === "POST") {
        current = null;
        revision++;
        return send(res, 204);
      }
      if (route === "select" && req.method === "POST") {
        const input = await bodyJson(req);
        if (typeof input.file !== "string" || !path.isAbsolute(input.file)) return send(res, 400);
        current = await manifestFor(input.file);
        revision++;
        const launch = Date.now() - Math.max(clientAt, launchedAt) > 10000;
        if (launch) launchedAt = Date.now();
        return send(res, 200, JSON.stringify({ launch, revision }), "application/json");
      }
      if (route === "shell" && req.method === "GET") {
        const body = await fs.readFile(path.join(here, "shell.html"));
        return send(res, 200, body, "text/html", { "Content-Security-Policy": SHELL_CSP });
      }
      if ((route === "shell.css" || route === "shell.js") && req.method === "GET") {
        const body = await fs.readFile(path.join(here, route));
        return send(res, 200, body, route.endsWith("css") ? "text/css" : "text/javascript", { "Content-Security-Policy": SHELL_CSP });
      }
      if (route.startsWith("document/") && req.method === "GET") {
        const name = fileName(route.slice("document/".length));
        const entry = name && current?.files.get(name);
        if (!entry) return send(res, 404);
        // The allowlist is refreshed for each selection; a changed symlink cannot escape it.
        const real = await fs.realpath(entry.target);
        if (!inside(current.root, real) || real !== entry.target) return send(res, 404);
        const stat = await fs.stat(real);
        if (!stat.isFile() || stat.size > MAX_FILE) return send(res, 404);
        const body = await fs.readFile(real);
        return send(res, 200, body, entry.mime, { "Content-Security-Policy": DOCUMENT_CSP, "Access-Control-Allow-Origin": "*" });
      }
      return send(res, 404);
    } catch { return send(res, 400, "Unavailable resource"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, token, port: server.address().port, base: `http://127.0.0.1:${server.address().port}/${token}/` };
}

const sessionFile = (dir) => path.join(dir, "session.json");
async function session(dir) {
  try {
    const data = JSON.parse(await fs.readFile(sessionFile(dir), "utf8"));
    if (!Number.isInteger(data.port) || !/^[a-f0-9]{64}$/.test(data.token)) return null;
    const base = `http://127.0.0.1:${data.port}/${data.token}/`;
    const check = await fetch(base + "health", { signal: AbortSignal.timeout(1000) });
    return check.ok ? { ...data, base } : null;
  } catch { return null; }
}

async function ensureSession(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const existing = await session(dir);
  if (existing) return existing;
  const lock = path.join(dir, "start.lock");
  let owned = false;
  try { await fs.mkdir(lock, { mode: 0o700 }); owned = true; } catch {
    // A launcher can die before removing the lock. A live launch finishes below this age.
    try {
      if (Date.now() - (await fs.stat(lock)).mtimeMs > 10000) {
        await fs.rmdir(lock);
        await fs.mkdir(lock, { mode: 0o700 });
        owned = true;
      }
    } catch { /* another opener is starting */ }
  }
  if (owned) {
    try {
      const again = await session(dir);
      if (again) return again;
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", dir], { detached: true, stdio: "ignore" });
      child.unref();
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const started = await session(dir);
        if (started) return started;
      }
      throw new Error("Viewer host did not start");
    } finally { await fs.rmdir(lock).catch(() => {}); }
  }
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = await session(dir);
    if (started) return started;
  }
  throw new Error("Viewer host did not start");
}

async function openBrowser(url) {
  if (process.env.READLIST_VIEWER_NO_BROWSER === "1") return;
  const run = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Browser did not open")));
  });
  const detached = (command, args) => new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
  if (process.platform === "darwin") {
    try {
      await fs.access("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
      return await run("open", ["-na", "Google Chrome", "--args", `--app=${url}`]);
    } catch { return run("open", [url]); }
  }
  if (process.platform === "win32") {
    const edge = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter(Boolean).map((dir) => path.join(dir, "Microsoft", "Edge", "Application", "msedge.exe"));
    for (const candidate of edge) {
      try { await fs.access(candidate); return await detached(candidate, [`--app=${url}`]); } catch { /* try the next browser */ }
    }
    return run("cmd.exe", ["/d", "/s", "/c", `start "" "${url}"`]);
  }
  for (const command of ["chromium", "chromium-browser", "google-chrome"]) {
    try { return await detached(command, [`--app=${url}`]); } catch { /* try the next browser */ }
  }
  return run("xdg-open", [url]);
}

async function main() {
  const [action, dir, file] = process.argv.slice(2);
  if (action === "serve") {
    const host = await createHost();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    await fs.writeFile(sessionFile(dir), JSON.stringify({ port: host.port, token: host.token, pid: process.pid }), { mode: 0o600 });
    await fs.chmod(sessionFile(dir), 0o600);
    process.on("SIGTERM", () => host.server.close());
    return;
  }
  if (action === "close" && dir) {
    const running = await session(dir);
    if (running) await fetch(running.base + "close", { method: "POST" });
    return;
  }
  if (action !== "open" || !dir || !file || !path.isAbsolute(file)) throw new Error("Expected open SESSION_DIR ABSOLUTE_HTML_FILE");
  const running = await ensureSession(dir);
  const response = await fetch(running.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });
  if (!response.ok) throw new Error("HTML file is unavailable");
  const result = await response.json();
  if (result.launch) {
    try { await openBrowser(running.base + "shell"); }
    catch (error) {
      await fetch(running.base + "launch-failed", { method: "POST" }).catch(() => {});
      throw error;
    }
  }
  process.stdout.write("viewer\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`readlist: ${error.message}\n`); process.exitCode = 1; });
}
