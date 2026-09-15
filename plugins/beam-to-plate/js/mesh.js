/* ==========================================================================
   Beam to Plate — element local axes and mesh generation
   --------------------------------------------------------------------------
   Pure. No DOM, no network, so `node test/run.js` exercises the geometry
   directly.

   The one invariant worth stating before the code, because every test in the
   suite leans on it:

       sum over generated plates of (plate area x thickness)
         == section area x member length

   A mesh that gets a local axis, a subdivision or a node merge wrong breaks it.
   It is checked per element at plan time and shown in the UI, so a conversion
   that is geometrically wrong is visible BEFORE anything is written.
   ========================================================================== */
(function (root) {
  "use strict";

  var VERTICAL = 1e-4;   /* sin of the angle at which a member counts as vertical */

  /* ------------------------------------------------------------ local axes */

  /**
   * The element coordinate system, and the section's place in it.
   *
   *   ex   from node i to node j
   *   ez   "up" — in the vertical plane containing ex
   *   ey   ez x ex, completing a right-handed set
   *
   * then both are rotated about ex by the element's ANGLE (beta angle), taken
   * as a right-handed rotation carrying ey towards ez.
   *
   * UNVERIFIED against a live model: the sign of the beta rotation, and the
   * fallback for a member parallel to global Z. The fallback here puts the local
   * z axis along global X, which is the documented CIVIL NX convention for a
   * vertical member and is what a column's section orientation implies — but it
   * was not measured. Both are stated in the readme, and both are visible: a
   * wrong beta spins the mesh about the member, which a glance at the model
   * shows immediately. Neither affects the area gate or the volume check, so
   * check the picture, not the numbers, for this one.
   */
  function localAxes(pi, pj, betaDeg) {
    var dx = pj[0] - pi[0], dy = pj[1] - pi[1], dz = pj[2] - pi[2];
    var L = Math.hypot(dx, dy, dz);
    if (!(L > 0)) return null;
    var ex = [dx / L, dy / L, dz / L];

    /* A member within VERTICAL of the global Z axis has no vertical plane to
       take "up" from; global X is the reference instead. */
    var horiz = Math.hypot(ex[0], ex[1]);
    var ref = horiz < VERTICAL ? [1, 0, 0] : [0, 0, 1];

    var ey = unit(cross(ref, ex));
    var ez = unit(cross(ex, ey));

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

  /**
   * Coordinate-keyed node pool, so walls that meet share their junction line and
   * two beams meeting end to end share their end section.
   *
   * The 27-cell probe matters: a plain rounded key splits two points that sit a
   * nanometre apart across a cell boundary, and the mesh then has a hairline
   * crack down the web that nothing reports — the plates are all there, the
   * model just is not connected.
   */
  function NodePool(tol) {
    this.tol = tol > 0 ? tol : 1e-4;
    this.cells = Object.create(null);
    this.list = [];
  }

  NodePool.prototype.cellKey = function (i, j, k) { return i + "|" + j + "|" + k; };

  /** The index of an existing point within tolerance, or -1. Never inserts —
   *  a lookup that inserts and then tries to undo itself leaves a stale bucket
   *  entry pointing past the end of the list. */
  NodePool.prototype.find = function (p) {
    var t = this.tol;
    var ci = Math.round(p[0] / t), cj = Math.round(p[1] / t), ck = Math.round(p[2] / t);
    for (var a = -1; a <= 1; a++) {
      for (var b = -1; b <= 1; b++) {
        for (var c = -1; c <= 1; c++) {
          var bucket = this.cells[this.cellKey(ci + a, cj + b, ck + c)];
          if (!bucket) continue;
          for (var i = 0; i < bucket.length; i++) {
            var q = this.list[bucket[i]];
            if (Math.abs(q[0] - p[0]) <= t && Math.abs(q[1] - p[1]) <= t &&
                Math.abs(q[2] - p[2]) <= t) return bucket[i];
          }
        }
      }
    }
    return -1;
  };

  NodePool.prototype.add = function (p) {
    var t = this.tol;
    var hit = this.find(p);
    if (hit !== -1) return hit;
    var ci = Math.round(p[0] / t), cj = Math.round(p[1] / t), ck = Math.round(p[2] / t);
    var idx = this.list.length;
    this.list.push([p[0], p[1], p[2]]);
    var key = this.cellKey(ci, cj, ck);
    (this.cells[key] || (this.cells[key] = [])).push(idx);
    return idx;
  };

  /* ------------------------------------------------------------ subdivision */

  /** Subdivide a wall centreline so no piece is longer than `target`. */
  function subdivide(pts, target, minPieces) {
    var out = [pts[0]];
    var min = Math.max(1, minPieces || 1);
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var n = target > 0 ? Math.max(min, Math.ceil(L / target - 1e-9)) : min;
      for (var k = 1; k <= n; k++) {
        out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
      }
    }
    return out;
  }

  /* ----------------------------------------------------------------- mesh */

  /**
   * Mesh one beam element into plates.
   *
   * @param {NodePool} pool   shared across the whole run, so elements connect
   * @param {Object} elem     { id, i:[x,y,z], j:[x,y,z], angle, matl }
   * @param {Object} model    a wall model from section.js, already origin()ed
   * @param {Object} opts     { longSize, transSize, minLong, minTrans }
   * @returns {{ok:boolean, reason?:string, plates:Array, stats:Object}}
   */
  function meshElement(pool, elem, model, opts) {
    opts = opts || {};
    var ax = localAxes(elem.i, elem.j, elem.angle);
    if (!ax) return { ok: false, reason: "the element's two nodes are at the same point", plates: [] };

    var nLong = Math.max(opts.minLong || 1,
      opts.longSize > 0 ? Math.round(ax.L / opts.longSize) || 1 : 1);

    /* Subdivided section point lists, one per wall, computed once and reused at
       every station — so a junction point is the SAME (y,z) at every station and
       the pool merges the two walls rather than leaving them a hair apart. */
    var walls = model.walls.map(function (w) {
      return { name: w.name, t: w.t,
               pts: subdivide(w.pts, opts.transSize, opts.minTrans || 1) };
    });

    var stationIdx = [];      /* [station][wall][point] -> pool index */
    for (var k = 0; k <= nLong; k++) {
      var s = ax.L * k / nLong;
      var byWall = walls.map(function (w) {
        return w.pts.map(function (p) {
          return pool.add([
            elem.i[0] + ax.ex[0] * s + ax.ey[0] * p[0] + ax.ez[0] * p[1],
            elem.i[1] + ax.ex[1] * s + ax.ey[1] * p[0] + ax.ez[1] * p[1],
            elem.i[2] + ax.ex[2] * s + ax.ey[2] * p[0] + ax.ez[2] * p[1]
          ]);
        });
      });
      stationIdx.push(byWall);
    }

    var plates = [];
    var degenerate = 0;
    for (var st = 0; st < nLong; st++) {
      for (var w = 0; w < walls.length; w++) {
        var pts = walls[w].pts;
        for (var p = 0; p < pts.length - 1; p++) {
          var n1 = stationIdx[st][w][p];
          var n2 = stationIdx[st][w][p + 1];
          var n3 = stationIdx[st + 1][w][p + 1];
          var n4 = stationIdx[st + 1][w][p];
          /* A zero-length piece of centreline (a dimension that collapsed, or a
             closed wall's repeated first point) would make a quad with a
             repeated corner. CIVIL NX would take it; it is not a plate. */
          if (n1 === n2 || n3 === n4 || n1 === n4 || n2 === n3) { degenerate++; continue; }
          plates.push({
            nodes: [n1, n2, n3, n4],
            t: walls[w].t,
            matl: elem.matl,
            wall: walls[w].name,
            source: elem.id
          });
        }
      }
    }

    var area = plates.reduce(function (a, q) { return a + quadArea(pool, q.nodes); }, 0);
    var volume = plates.reduce(function (a, q) { return a + quadArea(pool, q.nodes) * q.t; }, 0);

    return {
      ok: true,
      plates: plates,
      axes: ax,
      stats: {
        length: ax.L,
        stations: nLong + 1,
        plates: plates.length,
        degenerate: degenerate,
        plateArea: area,
        volume: volume,
        /* The invariant. `expected` is the SECTION's area times the member
           length; `volume` is summed from the plates that were actually built.
           They agree to rounding when the mesh is right. */
        expected: model.area * ax.L,
        error: model.area * ax.L > 0
          ? (volume - model.area * ax.L) / (model.area * ax.L) : 0
      }
    };
  }

  /** Area of a planar-ish quad, as two triangles. */
  function quadArea(pool, idx) {
    var a = pool.list[idx[0]], b = pool.list[idx[1]], c = pool.list[idx[2]], d = pool.list[idx[3]];
    return triArea(a, b, c) + triArea(a, c, d);
  }
  function triArea(a, b, c) {
    var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    var v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    var n = cross(u, v);
    return Math.hypot(n[0], n[1], n[2]) / 2;
  }

  var api = {
    localAxes: localAxes,
    NodePool: NodePool,
    subdivide: subdivide,
    meshElement: meshElement,
    quadArea: quadArea,
    cross: cross,
    unit: unit
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PMesh = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
