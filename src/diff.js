// Diff core. Loaded as a plain script in the page and the Web Worker, and with require() in Node tests.
// No dependencies: Myers' O(ND) diff, word-level diff, hunks and unified patch writer are all in this file.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DiffCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // The most edits (inserted + deleted lines) the exact algorithm will look for. Myers needs O(D^2) memory for the
  // trace, so this caps memory at roughly 4 * D^2 bytes (36 MB at 3000). Past it the result is valid but not minimal.
  const DEFAULT_MAX_EDITS = 3000;
  const MIN_INLINE_SIMILARITY = 0.25; // below this, a changed line pair is shown as wholly changed, with no inner highlight
  const MAX_INLINE_PAIRS = 3000; // changed line pairs that get word-level highlighting in one comparison
  const MAX_INLINE_TOKENS = 1500; // per line; longer lines (minified code) are shown as wholly changed

  const DEFAULT_OPTIONS = {
    ignoreWhitespace: false, // collapse runs of whitespace and trim each line, like `git diff -b`
    ignoreTrailingWhitespace: false,
    ignoreCase: false,
    normaliseEol: false, // a trailing \r (CRLF) does not count as a difference
    inlineMode: "word", // "word" or "char" highlighting inside changed lines
    maxEdits: DEFAULT_MAX_EDITS,
  };

  function normaliseOptions(options) {
    const o = Object.assign({}, DEFAULT_OPTIONS);
    const given = options || {};
    ["ignoreWhitespace", "ignoreTrailingWhitespace", "ignoreCase", "normaliseEol"].forEach((k) => {
      if (given[k] !== undefined) o[k] = Boolean(given[k]);
    });
    if (given.inlineMode === "char" || given.inlineMode === "word") o.inlineMode = given.inlineMode;
    if (Number.isFinite(given.maxEdits) && given.maxEdits >= 0) o.maxEdits = Math.floor(given.maxEdits);
    return o;
  }

  // ---------------------------------------------------------------------------------------------
  // Lines
  // ---------------------------------------------------------------------------------------------

  // Split on "\n" only. A "\r" before it stays on the line, so CRLF files round-trip through a patch unchanged.
  // eol says whether the last line ended with a newline ("" has no lines, and "a\n" has one line with eol true).
  function splitLines(text) {
    if (text === "") return { lines: [], eol: true };
    const parts = text.split("\n");
    let eol = true;
    if (parts[parts.length - 1] === "") parts.pop();
    else eol = false;
    return { lines: parts, eol: eol };
  }

  function countLines(text) {
    return splitLines(text).lines.length;
  }

  // "crlf", "lf", "mixed" or "none" (no line break at all).
  function detectEol(text) {
    const lf = (text.match(/\n/g) || []).length;
    if (lf === 0) return "none";
    const crlf = (text.match(/\r\n/g) || []).length;
    return crlf === 0 ? "lf" : crlf === lf ? "crlf" : "mixed";
  }

  // The string two lines are compared by. The original text is kept for display and for patches.
  // A last line with no newline gets a marker character, so "x" without a newline differs from "x\n", as in git,
  // unless an ignore-whitespace option is on (a newline is whitespace).
  function lineKey(text, opts, noEol) {
    let s = text;
    if (opts.normaliseEol) s = s.replace(/\r$/, "");
    if (opts.ignoreWhitespace) s = s.trim().replace(/\s+/g, " ");
    else if (opts.ignoreTrailingWhitespace) s = s.replace(/\s+$/, "");
    if (opts.ignoreCase) s = s.toLowerCase();
    if (noEol && !opts.ignoreWhitespace && !opts.ignoreTrailingWhitespace) s += "\u0001";
    return s;
  }

  function keysFor(split, opts) {
    const last = split.lines.length - 1;
    return split.lines.map((line, i) => lineKey(line, opts, !split.eol && i === last));
  }

  // ---------------------------------------------------------------------------------------------
  // Myers' O(ND) diff
  // ---------------------------------------------------------------------------------------------

  // Edit script for two arrays of strings. Returns { ops, approximate, distance }.
  //   ops       [{ t: "=", a, b } | { t: "-", a } | { t: "+", b }] in order; a and b are 0-based indexes.
  //   distance  number of "-" plus "+" ops. It equals N + M - 2 * LCS when approximate is false.
  //   approximate  true when more than options.maxEdits edits would be needed. The script is still valid (it turns
  //             the first sequence into the second) but is not minimal: the unmatched middle is replaced wholesale.
  //
  // Deterministic tie-breaking. Among scripts with the same minimal number of edits the result is fixed by:
  //   1. A common prefix and a common suffix are matched first and never reconsidered.
  //   2. Myers' forward search, on each diagonal, prefers a deletion over an insertion when both reach equally far,
  //      and follows diagonals (equal lines) as far as possible.
  //   3. Inside one block of consecutive changes, all deletions are listed before all insertions.
  function diffSequences(a, b, options) {
    const maxEdits = options && Number.isFinite(options.maxEdits) ? options.maxEdits : DEFAULT_MAX_EDITS;
    const ids = new Map();
    const intern = (s) => {
      let id = ids.get(s);
      if (id === undefined) {
        id = ids.size;
        ids.set(s, id);
      }
      return id;
    };
    const A = a.map(intern);
    const B = b.map(intern);
    const n = A.length;
    const m = B.length;

    let start = 0;
    while (start < n && start < m && A[start] === B[start]) start++;
    let endA = n;
    let endB = m;
    while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
      endA--;
      endB--;
    }

    const ops = [];
    for (let i = 0; i < start; i++) ops.push({ t: "=", a: i, b: i });
    const mid = myersMiddle(A.slice(start, endA), B.slice(start, endB), maxEdits);
    mid.ops.forEach((op) => {
      if (op.t === "=") ops.push({ t: "=", a: op.a + start, b: op.b + start });
      else if (op.t === "-") ops.push({ t: "-", a: op.a + start });
      else ops.push({ t: "+", b: op.b + start });
    });
    for (let i = 0; i < n - endA; i++) ops.push({ t: "=", a: endA + i, b: endB + i });

    const ordered = deletionsFirst(ops);
    let distance = 0;
    ordered.forEach((op) => {
      if (op.t !== "=") distance++;
    });
    return { ops: ordered, approximate: mid.approximate, distance: distance };
  }

  function deletionsFirst(ops) {
    const out = [];
    let dels = [];
    let ins = [];
    const flush = () => {
      for (const d of dels) out.push(d);
      for (const i of ins) out.push(i);
      dels = [];
      ins = [];
    };
    for (const op of ops) {
      if (op.t === "=") {
        flush();
        out.push(op);
      } else if (op.t === "-") dels.push(op);
      else ins.push(op);
    }
    flush();
    return out;
  }

  // Myers on arrays of integers with no common prefix or suffix.
  function myersMiddle(a, b, maxEdits) {
    const n = a.length;
    const m = b.length;
    if (n === 0 || m === 0) return { ops: trivialOps(n, m), approximate: false };
    const limit = Math.min(n + m, maxEdits);
    const off = limit + 1;
    const v = new Int32Array(2 * limit + 3); // v[off + k] = furthest x reached on diagonal k = x - y
    const trace = []; // trace[d] = v[-d..d] after round d; used to walk the path back
    for (let d = 0; d <= limit; d++) {
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1]; // step down: insert b[y]
        else x = v[off + k - 1] + 1; // step right: delete a[x] (also on ties)
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= n && y >= m) return { ops: backtrack(trace, n, m, d), approximate: false };
      }
      trace.push(v.slice(off - d, off + d + 1));
    }
    return { ops: trivialOps(n, m), approximate: true };
  }

  function trivialOps(n, m) {
    const ops = [];
    for (let i = 0; i < n; i++) ops.push({ t: "-", a: i });
    for (let j = 0; j < m; j++) ops.push({ t: "+", b: j });
    return ops;
  }

  function backtrack(trace, n, m, D) {
    const ops = [];
    let x = n;
    let y = m;
    for (let d = D; d > 0; d--) {
      const prev = trace[d - 1]; // v after round d-1, indexed by k + (d - 1)
      const base = d - 1;
      const k = x - y;
      const prevK = k === -d || (k !== d && prev[base + k - 1] < prev[base + k + 1]) ? k + 1 : k - 1;
      const prevX = prev[base + prevK];
      const prevY = prevX - prevK;
      while (x > prevX && y > prevY) {
        x--;
        y--;
        ops.push({ t: "=", a: x, b: y });
      }
      if (x === prevX) {
        y--;
        ops.push({ t: "+", b: y });
      } else {
        x--;
        ops.push({ t: "-", a: x });
      }
    }
    while (x > 0 && y > 0) {
      x--;
      y--;
      ops.push({ t: "=", a: x, b: y });
    }
    return ops.reverse();
  }

  // ---------------------------------------------------------------------------------------------
  // Word (or character) diff inside a changed line pair
  // ---------------------------------------------------------------------------------------------

  const WORD_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

  // "word": runs of whitespace, runs of word characters, single punctuation marks. "char": every code point.
  // Joining the tokens always gives the input back.
  function tokenise(text, mode) {
    if (mode === "char") return Array.from(text);
    return text.match(WORD_RE) || [];
  }

  function pushPart(parts, text, changed) {
    if (text === "") return;
    const last = parts[parts.length - 1];
    if (last && last.changed === changed) last.text += text;
    else parts.push({ text: text, changed: changed });
  }

  // Compare two lines token by token. Returns
  //   oldParts, newParts   [{ text, changed }]; each side's parts joined give that side's line back exactly
  //   similarity           0..1, share of the characters that are unchanged
  //   approximate          true if a line was too long to diff, so both lines are reported as wholly changed
  // Options: inlineMode, ignoreCase, ignoreWhitespace, ignoreTrailingWhitespace (as in normaliseOptions).
  function wordDiff(oldText, newText, options) {
    const opts = normaliseOptions(options);
    let oldTail = "";
    let newTail = "";
    let o = oldText;
    let n = newText;
    if (opts.ignoreWhitespace || opts.ignoreTrailingWhitespace) {
      oldTail = (o.match(/\s*$/) || [""])[0];
      newTail = (n.match(/\s*$/) || [""])[0];
      o = o.slice(0, o.length - oldTail.length);
      n = n.slice(0, n.length - newTail.length);
    }
    const ta = tokenise(o, opts.inlineMode);
    const tb = tokenise(n, opts.inlineMode);
    const oldParts = [];
    const newParts = [];
    let approximate = false;
    let kept = 0;

    if (ta.length > MAX_INLINE_TOKENS || tb.length > MAX_INLINE_TOKENS) {
      approximate = true;
      pushPart(oldParts, o, true);
      pushPart(newParts, n, true);
    } else {
      const isSpace = (t) => /^\s+$/.test(t);
      const key = (t) => {
        if (opts.ignoreWhitespace && isSpace(t)) return " ";
        return opts.ignoreCase ? t.toLowerCase() : t;
      };
      const d = diffSequences(ta.map(key), tb.map(key), { maxEdits: 2000 });
      d.ops.forEach((op) => {
        if (op.t === "=") {
          pushPart(oldParts, ta[op.a], false);
          pushPart(newParts, tb[op.b], false);
          kept += ta[op.a].length;
        } else if (op.t === "-") pushPart(oldParts, ta[op.a], !(opts.ignoreWhitespace && isSpace(ta[op.a])));
        else pushPart(newParts, tb[op.b], !(opts.ignoreWhitespace && isSpace(tb[op.b])));
      });
    }
    pushPart(oldParts, oldTail, false);
    pushPart(newParts, newTail, false);
    const total = oldText.length + newText.length;
    return { oldParts: oldParts, newParts: newParts, similarity: total === 0 ? 1 : (2 * kept) / total, approximate: approximate };
  }

  // ---------------------------------------------------------------------------------------------
  // Comparing two texts
  // ---------------------------------------------------------------------------------------------

  // Row: { type: "equal" | "delete" | "insert", a, b, text, bText, noEol, parts }
  //   a, b     1-based line numbers in the original and the changed text (null on the side that has no such line)
  //   text     the line as written in the original (equal, delete) or the changed text (insert)
  //   bText    equal rows only: the line as written in the changed text (differs from text only when an ignore option applies)
  //   noEol    this line is the last one on its side and has no newline after it ("No newline at end of file")
  //   bNoEol   equal rows only: the same flag for the changed text's copy of the line
  //   parts    delete and insert rows that were paired: [{ text, changed }] for word-level highlighting
  function compare(aText, bText, options) {
    const opts = normaliseOptions(options);
    const A = splitLines(aText);
    const B = splitLines(bText);
    const d = diffSequences(keysFor(A, opts), keysFor(B, opts), { maxEdits: opts.maxEdits });
    const aLast = A.lines.length - 1;
    const bLast = B.lines.length - 1;
    const rows = d.ops.map((op) => {
      if (op.t === "=") {
        return { type: "equal", a: op.a + 1, b: op.b + 1, text: A.lines[op.a], bText: B.lines[op.b], noEol: !A.eol && op.a === aLast, bNoEol: !B.eol && op.b === bLast };
      }
      if (op.t === "-") return { type: "delete", a: op.a + 1, b: null, text: A.lines[op.a], noEol: !A.eol && op.a === aLast };
      return { type: "insert", a: null, b: op.b + 1, text: B.lines[op.b], noEol: !B.eol && op.b === bLast };
    });

    let added = 0;
    let removed = 0;
    let unchanged = 0;
    let modified = 0;
    let inlinePairs = 0;
    let i = 0;
    while (i < rows.length) {
      if (rows[i].type === "equal") {
        unchanged++;
        i++;
        continue;
      }
      const dels = [];
      const ins = [];
      while (i < rows.length && rows[i].type !== "equal") {
        (rows[i].type === "delete" ? dels : ins).push(rows[i]);
        i++;
      }
      removed += dels.length;
      added += ins.length;
      const pairs = Math.min(dels.length, ins.length);
      modified += pairs;
      for (let p = 0; p < pairs && inlinePairs < MAX_INLINE_PAIRS; p++, inlinePairs++) {
        const wd = wordDiff(dels[p].text, ins[p].text, opts);
        if (wd.similarity >= MIN_INLINE_SIMILARITY && !wd.approximate) {
          dels[p].parts = wd.oldParts;
          ins[p].parts = wd.newParts;
        }
      }
    }

    return {
      rows: rows,
      stats: { added: added, removed: removed, unchanged: unchanged, modified: modified, distance: added + removed, aLines: A.lines.length, bLines: B.lines.length },
      approximate: d.approximate,
      identical: added + removed === 0,
      options: opts,
    };
  }

  // Side-by-side layout: [{ left: row | null, right: row | null }]. An equal row appears on both sides; in a block of
  // changes the i-th deletion sits next to the i-th insertion.
  function toSideBySide(rows) {
    const out = [];
    let i = 0;
    while (i < rows.length) {
      if (rows[i].type === "equal") {
        out.push({ left: rows[i], right: rows[i] });
        i++;
        continue;
      }
      const dels = [];
      const ins = [];
      while (i < rows.length && rows[i].type !== "equal") {
        (rows[i].type === "delete" ? dels : ins).push(rows[i]);
        i++;
      }
      for (let k = 0; k < Math.max(dels.length, ins.length); k++) out.push({ left: dels[k] || null, right: ins[k] || null });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Context, folding and hunks
  // ---------------------------------------------------------------------------------------------

  // Split rows into runs that are shown and runs that are hidden. Every changed row is shown, together with
  // `context` rows on each side. A run of unchanged rows between two changes is hidden only when it is longer than
  // 2 * context, which is the same rule git uses to merge hunks. With no changes at all everything is hidden.
  // Returns [{ hidden, start, rows }] where start is the index of the first row in the input.
  function foldRows(rows, context) {
    const ctx = Math.max(0, Math.floor(Number.isFinite(context) ? context : 3));
    const n = rows.length;
    const visible = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (rows[i].type === "equal") continue;
      const from = Math.max(0, i - ctx);
      const to = Math.min(n - 1, i + ctx);
      for (let j = from; j <= to; j++) visible[j] = 1;
    }
    const segments = [];
    let s = 0;
    while (s < n) {
      let e = s;
      while (e < n && visible[e] === visible[s]) e++;
      segments.push({ hidden: visible[s] === 0, start: s, rows: rows.slice(s, e) });
      s = e;
    }
    return segments;
  }

  // "start,count", or just "start" when the count is 1, as git and GNU diff write it.
  // An empty range (count 0) uses the number of the line BEFORE the gap, so an empty file is "0,0".
  function formatRange(start, count) {
    return count === 1 ? String(start) : start + "," + count;
  }

  // Hunks: [{ aStart, aCount, bStart, bCount, header, rows }].
  function buildHunks(rows, context) {
    const hunks = [];
    let aSeen = 0; // original lines before the current segment
    let bSeen = 0;
    foldRows(rows, context).forEach((seg) => {
      const aCount = seg.rows.filter((r) => r.type !== "insert").length;
      const bCount = seg.rows.filter((r) => r.type !== "delete").length;
      if (!seg.hidden) {
        const aStart = aCount > 0 ? aSeen + 1 : aSeen;
        const bStart = bCount > 0 ? bSeen + 1 : bSeen;
        hunks.push({
          aStart: aStart,
          aCount: aCount,
          bStart: bStart,
          bCount: bCount,
          header: "@@ -" + formatRange(aStart, aCount) + " +" + formatRange(bStart, bCount) + " @@",
          rows: seg.rows,
        });
      }
      aSeen += aCount;
      bSeen += bCount;
    });
    return hunks;
  }

  // Unified patch text for a compare() result. Empty string when there are no differences.
  // Context lines come from the original text. With ignore options on, lines that were treated as equal are written
  // as context, so such a patch describes only the differences that were not ignored.
  function toUnifiedPatch(result, options) {
    const o = options || {};
    const context = o.context === undefined ? 3 : o.context;
    const name = o.name || "file";
    const hunks = buildHunks(result.rows, context);
    if (hunks.length === 0) return "";
    const out = ["--- a/" + name, "+++ b/" + name];
    hunks.forEach((h) => {
      out.push(h.header);
      h.rows.forEach((r) => {
        out.push((r.type === "equal" ? " " : r.type === "delete" ? "-" : "+") + r.text);
        if (r.noEol) out.push("\\ No newline at end of file");
      });
    });
    return out.join("\n") + "\n";
  }

  return {
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    DEFAULT_MAX_EDITS: DEFAULT_MAX_EDITS,
    normaliseOptions: normaliseOptions,
    splitLines: splitLines,
    countLines: countLines,
    detectEol: detectEol,
    lineKey: lineKey,
    diffSequences: diffSequences,
    tokenise: tokenise,
    wordDiff: wordDiff,
    compare: compare,
    toSideBySide: toSideBySide,
    foldRows: foldRows,
    buildHunks: buildHunks,
    formatRange: formatRange,
    toUnifiedPatch: toUnifiedPatch,
  };
});
