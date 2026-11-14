// Local browser host for the reading list viewer. Node 20+ is used only by this
// companion process; the mod's native preview remains available without it.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createReadStream, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { markdownReferences, renderMarkdown } from "./markdown.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = new Map(Object.entries({
  ".html": "text/html", ".htm": "text/html", ".xhtml": "text/html",
  ".md": "text/markdown", ".markdown": "text/markdown", ".mdown": "text/markdown", ".mkd": "text/markdown", ".txt": "text/plain", ".pdf": "application/pdf",
  ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".heic": "image/heic", ".heif": "image/heif", ".bmp": "image/bmp",
  ".gltf": "model/gltf+json", ".glb": "model/gltf-binary", ".bin": "application/octet-stream",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
}));
const DOCUMENT_EXT = new Set([".html", ".htm", ".xhtml"]);
const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const VIDEO_MIME = new Map([[".mp4", "video/mp4"], [".m4v", "video/mp4"], [".webm", "video/webm"], [".mov", "video/quicktime"]]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".heic", ".heif", ".bmp"]);
const GLTF_ASSET_EXT = new Set([".bin", ".png", ".jpg", ".jpeg", ".webp", ".avif"]);
const PDFJS_FILES = new Map([["pdf.min.mjs", "text/javascript"], ["pdf.worker.min.mjs", "text/javascript"]]);
const THREE_FILES = new Set(["three.min.js"]);
const MAX_FILE = 16 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_TOTAL = 64 * 1024 * 1024;
const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; worker-src 'self'; img-src 'self' data: blob:; media-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'";
const DOCUMENT_CSP = "default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const runFile = promisify(execFile);
const BUILD_FILES = ["host.mjs", "shell.html", "shell.css", "shell.js", "markdown.mjs", "marked/marked.esm.js", "image-controls.js", "gltf-view.js", "pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs", ...THREE_FILES].map((name) => THREE_FILES.has(name) ? `three/${name}` : name);

async function buildIdentity() {
  const hash = createHash("sha256");
  for (const name of BUILD_FILES) {
    hash.update(name);
    hash.update(await fs.readFile(path.join(here, name)));
  }
  return hash.digest("hex");
}

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

async function documentManifestFor(selected, kind) {
  const real = await fs.realpath(selected);
  const root = path.dirname(real);
  const extension = path.extname(real).toLowerCase();
  if (kind === "html" ? !DOCUMENT_EXT.has(extension) : !MARKDOWN_EXT.has(extension)) throw new Error("Unsupported document type");
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
    if (mime !== "text/html" && mime !== "text/css" && mime !== "text/markdown") continue;
    const content = await fs.readFile(target, "utf8");
    for (const ref of mime === "text/markdown" ? markdownReferences(content) : references(content, mime)) {
      const next = relativeReference(ref, name);
      if (next && !files.has(next)) queue.push(next);
    }
  }
  if (!files.has(path.basename(real))) throw new Error("Document is too large or unavailable");
  return { kind, root, files, entry: path.basename(real), title: path.basename(real) };
}

export const manifestFor = (selected) => documentManifestFor(selected, "html");
export const markdownManifestFor = (selected) => documentManifestFor(selected, "markdown");

// A glTF JSON file can load only its declared buffers and images from its own folder.
// Data URIs are self-contained; all other schemes, missing assets and escapes fail the selection.
export async function gltfManifestFor(selected) {
  const real = await fs.realpath(selected);
  if (path.extname(real).toLowerCase() !== ".gltf") throw new Error("Expected a glTF file");
  const root = path.dirname(real), entry = path.basename(real);
  const stat = await fs.stat(real);
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("glTF JSON is unavailable or too large");
  const document = JSON.parse(await fs.readFile(real, "utf8"));
  if (document?.asset?.version?.split(".")[0] !== "2") throw new Error("Only glTF 2.0 is supported");
  const files = new Map([[entry, { target: real, mime: "model/gltf+json" }]]);
  let total = stat.size;
  for (const resource of [...(document.buffers ?? []), ...(document.images ?? [])]) {
    const uri = resource?.uri;
    if (uri === undefined) continue; // bufferView image inside an allowed buffer
    if (typeof uri !== "string") throw new Error("Invalid glTF asset URI");
    if (/^data:/i.test(uri)) continue;
    const name = relativeReference(uri, entry);
    if (!name || !GLTF_ASSET_EXT.has(path.extname(name).toLowerCase())) throw new Error("glTF asset is outside the supported local folder");
    if (files.has(name)) continue;
    const candidate = path.resolve(root, ...name.split("/"));
    if (!inside(root, candidate)) throw new Error("glTF asset escapes the selected folder");
    const target = await fs.realpath(candidate);
    const asset = await fs.stat(target);
    if (!inside(root, target) || !asset.isFile() || asset.size > MAX_FILE || total + asset.size > MAX_TOTAL || files.size >= MAX_FILES) throw new Error("glTF asset is unavailable or exceeds the viewer limit");
    files.set(name, { target, mime: fileMime(name) });
    total += asset.size;
  }
  return { kind: "gltf", root, files, entry, title: entry };
}

