/* ==========================================================================
   Beam to Plate — element local axes and mesh generation
   --------------------------------------------------------------------------
   Pure. No DOM, no network.

   LOCAL AXES — verified on CIVIL NX 2026 by analysis (2026-09-15): cantilevers
   in five orientations under tip loads, displacements matched beam theory to
   all printed digits under this convention and to nothing under the others.

       ex  node i → node j
       ey  = Z × ex (normalised), ez = ex × ey          for a non-vertical member
       vertical member (within 1e-4 of Z): ez = +X, ey = ez × ex
                     (so a column pointing up has ey = -Y, pointing down +Y)
       beta rotates ey towards ez about ex (right-handed, positive angle)

   THE INVARIANT every test leans on:

       Σ plate area × thickness  ==  ∫ wall-model area ds along the member

   It is checked per element at plan time.
   ========================================================================== */
(function (root) {
  "use strict";

  var VERTICAL = 1e-4;
  var CORNER = Math.cos(8 * Math.PI / 180);    /* a turn sharper than 8° keeps its vertex */

  /* ------------------------------------------------------------ local axes */

  function localAxes(pi, pj, betaDeg) {
    var dx = pj[0] - pi[0], dy = pj[1] - pi[1], dz = pj[2] - pi[2];
    var L = Math.hypot(dx, dy, dz);
    if (!(L > 0)) return null;
    var ex = [dx / L, dy / L, dz / L];
    var ey, ez;
    if (Math.hypot(ex[0], ex[1]) < VERTICAL) {
      ez = [1, 0, 0];
      ey = unit(cross(ez, ex));
    } else {
      ey = unit(cross([0, 0, 1], ex));
      ez = cross(ex, ey);
    }
    var b = (Number(betaDeg) || 0) * Math.PI / 180;
    if (b) {
      var c = Math.cos(b), s = Math.sin(b);
      var ey2 = [ey[0] * c + ez[0] * s, ey[1] * c + ez[1] * s, ey[2] * c + ez[2] * s];
      var ez2 = [-ey[0] * s + ez[0] * c, -ey[1] * s + ez[1] * c, -ey[2] * s + ez[2] * c];
      ey = ey2; ez = ez2;
    }
    return { ex: ex, ey: ey, ez: ez, L: L };
  }

  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function unit(v) {
    var L = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / L, v[1] / L, v[2] / L];
  }

  /* ------------------------------------------------------------- node pool */

  function NodePool(tol) {
    this.tol = tol > 0 ? tol : 1e-4;
    this.cells = Object.create(null);
    this.list = [];
  }
  NodePool.prototype.cellKey = function (i, j, k) { return i + "|" + j + "|" + k; };
  NodePool.prototype.find = function (p) {
    var t = this.tol;
    var ci = Math.round(p[0] / t), cj = Math.round(p[1] / t), ck = Math.round(p[2] / t);
    for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) for (var c = -1; c <= 1; c++) {
      var bucket = this.cells[this.cellKey(ci + a, cj + b, ck + c)];
      if (!bucket) continue;
      for (var i = 0; i < bucket.length; i++) {
        var q = this.list[bucket[i]];
        if (Math.abs(q[0] - p[0]) <= t && Math.abs(q[1] - p[1]) <= t && Math.abs(q[2] - p[2]) <= t) return bucket[i];
      }
    }
    return -1;
  };
  NodePool.prototype.add = function (p) {
    var hit = this.find(p);
    if (hit !== -1) return hit;
    var t = this.tol;
    var idx = this.list.length;
    this.list.push([p[0], p[1], p[2]]);
    var key = this.cellKey(Math.round(p[0] / t), Math.round(p[1] / t), Math.round(p[2] / t));
    (this.cells[key] || (this.cells[key] = [])).push(idx);
    return idx;
  };

  /* ---------------------------------------------------- wall resampling */

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /** Arc-length parameterisation of a wall: cumulative length and area at every vertex. */
  function profile(w) {
    var n = w.pts.length, segs = w.closed ? n : n - 1;
    var pts = w.closed ? w.pts.concat([w.pts[0]]) : w.pts;
    var s = [0], A = [0];
    for (var i = 0; i < segs; i++) {
      var L = dist(pts[i], pts[i + 1]);
      s.push(s[i] + L);
      A.push(A[i] + L * (w.t[i] || 0));
    }
    return { pts: pts, s: s, A: A, L: s[s.length - 1] };
  }

  /** Vertices that must survive resampling: hard ones and real corners. */
  function breakIndices(w, pr) {
    var n = pr.pts.length, out = [0];
    for (var i = 1; i < n - 1; i++) {
      var hard = w.hard && w.hard[i];
      var a = pr.pts[i - 1], b = pr.pts[i], c = pr.pts[i + 1];
      var u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
      var lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
      var corner = lu > 0 && lv > 0 && (u[0] * v[0] + u[1] * v[1]) / (lu * lv) < CORNER;
      if (hard || corner) out.push(i);
    }
    out.push(n - 1);
    return out;
  }

  function interpAt(pr, s) {
    var k = 1;
    while (k < pr.s.length - 1 && pr.s[k] < s) k++;
    var s0 = pr.s[k - 1], s1 = pr.s[k], f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    f = Math.max(0, Math.min(1, f));
    return {
      p: [pr.pts[k - 1][0] + (pr.pts[k][0] - pr.pts[k - 1][0]) * f, pr.pts[k - 1][1] + (pr.pts[k][1] - pr.pts[k - 1][1]) * f],
      A: pr.A[k - 1] + (pr.A[k] - pr.A[k - 1]) * f
    };
  }

  /**
   * The resampling PLAN for a wall, decided once (on the i end): the list of
   * piece boundaries as (run, fraction). Applying it to either end gives the
   * same number of points in the same order, so two ends interpolate.
   */
  function samplePlan(w, target, minPieces) {
    var pr = profile(w), br = breakIndices(w, pr), plan = [];
    for (var r = 0; r < br.length - 1; r++) {
      var L = pr.s[br[r + 1]] - pr.s[br[r]];
      var n = target > 0 ? Math.max(minPieces || 1, Math.ceil(L / target - 1e-9)) : (minPieces || 1);
      if (!(L > 0)) continue;
      for (var k = (plan.length ? 1 : 0); k <= n; k++) plan.push({ run: r, f: k / n });
    }
    return { plan: plan, runs: br.length - 1 };
  }

  /** Apply a sample plan to a wall: points, and a thickness per piece (ΔA/ΔL). */
  function applyPlan(w, sp) {
    var pr = profile(w), br = breakIndices(w, pr);
    var sameRuns = br.length - 1 === sp.runs;
    var pts = [], Acum = [];
    sp.plan.forEach(function (q) {
      var s;
      if (sameRuns) {
        var a = pr.s[br[q.run]], b = pr.s[br[q.run + 1]];
        s = a + (b - a) * q.f;
      } else {
        /* the other end breaks differently: fall back to fractions of the
           whole wall, taken from the plan's position on its own run list */
        s = pr.L * (q.run + q.f) / sp.runs;
      }
      var at = interpAt(pr, s);
      pts.push(at.p); Acum.push(at.A);
    });
    var t = [];
    for (var i = 0; i < pts.length - 1; i++) {
      var L = dist(pts[i], pts[i + 1]);
      t.push(L > 1e-15 ? (Acum[i + 1] - Acum[i]) / L : 0);
    }
    return { pts: pts, t: t, area: pr.A[pr.A.length - 1], lengthAlong: pr.L };
  }

  /* ----------------------------------------------------------------- mesh */

  /**
   * Mesh one beam element into plates.
   *
   * @param pool   NodePool shared across the run
   * @param elem   { id, i:[x,y,z], j:[x,y,z], angle, matl }
   * @param ends   { I: wallModel, J: wallModel|null } — already on the node line
   * @param opts   { longSize, transSize, minLong, minTrans }
   * @returns {{ok, reason?, plates, stations, connectors, endNodes, stats, axes}}
   */
  function meshElement(pool, elem, ends, opts) {
    opts = opts || {};
    var ax = localAxes(elem.i, elem.j, elem.angle);
    if (!ax) return { ok: false, reason: "the element's two nodes are at the same point", plates: [] };
    var I = ends.I, J = ends.J || ends.I;
    if (J.walls.length !== I.walls.length) {
      return { ok: false, reason: "the two ends of its tapered section have different wall layouts", plates: [] };
    }
    var nLong = Math.max(opts.minLong || 1, opts.longSize > 0 ? Math.ceil(ax.L / opts.longSize - 1e-9) : 1);

    /* resample each wall once, consistently at both ends */
    var walls = I.walls.map(function (wI, k) {
      var sp = samplePlan(wI, opts.transSize, opts.minTrans || 1);
      var a = applyPlan(wI, sp), b = J === I ? a : applyPlan(J.walls[k], sp);
      return { name: wI.name, part: wI.part || 0, closed: !!wI.closed, I: a, J: b };
    });

    function at(ptI, ptJ, xi) {
      return [ptI[0] + (ptJ[0] - ptI[0]) * xi, ptI[1] + (ptJ[1] - ptI[1]) * xi];
    }
    function global(s, yz) {
      return [elem.i[0] + ax.ex[0] * s + ax.ey[0] * yz[0] + ax.ez[0] * yz[1],
              elem.i[1] + ax.ex[1] * s + ax.ey[1] * yz[0] + ax.ez[1] * yz[1],
              elem.i[2] + ax.ex[2] * s + ax.ey[2] * yz[0] + ax.ez[2] * yz[1]];
    }

    var idx = [];                /* [station][wall][point] -> pool index */
    for (var st = 0; st <= nLong; st++) {
      var xi = st / nLong, s = ax.L * xi;
      idx.push(walls.map(function (w) {
        return w.I.pts.map(function (p, q) { return pool.add(global(s, at(p, w.J.pts[q], xi))); });
      }));
    }

    var plates = [], degenerate = 0;
    var weight = [];             /* [station] map poolIdx -> tributary volume */
    for (var st2 = 0; st2 <= nLong; st2++) weight.push(Object.create(null));
    for (var st3 = 0; st3 < nLong; st3++) {
      var xm = (st3 + 0.5) / nLong;
      walls.forEach(function (w, wi) {
        for (var p = 0; p < w.I.pts.length - 1; p++) {
          var n1 = idx[st3][wi][p], n2 = idx[st3][wi][p + 1], n3 = idx[st3 + 1][wi][p + 1], n4 = idx[st3 + 1][wi][p];
          if (n1 === n2 || n3 === n4 || n1 === n4 || n2 === n3) { degenerate++; continue; }
          var t = w.I.t[p] + (w.J.t[p] - w.I.t[p]) * xm;
          if (!(t > 0)) { degenerate++; continue; }
          /* A wall that changes position along a tapered member is INCLINED to
             it. The section gives its thickness in the cross-section plane; the
             plate's own (normal) thickness is that times the cosine of the tilt,
             or a haunched soffit carries 1/cos too much material. */
          t *= tiltCosine(pool, [n1, n2, n3, n4], ax.ex);
          var area = quadArea(pool, [n1, n2, n3, n4]);
          var vol = area * t;
          plates.push({ nodes: [n1, n2, n3, n4], t: t, part: w.part, matl: elem.matl, wall: w.name,
                        source: elem.id, station: st3, area: area });
          [[st3, n1], [st3, n2], [st3 + 1, n3], [st3 + 1, n4]].forEach(function (x) {
            weight[x[0]][x[1]] = (weight[x[0]][x[1]] || 0) + vol / 4;
          });
        }
      });
    }

    /* section-internal rigid ties (parts that only touch, deck slab to girder) */
    var connectors = [], missed = 0;
    var cI = I.connectors || [], cJ = J.connectors || cI;
    for (var st4 = 0; st4 <= nLong; st4++) {
      var x4 = st4 / nLong, s4 = ax.L * x4;
      cI.forEach(function (c, k) {
        var cj = cJ[k] || c;
        var a = pool.find(global(s4, at(c.a, cj.a, x4))), b = pool.find(global(s4, at(c.b, cj.b, x4)));
        if (a === -1 || b === -1 || a === b) { missed++; return; }
        connectors.push({ master: a, slave: b, station: st4, source: elem.id });
      });
    }

    var stations = weight.map(function (map, k) {
      return { s: ax.L * k / nLong, line: global(ax.L * k / nLong, [0, 0]),
               nodes: Object.keys(map).map(function (key) { return { idx: Number(key), w: map[key] }; }) };
    });

    var volume = plates.reduce(function (a, q) { return a + q.area * q.t; }, 0);
    var aI = walls.reduce(function (a, w) { return a + w.I.area; }, 0);
    var aJ = walls.reduce(function (a, w) { return a + w.J.area; }, 0);
    /* ∫A ds for a linear interpolation of the walls: area is quadratic in xi
       when both length and thickness vary, so integrate by Simpson on the
       resampled geometry rather than trusting a trapezoid */
    var expected = ax.L * simpsonArea(walls);

    return {
      ok: true, plates: plates, axes: ax, stations: stations, connectors: connectors,
      endNodes: { I: idsAt(idx[0]), J: idsAt(idx[nLong]) },
      stats: {
        length: ax.L, stations: nLong + 1, plates: plates.length, degenerate: degenerate,
        volume: volume, expected: expected, missedConnectors: missed,
        areaI: aI, areaJ: aJ,
        error: expected > 0 ? (volume - expected) / expected : 0
      }
    };
  }

  function idsAt(stationIdx) {
    var seen = Object.create(null), out = [];
    stationIdx.forEach(function (list) { list.forEach(function (i) { if (!seen[i]) { seen[i] = true; out.push(i); } }); });
    return out;
  }

  /** Mean over xi of Σ piece length × thickness, for linearly interpolated pieces. */
  function simpsonArea(walls) {
    function areaAt(xi) {
      var a = 0;
      walls.forEach(function (w) {
        for (var p = 0; p < w.I.pts.length - 1; p++) {
          var P0 = [w.I.pts[p][0] + (w.J.pts[p][0] - w.I.pts[p][0]) * xi, w.I.pts[p][1] + (w.J.pts[p][1] - w.I.pts[p][1]) * xi];
          var P1 = [w.I.pts[p + 1][0] + (w.J.pts[p + 1][0] - w.I.pts[p + 1][0]) * xi, w.I.pts[p + 1][1] + (w.J.pts[p + 1][1] - w.I.pts[p + 1][1]) * xi];
          var t = w.I.t[p] + (w.J.t[p] - w.I.t[p]) * xi;
          a += dist(P0, P1) * t;
        }
      });
      return a;
    }
    return (areaAt(0) + 4 * areaAt(0.5) + areaAt(1)) / 6;
  }

  /** |cos| between a quad's normal and the normal the wall has in the section plane. */
  function tiltCosine(pool, q, ex) {
    var P = q.map(function (i) { return pool.list[i]; });
    var n = unit(cross(sub(P[2], P[0]), sub(P[3], P[1])));
    var g = add(sub(P[1], P[0]), sub(P[2], P[3]));          /* in-section tangent */
    var gx = g[0] * ex[0] + g[1] * ex[1] + g[2] * ex[2];
    g = [g[0] - gx * ex[0], g[1] - gx * ex[1], g[2] - gx * ex[2]];
    if (!(Math.hypot(g[0], g[1], g[2]) > 0)) return 1;
    var m = unit(cross(ex, g));
    var c = Math.abs(n[0] * m[0] + n[1] * m[1] + n[2] * m[2]);
    return c > 0 ? Math.min(1, c) : 1;
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

  /** Area of a planar-ish quad, as two triangles. */
  function quadArea(pool, id4) {
    var a = pool.list[id4[0]], b = pool.list[id4[1]], c = pool.list[id4[2]], d = pool.list[id4[3]];
    return triArea(a, b, c) + triArea(a, c, d);
  }
  function triArea(a, b, c) {
    var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    var v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    var n = cross(u, v);
    return Math.hypot(n[0], n[1], n[2]) / 2;
  }

  /** Plates an element would produce, without building it (for the size guard). */
  function estimate(elemLength, ends, opts) {
    var nLong = Math.max(opts.minLong || 1, opts.longSize > 0 ? Math.ceil(elemLength / opts.longSize - 1e-9) : 1);
    var pieces = 0, pts = 0;
    ends.I.walls.forEach(function (w) {
      var sp = samplePlan(w, opts.transSize, opts.minTrans || 1);
      pieces += sp.plan.length - 1;
      pts += sp.plan.length;
    });
    return { plates: nLong * pieces, nodes: (nLong + 1) * pts };
  }

  var api = {
    localAxes: localAxes, NodePool: NodePool, meshElement: meshElement, estimate: estimate,
    samplePlan: samplePlan, applyPlan: applyPlan, quadArea: quadArea, cross: cross, unit: unit
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PMesh = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
