// What differs between the platforms Herdr runs on, apart from the actions themselves:
// the words for the platform's things, and the file types that run rather than open. The
// actions (open, reveal, the Space preview, thumbnails) are handlers, one built in per
// platform (core/handlers.js, handlers/). Pure functions and constants, shared by the mod
// and the node tests. See docs/design.md 4.5 and 4.7.

// The platform from Herdr's window() (`linux`, `macos` or `windows`). Anything else is taken
// as macOS, which is what the mod did before it knew about other platforms.
export function platformOf(win) {
  const p = win?.platform;
  return p === "linux" || p === "windows" ? p : "macos";
}

// The words that name the platform's things in toasts and the pane.
const WORDS = {
  macos: { files: "Finder", here: "this Mac", look: "Quick Look" },
  linux: { files: "the file manager", here: "this computer", look: "the quick preview" },
  windows: { files: "Explorer", here: "this computer", look: "the quick preview" },
};
export const words = (platform) => WORDS[platform] ?? WORDS.macos;

// File types Linux desktops run or install rather than show when opened, on top of the ones
// in core/items.js RUNS (docs/design.md 8).
export const LINUX_RUNS = new Set(["desktop", "appimage", "run", "bin", "deb", "rpm", "snap", "flatpak", "flatpakref", "flatpakrepo"]);

// File types Windows runs, installs, mounts or hands to a script host rather than shows when
// opened, on top of RUNS (docs/design.md 8). handlers/windows.ps1 refuses to open these and
// any type in PATHEXT.
export const WINDOWS_RUNS = new Set([
  "com", "psm1", "psd1", "ps1xml", "msp", "mst", "msix", "msixbundle", "appx", "appxbundle", "appinstaller",
  "application", "appref-ms", "lnk", "website", "pif", "cpl", "msc", "inf", "reg", "vbe", "js", "jse", "wsf",
  "wsh", "wsc", "ws", "hta", "chm", "gadget", "scf", "settingcontent-ms", "library-ms", "search-ms",
  "searchconnector-ms", "diagcab", "msh", "msh1", "msh2", "mshxml", "iso", "img", "vhd", "vhdx", "xll",
]);

// Space when no handler showed a preview window: why, in one line, for the toast. `reason`
// is what the built-in handler said when it passed (Linux: Sushi or gdbus is missing).
export function noQuickLook(reason) {
  if (reason) return `${reason}; showing the preview here instead.`;
  return "There is no quick preview on this platform yet; the preview here shows the file.";
}