async function selectionFor(selected) {
  const real = await fs.realpath(selected);
  const extension = path.extname(real).toLowerCase();
  if (DOCUMENT_EXT.has(extension)) return manifestFor(real);
  if (MARKDOWN_EXT.has(extension)) return markdownManifestFor(real);
  if (extension === ".gltf") return gltfManifestFor(real);
  const kind = extension === ".pdf" ? "pdf" : VIDEO_MIME.has(extension) ? "video"
    : IMAGE_EXT.has(extension) ? "image" : extension === ".glb" ? "gltf" : null;
  if (!kind) throw new Error("Unsupported viewer type");
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error("Selected path is not a file");
  const entry = path.basename(real);
  return { kind, root: path.dirname(real), entry, title: entry,
    files: new Map([[entry, { target: real, mime: kind === "pdf" ? "application/pdf" : VIDEO_MIME.get(extension) ?? fileMime(real) }]]) };
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
  const contentType = /^(text\/|application\/json)/.test(type) ? `${type}; charset=utf-8` : type;
  res.writeHead(status, { "Content-Type": contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers });
  res.end(body);
}

function byteRange(raw, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  return start < size && end >= start ? { start, end } : null;
}

async function selectedPath(selection, target) {
  const real = await fs.realpath(target);
  if (!inside(selection.root, real) || real !== target) throw new Error("Selected path changed");
  return real;
}

function markdownUrl(selection, value, from, image) {
  if (!image && value.startsWith("#")) return value;
  const name = relativeReference(value, from);
  const entry = name && selection.files.get(name);
  if (!entry || (image && !entry.mime.startsWith("image/"))) return null;
  const relative = path.posix.relative(path.posix.dirname(from), name);
  const encoded = relative.split("/").map((part) => part === ".." ? part : encodeURIComponent(part)).join("/");
  const fragment = !image && value.includes("#") ? `#${value.split("#").slice(1).join("#")}` : "";
  return encoded + fragment;
}

