import { test } from "node:test";
import assert from "node:assert/strict";
import { STEP_MS, REARM_MS, WATCH_RETRY_MS, bounded, serial, follow } from "../mods/readlist/core/refresh.js";

// Lets pending promise callbacks run.
const tick = () => new Promise((r) => setImmediate(r));
const never = () => new Promise(() => {});

// A sleep the test ends by hand: each call is recorded with its ms and how to end it.
function clock() {
  const sleeps = [];
  const sleep = (ms) => new Promise((resolve) => sleeps.push({ ms, resolve }));
  return { sleeps, sleep };
}

test("the limits: a step outlasts exec's own 30 s, a watch is renewed less often than reloads", () => {
  assert.ok(STEP_MS > 30000);
  assert.ok(REARM_MS > STEP_MS);
  assert.equal(WATCH_RETRY_MS, 30000);
});

test("bounded answers with the call when it answers first", async () => {
  const { sleeps, sleep } = clock();
  assert.equal(await bounded(Promise.resolve("listed"), 1000, sleep), "listed");
  assert.deepEqual(sleeps.map((s) => s.ms), [1000]);
  // The limit passing afterwards changes nothing (and rejects nothing unhandled).
  sleeps[0].resolve();
  await tick();
  await assert.rejects(bounded(Promise.reject(new Error("exec failed")), 1000, sleep), /exec failed/);
});

test("bounded gives up on a call that never answers, naming it", async () => {
  const { sleeps, sleep } = clock();
  const p = bounded(never(), 60000, sleep, "Reading the inbox folder");
  await tick();
  sleeps[0].resolve();
  await assert.rejects(p, /^Error: Reading the inbox folder took longer than 60 s$/);
  const q = bounded(never(), 1500, sleep);
  sleeps[1].resolve();
  await assert.rejects(q, /^Error: Reading the list took longer than 2 s$/);
});

test("serial runs one pass at a time, and calls meanwhile ask for one more", async () => {
  const gates = [];
  const seen = [];
  const run = serial(async (arg) => {
    seen.push(arg);
    await new Promise((r) => gates.push(r));
  });
  const first = run("a");
  await tick();
  assert.equal(await run("b"), false);
  assert.equal(await run("c"), false);
  gates[0]();
  await tick();
  // b and c became one more pass, with the arguments of the call that runs the loop.
  assert.deepEqual(seen, ["a", "a"]);
  gates[1]();
  assert.equal(await first, true);
  assert.deepEqual(seen, ["a", "a"]);
  // Free again afterwards.
  const next = run("d");
  await tick();
  gates[2]();
  assert.equal(await next, true);
  assert.deepEqual(seen, ["a", "a", "d"]);
});

test("serial: more() asks for another pass from inside one", async () => {
  let passes = 0;
  const run = serial(async (_arg, more) => {
    passes++;
    if (passes < 3) more();
  });
  assert.equal(await run(), true);
  assert.equal(passes, 3);
});

test("serial: a failing pass rejects its call and frees the loop", async () => {
  let fail = true;
  let passes = 0;
  const run = serial(async () => {
    passes++;
    if (fail) throw new Error("no list");
  });
  await assert.rejects(run(), /no list/);
  fail = false;
  assert.equal(await run(), true);
  assert.equal(passes, 2);
});

// The stale sidebar: one reload whose call never answered held the loop, so the watch and the
// 30 s reload only asked for "one more" from then on and the copy never read the folder again.
test("serial: an unbounded call that never answers holds every later call", async () => {
  let reads = 0;
  const run = serial(async () => {
    reads++;
    await never();
  });
  run();
  await tick();
  for (let n = 0; n < 5; n++) assert.equal(await run(), false);
  assert.equal(reads, 1);
});

test("serial with bounded calls: a call that never answers frees the loop at the limit", async () => {
  const { sleeps, sleep } = clock();
  let reads = 0;
  let hang = true;
  const run = serial(async () => {
    reads++;
    await bounded(hang ? never() : Promise.resolve("listed"), STEP_MS, sleep);
  });
  const stuck = run();
  await tick();
  assert.equal(await run(), false);
  sleeps[0].resolve();
  // The pass gives up; the call that arrived meanwhile is dropped with it, like any failed pass.
  await assert.rejects(stuck, /took longer than 60 s/);
  hang = false;
  assert.equal(await run(), true);
  assert.equal(reads, 2);
});

// A FolderWatch stand-in: fire() resolves it with paths, refuse() rejects, cancel() resolves [].
function watcher() {
  const watches = [];
  const watch = () => {
    let fire, refuse;
    const w = new Promise((resolve, reject) => {
      fire = resolve;
      refuse = reject;
    });
    w.fire = (paths = ["/l/items"]) => fire(paths);
    w.refuse = () => refuse(new Error("too many watched folders"));
    w.cancelled = false;
    w.cancel = () => {
      w.cancelled = true;
      fire([]);
    };
    watches.push(w);
    return w;
  };
  return { watches, watch };
}

test("follow reloads after each batch of changes and watches again", async () => {
  const { sleeps, sleep } = clock();
  const { watches, watch } = watcher();
  let reloads = 0;
  follow(watch, async () => { reloads++; }, sleep, { rearmMs: 5000, retryMs: 700 });
  await tick();
  watches[0].fire();
  await tick();
  watches[1].fire();
  await tick();
  assert.equal(reloads, 2);
  assert.equal(watches.length, 3);
  assert.ok(sleeps.every((s) => s.ms === 5000));
});

test("follow replaces a watch that stayed quiet past rearmMs, without a reload", async () => {
  const { sleeps, sleep } = clock();
  const { watches, watch } = watcher();
  let reloads = 0;
  follow(watch, async () => { reloads++; }, sleep, { rearmMs: 5000, retryMs: 700 });
  await tick();
  sleeps[0].resolve();
  await tick();
  assert.equal(watches[0].cancelled, true);
  assert.equal(watches.length, 2);
  assert.equal(reloads, 0);
  // The fresh watch still delivers.
  watches[1].fire();
  await tick();
  assert.equal(reloads, 1);
});

test("follow tries again after a refusal instead of giving up on the watch", async () => {
  const { sleeps, sleep } = clock();
  const { watches, watch } = watcher();
  let reloads = 0;
  follow(watch, async () => { reloads++; }, sleep, { rearmMs: 5000, retryMs: 700 });
  await tick();
  watches[0].refuse();
  await tick();
  assert.equal(watches.length, 1);
  const retry = sleeps.find((s) => s.ms === 700);
  assert.ok(retry);
  retry.resolve();
  await tick();
  assert.equal(watches.length, 2);
  watches[1].fire();
  await tick();
  assert.equal(reloads, 1);
});

test("follow ends once sleep or the reload throws (the copy's build was replaced or closed)", async () => {
  const { watches, watch } = watcher();
  const gone = () => { throw new Error("context released"); };
  await assert.rejects(follow(watch, async () => {}, gone), /context released/);
  const { sleep } = clock();
  const { watches: w2, watch: watch2 } = watcher();
  const done = follow(watch2, async () => { throw new Error("context released"); }, sleep);
  await tick();
  w2[0].fire();
  await assert.rejects(done, /context released/);
  assert.equal(watches.length, 1);
});
