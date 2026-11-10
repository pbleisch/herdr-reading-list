// The host contract is URL based; this frontend has no Herdr or browser-launch code.
const frame = document.getElementById("document");
const title = document.getElementById("title");
const message = document.getElementById("message");
const base = new URL("./", location.href);
let revision = -1;

async function refresh() {
  try {
    const response = await fetch(new URL("state", base), { cache: "no-store" });
    if (!response.ok) throw new Error("The viewer host is unavailable.");
    const state = await response.json();
    if (state.revision !== revision) {
      revision = state.revision;
      title.textContent = state.title || "";
      frame.src = state.document || "about:blank";
      message.textContent = state.document ? "" : "No document selected.";
      message.hidden = Boolean(state.document);
    }
    await fetch(new URL("heartbeat", base), { method: "POST", cache: "no-store" });
  } catch {
    message.hidden = false;
    message.textContent = "The viewer host is unavailable. Use the preview in Herdr.";
  }
}

refresh();
setInterval(refresh, 1000);
addEventListener("pagehide", () => navigator.sendBeacon(new URL("goodbye", base)));
