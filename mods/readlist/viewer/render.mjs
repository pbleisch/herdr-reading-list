// HTML-to-tiles renderer. The viewer host supplies the exact same asset manifest and
// document CSP as the browser viewer. Progress is published after each complete PNG.
import { spawn } from "node:child_process";
import { promises as fs, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHost, manifestFor } from "./host.mjs";
import { CACHE_LIMIT, cacheKey, mapCapturedLinks, pruneCache, touchEntry } from "./tile-cache.mjs";
import { tileCaptureOrder } from "../core/tiles.js";

const TILE = 512;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => Number(process.hrtime.bigint()) / 1e6;

export async function browserBinary() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    : process.platform === "win32"
      ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
        .filter(Boolean).flatMap((root) => [path.join(root, "Google", "Chrome", "Application", "chrome.exe"), path.join(root, "Microsoft", "Edge", "Application", "msedge.exe")])
      : (process.env.PATH ?? "").split(path.delimiter).flatMap((root) => ["chromium", "chromium-browser", "google-chrome", "microsoft-edge"].map((name) => path.join(root, name)));
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new Error("Chrome, Chromium, or Edge was not found");
}

async function publish(file, data) {
  if (!file) return;
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data));
  await fs.rename(temp, file);
}

export class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.next = 1;
    this.pending = new Map();
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    };
  }
  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, awaitPromise = false) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  close() { this.ws.close(); }
}

export async function chromeReady(profile, child) {
  const active = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}`);
    try {
      const [port] = (await fs.readFile(active, "utf8")).split("\n");
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* Chrome has not opened its debugging port yet. */ }
    await pause(50);
  }
  throw new Error("Chrome debugging port did not open");
}

async function run(file, output, width, scale, dark, progress, priority = 0, force = false) {
  const start = tick();
  const selected = await fs.realpath(file);
  const allowlist = await manifestFor(selected);
  const key = await cacheKey(selected, allowlist.files, width, scale, dark);
  const dir = path.join(output, key);
  const manifestPath = path.join(dir, "manifest.json");
  if (!force) {
    try {
      const old = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      if (old.tiles.length && (await Promise.all(old.tiles.map((t) => fs.stat(path.join(dir, t.file)).then(() => true, () => false)))).every(Boolean)) {
        await touchEntry(dir);
        const hit = { ...old, requested: file, cacheHit: true, elapsedMs: Math.round(tick() - start) };
        await publish(progress, hit);
        await pruneCache(output, [key]);
        return hit;
      }
    } catch { /* Render the missing cache entry. */ }
  }
  const chrome = await browserBinary();
  await fs.mkdir(dir, { recursive: true });
  const host = await createHost();
  let child, cdp, profile;
  try {
    const selection = await fetch(host.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: selected }) });
    if (!selection.ok) throw new Error("The viewer host refused the selected HTML file");
    const state = await (await fetch(host.base + "state")).json();
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-render-"));
    child = spawn(chrome, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${width},900`, "about:blank"], { stdio: "ignore" });
    cdp = new Cdp(await chromeReady(profile, child));
    await cdp.ready();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: scale, mobile: false });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await cdp.send("Page.navigate", { url: new URL(state.document, host.base).href });
    const ready = await cdp.eval(`(async () => {
      if (document.readyState !== "complete") await new Promise(resolve => addEventListener("load", resolve, {once:true}));
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; image.onerror = resolve; })));
      return {
        height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
        links: Array.from(document.querySelectorAll("a[href]")).flatMap(a => {
          let fragment = "";
          try { fragment = a.hash ? decodeURIComponent(a.hash.slice(1)) : ""; } catch { /* Invalid anchor escape. */ }
          const anchor = fragment ? document.getElementById(fragment) : null;
          const anchorY = anchor ? anchor.getBoundingClientRect().top + scrollY : null;
          return Array.from(a.getClientRects(), r => ({ href: a.href, x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, anchorY }));
        })
      };
    })()`, true);
    const links = mapCapturedLinks(ready.links, host.base + "document/", allowlist.files);
    const tiles = [];
    let firstTileMs = null;
    let cacheBytes = 0;
    const current = () => ({ requested: file, source: selected, key, width, scale, dark, height: ready.height, tiles, links });
    await publish(progress, current());
    for (const index of tileCaptureOrder(ready.height, priority)) {
      const y = index * TILE;
      const height = Math.min(TILE, ready.height - y);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width, height, scale: 1 } });
      const name = `tile-${String(index).padStart(3, "0")}.png`;
      await fs.writeFile(path.join(dir, name), Buffer.from(shot.data, "base64"));
      cacheBytes += (await fs.stat(path.join(dir, name))).size;
      if (cacheBytes > CACHE_LIMIT) {
        await fs.rm(dir, { recursive: true, force: true });
        throw new Error("Rendered HTML exceeds the tile cache limit");
      }
      tiles.push({ file: name, y, height });
      if (firstTileMs === null) firstTileMs = Math.round(tick() - start);
      await publish(progress, current());
    }
    const result = { ...current(), cacheHit: false,
      firstTileMs, elapsedMs: Math.round(tick() - start),
      cacheBytes };
    await fs.writeFile(manifestPath, JSON.stringify(result, null, 2));
    await touchEntry(dir);
    await publish(progress, result);
    await pruneCache(output, [key]);
    return result;
  } finally {
    cdp?.close();
    if (child?.pid) { child.kill("SIGTERM"); await pause(150); if (child.exitCode === null) child.kill("SIGKILL"); }
    if (profile) await fs.rm(profile, { recursive: true, force: true });
    await new Promise((resolve) => host.server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [file, output, rawWidth, rawScale = "2", mode = "light", progress = "", rawPriority = "0", force = ""] = process.argv.slice(2);
  const width = Number(rawWidth), scale = Number(rawScale), priority = Number(rawPriority);
  if (!file || !output || !path.isAbsolute(file) || !path.isAbsolute(output) || (progress && !path.isAbsolute(progress)) || !Number.isInteger(width) || width < 120 || width > 2000 || ![1, 2, 3].includes(scale) || !["light", "dark"].includes(mode) || !Number.isFinite(priority) || priority < 0) {
    console.error("Expected ABSOLUTE_HTML_FILE ABSOLUTE_CACHE_DIR WIDTH [SCALE=2] [light|dark] [ABSOLUTE_PROGRESS_FILE] [PRIORITY_Y=0] [--force]");
    process.exitCode = 2;
  } else {
    run(file, output, width, scale, mode === "dark", progress, priority, force === "--force")
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => { console.error(error.stack); process.exitCode = 1; })
      .finally(() => progress && fs.unlink(progress).catch(() => {}));
  }
}