async function serveSelected(req, res, selection, entry) {
  // Recheck the allowlisted target immediately before opening it.
  const real = await selectedPath(selection, entry.target);
  const stat = await fs.stat(real);
  if (!stat.isFile() || (["html", "markdown"].includes(selection.kind) && stat.size > MAX_FILE)) return send(res, 404);
  if (selection.kind === "html" || selection.kind === "markdown") {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 404);
    if (entry.mime === "text/markdown") {
      const name = [...selection.files].find(([, file]) => file === entry)?.[0];
      if (!name) return send(res, 404);
      const html = renderMarkdown(await fs.readFile(real, "utf8"), name,
        (value, from, image) => markdownUrl(selection, value, from, image));
      return send(res, 200, req.method === "HEAD" ? "" : html, "text/html", { "Content-Security-Policy": DOCUMENT_CSP });
    }
    const html = await fs.readFile(real);
    return send(res, 200, req.method === "HEAD" ? "" : html, entry.mime,
      { "Content-Security-Policy": DOCUMENT_CSP, "Access-Control-Allow-Origin": "*" });
  }
  const range = req.headers.range ? byteRange(req.headers.range, stat.size) : null;
  const headers = { "Accept-Ranges": "bytes", "Content-Length": String(range ? range.end - range.start + 1 : stat.size),
    "Content-Security-Policy": "default-src 'none'; script-src 'none'" };
  if (req.headers.range && !range) return send(res, 416, "", entry.mime,
    { "Accept-Ranges": "bytes", "Content-Range": `bytes */${stat.size}` });
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
  res.writeHead(range ? 206 : 200, { "Content-Type": entry.mime, "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers });
  if (req.method === "HEAD") return res.end();
  const stream = createReadStream(real, range ?? undefined);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function posterFor(selection) {
  if (!selection.poster) {
    const file = selection.files.get(selection.entry).target;
    selection.poster = selectedPath(selection, file).then((real) => runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", "0.5", "-i", real,
      "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
    { encoding: "buffer", timeout: 5000, maxBuffer: 2 * 1024 * 1024 })).then(({ stdout }) => stdout).catch(() => null);
  }
  return selection.poster;
}

async function openDefault(file) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", file] : [file];
  await runFile(command, args, { timeout: 5000 });
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
  const build = await buildIdentity();
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
      if (route === "version" && req.method === "GET") return send(res, 200, JSON.stringify({ build, pid: process.pid }), "application/json");
      if (route === "state" && req.method === "GET") {
        const document = current ? `document/${current.entry.split("/").map(encodeURIComponent).join("/")}` : null;
        return send(res, 200, JSON.stringify({ revision, title: current?.title ?? "", kind: current?.kind ?? null, document }), "application/json");
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
        current = await selectionFor(input.file);
        revision++;
        const launch = Date.now() - Math.max(clientAt, launchedAt) > 10000;
        if (launch) launchedAt = Date.now();
        return send(res, 200, JSON.stringify({ launch, revision }), "application/json");
      }
      if (route === "shell" && req.method === "GET") {
        const body = await fs.readFile(path.join(here, "shell.html"));
        return send(res, 200, body, "text/html", { "Content-Security-Policy": SHELL_CSP });
      }
      if (["shell.css", "shell.js", "image-controls.js", "gltf-view.js"].includes(route) && req.method === "GET") {
        const body = await fs.readFile(path.join(here, route));
        return send(res, 200, body, route.endsWith("css") ? "text/css" : "text/javascript", { "Content-Security-Policy": SHELL_CSP });
      }
      if (route.startsWith("pdfjs/") && req.method === "GET") {
        const name = route.slice("pdfjs/".length);
        const mime = PDFJS_FILES.get(name);
        if (!mime) return send(res, 404);
        return send(res, 200, await fs.readFile(path.join(here, "pdfjs", name)), mime, { "Content-Security-Policy": SHELL_CSP });
      }
      if (route.startsWith("three/") && req.method === "GET") {
        const name = route.slice("three/".length);
        if (!THREE_FILES.has(name)) return send(res, 404);
        return send(res, 200, await fs.readFile(path.join(here, "three", name)), "text/javascript", { "Content-Security-Policy": SHELL_CSP });
      }
      if (route === "poster" && req.method === "GET" && current?.kind === "video") {
        const selection = current;
        const poster = await posterFor(selection);
        if (selection !== current || !poster?.length) return send(res, 404);
        return send(res, 200, poster, "image/jpeg");
      }
      if (route === "open-default" && req.method === "POST" && current?.kind === "video") {
        const selection = current;
        const file = await selectedPath(selection, selection.files.get(selection.entry).target);
        if (selection !== current) return send(res, 404);
        await openDefault(file);
        return send(res, 204);
      }
      if (route.startsWith("document/") && (req.method === "GET" || req.method === "HEAD")) {
        const name = fileName(route.slice("document/".length));
        const entry = name && current?.files.get(name);
        if (!entry) return send(res, 404);
        // Await so a file removed after selection becomes a response, not an unhandled rejection.
        return await serveSelected(req, res, current, entry);
      }
      return send(res, 404);
    } catch { return send(res, 400, "Unavailable resource"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return { server, token, port: server.address().port, base: `http://127.0.0.1:${server.address().port}/${token}/`, build };
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

async function currentSession(dir, build) {
  const running = await session(dir);
  if (!running || running.build !== build) return null;
  try {
    const response = await fetch(running.base + "version", { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const version = await response.json();
    return version.build === build && version.pid === running.pid ? running : null;
  } catch { return null; }
}

async function verifiedHostPid(pid, dir) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const script = fileURLToPath(import.meta.url);
  try {
    const { stdout } = process.platform === "win32"
      ? await runFile("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`])
      : await runFile("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.includes(script) && stdout.includes(dir) && /(?:^|\s)serve(?:\s|$)/.test(stdout);
  } catch { return false; }
}

async function stopStaleHost(running, dir) {
  if (!await verifiedHostPid(running.pid, dir)) throw new Error("Viewer host changed, but its recorded process cannot be verified for restart");
  process.kill(running.pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!await session(dir)) return;
  }
  throw new Error("Viewer host did not stop after its build changed");
}

async function ensureSession(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const build = await buildIdentity();
  const existing = await currentSession(dir, build);
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
      const again = await currentSession(dir, build);
      if (again) return again;
      const stale = await session(dir);
      if (stale) await stopStaleHost(stale, dir);
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", dir], { detached: true, stdio: "ignore" });
      child.unref();
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const started = await currentSession(dir, build);
        if (started) return started;
      }
      throw new Error("Viewer host did not start");
    } finally { await fs.rmdir(lock).catch(() => {}); }
  }
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = await currentSession(dir, build);
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
    await fs.writeFile(sessionFile(dir), JSON.stringify({ port: host.port, token: host.token, pid: process.pid, build: host.build }), { mode: 0o600 });
    await fs.chmod(sessionFile(dir), 0o600);
    process.on("SIGTERM", () => host.server.close());
    return;
  }
  if (action === "close" && dir) {
    const running = await session(dir);
    if (running) await fetch(running.base + "close", { method: "POST" });
    return;
  }
  if (action !== "open" || !dir || !file || !path.isAbsolute(file)) throw new Error("Expected open SESSION_DIR ABSOLUTE_FILE");
  const running = await ensureSession(dir);
  const response = await fetch(running.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file }) });
  if (!response.ok) throw new Error("Viewer file is unavailable");
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

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`readlist: ${error.message}\n`); process.exitCode = 1; });
}
