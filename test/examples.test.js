const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const examples = require("../src/examples.js");
const { compare, toUnifiedPatch } = require("../src/diff.js");
const { applyPatch } = require("./helpers.js");

test("every example has differences, round-trips through a patch, and shows word-level highlights somewhere", () => {
  assert.ok(examples.length >= 2);
  for (const ex of examples) {
    const res = compare(ex.original, ex.changed);
    assert.equal(res.identical, false, ex.id);
    assert.equal(res.approximate, false, ex.id);
    for (const context of [0, 3]) assert.equal(applyPatch(ex.original, toUnifiedPatch(res, { context })), ex.changed, ex.id);
    assert.ok(res.rows.some((r) => r.parts), ex.id + " has an inner-line highlight");
  }
});

test("the JavaScript example has unchanged runs long enough to collapse at context 3", () => {
  const js = examples.find((e) => e.id === "js");
  const res = compare(js.original, js.changed);
  const hidden = require("../src/diff.js").foldRows(res.rows, 3).filter((s) => s.hidden);
  assert.ok(hidden.length >= 2, "hidden runs: " + hidden.length);
});

test("the prose example exercises 'No newline at end of file'", () => {
  const prose = examples.find((e) => e.id === "prose");
  assert.match(toUnifiedPatch(compare(prose.original, prose.changed)), /\\ No newline at end of file/);
});

test("the page uses textContent and createElement only: no innerHTML or other HTML-string sinks in src/", () => {
  const dir = path.join(__dirname, "..", "src");
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const code = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(code), file);
  }
});

test("index.html loads the scripts the page needs and references only files the server serves", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const src of ["src/diff.js", "src/examples.js", "src/app.js", "src/styles.css"]) assert.ok(html.includes(src), src);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "element ids are unique");
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
  for (const m of app.matchAll(/\$\("([^"]+)"\)/g)) assert.ok(ids.includes(m[1]), "app.js looks up #" + m[1] + " which index.html lacks");
});
