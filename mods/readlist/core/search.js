// Search in the viewer pane: `/` finds text in the item it shows, `n` and Shift-N go to the
// next and previous match, like `less`. Pure functions, shared by the mod and the node tests.
// See docs/design.md 4.3.
//
// While a search is on, the viewer draws the text itself, as rows of at most `cols`
// characters, so it can mark every match and scroll to the current one (TextView and Editor
// can do neither). Offsets are UTF-16 code units into the text, as JavaScript strings count.

// Case-insensitive unless the query has an uppercase letter (smart case).
export const caseSensitive = (query) => /\p{Lu}/u.test(query ?? "");

// Lowercases each code point whose lowercase is the same length, so offsets in the folded
// text are offsets in the original (a few letters, such as "İ", lowercase longer).
function fold(s) {
  let out = "";
  for (const c of s) {
    const l = c.toLowerCase();
    out += l.length === c.length ? l : c;
  }
  return out;
}

// Every match of `query` in `text`, literal (not a pattern), in order, not overlapping:
// [{ start, end }].
export function findMatches(text, query) {
  if (!query || !text) return [];
  const sensitive = caseSensitive(query);
  const hay = sensitive ? text : fold(text);
  const needle = sensitive ? query : fold(query);
  const out = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    out.push({ start: at, end: at + needle.length });
  }
  return out;
}

// The first match at or after `pos`, else the first one (wrapped): { index, wrapped }, or
// null when there is none.
export function firstFrom(matches, pos) {
  if (!matches.length) return null;
  const i = matches.findIndex((m) => m.start >= pos);
  return i === -1 ? { index: 0, wrapped: true } : { index: i, wrapped: false };
}

// The next (`dir` 1) or previous (-1) match from `index`, wrapping at either end:
// { index, wrapped }, or null when there is none.
export function step(matches, index, dir) {
  const n = matches.length;
  if (!n) return null;
  const next = index + (dir < 0 ? -1 : 1);
  if (next >= n) return { index: 0, wrapped: true };
  if (next < 0) return { index: n - 1, wrapped: true };
  return { index: next, wrapped: false };
}

// What the search bar says: "3 of 12", with "wrapped" after a wrap.
export function matchLabel(matches, index, wrapped = false) {
  if (!matches.length) return "no matches";
  return `${index + 1} of ${matches.length}${wrapped ? " · wrapped" : ""}`;
}

// A tab is drawn as this many spaces.
export const TAB = 4;

const width = (c) => (c === "\t" ? TAB : 1);

// The text as display rows of at most `cols` columns: [{ start, end }] (end excludes the
// line break). A line longer than `cols` wraps after its last space in the row when that
// space is past half the row, else at `cols`; a surrogate pair is never split.
export function wrapRows(text, cols) {
  const max = Math.max(8, Math.floor(cols) || 0);
  const rows = [];
  let lineStart = 0;
  for (;;) {
    const nl = text.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    let start = lineStart;
    for (;;) {
      let col = 0, i = start, space = -1;
      while (i < lineEnd) {
        const pair = text.charCodeAt(i) >= 0xd800 && text.charCodeAt(i) <= 0xdbff && i + 1 < lineEnd;
        const w = width(text[i]);
        if (col + w > max && i > start) break;
        col += w;
        if (text[i] === " " || text[i] === "\t") space = i;
        i += pair ? 2 : 1;
      }
      if (i >= lineEnd) {
        rows.push({ start, end: lineEnd });
        break;
      }
      const cut = space >= 0 && space - start >= max / 2 ? space + 1 : i;
      rows.push({ start, end: cut });
      start = cut;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return rows;
}

// The row holding offset `pos` (a binary search over wrapRows' rows).
export function rowOf(rows, pos) {
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid].start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// A row cut into the pieces to draw: [{ text, mark: null | "match" | "current" }], tabs as
// TAB spaces and carriage returns (CRLF files) left out. `matches` are all the matches,
// `current` the index of the one gone to. A match over a wrap is marked on both rows.
export function segments(text, row, matches, current) {
  const out = [];
  const push = (from, to, mark) => {
    const piece = to > from ? text.slice(from, to).replace(/\t/g, " ".repeat(TAB)).replace(/\r/g, "") : "";
    if (piece) out.push({ text: piece, mark });
  };
  let at = row.start;
  // Matches are in order: skip to the first that ends after the row starts.
  let lo = 0, hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (matches[mid].end <= row.start) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < matches.length && matches[i].start < row.end; i++) {
    const m = matches[i];
    const from = Math.max(m.start, row.start), to = Math.min(m.end, row.end);
    push(at, from, null);
    push(from, to, i === current ? "current" : "match");
    at = to;
  }
  push(at, row.end, null);
  return out;
}
