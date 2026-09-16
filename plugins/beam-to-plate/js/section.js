/* ==========================================================================
   Beam to Plate — reading a section
   --------------------------------------------------------------------------
   One /db/SECT row + its /ope/SECTPROP entry  →  a STUDY: a wall model for
   each end of the section, already placed on the element's node line, with
   every check the conversion depends on.

   Where the geometry comes from, in the order tried:

     exact     DB/User shape with dimensions (vSIZE) and a known wall layout
     outline   PSC guide curve, OUTER/INNER_POLYGON, general composite parts,
               or any other DB/User shape → walls by chordal axis / strips
     catalogue a DATATYPE 1 section: the API gives a NAME, no dimensions. The
               dimensions are recovered from the published properties — for
               rolled I, channel and tee the shear areas give them directly
               (Asz = tw.H, Asy = 5/6 (B1.tf1 + B2.tf2), verified on a live
               UC 356x406x287) — then checked on Iyy/Izz
     stress    a VALUE section whose stress points enclose its published area:
               the points ARE its corners
     equivalent a VALUE section with no usable geometry: an I or box fitted to
               A, Iyy, Izz and the centroid. Labelled as equivalent, never as
               the real shape.

   Placement on the node line (all measured on CIVIL NX 2026 by analysis,
   2026-09-15 — an axial load at the node line of an offset section, tip
   displacements compared with P.e.L²/2EI):

     OFFSET_PT     first letter L/C/R across (L = -y), second T/C/B vertical
     OFFSET_CENTER 0: "C" means the centroid · 1: the middle of the extents
     user offset   applies only on an EDGE letter (L/R with HORZ_OFFSET_OPT 1,
                   T/B with VERT_OFFSET_OPT 1). USER_OFFSET_REF 0 measures the
                   distance from the centroid towards the named edge; 1
                   measures it from that edge inwards. A negative value flips.
   ========================================================================== */
