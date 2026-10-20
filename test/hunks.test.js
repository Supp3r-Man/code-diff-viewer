const test = require("node:test");
const assert = require("node:assert/strict");
const { compare, buildHunks, foldRows, toSideBySide, formatRange, splitLines, countLines, detectEol } = require("../src/diff.js");
const { mulberry32, randomText } = require("./helpers.js");

const nums = (n) => Array.from({ length: n }, (_, i) => String(i + 1));
const text = (lines) => lines.join("\n") + "\n";
function edit(lines, changes) {
  const out = lines.slice();
  Object.keys(changes).forEach((k) => (out[Number(k) - 1] = changes[k]));
  return out;
}
const headers = (a, b, context) => buildHunks(compare(a, b).rows, context).map((h) => h.header);

test("formatRange omits the count when it is 1 and keeps 0", () => {
  assert.equal(formatRange(5, 1), "5");
  assert.equal(formatRange(5, 7), "5,7");
  assert.equal(formatRange(0, 0), "0,0");
  assert.equal(formatRange(3, 0), "3,0");
});

test("header: one changed line in the middle of 10 lines, context 3", () => {
  const a = text(nums(10));
  const b = text(edit(nums(10), { 5: "five" }));
  assert.deepEqual(headers(a, b, 3), ["@@ -2,7 +2,7 @@"]);
});

test("header: change at the first and at the last line (context is clipped by the file)", () => {
  assert.deepEqual(headers(text(nums(10)), text(edit(nums(10), { 1: "one" })), 3), ["@@ -1,4 +1,4 @@"]);
  assert.deepEqual(headers(text(nums(10)), text(edit(nums(10), { 10: "ten" })), 3), ["@@ -7,4 +7,4 @@"]);
});

test("header: a pure insertion and a pure deletion", () => {
  const a = nums(10);
  const inserted = a.slice(0, 5).concat(["new"], a.slice(5));
  assert.deepEqual(headers(text(a), text(inserted), 3), ["@@ -3,6 +3,7 @@"]);
  const deleted = a.slice(0, 4).concat(a.slice(5));
  assert.deepEqual(headers(text(a), text(deleted), 3), ["@@ -2,7 +2,6 @@"]);
});

test("header: context 0, insertion between lines uses the line before the gap for the empty side", () => {
  // A has 1..5; B inserts X after line 3. A side is empty: -3,0. B side is line 4.
  assert.deepEqual(headers(text(nums(5)), text(["1", "2", "3", "X", "4", "5"]), 0), ["@@ -3,0 +4 @@"]);
  // Deleting line 1 leaves the B side empty before line 1: +0,0.
  assert.deepEqual(headers(text(["1", "2", "3"]), text(["2", "3"]), 0), ["@@ -1 +0,0 @@"]);
  // Deleting the last line: B side is empty after line 2.
  assert.deepEqual(headers(text(["1", "2", "3"]), text(["1", "2"]), 0), ["@@ -3 +2,0 @@"]);
  // Inserting before everything: A side is "0,0".
  assert.deepEqual(headers(text(["1", "2"]), text(["X", "1", "2"]), 0), ["@@ -0,0 +1 @@"]);
});

test("header: empty sides use 0,0 and a count of 1 is written without ',1'", () => {
  assert.deepEqual(headers("", "a\nb\nc\n", 3), ["@@ -0,0 +1,3 @@"]);
  assert.deepEqual(headers("a\nb\nc\n", "", 3), ["@@ -1,3 +0,0 @@"]);
  assert.deepEqual(headers("", "a\n", 3), ["@@ -0,0 +1 @@"]);
  assert.deepEqual(headers("a\n", "", 3), ["@@ -1 +0,0 @@"]);
  assert.deepEqual(headers("a\n", "b\n", 3), ["@@ -1 +1 @@"]);
});

test("header: second hunk's B start includes the line offset of the first hunk", () => {
  const a = nums(30);
  const b = a.slice();
  b.splice(2, 0, "ins1", "ins2"); // two lines inserted near the top
  b.splice(b.indexOf("25"), 1, "twenty-five"); // far below, so a separate hunk
  const h = buildHunks(compare(text(a), text(b)).rows, 3);
  assert.equal(h.length, 2);
  assert.equal(h[0].header, "@@ -1,5 +1,7 @@");
  assert.equal(h[1].header, "@@ -22,7 +24,7 @@");
});

