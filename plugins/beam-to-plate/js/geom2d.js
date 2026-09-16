/* ==========================================================================
   Beam to Plate — plane geometry
   --------------------------------------------------------------------------
   Pure. Everything is in a section's own (y, z) frame.

   Two jobs:

   1. EXACT PROPERTIES of polygons with holes — area, centroid, second moments.
      These are what every idealisation is checked against.

   2. TURNING AN ARBITRARY OUTLINE INTO WALLS. A plate mesh needs centrelines
      with a thickness, and most sections (PSC girders, value sections, general
      composites, stress-point outlines) arrive only as an outline. Two methods:

      - The CHORDAL AXIS of a constrained triangulation (Prasad, 1997). Each
        triangle is classified by how many of its edges lie on the boundary; the
        midpoints of the interior edges, joined through the triangles, trace the
        centreline of every wall, and the triangles' own areas give the wall its
        thickness. Area is conserved EXACTLY, by construction — every triangle's
        area lands on exactly one piece of centreline.

      - STRIPS, for compact solids with no voids (a round pier, an octagon, a
        solid rectangle): one straight mid-plane plate whose thickness at each
        level is the width of the solid at that level. For a section symmetric
        about the plate plane that reproduces A, Iyy AND Izz exactly in the
        limit, which a chordal axis of a disc — a star of spokes — does not.

      The triangulation keeps vertex ids, and the skeleton keeps triangle and
      edge ids, so the SAME topology can be re-evaluated on a second outline
      with the same vertex count. That is how a tapered PSC girder gets one
      consistent mesh from its i end to its j end.
   ========================================================================== */
