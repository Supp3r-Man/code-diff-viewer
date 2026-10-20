const test = require("node:test");
const assert = require("node:assert/strict");
const { diffSequences } = require("../src/diff.js");
const { mulberry32, randInt, randomSeq, lcsLength } = require("./helpers.js");

// Rebuild B from A and the edit script, checking the script's own bookkeeping on the way.
function reconstruct(a, b, ops) {
  const out = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op.t === "=") {
      assert.equal(op.a, ai, "equal op must use the next unread A index");
      assert.equal(op.b, bi, "equal op must use the next unread B index");
      assert.equal(a[ai], b[bi], "equal op must pair equal elements");
      out.push(a[ai]);
      ai++;
      bi++;
    } else if (op.t === "-") {
      assert.equal(op.a, ai);
      ai++;
    } else {
      assert.equal(op.b, bi);
      out.push(b[bi]);
      bi++;
    }
  }
  assert.equal(ai, a.length, "every A element is consumed");
  assert.equal(bi, b.length, "every B element is consumed");
  return out;
}

// Consecutive non-equal ops, as { dels, ins } blocks.
function blocks(ops) {
  const out = [];
  let cur = null;
  for (const op of ops) {
    if (op.t === "=") {
      cur = null;
      continue;
    }
    if (!cur) out.push((cur = { dels: [], ins: [], order: [] }));
    (op.t === "-" ? cur.dels : cur.ins).push(op);
    cur.order.push(op.t);
  }
  return out;
}

const SEEDS = 600;

test("seeded random: the script reconstructs B from A", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = mulberry32(seed);
    const alphabet = randInt(rng, 1, 6);
    const a = randomSeq(rng, 16, alphabet);
    const b = randomSeq(rng, 16, alphabet);
    const { ops } = diffSequences(a, b);
    assert.deepEqual(reconstruct(a, b, ops), b, "seed " + seed);
  }
});

test("seeded random: insertions + deletions equals N + M - 2*LCS (minimal), against a brute-force DP", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = mulberry32(1000 + seed);
    const alphabet = randInt(rng, 1, 6);
    const a = randomSeq(rng, 16, alphabet);
    const b = randomSeq(rng, 16, alphabet);
    const res = diffSequences(a, b);
    const edits = res.ops.filter((o) => o.t !== "=").length;
    assert.equal(edits, a.length + b.length - 2 * lcsLength(a, b), "seed " + (1000 + seed) + ": " + a.join("") + " -> " + b.join(""));
    assert.equal(res.distance, edits);
    assert.equal(res.approximate, false);
  }
});

test("seeded random: no element is both deleted and inserted within one block of changes", () => {
  // In a minimal script, a block's deleted and inserted elements share nothing: otherwise one pair could be kept equal.
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = mulberry32(5000 + seed);
    const alphabet = randInt(rng, 2, 6);
    const a = randomSeq(rng, 16, alphabet);
    const b = randomSeq(rng, 16, alphabet);
    const { ops } = diffSequences(a, b);
    for (const blk of blocks(ops)) {
      const deleted = new Set(blk.dels.map((o) => a[o.a]));
      for (const ins of blk.ins) assert.ok(!deleted.has(b[ins.b]), "seed " + (5000 + seed) + ": " + b[ins.b] + " deleted and re-inserted");
    }
  }
});

test("seeded random: the number of equal ops is the LCS length, so no matchable pair is reported as changed", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = mulberry32(9000 + seed);
    const a = randomSeq(rng, 14, randInt(rng, 1, 5));
    const b = randomSeq(rng, 14, randInt(rng, 1, 5));
    const equal = diffSequences(a, b).ops.filter((o) => o.t === "=").length;
    assert.equal(equal, lcsLength(a, b), "seed " + (9000 + seed));
  }
});

test("exhaustive: every pair of binary sequences up to length 5 is minimal and reconstructs", () => {
  const all = [[]];
  for (let len = 1; len <= 5; len++) {
    for (let bits = 0; bits < 1 << len; bits++) {
      const s = [];
      for (let i = 0; i < len; i++) s.push((bits >> i) & 1 ? "b" : "a");
      all.push(s);
    }
  }
  assert.equal(all.length, 63);
  for (const a of all) {
    for (const b of all) {
      const { ops } = diffSequences(a, b);
      assert.deepEqual(reconstruct(a, b, ops), b);
      assert.equal(ops.filter((o) => o.t !== "=").length, a.length + b.length - 2 * lcsLength(a, b), a.join("") + " -> " + b.join(""));
    }
  }
});

