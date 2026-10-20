// Shared helpers for the tests. They are deliberately independent of src/diff.js: a brute-force LCS,
// a seeded random generator, and a tiny unified-patch applier. (node --test runs this file too; it has no tests.)

// Deterministic PRNG so every failure is reproducible from its seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function randomSeq(rng, maxLen, alphabet) {
  const len = randInt(rng, 0, maxLen);
  const out = [];
  for (let i = 0; i < len; i++) out.push(String.fromCharCode(97 + randInt(rng, 0, alphabet - 1)));
  return out;
}

// Brute-force O(N*M) dynamic-programming longest common subsequence length.
function lcsLength(a, b) {
  const dp = [];
  for (let i = 0; i <= a.length; i++) dp.push(new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Random text: lines drawn from a small vocabulary so that repeats (the hard case for diffs) are common.
function randomText(rng, o) {
  const opts = Object.assign({ maxLines: 12, vocab: 5, trailingNewline: null, crlf: false }, o);
  const n = randInt(rng, 0, opts.maxLines);
  const eol = opts.crlf ? "\r\n" : "\n";
  const lines = [];
  for (let i = 0; i < n; i++) lines.push("line " + randInt(rng, 0, opts.vocab - 1));
  if (n === 0) return "";
  const trailing = opts.trailingNewline === null ? rng() < 0.5 : opts.trailingNewline;
  return lines.join(eol) + (trailing ? eol : "");
}

// Independent text to {lines, noEol-aware} conversion used by the applier. Splits on "\n" only.
function toLineList(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf("\n", i);
    if (j === -1) {
      out.push({ text: text.slice(i), noEol: true });
      break;
    }
    out.push({ text: text.slice(i, j), noEol: false });
    i = j + 1;
  }
  return out;
}

function fromLineList(list) {
  list.forEach((l, i) => {
    if (l.noEol && i !== list.length - 1) throw new Error("a line without a newline is not the last line");
  });
  return list.map((l) => l.text + (l.noEol ? "" : "\n")).join("");
}

function parseRange(s) {
  const m = /^(\d+)(?:,(\d+))?$/.exec(s);
  if (!m) throw new Error("bad range " + s);
  return { start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]) };
}

// Apply a unified patch to `text` and return the new text. Throws if any context or removed line does not match,
// if hunk counts disagree with the hunk body, or if a "No newline" marker disagrees with the file.
function applyPatch(text, patch) {
  if (patch === "") return text;
  const src = toLineList(text);
  const lines = patch.split("\n");
  if (lines[lines.length - 1] !== "") throw new Error("patch must end with a newline");
  lines.pop();
  let i = 0;
  if (!lines[i].startsWith("--- ") || !lines[i + 1].startsWith("+++ ")) throw new Error("missing file headers");
  i += 2;
  const out = [];
  let pos = 0; // next unread index in src
  while (i < lines.length) {
    const h = /^@@ -(\S+) \+(\S+) @@/.exec(lines[i]);
    if (!h) throw new Error("expected hunk header, got: " + lines[i]);
    i++;
    const a = parseRange(h[1]);
    const b = parseRange(h[2]);
    const startIdx = a.count === 0 ? a.start : a.start - 1; // 0,0 and N,0 both mean "insert after line N"
    if (startIdx < pos) throw new Error("hunks overlap or are out of order");
    while (pos < startIdx) out.push(src[pos++]);
    let aSeen = 0;
    let bSeen = 0;
    while (i < lines.length && !lines[i].startsWith("@@ ")) {
      const line = lines[i];
      const tag = line[0];
      if (tag === "\\") throw new Error("marker without a preceding line");
      const body = line.slice(1);
      const marked = i + 1 < lines.length && lines[i + 1].startsWith("\\");
      if (tag === " " || tag === "-") {
        const have = src[pos];
        if (!have || have.text !== body) throw new Error("mismatch at source line " + (pos + 1) + ": " + JSON.stringify(have) + " vs " + JSON.stringify(body));
        if (have.noEol !== marked) throw new Error("no-newline marker disagrees with the file at line " + (pos + 1));
        pos++;
        aSeen++;
        if (tag === " ") {
          out.push({ text: body, noEol: marked });
          bSeen++;
        }
      } else if (tag === "+") {
        out.push({ text: body, noEol: marked });
        bSeen++;
      } else throw new Error("bad hunk line: " + line);
      i += marked ? 2 : 1;
    }
    if (aSeen !== a.count || bSeen !== b.count) throw new Error("hunk counts " + a.count + "/" + b.count + " but body has " + aSeen + "/" + bSeen);
  }
  while (pos < src.length) out.push(src[pos++]);
  return fromLineList(out);
}

module.exports = { mulberry32, randInt, randomSeq, lcsLength, randomText, applyPatch, toLineList };
