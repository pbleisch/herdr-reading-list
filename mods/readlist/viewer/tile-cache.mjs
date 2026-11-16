// Rendered HTML lives under appHome()/readlist-tile-cache, outside the watched mod.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const CACHE_LIMIT = 256 * 1024 * 1024;

export async function cacheKey(selected, files, width, scale, dark) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ selected, width, scale, dark, version: 1 }));
  for (const [name, entry] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name);
    hash.update(await fs.readFile(entry.target));
  }
  return hash.digest("hex").slice(0, 20);
}

// Only HTML and Markdown pages in the viewer host's selected-file manifest become pane links.
export function mapCapturedLinks(links, documentPrefix, files) {
  return links.filter((link) => link.href?.startsWith(documentPrefix)).flatMap((link) => {
    let name;
    try { name = decodeURIComponent(link.href.slice(documentPrefix.length).split(/[?#]/)[0]); }
    catch { return []; }
    const entry = files.get(name);
    return entry?.mime === "text/html" || entry?.mime === "text/markdown" ? [{ ...link, target: entry.target }] : [];
  });
}

async function bytesIn(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isFile()) total += (await fs.stat(file)).size;
  }
  return total;
}

// Each entry is one flat directory. Directory mtime is the last successful use.
export async function pruneCache(root, keep = [], limit = CACHE_LIMIT) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const candidates = [];
  let total = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const stat = await fs.stat(dir);
    const bytes = await bytesIn(dir);
    total += bytes;
    if (!keep.includes(entry.name)) candidates.push({ dir, bytes, used: stat.mtimeMs });
  }
  candidates.sort((a, b) => a.used - b.used);
  for (const entry of candidates) {
    if (total <= limit) break;
    await fs.rm(entry.dir, { recursive: true, force: true });
    total -= entry.bytes;
  }
}

export async function touchEntry(dir) {
  const now = new Date();
  await fs.utimes(dir, now, now);
}
