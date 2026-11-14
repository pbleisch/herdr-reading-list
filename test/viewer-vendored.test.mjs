import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const viewer = fileURLToPath(new URL("../mods/readlist/viewer/", import.meta.url));
const VENDOR_DIRS = ["marked", "pdfjs", "three"];

async function vendoredTable() {
  const text = await fs.readFile(path.join(viewer, "VENDORED.md"), "utf8");
  return [...text.matchAll(/^\| `([^`]+)` \|.*\| `([0-9a-f]{64})` \|$/gm)].map(([, file, sha]) => ({ file, sha }));
}

// Relative module and asset specifiers a viewer file loads: static and dynamic imports, and
// shell.js's url("...") for the PDF.js worker.
function specifiers(source) {
  const found = [];
  for (const match of source.matchAll(/import\s*(?:([\s\S]*?)\s*from\s*)?\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const names = /^\{([\s\S]*)\}$/.exec(match[1]?.trim() ?? "")?.[1].split(",").map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean) ?? [];
    found.push({ spec: match[2], names });
  }
  for (const match of source.matchAll(/\burl\(\s*"((?:pdfjs|three|marked)\/[^"]+)"\s*\)/g)) found.push({ spec: `./${match[1]}`, names: [] });
  return found;
}

test("every vendored file is listed in VENDORED.md with a matching checksum", async () => {
  const table = await vendoredTable();
  assert.ok(table.length > 0, "VENDORED.md lists no files");
  for (const { file, sha } of table) {
    const bytes = await fs.readFile(path.join(viewer, file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha, `${file} does not match VENDORED.md`);
  }
  const listed = new Set(table.map(({ file }) => file));
  for (const dir of VENDOR_DIRS) {
    for (const name of await fs.readdir(path.join(viewer, dir))) {
      assert.ok(listed.has(`${dir}/${name}`), `${dir}/${name} is not listed in VENDORED.md`);
    }
    assert.ok(listed.has(`${dir}/LICENSE`), `${dir} has no LICENSE`);
  }
});

test("every module the viewer imports exists and exports the names it uses", async () => {
  const queue = ["shell.js", "markdown.mjs"];
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await fs.readFile(path.join(viewer, file), "utf8");
    for (const { spec, names } of specifiers(source)) {
      const target = path.posix.join(path.posix.dirname(file), spec);
      await fs.access(path.join(viewer, target)).catch(() => assert.fail(`${file} loads ${spec}, which is missing`));
      if (/\.m?js$/.test(target)) queue.push(target);
      if (names.length && VENDOR_DIRS.includes(target.split("/")[0])) {
        const exported = await import(pathToFileURL(path.join(viewer, target)).href);
        for (const name of names) assert.ok(name in exported, `${target} does not export ${name}, which ${file} imports`);
      }
    }
  }
  for (const needed of ["image-controls.js", "gltf-view.js", "three/three.min.js", "pdfjs/pdf.min.mjs", "pdfjs/pdf.worker.min.mjs", "marked/marked.esm.js"]) {
    assert.ok(seen.has(needed), `the import walk did not reach ${needed}`);
  }
});
