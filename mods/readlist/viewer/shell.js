// The host contract is URL based; this frontend has no Herdr or browser-launch code.
import { installImageControls } from "./image-controls.js";
const $ = (id) => document.getElementById(id);
const frame = $("document"), title = $("title"), message = $("message");
const toolbar = $("pdf-toolbar"), pdfStage = $("pdf-stage"), pdfPage = $("pdf-page");
const canvas = $("pdf-canvas"), textLayer = $("pdf-text");
const videoStage = $("video-stage"), video = $("video"), unsupported = $("unsupported"), poster = $("poster");
const imageStage = $("image-stage"), stillImage = $("still-image"), modelStage = $("model-stage");
const imageToolbar = $("image-toolbar"), modelToolbar = $("model-toolbar");
const imageControls = installImageControls(imageStage, stillImage,
  [$("image-fit"), $("image-actual"), $("image-minus"), $("image-plus"), $("image-rotate"), $("image-zoom")]);
const base = new URL("./", location.href);
let revision = -1, generation = 0, renderSequence = 0, searchRun = 0, refreshing = false;
let modelSession = null;
let pdfjs, pdf, loadingTask, renderTask, page = 1, zoom = 1;
let pageText = "", matches = [], matchIndex = -1, searchQuery = "";

function show(element) {
  for (const part of [frame, pdfStage, videoStage, imageStage, modelStage, unsupported, message]) part.hidden = part !== element;
  toolbar.hidden = element !== pdfStage;
  imageToolbar.hidden = element !== imageStage;
  modelToolbar.hidden = element !== modelStage;
}

function status(text) { message.textContent = text; show(message); }
function url(route) { return new URL(route, base); }

function clearCurrent() {
  generation++;
  renderSequence++;
  searchRun++;
  renderTask?.cancel();
  renderTask = null;
  loadingTask?.destroy();
  loadingTask = null;
  pdf = null;
  pageText = "";
  video.onerror = null;
  video.pause();
  video.removeAttribute("src");
  video.load();
  imageControls.clear();
  stillImage.onerror = null;
  modelSession?.dispose();
  modelSession = null;
  modelStage.dataset.ready = "";
  frame.onerror = null;
  frame.src = "about:blank";
  poster.hidden = true;
  unsupported.querySelector("p").textContent = "This browser cannot play this video format.";
  textLayer.replaceChildren();
  matches = [];
  matchIndex = -1;
  searchQuery = "";
  $("pdf-search").value = "";
  $("search-count").textContent = "";
}

