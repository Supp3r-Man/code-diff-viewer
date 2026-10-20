const test = require("node:test");
const assert = require("node:assert/strict");
const { wordDiff, tokenise, compare } = require("../src/diff.js");
const { mulberry32, randInt } = require("./helpers.js");

const join = (parts) => parts.map((p) => p.text).join("");
const keep = (parts) => parts.filter((p) => !p.changed).map((p) => p.text).join("");
const changedOf = (parts) => parts.filter((p) => p.changed).map((p) => p.text);

function randomLine(rng) {
  const bits = ["foo", "bar", "  ", " ", "(", ")", ";", "x1", "=", "+", "\t", "é", "日本", "_id", "if", ","];
  let s = "";
  for (let n = randInt(rng, 0, 14); n > 0; n--) s += bits[randInt(rng, 0, bits.length - 1)];
  return s;
}

test("seeded random lines: unchanged + removed parts rebuild the old line; unchanged + added parts rebuild the new line", () => {
  for (const mode of ["word", "char"]) {
    for (let seed = 1; seed <= 300; seed++) {
      const rng = mulberry32(seed);
      const a = randomLine(rng);
      const b = rng() < 0.5 ? randomLine(rng) : a.slice(0, randInt(rng, 0, a.length)) + randomLine(rng);
      const wd = wordDiff(a, b, { inlineMode: mode });
      assert.equal(join(wd.oldParts), a, mode + " seed " + seed);
      assert.equal(join(wd.newParts), b, mode + " seed " + seed);
    }
  }
});

test("seeded random lines: the unchanged text is the same on both sides, and is a common subsequence of the two lines", () => {
  function isSubsequence(small, big) {
    let i = 0;
    for (const ch of big) if (i < small.length && ch === small[i]) i++;
    return i === small.length;
  }
  for (let seed = 1; seed <= 300; seed++) {
    const rng = mulberry32(2000 + seed);
    const a = randomLine(rng);
    const b = randomLine(rng);
    const wd = wordDiff(a, b);
    assert.equal(keep(wd.oldParts), keep(wd.newParts), "seed " + (2000 + seed));
    assert.ok(isSubsequence(Array.from(keep(wd.oldParts)).join(""), a));
    assert.ok(isSubsequence(Array.from(keep(wd.newParts)).join(""), b));
  }
});

test("parts never have two neighbours with the same flag, and never an empty text", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rng = mulberry32(3000 + seed);
    const wd = wordDiff(randomLine(rng), randomLine(rng));
    for (const parts of [wd.oldParts, wd.newParts]) {
      parts.forEach((p, i) => {
        assert.ok(p.text.length > 0);
        if (i > 0) assert.notEqual(p.changed, parts[i - 1].changed);
      });
    }
  }
});

test("tokenise: joining the tokens gives the text back, in both modes", () => {
  for (const s of ["", "const x = 1;", "  lead  ", "a\tb", "日本語 text_1", "emoji 😀 ok", "()[]{}", "a b"]) {
    assert.equal(tokenise(s, "word").join(""), s);
    assert.equal(tokenise(s, "char").join(""), s);
  }
  assert.deepEqual(tokenise("foo.bar(1)", "word"), ["foo", ".", "bar", "(", "1", ")"]);
  assert.deepEqual(tokenise("a  b", "word"), ["a", "  ", "b"]);
  assert.deepEqual(tokenise("a😀", "char"), ["a", "😀"]);
});

test("a renamed identifier is the only highlighted word", () => {
  const wd = wordDiff("const total = price * qty;", "const total = price * quantity;");
  assert.deepEqual(changedOf(wd.oldParts), ["qty"]);
  assert.deepEqual(changedOf(wd.newParts), ["quantity"]);
  assert.ok(wd.similarity > 0.7);
});

test("char mode highlights only the characters that differ", () => {
  const wd = wordDiff("color: red;", "colour: red;", { inlineMode: "char" });
  assert.deepEqual(changedOf(wd.oldParts), []);
  assert.deepEqual(changedOf(wd.newParts), ["u"]);
  const w = wordDiff("color: red;", "colour: red;", { inlineMode: "word" });
  assert.deepEqual(changedOf(w.oldParts), ["color"]);
  assert.deepEqual(changedOf(w.newParts), ["colour"]);
});

