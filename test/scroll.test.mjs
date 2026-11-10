import { test } from "node:test";
import assert from "node:assert/strict";
import { SCROLL_KEYS, LINE, MIN_THUMB, maxOffset, clampOffset, keyOffset, wheelOffset, centerOffset, visibleRows, thumb, trackOffset } from "../mods/readlist/core/scroll.js";
import { readableHtml, htmlText } from "../mods/readlist/core/preview.js";
import { findMatches, wrapRows, rowOf } from "../mods/readlist/core/search.js";

const v = (offset, view = 500, content = 3000) => ({ offset, view, content });

test("the offset stays between the top and the last page", () => {
  assert.equal(maxOffset(v(0)), 2500);
  assert.equal(maxOffset(v(0, 500, 300)), 0);
  assert.equal(clampOffset(-20, v(0)), 0);
  assert.equal(clampOffset(9999, v(0)), 2500);
  assert.equal(clampOffset(NaN, v(0)), 0);
  assert.equal(clampOffset(120, v(0, 500, 300)), 0, "text that fits does not scroll");
});

test("j, k and the arrows move a line; Space, Page Down and Page Up a page that keeps a line", () => {
  assert.equal(keyOffset("j", v(0)), LINE);
  assert.equal(keyOffset("down", v(100)), 100 + LINE);
  assert.equal(keyOffset("k", v(100)), 100 - LINE);
  assert.equal(keyOffset("up", v(10)), 0);
  assert.equal(keyOffset("space", v(0)), 500 - LINE);
  assert.equal(keyOffset("pagedown", v(0)), 500 - LINE);
  assert.equal(keyOffset("shift-space", v(1000)), 1000 - (500 - LINE));
  assert.equal(keyOffset("pageup", v(100)), 0);
  assert.equal(keyOffset("pagedown", v(2400)), 2500, "stops at the last page");
  assert.equal(keyOffset("ctrl-d", v(0)), 250);
  assert.equal(keyOffset("ctrl-u", v(1000)), 750);
});

test("g and Home go to the top, Shift-G and End to the bottom", () => {
  assert.equal(keyOffset("g", v(1234)), 0);
  assert.equal(keyOffset("home", v(1234)), 0);
  assert.equal(keyOffset("shift-g", v(0)), 2500);
  assert.equal(keyOffset("end", v(0)), 2500);
  assert.equal(keyOffset("shift-g", v(0, 500, 200)), 0);
});

test("other keys are not scroll keys, and the search keys are left alone", () => {
  for (const k of ["n", "shift-n", "/", "escape", "v", "enter", "x"]) {
    assert.equal(keyOffset(k, v(0)), null, k);
    assert.equal(SCROLL_KEYS[k], undefined, k);
  }
});

test("a tiny box still pages by a line", () => {
  assert.equal(keyOffset("space", v(0, 20, 3000)), LINE);
});

test("the wheel and the trackpad move the text with GPUI's sign", () => {
  assert.equal(wheelOffset(-120, v(0)), 120, "a move down shows what is below");
  assert.equal(wheelOffset(50, v(100)), 50);
  assert.equal(wheelOffset(500, v(100)), 0);
  assert.equal(wheelOffset(-9999, v(100)), 2500);
  assert.equal(wheelOffset(undefined, v(100)), 100);
});

test("centerOffset puts a span in the middle, as near as the ends allow", () => {
  assert.equal(centerOffset(1000, 1018, v(0)), 1009 - 250);
  assert.equal(centerOffset(10, 28, v(900)), 0);
  assert.equal(centerOffset(2990, 3000, v(0)), 2500);
});

test("visibleRows covers the box and no more", () => {
  assert.deepEqual(visibleRows(v(0, 100), 18, 1000, 6), { start: 0, end: 6 });
  assert.deepEqual(visibleRows(v(360, 100), 18, 1000, 6), { start: 19, end: 26 });
  assert.deepEqual(visibleRows(v(0, 100), 18, 3, 6), { start: 0, end: 3 });
  assert.deepEqual(visibleRows(v(0, 0), 18, 1000, 6), { start: 0, end: 0 });
  // Every row drawn overlaps the box, and every row overlapping it is drawn.
  const box = v(1234, 321);
  const { start, end } = visibleRows(box, 18, 1000, 6);
  for (let i = start - 1; i <= end; i++) {
    const top = 6 + i * 18, bottom = top + 18;
    const overlaps = bottom > box.offset && top < box.offset + box.view;
    assert.equal(i >= start && i < end, overlaps, `row ${i}`);
  }
});