async function renderPage() {
  if (!pdf) return;
  const selected = generation;
  const sequence = ++renderSequence;
  const previous = renderTask;
  previous?.cancel();
  if (previous) await previous.promise.catch(() => {});
  if (selected !== generation || sequence !== renderSequence) return;
  const thisPage = await pdf.getPage(page);
  if (selected !== generation || sequence !== renderSequence) return;
  const viewport = thisPage.getViewport({ scale: zoom });
  const ratio = devicePixelRatio || 1;
  canvas.width = Math.ceil(viewport.width * ratio);
  canvas.height = Math.ceil(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  pdfPage.style.width = `${viewport.width}px`;
  pdfPage.style.height = `${viewport.height}px`;
  textLayer.replaceChildren();
  const context = canvas.getContext("2d");
  renderTask = thisPage.render({ canvasContext: context, viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
  try { await renderTask.promise; } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
    return;
  }
  if (selected !== generation || sequence !== renderSequence) return;
  const content = await thisPage.getTextContent();
  if (selected !== generation || sequence !== renderSequence) return;
  pageText = content.items.map((item) => item.str + (item.hasEOL ? "\n" : "")).join("");
  await new pdfjs.TextLayer({ textContentSource: content, container: textLayer, viewport }).render();
  if (selected !== generation || sequence !== renderSequence) return;
  for (const span of textLayer.querySelectorAll("span")) span.classList.toggle("match", Boolean(searchQuery) && span.textContent.toLocaleLowerCase().includes(searchQuery));
  $("page-number").value = String(page);
  $("page-number").max = String(pdf.numPages);
  $("page-count").textContent = `/ ${pdf.numPages}`;
  $("previous-page").disabled = page <= 1;
  $("next-page").disabled = page >= pdf.numPages;
  $("zoom-value").textContent = `${Math.round(zoom * 100)}%`;
}

async function goToPage(number) {
  if (!pdf || !Number.isInteger(number)) return;
  page = Math.max(1, Math.min(pdf.numPages, number));
  pdfStage.scrollTo(0, 0);
  try { await renderPage(); } catch { status("This PDF page could not be rendered."); }
}

async function openPdf(documentUrl, selected) {
  status("Loading PDF…");
  pdfjs ||= await import("./pdfjs/pdf.min.mjs");
  if (selected !== generation) return;
  pdfjs.GlobalWorkerOptions.workerSrc = url("pdfjs/pdf.worker.min.mjs").href;
  loadingTask = pdfjs.getDocument({ url: documentUrl.href, isEvalSupported: false, enableXfa: false });
  pdf = await loadingTask.promise;
  if (selected !== generation) return;
  page = 1;
  zoom = 1;
  show(pdfStage);
  await goToPage(1);
}

function videoUnsupported(selected) {
  if (selected !== generation) return;
  video.pause();
  show(unsupported);
  poster.src = url("poster").href;
}

function openVideo(documentUrl, selected) {
  show(videoStage);
  video.onerror = () => videoUnsupported(selected);
  video.src = documentUrl.href;
  video.load();
}

function openImage(documentUrl, selected) {
  show(imageStage);
  stillImage.onerror = () => { if (selected === generation) status("This browser cannot decode this image format."); };
  imageControls.open(documentUrl.href);
}

async function openGltf(documentUrl, selected) {
  if (!/\.(glb|gltf)$/i.test(documentUrl.pathname)) return status("This 3D file extension is unsupported.");
  status("Loading 3D model…");
  const { createModelView } = await import("./gltf-view.js");
  if (selected !== generation) return;
  show(modelStage);
  try {
    modelSession = createModelView(modelStage, documentUrl.href, $("model-reset"), (text) => {
      if (selected === generation) status(text);
    });
    await modelSession.ready;
    if (selected === generation) modelStage.dataset.ready = "true";
  } catch (error) {
    if (selected !== generation) return;
    modelSession?.dispose();
    modelSession = null;
    status(/WebGL/.test(error?.message ?? "") ? error.message : "This 3D model could not be opened. Check its local buffers, textures and supported glTF extensions.");
    modelStage.dataset.ready = "error";
  }
}

async function applyState(state) {
  clearCurrent();
  const selected = generation;
  title.textContent = state.title || "";
  if (!state.document) return status("No document selected.");
  const documentUrl = url(state.document);
  if (state.kind === "html" || state.kind === "markdown") {
    const failed = () => { if (selected === generation) status("Could not render this document. Check that the file is still available."); };
    try {
      const response = await fetch(documentUrl, { method: "HEAD", cache: "no-store" });
      if (selected !== generation) return;
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/html")) return failed();
      frame.onerror = failed;
      frame.src = documentUrl.href;
      return show(frame);
    } catch { return failed(); }
  }
  if (state.kind === "video") return openVideo(documentUrl, selected);
  if (state.kind === "image") return openImage(documentUrl, selected);
  if (state.kind === "gltf") return openGltf(documentUrl, selected);
  if (state.kind === "pdf") {
    try { return await openPdf(documentUrl, selected); }
    catch { if (selected === generation) status("This PDF could not be opened."); }
  }
  status("This file extension is unsupported by the viewer.");
}

async function searchPdf(event) {
  event.preventDefault();
  if (!pdf) return;
  const selected = generation;
  const run = ++searchRun;
  searchQuery = $("pdf-search").value.trim().toLocaleLowerCase();
  matches = [];
  matchIndex = -1;
  if (!searchQuery) { $("search-count").textContent = ""; return renderPage(); }
  $("search-count").textContent = "Searching…";
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    if (selected !== generation || run !== searchRun) return;
    const text = content.items.map((item) => item.str + (item.hasEOL ? "\n" : "")).join("").toLocaleLowerCase();
    for (let at = text.indexOf(searchQuery); at !== -1; at = text.indexOf(searchQuery, at + Math.max(1, searchQuery.length))) {
      matches.push(n);
    }
  }
  if (selected !== generation || run !== searchRun) return;
  if (!matches.length) { $("search-count").textContent = "No matches"; return renderPage(); }
  await nextMatch();
}

async function nextMatch() {
  if (!matches.length) return;
  matchIndex = (matchIndex + 1) % matches.length;
  $("search-count").textContent = `${matchIndex + 1} of ${matches.length}`;
  await goToPage(matches[matchIndex]);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch(url("state"), { cache: "no-store" });
    if (!response.ok) throw new Error("The viewer host is unavailable.");
    const state = await response.json();
    if (state.revision !== revision) {
      revision = state.revision;
      applyState(state).catch(() => { if (revision === state.revision) status("Could not display this item."); });
    }
    await fetch(url("heartbeat"), { method: "POST", cache: "no-store" });
  } catch { status("The viewer host is unavailable. Use the preview in Herdr."); }
  finally { refreshing = false; }
}

$("previous-page").onclick = () => goToPage(page - 1);
$("next-page").onclick = () => goToPage(page + 1);
$("page-number").onchange = () => goToPage(Number($("page-number").value));
$("zoom-out").onclick = () => { zoom = Math.max(0.5, zoom - 0.25); renderPage(); };
$("zoom-in").onclick = () => { zoom = Math.min(3, zoom + 0.25); renderPage(); };
$("pdf-search-form").onsubmit = searchPdf;
$("next-match").onclick = nextMatch;
$("copy-text").onclick = async () => {
  const text = getSelection()?.toString() || pageText;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); $("search-count").textContent = "Copied"; }
  catch { $("search-count").textContent = "Select text and use Copy"; }
};
poster.onload = () => { poster.hidden = false; };
poster.onerror = () => { poster.hidden = true; };
$("open-default").onclick = async () => {
  try {
    const response = await fetch(url("open-default"), { method: "POST" });
    if (!response.ok) throw new Error();
  } catch { unsupported.querySelector("p").textContent = "Could not open this video in the default app."; }
};

refresh();
setInterval(refresh, 1000);
addEventListener("pagehide", () => navigator.sendBeacon(url("goodbye")));
