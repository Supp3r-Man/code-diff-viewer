// Compares the patch body with `git diff --no-index` on fixed inputs and on seeded realistic edits.
// Skipped when git is not installed. What is compared: everything from the first "@@" on, with the function-context
// text that git appends to hunk headers (for example "@@ -16,6 +16,7 @@ row 14") removed. The file headers differ by
// design (git adds "diff --git" and "index" lines and real paths) and are not compared.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { compare, toUnifiedPatch } = require("../src/diff.js");
const { mulberry32, randInt } = require("./helpers.js");

const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

function gitBody(a, b, context) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diffviewer-git-"));
  try {
    fs.writeFileSync(path.join(dir, "old.txt"), a);
    fs.writeFileSync(path.join(dir, "new.txt"), b);
    const r = spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--no-color", "-U" + context, "old.txt", "new.txt"], { cwd: dir, encoding: "utf8" });
    const i = r.stdout.indexOf("\n@@");
    return i === -1 ? "" : r.stdout.slice(i + 1).replace(/^(@@ [^@]+ @@).*$/gm, "$1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ourBody(a, b, context) {
  const p = toUnifiedPatch(compare(a, b), { context: context });
  const i = p.indexOf("\n@@");
  return i === -1 ? "" : p.slice(i + 1);
}

const FIXED = [
  ["one line changed", "a\nb\nc\nd\ne\nf\ng\nh\n", "a\nb\nc\nD\ne\nf\ng\nh\n"],
  ["line added at the top", "b\nc\n", "a\nb\nc\n"],
  ["line removed at the bottom", "a\nb\nc\n", "a\nb\n"],
  ["two distant changes", Array.from({ length: 30 }, (_, i) => "n" + i).join("\n") + "\n", Array.from({ length: 30 }, (_, i) => (i === 3 ? "X" : i === 25 ? "Y" : "n" + i)).join("\n") + "\n"],
  ["empty to text", "", "a\nb\n"],
  ["text to empty", "a\nb\n", ""],
  ["identical", "a\nb\n", "a\nb\n"],
  ["final newline added", "a\nb", "a\nb\n"],
  ["final newline removed", "a\nb\n", "a\nb"],
  ["last line changed, no newline either side", "a\nb", "a\nc"],
  ["CRLF to LF", "a\r\nb\r\n", "a\nb\n"],
  ["CRLF with one change", "a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"],
  ["blank lines", "a\n\n\nb\n", "a\n\nb\n"],
  ["replace a block with a longer one", "1\n2\n3\n4\n5\n6\n", "1\n2\nx\ny\nz\nw\n6\n"],
];

for (const [name, a, b] of FIXED) {
  test("git comparison, fixed input: " + name, { skip: !hasGit && "git is not installed" }, () => {
    for (const context of [0, 1, 3]) assert.equal(ourBody(a, b, context), gitBody(a, b, context), "context " + context);
  });
}

test("git comparison, 100 seeded realistic edits (one text, a few inserted, deleted or changed lines)", { skip: !hasGit && "git is not installed" }, () => {
  for (let seed = 1; seed <= 100; seed++) {
    const rng = mulberry32(500 + seed);
    const lines = Array.from({ length: randInt(rng, 5, 40) }, (_, i) => "row " + i);
    const edited = lines.slice();
    for (let e = randInt(rng, 1, 6); e > 0; e--) {
      const at = randInt(rng, 0, edited.length);
      const r = rng();
      if (r < 0.33) edited.splice(at, 1);
      else if (r < 0.66) edited.splice(at, 0, "new " + e);
      else if (at < edited.length) edited[at] = "changed " + e;
    }
    const a = lines.join("\n") + "\n";
    const b = edited.join("\n") + "\n";
    assert.equal(ourBody(a, b, 3), gitBody(a, b, 3), "seed " + (500 + seed));
  }
});
