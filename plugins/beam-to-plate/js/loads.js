/* ==========================================================================
   Beam to Plate — moving beam loads onto the plate mesh
   --------------------------------------------------------------------------
   Pure. A /db/BMLD item on a converted beam becomes nodal forces (/db/CNLD) on
   the plate nodes, with the RESULTANT PRESERVED EXACTLY: the same total force,
   and the same moment about any point, as the beam load.

   What a BMLD item means — measured on CIVIL NX 2026 by analysis (2026-09-15),
   cantilevers loaded one way at a time and base reactions read back:

     D       distances as RATIOS of the element length (CONLOAD at D=0.3 on a
             5 m cantilever of 10 kN gave a 15 kNm base moment)
     P       values at those ratios; UNILOAD/UNIMOMENT are piecewise linear
             between the D points in use
     no eccentricity  the load acts on the element axis — the CENTROID, not
             the node line: a lateral load on a top-offset beam produced
             exactly the torsion w.L.e of the centroid offset (2.0 kNm on a
             0.4 deep section) and none on the same beam centred
     USE_ECCEN, ECCEN_TYPE 0  offset from the CENTROID; 1 from the node line;
             ECCEN_DIR LY/LZ/GX/GY/GZ positive along that axis
     PRESSURE  a line load of P x the section's extent ACROSS the load: LY
             uses the depth, LZ the width (factor 0.4 and 0.1 on a 0.4 x 0.1)
     CONMOMENT / UNIMOMENT  a moment about the named axis

   Not verified, and implemented from the dialog's meaning: USE_PROJECTION (a
   global load per unit projected length), USE_ADDITIONAL on PRESSURE (refused,
   see below), CMD LINE/TYPICAL (treated as BEAM).

   How it gets onto the mesh:
     1. along the member, each load is lumped to the mesh STATIONS with linear
        (hat) shape functions — exact resultant, exact first moment;
     2. at a station, force F and moment M (about the node line) are shared
        between that station's section nodes by a weighted rigid-body
        distribution (RBE3):
            F_i = w_i F / W  +  w_i (K⁻¹ Mc) × r_i,   K = Σ w (|r|² I − r rᵀ)
        which gives Σ F_i = F and Σ r_i × F_i = Mc exactly. Weights are the
        plates' tributary volumes, so a load spreads like the material does.
        No nodal moments are written: a plate's drilling rotation is not a
        real stiffness.
   ========================================================================== */
