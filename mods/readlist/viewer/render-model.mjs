// One still poster through the same local host and headless browser path as HTML tiles.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, gltfManifestFor } from "./host.mjs";
import { browserBinary, Cdp, chromeReady } from "./render.mjs";
import { cacheKey, pruneCache, touchEntry } from "./tile-cache.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function renderModel(file, cache, width = 640, dark = false) {
  const selected = await fs.realpath(file);
  const extension = path.extname(selected).toLowerCase();
  if (extension !== ".glb" && extension !== ".gltf") throw new Error("Unsupported 3D file extension");
  const files = extension === ".gltf" ? (await gltfManifestFor(selected)).files
    : new Map([[path.basename(selected), { target: selected }]]);
  const key = await cacheKey(selected, files, width, 2, dark);
  const dir = path.join(cache, key), poster = path.join(dir, "poster.png");
  try {
    await fs.access(poster);
    await touchEntry(dir);
    return { key, cached: true };
  } catch { /* Capture the model. */ }
  const browser = await browserBinary();
  const host = await createHost();
  let child, cdp, profile;
  try {
    const response = await fetch(host.base + "select", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: selected }) });
    if (!response.ok) throw new Error("The viewer refused this 3D model or one of its assets");
    profile = await fs.mkdtemp(path.join(os.tmpdir(), "readlist-model-"));
    child = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
      "--enable-webgl", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
      `--window-size=${width},${width}`, "about:blank"], { stdio: "ignore" });
    cdp = new Cdp(await chromeReady(profile, child));
    await cdp.ready();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: width, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await cdp.send("Page.navigate", { url: host.base + "shell" });
    const ready = await cdp.eval(`new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 20000);
      const check = () => {
        const stage = document.getElementById("model-stage");
        if (stage?.dataset.ready === "true" || stage?.dataset.ready === "error") {
          clearTimeout(timer); resolve(stage.dataset.ready === "true");
        } else setTimeout(check, 100);
      };
      check();
    })`, true);
    if (!ready) throw new Error("The 3D model did not render in the headless browser");
    await cdp.eval('document.querySelector("header").hidden = true; document.getElementById("model-toolbar").hidden = true');
    await pause(100);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false,
      clip: { x: 0, y: 0, width, height: width, scale: 1 } });
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, `poster-${process.pid}.tmp`);
    await fs.writeFile(temp, Buffer.from(shot.data, "base64"));
    await fs.rename(temp, poster);
    await touchEntry(dir);
    await pruneCache(cache, [key]);
    return { key, cached: false };
  } finally {
    cdp?.close();
    if (child?.pid) { child.kill("SIGTERM"); await pause(150); if (child.exitCode === null) child.kill("SIGKILL"); }
    if (profile) await fs.rm(profile, { recursive: true, force: true });
    await new Promise((resolve) => host.server.close(resolve));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, cache, rawWidth = "640", appearance = "light"] = process.argv.slice(2);
  const width = Number(rawWidth);
  if (!file || !cache || !path.isAbsolute(file) || !path.isAbsolute(cache) || !Number.isInteger(width) || width < 120 || width > 1200 || !["light", "dark"].includes(appearance)) {
    console.error("Expected ABSOLUTE_MODEL_FILE ABSOLUTE_CACHE_DIR [WIDTH=640] [light|dark]");
    process.exitCode = 2;
  } else renderModel(file, cache, width, appearance === "dark")
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.stack); process.exitCode = 1; });
}