test("the thumb shows the share on screen and where it is", () => {
  assert.equal(thumb(v(0, 500, 400)), null, "no thumb when the text fits");
  assert.equal(thumb(v(0, 0, 400)), null);
  assert.deepEqual(thumb(v(0, 500, 1000)), { top: 0, height: 250 });
  assert.deepEqual(thumb(v(500, 500, 1000)), { top: 250, height: 250 });
  const long = thumb(v(0, 500, 1e6));
  assert.equal(long.height, MIN_THUMB);
  assert.equal(thumb(v(maxOffset(v(0, 500, 1e6)), 500, 1e6)).top, 500 - MIN_THUMB);
});

test("a click on the track pages toward it; on the thumb it does nothing", () => {
  assert.equal(trackOffset(400, v(0, 500, 1000)), 500 - LINE);
  assert.equal(trackOffset(10, v(500, 500, 1000)), 500 - (500 - LINE));
  assert.equal(trackOffset(100, v(0, 500, 1000)), null);
  assert.equal(trackOffset(100, v(0, 500, 400)), null);
});

test("readableHtml keeps the body's text and leaves out what is not text", () => {
  const html = `<!doctype html><html><head><title>T</title><style>body { color: red }</style>
    <script>var x = "<p>no</p>";</script></head>
    <body class="b"><h1>Report</h1><!-- a note --><p>Hello <b>you</b></p>
    <svg viewBox="0 0 1 1"><text>chart label</text></svg><noscript>enable js</noscript>
    <template><p>later</p></template><p>Bye</p></body></html>`;
  const out = readableHtml(html);
  assert.match(out, /<h1>Report<\/h1>/);
  assert.match(out, /<p>Hello <b>you<\/b><\/p>/);
  assert.match(out, /<p>Bye<\/p>/);
  for (const gone of ["color: red", "var x", "a note", "chart label", "enable js", "later", "<title>", "<body"]) {
    assert.ok(!out.includes(gone), gone);
  }
});

test("readableHtml takes a fragment as it is, and a cut-off page up to its end", () => {
  assert.equal(readableHtml("<p>a</p>"), "<p>a</p>");
  assert.equal(readableHtml("<!DOCTYPE html><html><p>a</p></html>"), "<p>a</p>");
  assert.equal(readableHtml("<body><p>a</p><p>b"), "<p>a</p><p>b");
  assert.equal(readableHtml("<p>a</p><script>never closed"), "<p>a</p>");
  assert.equal(readableHtml("<p>a</p><!-- never closed"), "<p>a</p>");
  assert.equal(readableHtml(null), "");
});

test("htmlText is the page's text: lines per block, entities decoded, spaces collapsed", () => {
  const html = `<html><head><style>p{}</style></head><body>
    <h2>Plan &amp; status</h2>
    <p>One   two<br>three&nbsp;&mdash;&#32;four &#x2192; &lt;b&gt; &unknown;</p>
    <ul><li>first</li><li>second</li></ul>
    <table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
    <div>end</div></body></html>`;
  assert.equal(htmlText(html), [
    "Plan & status", "", "One two", "three — four → <b> &unknown;", "", "• first", "", "• second", "", "a b", "", "1 2", "", "end",
  ].join("\n"));
});

test("a long HTML page: a match far down is found, and centering it puts it on screen", () => {
  const sections = Array.from({ length: 400 }, (_, i) => `<section><h3>Section ${i}</h3><p>Body text of section ${i}, with enough words to wrap on a narrow pane.</p></section>`);
  sections[371] = "<section><h3>Section 371</h3><p>The needle is here.</p></section>";
  const text = htmlText(`<html><body>${sections.join("\n")}</body></html>`);
  const ms = findMatches(text, "needle");
  assert.equal(ms.length, 1);
  const rows = wrapRows(text, 40);
  const L = 18, pad = 6;
  const content = rows.length * L + 2 * pad;
  const row = rowOf(rows, ms[0].start);
  const box = { offset: 0, view: 400, content };
  box.offset = centerOffset(pad + row * L, pad + row * L + L, box);
  assert.ok(box.offset > 0 && box.offset < maxOffset(box));
  const { start, end } = visibleRows(box, L, rows.length, pad);
  assert.ok(row >= start && row < end, `row ${row} in ${start}..${end}`);
  // And the keys reach both ends of it.
  assert.equal(keyOffset("shift-g", box), content - 400);
  assert.equal(keyOffset("g", box), 0);
});