(function (root) {
  "use strict";

  var GAUSS = [[-0.7745966692414834, 5 / 9], [0, 8 / 9], [0.7745966692414834, 5 / 9]];

  function dir(code, ax) {
    switch (String(code || "").toUpperCase()) {
      case "GX": return [1, 0, 0];
      case "GY": return [0, 1, 0];
      case "GZ": return [0, 0, 1];
      case "LX": return ax.ex;
      case "LY": return ax.ey;
      case "LZ": return ax.ez;
    }
    return null;
  }

  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }

  /**
   * One BMLD item → a list of line segments / points in element terms:
   *   { kind: "force"|"moment", x0, x1 (ratios), v0, v1 (vectors per length or
   *     total), ecc0, ecc1 ([y, z] in the section frame, relative to the node
   *     line) }
   * @param ctx { axes, length, centroid:[y,z] (placed frame), depth, width }
   * @returns {{ok, parts?, reason?}}
   */
  function interpret(item, ctx) {
    var type = String(item.TYPE || "").toUpperCase();
    var d = dir(item.DIRECTION, ctx.axes);
    if (!d) return { ok: false, reason: "load direction " + item.DIRECTION + " is not understood" };
    if (type === "PRESSURE" && item.USE_ADDITIONAL) {
      return { ok: false, reason: "a pressure load with an additional height from the top is not converted" };
    }
    var D = (item.D || []).map(Number), P = (item.P || []).map(Number);
    var isPoint = type === "CONLOAD" || type === "CONMOMENT";
    var kind = type === "CONMOMENT" || type === "UNIMOMENT" ? "moment" : "force";

    /* a global load with projection is given per unit length projected onto
       the plane normal to the load — scale back to per unit member length */
    var proj = 1;
    if (item.USE_PROJECTION && /^G/.test(String(item.DIRECTION)) && !isPoint) {
      var c = Math.abs(dot(d, ctx.axes.ex));
      proj = Math.sqrt(Math.max(0, 1 - c * c));
    }
    var factor = proj;
    if (type === "PRESSURE") {
      var ly = Math.abs(dot(d, ctx.axes.ey)), lz = Math.abs(dot(d, ctx.axes.ez));
      factor *= ly * ctx.depth + lz * ctx.width;
    }

    /* eccentricity: from the centroid (type 0) or the node line (type 1) */
    function eccAt(ratio) {
      /* No eccentricity: the load sits on the element axis, the centroid. */
      if (!item.USE_ECCEN) return ctx.centroid;
      var base = Number(item.ECCEN_TYPE) === 1 ? [0, 0] : ctx.centroid;
      var e0 = Number(item.I_END) || 0;
      var e1 = item.USE_J_END ? (Number(item.J_END) || 0) : e0;
      var e = e0 + (e1 - e0) * ratio;
      var ed = dir(item.ECCEN_DIR, ctx.axes) || ctx.axes.ey;
      /* only the part of the eccentricity in the section plane moves the load */
      return [base[0] + e * dot(ed, ctx.axes.ey), base[1] + e * dot(ed, ctx.axes.ez)];
    }

    var parts = [];
    if (isPoint) {
      parts.push({ kind: kind, point: true, x0: clamp(D[0]), v0: scale(d, (P[0] || 0) * factor), ecc0: eccAt(clamp(D[0])) });
    } else {
      /* piecewise linear through the D points that are in use: a point is in use
         while the distances keep increasing (the tail of a [x1, x2, 0, 0] is 0) */
      var pts = [[clamp(D[0]), P[0] || 0]];
      for (var i = 1; i < 4; i++) {
        if (!(D[i] > pts[pts.length - 1][0])) break;
        pts.push([clamp(D[i]), P[i] || 0]);
      }
      if (pts.length < 2) return { ok: false, reason: "a distributed load with no length" };
      for (var k = 0; k < pts.length - 1; k++) {
        parts.push({ kind: kind, point: false, x0: pts[k][0], x1: pts[k + 1][0],
                     v0: scale(d, pts[k][1] * factor), v1: scale(d, pts[k + 1][1] * factor),
                     ecc0: eccAt(pts[k][0]), ecc1: eccAt(pts[k + 1][0]) });
      }
    }
    return { ok: true, parts: parts };
  }

  function clamp(x) { x = Number(x) || 0; return Math.max(0, Math.min(1, x)); }

  /**
   * Lump interpreted parts to stations. Returns per station { F, M } with M about
   * the station's node-line point. Stations are at ratios k/n.
   */
  function lump(parts, ctx, nStations) {
    var n = nStations - 1;
    var out = [];
    for (var s = 0; s < nStations; s++) out.push({ F: [0, 0, 0], M: [0, 0, 0] });
    var ey = ctx.axes.ey, ez = ctx.axes.ez, L = ctx.length;

    function deposit(ratio, vec, ecc, kind, weight) {
      /* split between the two stations either side, by the hat functions */
      var pos = ratio * n, k = Math.min(n - 1, Math.max(0, Math.floor(pos)));
      var f = pos - k;
      if (n === 0) { k = 0; f = 0; }
      var targets = n === 0 ? [[0, 1]] : [[k, 1 - f], [k + 1, f]];
      targets.forEach(function (tg) {
        var w = tg[1] * weight;
        if (!w) return;
        var st = out[tg[0]];
        if (kind === "force") {
          var v = scale(vec, w);
          st.F = add(st.F, v);
          /* the force acts at the node line + eccentricity, but is moved to the
             station: a moment for the offset in the section, and one for the
             distance along the member to the station */
          var arm = add(scale(ey, ecc[0]), scale(ez, ecc[1]));
          arm = add(arm, scale(ctx.axes.ex, (ratio - tg[0] / (n || 1)) * L));
          st.M = add(st.M, cross(arm, v));
        } else {
          st.M = add(st.M, scale(vec, w));
        }
      });
    }

    parts.forEach(function (p) {
      if (p.point) { deposit(p.x0, p.v0, p.ecc0, p.kind, 1); return; }
      /* integrate over [x0, x1], split at the stations so each piece is smooth */
      var cuts = [p.x0];
      for (var s2 = 1; s2 < n; s2++) { var r = s2 / n; if (r > p.x0 && r < p.x1) cuts.push(r); }
      cuts.push(p.x1);
      for (var c = 0; c < cuts.length - 1; c++) {
        var a = cuts[c], b = cuts[c + 1], half = (b - a) / 2, mid = (a + b) / 2;
        GAUSS.forEach(function (g) {
          var x = mid + half * g[0];
          var f = (x - p.x0) / (p.x1 - p.x0);
          var v = add(scale(p.v0, 1 - f), scale(p.v1, f));
          var e = [p.ecc0[0] + (p.ecc1[0] - p.ecc0[0]) * f, p.ecc0[1] + (p.ecc1[1] - p.ecc0[1]) * f];
          deposit(x, v, e, p.kind, g[1] * half * L);
        });
      }
    });
    return out;
  }

  /**
   * RBE3-style distribution of (F, M about `line`) to weighted nodes.
   * nodes: [{ idx, w, p:[x,y,z] }]. Returns { forces: [{idx, F}], residual }.
   */
  function distribute(F, M, line, nodes) {
    var W = 0, c = [0, 0, 0];
    nodes.forEach(function (n) { W += n.w; c = add(c, scale(n.p, n.w)); });
    if (!(W > 0)) return { forces: [], residual: Math.hypot(F[0], F[1], F[2]) };
    c = scale(c, 1 / W);
    var Mc = add(M, cross(sub(line, c), F));
    var K = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    nodes.forEach(function (n) {
      var r = sub(n.p, c), r2 = dot(r, r);
      for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) K[i][j] += n.w * ((i === j ? r2 : 0) - r[i] * r[j]);
    });
    var omega = pinvSym(K, Mc);
    var forces = nodes.map(function (n) {
      var r = sub(n.p, c);
      return { idx: n.idx, F: add(scale(F, n.w / W), scale(cross(omega, r), n.w)) };
    });
    /* what was actually achieved — collinear nodes cannot carry a moment about
       their own line, and that part is reported rather than invented */
    var sumM = [0, 0, 0];
    forces.forEach(function (f, k) { sumM = add(sumM, cross(sub(nodes[k].p, c), f.F)); });
    var miss = sub(Mc, sumM);
    return { forces: forces, residualMoment: Math.hypot(miss[0], miss[1], miss[2]),
             moment: Math.hypot(Mc[0], Mc[1], Mc[2]) };
  }

  /** Solve K x = b for symmetric 3x3 K, dropping directions with no stiffness. */
  function pinvSym(K, b) {
    var e = jacobi(K), x = [0, 0, 0];
    var maxL = Math.max(Math.abs(e.values[0]), Math.abs(e.values[1]), Math.abs(e.values[2]));
    for (var k = 0; k < 3; k++) {
      var lam = e.values[k];
      if (Math.abs(lam) <= 1e-10 * maxL || lam === 0) continue;
      var v = [e.vectors[0][k], e.vectors[1][k], e.vectors[2][k]];
      x = add(x, scale(v, dot(v, b) / lam));
    }
    return x;
  }

  function jacobi(A) {
    var a = A.map(function (r) { return r.slice(); });
    var v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 50; sweep++) {
      var off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-30) break;
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        var th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        var t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        var c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (var k = 0; k < 3; k++) {
          var akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (var k2 = 0; k2 < 3; k2++) {
          var apk = a[p][k2], aqk = a[q][k2];
          a[p][k2] = c * apk - s * aqk; a[q][k2] = s * apk + c * aqk;
        }
        for (var k3 = 0; k3 < 3; k3++) {
          var vkp = v[k3][p], vkq = v[k3][q];
          v[k3][p] = c * vkp - s * vkq; v[k3][q] = s * vkp + c * vkq;
        }
      }
    }
    return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
  }

  /**
   * Convert every BMLD item on one converted element.
   * @param items  the element's BMLD ITEMS
   * @param mesh   meshElement() result (axes, stations with node weights)
   * @param pool   node pool (coordinates)
   * @param ctx    { centroid, depth, width }
   * @returns {{ loads: [{idx, lcname, group, F}], skipped: [{item, reason}], residual }}
   */
  function convertElement(items, mesh, pool, ctx) {
    var out = [], skipped = [], residual = 0, scale = 0;
    var c = { axes: mesh.axes, length: mesh.axes.L, centroid: ctx.centroid || [0, 0],
              depth: ctx.depth || 0, width: ctx.width || 0,
              /* the lever arm a moment is judged against: half the section's
                 own size, which is what the plate nodes have to work with */
              scale: Math.max(ctx.depth || 0, ctx.width || 0) / 2 || 1 };
    (items || []).forEach(function (item) {
      var it = interpret(item, c);
      if (!it.ok) { skipped.push({ item: item, reason: it.reason }); return; }
      var per = lump(it.parts, c, mesh.stations.length);
      per.forEach(function (st, k) {
        if (!(Math.hypot(st.F[0], st.F[1], st.F[2]) > 0 || Math.hypot(st.M[0], st.M[1], st.M[2]) > 0)) return;
        var station = mesh.stations[k];
        var nodes = station.nodes.map(function (n) { return { idx: n.idx, w: n.w, p: pool.list[n.idx] }; });
        var dres = distribute(st.F, st.M, station.line, nodes);
        /* Measure what is left over against the SIZE OF THE LOAD, not against
           the moment at this particular station: the end stations carry almost
           no moment, so a ratio against their own moment reads as a huge miss
           when the amount missed is nothing at all. */
        residual += dres.residualMoment;
        scale += Math.hypot(st.F[0], st.F[1], st.F[2]) * c.scale +
                 Math.hypot(st.M[0], st.M[1], st.M[2]);
        dres.forces.forEach(function (f) {
          out.push({ idx: f.idx, lcname: String(item.LCNAME || ""), group: String(item.GROUP_NAME || ""), F: f.F });
        });
      });
    });
    return { loads: out, skipped: skipped,
             residual: scale > 0 ? residual / scale : 0, residualMoment: residual };
  }

  /** Sum loads by (node, load case, load group). */
  function combine(list) {
    var map = Object.create(null), out = [];
    list.forEach(function (l) {
      var k = l.idx + "|" + l.lcname + "|" + l.group;
      if (!map[k]) { map[k] = { idx: l.idx, lcname: l.lcname, group: l.group, F: [0, 0, 0] }; out.push(map[k]); }
      map[k].F = add(map[k].F, l.F);
    });
    return out;
  }

  var api = { interpret: interpret, lump: lump, distribute: distribute, convertElement: convertElement,
              combine: combine, dir: dir };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PLoads = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
