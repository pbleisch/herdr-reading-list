// Shared by the tests: the repo's folder, and whether this runner has the POSIX sh scripts'
// world. On Windows the mod runs its PowerShell scripts instead (bin/windows,
// handlers/windows.ps1), tested in windows.test.mjs; the tests of the sh scripts and the
// POSIX rl are skipped there.
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("..", import.meta.url));
export const WINDOWS = process.platform === "win32";
export const posix = WINDOWS ? { skip: "runs the POSIX sh scripts; Windows runs bin/windows (windows.test.mjs)" } : {};
