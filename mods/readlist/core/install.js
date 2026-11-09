// Installing rl: the producer command ships inside the mod (bin/rl), and the "Install rl"
// action copies it to ~/.local/bin on this Mac. Pure functions and scripts, shared by the
// mod and the node tests. See docs/design.md 3.1.

// A line every copy of this rl carries; tells it from another program called rl.
export const MARK = "rl: put files and URLs on the person's Herdr reading list.";

const ours = `ours() { grep -qF "${MARK}" "$1" 2>/dev/null; }`;
const tilde = 'tilde() { case $1 in "$HOME"/*) printf "~/%s" "${1#"$HOME"/}" ;; *) printf "%s" "$1" ;; esac; }';

// What rl is like on this machine, one line `state<TAB>path`:
//   ok       the rl on PATH is this one
//   other    the rl on PATH is another program
//   offpath  ~/.local/bin/rl is this one, but ~/.local/bin is not on PATH
//   missing  no rl to be found
export const RL_STATUS_SCRIPT = [
  ours,
  tilde,
  'bin=$HOME/.local/bin; first=$(command -v rl 2>/dev/null)',
  'if [ -n "$first" ] && ours "$first"; then printf "ok\\t%s\\n" "$(tilde "$first")"',
  'elif [ -n "$first" ]; then printf "other\\t%s\\n" "$(tilde "$first")"',
  'elif ours "$bin/rl"; then printf "offpath\\t%s\\n" "$(tilde "$bin/rl")"',
  'else printf "missing\\t\\n"; fi',
].join("\n");

// Copies the rl at $1 to ~/.local/bin/rl. Never replaces another program or a link (the
// dev install's link into a checkout), and never writes through one. One line
// `result<TAB>~/.local/bin/rl<TAB>on PATH (1 or 0)<TAB>the rl PATH finds first`:
//   installed  copied; nothing was there
//   updated    replaced an older copy of this rl
//   same       already there, the same file (or a link to it)
//   other      another program is there; left as it is
//   link       a link to another copy is there; left as it is
//   error      the copy failed (the line's second field says why)
export const INSTALL_RL_SCRIPT = [
  ours,
  tilde,
  'src=$1; bin=$HOME/.local/bin; dest=$bin/rl',
  '[ -f "$src" ] || { printf "error\\tthe mod\'s rl is missing: %s\\n" "$src"; exit 0; }',
  'result=installed',
  'if [ -L "$dest" ] || [ -e "$dest" ]; then',
  '  if cmp -s "$src" "$dest"; then result=same',
  '  elif [ -L "$dest" ]; then result=link',
  '  elif ours "$dest"; then result=updated',
  '  else result=other; fi',
  'fi',
  'case $result in installed | updated)',
  '  mkdir -p "$bin" && tmp=$bin/.rl.$$ && cp "$src" "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$dest" ||',
  '    { rm -f "$bin/.rl.$$"; printf "error\\tcould not write %s\\n" "$(tilde "$dest")"; exit 0; } ;;',
  'esac',
  'case ":$PATH:" in *":$bin:"* | *":$bin/:"*) on=1 ;; *) on=0 ;; esac',
  'printf "%s\\t%s\\t%s\\t%s\\n" "$result" "$(tilde "$dest")" "$on" "$(tilde "$(command -v rl 2>/dev/null)")"',
].join("\n");

// RL_STATUS_SCRIPT's line as { state, path }; anything unreadable is "unknown" (no banner).
export function parseRlStatus(stdout) {
  const [state, path = ""] = (stdout ?? "").trim().split("\t");
  return ["ok", "other", "offpath", "missing"].includes(state) ? { state, path } : { state: "unknown", path: "" };
}

// The banner over the list while rl cannot be used from a terminal here, or null.
// { text, button } where button is "install" or null.
export function rlBanner(status) {
  switch (status?.state) {
    case "missing":
      return { text: "Agents add to this list with rl, which is not installed.", button: "install" };
    case "other":
      return { text: `The rl on your PATH (${status.path}) is another program.`, button: "install" };
    case "offpath":
      return { text: "rl is in ~/.local/bin, which is not on your PATH. Add it to PATH in your shell profile.", button: null };
    default:
      return null;
  }
}

// INSTALL_RL_SCRIPT's line as the toast to show: { body, level }.
export function installToast(stdout) {
  const [result, dest = "", on = "0", first = ""] = (stdout ?? "").trim().split("\t");
  const where = on === "1" ? "" : " ~/.local/bin is not on your PATH: add it in your shell profile so agents find rl.";
  const shadow = on === "1" && first && first !== dest ? ` Another rl comes first on PATH (${first}).` : "";
  switch (result) {
    case "installed":
      return { body: `Installed rl at ${dest}.${where}${shadow}`, level: on === "1" && !shadow ? "success" : "warning" };
    case "updated":
      return { body: `Updated rl at ${dest} to this version.${where}${shadow}`, level: on === "1" && !shadow ? "success" : "warning" };
    case "same":
      return { body: `rl at ${dest} is already this version.${where}${shadow}`, level: on === "1" && !shadow ? "info" : "warning" };
    case "other":
      return { body: `${dest} is another program called rl; left as it is. Move it aside and install again.`, level: "warning" };
    case "link":
      return { body: `${dest} is a link to another copy of rl; left as it is.`, level: "warning" };
    case "error":
      return { body: `Couldn't install rl: ${dest}`, level: "error" };
    default:
      return { body: `Couldn't install rl: ${(stdout ?? "").trim() || "no answer from the install script"}`, level: "error" };
  }
}
