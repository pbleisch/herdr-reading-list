import { test } from "node:test";
import assert from "node:assert/strict";
import { TAB, caseSensitive, findMatches, firstFrom, step, matchLabel, wrapRows, rowOf, segments } from "../mods/readlist/core/search.js";

const starts = (ms) => ms.map((m) => m.start);

test("smart case: case-insensitive unless the query has an uppercase letter", () => {
  assert.equal(caseSensitive("plan"), false);
  assert.equal(caseSensitive("Plan"), true);
  assert.equal(caseSensitive("über"), false);
  assert.equal(caseSensitive("Über"), true);
  assert.equal(caseSensitive("123 -"), false);
  const text = "Plan, plan, PLAN";
  assert.deepEqual(starts(findMatches(text, "plan")), [0, 6, 12]);
  assert.deepEqual(starts(findMatches(text, "Plan")), [0]);
  assert.deepEqual(starts(findMatches(text, "PLAN")), [12]);
});

test("findMatches is literal, in order and not overlapping", () => {
  assert.deepEqual(findMatches("a.b axb a.b", "a.b"), [{ start: 0, end: 3 }, { start: 8, end: 11 }]);
  assert.deepEqual(starts(findMatches("x(y) x(y)", "(y)")), [1, 6]);
  assert.deepEqual(starts(findMatches("aaaa", "aa")), [0, 2]);
  assert.deepEqual(findMatches("abc", ""), []);
  assert.deepEqual(findMatches("", "a"), []);
  assert.deepEqual(findMatches("abc", "z"), []);
});

test("findMatches keeps offsets in the original text when lowercasing changes length", () => {
  // "İ" lowercases to two code units; the offsets after it must still be the text's.
  const text = "İstanbul plan";
  const [m] = findMatches(text, "plan");
  assert.equal(text.slice(m.start, m.end), "plan");
  const [e] = findMatches("😀 Émile émile", "émile");
  assert.equal(e.start, 3);
  assert.deepEqual(starts(findMatches("😀 Émile émile", "émile")), [3, 9]);
});

test("firstFrom goes to the first match at or after the position, wrapping past the end", () => {
  const ms = findMatches("one two one two one", "one");
  assert.deepEqual(firstFrom(ms, 0), { index: 0, wrapped: false });
  assert.deepEqual(firstFrom(ms, 1), { index: 1, wrapped: false });
  assert.deepEqual(firstFrom(ms, 8), { index: 1, wrapped: false });
  assert.deepEqual(firstFrom(ms, 17), { index: 0, wrapped: true });
  assert.equal(firstFrom([], 0), null);
});

test("step goes next and previous in order, wrapping at both ends", () => {
  const ms = findMatches("a a a", "a");
  assert.deepEqual(step(ms, 0, 1), { index: 1, wrapped: false });
  assert.deepEqual(step(ms, 1, 1), { index: 2, wrapped: false });
  assert.deepEqual(step(ms, 2, 1), { index: 0, wrapped: true });
  assert.deepEqual(step(ms, 2, -1), { index: 1, wrapped: false });
  assert.deepEqual(step(ms, 0, -1), { index: 2, wrapped: true });
  assert.deepEqual(step(findMatches("a", "a"), 0, 1), { index: 0, wrapped: true });
  assert.equal(step([], 0, 1), null);
});

test("matchLabel says k of n, and when it wrapped", () => {
  const ms = findMatches("a a a", "a");
  assert.equal(matchLabel(ms, 0), "1 of 3");
  assert.equal(matchLabel(ms, 2, true), "3 of 3 · wrapped");
  assert.equal(matchLabel([], 0), "no matches");
});

test("wrapRows keeps lines and wraps long ones at a space or the width", () => {
  const rows = (text, cols) => wrapRows(text, cols).map((r) => text.slice(r.start, r.end));
  assert.deepEqual(rows("ab\n\ncd", 80), ["ab", "", "cd"]);
  assert.deepEqual(rows("", 80), [""]);
  assert.deepEqual(rows("trailing\n", 80), ["trailing", ""]);
  assert.deepEqual(rows("the quick brown fox jumps", 12), ["the quick ", "brown fox ", "jumps"]);
  assert.deepEqual(rows("abcdefghijklmnopqrst", 8), ["abcdefgh", "ijklmnop", "qrst"]);
  // A space early in the row is not worth the short row: cut at the width.
  assert.deepEqual(rows("a bcdefghijklmn", 8), ["a bcdefg", "hijklmn"]);
  // A tab takes TAB columns.
  assert.equal(TAB, 4);
  assert.deepEqual(rows("\t\tabcdefgh", 10), ["\t\tab", "cdefgh"]);
  // A surrogate pair stays whole.
  const smile = "abcdefg😀h";
  assert.deepEqual(rows(smile, 8), ["abcdefg😀", "h"]);
  // Rows cover the text: every offset but the line breaks is in exactly one row.
  const text = "x".repeat(50) + "\n" + "y ".repeat(40);
  const r = wrapRows(text, 17);
  assert.equal(r.reduce((n, row) => n + row.end - row.start, 0), text.length - 1);
});

test("rowOf finds the row holding an offset", () => {
  const text = "first line\nsecond\nthird line here";
  const rows = wrapRows(text, 80);
  assert.equal(rowOf(rows, 0), 0);
  assert.equal(rowOf(rows, 10), 0);
  assert.equal(rowOf(rows, 11), 1);
  assert.equal(rowOf(rows, text.indexOf("here")), 2);
});

test("segments mark every match and the current one, across a wrap too", () => {
  const text = "one two one\ttwo";
  const ms = findMatches(text, "two");
  const [row] = wrapRows(text, 80);
  assert.deepEqual(segments(text, row, ms, 1), [
    { text: "one ", mark: null },
    { text: "two", mark: "match" },
    { text: " one    ", mark: null },
    { text: "two", mark: "current" },
  ]);
  assert.deepEqual(segments(text, row, [], -1), [{ text: "one two one    two", mark: null }]);
  const long = "abcdefghij";
  const rows = wrapRows(long, 8);
  const hit = findMatches(long, "ghij");
  assert.deepEqual(segments(long, rows[0], hit, 0), [{ text: "abcdef", mark: null }, { text: "gh", mark: "current" }]);
  assert.deepEqual(segments(long, rows[1], hit, 0), [{ text: "ij", mark: "current" }]);
});

test("segments leave out a CRLF file's carriage returns", () => {
  const text = "one\r\ntwo\r\n";
  const rows = wrapRows(text, 80);
  assert.deepEqual(segments(text, rows[0], [], -1), [{ text: "one", mark: null }]);
  assert.deepEqual(segments(text, rows[2], [], -1), []);
});