test("inserted and deleted words", () => {
  const ins = wordDiff("if (a) run();", "if (a && b) run();");
  assert.deepEqual(changedOf(ins.oldParts), []);
  assert.deepEqual(changedOf(ins.newParts), [" && b"]);
  const del = wordDiff("let a = 1, b = 2;", "let a = 1;");
  assert.deepEqual(changedOf(del.oldParts), [", b = 2"]);
  assert.deepEqual(changedOf(del.newParts), []);
});

test("identical and empty lines", () => {
  const same = wordDiff("same line", "same line");
  assert.deepEqual(same.oldParts, [{ text: "same line", changed: false }]);
  assert.equal(same.similarity, 1);
  const empty = wordDiff("", "");
  assert.deepEqual(empty.oldParts, []);
  assert.equal(empty.similarity, 1);
  const toEmpty = wordDiff("abc", "");
  assert.deepEqual(toEmpty.oldParts, [{ text: "abc", changed: true }]);
  assert.deepEqual(toEmpty.newParts, []);
});

test("ignoreCase: a case-only change inside a word is not highlighted", () => {
  const wd = wordDiff("Return VALUE here", "return value there", { ignoreCase: true });
  assert.deepEqual(changedOf(wd.oldParts), ["here"]);
  assert.deepEqual(changedOf(wd.newParts), ["there"]);
  assert.equal(join(wd.oldParts), "Return VALUE here");
});

test("ignoreWhitespace: a change in the amount of whitespace is not highlighted, text is still exact", () => {
  const wd = wordDiff("a   b  c", "a b c d", { ignoreWhitespace: true });
  assert.deepEqual(changedOf(wd.oldParts), []);
  assert.deepEqual(changedOf(wd.newParts), ["d"]);
  assert.equal(join(wd.oldParts), "a   b  c");
  assert.equal(join(wd.newParts), "a b c d");
});

test("ignoreTrailingWhitespace: trailing spaces are never highlighted", () => {
  const wd = wordDiff("x = 1   ", "x = 2", { ignoreTrailingWhitespace: true });
  assert.deepEqual(changedOf(wd.oldParts), ["1"]);
  assert.equal(join(wd.oldParts), "x = 1   ");
  assert.equal(wd.oldParts[wd.oldParts.length - 1].changed, false);
});

test("very long lines are reported as wholly changed instead of being diffed", () => {
  const a = Array.from({ length: 1600 }, (_, i) => "a" + i).join(" ");
  const b = Array.from({ length: 1600 }, (_, i) => "b" + i).join(" ");
  const wd = wordDiff(a, b);
  assert.equal(wd.approximate, true);
  assert.equal(join(wd.oldParts), a);
  assert.equal(join(wd.newParts), b);
  assert.equal(wd.oldParts.length, 1);
  assert.equal(wd.oldParts[0].changed, true);
});

test("compare() attaches parts to similar pairs and leaves very different lines unhighlighted", () => {
  const res = compare("total = price * qty\nzzzzzzzz\n", "total = price * quantity\nqqqq qqqq\n");
  const dels = res.rows.filter((r) => r.type === "delete");
  const ins = res.rows.filter((r) => r.type === "insert");
  assert.equal(dels.length, 2);
  // The two lines form one block; they pair by position: line 1 with line 1, line 2 with line 2.
  assert.ok(dels[0].parts && ins[0].parts, "similar pair is highlighted inside");
  assert.equal(dels[1].parts, undefined, "dissimilar pair is shown as wholly changed");
  assert.equal(ins[1].parts, undefined);
  assert.equal(join(dels[0].parts), dels[0].text);
  assert.equal(join(ins[0].parts), ins[0].text);
});

test("compare() with inlineMode char highlights single characters", () => {
  const res = compare("colour\n", "color\n", { inlineMode: "char" });
  const del = res.rows.find((r) => r.type === "delete");
  assert.deepEqual(changedOf(del.parts), ["u"]);
});
