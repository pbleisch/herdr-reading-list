// Keeping a long-lived copy of the list current (docs/design.md 4.2): the folder watch, and the
// loops that read or write the list one pass at a time, which no call that never answers may
// hold forever. Pure functions with their waits passed in (`cx.sleep` in the mod: Herdr has no
// setTimeout), shared by the mod and the node tests.

// The longest one read or write of the list may take. `exec` gives up after 30 s by itself, but
// a call that never answers (an exec whose answer is lost, readTextFile, writeTextFile) would
// otherwise hold its loop, and with it every later reload, for as long as the copy lives.
export const STEP_MS = 60000;
// A watch that has not fired for this long is replaced by a fresh one: Herdr may reclaim idle
// watches to make room for other folders.
export const REARM_MS = 300000;
// How long after watchFolder refuses (64 folders already watched, or a tree too big on Linux)
// the watch is tried again. The 30 s reload covers the time between.
export const WATCH_RETRY_MS = 30000;

// `promise`, or a rejection naming `what` once `ms` have passed (`sleep(ms)` resolves then).
export function bounded(promise, ms, sleep, what = "Reading the list") {
  const late = Promise.resolve(sleep(ms)).then(() => {
    throw new Error(`${what} took longer than ${Math.round(ms / 1000)} s`);
  });
  return Promise.race([promise, late]);
}

// One pass of `pass(arg, more)` at a time: a call while a pass runs asks for one more pass after
// it (as does `more()` from inside a pass), and resolves false at once; the call that ran the
// passes resolves true, or rejects with the first pass's error. Bound each pass's calls with
// `bounded`, or one that never answers holds every later call.
export function serial(pass) {
  let running = false;
  let again = false;
  const more = () => {
    again = true;
  };
  return async (arg) => {
    if (running) {
      again = true;
      return false;
    }
    running = true;
    try {
      do {
        again = false;
        await pass(arg, more);
      } while (again);
    } finally {
      running = false;
    }
    return true;
  };
}

// Follows a folder with `watch()` (watchFolder on it): `changed()` after each batch of changes,
// a fresh watch after `rearmMs` without one (the old one cancelled), and another try `retryMs`
// after a refusal. Runs until `sleep` or `changed` throws, as the mod's cx does once its build is
// replaced or the copy closes.
export async function follow(watch, changed, sleep, { rearmMs = REARM_MS, retryMs = WATCH_RETRY_MS } = {}) {
  for (;;) {
    let fired;
    try {
      const w = watch();
      fired = await Promise.race([w.then(() => true), Promise.resolve(sleep(rearmMs)).then(() => false)]);
      if (!fired) w.cancel?.();
    } catch {
      await sleep(retryMs);
      continue;
    }
    if (fired) await changed();
  }
}