test("hunks merge when the unchanged gap is at most 2*context and split when it is longer", () => {
  const a = nums(30);
  // lines 5 and 5+gap+1 change, with `gap` unchanged lines between them
  const hunkCount = (gap, ctx) => buildHunks(compare(text(a), text(edit(a, { 5: "x", [6 + gap]: "y" }))).rows, ctx).length;
  assert.equal(hunkCount(6, 3), 1);
  assert.equal(hunkCount(7, 3), 2);
  assert.equal(hunkCount(0, 0), 1);
  assert.equal(hunkCount(1, 0), 2);
  assert.equal(hunkCount(2, 1), 1);
  assert.equal(hunkCount(3, 1), 2);
});

test("hunk bookkeeping on random inputs: counts match rows, ranges are ordered, and starts agree with line offsets", () => {
  for (let seed = 1; seed <= 120; seed++) {
    const rng = mulberry32(40 + seed);
    const a = randomText(rng, { maxLines: 16, vocab: 5 });
    const b = randomText(rng, { maxLines: 16, vocab: 5 });
    const res = compare(a, b);
    for (const context of [0, 1, 3]) {
      const hunks = buildHunks(res.rows, context);
      let prevAEnd = 0;
      let prevBEnd = 0;
      hunks.forEach((h) => {
        const at = res.rows.indexOf(h.rows[0]);
        const before = res.rows.slice(0, at);
        const aBefore = before.filter((r) => r.type !== "insert").length;
        const bBefore = before.filter((r) => r.type !== "delete").length;
        assert.equal(h.aCount, h.rows.filter((r) => r.type !== "insert").length);
        assert.equal(h.bCount, h.rows.filter((r) => r.type !== "delete").length);
        assert.equal(h.aStart - (h.aCount > 0 ? 1 : 0), aBefore, "A start, seed " + (40 + seed));
        assert.equal(h.bStart - (h.bCount > 0 ? 1 : 0), bBefore, "B start, seed " + (40 + seed));
        assert.ok(aBefore >= prevAEnd && bBefore >= prevBEnd, "hunks must not overlap");
        prevAEnd = aBefore + h.aCount;
        prevBEnd = bBefore + h.bCount;
        assert.match(h.header, /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@$/);
      });
    }
  }
});

test("every changed row is inside a hunk, for every context size", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = mulberry32(80 + seed);
    const res = compare(randomText(rng, { maxLines: 15 }), randomText(rng, { maxLines: 15 }));
    for (let context = 0; context <= 4; context++) {
      const inHunks = new Set();
      buildHunks(res.rows, context).forEach((h) => h.rows.forEach((r) => inHunks.add(r)));
      res.rows.filter((r) => r.type !== "equal").forEach((r) => assert.ok(inHunks.has(r)));
    }
  }
});

test("foldRows: hides long unchanged runs, keeps `context` rows next to changes, and covers every row once", () => {
  const a = nums(40);
  const res = compare(text(a), text(edit(a, { 10: "x", 30: "y" })));
  const segs = foldRows(res.rows, 3);
  assert.deepEqual(segs.map((s) => [s.hidden, s.rows.length]), [[true, 6], [false, 8], [true, 13], [false, 8], [true, 7]]); // 9 | 3+2+3 | 19-6 | 3+2+3 | 10-3
  assert.equal(segs.reduce((n, s) => n + s.rows.length, 0), res.rows.length);
  assert.equal(segs[1].start, 6);
  assert.deepEqual(segs.flatMap((s) => s.rows), res.rows);
});

test("foldRows: no changes hides everything, and a short gap stays visible", () => {
  const same = compare(text(nums(5)), text(nums(5)));
  assert.deepEqual(foldRows(same.rows, 3).map((s) => [s.hidden, s.rows.length]), [[true, 5]]);
  assert.deepEqual(foldRows([], 3), []);
  const a = nums(12);
  const res = compare(text(a), text(edit(a, { 3: "x", 10: "y" }))); // 6 unchanged between: exactly 2*3
  assert.equal(foldRows(res.rows, 3).filter((s) => s.hidden).length, 0);
});

