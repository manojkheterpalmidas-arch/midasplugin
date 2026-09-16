/* ==========================================================================
   Beam to Plate — wall models
   --------------------------------------------------------------------------
   A WALL MODEL is what a plate mesh is built from: centrelines in the section's
   own (y, z) frame, each piece with a thickness.

     { walls: [{ name, part, pts:[[y,z]..], t:[per segment], hard:[per vertex],
                 closed }],
       connectors: [{ a:[y,z], b:[y,z] }],   // rigid ties between separate parts
       regions: [{ outer, holes }],          // the solid outline, for drawing
       method: "exact" | "chordal" | "strips" }

   Walls that meet share the exact same junction point, so the mesh's node pool
   joins them. (The previous version ran a web to the flange's INNER face while
   the flange sat on its centreline, so web and flange never shared a node and
   the plates were not connected — nothing numeric caught it.)

   Geometry conventions here were MEASURED on CIVIL NX 2026 (probe of
   2026-09-15, one section per shape code, properties read back from
   /ope/SECTPROP):

     H   B1/tf1 is the TOP flange, B2/tf2 the bottom.
     B   C is the centre-to-centre spacing of the two webs (Izz proves it:
         webs at the outer faces would give 4.39e9 mm4, CIVIL NX says 2.749e9,
         webs at ±C/2 give 2.749e9 exactly). C = 0 puts them at the faces.
     T   flange on top.
     C   web on the -y side, flanges run to +y; B1 is the top flange width,
         measured over the web.
     L   the horizontal leg is at the TOP, full width B, thickness tf; the
         vertical leg is on the -y side, thickness tw.
     2L  two angles, vertical legs back to back with a gap C, horizontal legs
         at the top running outwards.
     2C  two channels, webs back to back with a gap C, flanges outwards.
     UDT flange at the BOTTOM; B1/B2 project beyond the web to -y/+y.
     HTRK flat on the -y side, round on +y.
   ========================================================================== */
