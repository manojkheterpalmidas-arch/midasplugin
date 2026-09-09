/* ==========================================================================
   Concurrent Forces — the analysis
   --------------------------------------------------------------------------
   Pure. Turns returned result tables into rows, builds the join key, finds the
   governing row, and filters the merged set to the rows that share that key.

   THE JOIN KEY IS (Load, Stage, Step). That triple is what identifies one
   deterministic structural state, and it is the only thing that makes two rows
   in different elements concurrent. Everything else in this file is in service
   of it: the criterion picks a row, the key is read off that row, and the
   answer is every row carrying the same key.

   Nothing here scales a number. Units are requested from MIDAS on the
   /post/TABLE call, so values arrive already in the user's chosen system — a
   client-side conversion would be a second, unverifiable, place to be wrong.
   ========================================================================== */
(function (root) {
  "use strict";

  /* A separator that cannot occur inside a load name, a stage name or a part
     token, so the composed key is unambiguous. Written as an escape, not as a
     literal, so the source stays plain ASCII and survives being spliced. */
  var SEP = "\u001f";

  /* -------------------------------------------------------------- parsing */

  /**
   * Parse one returned table into rows.
   *
   * @param {{HEAD:Array, DATA:Array}} table
   * @param {Object} opts  { group, components: [column names] }
   * @returns {{rows, columns, unresolved, head}}
   */
  function parseTable(table, opts) {
    opts = opts || {};
    var El = elementsModule();
    var src = opts.source;
    var components = (src.components || []).map(function (c) { return c.column; });
    var cols = El.resolveColumns(table.HEAD, {
      item: src.itemCols, part: src.partCols, components: components
    });
    var ix = cols.index;
    var rows = [];

    (table.DATA || []).forEach(function (d) {
      if (ix.item == null) return;
      var num = Number(String(d[ix.item]).trim());
      if (!isFinite(num)) return;
      var row = {
        source: src.id,
        elem: num,
        /* The member key carries its NAMESPACE. Element, node and link ids are
           separate spaces that collide, so a bare number would merge two
           different objects into one row. */
        elemKey: El.keyOf(src.namespace, num),
        /* A node table reports one row per item and has no part column at all.
           Recording that here is what stops an output-position filter throwing
           every one of its rows away. */
        hasPart: !!src.partCols,
        /* Whether the part is an I/J END. A plate reports at its nodes and an
           elastic link at its two node ids, so an I/J/both output position is
           meaningless there — filtering on it would silently discard every
           one of those rows. */
        partKind: src.partKind || null,
        load: cell(d, ix.Load),
        stage: cell(d, ix.Stage),
        step: cell(d, ix.Step),
        part: src.partCols ? cell(d, ix.part) : "",
        values: Object.create(null)
      };
      components.forEach(function (c) {
        if (ix[c] == null) return;
        var cellValue = d[ix[c]];
        /* An EMPTY cell is not a zero. Number("") is 0, so a blank in a numeric
           column would otherwise arrive as a real, plottable, exportable force
           of exactly nothing — the worst kind of wrong, because it is
           indistinguishable from a genuine zero and reads as a measurement. */
        var v = (cellValue === "" || cellValue == null) ? NaN : Number(cellValue);
        row.values[c] = isFinite(v) ? v : null;
      });
      row.key = joinKey(row);
      rows.push(row);
    });

    return { rows: rows, columns: cols.index, unresolved: cols.unresolved,
             missing: cols.missing, head: cols.head };
  }

  function cell(d, i) {
    if (i == null) return "";
    var v = d[i];
    return v == null ? "" : String(v).trim();
  }

  function elementsModule() {
    if (root.CfElements) return root.CfElements;
    if (typeof require === "function") return require("./elements.js");
    throw new Error("elements.js must load before concurrent.js");
  }

  /** (Load, Stage, Step) — one deterministic structural state. */
  function joinKey(row) {
    return String(row.load) + SEP + String(row.stage || "") + SEP + String(row.step || "");
  }

  function describeKey(key) {
    var p = String(key).split(SEP);
    return { load: p[0], stage: p[1] || "", step: p[2] || "" };
  }

  /* ---------------------------------------------------------------- parts */

  /**
   * The member-end token, normalised to "I" or "J".
   *
   * MEASURED ON A LIVE CIVIL NX 2026 MODEL: the beam force table's Part column
   * carries the END NODE with it — `I[100]`, `1/4`, `2/4`, `3/4`, `J[101]` —
   * not the bare "Part I"/"Part J" that this once assumed. Getting it wrong is
   * not a cosmetic fault: every row fails an I/J output-position filter, and a
   * run over 836 elements comes back either empty or, once the filter stands
   * down, at five output points where two were asked for.
   *
   * Anything that is not an end — a quarter point, a plate's node number —
   * keeps its own token.
   */
  function normPart(part) {
    var s = String(part == null ? "" : part).trim();
    var m = /^(?:part\s*)?([ij])\s*(?:\[\s*\d+\s*\])?$/i.exec(s);
    return m ? m[1].toUpperCase() : s;
  }

  var POSITIONS = [
    { id: "I", label: "Part I" },
    { id: "J", label: "Part J" },
    { id: "both", label: "Both ends" },
    { id: "all", label: "All output points" }
  ];

  /**
   * @param {string} part
   * @param {string} position
   * @param {boolean} [hasPart]  false where the source has no part column at all
   *
   * A node reaction is one value at one node — there is no Part I or Part J to
   * choose between. Filtering those rows on an output position would discard
   * every one of them, which is how a reaction driver would come back as "no
   * result row found".
   */
  function partAllowed(part, position, hasPart, partKind) {
    if (hasPart === false) return true;
    if (partKind && partKind !== "ij") return true;
    var p = normPart(part);
    if (position === "all") return true;
    if (position === "both") return p === "I" || p === "J";
    return p === position;
  }

  /* ----------------------------------------------------------- criterion */

  var CRITERIA = [
    { id: "max", label: "Maximum (signed)" },
    { id: "min", label: "Minimum (signed)" },
    { id: "absmax", label: "Absolute maximum" }
  ];

  function score(value, criterion) {
    if (value == null || !isFinite(value)) return null;
    if (criterion === "min") return -value;
    if (criterion === "absmax") return Math.abs(value);
    return value;
  }

  /* --------------------------------------------------------- the governing */

  var TIE_REL = 1e-9;
  function nearly(a, b) {
    var s = Math.max(Math.abs(a), Math.abs(b), 1e-12);
    return Math.abs(a - b) / s <= TIE_REL;
  }

  /**
   * Find the row where the key component governs at the key element.
   *
   * Near-ties are common, not a corner case — 14 in the first 72 driver items
   * on one real model. The policy, stated here and shown in the results header:
   * the FIRST row in query order wins, and every tie is reported, so the reader
   * can see that a choice was made rather than assume the answer was unique.
   *
   * @returns {{row, value, score, ties, candidates}|null}
   */
  function findGoverning(rows, opts) {
    var comp = opts.component;
    var best = null, ties = [], n = 0;

    rows.forEach(function (r) {
      if (r.elemKey !== opts.keyElemKey) return;
      /* One item can appear in more than one table — a node carries both a
         reaction and a displacement row — so the driver names a SOURCE as well
         as an item, or the criterion would range over two different quantities. */
      if (opts.source && r.source !== opts.source) return;
      if (!partAllowed(r.part, opts.position, r.hasPart, r.partKind)) return;
      var v = r.values[comp];
      if (v == null || !isFinite(v)) return;
      n++;
      var s = score(v, opts.criterion);
      if (best === null || s > best.score) { best = { row: r, value: v, score: s }; ties = []; }
      else if (nearly(s, best.score)) ties.push(r);
    });

    if (!best) return null;
    best.ties = ties;
    best.candidates = n;
    return best;
  }

  /* -------------------------------------------------------- the answer set */

  /**
   * Every row sharing the governing state, in the order the user entered the
   * set — not the order the API happened to return them.
   */
  function concurrentSet(rows, key, opts) {
    opts = opts || {};
    var orderOf = Object.create(null);
    (opts.order || []).forEach(function (k, i) { orderOf[k] = i; });

    var out = rows.filter(function (r) {
      return r.key === key && partAllowed(r.part, opts.position, r.hasPart, r.partKind);
    });

    out.sort(function (a, b) {
      var oa = orderOf[a.elemKey], ob = orderOf[b.elemKey];
      if (oa == null) oa = 1e9;
      if (ob == null) ob = 1e9;
      if (oa !== ob) return oa - ob;
      if (a.source !== b.source) return String(a.source).localeCompare(String(b.source));
      return partRank(a.part) - partRank(b.part);
    });
    return out;
  }

  /**
   * Where along the member an output point sits, so the report reads I, 1/4,
   * 2/4, 3/4, J — the order an engineer draws a diagram in.
   *
   * The intermediate points come back as fractions ("1/4"), so they rank
   * between the two ends rather than after them. Ranking every unrecognised
   * token the same was a silent fault: the sort became a no-op and the right
   * order survived only because Array.sort is stable and the API happened to
   * return them in order.
   */
  function partRank(part) {
    var p = normPart(part);
    if (p === "I") return 0;
    if (p === "J") return 1;
    var frac = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(p);
    if (frac) {
      var v = Number(frac[1]) / Number(frac[2]);
      if (isFinite(v)) return v;
    }
    var n = Number(p);
    if (!isFinite(n)) return 999;
    /* A bare fraction between the ends sorts between them; anything else — a
       plate's node number, say — sorts after, in numeric order. */
    return (n > 0 && n < 1) ? n : 2 + n;
  }

  /* ------------------------------------------------------- composed states */

  /**
   * Where an envelope resolves to a weighted SUM of single-valued cases rather
   * than to one child, the concurrent state is that sum. Combine the term rows
   * per (element, part, stage, step) and label the result with the expression.
   *
   * Every term is single-valued, so each is one deterministic state and their
   * weighted sum is one too. This is the arithmetic MIDAS does for an Add.
   *
   * @param {Array} rows    every row returned for the term series
   * @param {Array} terms   [{name, factor}] as resolved
   * @param {Object} opts   { label, matches(row, termName) }
   * @returns {{rows, missing}}  missing names the terms a member did not receive
   */
  function combineTerms(rows, terms, opts) {
    opts = opts || {};
    var buckets = Object.create(null);
    var order = [];
    var missing = Object.create(null);

    rows.forEach(function (r) {
      var term = null;
      for (var i = 0; i < terms.length; i++) {
        if (opts.matches(r, terms[i].name)) { term = terms[i]; break; }
      }
      if (!term) return;
      var id = r.source + SEP + r.elemKey + SEP + r.part + SEP + r.stage + SEP + r.step;
      var b = buckets[id];
      if (!b) {
        b = buckets[id] = {
          source: r.source, elem: r.elem, elemKey: r.elemKey, part: r.part,
          hasPart: r.hasPart, partKind: r.partKind, stage: r.stage, step: r.step,
          load: opts.label || "(resolved state)",
          values: Object.create(null), seen: Object.create(null)
        };
        order.push(id);
      }
      Object.keys(r.values).forEach(function (c) {
        if (r.values[c] == null) return;
        b.values[c] = (b.values[c] || 0) + term.factor * r.values[c];
      });
      b.seen[term.name] = true;
    });

    var out = order.map(function (id) {
      var b = buckets[id];
      var absent = terms.filter(function (t) { return !b.seen[t.name]; });
      /* A term that produced no row for this member is not a zero — it is a
         gap, and the report must say which term is missing rather than print a
         number that quietly omits it. */
      if (absent.length) missing[b.elemKey] = absent.map(function (t) { return t.name; });
      delete b.seen;
      b.key = joinKey(b);
      return b;
    });

    return { rows: out, missing: missing };
  }

  /* ------------------------------------------------------------ formatting */

  /**
   * Fixed-precision formatting with the exponential threshold raised — in
   * millimetre-newton units every moment reads as 1.519e+6 otherwise.
   *
   * NOT a clamping formatter. Nothing here is bounded to a range, so it is safe
   * to reuse for a derived quantity; a formatter that clamps must be named so
   * that nobody does.
   */
  function formatValue(v, sig) {
    if (v == null || !isFinite(v)) return "";
    sig = sig || 6;
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e9 || a < 1e-4)) return v.toExponential(Math.max(sig - 1, 1));
    var dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : 5;
    return v.toFixed(dp);
  }

  var api = {
    SEP: SEP, POSITIONS: POSITIONS, CRITERIA: CRITERIA, TIE_REL: TIE_REL,
    parseTable: parseTable, joinKey: joinKey, describeKey: describeKey,
    normPart: normPart, partAllowed: partAllowed, partRank: partRank,
    score: score, findGoverning: findGoverning, concurrentSet: concurrentSet,
    combineTerms: combineTerms, formatValue: formatValue
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfConcurrent = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
