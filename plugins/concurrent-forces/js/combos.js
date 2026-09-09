/* ==========================================================================
   Concurrent Forces — the load model
   --------------------------------------------------------------------------
   Pure. No DOM, no network, no globals beyond the export. Everything here is
   exercised by `node test/run.js`.

   This module answers four questions about a load case or combination:

     1. Is it addressable, and with which suffix?  (envelopeValued)
     2. May a concurrent set be taken from it at all?  (blockages)
     3. Which result family does it belong to?  (familyOf)
     4. If it is an envelope, which single deterministic state is behind its
        governing value at the driver element?  (resolveState)

   The core principle the whole plugin rests on: two results are concurrent
   only if they come from the SAME deterministic structural state. A load type
   that is already an envelope at source has no single state behind its
   maximum, so no other element can be paired with it. Those are blocked here,
   never approximated.

   THE TREE WALK IS THE PRIMARY CHECK, not the (MV)/(SM)/(RS) suffix on the
   result label. A combination nested three levels deep can inherit a blocked
   constituent while looking perfectly clean from the outside — its own name
   carries no suffix at all. The suffix is implemented too, as a cheap second
   check on directly selected cases whose kind the definitions do not settle.
   ========================================================================== */
(function (root) {
  "use strict";

  /* `ANAL` on a vCOMB child, and the kind of a leaf load case. Verified in
     references/write-shapes.md: ST, CS, MV, RS, CB. SM and TH follow the same
     spelling in the result-table labels. */
  var KINDS = ["ST", "CS", "MV", "SM", "RS", "TH", "CB"];

  /* iTYPE on a /db/LCOM-* record. 0 Add, 1 Envelope, 2 ABS, 3 SRSS. */
  var COMB_TYPES = { 0: "ADD", 1: "ENVELOPE", 2: "ABS", 3: "SRSS" };

  /* A plugin that means "every combination" must read all ten sibling tables;
     reading only LCOM-GEN silently loses the steel/concrete/seismic families. */
  var LCOM_TABLES = [
    "LCOM-GEN", "LCOM-STEEL", "LCOM-CONC", "LCOM-SRC", "LCOM-FDN",
    "LCOM-STLCOMP", "LCOM-CFSTEEL", "LCOM-SEISMIC", "LCOM-LINEAR", "LCOM-ALU"
  ];

  /* The messages are part of the specification of this plugin: each one names
     the workaround, because "blocked" without a route forward is a dead end for
     the engineer holding the model. */
  var BLOCK_MESSAGES = {
    MV: "Moving load cases are envelopes and have no single governing vehicle " +
        "position available here. Use Results > Moving Load Tracer to convert the " +
        "governing loading condition into a static load case, re-run the analysis, " +
        "then select that static case.",
    SM: "Settlement cases are enveloped over the settlement group. Define the " +
        "governing settlement as an explicit specified-displacement static load " +
        "case and select that instead.",
    RS: "Response spectrum results are sign-less after modal combination, so " +
        "concurrent forces are undefined. No workaround — use a time history " +
        "analysis if concurrency is required.",
    TH_NOSTEP: "This time history case holds max/min output only, which is an " +
        "envelope over the whole record — there is no single step behind it. " +
        "Re-run the time history analysis with step-by-step results saved, then " +
        "select the case again.",
    ABS: "An ABS combination discards sign, so no signed structural state stands " +
        "behind its result. Rebuild the loading you need as an Add combination.",
    SRSS: "An SRSS combination combines its children quadratically, so no single " +
        "structural state stands behind its result. Rebuild the loading you need " +
        "as an Add combination.",
    UNKNOWN: "The plugin could not establish which kind of analysis produces this " +
        "case, so it cannot prove the case is not already an envelope. Blocked " +
        "rather than guessed.",
    CYCLE: "This combination refers to itself, directly or through its children. " +
        "It has no resolvable definition."
  };

  /* ------------------------------------------------------------ label parsing */

  /* The ONLY tokens that may be stripped from the tail of a load label. Real
     load case names contain parentheses of their own — "Lateral Earth Pressure
     (LHS)(1)" is a real one — so a greedy paren regex eats half the name. This
     vocabulary is closed on purpose: anything not in it is part of the name. */
  var TAIL_TOKENS = {
    ST: { kind: "ST" }, CS: { kind: "CS" }, CB: { kind: "CB" },
    MV: { kind: "MV" }, SM: { kind: "SM" }, RS: { kind: "RS" }, TH: { kind: "TH" },
    max: { sense: "max" }, min: { sense: "min" }, all: { sense: "all" }
  };

  /**
   * Split at most one recognised trailing token off a load label.
   * "ULS-1(CB:max)" -> {base:"ULS-1", kind:"CB", sense:"max"}
   * "Asphalt"       -> {base:"Asphalt"}
   * "Pressure (LHS)(1)" -> {base:"Pressure (LHS)(1)"}   ← nothing stripped
   */
  function splitLabel(label) {
    var s = String(label == null ? "" : label).trim();
    var m = /^([\s\S]*)\(([^()]*)\)$/.exec(s);
    if (!m) return { base: s };
    var inner = m[2].split(":");
    if (inner.length > 2) return { base: s };
    var head = TAIL_TOKENS[inner[0]];
    var tail = inner.length === 2 ? TAIL_TOKENS[inner[1]] : null;
    if (!head) return { base: s };
    if (inner.length === 2 && (!tail || !tail.sense)) return { base: s };
    var out = { base: m[1].trim() };
    if (head.kind) out.kind = head.kind;
    if (head.sense) out.sense = head.sense;
    if (tail) out.sense = tail.sense;
    return out;
  }

  /* ------------------------------------------------------------- build model */

  /**
   * Build the load model from what the API returned.
   *
   * @param {Object} input
   *   stld            rows of /db/STLD, or null
   *   combos          [{ table, rows }] one entry per LCOM-* table that answered
   *   caseTables      [{ table, kind, rows }] moving-load / settlement / RS / TH
   *                   case tables that were found by probing (see model.js)
   *   publishedLabels [string] every series the model publishes, from the
   *                   LOAD_CASE_NAMES:[] enumeration. Evidence of existence,
   *                   and — through its suffix — of kind.
   * @returns {Object} the model
   */
  function buildLoadModel(input) {
    input = input || {};
    var nodes = Object.create(null);
    var order = [];
    var warnings = [];

    function add(node) {
      if (nodes[node.name]) {
        warnings.push("Two definitions share the name \"" + node.name +
          "\" (" + nodes[node.name].origin + " and " + node.origin +
          "). The first is used; results addressed by name are ambiguous.");
        return;
      }
      nodes[node.name] = node;
      order.push(node.name);
    }

    /* Static load cases. /db/STLD carries NAME and TYPE, where TYPE is the load
       TYPE (D, L, W…) and not the analysis kind — every STLD row is ST. */
    eachRow(input.stld, function (row) {
      if (!row.NAME) return;
      add({ name: String(row.NAME), kind: "ST", isCombo: false, origin: "STLD" });
    });

    /* Case tables discovered by probing — moving load, settlement, response
       spectrum, time history. Their endpoint names differ per design code and
       per build, so model.js probes for them rather than assuming; whatever
       answered is passed in here with the kind it stands for. */
    (input.caseTables || []).forEach(function (t) {
      eachRow(t.rows, function (row) {
        if (!row.NAME) return;
        add({ name: String(row.NAME), kind: t.kind, isCombo: false, origin: t.table });
      });
    });

    /* Combinations, across all ten sibling tables. */
    (input.combos || []).forEach(function (t) {
      eachRow(t.rows, function (row) {
        if (!row.NAME) return;
        var children = (row.vCOMB || []).map(function (c) {
          return {
            anal: String(c.ANAL || "").toUpperCase(),
            name: String(c.LCNAME == null ? "" : c.LCNAME),
            factor: Number(c.FACTOR == null ? 1 : c.FACTOR)
          };
        });
        add({
          name: String(row.NAME), kind: "CB", isCombo: true,
          iTYPE: Number(row.iTYPE || 0),
          combType: COMB_TYPES[Number(row.iTYPE || 0)] || "ADD",
          active: row.ACTIVE == null || String(row.ACTIVE).toUpperCase() === "ACTIVE",
          table: t.table, children: children, origin: t.table
        });
      });
    });

    /* Constituents named by a combination but defined nowhere we read. The ANAL
       on the reference still tells us the kind, which is what the block walk
       needs — so record them rather than losing the branch. */
    order.slice().forEach(function (name) {
      var n = nodes[name];
      if (!n.isCombo) return;
      n.children.forEach(function (c) {
        if (!c.name || nodes[c.name]) return;
        if (c.anal === "CB") {
          add({ name: c.name, kind: "CB", isCombo: true, iTYPE: 0, combType: "ADD",
                children: [], missing: true, origin: "referenced by " + name });
        } else {
          add({ name: c.name, kind: KINDS.indexOf(c.anal) >= 0 ? c.anal : "UNKNOWN",
                isCombo: false, missing: true, origin: "referenced by " + name });
        }
      });
    });

    /* The published-series enumeration. Two jobs: it proves which series the
       analysis actually produced (a combination's definition is not evidence
       its constituents produce results), and its suffix is the cheap second
       check on a case whose kind the definitions never settled. */
    var published = Object.create(null);
    (input.publishedLabels || []).forEach(function (label) {
      var p = splitLabel(label);
      if (!p.base) return;
      var rec = published[p.base] || (published[p.base] = { senses: {}, kinds: {} });
      if (p.sense) rec.senses[p.sense] = true;
      if (p.kind) rec.kinds[p.kind] = true;
      var n = nodes[p.base];
      if (!n) {
        add({ name: p.base, kind: p.kind || "UNKNOWN", isCombo: p.kind === "CB",
              children: [], iTYPE: 0, combType: "ADD",
              origin: "published result series" });
      } else if (n.kind === "UNKNOWN" && p.kind) {
        n.kind = p.kind;
      } else if (p.kind && !n.isCombo && n.kind !== p.kind && p.kind !== "CB") {
        /* The suffix contradicts the definitions. Believe the SUFFIX when it
           names a blocked kind: a false block is recoverable, a false pass is
           a wrong number in a design check. */
        warnings.push("\"" + p.base + "\" is defined as " + n.kind +
          " but the result table labels it (" + p.kind + "). The result table " +
          "is believed.");
        n.kind = p.kind;
      }
    });

    return {
      nodes: nodes, order: order, published: published, warnings: warnings,
      /* Filled in by the caller once the time-history step audit has run. */
      thStepless: Object.create(null)
    };
  }

  function eachRow(rows, fn) {
    if (!rows) return;
    Object.keys(rows).forEach(function (id) {
      var row = rows[id];
      if (row && typeof row === "object") fn(row, id);
    });
  }

  /* -------------------------------------------------------- envelope-valued */

  /**
   * Is this name envelope-valued — i.e. does MIDAS report it as a max/min pair?
   *
   * Recursive, because it PROPAGATES: an Add containing an Envelope is itself a
   * max/min pair, and MIDAS agrees by refusing to address it without a sense.
   * Getting this wrong is not an error, it is SILENCE — the series is dropped
   * from the response at HTTP 200 with no note.
   */
  function envelopeValued(model, name, seen) {
    var n = model.nodes[name];
    if (!n) return false;
    if (n._env != null) return n._env;
    seen = seen || Object.create(null);
    if (seen[name]) return true;            /* a cycle is treated as unresolvable */
    seen[name] = true;

    var out;
    if (!n.isCombo) {
      out = n.kind === "MV" || n.kind === "SM" || n.kind === "RS";
    } else if (n.iTYPE === 1 || n.iTYPE === 2 || n.iTYPE === 3) {
      out = true;                            /* Envelope, ABS and SRSS all are */
    } else {
      out = n.children.some(function (c) { return envelopeValued(model, c.name, seen); });
    }
    delete seen[name];
    n._env = out;
    return out;
  }

  /* --------------------------------------------------------------- families */

  /**
   * Which /post/TABLE family answers for this name.
   *
   * OPT_CS is a MODE SWITCH, not a filter: one request answers with the
   * construction-stage series or with everything else, never both, and the
   * excluded family is absent at HTTP 200 with no error. Only a CS *case* sits
   * in the CS family — a CB combination is always in the ordinary family even
   * when every one of its children is a CS case.
   */
  function familyOf(model, name) {
    var n = model.nodes[name];
    if (!n) return "STD";
    return (!n.isCombo && n.kind === "CS") ? "CS" : "STD";
  }

  /* -------------------------------------------------------------- addressing */

  /** The LOAD_CASE_NAMES entry for a series. */
  function requestSeries(model, name, sense) {
    var n = model.nodes[name];
    if (!n) return name + "(ST)";
    if (!n.isCombo) return name + "(" + n.kind + ")";
    return envelopeValued(model, name)
      ? name + "(CB:" + (sense || "max") + ")"
      : name + "(CB)";
  }

  /**
   * The label the RESPONSE will carry for that series.
   *
   * Built per case rather than by stripping a suffix off the reply: the kind is
   * dropped and only the sense survives, and names carry their own trailing
   * parentheses. "Asphalt(ST)" comes back as "Asphalt", "ENV-1(CB:max)" as
   * "ENV-1(max)".
   *
   * Some builds keep the analysis kind on the label for the non-static kinds,
   * which is why matchesLabel() below accepts either form rather than one.
   */
  function responseLabel(model, name, sense) {
    var n = model.nodes[name];
    var enveloped = n && n.isCombo && envelopeValued(model, name);
    return enveloped ? name + "(" + (sense || "max") + ")" : name;
  }

  /** Does an observed Load cell correspond to this requested series? */
  function matchesLabel(model, name, sense, observed) {
    var want = responseLabel(model, name, sense);
    if (observed === want) return true;
    var p = splitLabel(observed);
    if (p.base !== name) return false;
    var enveloped = model.nodes[name] && envelopeValued(model, name);
    if (enveloped) return p.sense === (sense || "max");
    return !p.sense;
  }

  /* -------------------------------------------------------------- blockages */

  /**
   * Walk the full combination tree to its leaves and report every constituent
   * that makes a concurrent set impossible.
   *
   * This is the check that matters. A combination three levels deep inherits a
   * blocked leaf while its own name looks clean, and nothing in the result
   * table's own label would ever say so.
   *
   * @returns {Array} [{ code, leaf, path: [names], message }]
   */
  function blockages(model, name) {
    var found = [];
    var seenLeaf = Object.create(null);
    walk(name, [], Object.create(null));
    return found;

    function walk(nm, path, onPath) {
      var n = model.nodes[nm];
      var here = path.concat([nm]);
      if (onPath[nm]) { push("CYCLE", nm, here); return; }

      if (!n) { push("UNKNOWN", nm, here); return; }

      if (!n.isCombo) {
        if (n.kind === "MV" || n.kind === "SM" || n.kind === "RS") push(n.kind, nm, here);
        else if (n.kind === "TH" && model.thStepless[nm]) push("TH_NOSTEP", nm, here);
        else if (n.kind === "UNKNOWN") push("UNKNOWN", nm, here);
        return;
      }

      if (n.combType === "ABS" || n.combType === "SRSS") { push(n.combType, nm, here); return; }
      if (n.missing) { push("UNKNOWN", nm, here); return; }

      onPath[nm] = true;
      n.children.forEach(function (c) { if (c.name) walk(c.name, here, onPath); });
      delete onPath[nm];
    }

    function push(code, leaf, path) {
      var sig = code + "|" + leaf;
      if (seenLeaf[sig]) return;
      seenLeaf[sig] = true;
      found.push({
        code: code, leaf: leaf, path: path,
        message: BLOCK_MESSAGES[code] || BLOCK_MESSAGES.UNKNOWN
      });
    }
  }

  /** One line for the UI: why this entry is greyed out. */
  function blockTooltip(list) {
    if (!list.length) return "";
    return list.map(function (b) {
      var via = b.path.length > 1 ? " (via " + b.path.join(" → ") + ")" : "";
      return b.leaf + via + ": " + b.message;
    }).join("\n\n");
  }

  /* ------------------------------------------------------- envelope resolve */

  /* Two children can reproduce the parent's extreme to within the reported
     precision, and on a real model that is COMMON, not a corner case — 14 in
     the first 72 driver items measured. The policy, stated here and shown in
     the results header: the first in definition order wins, and every tie is
     reported. Silently picking one and saying nothing is the failure mode. */
  var TIE_REL = 1e-6;

  function close(a, b) {
    var d = Math.abs(a - b);
    var s = Math.max(Math.abs(a), Math.abs(b), 1e-12);
    return d / s <= TIE_REL;
  }

  /**
   * Resolve an envelope-valued name to the single deterministic state behind
   * its governing value at the driver element.
   *
   * RE-READING A RESOLVED NAME AT ANOTHER LOCATION IS WRONG, and it is wrong
   * quietly — the governing child is usually itself envelope-valued, so reading
   * it elsewhere returns that location's own independent extreme rather than
   * the coexistent value. Measured 72% out on a live model. So this descends
   * until every term is SINGLE-VALUED, multiplying factors down the path.
   *
   * @param {Object} model
   * @param {string} name       the envelope-valued name to resolve
   * @param {string} sense      "max" or "min" — the sense being resolved
   * @param {Function} measure  async (seriesRequests) => Map(requestKey -> number)
   *                            the value of the driver component at the driver
   *                            element and part, per requested series
   * @returns {Object} { terms, path, ties, notes, single }
   */
  async function resolveState(model, name, sense, measure) {
    var ties = [];
    var notes = [];
    var path = [];
    var terms = await pin(name, sense, 1, []);
    var single = terms.length === 1 && close(terms[0].factor, 1);
    return {
      terms: terms, path: path, ties: ties, notes: notes, single: single,
      expression: expressionOf(terms),
      resolvedName: single ? terms[0].name : null
    };

    async function pin(nm, sns, factor, trail) {
      var here = trail.concat([nm]);
      if (!envelopeValued(model, nm)) {
        if (here.length > path.length) path = here;
        return [{ name: nm, kind: (model.nodes[nm] || {}).kind || "ST", factor: factor }];
      }
      var n = model.nodes[nm];
      if (!n || !n.isCombo) {
        throw resolveError("\"" + nm + "\" is envelope-valued at source and cannot " +
          "be resolved to a single structural state.");
      }
      if (trail.indexOf(nm) >= 0) {
        throw resolveError("\"" + nm + "\" refers to itself; its definition cannot be resolved.");
      }

      /* What the parent itself reports — the number the resolution has to
         reproduce. Every reconstruction here is gated against it, and discarded
         when it misses, rather than shipping a plausible wrong answer. */
      var target = await one(requestSeries(model, nm, sns));

      if (n.combType === "ENVELOPE") {
        var chosen = await pickGoverning(n, sns, target, here);
        return pin(chosen.child.name, sns, factor * chosen.child.factor, here);
      }

      /* An ADD that is envelope-valued only because a child is. Two readings
         are possible and the model decides which, not us:
           A  the parent is the weighted SUM of its children with each envelope
              child pinned at its own extreme;
           B  the parent propagates a single child's extreme, which is what was
              measured on a live model: PAR(max) == max(A_max, B_max).
         A is tried first, B second, and BOTH are gated against the parent's
         published value. If neither reproduces it the resolution is refused —
         a number that cannot be reconciled with what MIDAS reports is not a
         number worth printing. */
      var sumTerms = [];
      for (var i = 0; i < n.children.length; i++) {
        var c = n.children[i];
        if (!c.name) continue;
        var sub = await pin(c.name, sns, factor * c.factor, here);
        sumTerms = sumTerms.concat(sub);
      }
      var sumValue = await valueOfTerms(sumTerms);
      if (close(sumValue / factor, target)) {
        if (n.children.filter(function (c) { return c.name; }).length > 1) {
          notes.push("\"" + nm + "\" is an Add whose extreme reconciles as the " +
            "weighted sum of its pinned children (" + fmt(sumValue / factor) +
            " against " + fmt(target) + " reported).");
        }
        return sumTerms;
      }

      var alt = await pickGoverning(n, sns, target, here, true);
      if (alt) {
        notes.push("\"" + nm + "\" is an Add that propagates one child's extreme " +
          "rather than summing (MIDAS reports " + fmt(target) + ", matched by " +
          alt.child.name + "). Resolved through that child.");
        return pin(alt.child.name, sns, factor * alt.child.factor, here);
      }

      throw resolveError("The " + sns + " of \"" + nm + "\" (" + fmt(target) +
        ") could not be reconciled with its own children — neither their weighted " +
        "sum (" + fmt(sumValue / factor) + ") nor any single child reproduces it. " +
        "Rather than report forces from a state that cannot be checked, this " +
        "combination is refused. Select one of its children directly.");
    }

    /** Which child carries the parent's extreme. Returns null in soft mode. */
    async function pickGoverning(n, sns, target, here, soft) {
      var cands = [];
      for (var i = 0; i < n.children.length; i++) {
        var c = n.children[i];
        if (!c.name) continue;
        var childSense = envelopeValued(model, c.name) ? sns : null;
        var v = await one(requestSeries(model, c.name, childSense));
        cands.push({ child: c, value: v * c.factor });
      }
      var hits = cands.filter(function (k) { return close(k.value, target); });
      if (!hits.length) {
        if (soft) return null;
        throw resolveError("No child of \"" + n.name + "\" reproduces its reported " +
          sns + " of " + fmt(target) + " at the key element. The envelope cannot be " +
          "resolved to a state, so no concurrent set is available from it.");
      }
      if (hits.length > 1) {
        ties.push({
          parent: n.name, sense: sns, value: target,
          children: hits.map(function (h) { return h.child.name; })
        });
      }
      return hits[0];                          /* first in definition order */
    }

    async function valueOfTerms(list) {
      var total = 0;
      for (var i = 0; i < list.length; i++) {
        total += list[i].factor * await one(requestSeries(model, list[i].name, null));
      }
      return total;
    }

    async function one(req) {
      var got = await measure([req]);
      var v = got && (got instanceof Map ? got.get(req) : got[req]);
      if (v == null || !isFinite(v)) {
        throw resolveError("The result series \"" + req + "\" returned nothing at the " +
          "key element. An unaddressable series is dropped silently by the API, so " +
          "this is the only signal there is — the combination cannot be resolved.");
      }
      return Number(v);
    }
  }

  function resolveError(message) {
    var e = new Error(message);
    e.name = "ResolveError";
    e.hint = "Envelope combinations are resolved to the single child that governs " +
             "at the key element, because filtering an envelope directly produces a " +
             "physically impossible set. Where that resolution cannot be checked " +
             "against the value MIDAS itself reports, the plugin refuses rather " +
             "than approximates.";
    return e;
  }

  /** The full resolved expression, which is what makes a result auditable:
      a header carrying only a combination name tells the next reviewer nothing
      about where the numbers came from. */
  function expressionOf(terms) {
    return terms.map(function (t, i) {
      var mag = Math.abs(t.factor);
      var lead = (mag === 1 ? "" : trimNum(mag) + " × ");
      var op = t.factor < 0 ? "− " : (i ? "+ " : "");
      return op + lead + t.name;
    }).join(" ");
  }

  function trimNum(v) { return String(Number(v.toFixed(6))); }
  function fmt(v) { return (v == null || !isFinite(v)) ? "—" : Number(v).toPrecision(6); }

  var api = {
    KINDS: KINDS, COMB_TYPES: COMB_TYPES, LCOM_TABLES: LCOM_TABLES,
    BLOCK_MESSAGES: BLOCK_MESSAGES, TIE_REL: TIE_REL,
    splitLabel: splitLabel, buildLoadModel: buildLoadModel,
    envelopeValued: envelopeValued, familyOf: familyOf,
    requestSeries: requestSeries, responseLabel: responseLabel, matchesLabel: matchesLabel,
    blockages: blockages, blockTooltip: blockTooltip,
    resolveState: resolveState, expressionOf: expressionOf, close: close
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfCombos = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