(function (root) {
  "use strict";

  var G = root.B2PGeom || (typeof require === "function" ? require("./geom2d.js") : null);
  var TAU = Math.PI * 2;

  /* ------------------------------------------------------------- helpers */

  function wall(name, t, pts, opts) {
    opts = opts || {};
    var n = pts.length;
    /* a closed wall has as many segments as points (the last closes the loop) */
    var segs = opts.closed ? n : Math.max(0, n - 1);
    return {
      name: name, part: opts.part || 0, closed: !!opts.closed,
      pts: pts.map(function (p) { return [p[0], p[1]]; }),
      t: Array.isArray(t) ? t.slice() : new Array(segs).fill(Number(t) || 0),
      hard: opts.hard ? opts.hard.slice() : new Array(n).fill(true)
    };
  }

  function rect(y0, z0, y1, z1) { return [[y0, z0], [y1, z0], [y1, z1], [y0, z1]]; }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /* -------------------------------------------------------- exact builders */

  /* Each returns { walls, regions, connectors } in a natural frame; the section
     module moves it onto the node line afterwards. Frames: y centred where the
     shape is symmetric, z = 0 at the underside. */
  var EXACT = {
    H: function (v) {
      var H = num(v[0]), B1 = num(v[1]), tw = num(v[2]), tf1 = num(v[3]);
      var B2 = num(v[4]) || B1, tf2 = num(v[5]) || tf1;
      var r1 = num(v[6]), r2 = num(v[7]) || r1;
      if (!(H > 0 && B1 > 0 && tw > 0 && tf1 > 0 && tf1 + tf2 < H)) return null;
      var zt = H - tf1 / 2, zb = tf2 / 2;
      /* Root fillets carry area but almost no bending stiffness; they are put
         into the web, where they sit. */
      var fillet = 2 * (1 - Math.PI / 4) * (r1 * r1 + r2 * r2);
      var twEff = tw + fillet / (zt - zb);
      var outer = [[-B2 / 2, 0], [B2 / 2, 0], [B2 / 2, tf2], [tw / 2, tf2], [tw / 2, H - tf1],
        [B1 / 2, H - tf1], [B1 / 2, H], [-B1 / 2, H], [-B1 / 2, H - tf1], [-tw / 2, H - tf1],
        [-tw / 2, tf2], [-B2 / 2, tf2]];
      return {
        walls: [
          wall("Top flange", tf1, [[-B1 / 2, zt], [0, zt], [B1 / 2, zt]]),
          wall("Bottom flange", tf2, [[-B2 / 2, zb], [0, zb], [B2 / 2, zb]]),
          wall("Web", twEff, [[0, zb], [0, zt]])
        ],
        regions: [{ outer: outer, holes: [] }],
        note: fillet > 0 ? "root fillets added to the web thickness" : ""
      };
    },

    I: function (v) {       /* COMPOSITE steel plate girder: Hw, tw, B1, tf1, B2, tf2 */
      var Hw = num(v[0]), tw = num(v[1]), B1 = num(v[2]), tf1 = num(v[3]);
      var B2 = num(v[4]) || B1, tf2 = num(v[5]) || tf1;
      if (!(Hw > 0 && tw > 0 && B1 > 0 && tf1 > 0)) return null;
      return EXACT.H([Hw + tf1 + tf2, B1, tw, tf1, B2, tf2]);
    },

    B: function (v) {
      var H = num(v[0]), B = num(v[1]), tw = num(v[2]), tf1 = num(v[3]);
      var C = num(v[4]), tf2 = num(v[5]) || tf1;
      if (!(H > 0 && B > 0 && tw > 0 && tf1 > 0 && tf1 + tf2 < H)) return null;
      var yw = C > 0 ? C / 2 : B / 2 - tw / 2;
      if (yw + tw / 2 > B / 2 + 1e-9 || yw - tw / 2 <= 0) return null;
      var zt = H - tf1 / 2, zb = tf2 / 2;
      var fo = yw + tw / 2, fi = yw - tw / 2;
      var outer = [[-B / 2, 0], [B / 2, 0], [B / 2, tf2], [fo, tf2], [fo, H - tf1], [B / 2, H - tf1],
        [B / 2, H], [-B / 2, H], [-B / 2, H - tf1], [-fo, H - tf1], [-fo, tf2], [-B / 2, tf2]];
      var topPts = [[-B / 2, zt], [-yw, zt], [yw, zt], [B / 2, zt]];
      var botPts = [[-B / 2, zb], [-yw, zb], [yw, zb], [B / 2, zb]];
      /* An overhang of zero leaves a zero-length end piece — drop it. */
      if (Math.abs(B / 2 - yw) < 1e-12) { topPts = [[-yw, zt], [yw, zt]]; botPts = [[-yw, zb], [yw, zb]]; }
      return {
        walls: [
          wall("Top flange", tf1, topPts), wall("Bottom flange", tf2, botPts),
          wall("Left web", tw, [[-yw, zb], [-yw, zt]]), wall("Right web", tw, [[yw, zb], [yw, zt]])
        ],
        regions: [{ outer: G.cleanRing(outer), holes: [rect(-fi, tf2, fi, H - tf1)] }]
      };
    },

    T: function (v) {
      var H = num(v[0]), B = num(v[1]), tw = num(v[2]), tf = num(v[3]);
      if (!(H > 0 && B > 0 && tw > 0 && tf > 0 && tf < H)) return null;
      var zt = H - tf / 2;
      return {
        walls: [wall("Flange", tf, [[-B / 2, zt], [0, zt], [B / 2, zt]]),
                wall("Web", tw, [[0, 0], [0, zt]])],
        regions: [{ outer: [[-tw / 2, 0], [tw / 2, 0], [tw / 2, H - tf], [B / 2, H - tf], [B / 2, H],
          [-B / 2, H], [-B / 2, H - tf], [-tw / 2, H - tf]], holes: [] }]
      };
    },

    UDT: function (v) {
      var H = num(v[0]), B1 = num(v[1]), B2 = num(v[2]), tw = num(v[3]), tf = num(v[4]);
      if (!(H > 0 && tw > 0 && tf > 0 && tf < H)) return null;
      var zb = tf / 2, yl = -tw / 2 - B1, yr = tw / 2 + B2;
      return {
        walls: [wall("Flange", tf, [[yl, zb], [0, zb], [yr, zb]]),
                wall("Web", tw, [[0, zb], [0, H]])],
        regions: [{ outer: [[yl, 0], [yr, 0], [yr, tf], [tw / 2, tf], [tw / 2, H], [-tw / 2, H],
          [-tw / 2, tf], [yl, tf]], holes: [] }]
      };
    },

    C: function (v) {
      var H = num(v[0]), B1 = num(v[1]), tw = num(v[2]), tf1 = num(v[3]);
      var B2 = num(v[4]) || B1, tf2 = num(v[5]) || tf1;
      if (!(H > 0 && B1 > 0 && tw > 0 && tf1 > 0 && tf1 + tf2 < H)) return null;
      var yw = tw / 2, zt = H - tf1 / 2, zb = tf2 / 2;
      return {
        walls: [wall("Top flange", tf1, [[yw, zt], [B1, zt]]),
                wall("Bottom flange", tf2, [[yw, zb], [B2, zb]]),
                wall("Web", tw, [[yw, zb], [yw, zt]])],
        regions: [{ outer: [[0, 0], [B2, 0], [B2, tf2], [tw, tf2], [tw, H - tf1], [B1, H - tf1],
          [B1, H], [0, H]], holes: [] }]
      };
    },

    L: function (v) {
      var H = num(v[0]), B = num(v[1]), tw = num(v[2]), tf = num(v[3]);
      if (!(H > 0 && B > 0 && tw > 0 && tf > 0 && tf < H && tw < B)) return null;
      var yw = tw / 2, zt = H - tf / 2;
      return {
        walls: [wall("Horizontal leg", tf, [[yw, zt], [B, zt]]),
                wall("Vertical leg", tw, [[yw, 0], [yw, zt]])],
        regions: [{ outer: [[0, 0], [tw, 0], [tw, H - tf], [B, H - tf], [B, H], [0, H]], holes: [] }]
      };
    },

    "2L": function (v) {
      var H = num(v[0]), B = num(v[1]), t1 = num(v[2]), t2 = num(v[3]) || num(v[2]), C = num(v[4]);
      if (!(H > 0 && B > 0 && t1 > 0 && t2 > 0 && t2 < H && t1 < B)) return null;
      var zt = H - t2 / 2, g = C / 2;
      if (!(C > 0)) {
        return {
          walls: [wall("Legs", t2, [[-B, zt], [0, zt], [B, zt]]), wall("Backs", 2 * t1, [[0, 0], [0, zt]])],
          regions: [{ outer: [[-t1, 0], [t1, 0], [t1, H - t2], [B, H - t2], [B, H], [-B, H], [-B, H - t2],
            [-t1, H - t2]], holes: [] }]
        };
      }
      var yr = g + t1 / 2;
      var right = [[g, 0], [g + t1, 0], [g + t1, H - t2], [g + B, H - t2], [g + B, H], [g, H]];
      return {
        walls: [
          wall("Right horizontal leg", t2, [[yr, zt], [g + B, zt]], { part: 1 }),
          wall("Right vertical leg", t1, [[yr, 0], [yr, zt]], { part: 1 }),
          wall("Left horizontal leg", t2, [[-yr, zt], [-g - B, zt]], { part: 0 }),
          wall("Left vertical leg", t1, [[-yr, 0], [-yr, zt]], { part: 0 })
        ],
        regions: [{ outer: right, holes: [] }, { outer: right.map(function (p) { return [-p[0], p[1]]; }).reverse(), holes: [] }],
        /* back to back through the gusset: the beam model treats the pair as one
           section, so they are tied at the heels and at the bottom of the legs */
        connectors: [{ a: [-yr, zt], b: [yr, zt] }, { a: [-yr, 0], b: [yr, 0] }]
      };
    },

    "2C": function (v) {
      var H = num(v[0]), B = num(v[1]), tw = num(v[2]), tf = num(v[3]), C = num(v[4]);
      if (!(H > 0 && B > 0 && tw > 0 && tf > 0 && 2 * tf < H && tw < B)) return null;
      var zt = H - tf / 2, zb = tf / 2, g = C / 2;
      if (!(C > 0)) {
        return {
          walls: [wall("Top flanges", tf, [[-B, zt], [0, zt], [B, zt]]),
                  wall("Bottom flanges", tf, [[-B, zb], [0, zb], [B, zb]]),
                  wall("Webs", 2 * tw, [[0, zb], [0, zt]])],
          regions: [{ outer: [[-B, 0], [B, 0], [B, tf], [tw, tf], [tw, H - tf], [B, H - tf], [B, H],
            [-B, H], [-B, H - tf], [-tw, H - tf], [-tw, tf], [-B, tf]], holes: [] }]
        };
      }
      var yw = g + tw / 2;
      var right = [[g, 0], [g + B, 0], [g + B, tf], [g + tw, tf], [g + tw, H - tf], [g + B, H - tf], [g + B, H], [g, H]];
      return {
        walls: [
          wall("Right top flange", tf, [[yw, zt], [g + B, zt]], { part: 1 }),
          wall("Right bottom flange", tf, [[yw, zb], [g + B, zb]], { part: 1 }),
          wall("Right web", tw, [[yw, zb], [yw, zt]], { part: 1 }),
          wall("Left top flange", tf, [[-yw, zt], [-g - B, zt]], { part: 0 }),
          wall("Left bottom flange", tf, [[-yw, zb], [-g - B, zb]], { part: 0 }),
          wall("Left web", tw, [[-yw, zb], [-yw, zt]], { part: 0 })
        ],
        regions: [{ outer: right, holes: [] }, { outer: right.map(function (p) { return [-p[0], p[1]]; }).reverse(), holes: [] }],
        connectors: [{ a: [-yw, zt], b: [yw, zt] }, { a: [-yw, zb], b: [yw, zb] }]
      };
    },

    P: function (v, opts) {
      var D = num(v[0]), tw = num(v[1]);
      if (!(D > 0 && tw > 0 && tw < D / 2)) return null;
      var n = Math.max(8, Math.round((opts && opts.facets) || 24));
      var r = (D - tw) / 2;
      /* A faceted ring is shorter than the circle; scale the radius so the
         perimeter — and so the area — is exact. */
      var scale = (TAU * r) / (n * 2 * r * Math.sin(Math.PI / n));
      var pts = ring(0, D / 2, r * scale, n);
      return {
        walls: [wall("Wall", tw, pts, { closed: true })],
        regions: [{ outer: ring(0, D / 2, D / 2, 48), holes: [ring(0, D / 2, D / 2 - tw, 48)] }]
      };
    },

    TRK: function (v, opts) {
      var H = num(v[0]), B = num(v[1]), t = num(v[2]);
      if (!(H > 0 && B >= H && t > 0 && 2 * t < H)) return null;
      var n = Math.max(4, Math.round(((opts && opts.facets) || 24) / 2));
      var mid = obround(H - t, B - t, n, H / 2);
      var perim = Math.PI * (H - t) + 2 * (B - H);
      var poly = 0;
      for (var i = 0; i < mid.length; i++) {
        var q = mid[(i + 1) % mid.length];
        poly += Math.hypot(q[0] - mid[i][0], q[1] - mid[i][1]);
      }
      return {
        walls: [wall("Wall", t * perim / poly, mid, { closed: true })],
        regions: [{ outer: obround(H, B, 24, H / 2), holes: [obround(H - 2 * t, B - 2 * t, 24, H / 2)] }]
      };
    },

    OCT: function (v) {
      var H = num(v[0]), B = num(v[1]), c1 = num(v[2]), c2 = num(v[3]), t = num(v[4]);
      if (!(H > 0 && B > 0 && t > 0)) return null;
      var outer = octagon(H, B, c1, c2);
      var mid = offsetConvex(outer, t / 2), inner = offsetConvex(outer, t);
      if (!mid || !inner) return null;
      return {
        walls: [wall("Wall", t, mid, { closed: true })],
        regions: [{ outer: outer, holes: [inner] }]
      };
    }
  };

  function ring(cy, cz, r, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var a = TAU * i / n;
      out.push([cy + r * Math.sin(a), cz + r * Math.cos(a)]);
    }
    return out;
  }

  /** Obround H x B centred at (0, zc), semicircular ends of radius H/2. */
  function obround(H, B, n, zc) {
    var r = H / 2, s = B / 2 - r, out = [], i;
    for (i = 0; i <= n; i++) {
      var a = -Math.PI / 2 + Math.PI * i / n;
      out.push([s + r * Math.cos(a), zc + r * Math.sin(a)]);
    }
    for (i = 0; i <= n; i++) {
      var b = Math.PI / 2 + Math.PI * i / n;
      out.push([-s + r * Math.cos(b), zc + r * Math.sin(b)]);
    }
    return G.cleanRing(out);
  }

  /** Rectangle B x H (z from 0) with corners cut c1 along the width and c2 along the depth. */
  function octagon(H, B, c1, c2) {
    var b = B / 2;
    return G.cleanRing([[-b + c1, 0], [b - c1, 0], [b, c2], [b, H - c2], [b - c1, H], [-b + c1, H],
      [-b, H - c2], [-b, c2]]);
  }

  /** Inward offset of a convex polygon by d (counter-clockwise or not). */
  function offsetConvex(pts, d) {
    var ccw = G.signedArea(pts) > 0;
    var n = pts.length, lines = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      var dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
      if (L < 1e-12) continue;
      var nx = (ccw ? -dy : dy) / L, ny = (ccw ? dx : -dx) / L;
      lines.push({ p: [p[0] + nx * d, p[1] + ny * d], d: [dx / L, dy / L] });
    }
    var out = [];
    for (var k = 0; k < lines.length; k++) {
      var A = lines[(k + lines.length - 1) % lines.length], Bl = lines[k];
      var den = A.d[0] * Bl.d[1] - A.d[1] * Bl.d[0];
      if (Math.abs(den) < 1e-12) { out.push(Bl.p); continue; }
      var t = ((Bl.p[0] - A.p[0]) * Bl.d[1] - (Bl.p[1] - A.p[1]) * Bl.d[0]) / den;
      out.push([A.p[0] + A.d[0] * t, A.p[1] + A.d[1] * t]);
    }
    return out.length >= 3 && Math.abs(G.signedArea(out)) > 0 ? out : null;
  }

  /* ------------------------------------------------- outline → walls */

  /**
   * Turn solid regions into walls.
   *
   *   compact solid, no voids  → strips (one straight mid-plane plate whose
   *                              thickness follows the width at each level)
   *   anything else            → chordal axis of a conforming triangulation
   *
   * `opts.topology` (from a previous call's `.topology`) re-evaluates the same
   * triangles and branches on these regions — the regions must have the same
   * ring sizes. That is the tapered case.
   */
  function fromRegions(regions, opts) {
    opts = opts || {};
    var walls = [], topo = [], methods = {}, lost = 0, notes = [];
    for (var r = 0; r < regions.length; r++) {
      var rg = { outer: G.cleanRing(regions[r].outer), holes: (regions[r].holes || []).map(function (h) { return G.cleanRing(h); }) };
      var hint = opts.topology ? opts.topology[r] : null;
      var res = hint ? (hint.method === "strips" ? strips(rg, hint, r) : chordal(rg, hint, r))
                     : chooseAndBuild(rg, opts, r);
      if (!res) return null;
      methods[res.topology.method] = true;
      topo.push(res.topology);
      lost += res.lost || 0;
      res.walls.forEach(function (w) { walls.push(w); });
    }
    if (lost > 0) notes.push("a triangle of area " + lost.toExponential(2) + " had no centreline and was left out");
    return {
      walls: walls, regions: regions, connectors: [],
      method: Object.keys(methods).length === 1 ? Object.keys(methods)[0] : "mixed",
      topology: topo, note: notes.join("; ")
    };
  }

  function chooseAndBuild(rg, opts, part) {
    var props = G.polyProps([rg]);
    if (!props) return null;
    var w = props.bbox.max[0] - props.bbox.min[0], h = props.bbox.max[1] - props.bbox.min[1];
    if (opts.forceStrips) return strips(rg, null, part, opts);
    if (opts.forceChordal) return chordal(rg, null, part, opts) || strips(rg, null, part, opts);
    /* Build both where both are meaningful and keep the one whose second
       moments sit closer to the outline's. A solid with voids is never one
       plate. Strips win ties: one straight plate is the simpler mesh, and on a
       rectangle or a disc it is exact. */
    var c = chordal(rg, null, part, opts);
    if (rg.holes.length) return c || strips(rg, null, part, opts);
    var s = strips(rg, null, part, opts);
    var f = strips(rg, { axis: s.topology.axis, n: s.topology.n, follow: true }, part, opts);
    var es = idealError(s.walls, props), ef = f ? idealError(f.walls, props) : Infinity;
    /* a straight plate first; the centroid-following one only where it earns it */
    if (ef < es - 0.01) { s = f; es = ef; }
    if (!c) return s;
    var ec = idealError(c.walls, props);
    var compact = props.A / (w * h) >= (opts.compactness || 0.6);
    return (es <= ec + (compact ? 0.01 : -0.005)) ? s : c;
  }

  function idealError(walls, target) {
    var q = wallProps(walls);
    if (!q) return Infinity;
    return Math.max(Math.abs(q.Iyy - target.Iyy) / target.Iyy, Math.abs(q.Izz - target.Izz) / target.Izz,
                    Math.abs(q.A - target.A) / target.A);
  }

  /** One straight plate through the centroid, thickness = width at each level. */
  function strips(rg, hint, part, opts) {
    var props = G.polyProps([rg]);
    if (!props) return null;
    var w = props.bbox.max[0] - props.bbox.min[0], h = props.bbox.max[1] - props.bbox.min[1];
    var axis = hint ? hint.axis : (h >= w ? "z" : "y");
    var n = hint ? hint.n : Math.max(2, Math.min(64, (opts && opts.stripCount) || 32));
    var k = axis === "z" ? 1 : 0, o = 1 - k;
    var lo = props.bbox.min[k], hi = props.bbox.max[k];
    var follow = !!(hint && hint.follow);
    /* per slice: area and the centroid across it */
    var sl = [];
    for (var i = 0; i < n; i++) {
      var s0 = lo + (hi - lo) * i / n, s1 = lo + (hi - lo) * (i + 1) / n;
      var a = G.sliceArea(rg, axis, s0, s1);
      var c = props[o === 0 ? "cy" : "cz"];
      if (follow && a > 0) {
        var clipped = { outer: G.clipHalf(G.clipHalf(rg.outer, axis, s0, 1), axis, s1, -1),
                        holes: (rg.holes || []).map(function (hh) { return G.clipHalf(G.clipHalf(hh, axis, s0, 1), axis, s1, -1); })
                          .filter(function (hh) { return hh.length >= 3; }) };
        var cp = clipped.outer.length >= 3 ? G.polyProps([clipped]) : null;
        if (cp) c = o === 0 ? cp.cy : cp.cz;
      }
      sl.push({ s0: s0, s1: s1, a: a, c: c });
    }
    var pts = [], t = [];
    for (var j = 0; j <= n; j++) {
      var sv = lo + (hi - lo) * j / n;
      /* a vertex sits between two slices: take their area-weighted centre */
      var cv;
      if (!follow) cv = props[o === 0 ? "cy" : "cz"];
      else if (j === 0) cv = sl[0].c;
      else if (j === n) cv = sl[n - 1].c;
      else cv = (sl[j - 1].a + sl[j].a) > 0 ? (sl[j - 1].c * sl[j - 1].a + sl[j].c * sl[j].a) / (sl[j - 1].a + sl[j].a) : sl[j].c;
      pts.push(axis === "z" ? [cv, sv] : [sv, cv]);
    }
    for (var q = 0; q < n; q++) {
      var L = Math.hypot(pts[q + 1][0] - pts[q][0], pts[q + 1][1] - pts[q][1]);
      t.push(L > 0 ? sl[q].a / L : 0);
    }
    var hard = pts.map(function (p, i2) { return i2 === 0 || i2 === n; });
    return {
      walls: [wall("Mid-plane", t, pts, { part: part, hard: hard })],
      topology: { method: "strips", axis: axis, n: n, follow: follow }
    };
  }

  /** Chordal axis → walls. */
  function chordal(rg, hint, part, opts) {
    opts = opts || {};
    var props = G.polyProps([rg]);
    if (!props) return null;
    var tri, branches;
    if (hint) {
      tri = G.triangulateRegion(rg, 0, hint.subdiv);
      if (!tri || tri.verts.length !== hint.nVerts) return null;
      tri.tris = hint.tris;                          /* the same triangles on moved vertices */
      var flipped = tri.tris.some(function (t) {
        var A = tri.verts[t[0]], B = tri.verts[t[1]], C = tri.verts[t[2]];
        return (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) <= 0;
      });
      if (flipped) return null;
      branches = hint.branches;
    } else {
      tri = G.triangulateRegion(rg, opts.spacing || autoSpacing(rg, props));
      if (!tri || !tri.tris.length) return null;
      branches = G.branchesFrom(tri, G.chordalAxis(tri), opts).branches;
      mapPieceTris(tri, branches);
      branches.forEach(function (b) {
        b.free = [isFreeEnd(b.keys[0], branches), isFreeEnd(b.keys[b.keys.length - 1], branches)];
      });
    }
    var rings = [rg.outer].concat(rg.holes);

    /* 1. raw centrelines on THIS outline */
    var covered = 0;
    var raw = branches.map(function (b) {
      var pts = b.keys.map(function (k) { return G.nodePoint(k, tri.verts, tri.tris); });
      var areas = b.pieceTris.map(function (pt) {
        return pt.reduce(function (a, x) { return a + G.triArea(tri.verts, tri.tris[x.tri]) * x.share; }, 0);
      });
      areas.forEach(function (a) { covered += a; });
      var closed = b.keys.length > 2 && b.keys[0] === b.keys[b.keys.length - 1];
      return { pts: pts, areas: areas, closed: closed, free: b.free, keys: [b.keys[0], b.keys[b.keys.length - 1]] };
    });
    var lost = Math.max(0, props.A - covered);
    if (lost > props.A * 1e-9 && raw.length) {
      /* isolated triangles: spread over everything so area stays exact */
      var f = props.A / covered;
      raw.forEach(function (r) { r.areas = r.areas.map(function (a) { return a * f; }); });
    }

    /* 2. free ends: trim the corner-bound tip, carry straight on to the outline */
    raw.forEach(function (r) {
      if (r.closed || r.pts.length < 3) return;
      var tm = meanThickness(r.pts, r.areas);
      if (r.free[1]) trimAndExtend(r.pts, r.areas, rings, tm);
      if (r.free[0]) {
        r.pts.reverse(); r.areas.reverse();
        trimAndExtend(r.pts, r.areas, rings, tm);
        r.pts.reverse(); r.areas.reverse();
      }
    });

    /* 3. junctions to where the walls' own centrelines meet */
    sharpenJunctions(raw);

    /* 4. straighten each wall, square its corners, lay the areas along it */
    var walls = [];
    raw.forEach(function (r, bi) {
      var fin = finalizeWall(r);
      if (!fin) return;
      walls.push(wall("Wall " + (bi + 1), fin.t, fin.pts, {
        part: part, closed: r.closed,
        hard: fin.pts.map(function (p, i) { return !r.closed && (i === 0 || i === fin.pts.length - 1); })
      }));
    });

    return {
      walls: walls, lost: lost,
      topology: { method: "chordal", subdiv: tri.subdiv, tris: tri.tris, nVerts: tri.verts.length, branches: branches }
    };
  }

  /* For each branch piece, which triangles (and shares) its area came from.
     Pruned hairs hand their area to a host piece; that is kept as a scale on
     the host's own triangles, so a moved outline (tapered) redistributes it in
     proportion. */
  function mapPieceTris(tri, branches) {
    var pieces = G.chordalAxis(tri);
    var byEnds = Object.create(null);
    pieces.forEach(function (p) {
      var k = p.a < p.b ? p.a + "|" + p.b : p.b + "|" + p.a;
      (byEnds[k] || (byEnds[k] = [])).push(p);
    });
    branches.forEach(function (b) {
      b.pieceTris = [];
      for (var i = 0; i < b.keys.length - 1; i++) {
        var a = b.keys[i], c = b.keys[i + 1];
        var k = a < c ? a + "|" + c : c + "|" + a;
        var src = byEnds[k] || [];
        var direct = src.reduce(function (s, p) { return s + G.triArea(tri.verts, tri.tris[p.tri]) * p.share; }, 0);
        var scale = direct > 0 ? b.areas[i] / direct : 1;
        b.pieceTris.push(src.map(function (p) { return { tri: p.tri, share: p.share * scale }; }));
      }
    });
  }

  function isFreeEnd(k, branches) {
    var count = 0;
    branches.forEach(function (b) {
      if (b.keys[0] === k) count++;
      if (b.keys[b.keys.length - 1] === k) count++;
    });
    return count === 1;
  }

  function meanThickness(pts, areas) {
    var L = 0, A = 0;
    for (var i = 1; i < pts.length; i++) L += dist(pts[i], pts[i - 1]);
    areas.forEach(function (a) { A += a; });
    return L > 0 ? A / L : 0;
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /** Principal-axis line through a point set: { p: centroid, u: unit direction }. */
  function fitLine(ps) {
    var n = ps.length, cx = 0, cy = 0;
    ps.forEach(function (p) { cx += p[0]; cy += p[1]; });
    cx /= n; cy /= n;
    var sxx = 0, sxy = 0, syy = 0;
    ps.forEach(function (p) {
      var dx = p[0] - cx, dy = p[1] - cy;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    });
    var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { p: [cx, cy], u: [Math.cos(ang), Math.sin(ang)] };
  }

  function intersect(L1, L2) {
    var den = L1.u[0] * L2.u[1] - L1.u[1] * L2.u[0];
    if (Math.abs(den) < Math.sin(10 * Math.PI / 180)) return null;     /* nearly parallel: no corner */
    var t = ((L2.p[0] - L1.p[0]) * L2.u[1] - (L2.p[1] - L1.p[1]) * L2.u[0]) / den;
    return [L1.p[0] + L1.u[0] * t, L1.p[1] + L1.u[1] * t];
  }

  function project(L, p) {
    var t = (p[0] - L.p[0]) * L.u[0] + (p[1] - L.p[1]) * L.u[1];
    return [L.p[0] + L.u[0] * t, L.p[1] + L.u[1] * t];
  }

  /** Point at arc length s along a polyline, and the index of the piece it is on. */
  function pointAt(pts, s) {
    var run = 0;
    for (var i = 1; i < pts.length; i++) {
      var L = dist(pts[i], pts[i - 1]);
      if (run + L >= s) {
        var f = L > 0 ? (s - run) / L : 0;
        return { p: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f], i: i };
      }
      run += L;
    }
    return { p: pts[pts.length - 1].slice(), i: pts.length - 1 };
  }

  function polyLength(pts) {
    var L = 0;
    for (var i = 1; i < pts.length; i++) L += dist(pts[i], pts[i - 1]);
    return L;
  }

  /**
   * Trim about one wall thickness off a polyline's END and replace it with a
   * straight piece, along the clean centreline behind it, to the outline. The
   * trimmed area goes onto the new piece. Mutates pts/areas.
   */
  function trimAndExtend(pts, areas, rings, tMean) {
    var n = pts.length, run = 0, drop = 0;
    while (drop < n - 2) {
      run += dist(pts[n - 1 - drop], pts[n - 2 - drop]);
      if (run > tMean) break;
      drop++;
    }
    var carried = 0;
    for (var d = 0; d < drop; d++) { carried += areas.pop(); pts.pop(); }
    n = pts.length;
    var b = pts[n - 1], back = n - 2, run2 = 0;
    while (back > 0) {
      run2 += dist(pts[back + 1], pts[back]);
      if (run2 >= tMean) break;
      back--;
    }
    var a = pts[back], dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    var hit = len > 1e-12 ? rayHit(b, [dx / len, dy / len], rings) : null;
    if (hit && hit.s > 1e-9 && hit.s < 6 * Math.max(tMean, 1e-9)) {
      pts.push(hit.p);
      areas.push(carried);
    } else if (carried > 0) {
      areas[areas.length - 1] += carried;
    }
  }

  function rayHit(o, u, rings) {
    var best = Infinity, p0 = null;
    rings.forEach(function (ring) {
      for (var i = 0; i < ring.length; i++) {
        var p = ring[i], q = ring[(i + 1) % ring.length];
        var ex = q[0] - p[0], ey = q[1] - p[1];
        var den = u[0] * ey - u[1] * ex;
        if (Math.abs(den) < 1e-14) continue;
        var s = ((p[0] - o[0]) * ey - (p[1] - o[1]) * ex) / den;
        var w = ((p[0] - o[0]) * u[1] - (p[1] - o[1]) * u[0]) / den;
        if (s > -1e-12 && w >= -1e-9 && w <= 1 + 1e-9 && s < best) { best = s; p0 = [o[0] + u[0] * s, o[1] + u[1] * s]; }
      }
    });
    return p0 ? { p: p0, s: best } : null;
  }

  /**
   * Move each junction to the least-squares meeting point of its walls' own
   * centrelines, taken from about one to three thicknesses out. The first
   * stretch of each wall is replaced by a straight piece from the new junction,
   * carrying that stretch's area.
   */
  function sharpenJunctions(raw) {
    var ends = Object.create(null);
    raw.forEach(function (r) {
      if (r.closed) return;
      (ends[r.keys[0]] || (ends[r.keys[0]] = [])).push({ r: r, atStart: true });
      (ends[r.keys[1]] || (ends[r.keys[1]] = [])).push({ r: r, atStart: false });
    });
    Object.keys(ends).forEach(function (k) {
      var inc = ends[k];
      if (inc.length < 3) return;
      var J = inc[0].atStart ? inc[0].r.pts[0] : inc[0].r.pts[inc[0].r.pts.length - 1];
      var M = [[0, 0], [0, 0]], rhs = [0, 0], tMax = 0, used = [];
      inc.forEach(function (e) {
        var pts = e.atStart ? e.r.pts : e.r.pts.slice().reverse();
        var t = meanThickness(e.r.pts, e.r.areas);
        tMax = Math.max(tMax, t);
        var L = polyLength(pts);
        if (L < 3 * t || !(t > 0)) { used.push({ e: e, cut: 0 }); return; }
        var p1 = pointAt(pts, t).p, p2 = pointAt(pts, Math.min(3 * t, 0.6 * L)).p;
        var dx = p2[0] - p1[0], dy = p2[1] - p1[1], dl = Math.hypot(dx, dy);
        if (dl < 1e-12) { used.push({ e: e, cut: 0 }); return; }
        var u = [dx / dl, dy / dl];
        var P = [[1 - u[0] * u[0], -u[0] * u[1]], [-u[0] * u[1], 1 - u[1] * u[1]]];
        M[0][0] += P[0][0]; M[0][1] += P[0][1]; M[1][0] += P[1][0]; M[1][1] += P[1][1];
        rhs[0] += P[0][0] * p1[0] + P[0][1] * p1[1];
        rhs[1] += P[1][0] * p1[0] + P[1][1] * p1[1];
        used.push({ e: e, cut: t });
      });
      var det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
      if (Math.abs(det) < 1e-9) return;
      var X = [(rhs[0] * M[1][1] - M[0][1] * rhs[1]) / det, (M[0][0] * rhs[1] - M[1][0] * rhs[0]) / det];
      if (dist(X, J) > 2 * tMax) return;
      used.forEach(function (u) {
        var r = u.e.r;
        if (!u.e.atStart) { r.pts.reverse(); r.areas.reverse(); }
        var at = pointAt(r.pts, u.cut);
        /* pieces wholly inside the cut are merged into one straight piece X→(point at cut) */
        var merged = 0;
        for (var i = 0; i < at.i - 1; i++) merged += r.areas[i];
        var L = dist(r.pts[at.i - 1], r.pts[at.i]);
        var f = L > 0 ? dist(r.pts[at.i - 1], at.p) / L : 0;
        merged += r.areas[at.i - 1] * f;
        var rest = r.areas[at.i - 1] * (1 - f);
        var tail = r.pts.slice(at.i), tailAreas = r.areas.slice(at.i);
        if (u.cut > 0) {
          r.pts = [X, at.p].concat(tail);
          r.areas = [merged, rest].concat(tailAreas);
        } else {
          r.pts[0] = X;
        }
        if (!u.e.atStart) { r.pts.reverse(); r.areas.reverse(); }
      });
    });
  }

  /**
   * Straighten a raw centreline, square its corners, and lay the original
   * pieces' areas along the result in proportion to path length.
   */
  function finalizeWall(r) {
    var pts = r.pts, areas = r.areas;
    if (pts.length < 2) return null;
    var tm = meanThickness(pts, areas);

    if (r.closed) {
      /* start a loop in the middle of its longest straight run, so no corner
         sits on the seam */
      var k0 = G.simplifyIdx(pts, Math.max(1e-9, 0.25 * tm)), best = -1, at = 0;
      for (var s = 0; s < k0.length - 1; s++) {
        var L = dist(pts[k0[s]], pts[k0[s + 1]]);
        if (L > best) { best = L; at = Math.floor((k0[s] + k0[s + 1]) / 2); }
      }
      if (at > 0) {
        var body = pts.slice(0, -1);
        pts = body.slice(at).concat(body.slice(0, at));
        pts.push(pts[0].slice());
        areas = areas.slice(at).concat(areas.slice(0, at));
      }
    }
    pts = pts.map(function (p) { return p.slice(); });

    var keep = G.simplifyIdx(pts, Math.max(1e-9, 0.25 * tm));
    var nRun = keep.length - 1;

    /* Fit a line through the INTERIOR points of every straight run — a chordal
       axis bends diagonally into each corner, so the run's own end points are
       off the wall's centreline and a line through them is not the wall. */
    var lines = [];
    for (var s1 = 0; s1 < nRun; s1++) {
      var a0 = keep[s1], a1 = keep[s1 + 1];
      var runLen = 0;
      for (var z = a0; z < a1; z++) runLen += dist(pts[z], pts[z + 1]);
      if (runLen < 2 * tm) { lines.push(null); continue; }          /* a chamfer */
      var sel = [], acc = 0;
      for (var z2 = a0; z2 <= a1; z2++) {
        if (z2 > a0) acc += dist(pts[z2], pts[z2 - 1]);
        if (acc >= 0.75 * tm && acc <= runLen - 0.75 * tm) sel.push(pts[z2]);
      }
      if (sel.length < 2) sel = pts.slice(a0, a1 + 1);
      lines.push(fitLine(sel));
    }
    /* move each interior kept vertex to the meeting point of the lines either
       side of it (skipping over a chamfer run) */
    var closedLoop = r.closed;
    for (var kv = 0; kv <= nRun; kv++) {
      var endVertex = kv === 0 || kv === nRun;
      if (endVertex && !closedLoop) continue;
      var before = kv === 0 ? nRun - 1 : kv - 1, after = kv === nRun ? 0 : kv;
      var Lb = lines[before], La = lines[after], X = null, skip = null;
      if (!La && lines[(after + 1) % nRun] && Lb) { La = lines[(after + 1) % nRun]; skip = after; }
      if (Lb && La) X = intersect(Lb, La);
      if (!X) {
        var only = Lb || La;
        if (only) X = project(only, pts[keep[kv]]);
      }
      if (!X || dist(X, pts[keep[kv]]) > 3 * tm) continue;
      pts[keep[kv]] = X.slice();
      if (skip != null) {
        for (var q = keep[skip]; q <= keep[skip + 1]; q++) pts[q] = X.slice();
      }
      if (closedLoop && kv === 0) pts[keep[nRun]] = X.slice();
      if (closedLoop && kv === nRun) pts[keep[0]] = X.slice();
    }
    /* Open ends are NOT moved here. A junction end is shared, to the last digit,
       with the other walls that meet there (sharpenJunctions put it there), and
       sliding it onto this wall's own line would part the mesh at the joint. A
       free end was already carried along the centreline to the outline. */

    var out = [pts[keep[0]]], ts = [], carry = 0;
    for (var s2 = 0; s2 < keep.length - 1; s2++) {
      var i0 = keep[s2], i1 = keep[s2 + 1], P0 = pts[i0], P1 = pts[i1];
      var path = 0, cum = [0];
      for (var j = i0; j < i1; j++) { path += dist(pts[j + 1], pts[j]); cum.push(path); }
      for (var q2 = 0; q2 < i1 - i0; q2++) {
        carry += areas[i0 + q2];
        var f1 = path > 0 ? cum[q2 + 1] / path : (q2 + 1) / (i1 - i0);
        var to = [P0[0] + (P1[0] - P0[0]) * f1, P0[1] + (P1[1] - P0[1]) * f1];
        var segLen = dist(to, out[out.length - 1]);
        if (segLen <= 1e-9 * Math.max(1, tm)) continue;       /* carry forward */
        out.push(to);
        ts.push(carry / segLen);
        carry = 0;
      }
    }
    if (carry > 0 && ts.length) {
      ts[ts.length - 1] += carry / dist(out[out.length - 1], out[out.length - 2]);
    }
    if (out.length < 2 || !ts.length) return null;
    if (r.closed) {
      if (dist(out[0], out[out.length - 1]) < 1e-9 * Math.max(1, tm)) out.pop();
      else ts.pop();          /* a loop that failed to close: drop the stray piece */
      if (ts.length !== out.length) return null;
    }
    return { pts: out, t: ts };
  }

  /* A spacing fine enough for the thinnest wall: half the smallest distance
     from a vertex to a non-adjacent boundary edge, bounded to keep the point
     count sane. */
  function autoSpacing(rg, props) {
    var rings = [rg.outer].concat(rg.holes);
    var segs = [];
    rings.forEach(function (ring, r) {
      ring.forEach(function (p, i) { segs.push({ p: p, q: ring[(i + 1) % ring.length], r: r, i: i, n: ring.length }); });
    });
    var extent = Math.max(props.bbox.max[0] - props.bbox.min[0], props.bbox.max[1] - props.bbox.min[1]);
    var tmin = extent;
    rings.forEach(function (ring, r) {
      ring.forEach(function (p, i) {
        segs.forEach(function (s) {
          if (s.r === r && (s.i === i || (s.i + 1) % s.n === i || (i + 1) % ring.length === s.i ||
              (s.i + 1) % s.n === (i + ring.length - 1) % ring.length)) return;
          var d = distPointSeg(p, s.p, s.q);
          if (d > 1e-9 && d < tmin) tmin = d;
        });
      });
    });
    return Math.max(extent / 400, Math.min(extent / 12, tmin / 2));
  }

  function distPointSeg(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
    var t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }

  /* ---------------------------------------------------------- properties */

  /**
   * Properties of a wall model: every segment is a rectangle of its thickness
   * about its own centreline. Overlaps at junctions are counted twice, exactly
   * as the plate mesh counts them — this is the section the MESH has.
   */
  function wallProps(walls) {
    var A = 0, Sy = 0, Sz = 0, Iyy = 0, Izz = 0, Iyz = 0;
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    walls.forEach(function (w) {
      var n = w.pts.length, segs = w.closed ? n : n - 1;
      for (var i = 0; i < segs; i++) {
        var p = w.pts[i], q = w.pts[(i + 1) % n], t = w.t[i] || 0;
        var dy = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dy, dz);
        if (!(L > 0) || !(t > 0)) continue;
        var uy = dy / L, uz = dz / L, a = L * t;
        var my = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
        A += a; Sy += a * my; Sz += a * mz;
        Iyy += a * mz * mz + a * (L * L * uz * uz + t * t * uy * uy) / 12;
        Izz += a * my * my + a * (L * L * uy * uy + t * t * uz * uz) / 12;
        Iyz += a * my * mz + a * (L * L - t * t) * uy * uz / 12;
        [[p, 1], [q, 1]].forEach(function (x) {
          var ny = -uz * t / 2, nz = uy * t / 2;
          [[x[0][0] + ny, x[0][1] + nz], [x[0][0] - ny, x[0][1] - nz]].forEach(function (c) {
            lo[0] = Math.min(lo[0], c[0]); lo[1] = Math.min(lo[1], c[1]);
            hi[0] = Math.max(hi[0], c[0]); hi[1] = Math.max(hi[1], c[1]);
          });
        });
      }
    });
    if (!(A > 0)) return null;
    var cy = Sy / A, cz = Sz / A;
    return { A: A, cy: cy, cz: cz, Iyy: Iyy - A * cz * cz, Izz: Izz - A * cy * cy,
             Iyz: Iyz - A * cy * cz, bbox: { min: lo, max: hi } };
  }

  /**
   * Adjust plate thicknesses so the wall model has exactly the target area,
   * centroid and second moments.
   *
   * Every piece of plate gets its own multiplier, and the SMALLEST set of
   * changes that satisfies the conditions is taken: minimise the area-weighted
   * sum of (m - 1)² subject to
   *
   *     Σ a m = A*,  Σ a m z = 0,  Σ a m y = 0,
   *     Σ a m (z² + own) = Iyy*,   Σ a m (y² + own) = Izz*
   *
   * which is d = W⁻¹Gᵀ(GW⁻¹Gᵀ)⁻¹ r with W the piece areas. A fixed polynomial
   * in (y, z) was tried first and is not usable: on a symmetric I with five
   * wall pieces, y² and z² take the same value on every one of them and the
   * system is singular. This form has no such degeneracy — and where the
   * geometry genuinely cannot carry a condition (a single plate has no lever
   * arm across itself), that direction drops out of the pseudo-inverse and is
   * REPORTED rather than silently missed.
   *
   * The plates' own t³ terms make it slightly non-linear, so it is iterated.
   * A multiplier outside [0.5, 2] anywhere is refused: that is no longer
   * calibration, it is a different section.
   *
   * @returns {{ok, model?, reason?, range?, dropped?}}
   */
  function calibrate(model, target) {
    /* Give the solve something to work with. With one multiplier per wall piece,
       a plain I has five of them — and A, Iyy and Izz then span only two
       independent directions across its flanges, so one of them cannot be met.
       Splitting long pieces first (they are re-joined by the mesh anyway, which
       resamples to its own size) lets the thickness vary along a flange, which
       is what carries Izz. */
    model = refine(model, 8);
    var segs = [];
    model.walls.forEach(function (w, wi) {
      var n = w.pts.length, count = w.closed ? n : n - 1;
      for (var i = 0; i < count; i++) {
        var p = w.pts[i], q = w.pts[(i + 1) % n];
        var dy = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dy, dz);
        if (!(L > 0) || !(w.t[i] > 0)) continue;
        segs.push({ wi: wi, i: i, L: L, t0: w.t[i], uy: dy / L, uz: dz / L,
                    y: (p[0] + q[0]) / 2 - target.cy, z: (p[1] + q[1]) / 2 - target.cz });
      }
    });
    if (!segs.length) return { ok: false, reason: "no plates to calibrate" };
    var spreadY = 0, spreadZ = 0;
    segs.forEach(function (s) { spreadY = Math.max(spreadY, Math.abs(s.y)); spreadZ = Math.max(spreadZ, Math.abs(s.z)); });
    var hasY = spreadY > 1e-9, hasZ = spreadZ > 1e-9;

    var conds = [{ name: "A", f: function () { return 1; }, rhs: target.A }];
    if (hasZ) conds.push({ name: "cz", f: function (s) { return s.z; }, rhs: 0 });
    if (hasY) conds.push({ name: "cy", f: function (s) { return s.y; }, rhs: 0 });
    if (hasZ) conds.push({ name: "Iyy", own: true, f: function (s, t) {
      return s.z * s.z + (s.L * s.L * s.uz * s.uz + t * t * s.uy * s.uy) / 12; }, rhs: target.Iyy });
    if (hasY) conds.push({ name: "Izz", own: true, f: function (s, t) {
      return s.y * s.y + (s.L * s.L * s.uy * s.uy + t * t * s.uz * s.uz) / 12; }, rhs: target.Izz });
    var dropped = [];
    if (!hasY) dropped.push("Izz");
    if (!hasZ) dropped.push("Iyy");

    var m = segs.map(function () { return 1; });
    for (var it = 0; it < 8; it++) {
      var K = conds.length, n2 = segs.length;
      var Gm = [], r = [];
      for (var k = 0; k < K; k++) {
        var row = segs.map(function (s, q2) { return s.L * s.t0 * conds[k].f(s, s.t0 * m[q2]); });
        Gm.push(row);
        var got = 0;
        for (var q3 = 0; q3 < n2; q3++) got += row[q3] * m[q3];
        r.push(conds[k].rhs - got);
      }
      /* M = G W⁻¹ Gᵀ with W = diag(area) */
      var Mx = [], rhs2 = r.slice();
      for (var a = 0; a < K; a++) {
        Mx.push(new Array(K).fill(0));
        for (var b = 0; b < K; b++) {
          var sum = 0;
          for (var q4 = 0; q4 < n2; q4++) {
            var wgt = segs[q4].L * segs[q4].t0;
            if (wgt > 0) sum += Gm[a][q4] * Gm[b][q4] / wgt;
          }
          Mx[a][b] = sum;
        }
      }
      var lam = solvePseudo(Mx, rhs2);
      if (!lam) return { ok: false, reason: "the calibration equations could not be solved" };
      if (lam.dropped.length) lam.dropped.forEach(function (d2) {
        if (dropped.indexOf(conds[d2].name) === -1) dropped.push(conds[d2].name);
      });
      var maxStep = 0;
      for (var q5 = 0; q5 < n2; q5++) {
        var wgt2 = segs[q5].L * segs[q5].t0, d3 = 0;
        for (var k2 = 0; k2 < K; k2++) d3 += Gm[k2][q5] * lam.x[k2];
        d3 = wgt2 > 0 ? d3 / wgt2 : 0;
        m[q5] += d3;
        maxStep = Math.max(maxStep, Math.abs(d3));
      }
      if (maxStep < 1e-12) break;
    }
    var lo = Math.min.apply(null, m), hi = Math.max.apply(null, m);
    if (!(lo >= 0.5 && hi <= 2) || !isFinite(lo) || !isFinite(hi)) {
      return { ok: false, range: [lo, hi],
        reason: "matching the section would change plate thicknesses by " +
          Math.round(Math.max(1 - lo, hi - 1) * 100) + "% somewhere" };
    }
    var out = shift(model, 0, 0);
    out.walls = model.walls.map(function (w) {
      var c = {};
      Object.keys(w).forEach(function (k) { c[k] = w[k]; });
      c.t = w.t.slice();
      return c;
    });
    segs.forEach(function (s, k) { out.walls[s.wi].t[s.i] = s.t0 * m[k]; });
    out.calibrated = { range: [lo, hi], dropped: dropped };
    return { ok: true, model: out, range: [lo, hi], dropped: dropped };
  }


  /** Split wall pieces longer than (extent / parts), keeping everything else. */
  function refine(model, parts) {
    var wp = wallProps(model.walls);
    if (!wp) return model;
    var extent = Math.max(wp.bbox.max[0] - wp.bbox.min[0], wp.bbox.max[1] - wp.bbox.min[1]);
    var maxLen = extent / Math.max(1, parts);
    if (!(maxLen > 0)) return model;
    var out = shift(model, 0, 0);
    out.walls = model.walls.map(function (w) {
      var n = w.pts.length, segs = w.closed ? n : n - 1;
      var pts = [w.pts[0]], t = [], hard = [w.hard ? w.hard[0] : true];
      for (var i = 0; i < segs; i++) {
        var a = w.pts[i], b = w.pts[(i + 1) % n];
        var L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        var k = Math.max(1, Math.min(12, Math.ceil(L / maxLen - 1e-9)));
        for (var q = 1; q <= k; q++) {
          var closing = w.closed && i === segs - 1 && q === k;
          if (!closing) {
            pts.push([a[0] + (b[0] - a[0]) * q / k, a[1] + (b[1] - a[1]) * q / k]);
            hard.push(q === k ? (w.hard ? w.hard[(i + 1) % n] : true) : false);
          }
          t.push(w.t[i]);
        }
      }
      var c = {};
      Object.keys(w).forEach(function (key) { c[key] = w[key]; });
      c.pts = pts; c.t = t; c.hard = hard;
      return c;
    });
    return out;
  }

  /** Solve a symmetric system, dropping directions with no stiffness. */
  function solvePseudo(A, b) {
    var n = b.length;
    var M = A.map(function (r, i) { return r.slice().concat([b[i]]); });
    var scale = 0;
    A.forEach(function (r) { r.forEach(function (v) { scale = Math.max(scale, Math.abs(v)); }); });
    if (!(scale > 0)) return { x: new Array(n).fill(0), dropped: A.map(function (_, i) { return i; }) };
    var dropped = [], where = [];
    for (var c = 0; c < n; c++) {
      var piv = -1, best = 0;
      for (var r2 = 0; r2 < n; r2++) {
        if (where.indexOf(r2) !== -1) continue;
        if (Math.abs(M[r2][c]) > best) { best = Math.abs(M[r2][c]); piv = r2; }
      }
      if (piv < 0 || best < 1e-10 * scale) { dropped.push(c); where.push(-1); continue; }
      where.push(piv);
      for (var r3 = 0; r3 < n; r3++) {
        if (r3 === piv) continue;
        var f2 = M[r3][c] / M[piv][c];
        for (var k3 = c; k3 <= n; k3++) M[r3][k3] -= f2 * M[piv][k3];
      }
    }
    var x = new Array(n).fill(0);
    for (var c2 = 0; c2 < n; c2++) {
      var row2 = where[c2];
      if (row2 < 0) continue;
      x[c2] = M[row2][n] / M[row2][c2];
    }
    return { x: x, dropped: dropped };
  }

  function solve(A, b) {
    var n = b.length, M = A.map(function (r, i) { return r.slice().concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var piv = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-300) return null;
      var tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === c) continue;
        var f = M[r2][c] / M[c][c];
        for (var k = c; k <= n; k++) M[r2][k] -= f * M[c][k];
      }
    }
    return M.map(function (row, i) { return row[n] / row[i]; });
  }

  /** Translate a wall model (walls, regions, connectors) by (-dy, -dz). */
  function shift(model, dy, dz) {
    function m(p) { return [p[0] - dy, p[1] - dz]; }
    var out = {};
    Object.keys(model).forEach(function (k) { out[k] = model[k]; });
    out.walls = model.walls.map(function (w) {
      var c = {}; Object.keys(w).forEach(function (k) { c[k] = w[k]; });
      c.pts = w.pts.map(m); return c;
    });
    out.regions = (model.regions || []).map(function (r) {
      return { outer: r.outer.map(m), holes: (r.holes || []).map(function (h) { return h.map(m); }) };
    });
    out.connectors = (model.connectors || []).map(function (c) { return { a: m(c.a), b: m(c.b) }; });
    return out;
  }

  /** Build from a known DB/User shape code, or null if there is no exact layout. */
  function exact(code, v, opts) {
    var f = EXACT[String(code || "").toUpperCase()];
    if (!f) return null;
    var r = f(v || [], opts || {});
    if (!r) return null;
    r.method = "exact";
    r.connectors = r.connectors || [];
    return r;
  }

  var api = {
    EXACT: EXACT,
    exact: exact,
    fromRegions: fromRegions,
    wallProps: wallProps,
    calibrate: calibrate,
    shift: shift,
    wall: wall,
    octagon: octagon,
    obround: obround,
    offsetConvex: offsetConvex,
    rect: rect
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PWalls = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
