/* ==========================================================================
   Beam to Plate — reading the model and planning the conversion
   --------------------------------------------------------------------------
   Everything here is pure apart from readTables, so the whole plan can be built
   and checked offline.

   NOTHING in this file writes. The plan is a complete description of what WOULD
   be written — every plate, every rigid link, every converted load, every
   reference that will be left dangling — and the UI shows it before the user
   commits.
   ========================================================================== */
(function (root) {
  "use strict";

  var FILES = { Section: "section", Mesh: "mesh", Loads: "loads", Model: "model", Walls: "walls", Geom: "geom2d" };
  var need = function (name) {
    return root["B2P" + name] || (typeof require === "function" ? require("./" + FILES[name] + ".js") : null);
  };
  var Section = need("Section"), Mesh = need("Mesh"), Loads = need("Loads"), Model = need("Model");
  var Walls = need("Walls"), Geom = need("Geom");

  var CONVERTIBLE = { BEAM: true };

  /* Read in three waves: the geometry always, the rest only when there is
     something to read it for. */
  var CORE = ["NODE", "ELEM", "SECT", "MATL", "THIK", "GRUP"];
  var ATTACH = ["CONS", "NSPR", "GSPR", "SSPS", "CNLD", "SDSP", "NMAS", "SKEW", "NTMP", "NBOF",
                "RIGD", "ELNK", "NLNK", "BNGR", "LDGR", "STLD"];
  var ELEMENT_DATA = ["BMLD", "FRLS", "OFFS", "ETMP", "STAG"];
  var DANGLING = Model.ELEMENT_TABLES.map(function (p) { return p[0]; });

  /** Read every table the conversion needs, plus /ope/SECTPROP. */
  async function readTables(mapi, onProgress) {
    var keys = CORE.concat(ATTACH, ELEMENT_DATA, DANGLING);
    var out = {};
    var done = 0;
    await Promise.all(keys.map(async function (key) {
      out[key] = await mapi.db(key);
      done++;
      if (onProgress) onProgress(done, keys.length + 1, key);
    }));
    out.SECTPROP = await mapi.sectProp();
    if (onProgress) onProgress(keys.length + 1, keys.length + 1, "SECTPROP");
    return out;
  }

  /** Normalise /db/ELEM into what the mesh needs. */
  function beams(tables) {
    var elemRows = (tables.ELEM && tables.ELEM.rows) || {};
    var nodeRows = (tables.NODE && tables.NODE.rows) || {};
    var offs = (tables.OFFS && tables.OFFS.rows) || {};
    var out = [];
    Object.keys(elemRows).forEach(function (id) {
      var e = elemRows[id] || {};
      var type = String(e.TYPE || "").toUpperCase();
      var nodes = (e.NODE || []).filter(function (n) { return Number(n) > 0; });
      var rec = {
        id: String(id), type: type,
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
          rec.nodeI = [Number(a.X) || 0, Number(a.Y) || 0, Number(a.Z) || 0];
          rec.nodeJ = [Number(b.X) || 0, Number(b.Y) || 0, Number(b.Z) || 0];
          rec.i = rec.nodeI; rec.j = rec.nodeJ;
          /* beam end offsets move the ends of the MESH; the link then spans the
             rigid zone, which is what an end offset is */
          var ax = Mesh.localAxes(rec.nodeI, rec.nodeJ, rec.angle);
          var off = ax ? Model.endOffsets(offs[id], ax) : null;
          if (off) {
            rec.i = add(rec.nodeI, off.I);
            rec.j = add(rec.nodeJ, off.J);
            rec.offsetEnd = { I: any(off.I), J: any(off.J) };
            rec.offsetNote = off.note;
            if (!(dist(rec.i, rec.j) > 0)) rec.skip = "its end offsets leave no length to mesh";
          }
        }
      }
      out.push(rec);
    });
    out.sort(function (p, q) { return Number(p.id) - Number(q.id); });
    return out;
  }

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function any(v) { return !!(v && (v[0] || v[1] || v[2])); }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

  /** Parse "101-118, 205, 300". A token that is not an id is reported. */
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

  /**
   * Apply the selection.
   *   selection  { mode: "selection"|"all"|"sect"|"ids"|"group", ids, sects,
   *                groups, selected:[ids from /view/SELECT] }
   */
  function select(allBeams, selection, tables) {
    selection = selection || { mode: "all" };
    var fromGroup = Object.create(null);
    if (selection.mode === "group") {
      var rows = (tables && tables.GRUP && tables.GRUP.rows) || {};
      Object.keys(rows).forEach(function (gid) {
        if ((selection.groups || []).indexOf(String(rows[gid].NAME)) === -1) return;
        (rows[gid].E_LIST || []).forEach(function (e) { fromGroup[String(e)] = true; });
      });
    }
    var picked = Object.create(null);
    (selection.selected || []).forEach(function (e) { picked[String(e)] = true; });
    return allBeams.filter(function (b) {
      if (b.skip) return false;
      if (selection.mode === "ids") return !!selection.ids[b.id];
      if (selection.mode === "sect") return (selection.sects || []).indexOf(b.sect) !== -1;
      if (selection.mode === "group") return !!fromGroup[b.id];
      if (selection.mode === "selection") return !!picked[b.id];
      return true;
    });
  }

  /* ------------------------------------------------------- section studies */

  function sectPropEntry(tables, id) {
    var sp = tables.SECTPROP;
    var body = sp && (sp.rows || sp);
    if (!body) return null;
    return body[String(id)] || null;
  }

  function studySections(tables, sectIds, opts) {
    var rows = (tables.SECT && tables.SECT.rows) || {};
    var out = {};
    sectIds.forEach(function (sid) {
      var row = rows[sid];
      if (!row) {
        out[sid] = { id: sid, name: "Section " + sid, ok: false, sectType: "", ends: {}, checks: {}, notes: [],
                     reason: "no /db/SECT row with this id — the element references a section the model does not publish" };
        return;
      }
      try {
        out[sid] = Section.study(sid, row, sectPropEntry(tables, sid), opts);
      } catch (err) {
        out[sid] = { id: sid, name: row.SECT_NAME || ("Section " + sid), ok: false, ends: {}, checks: {}, notes: [],
                     reason: "this section could not be interpreted (" + err.message + ")" };
      }
    });
    return out;
  }

  /* --------------------------------------------------------------- the plan */

  function estimate(selected, sections, opts) {
    var plates = 0, nodes = 0, elements = 0;
    selected.forEach(function (b) {
      var st = sections[b.sect];
      if (!st || !st.ok || st.blocked || !st.ends.I) return;
      var e = Mesh.estimate(dist(b.i, b.j), st.ends, opts);
      elements++; plates += e.plates; nodes += e.nodes;
    });
    return { elements: elements, plates: plates, nodes: nodes };
  }

  /**
   * Build the full conversion plan.
   * @param opts { longSize, transSize, minLong, minTrans, mergeTol, linkAll,
   *               convertLoads, materialFor(part, study) }
   */
  function buildPlan(selected, sections, tables, opts) {
    opts = opts || {};
    var pool = new Mesh.NodePool(opts.mergeTol);
    var elements = [], plates = [], meshes = [], loadList = [], skippedLoads = [];
    var convertedIds = Object.create(null);
    var worst = 0, loadResidual = 0;
    var bmld = (tables.BMLD && tables.BMLD.rows) || {};
    var etmp = (tables.ETMP && tables.ETMP.rows) || {};

    selected.forEach(function (b) {
      var st = sections[b.sect];
      if (!st || !st.ok || !st.ends.I) {
        elements.push({ id: b.id, sect: b.sect, ok: false,
                        reason: (st && st.reason) || "its section could not be interpreted" });
        return;
      }
      if (st.blocked) {
        elements.push({ id: b.id, sect: b.sect, ok: false, reason: "its section did not pass its checks: " + st.reason });
        return;
      }
      var mesh = Mesh.meshElement(pool, { id: b.id, i: b.i, j: b.j, angle: b.angle, matl: b.matl },
        st.ends, opts);
      if (!mesh.ok) {
        elements.push({ id: b.id, sect: b.sect, ok: false, reason: mesh.reason });
        return;
      }
      mesh.plates.forEach(function (p) {
        p.matl = materialOf(p, st, b, opts);
        plates.push(p);
      });
      worst = Math.max(worst, Math.abs(mesh.stats.error));
      meshes.push({ elem: b, mesh: mesh, study: st });
      convertedIds[b.id] = true;
      elements.push({ id: b.id, sect: b.sect, ok: true, stats: mesh.stats, sectName: st.name,
                      note: b.offsetNote || null });

      /* loads */
      if (opts.convertLoads !== false && bmld[b.id]) {
        var extent = Geom.polyProps(st.ends.I.regions);
        var ctx = {
          centroid: centroidOf(st.ends.I),
          depth: extent ? extent.bbox.max[1] - extent.bbox.min[1] : 0,
          width: extent ? extent.bbox.max[0] - extent.bbox.min[0] : 0
        };
        var conv = Loads.convertElement(bmld[b.id].ITEMS, mesh, pool, ctx);
        conv.loads.forEach(function (l) { loadList.push(l); });
        conv.skipped.forEach(function (s) { skippedLoads.push({ element: b.id, reason: s.reason }); });
        loadResidual = Math.max(loadResidual, conv.residual || 0);
      }
    });

    var links = Model.planLinks(meshes, tables, convertedIds, opts);
    var ties = Model.planTies(meshes, links.links);
    var groups = Model.planGroups(tables, meshes, convertedIds);
    var dangling = Model.danglingReferences(tables, convertedIds);
    var loads = Loads.combine(loadList);
    var temps = elementTemperatures(etmp, meshes);
    var thicknesses = collectThicknesses(plates, (tables.THIK && tables.THIK.rows) || {}, opts.thickTol);

    var okEls = elements.filter(function (e) { return e.ok; });
    return {
      pool: pool, elements: elements, plates: plates, meshes: meshes,
      links: links.links, freeEnds: links.freeEnds, conflicts: links.conflicts, ties: ties,
      groups: groups, dangling: dangling, loads: loads, skippedLoads: skippedLoads,
      temperatures: temps, thicknesses: thicknesses, convertedIds: convertedIds,
      totals: {
        converted: okEls.length,
        failed: elements.length - okEls.length,
        nodes: pool.list.length,
        plates: plates.length,
        thicknesses: thicknesses.length,
        links: links.links.length,
        ties: ties.reduce(function (a, t) { return a + t.slaves.length; }, 0),
        loads: loads.length,
        volume: okEls.reduce(function (a, e) { return a + e.stats.volume; }, 0),
        expected: okEls.reduce(function (a, e) { return a + e.stats.expected; }, 0),
        worstError: worst,
        loadResidual: loadResidual
      }
    };
  }

  /** The centroid of a placed wall model, in its own (node-line) frame. */
  function centroidOf(model) {
    var pp = Geom.polyProps(model.regions);
    if (pp) return [pp.cy, pp.cz];
    var wp = Walls.wallProps(model.walls);
    return wp ? [wp.cy, wp.cz] : [0, 0];
  }

  /** Which material a plate takes: the element's, or the slot chosen for its part. */
  function materialOf(plate, study, beam, opts) {
    if (!plate.part) return beam.matl;
    var chosen = opts.materialFor ? opts.materialFor(plate.part, study) : null;
    return chosen != null ? Number(chosen) : beam.matl;
  }

  /** Element temperatures follow the plates of their element. */
  function elementTemperatures(etmp, meshes) {
    var out = [];
    meshes.forEach(function (m) {
      var row = etmp[String(m.elem.id)];
      if (!row || !row.ITEMS) return;
      out.push({ source: m.elem.id, items: row.ITEMS, plates: m.mesh.plates });
    });
    return out;
  }

  /**
   * One THIK record per distinct thickness. Thicknesses within `tol` (relative)
   * of each other share a record — a chordal-axis mesh has a different thickness
   * on every piece, and a table with ten thousand near-identical records helps
   * nobody. The binning error is reported.
   */
  function collectThicknesses(plates, existing, tol) {
    tol = tol > 0 ? tol : 0.005;
    var sorted = plates.map(function (p) { return p.t; }).filter(function (t) { return t > 0; })
      .sort(function (a, b) { return a - b; });
    var bins = [];
    sorted.forEach(function (t) {
      var last = bins[bins.length - 1];
      if (last && t <= last.lo * (1 + tol)) { last.hi = t; last.sum += t; last.n++; return; }
      bins.push({ lo: t, hi: t, sum: t, n: 1 });
    });
    var existingList = [];
    Object.keys(existing || {}).forEach(function (id) {
      var v = Number(existing[id].T_IN);
      if (isFinite(v) && v > 0) existingList.push({ id: String(id), t: v, name: existing[id].NAME });
    });
    return bins.map(function (b) {
      var t = b.sum / b.n;
      var match = existingList.filter(function (e) { return Math.abs(e.t - t) <= Math.max(1e-12, t * tol); })[0];
      return { t: t, lo: b.lo, hi: b.hi, plates: b.n, reuseId: match ? match.id : null,
               name: match ? match.name : thikName(t), spread: b.lo > 0 ? (b.hi - b.lo) / b.lo : 0 };
    });
  }

  function thikName(t) {
    var v = t >= 1 ? t.toFixed(3) : t >= 0.01 ? t.toPrecision(4) : t.toExponential(2);
    var name = "B2P " + v;
    return name.length <= 16 ? name : name.slice(0, 16);
  }

  /** The THIK record a plate belongs to. */
  function thicknessFor(thicknesses, t) {
    for (var i = 0; i < thicknesses.length; i++) {
      var b = thicknesses[i];
      if (t >= b.lo * (1 - 1e-9) && t <= b.hi * (1 + 1e-9)) return b;
    }
    /* nearest, for a plate that slipped between bins */
    var best = null;
    thicknesses.forEach(function (b) {
      var d = Math.abs(b.t - t);
      if (!best || d < best.d) best = { d: d, b: b };
    });
    return best ? best.b : null;
  }

  /** Group the plan's failures so the UI shows each reason once, with a count. */
  function problems(plan, allBeams) {
    var byReason = Object.create(null);
    function note(reason, id) {
      if (!byReason[reason]) byReason[reason] = { reason: reason, ids: [] };
      byReason[reason].ids.push(id);
    }
    allBeams.forEach(function (b) { if (b.skip) note(b.skip, b.id); });
    plan.elements.forEach(function (e) { if (!e.ok) note(e.reason, e.id); });
    (plan.skippedLoads || []).forEach(function (s) { note("load not converted: " + s.reason, s.element); });
    return Object.keys(byReason).map(function (k) {
      var p = byReason[k];
      return { reason: p.reason, count: p.ids.length,
               sample: p.ids.slice(0, 8).join(", ") + (p.ids.length > 8 ? " …" : "") };
    });
  }

  var api = {
    CORE: CORE, ATTACH: ATTACH, ELEMENT_DATA: ELEMENT_DATA, CONVERTIBLE: CONVERTIBLE,
    readTables: readTables, beams: beams, parseIds: parseIds, select: select,
    studySections: studySections, estimate: estimate, buildPlan: buildPlan,
    collectThicknesses: collectThicknesses, thicknessFor: thicknessFor, thikName: thikName,
    problems: problems, centroidOf: centroidOf
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PPlan = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
