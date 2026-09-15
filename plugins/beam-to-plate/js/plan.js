/* ==========================================================================
   Beam to Plate — reading the model and planning the conversion
   --------------------------------------------------------------------------
   Everything here is pure apart from the Mapi object handed to readTables, so
   the whole plan can be built and checked offline.

   NOTHING in this file writes. The plan is a complete description of what WOULD
   be written, including the per-element volume check, and the UI shows it before
   the user commits. A writing plugin that cannot show its work before it works
   is one the engineer cannot use on a real model.
   ========================================================================== */
(function (root) {
  "use strict";

  var Section = root.B2PSection || (typeof require === "function" ? require("./section.js") : null);
  var Mesh = root.B2PMesh || (typeof require === "function" ? require("./mesh.js") : null);

  /* Only these element types carry a section along a line. A plate, a solid or
     an elastic link is not a beam and is reported as skipped, not as a failure. */
  var CONVERTIBLE = { BEAM: true };

  var TABLES = ["NODE", "ELEM", "SECT", "MATL", "THIK", "GRUP"];

  /* ------------------------------------------------------------------ read */

  /** Read the tables the conversion needs. Concurrent — they have no ordering. */
  async function readTables(mapi, onProgress) {
    var out = {};
    var done = 0;
    await Promise.all(TABLES.map(async function (key) {
      out[key] = await mapi.db(key);
      done++;
      if (onProgress) onProgress(done, TABLES.length, key);
    }));
    return out;
  }

  /** Normalise /db/ELEM into the handful of fields the mesh needs. */
  function beams(tables) {
    var elemRows = (tables.ELEM && tables.ELEM.rows) || {};
    var nodeRows = (tables.NODE && tables.NODE.rows) || {};
    var out = [];
    Object.keys(elemRows).forEach(function (id) {
      var e = elemRows[id] || {};
      var type = String(e.TYPE || "").toUpperCase();
      /* Reads come back with NODE zero-padded to eight entries. */
      var nodes = (e.NODE || []).filter(function (n) { return Number(n) > 0; });
      var rec = {
        id: String(id),
        type: type,
        sect: e.SECT != null ? String(e.SECT) : "",
        matl: e.MATL != null ? Number(e.MATL) : 1,
        angle: Number(e.ANGLE) || 0,
        nodeIds: nodes.map(String)
      };
      if (!CONVERTIBLE[type]) {
        rec.skip = "not a beam element (" + (type || "no type") + ")";
      } else if (nodes.length !== 2) {
        rec.skip = "a beam with " + nodes.length + " nodes cannot be meshed";
      } else {
        var a = nodeRows[String(nodes[0])], b = nodeRows[String(nodes[1])];
        if (!a || !b) rec.skip = "one of its nodes is missing from /db/NODE";
        else {
          rec.i = [Number(a.X) || 0, Number(a.Y) || 0, Number(a.Z) || 0];
          rec.j = [Number(b.X) || 0, Number(b.Y) || 0, Number(b.Z) || 0];
        }
      }
      out.push(rec);
    });
    out.sort(function (p, q) { return Number(p.id) - Number(q.id); });
    return out;
  }

  /**
   * Parse an id selection: "101-118, 205, 300".
   * Returns { ids: Set-like object, bad: [tokens] } — a token that is not a
   * number or a range is REPORTED rather than ignored, because a typo that
   * silently selects nothing looks exactly like a plugin that does not work.
   */
  function parseIds(text) {
    var ids = Object.create(null), bad = [];
    String(text || "").split(/[\s,;]+/).forEach(function (tok) {
      if (!tok) return;
      var range = /^(\d+)\s*-\s*(\d+)$/.exec(tok);
      if (range) {
        var lo = Number(range[1]), hi = Number(range[2]);
        if (hi < lo) { bad.push(tok); return; }
        for (var i = lo; i <= hi; i++) ids[String(i)] = true;
        return;
      }
      if (/^\d+$/.test(tok)) { ids[tok] = true; return; }
      bad.push(tok);
    });
    return { ids: ids, bad: bad, count: Object.keys(ids).length };
  }

  /** Apply the user's selection to the normalised beam list. */
  function select(allBeams, selection) {
    selection = selection || { mode: "all" };
    return allBeams.filter(function (b) {
      if (b.skip) return false;
      if (selection.mode === "ids") return !!selection.ids[b.id];
      if (selection.mode === "sect") return selection.sects.indexOf(b.sect) !== -1;
      return true;
    });
  }

  /* --------------------------------------------------------- section study */

  /**
   * Interpret every section used by the selection, apply any user override, and
   * gate the result against the area the model publishes.
   *
   * A section is converted only when its gate passes or the user has accepted a
   * gate that could not run. `override` is what makes the plugin usable where
   * the shape tables in section.js are wrong: the engineer types the dimensions
   * off the section dialog and the gate confirms them.
   */
  function studySections(sectRows, sectIds, opts) {
    opts = opts || {};
    var overrides = opts.overrides || {};
    var out = {};
    sectIds.forEach(function (sid) {
      var row = sectRows && sectRows[sid];
      var study;
      if (!row) {
        study = { id: sid, name: "Section " + sid, ok: false, sectType: "",
                  published: null,
                  reason: "no /db/SECT row with this id — the element references a " +
                          "section the model does not publish" };
      } else {
        study = Section.readRow(sid, row);
      }

      var ov = overrides[sid] || {};
      if (ov.shape) {
        study.shape = ov.shape;
        study.overridden = true;
        study.ok = true;
        study.reason = null;
      }
      if (ov.dims) {
        study.dims = Object.assign({}, study.dims || {}, ov.dims);
        study.overridden = true;
        study.ok = !!study.shape;
        if (study.shape) study.reason = null;
      }

      if (study.ok && study.shape) {
        var built = Section.buildWalls(study.shape, study.dims, { pipeFacets: opts.pipeFacets });
        if (!built.ok) {
          study.ok = false;
          study.reason = built.reason;
        } else {
          study.model = Section.origin(built, opts.originRef);
          study.area = built.area;
          study.gate = Section.gate(built.area, study.published, opts.tolerance);
          /* A failed gate does not throw the section away — it stops it being
             converted silently. The user can accept it deliberately. */
          study.blocked = study.gate.status === "fail" && !ov.acceptGate;
          study.accepted = !!ov.acceptGate;
        }
      }
      out[sid] = study;
    });
    return out;
  }

  /* ------------------------------------------------------------- the plan */

  /**
   * How big would the mesh be, without building it?
   *
   * buildPlan() is synchronous, and synchronous work on the UI thread is what
   * makes a plugin's close button stop responding. A selection of a thousand
   * girders at a 50 mm mesh is tens of millions of plates — the honest answer is
   * to say so and refuse, not to freeze the window and be reported as broken.
   * The count is exact for the subdivision rule in mesh.js, so it can be trusted
   * as a limit rather than used as a rough guide.
   */
  function estimate(selected, sections, opts) {
    opts = opts || {};
    var plates = 0, nodes = 0, elements = 0;
    selected.forEach(function (b) {
      var study = sections[b.sect];
      if (!study || !study.ok || !study.model || study.blocked) return;
      var L = Math.hypot(b.j[0] - b.i[0], b.j[1] - b.i[1], b.j[2] - b.i[2]);
      var nLong = Math.max(opts.minLong || 1,
        opts.longSize > 0 ? Math.round(L / opts.longSize) || 1 : 1);
      var pieces = 0, pts = 0;
      study.model.walls.forEach(function (w) {
        var sub = Mesh.subdivide(w.pts, opts.transSize, opts.minTrans || 1);
        pieces += sub.length - 1;
        pts += sub.length;
      });
      elements++;
      plates += nLong * pieces;
      /* An upper bound: shared junctions and shared end sections only reduce it. */
      nodes += (nLong + 1) * pts;
    });
    return { elements: elements, plates: plates, nodes: nodes };
  }

  /**
   * Build the full conversion plan.
   *
   * @returns {{pool, elements, plates, thicknesses, totals, problems}}
   */
  function buildPlan(selected, sections, opts) {
    opts = opts || {};
    var pool = new Mesh.NodePool(opts.mergeTol);
    var elements = [];
    var plates = [];
    var worst = 0;

    selected.forEach(function (b) {
      var study = sections[b.sect];
      if (!study || !study.ok || !study.model) {
        elements.push({ id: b.id, sect: b.sect, ok: false,
          reason: (study && study.reason) || "its section could not be interpreted" });
        return;
      }
      if (study.blocked) {
        elements.push({ id: b.id, sect: b.sect, ok: false,
          reason: "its section failed the area check" });
        return;
      }
      var meshed = Mesh.meshElement(pool, b, study.model, opts);
      if (!meshed.ok) {
        elements.push({ id: b.id, sect: b.sect, ok: false, reason: meshed.reason });
        return;
      }
      meshed.plates.forEach(function (p) { plates.push(p); });
      worst = Math.max(worst, Math.abs(meshed.stats.error));
      elements.push({ id: b.id, sect: b.sect, ok: true, stats: meshed.stats,
                      sectName: study.name });
    });

    var thicknesses = collectThicknesses(plates, opts.existingThik);

    var okEls = elements.filter(function (e) { return e.ok; });
    return {
      pool: pool,
      elements: elements,
      plates: plates,
      thicknesses: thicknesses,
      totals: {
        converted: okEls.length,
        failed: elements.length - okEls.length,
        nodes: pool.list.length,
        plates: plates.length,
        thicknesses: thicknesses.length,
        volume: okEls.reduce(function (a, e) { return a + e.stats.volume; }, 0),
        expected: okEls.reduce(function (a, e) { return a + e.stats.expected; }, 0),
        worstError: worst
      }
    };
  }

  /**
   * One THIK record per distinct plate thickness, reusing an existing record
   * where the model already has that value.
   *
   * Reuse is by VALUE, not by name: a model converted twice must not accumulate
   * a second "B2P 12mm" beside the first. The names are kept short deliberately
   * — MIDAS's name caps differ per table and THIK's was not measured, so the
   * scheme is sized to the shortest cap seen anywhere (16).
   */
  function collectThicknesses(plates, existingThik) {
    var byValue = Object.create(null);
    plates.forEach(function (p) {
      var key = round(p.t, 9);
      if (!byValue[key]) byValue[key] = { t: p.t, key: key, plates: 0 };
      byValue[key].plates++;
    });

    var existing = [];
    Object.keys(existingThik || {}).forEach(function (id) {
      var r = existingThik[id] || {};
      var v = Number(r.T_IN);
      if (isFinite(v) && v > 0) existing.push({ id: String(id), t: v, name: r.NAME });
    });

    return Object.keys(byValue).map(function (k) {
      var rec = byValue[k];
      var match = existing.filter(function (e) {
        return Math.abs(e.t - rec.t) <= Math.max(1e-9, rec.t * 1e-6);
      })[0];
      rec.reuseId = match ? match.id : null;
      rec.name = match ? match.name : thikName(rec.t);
      return rec;
    }).sort(function (a, b) { return a.t - b.t; });
  }

  /** A name that fits the tightest cap measured on any table (16 characters). */
  function thikName(t) {
    var mm = t * 1000;
    var txt = mm >= 100 ? mm.toFixed(0) : mm >= 10 ? mm.toFixed(1) : mm.toFixed(2);
    var name = "B2P " + txt;
    return name.length <= 16 ? name : name.slice(0, 16);
  }

  function round(v, p) {
    var f = Math.pow(10, p);
    return String(Math.round(v * f) / f);
  }

  /* --------------------------------------------------------------- report */

  /** Group the plan's failures so the UI shows each reason once, with a count. */
  function problems(plan, allBeams, selected) {
    var byReason = Object.create(null);
    function note(reason, id) {
      if (!byReason[reason]) byReason[reason] = { reason: reason, ids: [] };
      byReason[reason].ids.push(id);
    }
    allBeams.forEach(function (b) { if (b.skip) note(b.skip, b.id); });
    plan.elements.forEach(function (e) { if (!e.ok) note(e.reason, e.id); });
    return Object.keys(byReason).map(function (k) {
      var p = byReason[k];
      return { reason: p.reason, count: p.ids.length,
               sample: p.ids.slice(0, 8).join(", ") + (p.ids.length > 8 ? " …" : "") };
    });
  }

  var api = {
    TABLES: TABLES,
    CONVERTIBLE: CONVERTIBLE,
    readTables: readTables,
    beams: beams,
    parseIds: parseIds,
    select: select,
    studySections: studySections,
    estimate: estimate,
    buildPlan: buildPlan,
    collectThicknesses: collectThicknesses,
    thikName: thikName,
    problems: problems
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PPlan = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
