// Browser UI. The diff itself lives in diff.js (tested in Node); this file only reads inputs and builds DOM.
// All text goes into the page with createElement and text nodes, never through HTML strings (a test checks this).
(function () {
  "use strict";

  const LARGE_LINES = 5000; // above this on either side, ask first and run the diff in a Web Worker
  const LIVE_MAX_LINES = 1500; // live compare only below this
  const WORKER_TIMEOUT_MS = 20000;
  const DEBOUNCE_MS = 300;
  const CLIPBOARD_TIMEOUT_MS = 1500;
  const core = window.DiffCore;
  const examples = window.DiffExamples;

  const $ = (id) => document.getElementById(id);
  const el = {
    original: $("original"),
    changed: $("changed"),
    originalCount: $("original-count"),
    changedCount: $("changed-count"),
    openOriginal: $("open-original"),
    openChanged: $("open-changed"),
    fileOriginal: $("file-original"),
    fileChanged: $("file-changed"),
    compare: $("compare"),
    swap: $("swap"),
    example: $("example"),
    clear: $("clear"),
    live: $("live"),
    optWs: $("opt-ws"),
    optTrailing: $("opt-trailing"),
    optCase: $("opt-case"),
    optEol: $("opt-eol"),
    optInline: $("opt-inline"),
    notice: $("notice"),
    result: $("result"),
    stats: $("stats"),
    viewUnified: $("view-unified"),
    viewSplit: $("view-split"),
    context: $("context"),
    expandAll: $("expand-all"),
    copy: $("copy"),
    diff: $("diff"),
    patchBox: $("patch-box"),
    patchOut: $("patch-out"),
  };

  const MAX_FILE_BYTES = 5 * 1024 * 1024;

  const state = {
    // A textarea's value always has CRLF and lone CR turned into LF by the browser, so text that came from a file is
    // remembered here as read, and used for as long as the textarea still shows that same text.
    raw: { original: null, changed: null },
    result: null, // last compare() result
    sourceA: null, // the texts that result was computed from
    sourceB: null,
    view: "unified",
    expanded: new Set(), // start indexes of hidden runs the user has opened
    runId: 0, // bumped on every comparison so that a slow earlier one cannot overwrite a newer one
    confirmedLarge: false, // the user accepted the large-input warning for the current texts
    exampleIndex: 0,
    debounce: null,
    copyTimer: null,
  };

  function node(tag, props, children) {
    const n = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach((k) => {
        if (k === "text") n.textContent = props[k];
        else n.setAttribute(k, props[k]);
      });
    }
    (children || []).forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return n;
  }

  function readOptions() {
    return {
      ignoreWhitespace: el.optWs.checked,
      ignoreTrailingWhitespace: el.optTrailing.checked,
      ignoreCase: el.optCase.checked,
      normaliseEol: el.optEol.checked,
      inlineMode: el.optInline.value,
    };
  }

  function contextValue() {
    const n = parseInt(el.context.value, 10);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 999) : 3;
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  // ---- notices ----

  function showNotice(kind, children) {
    el.notice.className = "notice " + kind;
    el.notice.replaceChildren.apply(el.notice, children);
    el.notice.hidden = false;
  }

  function hideNotice() {
    el.notice.hidden = true;
    el.notice.replaceChildren();
  }

  // ---- comparing ----

  // The text of one side: the file as read (with its CRLFs) if the textarea still shows it, otherwise the textarea value.
  function sideText(side) {
    const raw = state.raw[side];
    return raw !== null && raw.replace(/\r\n?/g, "\n") === el[side].value ? raw : el[side].value;
  }

  function updateCounts() {
    [["original", el.originalCount], ["changed", el.changedCount]].forEach((pair) => {
      const text = sideText(pair[0]);
      const eol = core.detectEol(text);
      pair[1].textContent = plural(core.countLines(text), "line") + (eol === "crlf" ? ", CRLF" : eol === "mixed" ? ", mixed endings" : "");
    });
  }

  async function openFile(side, input) {
    const file = input.files && input.files[0];
    input.value = ""; // so that choosing the same file again fires another change event
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      showNotice("error", [node("span", { text: file.name + " is larger than " + MAX_FILE_BYTES / 1048576 + " MB, which is more than this page loads." })]);
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch (e) {
      showNotice("error", [node("span", { text: "Could not read " + file.name + "." })]);
      return;
    }
    el[side].value = text;
    state.raw[side] = text;
    state.confirmedLarge = false;
    updateCounts();
    if (el.live.checked || state.result) compareNow();
  }

  function runInWorker(a, b, options) {
    return new Promise((resolve) => {
      let w;
      try {
        w = new Worker("src/worker.js");
      } catch (e) {
        resolve({ ok: false, message: "Could not start the background worker (" + e.message + "). Open this page over http, for example with `npm start`, not from a file:// URL." });
        return;
      }
      const timer = setTimeout(() => {
        w.terminate();
        resolve({ ok: false, timeout: true, message: "No result after " + WORKER_TIMEOUT_MS / 1000 + " seconds, so the comparison was stopped. Try turning on an ignore option or comparing smaller pieces." });
      }, WORKER_TIMEOUT_MS);
      w.onmessage = (ev) => {
        clearTimeout(timer);
        w.terminate();
        resolve(ev.data);
      };
      w.onerror = (ev) => {
        clearTimeout(timer);
        w.terminate();
        resolve({ ok: false, message: "Worker error: " + (ev.message || "unknown") });
      };
      w.postMessage({ a: a, b: b, options: options });
    });
  }

  async function compareNow(opts) {
    const force = (opts && opts.force) || false;
    const a = sideText("original");
    const b = sideText("changed");
    const options = readOptions();
    const aLines = core.countLines(a);
    const bLines = core.countLines(b);
    const large = Math.max(aLines, bLines) > LARGE_LINES;
    clearTimeout(state.debounce);

    if (large && !force && !(state.confirmedLarge && a === state.sourceA && b === state.sourceB)) {
      const go = node("button", { type: "button", id: "compare-anyway", text: "Compare anyway" });
      go.addEventListener("click", () => {
        state.confirmedLarge = true;
        compareNow({ force: true });
      });
      showNotice("warn", [
        node("span", {
          text:
            "Large input: the original has " + plural(aLines, "line") + " and the changed text has " + plural(bLines, "line") + " (instant comparison is limited to " + LARGE_LINES + "). " +
            "It will run in a background worker and stop after " + WORKER_TIMEOUT_MS / 1000 + " seconds. ",
        }),
        go,
      ]);
      return;
    }

    const myRun = ++state.runId;
    let result;
    if (large) {
      el.compare.disabled = true;
      showNotice("info", [node("span", { text: "Comparing " + plural(Math.max(aLines, bLines), "line") + " in a background worker…" })]);
      const reply = await runInWorker(a, b, options);
      el.compare.disabled = false;
      if (myRun !== state.runId) return;
      if (!reply.ok) {
        showNotice("error", [node("span", { text: reply.message })]);
        return;
      }
      result = reply.result;
    } else {
      try {
        result = core.compare(a, b, options);
      } catch (e) {
        showNotice("error", [node("span", { text: "Comparison failed: " + (e && e.message ? e.message : String(e)) })]);
        return;
      }
    }
    state.result = result;
    state.sourceA = a;
    state.sourceB = b;
    state.confirmedLarge = large;
    state.expanded = new Set();
    hideNotice();
    addHints(a, b, options, result);
    render();
  }

  function addHints(a, b, options, result) {
    const notes = [];
    const ea = core.detectEol(a);
    const eb = core.detectEol(b);
    if (!options.normaliseEol && ((ea === "crlf" && eb !== "crlf" && eb !== "none") || (eb === "crlf" && ea !== "crlf" && ea !== "none"))) {
      notes.push("The two texts use different line endings (CRLF and LF), so every line differs. Turn on \"Normalise CRLF\" to ignore that.");
    }
    if (result.approximate) {
      notes.push("This diff needed more than " + core.DEFAULT_MAX_EDITS + " line edits, so the exact search was stopped. The result is correct but may not be the smallest possible.");
    }
    if (notes.length) showNotice("warn", [node("span", { text: notes.join(" ") })]);
  }

  // ---- rendering ----

  function codeCell(row, text, withParts, noEol) {
    const td = node("td", { class: "code" });
    if (withParts && row.parts) {
      row.parts.forEach((p) => {
        if (p.changed) td.appendChild(node("span", { class: "hl", text: p.text }));
        else td.appendChild(document.createTextNode(p.text));
      });
    } else {
      td.appendChild(document.createTextNode(text));
    }
    if (noEol) td.appendChild(node("span", { class: "noeol", text: "No newline at end of file" }));
    return td;
  }

  const SIGN = { equal: " ", delete: "-", insert: "+" };

  function unifiedRow(row) {
    const tr = node("tr", { class: "row " + row.type });
    tr.appendChild(node("td", { class: "num", text: row.a === null ? "" : String(row.a) }));
    tr.appendChild(node("td", { class: "num", text: row.b === null ? "" : String(row.b) }));
    tr.appendChild(node("td", { class: "sign", "aria-hidden": "true", text: SIGN[row.type] }));
    tr.appendChild(codeCell(row, row.text, true, row.noEol));
    return tr;
  }

  function splitRow(pair) {
    const tr = node("tr", { class: "row" });
    const side = (row, which) => {
      if (!row) {
        tr.appendChild(node("td", { class: "num empty" }));
        tr.appendChild(node("td", { class: "code empty" }));
        return;
      }
      const number = which === "left" ? row.a : row.b;
      const cls = row.type;
      // An equal row has one object for both sides: text and noEol describe the original, bText and bNoEol the changed text.
      const right = row.type === "equal" && which === "right";
      const code = codeCell(row, right ? row.bText : row.text, row.type !== "equal", right ? row.bNoEol : row.noEol);
      tr.appendChild(node("td", { class: "num " + cls, text: String(number) }));
      code.className = "code " + cls;
      tr.appendChild(code);
    };
    side(pair.left, "left");
    side(pair.right, "right");
    return tr;
  }

  function foldRow(seg, expanded, colspan) {
    const label = (expanded ? "Hide " : "Show ") + plural(seg.rows.length, "unchanged line");
    const button = node("button", { type: "button", class: "fold-button", "aria-expanded": expanded ? "true" : "false", text: (expanded ? "▾ " : "▸ ") + label });
    button.addEventListener("click", () => {
      if (expanded) state.expanded.delete(seg.start);
      else state.expanded.add(seg.start);
      render();
    });
    return node("tr", { class: "fold" + (expanded ? " open" : "") }, [node("td", { colspan: String(colspan) }, [button])]);
  }

  function render() {
    const result = state.result;
    if (!result) {
      el.result.hidden = true;
      return;
    }
    el.result.hidden = false;
    renderStats(result);
    el.diff.replaceChildren();
    const unified = state.view === "unified";
    el.viewUnified.setAttribute("aria-pressed", unified ? "true" : "false");
    el.viewSplit.setAttribute("aria-pressed", unified ? "false" : "true");

    if (result.identical) {
      const same = state.sourceA === state.sourceB;
      el.diff.appendChild(node("p", { class: "empty-state", text: same ? "The two texts are identical." : "No differences, with the selected options ignoring some changes." }));
      return;
    }

    const colspan = 4;
    const table = node("table", { class: "diff " + (unified ? "unified" : "split"), role: "table", "aria-label": unified ? "Unified diff" : "Side-by-side diff" });
    if (!unified) {
      table.appendChild(node("colgroup", {}, [node("col", { class: "c-num" }), node("col", { class: "c-code" }), node("col", { class: "c-num" }), node("col", { class: "c-code" })]));
    } else {
      table.appendChild(node("colgroup", {}, [node("col", { class: "c-num" }), node("col", { class: "c-num" }), node("col", { class: "c-sign" }), node("col", { class: "c-ucode" })]));
    }
    const body = node("tbody");
    core.foldRows(result.rows, contextValue()).forEach((seg) => {
      const open = !seg.hidden || state.expanded.has(seg.start);
      if (seg.hidden) body.appendChild(foldRow(seg, open, colspan));
      if (!open) return;
      if (unified) seg.rows.forEach((r) => body.appendChild(unifiedRow(r)));
      else core.toSideBySide(seg.rows).forEach((p) => body.appendChild(splitRow(p)));
    });
    table.appendChild(body);
    el.diff.appendChild(table);
  }

  function renderStats(result) {
    const s = result.stats;
    const parts = [
      node("span", { class: "stat added", text: "+" + s.added + " added" }),
      " ",
      node("span", { class: "stat removed", text: "−" + s.removed + " removed" }),
      " ",
      node("span", { class: "stat", text: s.unchanged + " unchanged" }),
      " ",
      node("span", { class: "stat", title: "Line insertions plus deletions in the diff (not Levenshtein distance: a changed line counts as one deletion and one insertion)", text: "edit distance " + s.distance }),
    ];
    el.stats.replaceChildren.apply(el.stats, parts);
  }

  // ---- patch ----

  async function copyPatch() {
    if (!state.result) return;
    const patch = core.toUnifiedPatch(state.result, { context: contextValue(), name: "file" });
    el.patchOut.value = patch;
    if (patch === "") {
      showNotice("info", [node("span", { text: "No differences, so the patch is empty." })]);
      return;
    }
    let ok = false;
    try {
      // Some browsers leave this promise pending (no focus, or a permission prompt), so do not wait for it forever.
      const timeout = new Promise((resolve, reject) => setTimeout(() => reject(new Error("clipboard timed out")), CLIPBOARD_TIMEOUT_MS));
      await Promise.race([navigator.clipboard.writeText(patch), timeout]);
      ok = true;
    } catch (e) {
      el.patchOut.focus();
      el.patchOut.select();
      try {
        ok = document.execCommand("copy");
      } catch (e2) {
        ok = false;
      }
    }
    clearTimeout(state.copyTimer);
    if (ok) {
      el.copy.textContent = "Copied";
      state.copyTimer = setTimeout(() => (el.copy.textContent = "Copy patch"), 2000);
    } else {
      el.patchBox.open = true;
      el.copy.textContent = "Copy patch";
      showNotice("warn", [node("span", { text: "The browser did not allow copying. The patch is shown below: select it and copy it by hand." })]);
    }
  }

  // ---- wiring ----

  function inputsChanged() {
    updateCounts();
    state.confirmedLarge = false;
    clearTimeout(state.debounce);
    const lines = Math.max(core.countLines(el.original.value), core.countLines(el.changed.value));
    if (el.live.checked && lines <= LIVE_MAX_LINES) {
      state.debounce = setTimeout(() => compareNow(), DEBOUNCE_MS);
    } else if (state.result) {
      showNotice("info", [node("span", { text: "The inputs changed. Press Compare to update the result." })]);
    }
  }

  function optionsChanged() {
    if (state.result) compareNow({ force: state.confirmedLarge });
  }

  ["original", "changed"].forEach((side) =>
    el[side].addEventListener("input", () => {
      state.raw[side] = null; // typing or pasting replaces the text that came from a file
      inputsChanged();
    })
  );
  [el.original, el.changed].forEach((t) =>
    t.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        compareNow();
      }
    })
  );
  [["original", el.openOriginal, el.fileOriginal], ["changed", el.openChanged, el.fileChanged]].forEach((s) => {
    s[1].addEventListener("click", () => s[2].click());
    s[2].addEventListener("change", () => openFile(s[0], s[2]));
  });
  el.compare.addEventListener("click", () => compareNow());
  [el.optWs, el.optTrailing, el.optCase, el.optEol, el.optInline].forEach((c) => c.addEventListener("change", optionsChanged));

  el.swap.addEventListener("click", () => {
    const t = el.original.value;
    el.original.value = el.changed.value;
    el.changed.value = t;
    const r = state.raw.original;
    state.raw.original = state.raw.changed;
    state.raw.changed = r;
    updateCounts();
    if (state.result || el.live.checked) compareNow({ force: state.confirmedLarge });
  });

  function loadExample() {
    const ex = examples[state.exampleIndex % examples.length];
    state.exampleIndex++;
    el.original.value = ex.original;
    el.changed.value = ex.changed;
    state.raw.original = null;
    state.raw.changed = null;
    updateCounts();
    compareNow();
  }
  el.example.addEventListener("click", loadExample);

  el.clear.addEventListener("click", () => {
    el.original.value = "";
    el.changed.value = "";
    state.raw.original = null;
    state.raw.changed = null;
    updateCounts();
    state.result = null;
    state.runId++;
    state.confirmedLarge = false;
    hideNotice();
    render();
  });

  el.viewUnified.addEventListener("click", () => {
    state.view = "unified";
    render();
  });
  el.viewSplit.addEventListener("click", () => {
    state.view = "split";
    render();
  });
  el.context.addEventListener("input", () => {
    state.expanded = new Set();
    render();
  });
  el.expandAll.addEventListener("click", () => {
    if (!state.result) return;
    core.foldRows(state.result.rows, contextValue()).forEach((seg) => {
      if (seg.hidden) state.expanded.add(seg.start);
    });
    render();
  });
  el.copy.addEventListener("click", copyPatch);

  loadExample(); // start with something to look at
})();
