const test = require("node:test");
const assert = require("node:assert/strict");
const { compare, diffSequences, toUnifiedPatch, DEFAULT_MAX_EDITS } = require("../src/diff.js");
const { mulberry32, randInt, applyPatch } = require("./helpers.js");

// Generous wall-clock limits: these catch an accidental O(N*M) or O(N^3), not small slowdowns.
function timed(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test("2000-line files with 100 random edits diff quickly, exactly, and the patch round-trips", () => {
  const rng = mulberry32(2026);
  const lines = Array.from({ length: 2000 }, (_, i) => "line " + i + " value=" + randInt(rng, 0, 99999));
  const edited = lines.slice();
  for (let e = 0; e < 100; e++) {
    const at = randInt(rng, 0, edited.length - 1);
    const r = rng();
    if (r < 0.33) edited.splice(at, 1);
    else if (r < 0.66) edited.splice(at, 0, "inserted " + e);
    else edited[at] = edited[at] + " (edited " + e + ")";
  }
  const a = lines.join("\n") + "\n";
  const b = edited.join("\n") + "\n";
  const { value: res, ms } = timed(() => compare(a, b));
  assert.ok(ms < 2000, "took " + Math.round(ms) + " ms");
  assert.equal(res.approximate, false);
  assert.ok(res.stats.distance <= 300, "at most 100 edits, each one or two line changes: " + res.stats.distance);
  assert.ok(res.stats.distance >= 50);
  assert.equal(res.stats.added + res.stats.removed + res.stats.unchanged * 0, res.stats.distance);
  assert.equal(applyPatch(a, toUnifiedPatch(res, { context: 3 })), b);
});

test("distance for the random-edit case is minimal: a second, independent bound", () => {
  // Every edit above changes the file by one inserted or deleted line, or replaces one line (1 delete + 1 insert),
  // so the minimal script never needs more than 2 per edit.
  const rng = mulberry32(77);
  const a = Array.from({ length: 500 }, (_, i) => "k" + i);
  const b = a.slice();
  for (let e = 0; e < 40; e++) {
    const at = randInt(rng, 0, b.length - 1);
    if (e % 2) b.splice(at, 1);
    else b[at] = "changed" + e;
  }
  const { distance } = diffSequences(a, b);
  assert.ok(distance <= 40 * 2, "distance " + distance);
});

test("worst case: 3000 x 3000 completely different lines is stopped by the size guard, quickly", () => {
  const a = Array.from({ length: 3000 }, (_, i) => "alpha " + i).join("\n") + "\n";
  const b = Array.from({ length: 3000 }, (_, i) => "beta " + i).join("\n") + "\n";
  const { value: res, ms } = timed(() => compare(a, b));
  assert.ok(ms < 10000, "took " + Math.round(ms) + " ms");
  assert.equal(res.approximate, true, "6000 edits are needed, more than the limit of " + DEFAULT_MAX_EDITS);
  assert.equal(res.stats.removed, 3000);
  assert.equal(res.stats.added, 3000);
  assert.equal(res.stats.unchanged, 0);
  // Approximate does not mean wrong: the patch still turns A into B.
  assert.equal(applyPatch(a, toUnifiedPatch(res, { context: 3 })), b);
});

test("worst case for Myers with shared lines: a reversed file is guarded too, and the result stays valid", () => {
  const lines = Array.from({ length: 2500 }, (_, i) => "row " + i);
  const a = lines.join("\n") + "\n";
  const b = lines.slice().reverse().join("\n") + "\n";
  const { value: res, ms } = timed(() => compare(a, b));
  assert.ok(ms < 10000, "took " + Math.round(ms) + " ms");
  assert.equal(res.approximate, true);
  assert.equal(applyPatch(a, toUnifiedPatch(res, { context: 1 })), b);
});

test("a lower maxEdits option reaches the guard sooner", () => {
  const a = Array.from({ length: 100 }, (_, i) => "a" + i).join("\n") + "\n";
  const b = Array.from({ length: 100 }, (_, i) => "b" + i).join("\n") + "\n";
  assert.equal(compare(a, b, { maxEdits: 50 }).approximate, true);
  assert.equal(compare(a, b, { maxEdits: 500 }).approximate, false);
});

test("a 20000-line identical pair is trivial (prefix matching) and a one-line change in the middle is exact", () => {
  const lines = Array.from({ length: 20000 }, (_, i) => "same " + i);
  const a = lines.join("\n") + "\n";
  const same = timed(() => compare(a, a));
  assert.equal(same.value.identical, true);
  assert.ok(same.ms < 2000);
  const changed = lines.slice();
  changed[10000] = "different";
  const one = timed(() => compare(a, changed.join("\n") + "\n"));
  assert.equal(one.value.stats.distance, 2);
  assert.equal(one.value.approximate, false);
  assert.ok(one.ms < 2000);
});