(function (root) {
  "use strict";

  var EPS = 1e-12;

  /* ------------------------------------------------------------ polygons */

  function signedArea(ring) {
    var a = 0;
    for (var i = 0, n = ring.length; i < n; i++) {
      var p = ring[i], q = ring[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  /** Integrals over one closed ring (signed by orientation). */
  function ringIntegrals(ring) {
    var A = 0, Sy = 0, Sz = 0, Iyy = 0, Izz = 0, Iyz = 0;
    for (var i = 0, n = ring.length; i < n; i++) {
      var y0 = ring[i][0], z0 = ring[i][1];
      var y1 = ring[(i + 1) % n][0], z1 = ring[(i + 1) % n][1];
      var c = y0 * z1 - y1 * z0;
      A += c;
      Sy += (z0 + z1) * c;           /* ∫z dA * 6 */
      Sz += (y0 + y1) * c;           /* ∫y dA * 6 */
      Iyy += (z0 * z0 + z0 * z1 + z1 * z1) * c;          /* ∫z² * 12 */
      Izz += (y0 * y0 + y0 * y1 + y1 * y1) * c;          /* ∫y² * 12 */
      Iyz += (y0 * z1 + 2 * y0 * z0 + 2 * y1 * z1 + y1 * z0) * c; /* ∫yz * 24 */
    }
    return { A: A / 2, Qz: Sz / 6, Qy: Sy / 6, Iyy: Iyy / 12, Izz: Izz / 12, Iyz: Iyz / 24 };
  }

  /**
   * Properties of a set of regions. `regions` is [{outer, holes}], each ring a
   * list of [y, z]; orientation does not matter. Second moments are about the
   * CENTROID. Iyy = ∫z² (bending about the y axis), Izz = ∫y².
   */
  function polyProps(regions) {
    var A = 0, Qy = 0, Qz = 0, Iyy = 0, Izz = 0, Iyz = 0;
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    function add(ring, sign) {
      if (!ring || ring.length < 3) return;
      var r = ringIntegrals(ring);
      var s = (r.A >= 0 ? 1 : -1) * sign;
      A += s * r.A; Qy += s * r.Qy; Qz += s * r.Qz;
      Iyy += s * r.Iyy; Izz += s * r.Izz; Iyz += s * r.Iyz;
    }
    (regions || []).forEach(function (rg) {
      add(rg.outer, 1);
      (rg.outer || []).forEach(function (p) {
        lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]);
        hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]);
      });
      (rg.holes || []).forEach(function (h) { add(h, -1); });
    });
    if (!(A > EPS)) return null;
    var cy = Qz / A, cz = Qy / A;
    return {
      A: A, cy: cy, cz: cz,
      Iyy: Iyy - A * cz * cz, Izz: Izz - A * cy * cy, Iyz: Iyz - A * cy * cz,
      bbox: { min: lo, max: hi }
    };
  }

  function pointInRing(p, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) &&
          p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }

  function pointInRegion(p, region) {
    if (!pointInRing(p, region.outer)) return false;
    for (var i = 0; i < (region.holes || []).length; i++) {
      if (pointInRing(p, region.holes[i])) return false;
    }
    return true;
  }

  /** Drop repeated closing points and consecutive duplicates. */
  function cleanRing(ring, tol) {
    tol = tol || 1e-9;
    var out = [];
    (ring || []).forEach(function (p) {
      var q = out[out.length - 1];
      if (!q || Math.abs(q[0] - p[0]) > tol || Math.abs(q[1] - p[1]) > tol) out.push([p[0], p[1]]);
    });
    while (out.length > 1 &&
           Math.abs(out[0][0] - out[out.length - 1][0]) <= tol &&
           Math.abs(out[0][1] - out[out.length - 1][1]) <= tol) out.pop();
    return out;
  }

  /* -------------------------------------------------------- triangulation */

  /**
   * Bowyer–Watson Delaunay triangulation of a point list. O(n²), which is fine
   * for a section outline (hundreds of points), and has no dependencies.
   * Returns triangles as index triples, counter-clockwise.
   */
  function delaunay(pts) {
    var n = pts.length;
    if (n < 3) return [];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(function (p) {
      minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
    });
    var d = Math.max(maxX - minX, maxY - minY) || 1;
    var mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    var P = pts.concat([[mx - 20 * d, my - d], [mx, my + 20 * d], [mx + 20 * d, my - d]]);
    var tris = [mkTri(P, n, n + 1, n + 2)];

    for (var i = 0; i < n; i++) {
      var p = P[i];
      var bad = [], keep = [];
      for (var t = 0; t < tris.length; t++) {
        var T = tris[t];
        var dx = p[0] - T.cx, dy = p[1] - T.cy;
        if (dx * dx + dy * dy < T.r2 * (1 - 1e-12)) bad.push(T); else keep.push(T);
      }
      /* The boundary of the cavity: edges of bad triangles not shared by two. */
      var edges = Object.create(null);
      bad.forEach(function (T) {
        [[T.a, T.b], [T.b, T.c], [T.c, T.a]].forEach(function (e) {
          var k = e[0] < e[1] ? e[0] + "_" + e[1] : e[1] + "_" + e[0];
          if (edges[k]) edges[k].n++; else edges[k] = { e: e, n: 1 };
        });
      });
      tris = keep;
      Object.keys(edges).forEach(function (k) {
        if (edges[k].n === 1) {
          var tri = mkTri(P, edges[k].e[0], edges[k].e[1], i);
          if (tri) tris.push(tri);
        }
      });
    }
    return tris.filter(function (T) { return T.a < n && T.b < n && T.c < n; })
      .map(function (T) { return [T.a, T.b, T.c]; });
  }

  function mkTri(P, a, b, c) {
    var A = P[a], B = P[b], C = P[c];
    var orient = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (Math.abs(orient) < 1e-18) return null;
    if (orient < 0) { var tmp = b; b = c; c = tmp; B = P[b]; C = P[c]; }
    var D = 2 * (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1]));
    var a2 = A[0] * A[0] + A[1] * A[1], b2 = B[0] * B[0] + B[1] * B[1], c2 = C[0] * C[0] + C[1] * C[1];
    var cx = (a2 * (B[1] - C[1]) + b2 * (C[1] - A[1]) + c2 * (A[1] - B[1])) / D;
    var cy = (a2 * (C[0] - B[0]) + b2 * (A[0] - C[0]) + c2 * (B[0] - A[0])) / D;
    var dx = A[0] - cx, dy = A[1] - cy;
    return { a: a, b: b, c: c, cx: cx, cy: cy, r2: dx * dx + dy * dy };
  }

  /**
   * Triangulate a region (outer ring + holes) so that every boundary segment is
   * an edge of the triangulation. Boundary segments are first subdivided to
   * `spacing`; any segment the Delaunay triangulation still does not contain is
   * split at its midpoint and the triangulation rebuilt, until all conform.
   *
   * Vertices remember which ring they sit on and where, so a second outline with
   * the same ring sizes can be mapped onto the same triangles (see mapOutline).
   *
   * @returns {{verts, tris, ringOf, posOf, rings, spacingUsed, subdiv}}
   */
  function triangulateRegion(region, spacing, subdivHint) {
    var rings = [region.outer].concat(region.holes || []).map(function (r) { return cleanRing(r); });
    /* subdiv[r][k] = pieces the k-th original edge of ring r is cut into. A hint
       (from another outline) fixes the counts so both outlines share topology. */
    var subdiv = subdivHint ? subdivHint.map(function (a) { return a.slice(); }) : rings.map(function (ring) {
      return ring.map(function (p, k) {
        var q = ring[(k + 1) % ring.length];
        var L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        return Math.max(1, Math.ceil(L / spacing - 1e-9));
      });
    });

    for (var attempt = 0; attempt < 12; attempt++) {
      var built = buildDense(rings, subdiv);
      var tris = delaunay(built.verts);
      var edgeSet = Object.create(null);
      tris.forEach(function (t) {
        [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]].forEach(function (e) {
          edgeSet[e[0] < e[1] ? e[0] + "_" + e[1] : e[1] + "_" + e[0]] = true;
        });
      });
      var missing = 0;
      built.segments.forEach(function (s) {
        var k = s.a < s.b ? s.a + "_" + s.b : s.b + "_" + s.a;
        if (!edgeSet[k]) {
          subdiv[s.ring][s.edge] *= 2;
          missing++;
        }
      });
      if (!missing || subdivHint) {
        /* Keep only triangles inside the region. A triangle is inside when its
           centroid is — every boundary segment is an edge, so no triangle
           straddles the boundary. */
        var inside = tris.filter(function (t) {
          var A = built.verts[t[0]], B = built.verts[t[1]], C = built.verts[t[2]];
          var c = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3];
          return pointInRing(c, rings[0]) && !rings.slice(1).some(function (h) { return pointInRing(c, h); });
        });
        return { verts: built.verts, tris: inside, ringOf: built.ringOf, posOf: built.posOf,
                 rings: rings, subdiv: subdiv, conforming: !missing, segments: built.segments };
      }
    }
    return null;
  }

  function buildDense(rings, subdiv) {
    var verts = [], ringOf = [], posOf = [], segments = [];
    rings.forEach(function (ring, r) {
      var start = verts.length, count = 0;
      ring.forEach(function (p, k) {
        var q = ring[(k + 1) % ring.length], n = subdiv[r][k];
        for (var s = 0; s < n; s++) {
          verts.push([p[0] + (q[0] - p[0]) * s / n, p[1] + (q[1] - p[1]) * s / n]);
          ringOf.push(r); posOf.push(count++);
        }
      });
      var m = verts.length - start;
      var idx = 0;
      ring.forEach(function (p, k) {
        for (var s = 0; s < subdiv[r][k]; s++) {
          segments.push({ a: start + idx, b: start + ((idx + 1) % m), ring: r, edge: k });
          idx++;
        }
      });
    });
    return { verts: verts, ringOf: ringOf, posOf: posOf, segments: segments };
  }

  /* ------------------------------------------------------ chordal axis */

  /**
   * The chordal axis of a triangulated region, as a graph of centreline pieces.
   *
   * Nodes are keyed so the graph can be re-evaluated on moved vertices:
   *   "e:i_j"  midpoint of interior edge (i, j)
   *   "t:n"    centroid of triangle n (a junction)
   *   "v:i"    boundary vertex i (the apex of a terminal triangle)
   * Every piece carries the triangle whose area it owns (a junction shares its
   * area equally between its three spokes).
   */
  function chordalAxis(tri) {
    var T = tri.tris, V = tri.verts;
    var boundary = Object.create(null);
    tri.segments.forEach(function (s) { boundary[key(s.a, s.b)] = true; });

    var pieces = [];
    T.forEach(function (t, n) {
      var e = [[t[0], t[1], t[2]], [t[1], t[2], t[0]], [t[2], t[0], t[1]]];   /* edge + opposite */
      var interior = e.filter(function (x) { return !boundary[key(x[0], x[1])]; });
      if (interior.length === 1) {
        /* Terminal: from the interior edge's midpoint to the apex. */
        pieces.push({ a: "e:" + key(interior[0][0], interior[0][1]), b: "v:" + interior[0][2], tri: n, share: 1 });
      } else if (interior.length === 2) {
        pieces.push({ a: "e:" + key(interior[0][0], interior[0][1]),
                      b: "e:" + key(interior[1][0], interior[1][1]), tri: n, share: 1 });
      } else if (interior.length === 3) {
        interior.forEach(function (x) {
          pieces.push({ a: "t:" + n, b: "e:" + key(x[0], x[1]), tri: n, share: 1 / 3 });
        });
      } else {
        /* An isolated triangle: all three edges on the boundary. It has no
           centreline; its area is attached to its centroid as a degenerate wall
           and reported by the caller if it matters. */
        pieces.push({ a: "t:" + n, b: "t:" + n, tri: n, share: 1, isolated: true });
      }
    });
    return pieces;
  }

  function key(i, j) { return i < j ? i + "_" + j : j + "_" + i; }

  function nodePoint(k, verts, tris) {
    var c = k.charAt(0), rest = k.slice(2);
    if (c === "v") return verts[Number(rest)];
    if (c === "e") {
      var ij = rest.split("_").map(Number);
      return [(verts[ij[0]][0] + verts[ij[1]][0]) / 2, (verts[ij[0]][1] + verts[ij[1]][1]) / 2];
    }
    /* A junction sits at the triangle's circumcentre — a point of the true
       medial axis — when that lies inside the triangle; otherwise (an obtuse
       triangle) at the midpoint of its longest edge. The centroid, the textbook
       choice, drags a T-junction towards the stem. */
    var t = tris[Number(rest)];
    var A = verts[t[0]], B = verts[t[1]], C = verts[t[2]];
    var D = 2 * (A[0] * (B[1] - C[1]) + B[0] * (C[1] - A[1]) + C[0] * (A[1] - B[1]));
    if (Math.abs(D) > 1e-18) {
      var a2 = A[0] * A[0] + A[1] * A[1], b2 = B[0] * B[0] + B[1] * B[1], c2 = C[0] * C[0] + C[1] * C[1];
      var ux = (a2 * (B[1] - C[1]) + b2 * (C[1] - A[1]) + c2 * (A[1] - B[1])) / D;
      var uy = (a2 * (C[0] - B[0]) + b2 * (A[0] - C[0]) + c2 * (B[0] - A[0])) / D;
      var s1 = cross3(A, B, [ux, uy]), s2 = cross3(B, C, [ux, uy]), s3 = cross3(C, A, [ux, uy]);
      if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return [ux, uy];
    }
    var e = [[A, B], [B, C], [C, A]].sort(function (p, q) {
      return Math.hypot(q[0][0] - q[1][0], q[0][1] - q[1][1]) - Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
    })[0];
    return [(e[0][0] + e[1][0]) / 2, (e[0][1] + e[1][1]) / 2];
  }

  function cross3(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }

  function triArea(verts, t) {
    var A = verts[t[0]], B = verts[t[1]], C = verts[t[2]];
    return Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2;
  }

  /**
   * Chordal-axis pieces → branches (polylines between junctions and ends),
   * with short hairs pruned. A hair is a terminal branch shorter than
   * `pruneRatio` x the local wall width where it leaves its junction — the
   * spurs a triangulation grows into every corner. Their area is handed to the
   * branch they left, so area stays exact.
   *
   * Branches are returned as node-key lists with per-piece area weights, so
   * the same topology can be evaluated on any outline with the same vertices.
   */
  function branchesFrom(tri, pieces, opts) {
    opts = opts || {};
    var pruneRatio = opts.pruneRatio == null ? 1.25 : opts.pruneRatio;
    var V = tri.verts, T = tri.tris;

    /* adjacency */
    var adj = Object.create(null);
    var live = pieces.filter(function (p) { return !p.isolated; });
    live.forEach(function (p, i) {
      p.id = i;
      p.area = triArea(V, T[p.tri]) * p.share;
      (adj[p.a] || (adj[p.a] = [])).push(p);
      (adj[p.b] || (adj[p.b] = [])).push(p);
    });
    var lostArea = pieces.filter(function (p) { return p.isolated; })
      .reduce(function (a, p) { return a + triArea(V, T[p.tri]); }, 0);

    function other(p, k) { return p.a === k ? p.b : p.a; }
    function degree(k) { return (adj[k] || []).filter(function (p) { return !p.dead; }).length; }
    function width(k) {
      if (k.charAt(0) === "e") {
        var ij = k.slice(2).split("_").map(Number);
        return Math.hypot(V[ij[0]][0] - V[ij[1]][0], V[ij[0]][1] - V[ij[1]][1]);
      }
      if (k.charAt(0) === "t") {
        var t = T[Number(k.slice(2))];
        var w = 0;
        [[0, 1], [1, 2], [2, 0]].forEach(function (e) {
          w = Math.max(w, Math.hypot(V[t[e[0]]][0] - V[t[e[1]]][0], V[t[e[0]]][1] - V[t[e[1]]][1]));
        });
        return w;
      }
      return 0;
    }
    function len(p) {
      var a = nodePoint(p.a, V, T), b = nodePoint(p.b, V, T);
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    }

    /* Prune repeatedly: removing a hair can turn its junction into a pass-through
       and expose a new hair. */
    for (var pass = 0; pass < 20; pass++) {
      var removed = 0;
      Object.keys(adj).forEach(function (k) {
        if (degree(k) !== 1) return;
        /* walk from this end to the first node of degree != 2 */
        var path = [], cur = k, prev = null, L = 0, area = 0;
        for (var guard = 0; guard < 100000; guard++) {
          var next = (adj[cur] || []).filter(function (p) { return !p.dead && p !== prev; });
          if (!next.length) break;
          var p = next[0];
          path.push(p); L += len(p); area += p.area;
          prev = p; cur = other(p, cur);
          if (degree(cur) !== 2) break;
        }
        if (degree(cur) < 3) return;          /* a whole free branch: never prune */
        if (L < pruneRatio * width(cur)) {
          path.forEach(function (p) { p.dead = true; });
          /* hand the area to a surviving piece at the junction */
          var host = (adj[cur] || []).filter(function (p) { return !p.dead; })[0];
          if (host) host.area += area;
          removed++;
        }
      });
      if (!removed) break;
    }

    /* Collect branches: maximal chains through degree-2 nodes. */
    var used = Object.create(null);
    var branches = [];
    function walk(start, first) {
      var keys = [start], areas = [], cur = start, p = first;
      while (p && !used[p.id]) {
        used[p.id] = true;
        cur = other(p, cur);
        keys.push(cur); areas.push(p.area);
        if (degree(cur) !== 2) break;
        p = (adj[cur] || []).filter(function (q) { return !q.dead && !used[q.id]; })[0];
      }
      return { keys: keys, areas: areas };
    }
    Object.keys(adj).forEach(function (k) {
      if (degree(k) === 2) return;
      (adj[k] || []).forEach(function (p) {
        if (!p.dead && !used[p.id]) branches.push(walk(k, p));
      });
    });
    /* closed loops with no junction at all (a pipe) */
    live.forEach(function (p) {
      if (!p.dead && !used[p.id]) branches.push(walk(p.a, p));
    });
    return { branches: branches, lostArea: lostArea };
  }

  /* ------------------------------------------------- polyline utilities */

  /** Douglas–Peucker on a polyline; returns the indices kept. */
  function simplifyIdx(pts, tol) {
    var n = pts.length;
    if (n <= 2) return pts.map(function (p, i) { return i; });
    var keep = new Array(n); keep[0] = keep[n - 1] = true;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var s = stack.pop(), a = s[0], b = s[1];
      var A = pts[a], B = pts[b], dx = B[0] - A[0], dy = B[1] - A[1];
      var L = Math.hypot(dx, dy), best = -1, bi = -1;
      for (var i = a + 1; i < b; i++) {
        var d = L > EPS ? Math.abs((pts[i][0] - A[0]) * dy - (pts[i][1] - A[1]) * dx) / L
                        : Math.hypot(pts[i][0] - A[0], pts[i][1] - A[1]);
        if (d > best) { best = d; bi = i; }
      }
      if (best > tol) { keep[bi] = true; stack.push([a, bi], [bi, b]); }
    }
    var out = [];
    for (var k = 0; k < n; k++) if (keep[k]) out.push(k);
    return out;
  }

  /* ------------------------------------------------------------- strips */

  /**
   * Width of a region along a line: the total length of the chord(s) the line
   * y = c (axis "y": line of constant y) or z = c cuts through it.
   */
  function sliceArea(region, axis, lo, hi) {
    /* area of region between two parallel lines, by clipping each ring */
    var clipRing = function (ring) {
      var r = clipHalf(ring, axis, lo, 1);
      r = clipHalf(r, axis, hi, -1);
      return r.length >= 3 ? Math.abs(signedArea(r)) : 0;
    };
    var a = clipRing(region.outer);
    (region.holes || []).forEach(function (h) { a -= clipRing(h); });
    return a;
  }

  /** Sutherland–Hodgman against one half-plane: keep coord >= c (dir 1) or <= c (dir -1). */
  function clipHalf(ring, axis, c, dir) {
    var k = axis === "y" ? 0 : 1, out = [];
    for (var i = 0, n = ring.length; i < n; i++) {
      var P = ring[i], Q = ring[(i + 1) % n];
      var pin = dir * (P[k] - c) >= 0, qin = dir * (Q[k] - c) >= 0;
      if (pin) out.push(P);
      if (pin !== qin) {
        var t = (c - P[k]) / (Q[k] - P[k]);
        out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
      }
    }
    return out;
  }

  var api = {
    signedArea: signedArea,
    polyProps: polyProps,
    pointInRing: pointInRing,
    pointInRegion: pointInRegion,
    cleanRing: cleanRing,
    delaunay: delaunay,
    triangulateRegion: triangulateRegion,
    chordalAxis: chordalAxis,
    branchesFrom: branchesFrom,
    nodePoint: nodePoint,
    triArea: triArea,
    simplifyIdx: simplifyIdx,
    sliceArea: sliceArea,
    clipHalf: clipHalf
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PGeom = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
