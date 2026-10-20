const test = require("node:test");
const assert = require("node:assert/strict");
const { compare, lineKey, normaliseOptions, toUnifiedPatch } = require("../src/diff.js");
const { mulberry32, randomText, applyPatch } = require("./helpers.js");

const types = (res) => res.rows.map((r) => r.type[0]).join("");

test("normaliseOptions: defaults, coercion, and unknown values ignored", () => {
  const d = normaliseOptions();
  assert.equal(d.ignoreWhitespace, false);
  assert.equal(d.ignoreCase, false);
  assert.equal(d.inlineMode, "word");
  const o = normaliseOptions({ ignoreCase: 1, inlineMode: "bogus", maxEdits: -4, other: true });
  assert.equal(o.ignoreCase, true);
  assert.equal(o.inlineMode, "word");
  assert.equal(o.maxEdits, d.maxEdits);
  assert.equal(normaliseOptions({ inlineMode: "char" }).inlineMode, "char");
  assert.equal(normaliseOptions({ maxEdits: 7.9 }).maxEdits, 7);
  assert.equal("other" in o, false);
});

test("lineKey: each option on its own", () => {
  const none = normaliseOptions();
  assert.equal(lineKey("  A  b \r", none, false), "  A  b \r");
  assert.equal(lineKey("  A  b \r", normaliseOptions({ ignoreWhitespace: true }), false), "A b");
  assert.equal(lineKey("  A  b \r", normaliseOptions({ ignoreTrailingWhitespace: true }), false), "  A  b");
  assert.equal(lineKey("  A  b \r", normaliseOptions({ ignoreCase: true }), false), "  a  b \r");
  assert.equal(lineKey("x\r", normaliseOptions({ normaliseEol: true }), false), "x");
  assert.equal(lineKey("x \r", normaliseOptions({ normaliseEol: true }), false), "x ");
});

test("ignore whitespace: lines differing only in whitespace are equal but keep their original text on each side", () => {
  const res = compare("a\n  b   c\nd\n", "a\nb c\nd\n", { ignoreWhitespace: true });
  assert.equal(types(res), "eee");
  assert.equal(res.identical, true);
  const row = res.rows[1];
  assert.equal(row.text, "  b   c");
  assert.equal(row.bText, "b c");
  assert.equal(res.stats.distance, 0);
  // Without the option the same lines are a change.
  assert.equal(types(compare("a\n  b   c\nd\n", "a\nb c\nd\n")), "edie");
});

test("ignore whitespace: a real change next to whitespace-only changes is still found, and shown with original text", () => {
  const res = compare("if (a) {\n    run();\n}\n", "if (a) {\n  run(1);\n}\n", { ignoreWhitespace: true });
  assert.equal(types(res), "edie");
  const del = res.rows.find((r) => r.type === "delete");
  const ins = res.rows.find((r) => r.type === "insert");
  assert.equal(del.text, "    run();");
  assert.equal(ins.text, "  run(1);");
});

test("ignore whitespace also treats blank and whitespace-only lines as equal", () => {
  assert.equal(compare("a\n\nb\n", "a\n   \t\nb\n", { ignoreWhitespace: true }).identical, true);
  assert.equal(compare("a\n\nb\n", "a\n   \t\nb\n").identical, false);
});

test("ignore whitespace is not 'ignore all whitespace': 'a b' still differs from 'ab'", () => {
  assert.equal(compare("a b\n", "ab\n", { ignoreWhitespace: true }).identical, false);
});

test("ignore trailing whitespace: only the end of the line is ignored", () => {
  assert.equal(compare("x  \ny\n", "x\ny\t\n", { ignoreTrailingWhitespace: true }).identical, true);
  assert.equal(compare("  x\n", "x\n", { ignoreTrailingWhitespace: true }).identical, false);
  const res = compare("x  \n", "x\n", { ignoreTrailingWhitespace: true });
  assert.equal(res.rows[0].text, "x  ");
  assert.equal(res.rows[0].bText, "x");
});

test("ignore case: equal lines keep each side's original casing", () => {
  const res = compare("Hello World\nfoo\n", "HELLO world\nbar\n", { ignoreCase: true });
  assert.equal(types(res), "edi");
  assert.equal(res.rows[0].text, "Hello World");
  assert.equal(res.rows[0].bText, "HELLO world");
  assert.equal(compare("A\n", "a\n").identical, false);
});

test("normalise CRLF: CRLF against LF is identical, a lone \\r in the middle is not", () => {
  assert.equal(compare("a\r\nb\r\n", "a\nb\n").identical, false);
  const res = compare("a\r\nb\r\n", "a\nb\n", { normaliseEol: true });
  assert.equal(res.identical, true);
  assert.equal(res.rows[0].text, "a\r");
  assert.equal(res.rows[0].bText, "a");
  assert.equal(compare("a\rb\n", "ab\n", { normaliseEol: true }).identical, false);
});

test("normalise CRLF: mixed endings, with a real change, keep exact text for the changed lines", () => {
  const res = compare("a\r\nb\r\nc\r\n", "a\nB\nc\n", { normaliseEol: true });
  assert.equal(types(res), "edie");
  assert.equal(res.rows.find((r) => r.type === "delete").text, "b\r");
  assert.equal(res.rows.find((r) => r.type === "insert").text, "B");
});

test("a missing final newline counts as a difference, unless an ignore-whitespace option is on", () => {
  assert.equal(compare("a\nb", "a\nb\n").identical, false);
  assert.equal(compare("a\nb", "a\nb\n", { ignoreTrailingWhitespace: true }).identical, true);
  assert.equal(compare("a\nb", "a\nb\n", { ignoreWhitespace: true }).identical, true);
  assert.equal(compare("a\nb", "a\nb\n", { ignoreCase: true }).identical, false);
});

test("options combine", () => {
  const res = compare("  Hello\r\nWORLD  \r\n", "hello\nworld\n", { ignoreWhitespace: true, ignoreCase: true, normaliseEol: true });
  assert.equal(res.identical, true);
});

test("with options on, the patch applies to A and gives B up to the ignored differences", () => {
  const options = { ignoreWhitespace: true, ignoreCase: true };
  // The random B may lose its final newline, which these options also ignore, so compare without trailing newlines.
  const norm = (s) => s.replace(/\n+$/, "").split("\n").map((l) => l.trim().replace(/\s+/g, " ").toLowerCase()).join("\n");
  for (let seed = 1; seed <= 80; seed++) {
    const rng = mulberry32(600 + seed);
    const a = randomText(rng, { maxLines: 10, vocab: 4, trailingNewline: true });
    // B: same lines with random case/spacing noise, plus random edits
    const b = a
      .split("\n")
      .map((l) => (rng() < 0.4 ? "  " + l.toUpperCase() + " " : l))
      .filter(() => rng() < 0.9)
      .join("\n");
    const res = compare(a, b, options);
    const patch = toUnifiedPatch(res, { context: 2 });
    const applied = applyPatch(a, patch);
    assert.equal(norm(applied), norm(b), "seed " + (600 + seed));
  }
});

test("exact comparison (no options) never reports equal rows with different text", () => {
  for (let seed = 1; seed <= 60; seed++) {
    const rng = mulberry32(800 + seed);
    const res = compare(randomText(rng), randomText(rng));
    res.rows.filter((r) => r.type === "equal").forEach((r) => assert.equal(r.text, r.bText));
  }
});