(function (root) {
  "use strict";

  var G = root.B2PGeom || (typeof require === "function" ? require("./geom2d.js") : null);
  var W = root.B2PWalls || (typeof require === "function" ? require("./walls.js") : null);
  var SS = root.SectShape || (typeof require === "function" ? require("./sect-shape.js") : null);

  /* Dimension names per code, for the editable table in the UI. Order is the
     API's vSIZE order (manual article "Section Properties - DB/User", with the
     geometry of the common ones measured live). */
  var DIMS = {
    H: ["H", "B1", "tw", "tf1", "B2", "tf2", "r1", "r2"],
    B: ["H", "B", "tw", "tf1", "C", "tf2"],
    T: ["H", "B", "tw", "tf"],
    C: ["H", "B1", "tw", "tf1", "B2", "tf2"],
    L: ["H", "B", "tw", "tf"],
    P: ["D", "tw"],
    SB: ["H", "B"],
    SR: ["D"],
    "2L": ["H", "B", "tw", "tf", "C"],
    "2C": ["H", "B", "tw", "tf", "C"],
    UDT: ["H", "B1", "B2", "tw", "tf"],
    OCT: ["H", "B", "a", "b", "t"],
    SOCT: ["H", "B", "a", "b"],
    TRK: ["H", "B", "t"],
    STRK: ["H", "B"],
    HTRK: ["H", "B"],
    I: ["Hw", "tw", "B1", "tf1", "B2", "tf2"],
    CC: ["H", "B", "tw", "r", "d"],
    URIB: ["H", "B1", "B2", "t", "R"],
    Z: ["H", "B", "tw", "r", "d", "th"],
    ROCT: ["H", "B", "a", "b", "t1", "t2", "t3"],
    BSTF: ["H", "B", "tf", "tw", "S1", "Hr1", "tr1", "S2", "Hr2", "tr2"],
    PSTF: ["D", "tw", "Hr", "tr"],
    UP: ["H", "B", "tw", "Hw1", "Hw2", "B1", "B2", "B3", "Bf3", "d"]
  };

  var LABELS = {
    H: "I / H", B: "Box", T: "Tee", C: "Channel", L: "Angle", P: "Pipe", SB: "Solid rectangle",
    SR: "Solid round", "2L": "Double angle", "2C": "Double channel", UDT: "Inverted tee",
    OCT: "Octagon", SOCT: "Solid octagon", TRK: "Track", STRK: "Solid track", HTRK: "Half track",
    I: "Plate girder", CC: "Cold-formed channel", URIB: "U-rib", Z: "Z", ROCT: "R-octagon",
    BSTF: "Stiffened box", PSTF: "Stiffened pipe", UP: "U-profile"
  };

  var TOL = { reading: 0.02, readingI: 0.05, ideal: 0.05, idealFail: 0.15 };

  /* ------------------------------------------------------------ SECTPROP */

  /**
   * Parse one /ope/SECTPROP entry. Its columns change with the section:
   *   ["Property","Value","Unit"]
   *   ["Property","Value(I)","Value(J)","Unit"]                    tapered
   *   ["Property","Value(Before)","Value(After)","Unit"]           composite
   *   ["Property","Before(I)","After(I)","Before(J)","After(J)","Unit"]
   * Numbers arrive as TEXT. Returns { I: {before, after}, J: {...} } of maps.
   */
  function parseProps(entry) {
    if (!entry || !Array.isArray(entry.DATA)) return null;
    var head = (entry.HEAD || []).map(String);
    var cols = [];
    head.forEach(function (h, i) {
      if (i === 0 || /^unit$/i.test(h)) return;
      var end = /\(J\)/i.test(h) ? "J" : "I";
      var phase = /after/i.test(h) ? "after" : "before";
      cols.push({ i: i, end: end, phase: phase });
    });
    if (!cols.length && head.length === 0) cols.push({ i: 1, end: "I", phase: "before" });
    var out = { I: { before: {}, after: {} }, J: { before: {}, after: {} } };
    entry.DATA.forEach(function (row) {
      cols.forEach(function (c) {
        var v = Number(row[c.i]);
        if (isFinite(v)) out[c.end][c.phase][String(row[0])] = v;
      });
    });
    ["I", "J"].forEach(function (e) {
      if (!Object.keys(out[e].after).length) out[e].after = out[e].before;
    });
    if (!Object.keys(out.J.before).length) out.J = null;
    return out;
  }

  /** Published props in the names used here. */
  function pub(map) {
    if (!map || !(map.Area > 0)) return null;
    var y = [], z = [];
    for (var i = 1; i <= 16; i++) {
      if (map["y" + i] != null && map["z" + i] != null) { y.push(map["y" + i]); z.push(map["z" + i]); }
    }
    return {
      A: map.Area, Iyy: map.Iyy, Izz: map.Izz, Ixx: map.Ixx, Asy: map.Asy, Asz: map.Asz,
      Cyp: map.Cyp, Cym: map.Cym, Czp: map.Czp, Czm: map.Czm,
      width: (map.Cyp || 0) + (map.Cym || 0), depth: (map.Czp || 0) + (map.Czm || 0),
      stress: y.length ? { y: y, z: z } : null
    };
  }

  /** A part's own STIFF block (upper-case keys, RYY/RZZ for the second moments). */
  function stiffPub(s) {
    if (!s || !(Number(s.AREA) > 0)) return null;
    return { A: Number(s.AREA), Iyy: Number(s.RYY), Izz: Number(s.RZZ), Ixx: Number(s.RXX),
             Asy: Number(s.ASY), Asz: Number(s.ASZ), Cyp: Number(s.CYP), Cym: Number(s.CYM),
             Czp: Number(s.CZP), Czm: Number(s.CZM),
             width: Number(s.CYP) + Number(s.CYM), depth: Number(s.CZP) + Number(s.CZM), stress: null };
  }

  /* ------------------------------------------------------------- reading */

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function nums(a) { return Array.isArray(a) ? a.map(num) : null; }

  function polygonOf(list) {
    if (!Array.isArray(list) || !list.length) return null;
    var verts = list[0] && list[0].VERTEX;
    if (!Array.isArray(verts) || verts.length < 3) return null;
    return verts.map(function (p) { return [num(p.X), num(p.Y)]; });
  }

  /** One end's raw geometry sources. */
  function endOf(si, before) {
    if (!si || typeof si !== "object") return null;
    var e = {
      vSize: nums(si.vSIZE),
      psc: (si.vSIZE_PSC_A || si.vSIZE_PSC_B) ? { a: nums(si.vSIZE_PSC_A), b: nums(si.vSIZE_PSC_B),
        c: nums(si.vSIZE_PSC_C), d: nums(si.vSIZE_PSC_D) } : null,
      joints: Array.isArray(before.JOINT) ? before.JOINT.slice() : null,
      cells: [before.PSC_OPT1, before.PSC_OPT2],
      polygon: null, holes: [], parts: null, stiff: si.STIFF || null,
      dbName: si.DB_NAME || "", dbSection: si.SECT_NAME || ""
    };
    if (Array.isArray(si.GENERAL_PART) && Array.isArray(si.OUTER_POLYGON)) e.parts = generalParts(si);
    else e.polygon = polygonOf(si.OUTER_POLYGON);
    if (Array.isArray(si.INNER_POLYGON)) {
      /* seen both as [{VERTEX}] per void and as one flat VERTEX list */
      si.INNER_POLYGON.forEach(function (ring) {
        var p = ring && ring.VERTEX ? polygonOf([ring]) : null;
        if (p) e.holes.push(p);
      });
      if (!e.holes.length && si.INNER_POLYGON.length >= 3 && si.INNER_POLYGON[0].X !== undefined) {
        e.holes.push(si.INNER_POLYGON.map(function (p) { return [num(p.X), num(p.Y)]; }));
      }
    }
    return e;
  }

  /* COMPOSITE-GEN: parts are plate LINEs (a vertex pool + connectivity) or
     polygon rings — see the midasplugin reference for why the pool is never a
     ring. Each part keeps its material data. */
  function generalParts(si) {
    var pool = [], ringStart = [];
    si.OUTER_POLYGON.forEach(function (r) {
      ringStart.push(pool.length);
      (Array.isArray(r && r.VERTEX) ? r.VERTEX : []).forEach(function (p) { pool.push([num(p.X), num(p.Y)]); });
    });
    ringStart.push(pool.length);
    var lines = Array.isArray(si.LINE) ? si.LINE : [];
    return si.GENERAL_PART.map(function (part, i) {
      var from = Array.isArray(part.IDX_START) ? num(part.IDX_START[0]) : i;
      var to = Array.isArray(part.IDX_END) ? num(part.IDX_END[0]) : i + 1;
      if (to <= from) to = from + 1;
      var lo = ringStart[from] == null ? 0 : ringStart[from];
      var hi = ringStart[to] == null ? pool.length : ringStart[to];
      var mine = lines.filter(function (l) {
        var a = num(l.VERTEX_ID1), b = num(l.VERTEX_ID2);
        return a >= lo && a < hi && b >= lo && b < hi;
      });
      var out = { index: i, useBase: part.USE_BASE_MATL === true, elast: num(part.ELAST), poisson: num(part.POISSON),
                  stiff: part.STIFF || null, plates: [], rings: [] };
      if (mine.length) {
        mine.forEach(function (l) {
          var a = pool[num(l.VERTEX_ID1)], b = pool[num(l.VERTEX_ID2)];
          if (a && b && num(l.THICK) > 0) out.plates.push({ a: a, b: b, t: num(l.THICK) });
        });
      } else {
        for (var k = from; k < to && k < si.OUTER_POLYGON.length; k++) {
          var ring = polygonOf([si.OUTER_POLYGON[k]]);
          if (ring) out.rings.push(ring);
        }
      }
      return out;
    });
  }

  function readRow(id, row) {
    row = row || {};
    var before = row.SECT_BEFORE || {};
    var sectType = String(row.SECTTYPE || "").toUpperCase();
    var after = row.SECT_AFTER || null;
    var info = {
      id: String(id), name: row.SECT_NAME || ("Section " + id), sectType: sectType,
      shape: String(before.SHAPE || "").toUpperCase(),
      datatype: before.DATATYPE == null ? null : num(before.DATATYPE),
      offset: {
        pt: String(before.OFFSET_PT || "CC").toUpperCase(),
        center: num(before.OFFSET_CENTER),
        ref: num(before.USER_OFFSET_REF),
        horz: num(before.HORZ_OFFSET_OPT), yi: num(before.USERDEF_OFFSET_YI),
        yj: before.USERDEF_OFFSET_YJ == null ? num(before.USERDEF_OFFSET_YI) : num(before.USERDEF_OFFSET_YJ),
        vert: num(before.VERT_OFFSET_OPT), zi: num(before.USERDEF_OFFSET_ZI),
        zj: before.USERDEF_OFFSET_ZJ == null ? num(before.USERDEF_OFFSET_ZI) : num(before.USERDEF_OFFSET_ZJ)
      },
      tapered: /TAPER/.test(sectType),
      taper: { yVar: num(before.Y_VAR) || 1, zVar: num(before.Z_VAR) || 1 },
      ends: { I: endOf(before.SECT_I, before), J: null },
      slab: null, modular: num(before.MATL_ELAST) || null,
      cells: { n1: num(before.CELL_SHAPE), n2: num(before.CELL_TYPE) }
    };
    if (info.tapered) info.ends.J = endOf(before.SECT_J || row.COMPOSITE_J, before);
    if (after) {
      if (Array.isArray(after.SLAB) && num(after.SLAB[1]) > 0) {
        info.slab = { width: num(after.SLAB[0]), thickness: num(after.SLAB[1]), haunch: num(after.SLAB[2]) };
      } else {
        Object.keys(after).forEach(function (k) {
          var v = after[k] && after[k].vSIZE;
          if (!info.slab && Array.isArray(v) && v.length >= 2 && num(v[0]) > 0 && num(v[1]) > 0) {
            info.slab = { width: num(v[0]), thickness: num(v[1]), haunch: num(v[2]) };
          }
        });
      }
    }
    return info;
  }

  /* ------------------------------------------------------- one end → walls */

  /**
   * Build the wall model for ONE end.
   * @returns {{ok, model?, source, reason?, note?, outline?}}
   */
  function buildEnd(info, end, published, opts, hintModel) {
    opts = opts || {};
    var override = opts.override || {};
    var code = override.shape || info.shape;
    var vSize = override.dims ? override.dims : (end && end.vSize);

    /* An engineer's override always wins: shape + dimensions typed off the
       section dialog. */
    if (override.shape && override.dims) {
      return fromCode(code, vSize, opts, hintModel, "override");
    }

    if (info.sectType === "VALUE" || info.sectType === "PSCVALUE") {
      return valueSection(info, published, opts);
    }

    /* general composite */
    if (end && end.parts) return fromParts(end.parts, opts, hintModel);

    /* explicit polygon (PSC value, composite PC, anything carrying one) */
    if (end && end.polygon && end.polygon.length >= 3) {
      return fromOutline([{ outer: end.polygon, holes: end.holes }], opts, hintModel, "polygon");
    }

    /* PSC guide curve */
    if (end && end.psc) {
      var key = SS._internal.PSC_KEYS[code] ? code : SS.matchPscBySignature(end.psc);
      if (!key) return { ok: false, reason: "PSC shape \"" + code + "\" has no known guide-curve layout" };
      var dims = SS.pscDimsOf(key, end.psc);
      var built = dims ? SS._internal.PSC_KEYS[key].build(dims, end.joints, end.cells) : null;
      if (!built || !built.outer) return { ok: false, reason: "the " + key + " guide curve could not be rebuilt" };
      return fromOutline([{ outer: built.outer, holes: built.holes || [] }], opts, hintModel, "psc");
    }

    /* catalogue section: dimensions from the properties */
    if (Number(info.datatype) === 1 && !(vSize && vSize.some(function (v) { return v > 0; }))) {
      return catalogue(info, end, published, opts);
    }

    if (vSize && vSize.some(function (v) { return v > 0; })) {
      var fc = fromCode(code, vSize, opts, hintModel, "exact");
      if (fc.ok || !published) return fc;
      /* A shape this plugin has no layout for is still a set of published
         properties — treat it the way a VALUE section is treated. */
      var vs = valueSection(info, published, opts);
      if (vs.ok) vs.note = "shape code \"" + code + "\" has no known layout, so: " + (vs.note || "");
      return vs.ok ? vs : fc;
    }
    if (published) {
      var v2 = valueSection(info, published, opts);
      if (v2.ok) { v2.note = "the section publishes no geometry, so: " + (v2.note || ""); return v2; }
    }
    return { ok: false, reason: "the section publishes no geometry (no vSIZE, guide curve or polygon)" };
  }

  function fromCode(code, v, opts, hintModel, source) {
    var ex = W.exact(code, v, { facets: opts.facets });
    if (ex) {
      ex.source = source === "override" ? "override" : "exact";
      return { ok: true, model: ex, source: ex.source };
    }
    var fn = SS._internal.SHAPES[code];
    if (!fn) return { ok: false, reason: "shape code \"" + code + "\" is not one this plugin knows" };
    var s = fn(v, { cells: { n1: 0, n2: 0 } });
    if (s && s.candidates) s = s.candidates[0];
    if (!s || !s.outer) return { ok: false, reason: "the " + code + " dimensions are incomplete or inconsistent" };
    var regions = [{ outer: s.outer, holes: s.holes || [] }].concat((s.extras || []).map(function (x) { return { outer: x, holes: [] }; }));
    return fromOutline(regions, opts, hintModel, source === "override" ? "override" : "outline");
  }

  function fromOutline(regions, opts, hintModel, source) {
    var m = W.fromRegions(regions, { topology: hintModel && hintModel.topology, compactness: opts.compactness });
    if (!m && hintModel) m = W.fromRegions(regions, { compactness: opts.compactness });
    if (!m || !m.walls.length) return { ok: false, reason: "no wall layout could be found in the outline" };
    if (m.walls.length > 1 || regions.length > 1) m.connectors = autoConnect(m.walls);
    m.source = source;
    return { ok: true, model: m, source: source };
  }

  function fromParts(parts, opts, hintModel) {
    var walls = [], regions = [], topology = [], hints = hintModel && hintModel.topology;
    var pi = 0;
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.plates.length) {
        part.plates.forEach(function (pl) {
          walls.push(W.wall("Part " + (i + 1) + " plate", pl.t, [pl.a, pl.b], { part: i }));
          var dy = pl.b[0] - pl.a[0], dz = pl.b[1] - pl.a[1], L = Math.hypot(dy, dz) || 1;
          var ny = -dz / L * pl.t / 2, nz = dy / L * pl.t / 2;
          regions.push({ part: i, outer: [[pl.a[0] + ny, pl.a[1] + nz], [pl.b[0] + ny, pl.b[1] + nz],
            [pl.b[0] - ny, pl.b[1] - nz], [pl.a[0] - ny, pl.a[1] - nz]], holes: [] });
        });
        topology.push(null);
      } else {
        var rg = part.rings.map(function (r) { return { outer: r, holes: [] }; });
        var m = W.fromRegions(rg, { topology: hints ? hints[pi] : null, compactness: opts.compactness }) ||
                W.fromRegions(rg, { compactness: opts.compactness });
        if (!m) return { ok: false, reason: "part " + (i + 1) + " of the general composite has no wall layout" };
        m.walls.forEach(function (w) { w.part = i; walls.push(w); });
        rg.forEach(function (r) { r.part = i; regions.push(r); });
        topology.push(m.topology);
      }
      pi++;
    }
    /* plate LINEs share vertices where they join — the node pool merges them.
       Parts that only touch are tied by rigid connectors. */
    var model = { walls: walls, regions: regions, connectors: autoConnect(walls), method: "parts",
                  topology: topology, source: "polygon", parts: parts };
    return { ok: true, model: model, source: "polygon" };
  }

  /**
   * Rigid ties between walls of DIFFERENT parts (and separate regions of one
   * part) that touch or nearly touch. For every end/junction point of one part,
   * the nearest point on the other parts' walls within half the sum of their
   * thicknesses plus a small gap is tied to it.
   */
  function autoConnect(walls, extraGap) {
    var out = [];
    var groups = Object.create(null);
    walls.forEach(function (w, wi) { (groups[w.part] || (groups[w.part] = [])).push(wi); });
    var partIds = Object.keys(groups);
    if (partIds.length < 2) return out;
    walls.forEach(function (w, wi) {
      [0, w.pts.length - 1].forEach(function (k) {
        var p = w.pts[k], tp = w.t[Math.min(k, w.t.length - 1)] || 0;
        var best = null;
        walls.forEach(function (o, oi) {
          if (o.part === w.part) return;
          for (var s = 0; s < (o.closed ? o.pts.length : o.pts.length - 1); s++) {
            var a = o.pts[s], b = o.pts[(s + 1) % o.pts.length];
            var q = closest(p, a, b), d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            var lim = (tp + (o.t[s] || 0)) / 2 * 1.05 + (extraGap || 0) + 1e-9;
            if (d <= lim && (!best || d < best.d)) best = { d: d, q: q, oi: oi, s: s };
          }
        });
        if (best && w.part < walls[best.oi].part) {
          /* the tie must land on a mesh node: split the other wall there */
          var q2 = insertPoint(walls[best.oi], best.s, best.q);
          out.push({ a: p.slice(), b: q2 });
        }
      });
    });
    return dedupeConnectors(out);
  }

  /** Split segment s of a wall at q (or reuse a vertex within a hair of it); mark it hard. */
  function insertPoint(w, s, q) {
    var n = w.pts.length, a = w.pts[s], b = w.pts[(s + 1) % n];
    var eps = 1e-9 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
    if (Math.hypot(q[0] - a[0], q[1] - a[1]) <= eps) { w.hard[s] = true; return a.slice(); }
    if (Math.hypot(q[0] - b[0], q[1] - b[1]) <= eps) { w.hard[(s + 1) % n] = true; return b.slice(); }
    w.pts.splice(s + 1, 0, [q[0], q[1]]);
    w.t.splice(s + 1, 0, w.t[s]);
    w.hard.splice(s + 1, 0, true);
    return [q[0], q[1]];
  }

  function closest(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    var t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return [a[0] + dx * t, a[1] + dy * t];
  }

  function dedupeConnectors(list) {
    var seen = Object.create(null);
    return list.filter(function (c) {
      var k = c.a.map(function (v) { return v.toFixed(9); }).join(",") + "|" + c.b.map(function (v) { return v.toFixed(9); }).join(",");
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  /* ---------------------------------------------------------- VALUE sections */

  function valueSection(info, published, opts) {
    if (!published) {
      return { ok: false, reason: "a VALUE section carries only properties, and /ope/SECTPROP published none for it" };
    }
    var sp = published.stress;
    if (sp && sp.y.length >= 2) {
      var ymin = Math.min.apply(null, sp.y), ymax = Math.max.apply(null, sp.y);
      var zmin = Math.min.apply(null, sp.z), zmax = Math.max.apply(null, sp.z);
      var rectA = (ymax - ymin) * (zmax - zmin);
      if (rectA > 0 && Math.abs(rectA - published.A) / published.A <= TOL.reading) {
        var reg = [{ outer: W.rect(ymin, zmin, ymax, zmax), holes: [] }];
        var m = W.fromRegions(reg, {});
        m.source = "stress";
        return { ok: true, model: m, source: "stress",
          note: "its stress points enclose exactly its published area, so they are its corners" };
      }
    }
    var eq = equivalent(published, opts.equivalentFamily);
    if (!eq) return { ok: false, reason: "no equivalent section could be fitted to its published properties" };
    eq.model.source = "equivalent";
    return { ok: true, model: eq.model, source: "equivalent", note: eq.note, fit: eq };
  }

  /**
   * An I or a box, fitted to A, Iyy, Izz and the centroid height, inside the
   * published extents. The family whose torsion constant is nearer the
   * published one is preferred — a closed box and an open I with the same
   * bending properties differ in Ixx by orders of magnitude.
   */
  function equivalent(p, family) {
    var H = p.depth, B = p.width;
    if (!(H > 0 && B > 0 && p.A > 0)) return null;
    var fams = family ? [family] : ["H", "B", "C", "T"];
    var best = null;
    fams.forEach(function (fam) {
      var f = fitFamily(fam, p);
      if (f && (!best || f.score < best.score)) best = f;
    });
    if (!best) return null;
    best.note = "no geometry is published for a VALUE section, so an equivalent " + LABELS[best.code] +
      " (" + DIMS[best.code].slice(0, best.values.length).map(function (k, i) { return k + " " + fmt(best.values[i]); }).join(", ") +
      ") was fitted to its area, second moments and centroid. It is NOT the real shape.";
    return best;
  }

  function fitFamily(code, p) {
    var H = p.depth, B = p.width;
    var build, x0;
    if (code === "H") {
      /* x = [tw, tf1, tf2, B1/B, B2/B] in log space */
      x0 = [Math.log(p.A / (4 * H)), Math.log(p.A / (4 * B)), Math.log(p.A / (4 * B)), 0, 0];
      build = function (x) {
        var b1 = B * Math.min(1, Math.exp(x[3])), b2 = B * Math.min(1, Math.exp(x[4]));
        return [H, b1, Math.exp(x[0]), Math.exp(x[1]), b2, Math.exp(x[2])];
      };
    } else if (code === "B") {
      x0 = [Math.log(p.A / (4 * H)), Math.log(p.A / (4 * B)), Math.log(p.A / (4 * B)), Math.log(0.8)];
      build = function (x) {
        var tw = Math.exp(x[0]);
        return [H, B, tw, Math.exp(x[1]), Math.min(B - tw, B * Math.exp(x[3])), Math.exp(x[2])];
      };
    } else if (code === "C") {
      x0 = [Math.log(p.A / (3 * H)), Math.log(p.A / (3 * B)), Math.log(p.A / (3 * B)), 0, 0];
      build = function (x) {
        return [H, B * Math.min(1, Math.exp(x[3])), Math.exp(x[0]), Math.exp(x[1]),
                B * Math.min(1, Math.exp(x[4])), Math.exp(x[2])];
      };
    } else {  /* T */
      x0 = [Math.log(p.A / (2 * H)), Math.log(p.A / (2 * B))];
      build = function (x) { return [H, B, Math.exp(x[0]), Math.exp(x[1])]; };
    }
    function score(x) {
      var v = build(x), m = W.exact(code, v);
      if (!m) return 1e9;
      var q = W.wallProps(m.walls);
      if (!q) return 1e9;
      var bb = G.polyProps(m.regions);
      var cz = q.cz - (bb ? bb.bbox.min[1] : 0), cy = q.cy - (bb ? bb.bbox.min[0] : 0);
      var e = [
        4 * rel(q.A, p.A), 2 * rel(q.Iyy, p.Iyy), 2 * rel(q.Izz, p.Izz),
        p.Czm > 0 ? 2 * (cz - p.Czm) / H : 0,
        p.Cym > 0 ? 2 * (cy - p.Cym) / B : 0
      ];
      return e.reduce(function (a, b) { return a + b * b; }, 0);
    }
    var x = x0;
    for (var restart = 0; restart < 4; restart++) x = nelderMead(score, x, 500);
    var v = build(x), m = W.exact(code, v);
    if (!m) return null;
    var s = score(x);
    var q = W.wallProps(m.walls);
    /* torsion preference: thin-walled estimates */
    var ixx = code === "B" ? boxTorsion(v) : openTorsion(m.walls);
    var tors = p.Ixx > 0 ? Math.abs(Math.log(ixx / p.Ixx)) : 0;
    return { code: code, values: v, model: m, score: s + 0.05 * tors * tors, fitScore: s, props: q };
  }

  function boxTorsion(v) {
    var H = v[0], B = v[1], tw = v[2], tf1 = v[3], C = v[4], tf2 = v[5];
    var h = H - (tf1 + tf2) / 2, b = C > 0 ? C : B - tw;
    var perim = 2 * b / ((tf1 + tf2) / 2) + 2 * h / tw;
    return 4 * b * b * h * h / perim;
  }

  function openTorsion(walls) {
    var J = 0;
    walls.forEach(function (w) {
      for (var i = 0; i < w.t.length; i++) {
        var a = w.pts[i], b = w.pts[(i + 1) % w.pts.length];
        J += Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.pow(w.t[i], 3) / 3;
      }
    });
    return J;
  }

  function rel(a, b) { return b ? (a - b) / b : 0; }
  function fmt(v) { return Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3); }

  function nelderMead(f, x0, iters) {
    var n = x0.length, pts = [x0.slice()];
    for (var i = 0; i < n; i++) { var p = x0.slice(); p[i] += 0.3; pts.push(p); }
    var vals = pts.map(f);
    for (var it = 0; it < iters; it++) {
      var order = vals.map(function (v, k) { return k; }).sort(function (a, b) { return vals[a] - vals[b]; });
      pts = order.map(function (k) { return pts[k]; }); vals = order.map(function (k) { return vals[k]; });
      if (Math.abs(vals[n] - vals[0]) < 1e-14) break;
      var c = new Array(n).fill(0);
      for (var q = 0; q < n; q++) for (var j = 0; j < n; j++) c[j] += pts[q][j] / n;
      var step = function (t) { return c.map(function (cj, j2) { return cj + t * (pts[n][j2] - cj); }); };
      var xr = step(-1), fr = f(xr);
      if (fr < vals[0]) {
        var xe = step(-2), fe = f(xe);
        if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
      } else if (fr < vals[n - 1]) { pts[n] = xr; vals[n] = fr; }
      else {
        var xc = step(0.5), fc = f(xc);
        if (fc < vals[n]) { pts[n] = xc; vals[n] = fc; }
        else {
          for (var s2 = 1; s2 <= n; s2++) {
            pts[s2] = pts[s2].map(function (v, j3) { return pts[0][j3] + 0.5 * (v - pts[0][j3]); });
            vals[s2] = f(pts[s2]);
          }
        }
      }
    }
    var bi = vals.indexOf(Math.min.apply(null, vals));
    return pts[bi];
  }

  /* ------------------------------------------------------ catalogue sections */

  function catalogue(info, end, p, opts) {
    var name = [end && end.dbName, end && end.dbSection].filter(Boolean).join(" ");
    if (!p) return { ok: false, reason: "catalogue section " + name + " publishes no properties to recover its dimensions from" };
    var code = info.shape, H = p.depth, B = p.width, v = null;
    if (code === "H" && p.Asz > 0 && p.Asy > 0) {
      var tw = p.Asz / H, tf = p.Asy / (5 / 6) / (2 * B);
      var plain = 2 * B * tf + tw * (H - 2 * tf);
      var r = Math.sqrt(Math.max(0, (p.A - plain) / (4 * (1 - Math.PI / 4))));
      v = [H, B, tw, tf, B, tf, r, r];
    } else if (code === "T" && p.Asz > 0 && p.Asy > 0) {
      v = [H, B, p.Asz / H, p.Asy / (5 / 6) / B];
    } else if (code === "C" && p.Asz > 0 && p.Asy > 0) {
      var tfc = p.Asy / (5 / 6) / (2 * B);
      v = [H, B, p.Asz / H, tfc, B, tfc];
    } else if (code === "B" && p.Asz > 0 && p.Asy > 0) {
      var tfb = p.Asy / B / 2, twb = p.Asz / (2 * H);
      v = [H, B, twb, tfb, B - twb, tfb];
    } else if (code === "P") {
      var D = Math.max(H, B);
      var ri2 = D * D / 4 - p.A / Math.PI;
      v = ri2 > 0 ? [D, D / 2 - Math.sqrt(ri2)] : null;
    } else if (code === "SB") {
      v = [H, B];
    } else if (code === "SR") {
      v = [Math.max(H, B)];
    } else if (code === "L") {
      var fitL = fitFree("L", p, [H, B, Math.log(p.A / (2 * H)), Math.log(p.A / (2 * B))], function (x) {
        return [H, B, Math.exp(x[2]), Math.exp(x[3])];
      });
      v = fitL;
    }
    if (!v) return { ok: false, reason: "catalogue section " + name + ": the API gives no dimensions, and " +
      "this shape's cannot be recovered from its properties" };
    var res = fromCode(code, v, opts, null, "exact");
    if (!res.ok) return res;
    res.model.source = "catalogue";
    res.source = "catalogue";
    res.dims = v;
    res.note = "catalogue section " + name + ": dimensions recovered from its published properties (" +
      DIMS[code].slice(0, v.length).map(function (k, i) { return k + " " + fmt(v[i]); }).join(", ") + ")";
    return res;
  }

  function fitFree(code, p, x0, build) {
    var x = nelderMead(function (xx) {
      var m = W.exact(code, build(xx));
      if (!m) return 1e9;
      var q = W.wallProps(m.walls);
      return Math.pow(rel(q.A, p.A), 2) * 4 + Math.pow(rel(q.Iyy, p.Iyy), 2) + Math.pow(rel(q.Izz, p.Izz), 2);
    }, x0, 400);
    return build(x);
  }

  /* ---------------------------------------------------------- composite slab */

  /**
   * Add the deck slab of a COMPOSITE section as its own part (part 1), tied to
   * the girder's top by rigid connectors at every girder wall point on its top
   * surface. The haunch is not modelled as plate: the ties span it.
   */
  function addSlab(model, slab) {
    var gp = G.polyProps(model.regions);
    if (!gp) return model;
    var top = gp.bbox.max[1], yc = (gp.bbox.min[0] + gp.bbox.max[0]) / 2;
    var zs = top + (slab.haunch || 0) + slab.thickness / 2;
    var half = slab.width / 2;

    /* girder points to tie: every wall vertex within one top-wall thickness of
       the girder's highest centreline */
    var zTopWall = -Infinity;
    model.walls.forEach(function (w) { w.pts.forEach(function (p) { zTopWall = Math.max(zTopWall, p[1]); }); });
    var ties = [];
    model.walls.forEach(function (w) {
      w.pts.forEach(function (p, i) {
        var t = w.t[Math.min(i, w.t.length - 1)] || 0;
        if (p[1] >= zTopWall - Math.max(t, 1e-9) * 0.5 && Math.abs(p[0] - yc) <= half && (w.hard[i] || i === 0 || i === w.pts.length - 1)) {
          ties.push([p[0], p[1]]);
        }
      });
    });
    var ys = [yc - half, yc + half].concat(ties.map(function (p) { return p[0]; }));
    ys = ys.sort(function (a, b) { return a - b; }).filter(function (y, i, arr) { return i === 0 || y - arr[i - 1] > 1e-9; });
    var slabWall = W.wall("Deck slab", slab.thickness, ys.map(function (y) { return [y, zs]; }), { part: 1 });
    var out = {};
    Object.keys(model).forEach(function (k) { out[k] = model[k]; });
    out.walls = model.walls.concat([slabWall]);
    out.regions = model.regions.concat([{ outer: W.rect(yc - half, top + (slab.haunch || 0), yc + half, top + (slab.haunch || 0) + slab.thickness), holes: [] }]);
    out.connectors = (model.connectors || []).concat(ties.map(function (p) { return { a: p, b: [p[0], zs] }; }));
    out.slab = { z: zs, width: slab.width, thickness: slab.thickness, haunch: slab.haunch };
    return out;
  }

  /* ------------------------------------------------------------ placement */

  /**
   * The node line's position in the model's natural frame.
   * `extent` is the finished section's bbox; `centre` the centroid used for "C".
   */
  function nodeLinePoint(off, extent, centroid, end) {
    var h = off.pt.charAt(0), v = off.pt.charAt(1);
    var mid = [(extent.min[0] + extent.max[0]) / 2, (extent.min[1] + extent.max[1]) / 2];
    var c = off.center === 1 ? mid : centroid;
    var y, z;
    var yOff = end === "J" ? off.yj : off.yi, zOff = end === "J" ? off.zj : off.zi;
    if (h === "L") y = off.horz === 1 ? (off.ref === 1 ? extent.min[0] + yOff : c[0] - yOff) : extent.min[0];
    else if (h === "R") y = off.horz === 1 ? (off.ref === 1 ? extent.max[0] - yOff : c[0] + yOff) : extent.max[0];
    else y = c[0];
    if (v === "T") z = off.vert === 1 ? (off.ref === 1 ? extent.max[1] - zOff : c[1] + zOff) : extent.max[1];
    else if (v === "B") z = off.vert === 1 ? (off.ref === 1 ? extent.min[1] + zOff : c[1] - zOff) : extent.min[1];
    else z = c[1];
    return [y, z];
  }

  /* ---------------------------------------------------------------- study */

  /**
   * Study one section: both ends built, checked and placed.
   *
   * @param opts { overrides, facets, compactness, calibrate: "off"|"generic"|"all",
   *               tolerance }
   */
  function study(id, row, propEntry, opts) {
    opts = opts || {};
    var info = readRow(id, row);
    var props = parseProps(propEntry);
    var ov = (opts.overrides || {})[String(id)] || {};
    var out = {
      id: info.id, name: info.name, sectType: info.sectType, shape: info.shape, info: info,
      tapered: info.tapered, ok: false, blocked: false, reason: null, notes: [], ends: {}, checks: {},
      editable: null, materialSlots: []
    };

    var endsWanted = info.tapered ? ["I", "J"] : ["I"];
    var hint = null;
    for (var k = 0; k < endsWanted.length; k++) {
      var e = endsWanted[k];
      var rawEnd = info.ends[e] || info.ends.I;
      var phases = props ? props[e] || props.I : null;
      var pBefore = pub(phases && phases.before), pAfter = pub(phases && phases.after);
      var o = { override: e === "J" && ov.dimsJ ? { shape: ov.shape, dims: ov.dimsJ } : ov,
                facets: opts.facets, compactness: opts.compactness, equivalentFamily: ov.family };
      var b = buildEnd(info, rawEnd, pBefore, o, hint);
      if (!b.ok) { out.reason = (info.tapered ? e + " end: " : "") + b.reason; return out; }
      var model = b.model;
      if (b.note && out.notes.indexOf(b.note) === -1) out.notes.push(b.note);
      hint = model;

      /* checks on the GIRDER (the part the published "before" set describes);
         a general composite is checked part by part against each part's own
         published STIFF, because its "before" column is the first part only */
      var cal = opts.calibrate || "generic";
      var wantCal = cal === "all" || (cal === "generic" && b.source !== "exact" && b.source !== "override" && b.source !== "catalogue");
      var check;
      if (model.parts) {
        check = { source: b.source, status: "pass", summary: "", parts: [] };
        model.parts.forEach(function (pt) {
          var sub = { walls: model.walls.filter(function (w) { return w.part === pt.index; }),
                      regions: model.regions.filter(function (r) { return r.part === pt.index; }) };
          var pp = stiffPub(pt.stiff);
          var c = checkModel(sub, pp, b.source, opts);
          if (wantCal && c.target && !pt.plates.length) {
            var cb = W.calibrate(sub, c.target);
            if (cb.ok) {
              var map = new Map();
              sub.walls.forEach(function (w, k) { map.set(w, cb.model.walls[k]); });
              model.walls = model.walls.map(function (w) { return map.get(w) || w; });
              c.calibrated = cb;
              c.after = compare(W.wallProps(cb.model.walls), c.target);
            } else c.calibrationFailed = cb.reason;
          }
          check.parts.push(c);
          if (c.status === "fail" && check.status !== "fail") { check.status = "fail"; check.summary = "part " + (pt.index + 1) + ": " + c.summary; }
          else if (c.status === "warn" && check.status === "pass") { check.status = "warn"; check.summary = "part " + (pt.index + 1) + ": " + c.summary; }
        });
        check.reading = check.parts[0] && check.parts[0].reading;
        check.ideal = check.parts[0] && check.parts[0].ideal;
      } else {
        check = checkModel(model, pBefore, b.source, opts);
        if (check.target && wantCal) {
          var calib = W.calibrate(model, check.target);
          if (calib && calib.ok) {
            model = calib.model;
            check.calibrated = calib;
            check.after = compare(W.wallProps(model.walls), check.target);
          } else if (calib) {
            check.calibrationFailed = calib.reason;
          }
        }
      }
      out.checks[e] = check;

      /* composite deck slab */
      if (info.slab && (info.sectType === "COMPOSITE" || info.sectType === "TAPERED")) {
        model = addSlab(model, info.slab);
        if (!out.materialSlots.some(function (s) { return s.part === 1; })) {
          out.materialSlots.push({ part: 1, label: "Deck slab", ratio: info.modular,
            defaultToElement: !info.modular || Math.abs(info.modular - 1) < 1e-9 });
        }
      }
      if (model.parts) {
        model.parts.forEach(function (pt) {
          if (pt.index > 0 && !pt.useBase && !out.materialSlots.some(function (s) { return s.part === pt.index; })) {
            out.materialSlots.push({ part: pt.index, label: "Part " + (pt.index + 1), elast: pt.elast, defaultToElement: false });
          }
        });
      }

      /* place on the node line */
      var extent = G.polyProps(model.regions) || { bbox: W.wallProps(model.walls).bbox };
      var centroid = centroidFor(model, pAfter, extent.bbox);
      var nl = nodeLinePoint(info.offset, extent.bbox, centroid, e);
      var placed = W.shift(model, nl[0], nl[1]);
      placed.nodeLine = nl;
      out.ends[e] = placed;
    }

    if (info.tapered && out.ends.I && out.ends.J && !sameTopology(out.ends.I, out.ends.J)) {
      out.notes.push("the two ends of this tapered section idealise to different wall layouts; the mesh " +
        "uses the i-end layout stretched to the j-end outline");
      out.ends.J = stretch(out.ends.I, out.ends.J);
    }

    /* editable dimensions for vSIZE shapes */
    var code = ov.shape || info.shape;
    if (DIMS[code] && (info.ends.I && info.ends.I.vSize || ov.dims)) {
      out.editable = { code: code, keys: DIMS[code], values: (ov.dims || info.ends.I.vSize || []).slice(0, DIMS[code].length),
                       valuesJ: info.tapered ? (ov.dimsJ || (info.ends.J && info.ends.J.vSize) || []).slice(0, DIMS[code].length) : null };
    }

    /* the verdict */
    var worst = null;
    Object.keys(out.checks).forEach(function (e2) {
      var c = out.checks[e2];
      if (c.status === "fail" && !worst) worst = (info.tapered ? e2 + " end: " : "") + c.summary;
    });
    out.ok = true;
    out.blocked = !!worst && !ov.acceptGate;
    out.accepted = !!ov.acceptGate;
    if (worst) out.reason = worst;
    return out;
  }

  function centroidFor(model, pAfter, bbox) {
    /* The published centroid, measured from the published extreme fibres,
       is what CIVIL NX's "C" uses — for a composite section the transformed
       one. Without it, the outline's own centroid. */
    if (pAfter && pAfter.Cym != null && pAfter.Czm != null && pAfter.width > 0 && pAfter.depth > 0 &&
        Math.abs((bbox.max[0] - bbox.min[0]) - pAfter.width) <= 0.02 * pAfter.width &&
        Math.abs((bbox.max[1] - bbox.min[1]) - pAfter.depth) <= 0.02 * pAfter.depth) {
      return [bbox.min[0] + pAfter.Cym, bbox.min[1] + pAfter.Czm];
    }
    var pp = G.polyProps(model.regions);
    if (pp) return [pp.cy, pp.cz];
    var wp = W.wallProps(model.walls);
    return [wp.cy, wp.cz];
  }

  /**
   * The two checks, kept apart because they mean different things:
   *   reading  — does the outline we read reproduce what CIVIL NX published?
   *              A miss means the dimensions were read wrongly.
   *   ideal    — how far does the WALL model (what the mesh will be) sit from
   *              the section? Overlaps at junctions and thick walls cost a few
   *              percent; that is idealisation, not error, and is reported.
   */
  function checkModel(model, p, source, opts) {
    var tol = Object.assign({}, TOL, opts.tolerance || {});
    var outline = G.polyProps(model.regions);
    var walls = W.wallProps(model.walls);
    var res = { source: source, published: p, outline: outline, walls: walls, status: "pass", summary: "" };
    if (!walls) { res.status = "fail"; res.summary = "the wall model has no area"; return res; }

    if (p) {
      res.reading = compare(outline || walls, p);
      var readI = Math.max(Math.abs(res.reading.Iyy || 0), Math.abs(res.reading.Izz || 0));
      if (source !== "equivalent" && Math.abs(res.reading.A) > tol.reading) {
        res.status = "fail";
        res.summary = "the outline read from the model has area " + pct(res.reading.A) +
          " off what CIVIL NX publishes — its dimensions were not read correctly";
      } else if (source !== "equivalent" && readI > tol.readingI) {
        /* area right, second moments wrong: the SHAPE is misread (a dimension in
           the wrong place moves material without changing its amount) */
        res.status = "fail";
        res.summary = "the outline's area matches CIVIL NX but its second moments are " + pct(readI) +
          " off — the shape was not read correctly";
      }
      res.target = { A: p.A, Iyy: p.Iyy, Izz: p.Izz,
                     cy: outline && p.Cym != null ? outline.bbox.min[0] + p.Cym : (outline ? outline.cy : walls.cy),
                     cz: outline && p.Czm != null ? outline.bbox.min[1] + p.Czm : (outline ? outline.cz : walls.cz) };
    } else if (outline) {
      res.status = "none";
      res.summary = "CIVIL NX published no properties for this section, so the reading is unchecked";
      res.target = { A: outline.A, Iyy: outline.Iyy, Izz: outline.Izz, cy: outline.cy, cz: outline.cz };
    }
    if (res.target) {
      res.ideal = compare(walls, res.target);
      var worst = Math.max(Math.abs(res.ideal.A), Math.abs(res.ideal.Iyy), Math.abs(res.ideal.Izz));
      if (res.status === "pass" && worst > tol.idealFail) {
        res.status = "fail";
        res.summary = "the plate idealisation is " + pct(worst) + " off the section's stiffness";
      } else if (res.status === "pass" && worst > tol.ideal) {
        res.status = "warn";
        res.summary = "the plate idealisation differs by up to " + pct(worst);
      }
    }
    return res;
  }

  function compare(q, t) {
    return { A: rel(q.A, t.A), Iyy: rel(q.Iyy, t.Iyy), Izz: rel(q.Izz, t.Izz) };
  }
  function pct(v) { return (v * 100).toFixed(1) + "%"; }

  function sameTopology(a, b) {
    if (a.walls.length !== b.walls.length) return false;
    for (var i = 0; i < a.walls.length; i++) {
      if (a.walls[i].closed !== b.walls[i].closed || a.walls[i].part !== b.walls[i].part) return false;
    }
    return (a.connectors || []).length === (b.connectors || []).length;
  }

  /** i-end walls mapped affinely into the j-end outline's box, area-matched. */
  function stretch(I, J) {
    var bi = G.polyProps(I.regions), bj = G.polyProps(J.regions);
    if (!bi || !bj) return I;
    var sy = (bj.bbox.max[0] - bj.bbox.min[0]) / ((bi.bbox.max[0] - bi.bbox.min[0]) || 1);
    var sz = (bj.bbox.max[1] - bj.bbox.min[1]) / ((bi.bbox.max[1] - bi.bbox.min[1]) || 1);
    function m(p) { return [bj.bbox.min[0] + (p[0] - bi.bbox.min[0]) * sy, bj.bbox.min[1] + (p[1] - bi.bbox.min[1]) * sz]; }
    var out = W.shift(I, 0, 0);
    out.walls = I.walls.map(function (w) {
      var c = Object.assign({}, w); c.pts = w.pts.map(m); return c;
    });
    var wa = W.wallProps(out.walls), ratio = wa ? bj.A / wa.A : 1;
    out.walls.forEach(function (w) { w.t = w.t.map(function (t) { return t * ratio; }); });
    out.connectors = (I.connectors || []).map(function (c) { return { a: m(c.a), b: m(c.b) }; });
    out.regions = J.regions;
    out.nodeLine = J.nodeLine;
    return out;
  }

  var api = {
    DIMS: DIMS, LABELS: LABELS, TOL: TOL,
    parseProps: parseProps, pub: pub, readRow: readRow, buildEnd: buildEnd,
    nodeLinePoint: nodeLinePoint, study: study, equivalent: equivalent, autoConnect: autoConnect,
    addSlab: addSlab, checkModel: checkModel, nelderMead: nelderMead
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PSection = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
