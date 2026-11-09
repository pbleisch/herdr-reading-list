// Paths in both forms the list meets: POSIX (/home/me/a.md, macOS, Linux and other machines'
// items) and Windows (C:\Users\me\a.md). Pure functions, shared by the mod and the node tests.

// An absolute path on a Windows drive: C:\... or C:/... (not a network \\server or device
// \\?\ path).
export const isWinPath = (p) => typeof p === "string" && /^[A-Za-z]:[\\/]/.test(p);

// An absolute path in either form.
export const isAbsPath = (p) => typeof p === "string" && (p.startsWith("/") || isWinPath(p));

// An absolute path in the form `platform` uses: C:\... on Windows, /... elsewhere.
export const isLocalPath = (p, platform) => (platform === "windows" ? isWinPath(p) : typeof p === "string" && p.startsWith("/"));

// The last name in a path ("" for a root). A backslash separates names only in a Windows
// path: in a POSIX one it is part of a name.
export function baseName(p) {
  const s = String(p ?? "");
  const win = isWinPath(s);
  const trimmed = win ? s.replace(/[\\/]+$/, "") : s.replace(/\/+$/, "");
  return trimmed.split(win ? /[\\/]/ : "/").pop() ?? "";
}

// `base` (absolute) joined with relative parts written with "/": all backslashes when `base`
// is a Windows path, as written otherwise.
export function joinPath(base, ...parts) {
  const rel = parts.filter((x) => x !== "" && x != null).join("/");
  if (isWinPath(base)) {
    const b = base.replace(/\//g, "\\");
    return rel ? `${b.replace(/\\+$/, "")}\\${rel.replace(/\//g, "\\")}` : b;
  }
  return rel ? `${base}/${rel}` : base;
}