test("longer sequences with a few edits: still minimal against the DP", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rng = mulberry32(20000 + seed);
    const a = randomSeq(rng, 120, 12);
    const b = a.slice();
    for (let e = randInt(rng, 1, 8); e > 0; e--) {
      const at = randInt(rng, 0, b.length);
      if (rng() < 0.5) b.splice(at, 1);
      else b.splice(at, 0, String.fromCharCode(97 + randInt(rng, 0, 11)));
    }
    const { ops } = diffSequences(a, b);
    assert.deepEqual(reconstruct(a, b, ops), b);
    assert.equal(ops.filter((o) => o.t !== "=").length, a.length + b.length - 2 * lcsLength(a, b), "seed " + (20000 + seed));
  }
});

test("empty and identical inputs", () => {
  assert.deepEqual(diffSequences([], []).ops, []);
  assert.deepEqual(diffSequences([], ["x", "y"]).ops, [{ t: "+", b: 0 }, { t: "+", b: 1 }]);
  assert.deepEqual(diffSequences(["x", "y"], []).ops, [{ t: "-", a: 0 }, { t: "-", a: 1 }]);
  const same = diffSequences(["a", "b", "c"], ["a", "b", "c"]);
  assert.equal(same.distance, 0);
  assert.ok(same.ops.every((o) => o.t === "="));
});

test("tie-breaking is fixed: deletions before insertions in a block", () => {
  assert.deepEqual(diffSequences(["a"], ["b"]).ops, [{ t: "-", a: 0 }, { t: "+", b: 0 }]);
  const blk = diffSequences(["a", "b", "c"], ["x", "y", "z"]).ops.map((o) => o.t).join("");
  assert.equal(blk, "---+++");
});

test("tie-breaking is fixed: ab -> ba deletes 'a', keeps 'b' and re-inserts 'a' (a pinned script)", () => {
  // Keeping 'a' (delete b, insert b) and keeping 'b' (delete a, insert a) both cost 2 edits. The rule picks one; pin it.
  const { ops } = diffSequences(["a", "b"], ["b", "a"]);
  assert.deepEqual(ops, [{ t: "-", a: 0 }, { t: "=", a: 1, b: 0 }, { t: "+", b: 1 }]);
});

test("repeated elements: output is deterministic across calls and does not mutate its inputs", () => {
  const a = ["x", "x", "y", "x", "x"];
  const b = ["x", "y", "x", "x", "x", "y"];
  const copyA = a.slice();
  const copyB = b.slice();
  const one = diffSequences(a, b);
  const two = diffSequences(a, b);
  assert.deepEqual(one, two);
  assert.deepEqual(a, copyA);
  assert.deepEqual(b, copyB);
});

test("common prefix and suffix are matched first", () => {
  const { ops } = diffSequences(["p", "q", "m1", "s"], ["p", "q", "m2", "s"]);
  assert.deepEqual(ops.map((o) => o.t).join(""), "==-+=");
});

test("the size guard: past maxEdits the result is flagged approximate but still valid", () => {
  const a = [];
  const b = [];
  for (let i = 0; i < 60; i++) {
    a.push("a" + i);
    b.push("b" + i);
  }
  const guarded = diffSequences(a, b, { maxEdits: 20 });
  assert.equal(guarded.approximate, true);
  assert.deepEqual(reconstruct(a, b, guarded.ops), b);
  const exact = diffSequences(a, b, { maxEdits: 200 });
  assert.equal(exact.approximate, false);
  assert.equal(exact.distance, 120);
});

test("the guard keeps the matched prefix and suffix even when it gives up on the middle", () => {
  const a = ["top"].concat(Array.from({ length: 40 }, (_, i) => "a" + i), ["bottom"]);
  const b = ["top"].concat(Array.from({ length: 40 }, (_, i) => "b" + i), ["bottom"]);
  const r = diffSequences(a, b, { maxEdits: 10 });
  assert.equal(r.approximate, true);
  assert.equal(r.ops[0].t, "=");
  assert.equal(r.ops[r.ops.length - 1].t, "=");
  assert.equal(r.distance, 80);
});

test("maxEdits exactly at the needed distance still finds the exact answer", () => {
  const r = diffSequences(["a", "b", "c"], ["a", "x", "c"], { maxEdits: 2 });
  assert.equal(r.approximate, false);
  assert.equal(r.distance, 2);
  const tooSmall = diffSequences(["a", "b", "c"], ["a", "x", "c"], { maxEdits: 1 });
  assert.equal(tooSmall.approximate, true);
});
