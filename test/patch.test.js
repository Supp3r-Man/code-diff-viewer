const test = require("node:test");
const assert = require("node:assert/strict");
const { compare, toUnifiedPatch } = require("../src/diff.js");
const { mulberry32, randInt, randomText, applyPatch } = require("./helpers.js");

function patchFor(a, b, context, options) {
  return toUnifiedPatch(compare(a, b, options), { context: context });
}

function assertRoundTrip(a, b, context, label) {
  const patch = patchFor(a, b, context);
  assert.equal(applyPatch(a, patch), b, label + " (context " + context + ")\n" + patch);
  return patch;
}

test("the applier itself rejects a patch that does not match (so the round-trip tests mean something)", () => {
  const patch = patchFor("a\nb\nc\n", "a\nX\nc\n", 1);
  assert.equal(applyPatch("a\nb\nc\n", patch), "a\nX\nc\n");
  assert.throws(() => applyPatch("a\nZ\nc\n", patch), /mismatch/);
  assert.throws(() => applyPatch("a\nb\nc", patch), /marker disagrees|mismatch/);
  assert.throws(() => applyPatch("a\nb\nc\n", patch.replace("@@ -1,3 +1,3 @@", "@@ -1,3 +1,4 @@")), /counts/);
});

test("seeded random texts: applying the patch to A gives B exactly, for context 0..5", () => {
  for (let seed = 1; seed <= 150; seed++) {
    const rng = mulberry32(seed);
    const a = randomText(rng, { maxLines: 14, vocab: 6 });
    const b = randomText(rng, { maxLines: 14, vocab: 6 });
    for (let context = 0; context <= 5; context++) assertRoundTrip(a, b, context, "seed " + seed + " A=" + JSON.stringify(a) + " B=" + JSON.stringify(b));
  }
});

test("seeded random edits of one text (the realistic case): patch round-trips for every context size", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rng = mulberry32(300 + seed);
    const lines = [];
    for (let i = 0; i < randInt(rng, 5, 40); i++) lines.push("row " + i);
    const edited = lines.slice();
    for (let e = randInt(rng, 1, 6); e > 0; e--) {
      const at = randInt(rng, 0, edited.length);
      const r = rng();
      if (r < 0.33) edited.splice(at, 1);
      else if (r < 0.66) edited.splice(at, 0, "new " + e);
      else if (at < edited.length) edited[at] = "changed " + e;
    }
    const a = lines.join("\n") + (rng() < 0.5 ? "\n" : "");
    const b = edited.join("\n") + (rng() < 0.5 ? "\n" : "");
    for (let context = 0; context <= 5; context++) assertRoundTrip(a, b, context, "seed " + (300 + seed));
  }
});

test("random texts with and without a trailing newline on each side (all four combinations)", () => {
  for (const ta of [true, false]) {
    for (const tb of [true, false]) {
      for (let seed = 1; seed <= 40; seed++) {
        const rng = mulberry32(700 + seed);
        const a = randomText(rng, { maxLines: 8, vocab: 4, trailingNewline: ta });
        const b = randomText(rng, { maxLines: 8, vocab: 4, trailingNewline: tb });
        for (const context of [0, 1, 3]) assertRoundTrip(a, b, context, "ta=" + ta + " tb=" + tb + " seed " + seed);
      }
    }
  }
});

test("CRLF input round-trips (the \\r stays on each line)", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = mulberry32(900 + seed);
    const a = randomText(rng, { maxLines: 10, vocab: 5, crlf: true });
    const b = randomText(rng, { maxLines: 10, vocab: 5, crlf: true });
    for (const context of [0, 2, 5]) assertRoundTrip(a, b, context, "seed " + (900 + seed));
  }
  // CRLF on one side, LF on the other: every line differs, and the patch still round-trips.
  assertRoundTrip("a\r\nb\r\n", "a\nb\n", 3, "crlf to lf");
  assertRoundTrip("a\nb\n", "a\r\nb\r\n", 3, "lf to crlf");
});

test("the 'No newline at end of file' marker: added, removed and kept", () => {
  assert.equal(patchFor("a\nb", "a\nb\n", 3), "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n");
  assert.equal(patchFor("a\nb\n", "a\nb", 3), "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n");
  assert.equal(patchFor("a\nb", "a\nB", 3), "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n");
  // A last line that is unchanged and has no newline on either side is context with one marker.
  assert.equal(patchFor("x\ny", "w\ny", 3), "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-x\n+w\n y\n\\ No newline at end of file\n");
});

test("a file that gains a line after a final line with no newline", () => {
  const p = assertRoundTrip("a", "a\nb\n", 3, "gain");
  assert.match(p, /\\ No newline at end of file/);
  assertRoundTrip("a\nb\n", "a", 3, "lose");
});

test("empty files: empty to something, something to empty, empty to empty", () => {
  assert.equal(patchFor("", "a\nb\n", 3), "--- a/file\n+++ b/file\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  assert.equal(patchFor("a\nb\n", "", 3), "--- a/file\n+++ b/file\n@@ -1,2 +0,0 @@\n-a\n-b\n");
  assert.equal(patchFor("", "", 3), "");
  assert.equal(applyPatch("", patchFor("", "a\nb", 3)), "a\nb");
  assert.equal(applyPatch("a\nb", patchFor("a\nb", "", 3)), "");
  assert.equal(patchFor("", "x\n", 3), "--- a/file\n+++ b/file\n@@ -0,0 +1 @@\n+x\n");
});

test("a file that is only a blank line", () => {
  assertRoundTrip("\n", "", 3, "newline to empty");
  assertRoundTrip("", "\n", 3, "empty to newline");
  assertRoundTrip("\n\n", "\n", 3, "two blanks to one");
});

test("identical inputs give an empty patch, whatever the context", () => {
  for (const text of ["", "a\n", "a\nb", "a\r\nb\r\n", "\n"]) {
    for (let context = 0; context <= 5; context++) assert.equal(patchFor(text, text, context), "", JSON.stringify(text));
  }
});

test("file name label is configurable and defaults to 'file'", () => {
  const r = compare("a\n", "b\n");
  assert.match(toUnifiedPatch(r), /^--- a\/file\n\+\+\+ b\/file\n/);
  assert.match(toUnifiedPatch(r, { name: "src/app.js" }), /^--- a\/src\/app\.js\n\+\+\+ b\/src\/app\.js\n/);
});

test("context 0 produces one hunk per block with no context lines; large context merges everything", () => {
  const a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
  const b = "1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n";
  const zero = patchFor(a, b, 0);
  assert.equal((zero.match(/^@@/gm) || []).length, 2);
  assert.ok(!/^ /m.test(zero), "no context lines");
  assert.equal(applyPatch(a, zero), b);
  const wide = patchFor(a, b, 20);
  assert.equal((wide.match(/^@@/gm) || []).length, 1);
  assert.match(wide, /@@ -1,10 \+1,10 @@/);
});

test("the patch with ignore options describes only the differences that were not ignored", () => {
  const a = "keep\nHello   World\nlast\n";
  const b = "keep\nhello world\nlast\nextra\n";
  const patch = patchFor(a, b, 3, { ignoreCase: true, ignoreWhitespace: true });
  // The Hello/hello line is context (taken from A), so applying the patch to A adds only the extra line.
  assert.equal(applyPatch(a, patch), "keep\nHello   World\nlast\nextra\n");
  assert.ok(!/^[-+]hello/im.test(patch));
});