test("foldRows: a context larger than the file shows everything; negative or odd values are clamped", () => {
  const res = compare(text(nums(20)), text(edit(nums(20), { 10: "x" })));
  assert.equal(foldRows(res.rows, 1000).filter((s) => s.hidden).length, 0);
  assert.deepEqual(foldRows(res.rows, -5).map((s) => s.hidden), foldRows(res.rows, 0).map((s) => s.hidden));
  assert.deepEqual(foldRows(res.rows, NaN).map((s) => s.hidden), foldRows(res.rows, 3).map((s) => s.hidden));
});

test("toSideBySide: equal rows on both sides; deletions pair with insertions in order; leftovers stand alone", () => {
  const res = compare("a\nb\nc\nd\ne\n", "a\nB\nC\nX\nY\ne\n"); // b,c,d -> B,C,X,Y
  const rows = toSideBySide(res.rows);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].left, rows[0].right);
  assert.deepEqual(rows.slice(1, 5).map((r) => [r.left && r.left.text, r.right && r.right.text]), [["b", "B"], ["c", "C"], ["d", "X"], [null, "Y"]]);
  const more = toSideBySide(compare("a\nb\nc\n", "a\n").rows);
  assert.deepEqual(more.map((r) => [r.left && r.left.text, r.right && r.right.text]), [["a", "a"], ["b", null], ["c", null]]);
});

test("toSideBySide keeps every row exactly once", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = mulberry32(120 + seed);
    const res = compare(randomText(rng, { maxLines: 15 }), randomText(rng, { maxLines: 15 }));
    const seen = [];
    toSideBySide(res.rows).forEach((p) => {
      if (p.left && p.left.type !== "equal") seen.push(p.left);
      if (p.right && p.right.type !== "equal") seen.push(p.right);
      if (p.left && p.left.type === "equal") seen.push(p.left);
    });
    assert.equal(seen.length, res.rows.length);
    assert.equal(new Set(seen).size, res.rows.length);
  }
});

test("stats: added, removed, unchanged, modified pairs and edit distance", () => {
  const res = compare("a\nb\nc\nd\n", "a\nB\nc\nd\nz\n");
  assert.deepEqual(
    { added: res.stats.added, removed: res.stats.removed, unchanged: res.stats.unchanged, modified: res.stats.modified, distance: res.stats.distance },
    { added: 2, removed: 1, unchanged: 3, modified: 1, distance: 3 }
  );
  assert.equal(res.stats.aLines, 4);
  assert.equal(res.stats.bLines, 5);
  assert.equal(res.identical, false);
  assert.equal(compare("x\n", "x\n").identical, true);
});

test("line numbers: delete rows carry only the old number, insert rows only the new one, and both sequences are complete", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = mulberry32(160 + seed);
    const a = randomText(rng, { maxLines: 12 });
    const b = randomText(rng, { maxLines: 12 });
    const { rows } = compare(a, b);
    const aNums = rows.filter((r) => r.a !== null).map((r) => r.a);
    const bNums = rows.filter((r) => r.b !== null).map((r) => r.b);
    assert.deepEqual(aNums, Array.from({ length: countLines(a) }, (_, i) => i + 1));
    assert.deepEqual(bNums, Array.from({ length: countLines(b) }, (_, i) => i + 1));
    rows.forEach((r) => {
      if (r.type === "delete") assert.equal(r.b, null);
      if (r.type === "insert") assert.equal(r.a, null);
    });
  }
});

test("splitLines, countLines and detectEol", () => {
  assert.deepEqual(splitLines(""), { lines: [], eol: true });
  assert.deepEqual(splitLines("a"), { lines: ["a"], eol: false });
  assert.deepEqual(splitLines("a\n"), { lines: ["a"], eol: true });
  assert.deepEqual(splitLines("a\n\n"), { lines: ["a", ""], eol: true });
  assert.deepEqual(splitLines("\n"), { lines: [""], eol: true });
  assert.deepEqual(splitLines("a\r\nb"), { lines: ["a\r", "b"], eol: false });
  assert.equal(countLines("a\nb\nc"), 3);
  assert.equal(detectEol("a"), "none");
  assert.equal(detectEol("a\nb\n"), "lf");
  assert.equal(detectEol("a\r\nb\r\n"), "crlf");
  assert.equal(detectEol("a\r\nb\n"), "mixed");
});
