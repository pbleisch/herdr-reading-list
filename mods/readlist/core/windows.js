// Windows has no sh: there the mod runs its PowerShell 7 scripts in bin/windows (the helper
// readlist.ps1 for what the sh scripts do elsewhere, run-handler.ps1 for the handlers, and
// rl.ps1 with its rl.cmd and Git Bash shims), each with `pwsh -File` and every argument its
// own argv entry. Constants only, shared by the mod and the node tests.

export const PWSH = "pwsh";
// No profile (fast, and nothing of the person's runs), no prompts, and the mod's own scripts
// run whatever the execution policy (a downloaded mod's files may carry a web mark).
export const PWSH_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"];
// Under the mod's folder.
export const WIN_DIR = "bin/windows";
export const WIN_HELPER = `${WIN_DIR}/readlist.ps1`;
export const WIN_RUNNER = `${WIN_DIR}/run-handler.ps1`;
export const WIN_RL = `${WIN_DIR}/rl.ps1`;

// exec's error when pwsh cannot start: the list says it needs PowerShell 7.
export const noPwsh = (error) => /\bpwsh\b/i.test(error ?? "") && /not found|cannot start|cannot find|no such file|os error 2\b/i.test(error ?? "");

export const NEEDS_PWSH = "The reading list needs PowerShell 7 (pwsh) on Windows: https://aka.ms/powershell";
