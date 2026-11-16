// The selected PDF's pages stacked at the window's width, for the tile renderer
// (render.mjs), which captures this page like an HTML document. Pages are drawn only
// around the tile being captured, so a long PDF never holds every page's canvas at once.
// PDF.js runs as in the shell: bundled, with PDF evaluation and XFA off.
export const MAX_PAGES = 100;
const GAP = 12, PAD = 12, KEEP = 3000;
const base = new URL("./", location.href);
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const pages = [];

async function layout() {
  const state = await (await fetch(new URL("state", base), { cache: "no-store" })).json();
  if (state.kind !== "pdf" || !state.document) throw new Error("No PDF is selected");
  const pdfjs = await import("./pdfjs/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs/pdf.worker.min.mjs", base).href;
  const pdf = await pdfjs.getDocument({ url: new URL(state.document, base).href, isEvalSupported: false, enableXfa: false }).promise;
  Object.assign(document.documentElement.style, { margin: "0", background: dark ? "#2a2c31" : "#e6e7ea" });
  Object.assign(document.body.style, { margin: "0", position: "relative" });
  const width = document.documentElement.clientWidth - 2 * PAD;
  const shown = Math.min(pdf.numPages, MAX_PAGES);
  let y = PAD;
  for (let n = 1; n <= shown; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const box = document.createElement("div");
    Object.assign(box.style, { position: "absolute", left: `${PAD}px`, top: `${y}px`, width: `${viewport.width}px`,
      height: `${viewport.height}px`, background: "white", boxShadow: "0 1px 6px #0005", overflow: "hidden" });
    document.body.append(box);
    pages.push({ page, viewport, box, y, canvas: null });
    y += viewport.height + GAP;
  }
  const height = Math.ceil(y - GAP + PAD);
  document.body.style.height = `${height}px`;
  return { height, pages: pdf.numPages, shown };
}

// Draws the pages that meet [top, top + height] and drops canvases far from it.
async function draw(top, height) {
  const scale = devicePixelRatio || 1;
  const work = [];
  for (const entry of pages) {
    const bottom = entry.y + entry.viewport.height;
    if (entry.canvas && (bottom < top - KEEP || entry.y > top + height + KEEP)) {
      entry.canvas.remove();
      entry.canvas = null;
    }
    if (entry.canvas || bottom < top || entry.y > top + height) continue;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(entry.viewport.width * scale);
    canvas.height = Math.ceil(entry.viewport.height * scale);
    Object.assign(canvas.style, { display: "block", width: `${entry.viewport.width}px`, height: `${entry.viewport.height}px` });
    entry.canvas = canvas;
    entry.box.append(canvas);
    work.push(entry.page.render({ canvasContext: canvas.getContext("2d"), viewport: entry.page.getViewport({ scale: entry.viewport.scale * scale }) }).promise);
  }
  await Promise.all(work);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

window.readlistPages = { ready: layout(), draw };
