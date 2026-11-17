// One frame of a local video as a PNG poster for the built-in preview, made with FFmpeg when it
// is installed. Cached by the file's real path, size and modification time under the cache
// folder given (appHome()/readlist-poster-cache), like the model posters.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pruneCache, touchEntry } from "./tile-cache.mjs";

const run = promisify(execFile);
export const VIDEO_EXT = new Set([".mp4", ".m4v", ".webm", ".mov"]);

export async function videoPoster(file, cache, ffmpeg = "ffmpeg") {
  const selected = await fs.realpath(file);
  if (!VIDEO_EXT.has(path.extname(selected).toLowerCase())) throw new Error("Unsupported video file extension");
  const stat = await fs.stat(selected);
  if (!stat.isFile()) throw new Error("Selected path is not a file");
  const key = createHash("sha256").update(JSON.stringify({ selected, size: stat.size, mtime: stat.mtimeMs, version: 1 })).digest("hex").slice(0, 20);
  const dir = path.join(cache, key), poster = path.join(dir, "poster.png");
  try {
    await fs.access(poster);
    await touchEntry(dir);
    return { key, cached: true };
  } catch { /* Make the poster. */ }
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `poster-${process.pid}.png`);
  try {
    // A frame half a second in (the first is often black), else the first one for a short clip.
    for (const at of ["0.5", "0"]) {
      try {
        await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", at, "-i", selected, "-frames:v", "1",
          "-vf", "scale='min(1280,iw)':-2", temp], { timeout: 15000 });
        if ((await fs.stat(temp)).size > 0) break;
      } catch (error) {
        if (error.code === "ENOENT") throw new Error("FFmpeg is not installed");
      }
    }
    try { await fs.rename(temp, poster); } catch { throw new Error("FFmpeg could not read a frame of this video"); }
  } catch (error) {
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
  await touchEntry(dir);
  await pruneCache(cache, [key]);
  return { key, cached: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, cache] = process.argv.slice(2);
  if (!file || !cache || !path.isAbsolute(file) || !path.isAbsolute(cache)) {
    console.error("Expected ABSOLUTE_VIDEO_FILE ABSOLUTE_CACHE_DIR");
    process.exitCode = 2;
  } else videoPoster(file, cache)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
