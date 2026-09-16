/* Model Report v2.10.0 — cross-section outlines.
 *
 * Pure module: no DOM, no network. Takes what /db/SECT gives for one section
 * and returns polygons in the section's own (y, z) frame, with the origin moved
 * to the geometric centroid so a renderer can draw the axes through (0, 0).
 *
 * Everything here is unit-agnostic: metres in, metres out.
 *
 * The honesty rule that governs this file
 * ---------------------------------------
 * An engineer signing a check certificate has to be able to tell a real outline
 * from a placeholder. So every result carries a `source`:
 *
 *   "polygon"  the outline came from OUTER_POLYGON — exact, drawn as supplied
 *   "vsize"    reconstructed from the shape code and vSIZE dimensions, and
 *              CHECKED against the area GEN NX published before being used.
 *              A curved shape carries a small honest difference here — a
 *              48-sided circle sits 0.29% inside a true one — and the note on
 *              the drawing quotes whatever the difference was.
 *   "psc"      reconstructed from a PSC guide curve's named dimensions, and
 *              CHECKED against the area GEN NX published before being used
 *   "stress"   the polygon through the stress points, CHECKED against the
 *              published area and found to match. On a VALUE section those
 *              points are the only geometry the API carries, and for a solid
 *              one they are literally its corners — so this is the outline,
 *              not an approximation to it.
 *   "hull"     NOT a real outline. The same envelope where it did NOT reproduce
 *              the published area — close to the real shape on a box girder,
 *              but blind to voids and re-entrant corners. Label it schematic.
 *   "bbox"     NOT a real outline. A bounding box from the stress points,
 *              to be labelled as schematic wherever it is drawn
 *
 * Use isSchematic(source) rather than testing for "bbox" — there are two
 * schematic sources, and "stress" is deliberately not one of them.
 *
 * A schematic is returned rather than a guessed profile whenever the API
 * genuinely does not carry the geometry. See notDrawableReason() for the four
 * cases, one of which is a trap: a VALUE section carries a vSIZE that does not
 * match its real area, so it must never be drawn from it.
 *
 * MIDAS IT EUROPE — manoj@midasit.com
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SectShape = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var CIRCLE_SEGMENTS = 48;   /* brief asks for >= 16; 48 keeps a 300 mm pipe smooth */
  var FILLET_SEGMENTS = 6;

  /* --- small geometry helpers -------------------------------------------- */

  function shoelaceArea(pts) {
    var a = 0;
    for (var i = 0; i < pts.length; i += 1) {
      var p = pts[i];
      var q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  }

  function shoelaceCentroid(pts) {
    var cx = 0, cy = 0, a = 0;
    for (var i = 0; i < pts.length; i += 1) {
      var p = pts[i];
      var q = pts[(i + 1) % pts.length];
      var f = p[0] * q[1] - q[0] * p[1];
      a += f;
      cx += (p[0] + q[0]) * f;
      cy += (p[1] + q[1]) * f;
    }
    a = a / 2;
    if (Math.abs(a) < 1e-15) return [0, 0];
    return [cx / (6 * a), cy / (6 * a)];
  }

  function bboxOf(pts) {
    var b = { minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    pts.forEach(function (p) {
      if (p[0] < b.minY) b.minY = p[0];
      if (p[0] > b.maxY) b.maxY = p[0];
      if (p[1] < b.minZ) b.minZ = p[1];
      if (p[1] > b.maxZ) b.maxZ = p[1];
    });
    return b;
  }

  function shift(pts, dy, dz) {
    return pts.map(function (p) { return [p[0] - dy, p[1] - dz]; });
  }

  function circle(cy, cz, r, segments) {
    var n = segments || CIRCLE_SEGMENTS;
    var out = [];
    for (var i = 0; i < n; i += 1) {
      var t = (2 * Math.PI * i) / n;
      out.push([cy + r * Math.cos(t), cz + r * Math.sin(t)]);
    }
    return out;
  }

  function rect(y0, z0, y1, z1) {
    return [[y0, z0], [y1, z0], [y1, z1], [y0, z1]];
  }

  function moved(pts, dy, dz) {
    return pts.map(function (p) { return [p[0] + dy, p[1] + dz]; });
  }

  /* A rectangle of thickness t along the segment from (y0,z0) to (y1,z1) — a
     stiffener plate, drawn at whatever angle it stands. */
  function plate(y0, z0, y1, z1, t) {
    var dy = y1 - y0, dz = z1 - z0;
    var len = Math.sqrt(dy * dy + dz * dz);
    if (!(len > 0) || !(t > 0)) return null;
    var ny = -dz / len * t / 2, nz = dy / len * t / 2;
    return [[y0 + ny, z0 + nz], [y0 - ny, z0 - nz], [y1 - ny, z1 - nz], [y1 + ny, z1 + nz]];
  }

  /* Rounds the corners of a polygon. radii[i] is the radius at pts[i] (0 =
     sharp); any corner angle, convex or re-entrant. The arc meets the two edges
     at tangent points r.tan(turn/2) back from the corner, and its centre lies r
     off the incoming edge on the side the outline turns towards — which is what
     lets one helper round the outside and the inside of a bent plate. Each
     radius is clamped so two fillets never overrun the edge they share. */
  function filletCorners(pts, radii) {
    var n = pts.length, out = [];
    function unit(a, b) {
      var dy = b[0] - a[0], dz = b[1] - a[1], l = Math.sqrt(dy * dy + dz * dz);
      return l > 0 ? [dy / l, dz / l, l] : [0, 0, 0];
    }
    for (var i = 0; i < n; i += 1) {
      var p = pts[i], prev = pts[(i + n - 1) % n], next = pts[(i + 1) % n];
      var u = unit(prev, p), w = unit(p, next);
      var r = Math.max(0, num(radii[i]));
      var cosT = Math.max(-1, Math.min(1, u[0] * w[0] + u[1] * w[1]));
      var turn = Math.acos(cosT);
      if (!(r > 0) || turn < 1e-6 || turn > Math.PI - 1e-6) { out.push(p); continue; }
      var L = r * Math.tan(turn / 2);
      var Lmax = Math.min(u[2], w[2]) / 2;
      if (L > Lmax) { r *= Lmax / L; L = Lmax; }
      var a = [p[0] - u[0] * L, p[1] - u[1] * L];
      var b = [p[0] + w[0] * L, p[1] + w[1] * L];
      var left = u[0] * w[1] - u[1] * w[0] > 0;
      var c = left ? [a[0] - u[1] * r, a[1] + u[0] * r] : [a[0] + u[1] * r, a[1] - u[0] * r];
      var a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
      var a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
      var d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      out = out.concat(arc(c[0], c[1], r, a0, a0 + d));
    }
    return out;
  }
  var filletRightAngles = filletCorners;

  /* A bent plate of thickness t along an OPEN path of points on one face of it.
     Each segment is moved t to the right of its direction of travel, and
     neighbouring moved segments are joined where they meet (a mitre), so the
     wall is t thick everywhere, sloped parts included. The outline is the path
     out and the offset path back. */
  function platePath(path, t) {
    var n = path.length;
    if (n < 2 || !(t > 0)) return null;
    var seg = [];
    for (var i = 0; i < n - 1; i += 1) {
      var dy = path[i + 1][0] - path[i][0], dz = path[i + 1][1] - path[i][1];
      var l = Math.sqrt(dy * dy + dz * dz);
      if (!(l > 0)) return null;
      seg.push({ uy: dy / l, uz: dz / l, ny: dz / l * t, nz: -dy / l * t });
    }
    var off = [];
    for (i = 0; i < n; i += 1) {
      if (i === 0 || i === n - 1) {
        var s = seg[i === 0 ? 0 : n - 2];
        off.push([path[i][0] + s.ny, path[i][1] + s.nz]);
        continue;
      }
      var s0 = seg[i - 1], s1 = seg[i];
      var p0 = [path[i][0] + s0.ny, path[i][1] + s0.nz];
      var p1 = [path[i][0] + s1.ny, path[i][1] + s1.nz];
      var det = s0.uy * (-s1.uz) - (-s1.uy) * s0.uz;
      if (Math.abs(det) < 1e-12) { off.push(p1); continue; }
      var k = ((p1[0] - p0[0]) * (-s1.uz) - (-s1.uy) * (p1[1] - p0[1])) / det;
      off.push([p0[0] + s0.uy * k, p0[1] + s0.uz * k]);
    }
    return path.concat(off.reverse());
  }

  /* A concave fillet at a re-entrant corner. (cy,cz) is the arc centre, and the
     arc sweeps from angle a0 to a1. Used where a web meets a flange. */
  function arc(cy, cz, r, a0, a1) {
    var out = [];
    for (var i = 0; i <= FILLET_SEGMENTS; i += 1) {
      var t = a0 + (a1 - a0) * (i / FILLET_SEGMENTS);
      out.push([cy + r * Math.cos(t), cz + r * Math.sin(t)]);
    }
    return out;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /* The note under a drawing is in the report language; build() runs inside
     resolve(), which sets it — see report-i18n.js. */
  function lx(key, params) {
    var I = typeof globalThis !== "undefined" ? globalThis.ReportI18n : null;
    if (I) return I.t(key, params);
    return String(key).replace(/\{(\w+)\}/g, function (m, k) {
      return params && params[k] !== undefined ? String(params[k]) : m;
    });
  }
  /* "PSC-I" is a code and reads the same in every language; "composite PSC-I
     girder" is a phrase and does not. */
  function labelOf(spec) { return lx(spec.label); }

  /* --- shape builders -----------------------------------------------------
     Each returns points in a natural frame; build() shifts to the centroid.
     The vSIZE index maps are from the MIDAS JSON manual and are asserted
     against closed-form areas by the test harness. */

  var SHAPES = {
    /* Solid rectangle: H, B */
    SB: function (v) {
      var H = num(v[0]), B = num(v[1]);
      if (H <= 0 || B <= 0) return null;
      return { outer: rect(-B / 2, 0, B / 2, H), holes: [] };
    },

    /* Solid round: D */
    SR: function (v) {
      var D = num(v[0]);
      if (D <= 0) return null;
      return { outer: circle(0, D / 2, D / 2), holes: [] };
    },

    /* Pipe: D, tw */
    P: function (v) {
      var D = num(v[0]), tw = num(v[1]);
      if (D <= 0) return null;
      var ro = D / 2;
      var ri = ro - tw;
      var holes = (tw > 0 && ri > 0) ? [circle(0, ro, ri)] : [];
      return { outer: circle(0, ro, ro), holes: holes };
    },

    /* Box: H, B, tw, tf1, C, tf2.
       tw is each web, tf1 the top flange, tf2 the bottom flange. C is the
       inner web spacing in MIDAS's own input and is not needed to draw the
       outline, so it is deliberately unused here. */
    B: function (v) {
      var H = num(v[0]), B = num(v[1]), tw = num(v[2]);
      var tf1 = num(v[3]), tf2 = num(v[5]) || num(v[3]);
      if (H <= 0 || B <= 0) return null;
      var outer = rect(-B / 2, 0, B / 2, H);
      var iy = B / 2 - tw;
      var iz0 = tf2;
      var iz1 = H - tf1;
      var holes = (tw > 0 && iy > 0 && iz1 > iz0) ? [rect(-iy, iz0, iy, iz1)] : [];
      return { outer: outer, holes: holes };
    },

    /* I / H section: H, B1, tw, tf1, B2, tf2, r1, r2.
       B1/tf1 are the TOP flange, B2/tf2 the bottom. r1 and r2 are the root
       fillets; they are approximated, which is why the area test allows 1%. */
    H: function (v) {
      var H = num(v[0]), B1 = num(v[1]), tw = num(v[2]), tf1 = num(v[3]);
      var B2 = num(v[4]) || B1, tf2 = num(v[5]) || tf1;
      /* r2 falls back to r1 the same way B2 and tf2 fall back to B1 and tf1:
         a catalogue section quotes one root radius and leaves the second slot
         zero. Drawing only the top pair of fillets left a live HEA140 1.9%
         light — almost exactly half its total fillet area. */
      var r1 = num(v[6]), r2 = num(v[7]) || num(v[6]);
      if (H <= 0 || B1 <= 0 || tw <= 0) return null;

      var zTop = H, zBotFl = tf2, zTopFl = H - tf1;
      if (zTopFl <= zBotFl) return null;
      var hw = tw / 2;

      /* Clamp fillets so they cannot exceed the web or flange they sit in. */
      var maxR = Math.min((B2 / 2 - hw), (B1 / 2 - hw), (zTopFl - zBotFl) / 2);
      if (!(maxR > 0)) { r1 = 0; r2 = 0; }
      r1 = Math.max(0, Math.min(r1, maxR));
      r2 = Math.max(0, Math.min(r2, maxR));

      /* Counter-clockwise from the bottom-left corner. Each root fillet is a
         quarter arc swept the short way round, so it curves into the corner
         rather than bulging out of it. arc() includes both endpoints, so the
         corner points themselves are not pushed separately. */
      var pts = [[-B2 / 2, 0], [B2 / 2, 0], [B2 / 2, zBotFl]];

      /* bottom-right: (hw+r2, zBotFl) -> (hw, zBotFl+r2) */
      if (r2 > 0) pts = pts.concat(arc(hw + r2, zBotFl + r2, r2, -Math.PI / 2, -Math.PI));
      else pts.push([hw, zBotFl]);

      /* top-right: (hw, zTopFl-r1) -> (hw+r1, zTopFl) */
      if (r1 > 0) pts = pts.concat(arc(hw + r1, zTopFl - r1, r1, Math.PI, Math.PI / 2));
      else pts.push([hw, zTopFl]);

      pts.push([B1 / 2, zTopFl], [B1 / 2, zTop], [-B1 / 2, zTop], [-B1 / 2, zTopFl]);

      /* top-left: (-hw-r1, zTopFl) -> (-hw, zTopFl-r1) */
      if (r1 > 0) pts = pts.concat(arc(-hw - r1, zTopFl - r1, r1, Math.PI / 2, 0));
      else pts.push([-hw, zTopFl]);

      /* bottom-left: (-hw, zBotFl+r2) -> (-hw-r2, zBotFl) */
      if (r2 > 0) pts = pts.concat(arc(-hw - r2, zBotFl + r2, r2, 0, -Math.PI / 2));
      else pts.push([-hw, zBotFl]);

      pts.push([-B2 / 2, zBotFl]);
      return { outer: pts, holes: [] };
    },

    /* Tee: H, B, tw, tf — flange on top.
       A fifth value, beyond the manual's four, is a ROOT RADIUS. No section
       read from the API carries one; only the catalogue fit below sets it, so
       that a rolled tee's fillets can be matched instead of forcing its
       thicknesses to absorb them. The same goes for L (index 4) and C (6). */
    T: function (v) {
      var H = num(v[0]), B = num(v[1]), tw = num(v[2]), tf = num(v[3]), r = num(v[4]);
      if (H <= 0 || B <= 0 || tw <= 0 || tf <= 0 || tf >= H) return null;
      var hw = tw / 2;
      var pts = [
        [-hw, 0], [hw, 0], [hw, H - tf], [B / 2, H - tf],
        [B / 2, H], [-B / 2, H], [-B / 2, H - tf], [-hw, H - tf]
      ];
      return { outer: r > 0 ? filletRightAngles(pts, [0, 0, r, 0, 0, 0, 0, r]) : pts, holes: [] };
    },

    /* Angle: H, B, tw, tf — vertical leg on the left, horizontal at the bottom.
       Optional index 4: root radius (catalogue fit only), with the usual toe
       radius of half of it at each leg tip. */
    L: function (v) {
      var H = num(v[0]), B = num(v[1]), tw = num(v[2]), tf = num(v[3]), r = num(v[4]);
      if (H <= 0 || B <= 0 || tw <= 0 || tf <= 0) return null;
      var pts = [[0, 0], [B, 0], [B, tf], [tw, tf], [tw, H], [0, H]];
      return {
        outer: r > 0 ? filletRightAngles(pts, [0, 0, Math.min(r / 2, tf), r, Math.min(r / 2, tw), 0]) : pts,
        holes: []
      };
    },

    /* Channel: H, B1, tw, tf1, B2, tf2 — opening to the right.
       Optional index 6: root radius (catalogue fit only). */
    C: function (v) {
      var H = num(v[0]), B1 = num(v[1]), tw = num(v[2]), tf1 = num(v[3]);
      var B2 = num(v[4]) || B1, tf2 = num(v[5]) || tf1, r = num(v[6]);
      if (H <= 0 || B1 <= 0 || tw <= 0) return null;
      if (tf1 + tf2 >= H) return null;
      var pts = [
        [0, 0], [B2, 0], [B2, tf2], [tw, tf2],
        [tw, H - tf1], [B1, H - tf1], [B1, H], [0, H]
      ];
      return { outer: r > 0 ? filletRightAngles(pts, [0, 0, 0, r, r, 0, 0, 0]) : pts, holes: [] };
    },

    /* --- the five below were settled READ-ONLY on a live model -------------
       Area, outer perimeter and centroid together pin each of these exactly,
       so unlike the PSC guide curves they needed no probe sections at all:
       every claim here reproduces a live section to the digit. */

    /* Double angle, back to back: H, B, t1, t2.
       Two equal angles fused at the centreline with their horizontal legs at
       the TOP — so the outline is a single hat, not two separate Ls. H is the
       vertical leg (the section depth), B the horizontal leg measured out from
       the centre, t1 the vertical leg thickness and t2 the horizontal one.
       Verified: area 4B.t2/2 + ... = 0.021681 and perimeter 1.219200 against a
       live 0.2032 x 0.2032 x 0.028702, both exact, and the centroid lands
       0.061291 below the top exactly as published. */
    "2L": function (v) {
      var H = num(v[0]), B = num(v[1]), t1 = num(v[2]), t2 = num(v[3]) || num(v[2]);
      var C = num(v[4]);
      if (H <= 0 || B <= 0 || t1 <= 0 || t2 <= 0) return null;
      if (t2 >= H || t1 >= B) return null;
      /* C is the gap between the two backs (the gusset plate). With a gap the
         two angles are separate parts, each B wide from its own back. The fused
         outline above was verified live with C = 0; the gap follows the manual's
         dimension table and is checked against the published area like any
         other rebuild. */
      if (C > 0) {
        var g = C / 2;
        var right = [[g, 0], [g + t1, 0], [g + t1, H - t2], [g + B, H - t2], [g + B, H], [g, H]];
        return { outer: right, holes: [], extras: [mirrorPts(right, true, false)] };
      }
      return {
        outer: [
          [-t1, 0], [t1, 0], [t1, H - t2], [B, H - t2], [B, H],
          [-B, H], [-B, H - t2], [-t1, H - t2]
        ],
        holes: []
      };
    },

    /* Double channel, back to back: H, B, tw, tf.
       The two webs meet on the centreline, so the outline is an I with a web
       2.tw thick and flanges 2.B wide — B is ONE channel's width, which is why
       the published Cyp equals B and not 2B. Verified: area 0.015097 and
       perimeter 1.424432 on a live 0.381 x 0.089408 x 0.013208 x 0.01651. */
    "2C": function (v) {
      var H = num(v[0]), B = num(v[1]), tw = num(v[2]), tf = num(v[3]);
      var C = num(v[4]);
      if (H <= 0 || B <= 0 || tw <= 0 || tf <= 0) return null;
      if (2 * tf >= H || tw >= B) return null;
      /* Channels back to back with a gap C between the webs: two parts. */
      if (C > 0) {
        var g = C / 2;
        var right = [[g, 0], [g + B, 0], [g + B, tf], [g + tw, tf], [g + tw, H - tf],
          [g + B, H - tf], [g + B, H], [g, H]];
        return { outer: right, holes: [], extras: [mirrorPts(right, true, false)] };
      }
      return {
        outer: [
          [-B, 0], [B, 0], [B, tf], [tw, tf], [tw, H - tf], [B, H - tf],
          [B, H], [-B, H], [-B, H - tf], [-tw, H - tf], [-tw, tf], [-B, tf]
        ],
        holes: []
      };
    },

    /* Solid octagon: H, B, c1, c2 — a rectangle with all four corners cut off
       by c1 horizontally and c2 vertically. Verified on a live 1 x 1 with
       0.2/0.2 cuts: area B.H - 2.c1.c2 = 0.920000 and perimeter 3.531371,
       both exact. */
    SOCT: function (v) {
      var H = num(v[0]), B = num(v[1]), c1 = num(v[2]), c2 = num(v[3]);
      if (H <= 0 || B <= 0) return null;
      return { outer: octagon(H, B, c1, c2), holes: [] };
    },

    /* Hollow octagon: H, B, c1, c2, t. The same outline as SOCT with a wall of
       thickness t, and the void is the outer offset INWARD by t — not a scaled
       copy, which is what makes the inner corners come out right.
       Verified on a live 0.5 x 0.5, c = 0.01, t = 0.012: the outer perimeter
       1.976569 fixes c exactly, and the published inner perimeter 1.897040 is
       then reproduced to the digit by the offset. */
    OCT: function (v) {
      var H = num(v[0]), B = num(v[1]), c1 = num(v[2]), c2 = num(v[3]);
      var t = num(v[4]);
      if (H <= 0 || B <= 0) return null;
      var outer = octagon(H, B, c1, c2);
      var inner = t > 0 ? offsetConvexInward(outer, t) : null;
      return { outer: outer, holes: inner ? [inner] : [] };
    },

    /* Composite steel plate girder: Hw, tw, B1, tf1, B2, tf2.
       This is the `I` of a SECTTYPE "COMPOSITE" section and its vSIZE order is
       NOT the rolled `H` section's — the web comes first and there are no root
       fillets, because it is a fabricated plate girder. Hw is the CLEAR web
       depth between the flanges, so the overall depth is Hw + tf1 + tf2.

       What it draws is the STEEL GIRDER, which is also what /ope/SECTPROP
       describes for these: on a live 1.5/0.011/0.36/0.022/0.46/0.025 the
       published area 0.035920, centroid 0.698674 above the soffit and outer
       perimeter 4.662000 are all reproduced exactly by the bare steel. The deck
       slab acting with it is in SECT_AFTER.SLAB and is not part of this shape —
       build() says so on the drawing for every composite section. */
    I: function (v) {
      var Hw = num(v[0]), tw = num(v[1]);
      var B1 = num(v[2]), tf1 = num(v[3]);
      var B2 = num(v[4]) || B1, tf2 = num(v[5]) || tf1;
      if (Hw <= 0 || tw <= 0 || B1 <= 0) return null;
      if (tw > B1 || tw > B2) return null;
      var hw = tw / 2;
      var zTopFl = tf2 + Hw;
      return {
        outer: [
          [-B2 / 2, 0], [B2 / 2, 0], [B2 / 2, tf2], [hw, tf2],
          [hw, zTopFl], [B1 / 2, zTopFl], [B1 / 2, zTopFl + tf1],
          [-B1 / 2, zTopFl + tf1], [-B1 / 2, zTopFl], [-hw, zTopFl],
          [-hw, tf2], [-B2 / 2, tf2]
        ],
        holes: []
      };
    },

    /* Solid track (obround / stadium): H, B. A rectangle with a semicircular
       end at each side, so the end radius is H/2 and the straight part is
       B - H long. Verified on a live 0.5 x 1.0: area 0.446350 and perimeter
       2.570796, both exact — which is what identifies it as semicircular ends
       rather than a rounded rectangle with an independent radius. */
    STRK: function (v) {
      var H = num(v[0]), B = num(v[1]);
      if (H <= 0 || B <= 0 || B < H) return null;
      var r = H / 2;
      var straight = B / 2 - r;
      var n = Math.max(6, Math.round(CIRCLE_SEGMENTS / 2));
      var pts = [];
      var i;
      /* right end, from the bottom round to the top */
      for (i = 0; i <= n; i += 1) {
        var a = -Math.PI / 2 + Math.PI * (i / n);
        pts.push([straight + r * Math.cos(a), r + r * Math.sin(a)]);
      }
      /* left end, from the top round to the bottom */
      for (i = 0; i <= n; i += 1) {
        var b = Math.PI / 2 + Math.PI * (i / n);
        pts.push([-straight + r * Math.cos(b), r + r * Math.sin(b)]);
      }
      return { outer: pts, holes: [] };
    },

    /* --- added from the dimension table in the MIDAS API manual -------------
       (db/SECT "Section Properties - DB/User", Sept 2026). The ORDER of every
       vSIZE below is the manual's. Where the geometry a name describes admits
       more than one reading, the builder returns each reading as a candidate
       and build() keeps the one that reproduces the published area, extreme
       fibres and second moments — so a guess can lose, but it cannot be drawn
       unchecked. */

    /* Inverted T-section: H, B1, B2, tw, tf. The flange is at the BOTTOM; B1
       and B2 are how far it projects beyond the web on the left and on the
       right, and H is the overall depth including tf. Read off the Section Data
       dialog: H 1, B1 0.3, B2 0.3, tw 1.2, tf 0.7 draws a 1.8 m flange 0.7 deep
       under a 1.2 m stem, exactly as the dialog's preview shows it. */
    UDT: function (v) {
      var H = num(v[0]), B1 = num(v[1]), B2 = num(v[2]), tw = num(v[3]), tf = num(v[4]);
      if (H <= 0 || tw <= 0 || tf <= 0 || tf > H) return null;
      var hw = tw / 2, yl = -hw - Math.max(0, B1), yr = hw + Math.max(0, B2);
      if (tf >= H) return { outer: rect(yl, 0, yr, H), holes: [] };
      return {
        outer: [[yl, 0], [yr, 0], [yr, tf], [hw, tf], [hw, H], [-hw, H], [-hw, tf], [yl, tf]],
        holes: []
      };
    },

    /* Track (hollow obround): H, B, t. The solid track with a wall t thick;
       the void is the same obround offset inward by t, which for this shape is
       exactly another obround (H - 2t) x (B - 2t). */
    TRK: function (v) {
      var H = num(v[0]), B = num(v[1]), t = num(v[2]);
      var outer = SHAPES.STRK([H, B]);
      if (!outer) return null;
      var hole = null;
      if (t > 0 && H - 2 * t > 0 && B - 2 * t >= H - 2 * t) {
        var inner = SHAPES.STRK([H - 2 * t, B - 2 * t]);
        if (inner) hole = moved(inner.outer, 0, t);
      }
      return { outer: outer.outer, holes: hole ? [hole] : [] };
    },

    /* Half track: H, B. From the Section Data dialog: a flat back on the left
       and one semicircular end on the right, B the overall width and the end
       radius R = H/2 (R is drawn in the dialog but is not an input). */
    HTRK: function (v) {
      var H = num(v[0]), B = num(v[1]);
      if (H <= 0 || B <= 0) return null;
      var r = H / 2;
      if (B < r) return null;
      var ls = B - r, n = Math.max(6, Math.round(CIRCLE_SEGMENTS / 2));
      var a = [[0, 0], [ls, 0]];
      for (var i = 1; i < n; i += 1) {
        var t = -Math.PI / 2 + Math.PI * (i / n);
        a.push([ls + r * Math.cos(t), r + r * Math.sin(t)]);
      }
      a.push([ls, H], [0, H]);
      return { outer: a, holes: [] };
    },

    /* R-Octagon: H, B, a, b, t1, t2, t3. From the Section Data dialog: a SOLID
       RECTANGLE B x H outside, and an octagonal void inside — the void is the
       rectangle less the walls (t1 at the sides, t2 at the top) with its
       corners cut a x b. The dialog's diagram does not label t3; it is read as
       the bottom wall, or, if that does not reproduce the published set, as
       not a wall at all (bottom = t2). Which of a and b is horizontal is also
       left to the published second moments. */
    ROCT: function (v) {
      var H = num(v[0]), B = num(v[1]), a = num(v[2]), b = num(v[3]);
      var t1 = num(v[4]), t2 = num(v[5]), t3 = num(v[6]);
      if (H <= 0 || B <= 0 || t1 <= 0 || t2 <= 0) return null;
      var outer = rect(-B / 2, 0, B / 2, H);
      var cands = [];
      [t3 > 0 ? t3 : t2, t2].forEach(function (bottom, bi) {
        [[a, b], [b, a]].forEach(function (ab, si) {
          var w = B - 2 * t1, h = H - t2 - bottom;
          if (!(w > 0) || !(h > 0)) return;
          var hole = dedupe(moved(octagon(h, w, Math.min(ab[0], w / 2), Math.min(ab[1], h / 2)), 0, bottom));
          if (hole.length >= 3) cands.push({ outer: outer, holes: [hole], reading: "bottom " + bi + " ab " + si });
        });
      });
      return cands.length ? { candidates: cands } : null;
    },

    /* Cold formed channel: H, B, tw, r, d. From the Section Data dialog: a
       lipped channel of one thickness tw, outside dimensions, opening to the
       right, lips d deep turned in, r the INSIDE bend radius at the four bends. */
    CC: function (v) {
      var H = num(v[0]), B = num(v[1]), t = num(v[2]), r = num(v[3]), d = num(v[4]);
      if (H <= 0 || B <= 0 || t <= 0 || 2 * t >= H || t >= B) return null;
      var ri = Math.max(0, r), R = ri + t;
      if (d > t) {
        return {
          outer: filletCorners(
            [[0, 0], [B, 0], [B, d], [B - t, d], [B - t, t], [t, t],
              [t, H - t], [B - t, H - t], [B - t, H - d], [B, H - d], [B, H], [0, H]],
            [R, R, 0, 0, ri, ri, ri, ri, 0, 0, R, R]),
          holes: []
        };
      }
      return {
        outer: filletCorners(
          [[0, 0], [B, 0], [B, t], [t, t], [t, H - t], [B, H - t], [B, H], [0, H]],
          [R, 0, 0, ri, ri, 0, 0, R]),
        holes: []
      };
    },

    /* Z-section: H, B, tw, r, d, th — cold formed, one thickness tw, flanges B
       wide in opposite directions, lips d deep. th is the lip angle; a lip at
       90 degrees is drawn, and the area check says whether that held.
       PROVISIONAL. */
    Z: function (v) {
      var H = num(v[0]), B = num(v[1]), t = num(v[2]), r = num(v[3]), d = num(v[4]);
      if (H <= 0 || B <= 0 || t <= 0 || 2 * t >= H || t >= B) return null;
      var ri = Math.max(0, r), R = ri + t;
      if (d > t) {
        return {
          outer: filletRightAngles(
            [[t - B, 0], [t, 0], [t, H - t], [B - t, H - t], [B - t, H - d], [B, H - d],
              [B, H], [0, H], [0, t], [2 * t - B, t], [2 * t - B, d], [t - B, d]],
            [R, R, ri, ri, 0, 0, R, R, ri, ri, 0, 0]),
          holes: []
        };
      }
      return {
        outer: filletRightAngles(
          [[t - B, 0], [t, 0], [t, H - t], [B, H - t], [B, H], [0, H], [0, t], [t - B, t]],
          [0, R, ri, 0, 0, R, ri, 0]),
        holes: []
      };
    },

    /* U-rib (trough stiffener): H, B1, B2, t, R. From the Section Data dialog:
       open at the TOP; two sloping webs and a flat bottom, all t thick; B1 the
       outside width across the top of the webs, B2 the outside width at the
       bottom (where the web faces would meet the bottom face), H the overall
       depth, R the INSIDE radius of the two bottom bends. */
    URIB: function (v) {
      var H = num(v[0]), B1 = num(v[1]), B2 = num(v[2]), t = num(v[3]), R = Math.max(0, num(v[4]));
      if (H <= 0 || B1 <= 0 || B2 <= 0 || t <= 0 || t >= H) return null;
      var a = (B1 - B2) / 2, len = Math.sqrt(a * a + H * H);
      var dirY = a / len, dirZ = H / len;
      var nY = -dirZ, nZ = dirY;                    /* inward normal of the right web */
      var p0y = B2 / 2 + nY * t, p0z = nZ * t;
      function yAt(z) { return p0y + (z - p0z) / dirZ * dirY; }
      var yBot = yAt(t), yTop = yAt(H);
      if (!(yBot > 0) || !(yTop > 0)) return null;
      return {
        outer: filletCorners(
          [[-B1 / 2, H], [-B2 / 2, 0], [B2 / 2, 0], [B1 / 2, H],
            [yTop, H], [yBot, t], [-yBot, t], [-yTop, H]],
          [0, R + t, R + t, 0, 0, R, R, 0]),
        holes: []
      };
    },

    /* Box with stiffeners: H, B, tf, tw, S1, Hr1, tr1, S2, Hr2, tr2, with the
       counts N1 (CELL_SHAPE) and N2 (CELL_TYPE). From the Section Data dialog:
       tf is the top and bottom plate, tw the side plates; set 1 is N1 plates on
       the inside of the top AND bottom plates, Hr1 high and tr1 thick; set 2 is
       N2 plates on the inside of each side plate, Hr2 high and tr2 thick. Each
       group is centred on its plate. Whether S is the pitch (centre to centre)
       or the clear gap between plates is left to the published second
       moments. */
    BSTF: function (v, s) {
      var H = num(v[0]), B = num(v[1]), tf = num(v[2]), tw = num(v[3]);
      var set1 = { S: num(v[4]), Hr: num(v[5]), tr: num(v[6]), n: s && s.cells ? num(s.cells.n1) : 0 };
      var set2 = { S: num(v[7]), Hr: num(v[8]), tr: num(v[9]), n: s && s.cells ? num(s.cells.n2) : 0 };
      if (H <= 0 || B <= 0 || tf <= 0 || tw <= 0 || 2 * tw >= B || 2 * tf >= H) return null;
      var outer = rect(-B / 2, 0, B / 2, H);
      var hole = rect(-B / 2 + tw, tf, B / 2 - tw, H - tf);
      function stiffeners(clearGap) {
        var ex = [], k;
        var p1 = set1.S + (clearGap ? set1.tr : 0), p2 = set2.S + (clearGap ? set2.tr : 0);
        for (k = 0; k < set1.n; k += 1) {
          var y = (k - (set1.n - 1) / 2) * p1;
          if (set1.Hr > 0 && set1.tr > 0) {
            ex.push(rect(y - set1.tr / 2, tf, y + set1.tr / 2, tf + set1.Hr));
            ex.push(rect(y - set1.tr / 2, H - tf - set1.Hr, y + set1.tr / 2, H - tf));
          }
        }
        for (k = 0; k < set2.n; k += 1) {
          var z = H / 2 + (k - (set2.n - 1) / 2) * p2;
          if (set2.Hr > 0 && set2.tr > 0) {
            ex.push(rect(-B / 2 + tw, z - set2.tr / 2, -B / 2 + tw + set2.Hr, z + set2.tr / 2));
            ex.push(rect(B / 2 - tw - set2.Hr, z - set2.tr / 2, B / 2 - tw, z + set2.tr / 2));
          }
        }
        return ex;
      }
      if (!(set1.n > 0) && !(set2.n > 0)) return { outer: outer, holes: [hole] };
      return {
        candidates: [
          { outer: outer, holes: [hole], extras: stiffeners(false), reading: "S centre to centre" },
          { outer: outer, holes: [hole], extras: stiffeners(true), reading: "S clear gap" }
        ]
      };
    },

    /* Pipe with stiffeners: D, tw, Hr, tr, with the count N in CELL_SHAPE.
       From the Section Data dialog: N radial plates on the INSIDE of the tube,
       Hr deep from the inner face and tr thick, evenly spaced with the first at
       the top. */
    PSTF: function (v, s) {
      var D = num(v[0]), tw = num(v[1]), Hr = num(v[2]), tr = num(v[3]);
      var n = s && s.cells ? num(s.cells.n1) : 0;
      if (D <= 0 || tw <= 0 || 2 * tw >= D) return null;
      var ro = D / 2, ri = ro - tw;
      var outer = circle(0, 0, ro), hole = circle(0, 0, ri);
      var ex = [];
      if (n > 0 && Hr > 0 && tr > 0 && Hr < ri) {
        for (var k = 0; k < n; k += 1) {
          var th = Math.PI / 2 + 2 * Math.PI * k / n;
          var c = Math.cos(th), sn = Math.sin(th);
          var p = plate((ri - Hr) * c, (ri - Hr) * sn, ri * c, ri * sn, tr);
          if (p) ex.push(p);
        }
      }
      return { outer: outer, holes: [hole], extras: ex };
    },

    /* Upright (rack upright): H, B, tw, Hw1, Hw2, B1, B2, B3, Bf3, d. From the
       Section Data dialog: one plate tw thick bent into a lipped omega — a top
       face B wide with a centred groove d deep, sides running down Hw1 from the
       top, then sloping in to short horizontal returns, and lips turned down
       Hw2 to the bottom, B3 apart across the opening; H the overall depth.
       Outside dimensions throughout. The diagram leaves three details open, so
       each is tried both ways and the published properties decide: whether B2
       is the flat bottom of the groove or runs from the groove's edge to its far
       bottom corner (with B1 from the outer edge to the groove), whether B3 is
       measured to the lips' outer or inner faces, and whether Hw2 reaches the
       underside or the top of the returns. */
    UP: function (v) {
      var H = num(v[0]), B = num(v[1]), t = num(v[2]);
      var Hw1 = num(v[3]), Hw2 = num(v[4]), B1 = num(v[5]), B2 = num(v[6]);
      var B3 = num(v[7]), Bf3 = num(v[8]), d = num(v[9]);
      if (H <= 0 || B <= 0 || t <= 0 || Hw1 <= 0 || Hw1 >= H) return null;
      var cands = [];
      [0, 1].forEach(function (grooveReading) {
        [0, 1].forEach(function (lipReading) {
          [0, 1].forEach(function (returnReading) {
            var g = B / 2 - B1;                             /* groove top half-width */
            var gb = grooveReading === 0 ? B2 / 2 : B2 - g;  /* groove bottom half-width */
            var lip = B3 / 2 + (lipReading === 0 ? 0 : t);   /* lip face on the path */
            var zr = Hw2 - (returnReading === 0 ? 0 : t);    /* return underside */
            var yr = B3 / 2 + Bf3;
            if (!(zr > 0) || !(yr < B / 2) || !(lip < yr) || H - Hw1 <= zr) return;
            var top = d > 0 && g > 0 && gb >= 0 && gb <= g
              ? [[-B / 2, H], [-g, H], [-gb, H - d], [gb, H - d], [g, H], [B / 2, H]]
              : [[-B / 2, H], [B / 2, H]];
            /* One face of the plate, clockwise from the left lip's tip: the
               material is on the right of every segment. */
            var path = [[-lip, 0], [-lip, zr], [-yr, zr], [-B / 2, H - Hw1]]
              .concat(top)
              .concat([[B / 2, H - Hw1], [yr, zr], [lip, zr], [lip, 0]]);
            var outline = platePath(dedupe(path), t);
            if (outline) {
              cands.push({ outer: outline, holes: [], reading: [grooveReading, lipReading, returnReading].join("") });
            }
          });
        });
      });
      return cands.length ? { candidates: cands } : null;
    }
  };

  function dedupe(pts) {
    var out = [];
    pts.forEach(function (p) {
      var q = out.length ? out[out.length - 1] : null;
      if (!q || Math.abs(q[0] - p[0]) > 1e-12 || Math.abs(q[1] - p[1]) > 1e-12) out.push(p);
    });
    if (out.length > 1) {
      var f = out[0], l = out[out.length - 1];
      if (Math.abs(f[0] - l[0]) < 1e-12 && Math.abs(f[1] - l[1]) < 1e-12) out.pop();
    }
    return out;
  }

  function mirrorPts(pts, my, mz) {
    var out = pts.map(function (p) { return [my ? -p[0] : p[0], mz ? -p[1] : p[1]]; });
    return (my !== mz) ? out.reverse() : out;
  }

  /* The dimension names of every DB/User shape, in vSIZE order, from the MIDAS
     API manual. Used to list a section's dimensions by name wherever it cannot
     be drawn, so the reader can check them against the Section Data dialog. */
  var DIM_NAMES = {
    L: ["H", "B", "tw", "tf"], C: ["H", "B1", "tw", "tf1", "B2", "tf2"],
    H: ["H", "B1", "tw", "tf1", "B2", "tf2", "r1", "r2"], T: ["H", "B", "tw", "tf"],
    B: ["H", "B", "tw", "tf1", "C", "tf2"], P: ["D", "tw"],
    "2L": ["H", "B", "tw", "tf", "C"], "2C": ["H", "B", "tw", "tf", "C"],
    SB: ["H", "B"], SR: ["D"], OCT: ["H", "B", "a", "b", "t"], SOCT: ["H", "B", "a", "b"],
    ROCT: ["H", "B", "a", "b", "t1", "t2", "t3"], TRK: ["H", "B", "t"], STRK: ["H", "B"],
    HTRK: ["H", "B"], CL: ["H", "B", "tw", "tf", "C"], CC: ["H", "B", "tw", "r", "d"],
    UP: ["H", "B", "tw", "Hw1", "Hw2", "B1", "B2", "B3", "Bf3", "d"],
    Z: ["H", "B", "tw", "r", "d", "th"], URIB: ["H", "B1", "B2", "t", "R"],
    BSTF: ["H", "B", "tf", "tw", "S1", "Hr1", "tr1", "S2", "Hr2", "tr2"],
    PSTF: ["D", "tw", "Hr", "tr"], UDT: ["H", "B1", "B2", "tw", "tf"]
  };

  /* The names the Section Data dialog shows for each code. */
  var SHAPE_NAMES = {
    L: "Angle", C: "Channel", H: "I-Section", T: "T-Section", B: "Box", P: "Pipe",
    "2L": "Double Angle", "2C": "Double Channel", SB: "Solid Rectangle", SR: "Solid Round",
    OCT: "Octagon", SOCT: "Solid Octagon", ROCT: "R-Octagon", TRK: "Track",
    STRK: "Solid Track", HTRK: "Half Track", CC: "Cold Formed Channel", UP: "Upright",
    Z: "Z-Section", URIB: "U-Rib", BSTF: "Box with Stiffener", PSTF: "Pipe with Stiffener",
    UDT: "Inverted T-section"
  };

  function dimsText(code, values, extraNames) {
    var names = DIM_NAMES[String(code || "").toUpperCase()];
    if (!names || !values) return "";
    names = names.concat(extraNames || []);
    var parts = [];
    names.forEach(function (name, i) {
      if (values[i] !== undefined && values[i] !== null) parts.push(name + " " + fmtDim(values[i]));
    });
    return parts.join(", ");
  }

  /* A rectangle B wide and H tall, centred on y, sitting on z = 0, with each
     corner cut off by c1 horizontally and c2 vertically. Counter-clockwise. */
  function octagon(H, B, c1, c2) {
    var hy = B / 2;
    var a = Math.max(0, Math.min(c1, hy));
    var b = Math.max(0, Math.min(c2, H / 2));
    return [
      [-hy + a, 0], [hy - a, 0], [hy, b], [hy, H - b],
      [hy - a, H], [-hy + a, H], [-hy, H - b], [-hy, b]
    ];
  }

  /* The inside of a wall of thickness t around a CONVEX counter-clockwise
     polygon: every edge moved inward along its own normal, then consecutive
     edges intersected. A scaled copy would be wrong — it moves the corners by
     a distance that depends on how far they are from the centre, whereas a
     real wall is the same thickness everywhere. Returns null if the wall eats
     the section. */
  /* `t` may also be a function (dy, dz) -> thickness of the wall along that
     edge direction, for a section whose walls are not all the same thickness. */
  function offsetConvexInward(pts, t) {
    var n = pts.length;
    var thick = typeof t === "function" ? t : function () { return t; };
    if (typeof t !== "function" && !(t > 0)) return null;
    if (n < 3) return null;
    var lines = [];
    var i;
    for (i = 0; i < n; i += 1) {
      var p = pts[i], q = pts[(i + 1) % n];
      var dy = q[0] - p[0], dz = q[1] - p[1];
      var len = Math.sqrt(dy * dy + dz * dz);
      if (len < 1e-12) return null;
      dy /= len; dz /= len;
      var te = num(thick(dy, dz));
      if (!(te > 0)) return null;
      /* Interior is to the left of each edge on a CCW ring, so the inward
         normal is the left normal. */
      lines.push([p[0] - dz * te, p[1] + dy * te, dy, dz]);
    }
    var out = [];
    for (i = 0; i < n; i += 1) {
      var a = lines[(i + n - 1) % n], b = lines[i];
      var det = a[2] * (-b[3]) - (-b[2]) * a[3];
      if (Math.abs(det) < 1e-12) return null;
      var s = ((b[0] - a[0]) * (-b[3]) - (-b[2]) * (b[1] - a[1])) / det;
      out.push([a[0] + a[2] * s, a[1] + a[3] * s]);
    }
    /* A wall thicker than the section leaves an inside-out ring. */
    if (shoelaceArea(out) >= shoelaceArea(pts)) return null;
    return out;
  }

  function implementedShapes() { return Object.keys(SHAPES); }
  function shapeName(code) { return SHAPE_NAMES[String(code || "").toUpperCase()] || ""; }

  /* --- the drawn outline's own section properties ---------------------------
     Area, centroid, second moments about the centroid, extreme-fibre distances
     and perimeters of a set of rings — computed exactly the way the published
     /ope/SECTPROP set is defined, so the two can be compared term by term:
     Iyy is the integral of z squared, Izz of y squared, Cyp/Cym and Czp/Czm the
     distances from the centroid to the extreme fibres. */

  function ringMoments(pts) {
    var a = 0, sy = 0, sz = 0, yy = 0, zz = 0, per = 0;
    for (var i = 0; i < pts.length; i += 1) {
      var p = pts[i], q = pts[(i + 1) % pts.length];
      var f = p[0] * q[1] - q[0] * p[1];
      a += f;
      sy += (p[0] + q[0]) * f;
      sz += (p[1] + q[1]) * f;
      yy += (p[0] * p[0] + p[0] * q[0] + q[0] * q[0]) * f;
      zz += (p[1] * p[1] + p[1] * q[1] + q[1] * q[1]) * f;
      per += Math.sqrt((q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]));
    }
    var sgn = a < 0 ? -1 : 1;
    return { a: sgn * a / 2, sy: sgn * sy / 6, sz: sgn * sz / 6, yy: sgn * yy / 12, zz: sgn * zz / 12, per: per };
  }

  function polyProps(outer, holes, extras) {
    var A = 0, Sy = 0, Sz = 0, Yy = 0, Zz = 0, perO = 0, perI = 0;
    var box = { minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    function add(pts, sign, isHole) {
      if (!pts || pts.length < 3) return;
      var m = ringMoments(pts);
      A += sign * m.a; Sy += sign * m.sy; Sz += sign * m.sz; Yy += sign * m.yy; Zz += sign * m.zz;
      if (isHole) perI += m.per; else perO += m.per;
      if (!isHole) {
        var b = bboxOf(pts);
        box.minY = Math.min(box.minY, b.minY); box.maxY = Math.max(box.maxY, b.maxY);
        box.minZ = Math.min(box.minZ, b.minZ); box.maxZ = Math.max(box.maxZ, b.maxZ);
      }
    }
    add(outer, 1, false);
    (holes || []).forEach(function (h) { add(h, -1, true); });
    (extras || []).forEach(function (e) { add(e, 1, false); });
    if (!(A > 0)) return null;
    var cy = Sy / A, cz = Sz / A;
    return {
      area: A,
      iyy: Zz - A * cz * cz,
      izz: Yy - A * cy * cy,
      cyp: box.maxY - cy, cym: cy - box.minY,
      czp: box.maxZ - cz, czm: cz - box.minZ,
      periO: perO, periI: perI
    };
  }

  /* Relative differences from the published set, for whatever it carries.
     The fibre distances are measured against the published width and depth,
     so an off-centre centroid scores by how far it is off, not by its size. */
  function compareToPublished(pp, pub) {
    var r = {};
    if (!pp || !pub) return r;
    function ok(v) { return typeof v === "number" && isFinite(v); }
    function rel(a, b) { return Math.abs(a - b) / Math.max(Math.abs(b), 1e-12); }
    if (ok(pub.area) && pub.area > 0) r.area = rel(pp.area, pub.area);
    if (ok(pub.cyp) && ok(pub.cym) && pub.cyp + pub.cym > 0) {
      var W = pub.cyp + pub.cym;
      r.width = rel(pp.cyp + pp.cym, W);
      r.cy = Math.abs(pp.cym - pub.cym) / W;
    }
    if (ok(pub.czp) && ok(pub.czm) && pub.czp + pub.czm > 0) {
      var D = pub.czp + pub.czm;
      r.depth = rel(pp.czp + pp.czm, D);
      r.cz = Math.abs(pp.czm - pub.czm) / D;
    }
    if (ok(pub.iyy) && pub.iyy > 0) r.iyy = rel(pp.iyy, pub.iyy);
    if (ok(pub.izz) && pub.izz > 0) r.izz = rel(pp.izz, pub.izz);
    if (ok(pub.periO) && pub.periO > 0) r.periO = rel(pp.periO, pub.periO);
    if (ok(pub.periI) && pub.periI > 0 && pp.periI > 0) r.periI = rel(pp.periI, pub.periI);
    return r;
  }

  var MATCH_WEIGHTS = { area: 4, width: 2, depth: 2, cy: 2, cz: 2, iyy: 1, izz: 1, periO: 0.5, periI: 0.5 };
  function matchScore(r) {
    var s = 0;
    Object.keys(MATCH_WEIGHTS).forEach(function (k) {
      if (r[k] !== undefined) s += MATCH_WEIGHTS[k] * r[k] * r[k];
    });
    return s;
  }

  function mirrorShape(b, my, mz) {
    return {
      outer: mirrorPts(b.outer, my, mz),
      holes: (b.holes || []).map(function (h) { return mirrorPts(h, my, mz); }),
      extras: (b.extras || []).map(function (e) { return mirrorPts(e, my, mz); }),
      reading: b.reading, mirrored: my || mz
    };
  }

  /* Every reading a builder offers, each also mirrored left-right and
     top-bottom, scored against the published set. A symmetric shape scores
     the same mirrored, and the first (as built) is kept on a tie — so this
     only ever turns an asymmetric shape round when the published extreme
     fibres say it faces the other way. */
  function resolveVsize(code, v, s) {
    var base = SHAPES[code] ? SHAPES[code](v, s) : null;
    if (!base) return null;
    var readings = base.candidates || [base];
    var pub = s.published || null;
    var best = null;
    readings.forEach(function (rd, ri) {
      [[false, false], [true, false], [false, true], [true, true]].forEach(function (m, mi) {
        var shape = mi === 0 ? rd : mirrorShape(rd, m[0], m[1]);
        var pp = polyProps(shape.outer, shape.holes, shape.extras);
        if (!pp) return;
        var r = compareToPublished(pp, pub);
        var score = matchScore(r);
        if (!best || score < best.score - 1e-12) {
          best = { shape: shape, r: r, score: score, readingIndex: ri, mirrored: mi > 0 };
        }
      });
    });
    if (best) best.multiple = readings.length > 1;
    return best;
  }

  /* --- catalogue sections ------------------------------------------------------
     A DB section reaches the plugin by name only — `vSIZE` is absent, not
     zeroed (verified live). Its published properties are complete, though, and
     for the standard steel shapes they pin the dimensions: the width and depth
     are the extreme-fibre sums, and the thicknesses (and root radius) are what
     reproduces the published area and second moments. That is solved here by a
     plain Nelder-Mead search in log space, and the result is drawn only if it
     reproduces the published set — so a catalogue shape with rounded corners
     or tapered flanges that the builder cannot represent comes out as a
     labelled schematic, not as a near miss. */

  function nelderMead(f, x0, iters) {
    var n = x0.length;
    var pts = [x0.slice()];
    for (var i = 0; i < n; i += 1) {
      var p = x0.slice();
      p[i] += 0.25;
      pts.push(p);
    }
    var vals = pts.map(f);
    for (var it = 0; it < (iters || 600); it += 1) {
      var order = vals.map(function (v, k) { return k; }).sort(function (a, b) { return vals[a] - vals[b]; });
      pts = order.map(function (k) { return pts[k]; });
      vals = order.map(function (k) { return vals[k]; });
      if (Math.abs(vals[n] - vals[0]) < 1e-14) break;
      var c = new Array(n).fill(0);
      for (i = 0; i < n; i += 1) for (var j = 0; j < n; j += 1) c[j] += pts[i][j] / n;
      var step = function (t) { return c.map(function (cj, j2) { return cj + t * (pts[n][j2] - cj); }); };
      var xr = step(-1), fr = f(xr);
      if (fr < vals[0]) {
        var xe = step(-2), fe = f(xe);
        if (fe < fr) { pts[n] = xe; vals[n] = fe; } else { pts[n] = xr; vals[n] = fr; }
      } else if (fr < vals[n - 1]) {
        pts[n] = xr; vals[n] = fr;
      } else {
        var xc = step(fr < vals[n] ? -0.5 : 0.5), fc = f(xc);
        if (fc < Math.min(fr, vals[n])) { pts[n] = xc; vals[n] = fc; }
        else {
          for (i = 1; i <= n; i += 1) {
            pts[i] = pts[i].map(function (x, j3) { return pts[0][j3] + 0.5 * (x - pts[0][j3]); });
            vals[i] = f(pts[i]);
          }
        }
      }
    }
    var bi = 0;
    for (i = 1; i <= n; i += 1) if (vals[i] < vals[bi]) bi = i;
    return { x: pts[bi], f: vals[bi] };
  }

  /* For each shape: which dimensions are free, how they make a vSIZE with the
     width W and depth D, where to start, and which published quantities they
     must reproduce. Starting values are fractions of the section size. */
  var FITS = {
    SB: { free: [], make: function (W, D) { return [D, W]; }, targets: ["area"] },
    SR: { free: [], make: function (W, D) { return [D]; }, targets: ["area"] },
    P: {
      free: ["tw"], make: function (W, D, x) { return [D, x[0]]; },
      starts: function (W, D) { return [[D * 0.05], [D * 0.15]]; }, targets: ["area", "iyy"]
    },
    B: {
      free: ["tw", "tf"], make: function (W, D, x) { return [D, W, x[0], x[1], 0, x[1]]; },
      starts: function (W, D) { return [[W * 0.05, D * 0.05], [W * 0.1, D * 0.1]]; },
      targets: ["area", "iyy", "izz"]
    },
    H: {
      free: ["tw", "tf", "r"], make: function (W, D, x) { return [D, W, x[0], x[1], W, x[1], x[2], x[2]]; },
      starts: function (W, D) { return [[W * 0.05, D * 0.07, W * 0.04], [W * 0.03, D * 0.04, W * 0.02]]; },
      targets: ["area", "iyy", "izz"]
    },
    C: {
      free: ["tw", "tf", "r"], make: function (W, D, x) { return [D, W, x[0], x[1], W, x[1], x[2]]; },
      starts: function (W, D) { return [[W * 0.08, D * 0.07, W * 0.1], [W * 0.15, D * 0.1, W * 0.05]]; },
      targets: ["area", "iyy", "izz", "cy"]
    },
    T: {
      free: ["tw", "tf", "r"], make: function (W, D, x) { return [D, W, x[0], x[1], x[2]]; },
      starts: function (W, D) { return [[W * 0.05, D * 0.08, W * 0.05], [W * 0.1, D * 0.15, W * 0.02]]; },
      targets: ["area", "iyy", "izz", "cz"]
    },
    /* Cold formed channel from a catalogue: thickness, inside bend radius and
       lip depth are free; H and B come from the extreme fibres. */
    CC: {
      free: ["tw", "r", "d"], make: function (W, D, x) { return [D, W, x[0], x[1], x[2]]; },
      starts: function (W, D) { return [[W * 0.03, W * 0.04, W * 0.25], [W * 0.05, W * 0.02, W * 0.15]]; },
      targets: ["area", "iyy", "izz", "cy"]
    },
    L: {
      free: ["tw", "tf", "r"], make: function (W, D, x) { return [D, W, x[0], x[1], x[2]]; },
      starts: function (W, D) { return [[W * 0.08, D * 0.08, W * 0.1], [W * 0.12, D * 0.12, W * 0.05]]; },
      targets: ["area", "iyy", "izz", "cy", "cz"]
    }
  };
  /* The fitted root radius has no slot in the manual's vSIZE for L, C and T,
     so it is listed under its own name. */
  var FIT_EXTRA_NAMES = { L: ["r"], C: ["r"], T: ["r"] };

  function fitCatalogue(s) {
    var code = String(s.shape || "").toUpperCase();
    var spec = FITS[code], pub = s.published;
    if (!spec || !pub || !(pub.area > 0)) return null;
    var W = num(pub.cyp) + num(pub.cym), D = num(pub.czp) + num(pub.czm);
    if (!(W > 0) || !(D > 0)) return null;

    function shapeFor(x) {
      var b = SHAPES[code](spec.make(W, D, x), s);
      return b && !b.candidates ? b : null;
    }
    /* Orientation is not a dimension: the residual takes the better of the
       shape and its mirror images for the centroid terms. */
    function residual(x) {
      var b = shapeFor(x);
      if (!b) return 1e9;
      var pp = polyProps(b.outer, b.holes, b.extras);
      if (!pp) return 1e9;
      var bestTerm = Infinity;
      [[false, false], [true, false], [false, true], [true, true]].forEach(function (m) {
        var q = {
          area: pp.area, iyy: pp.iyy, izz: pp.izz,
          cyp: m[0] ? pp.cym : pp.cyp, cym: m[0] ? pp.cyp : pp.cym,
          czp: m[1] ? pp.czm : pp.czp, czm: m[1] ? pp.czp : pp.czm
        };
        var r = compareToPublished(q, pub), sum = 0;
        spec.targets.forEach(function (k) { if (r[k] !== undefined) sum += r[k] * r[k]; });
        bestTerm = Math.min(bestTerm, sum);
      });
      return bestTerm;
    }

    var x = [];
    if (spec.free.length) {
      var best = null;
      spec.starts(W, D).forEach(function (st) {
        var res = nelderMead(function (u) {
          return residual(u.map(function (ui) { return Math.exp(ui); }));
        }, st.map(function (v) { return Math.log(Math.max(v, 1e-9)); }), 800);
        if (!best || res.f < best.f) best = res;
      });
      x = best.x.map(function (ui) { return Math.exp(ui); });
    }
    var v = spec.make(W, D, x);
    var picked = resolveVsize(code, v, s);
    if (!picked) return null;
    var r = picked.r;
    var ok = r.area !== undefined && r.area <= 0.01 &&
      (r.iyy === undefined || spec.targets.indexOf("iyy") < 0 || r.iyy <= 0.03) &&
      (r.izz === undefined || spec.targets.indexOf("izz") < 0 || r.izz <= 0.03) &&
      (r.cy === undefined || r.cy <= 0.02) && (r.cz === undefined || r.cz <= 0.02);
    return { ok: ok, shape: picked.shape, values: v, r: r, code: code };
  }

  function pct(v) { return v === undefined ? "—" : (v * 100).toFixed(2) + "%"; }
  function checksText(r) {
    var out = [];
    if (r.area !== undefined) out.push("A " + pct(r.area));
    if (r.iyy !== undefined) out.push("Iyy " + pct(r.iyy));
    if (r.izz !== undefined) out.push("Izz " + pct(r.izz));
    return out.join(", ");
  }

  /* --- PSC guide curves -----------------------------------------------------
     A PSC section that carries no OUTER_POLYGON is not undrawable: it is
     defined parametrically, by the named dimensions of the shape's "guide
     curve" — the diagram GEN NX shows in its PSC Viewer. Those dimensions
     arrive in SECT_I as vSIZE_PSC_A / _B / _C / _D rather than as a plain
     vSIZE, and the split between the four arrays is by side and direction, not
     by anything you would guess:

       _A  H1 and the LEFT vertical chain, top to bottom
       _B  the LEFT horizontal chain
       _C  the RIGHT vertical chain (no H1 — the depth is shared)
       _D  the RIGHT horizontal chain

     This mapping is not from the manual. It was established by pairing a live
     model's JSON against the dimension table GEN NX prints for the same
     section, name for name, value for value.

     The horizontal dimensions are HALF-WIDTHS FROM THE SECTION CENTRELINE, not
     offsets accumulated outward from the web. That was the one genuine
     ambiguity in the diagram, and it is settled by the same section's stress
     points: an "Inner Gird T1" with BL2 = BR2 = 262.5 reports a stress-point
     width of 525 mm, which is 2 x 262.5 and not 2 x (137.5 + 262.5).

     Everything built here is still checked against the published area before it
     is used — see build(). A reconstruction that does not reproduce the area
     GEN NX computed is not drawn, whatever the dimensions say. */

  /* The role of the four arrays is SHAPE-DEPENDENT and there is no way to
     infer it — PSC-I splits them left/right, the box girders split them
     outer/inner. Each entry below records which, because getting it wrong is
     silent: the arrays are all just numbers.

     One more thing the diagrams show and the numbers confirm, and it differs
     between the two families: the OUTER horizontal dimensions of a box girder
     are a CHAIN (BO1 + BO2 + BO3 = the half width, drawn end to end along the
     soffit), while the INNER ones are ABSOLUTE half widths from the centreline
     (BI1, BI3 and their -2 partners, drawn nested from the centre). PSC-I's are
     absolute throughout. */

  var PSC_KEYS = {
    /* PSC-I. The vertical chain runs top flange, top haunch, web, bottom
       haunch, bottom flange; the -1 and -2 entries subdivide the haunches for
       a stepped profile and are zero on a plain one.

       Note the code: `CI` is what a section of SECTTYPE COMPOSITE reports — a
       precast girder acting with a deck slab. The standalone PSC version of the
       same dialog reports `PSCI`, registered below against this same mapping. */
    CI: {
      label: "PSC-I",
      a: ["H1", "HL1", "HL2", "HL2-1", "HL2-2", "HL3", "HL4", "HL4-1", "HL4-2", "HL5"],
      b: ["BL1", "BL2", "BL2-1", "BL2-2", "BL4", "BL4-1", "BL4-2"],
      c: ["HR1", "HR2", "HR2-1", "HR2-2", "HR3", "HR4", "HR4-1", "HR4-2", "HR5"],
      d: ["BR1", "BR2", "BR2-1", "BR2-2", "BR4", "BR4-1", "BR4-2"],
      sides: "left/right",
      build: buildPscI
    },

    /* PSC-1CELL. Here A/B are the OUTER chains and C/D the INNER ones — not
       left and right. Confirmed by SECT_BEFORE.JOINT being eight flags,
       JO1..JO3 then JI1..JI5, and by sum(A) == sum(C) == the section depth on
       all 52 sections of a live model.

       Verified against the dimension dialog for section "PSC1", name for name,
       and then against the published area of every one of those 52 sections:
       worst error 0.000005%. */
    "1CEL": {
      label: "PSC-1CELL",
      a: ["HO1", "HO2", "HO2-1", "HO2-2", "HO3", "HO3-1"],
      b: ["BO1", "BO1-1", "BO1-2", "BO2", "BO2-1", "BO3"],
      c: ["HI1", "HI2", "HI2-1", "HI2-2", "HI3", "HI3-1", "HI4", "HI4-1", "HI4-2", "HI5"],
      d: ["BI1", "BI1-1", "BI1-2", "BI2-1", "BI3", "BI3-1", "BI3-2", "BI4"],
      sides: "outer/inner",
      build: function (d, j) { return buildPscCellBox(d, j, 1); }
    },

    /* PSC-2CELL. The same dimension set as 1CEL, down to the array lengths —
       GEN NX offers both behind one entry in its section dropdown and a "1
       Cell / 2 Cell" radio. Switching that radio changes exactly two things
       over the API: SHAPE becomes "2CEL", and BI4 (the last slot of _D, which
       is zero on every 1CEL) becomes the HALF-thickness of the central web.

       Verified by toggling it on a live section: area went 8.485750 ->
       9.361750, a difference of 0.876, which is 2 x BI4 x the clear void height
       of 2.19 exactly. Half, not full — consistent with every other BI value
       being a half-width from the centreline. */
    "2CEL": {
      label: "PSC-2CELL",
      a: ["HO1", "HO2", "HO2-1", "HO2-2", "HO3", "HO3-1"],
      b: ["BO1", "BO1-1", "BO1-2", "BO2", "BO2-1", "BO3"],
      c: ["HI1", "HI2", "HI2-1", "HI2-2", "HI3", "HI3-1", "HI4", "HI4-1", "HI4-2", "HI5"],
      d: ["BI1", "BI1-1", "BI1-2", "BI2-1", "BI3", "BI3-1", "BI3-2", "BI4"],
      sides: "outer/inner",
      build: function (d, j) { return buildPscCellBox(d, j, 2); }
    },

    /* PSC-MID. The dialog is a PSC-I's with one field removed — there is no
       BL4/BR4, because a MID section's soffit is dimensioned by BL2 — and one
       group added: a **Cell Type per side**, which arrives as PSC_OPT1 (left)
       and PSC_OPT2 (right). Reading those is not optional: they decide the
       shape of that half outright, and a reader that ignores them is wrong by
       about 12% on a half that has no cell.

       Only "POLYGON" means anything. "NONE", "RECTANGLE", "TAPERED" and the
       empty string all behave identically (no cell); "CIRCLE" is rejected by
       GEN NX outright. Verified by writing all 36 pairs.

       The two states of a half:
         no cell   the half is a plain PENTAGON side — a vertical face BL2 wide
                   and HL1 tall standing on the soffit, closed to the centre
                   apex at H1. Every other vertical dimension is INERT, which is
                   the giveaway: on a live sweep HL2..HL5, BL1 and all six
                   subdivisions moved neither the area, the width nor the depth.
         POLYGON   the half is an ordinary PSC-I chain with BL2 serving as the
                   soffit width, subdivisions, joints and all.

       Verified live and exactly: solid 3.3800, one cell 3.0475, two cells
       2.7150 on the same dimensions — one cell being the exact average of the
       other two is what proves the halves are independent. The PSC-MID this was
       worked out for (left NONE, right POLYGON) rebuilds to 2.2879 m2 against a
       published 2.2879 m2. */
    PSCM: {
      label: "PSC-MID",
      a: ["H1", "HL1", "HL2", "HL2-1", "HL2-2", "HL3", "HL4", "HL4-1", "HL4-2", "HL5"],
      b: ["BL1", "BL2", "BL2-1", "BL2-2", "BL4-1", "BL4-2"],
      c: ["HR1", "HR2", "HR2-1", "HR2-2", "HR3", "HR4", "HR4-1", "HR4-2", "HR5"],
      d: ["BR1", "BR2", "BR2-1", "BR2-2", "BR4-1", "BR4-2"],
      sides: "left/right",
      needsCells: true,
      build: function (d, j, cells) { return buildPscMid(d, j, cells); }
    },

    /* PSC-TEE. The array layout here is the surprise, and it could not have
       been guessed: unlike every other PSC family, a PSC-TEE MIXES HEIGHTS AND
       WIDTHS IN THE SAME ARRAY. _A carries H1, the three plain heights and then
       the four plain widths; _B carries all eight subdivisions, heights first.
       Established on a live model by perturbing each slot in turn — the slots
       that moved the overall width were _A[4..6], which no reading of "_A is
       the vertical chain" can explain.

       The widths are a CHAIN out from the centreline: BL1 + BL2 + BL3 is the
       half width at the flange tip, and BL4 is the half width of the flange's
       TOP surface, which is narrower. Verified against the stress points and
       against the published width of 33 live sections, all exact. */
    PSCT: {
      label: "PSC-TEE",
      a: ["H1", "HL1", "HL2", "HL3", "BL1", "BL2", "BL3", "BL4"],
      /* Note the width order: the four subdivision HEIGHTS run 2-1, 2-2, 3-1,
         3-2, but the four subdivision WIDTHS run 3-1, 3-2, 2-1, 2-2. That is
         not a typo and it is not guessable — it was read off which slot GEN
         NX accepts alongside which JOINT flag, since writing a joint with its
         own dimension zero is rejected. */
      b: ["HL2-1", "HL2-2", "HL3-1", "HL3-2", "BL3-1", "BL3-2", "BL2-1", "BL2-2"],
      c: ["HR1", "HR2", "HR3", "BR1", "BR2", "BR3", "BR4"],
      d: ["HR2-1", "HR2-2", "HR3-1", "HR3-2", "BR3-1", "BR3-2", "BR2-1", "BR2-2"],
      sides: "left/right",
      build: function (d, j) { return buildPscTee(d, j); }
    }
  };

  /* The standalone PSC-I. `CI` above is the COMPOSITE one — that is the code a
     precast girder acting with a deck slab reports, and it is what every model
     probed so far happened to contain. A plain PSC section drawn with the same
     dialog reports `PSCI`, which no version before this one recognised, so the
     report said "this version cannot yet rebuild PSCI" about a shape it has
     been able to draw all along.

     The two carry identical guide curves: verified against the MIDAS Python library's own
     serialiser, which writes vSIZE_PSC_A..D for a PSCI section in exactly the
     order mapped here — A = H1 then HL1..HL5 with subdivisions, B = BL1, BL2,
     BL2-1, BL2-2, BL4, BL4-1, BL4-2, and C/D the same for the right side. */
  PSC_KEYS.PSCI = {
    label: "PSC-I",
    a: PSC_KEYS.CI.a, b: PSC_KEYS.CI.b, c: PSC_KEYS.CI.c, d: PSC_KEYS.CI.d,
    sides: PSC_KEYS.CI.sides,
    build: PSC_KEYS.CI.build
  };

  /* GEN NX has not been observed emitting these spellings, but the cost of
     accepting one that never arrives is nothing and the cost of missing the
     real code is a section the report refuses to draw. */
  PSC_KEYS.PSCMID = PSC_KEYS.PSCM;
  PSC_KEYS.MID = PSC_KEYS.PSCM;
  PSC_KEYS.PSCTEE = PSC_KEYS.PSCT;
  PSC_KEYS.TEE = PSC_KEYS.PSCT;

  /* A COMPOSITE PSC-I. SECT_BEFORE describes the precast girder and its guide
     curve is an ordinary PSC-I one — same four arrays, same lengths, same
     names, verified on a live deck where sum(HL1..HL5) reproduces H1 exactly.
     The deck slab acting with it lives in SECT_AFTER and is not part of this
     outline; the girder elevation adds it, and the area gate here is checked
     against the girder part, which is what SECT_BEFORE's own STIFF reports. */
  PSC_KEYS.CPCI = {
    label: "composite PSC-I girder",
    a: PSC_KEYS.CI.a, b: PSC_KEYS.CI.b, c: PSC_KEYS.CI.c, d: PSC_KEYS.CI.d,
    sides: PSC_KEYS.CI.sides,
    build: PSC_KEYS.CI.build
  };

  /* PSC-1CELL: half the box, mirrored. The outer runs from the centreline out
     along the deck to the tip, down the cantilever underside, down the web and
     back along the soffit; the void is a separate chain subtracted from it.

     `joints` is SECT_BEFORE.JOINT — [JO1, JO2, JO3, JI1..JI5] — and says which
     intermediate points are switched on. Where it is absent a non-zero offset
     is taken to mean the same thing, which is what the live model shows. */
  function buildPscCellBox(d, joints, cells) {
    var j = joints || [];
    function on(i, value) {
      return (j.length > i ? j[i] === true : true) && num(value) > 0;
    }

    /* The depth is the sum of the outer chain, which is an invariant that held
       on every section tested — safer than adding three named entries and
       hoping the sub-entries are not part of the total. */
    var depth = 0;
    PSC_KEYS["1CEL"].a.forEach(function (n) { depth += num(d[n]); });

    var yTip = num(d.BO1) + num(d.BO2) + num(d.BO3);
    var yRoot = num(d.BO2) + num(d.BO3);
    var ySoffit = num(d.BO3);
    if (!(depth > 0) || !(yTip > 0)) return null;

    var zTipUnder = num(d.HO1);
    var zJ1 = zTipUnder + num(d["HO2-1"]);
    var zJ2 = zJ1 + num(d["HO2-2"]);
    var zRoot = num(d.HO1) + num(d.HO2) + num(d["HO2-1"]) + num(d["HO2-2"]);
    var zJ3 = zRoot + num(d["HO3-1"]);

    var outer = [[0, 0], [yTip, 0], [yTip, zTipUnder]];
    if (on(0, d["BO1-1"])) outer.push([yTip - num(d["BO1-1"]), zJ1]);
    if (on(1, d["BO1-2"])) outer.push([yTip - num(d["BO1-2"]), zJ2]);
    outer.push([yRoot, zRoot]);
    if (on(2, d["BO2-1"])) outer.push([ySoffit + num(d["BO2-1"]), zJ3]);
    outer.push([ySoffit, depth], [0, depth]);

    /* The void, as a chain of half widths down the section. */
    var zvTop = num(d.HI1);
    var zvUpper = zvTop + num(d.HI2) + num(d["HI2-1"]) + num(d["HI2-2"]);
    var zvLower = zvUpper + num(d.HI3) + num(d["HI3-1"]);
    var zvBot = depth - num(d.HI5);
    var wTop = num(d["BI1-2"]) > 0 ? num(d["BI1-2"]) : num(d.BI1);
    var wBot = num(d["BI3-2"]) > 0 ? num(d["BI3-2"]) : num(d.BI3);

    var holes = [];
    if (zvBot > zvTop && num(d.BI1) > 0 && num(d.BI3) > 0) {
      var right = [[wTop, zvTop], [num(d.BI1), zvUpper], [num(d.BI3), zvLower], [wBot, zvBot]];

      /* BI4 is the half-thickness of the central web. On a two-cell box it
         splits the void in two; on a single-cell box it is zero and the two
         halves join into one ring across the centreline. */
      var web = cells >= 2 ? num(d.BI4) : 0;

      if (web > 0) {
        holes.push(cellRing(right, web, depth));
        holes.push(mirrorRing(cellRing(right, web, depth)));
      } else {
        var ring = right.slice();
        for (var i = right.length - 1; i >= 0; i -= 1) ring.push([-right[i][0], right[i][1]]);
        holes.push(ring.map(function (p) { return [p[0], depth - p[1]]; }));
      }
    }

    /* Mirror the outer half, and flip z so it points up like every other
       shape in this file. */
    var full = [];
    outer.forEach(function (p) { full.push([p[0], depth - p[1]]); });
    for (var k = outer.length - 1; k >= 0; k -= 1) {
      if (Math.abs(outer[k][0]) < 1e-12) continue;   /* skip the centreline points */
      full.push([-outer[k][0], depth - outer[k][1]]);
    }
    return { outer: full, holes: holes };
  }

  function implementedPscShapes() { return Object.keys(PSC_KEYS); }

  /* The length of each of the four arrays, which is what identifies a guide
     curve when the shape code does not. */
  function signatureOf(spec) {
    return [spec.a.length, spec.b.length, spec.c.length, spec.d.length];
  }

  /* The one family whose signature these arrays match, or null where none does
     or more than one does. Entries that are aliases of each other — PSCI, CI
     and CPCI all build a PSC-I — count once; 1CEL and 2CEL share a signature
     but build different shapes, so they correctly match nothing. */
  function matchPscBySignature(arrays) {
    if (!arrays) return null;
    var got = ["a", "b", "c", "d"].map(function (k) {
      return Array.isArray(arrays[k]) ? arrays[k].length : 0;
    }).join();
    var hits = [];
    Object.keys(PSC_KEYS).forEach(function (k) {
      if (signatureOf(PSC_KEYS[k]).join() !== got) return;
      var seen = hits.some(function (h) { return PSC_KEYS[h].build === PSC_KEYS[k].build; });
      if (!seen) hits.push(k);
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /* The named dimensions as a sentence, for the case where the outline has been
     withheld. "The mapping is unknown" is a dead end for the reader; the same
     section's dimensions, named, is something they can check against the
     Section Data dialog in front of them. */
  function pscDimSentence(shape, dims) {
    var spec = PSC_KEYS[String(shape || "").toUpperCase()];
    if (!spec || !dims) return "";
    var parts = [];
    ["a", "b", "c", "d"].forEach(function (k) {
      spec[k].forEach(function (name) {
        if (num(dims[name]) !== 0) parts.push(name + " " + fmtDim(dims[name]));
      });
    });
    if (!parts.length) return "";
    return " " + lx("The dimensions it reports, read as a {label}, are: {dims}.", {
      label: labelOf(spec), dims: parts.join(", ")
    });
  }

  function fmtDim(v) {
    var n = num(v);
    return String(Math.round(n * 1e6) / 1e6);
  }

  /* Turns the four arrays into a name -> number map, so the builders read like
     the dimension table an engineer is looking at. */
  function pscDimsOf(shape, arrays) {
    var spec = PSC_KEYS[String(shape || "").toUpperCase()];
    if (!spec || !arrays) return null;
    var out = {};
    var ok = false;
    [["a", spec.a], ["b", spec.b], ["c", spec.c], ["d", spec.d]].forEach(function (pair) {
      var list = arrays[pair[0]];
      if (!Array.isArray(list)) return;
      ok = true;
      pair[1].forEach(function (name, i) {
        out[name] = i < list.length ? num(list[i]) : 0;
      });
    });
    return ok ? out : null;
  }

  /* --- PSC-I, measured rather than assumed ---------------------------------
     Everything below was settled against a live GEN NX on 2026-08-26 by
     writing sections over the API and reading back what /ope/SECTPROP computed
     for them — first one perturbation per dimension about a real section, then
     a designed ladder from a clean symmetric baseline. It reproduces the
     published area of 48 live PSC-I sections to 0.000%. Four of these rules
     were wrong in v2.6.0 and earlier, and each was wrong in the direction that
     makes a girder look BIGGER than it is:

     1. H1 IS NOT THE SECTION DEPTH. It is the depth at the CENTRELINE — the J1
        joint the dialog draws as a short arrow at the top centre. The section
        depth is max(H1, left chain, right chain), and the two sides are aligned
        at the SOFFIT, not at the top. Verified: a section with chains of 2.50
        and 2.52 and H1 = 2.45 reports a depth of 2.52 with both bottom stress
        points level and the left top 0.02 below the right.
     2. Where H1 differs from the side chains the top surface is not flat: it
        runs straight from each flange tip to the centre point at H1, giving a
        crown where H1 is greater and a valley where it is less. Verified to the
        square millimetre: raising H1 by 0.5 on a section 2.0 wide added exactly
        0.5 m2, which is the two triangles.
     3. THE -1 AND -2 HAUNCH WIDTHS ARE INSETS FROM THEIR FLANGE TIP, not
        absolute half widths: the half width at the step is B2 - B2-k on the top
        and B4 - B4-k on the bottom. Reading them as absolute overstates a
        girder by tens of percent.
     4. Their heights are ABSOLUTE from the flange end of the haunch, not
        cumulative down it — HL2-k measured DOWN from the flange soffit, HL4-k
        measured UP from the top of the soffit. So -1 is always the point
        nearest its own flange.

     One more thing the API enforces and the reader must honour: a sub-point
     only exists when its JOINT flag is on. JOINT is [J1, JL1..JL4, JR1..JR4],
     and the pairing is JL1 -> 2-1, JL2 -> 2-2, JL3 -> 4-2, JL4 -> 4-1 (the
     joints are numbered down the section, so on the bottom haunch, which is
     traversed downward, the -2 point comes first). Writing a section with a
     joint on and its dimension zero is rejected outright by GEN NX, which is
     how the pairing was established.

     `opts.bottomKey` names the dimension carrying the soffit half width: "4"
     on a PSC-I, which dimensions its two flanges independently. */
  function pscISide(d, p, joints, opts) {
    var H = function (k) { return num(d["H" + p + k]); };
    var B = function (k) { return num(d["B" + p + k]); };
    var j = joints || [];
    var bottomKey = (opts && opts.bottomKey) || "4";

    var bTop = B(2);                       /* half width at the flange tip */
    var bWeb = B(1);                       /* half width at the web face   */
    var bBot = B(bottomKey);               /* half width at the soffit     */

    /* A joint whose flag is absent is treated as on, so a payload that omits
       JOINT still draws; a flag that is present is obeyed. */
    var on = function (i, value) {
      return (j.length > i ? j[i] === true : true) && num(value) > 0;
    };

    var pts = [];
    pts.push([bTop, 0]);                                   /* top of tip      */
    pts.push([bTop, H(1)]);                                /* bottom of tip   */

    /* Top haunch: steps at their own depth below the flange soffit, sorted so
       the outline stays monotonic whichever order the dialog was filled in. */
    var top = [];
    if (on(0, d["H" + p + "2-1"])) top.push([H("2-1"), bTop - B("2-1")]);
    if (on(1, d["H" + p + "2-2"])) top.push([H("2-2"), bTop - B("2-2")]);
    top.sort(function (a, b) { return a[0] - b[0]; });
    top.forEach(function (s) { pts.push([s[1], H(1) + s[0]]); });

    pts.push([bWeb, H(1) + H(2)]);                         /* top of the web  */
    var zWeb = H(1) + H(2) + H(3);
    pts.push([bWeb, zWeb]);                                /* foot of the web */

    /* Bottom haunch: steps measured UP from the top of the soffit, so the
       larger offset is encountered first going down. */
    var bot = [];
    if (on(2, d["H" + p + "4-2"])) bot.push([H("4-2"), bBot - B("4-2")]);
    if (on(3, d["H" + p + "4-1"])) bot.push([H("4-1"), bBot - B("4-1")]);
    bot.sort(function (a, b) { return b[0] - a[0]; });
    bot.forEach(function (s) { pts.push([s[1], zWeb + H(4) - s[0]]); });

    pts.push([bBot, zWeb + H(4)]);                         /* top of the soffit */
    pts.push([bBot, zWeb + H(4) + H(5)]);                  /* soffit            */
    return pts;
  }

  function pscIChain(d, p) {
    return num(d["H" + p + "1"]) + num(d["H" + p + "2"]) + num(d["H" + p + "3"]) +
      num(d["H" + p + "4"]) + num(d["H" + p + "5"]);
  }

  function buildPscI(d, joints, opts) {
    var j = joints || [];
    var sumL = pscIChain(d, "L");
    var sumR = pscIChain(d, "R");
    var H1 = num(d.H1);
    if (!(sumL > 0) || !(sumR > 0)) return null;
    /* H1 = 0 means "no centre point": the top is flat between the flange tips. */
    var crown = H1 > 0 ? H1 : 0;
    return assembleSides(
      Math.max(crown, sumL, sumR), sumL, sumR, crown,
      pscISide(d, "L", [j[1], j[2], j[3], j[4]], opts),
      pscISide(d, "R", [j[5], j[6], j[7], j[8]], opts));
  }

  /* The left chain down and the right chain back up, closed, with both sides
     standing on a common soffit and the top closed through the centre point.
     Each side is given as [halfWidth, depth below THAT SIDE's own top]; z is
     flipped here so it points up like every other shape in this file. */
  function assembleSides(depth, sumL, sumR, crown, left, right) {
    if (!left || !right || !left.length || !right.length) return null;

    var outer = [];
    left.forEach(function (p) { outer.push([-p[0], sumL - p[1]]); });
    for (var i = right.length - 1; i >= 0; i -= 1) {
      outer.push([right[i][0], sumR - right[i][1]]);
    }
    /* The centre point closes the top. It is only a vertex when it is off the
       line between the two flange tips — on a section whose chains and H1 agree
       it would be collinear and adds nothing. */
    if (crown > 0 && (Math.abs(crown - sumL) > 1e-12 || Math.abs(crown - sumR) > 1e-12)) {
      outer.push([0, crown]);
    }
    /* Degenerate dimensions (all zero, or a width of nothing) are rejected
       rather than drawn as a line. */
    var wide = false, tall = false;
    outer.forEach(function (p) {
      if (Math.abs(p[0]) > 1e-9) wide = true;
      if (Math.abs(p[1]) > 1e-9) tall = true;
    });
    if (!wide || !tall) return null;
    return { outer: outer, holes: [] };
  }

  /* One side of a PSC-TEE, top down, in the same [halfWidth, drop] form as
     pscISide. Three vertical segments — flange (HL1), haunch (HL2) and stem
     (HL3) — and four widths that CHAIN outward from the centreline.

     Verified on a live model, exactly: a plain PSC-TEE with HL1/HL2/HL3 =
     0.3/0.2/1.5 and BL1..BL4 = 0.2/0.3/1.0/1.4 reports an area of 2.3200, a
     width of 3.000 = 2(BL1+BL2+BL3) and a depth of 2.000, and the outline
     below reproduces all three to the digit. Widening BL2 to 0.5 gives 2.7600
     and this gives 2.7600.

     Two things the shape does that a T-beam sketch would not suggest: the
     flange's top surface (BL4) is NARROWER than its tip (BL1+BL2+BL3), so the
     outer face slopes; and the stem tapers from BL1+BL2 at the haunch down to
     BL1 at the soffit rather than running parallel.

     The four sub-points are two on the haunch and two on the stem, and THE TWO
     GROUPS USE OPPOSITE WIDTH CONVENTIONS:

       JL1, JL2 — on the haunch. Depth HL2-k measured DOWN from the flange
                  soffit; half width is bTip - BL2-k, an INSET from the tip.
       JL3, JL4 — on the stem. Height HL3-k measured UP from the soffit; half
                  width is BL1 + BL3-k, an OUTSET from the stem face.

     Verified live, to 0.000%, on both conventions across three values each, on
     two points of the same group together, and finally on the whole thing: the
     PSC-TEE this was worked out for rebuilds to 2.136800 m2 against a published
     2.136800 m2. */
  function pscTeeSide(d, p, joints) {
    var H = function (k) { return num(d["H" + p + k]); };
    var B = function (k) { return num(d["B" + p + k]); };
    var j = joints || [];
    var on = function (i, value) {
      return (j.length > i ? j[i] === true : true) && num(value) > 0;
    };

    var bStem = B(1);                              /* half width of the stem  */
    var bMid = B(1) + B(2);                        /* stem top / haunch foot  */
    var bTip = B(1) + B(2) + B(3);                 /* flange tip — the widest */
    var bTop = B(4);                               /* flange TOP surface      */
    if (!(bTip > 0) || !(bStem > 0)) return [];

    var pts = [];
    pts.push([bTop, 0]);                                   /* top surface    */
    pts.push([bTip, H(1)]);                                /* flange tip     */

    /* Both groups are taken in NAME order, -1 then -2, and deliberately not
       sorted by position. On a section entered through the dialog the two agree
       — -1 is the point nearer its flange — but where a payload sets HL2-1
       deeper than HL2-2, GEN NX keeps the named order and computes the area
       of the resulting self-crossing outline. Sorting instead cost 1.6% on such
       a section; following the names costs 0.0%. */
    if (on(0, d["H" + p + "2-1"])) pts.push([bTip - B("2-1"), H(1) + H("2-1")]);
    if (on(1, d["H" + p + "2-2"])) pts.push([bTip - B("2-2"), H(1) + H("2-2")]);

    pts.push([bMid, H(1) + H(2)]);                         /* top of stem    */

    var zBot = H(1) + H(2) + H(3);
    if (on(2, d["H" + p + "3-1"])) pts.push([bStem + B("3-1"), zBot - H("3-1")]);
    if (on(3, d["H" + p + "3-2"])) pts.push([bStem + B("3-2"), zBot - H("3-2")]);

    pts.push([bStem, zBot]);                               /* soffit         */
    return pts;
  }

  /* One side of a PSC-MID that carries no cell: a vertical face BL2 wide and
     HL1 tall standing on the soffit. The apex at H1 closes it in
     assembleSides(), which is what makes the half a pentagon. */
  function pscMidPlainSide(d, p) {
    var b = num(d["B" + p + "2"]);
    var h = num(d["H" + p + "1"]);
    if (!(b > 0) || !(h > 0)) return [];
    return [[b, 0], [b, h]];
  }

  function isCell(value) {
    return String(value === undefined || value === null ? "" : value)
      .toUpperCase() === "POLYGON";
  }

  function buildPscMid(d, joints, cells) {
    var j = joints || [];
    var c = cells || [];
    var polyL = isCell(c[0]);            /* PSC_OPT1 is the LEFT half  */
    var polyR = isCell(c[1]);            /* PSC_OPT2 is the RIGHT half */

    var sumL = polyL ? pscIChain(d, "L") : num(d.HL1);
    var sumR = polyR ? pscIChain(d, "R") : num(d.HR1);
    if (!(sumL > 0) || !(sumR > 0)) return null;

    var crown = num(d.H1) > 0 ? num(d.H1) : 0;
    return assembleSides(
      Math.max(crown, sumL, sumR), sumL, sumR, crown,
      polyL ? pscISide(d, "L", [j[1], j[2], j[3], j[4]], { bottomKey: "2" })
        : pscMidPlainSide(d, "L"),
      polyR ? pscISide(d, "R", [j[5], j[6], j[7], j[8]], { bottomKey: "2" })
        : pscMidPlainSide(d, "R"));
  }

  function pscTeeChain(d, p) {
    return num(d["H" + p + "1"]) + num(d["H" + p + "2"]) + num(d["H" + p + "3"]);
  }

  function buildPscTee(d, joints) {
    var j = joints || [];
    var sumL = pscTeeChain(d, "L");
    var sumR = pscTeeChain(d, "R");
    if (!(sumL > 0) || !(sumR > 0)) return null;
    var crown = num(d.H1) > 0 ? num(d.H1) : 0;
    return assembleSides(
      Math.max(crown, sumL, sumR), sumL, sumR, crown,
      pscTeeSide(d, "L", [j[1], j[2], j[3], j[4]]),
      pscTeeSide(d, "R", [j[5], j[6], j[7], j[8]]));
  }

  /* One cell of a two-cell box: down the outer face of the void, then back up
     the face of the central web. `profile` is [[halfWidth, zDown], ...] and the
     result is in the z-up frame. */
  function cellRing(profile, web, depth) {
    var ring = [];
    profile.forEach(function (p) { ring.push([Math.max(p[0], web), depth - p[1]]); });
    for (var i = profile.length - 1; i >= 0; i -= 1) {
      ring.push([web, depth - profile[i][1]]);
    }
    return ring;
  }

  function mirrorRing(ring) {
    var out = [];
    for (var i = ring.length - 1; i >= 0; i -= 1) out.push([-ring[i][0], ring[i][1]]);
    return out;
  }

  /* --- convex hull of the stress points ------------------------------------
     The fallback when nothing else is available. SECTPROP reports a stress
     point at each governing corner, and on a box girder there are ten of them
     tracing the real envelope — far more informative than the bounding
     rectangle that used to be drawn. It is still an ENVELOPE, not the outline:
     it cannot show a void, a haunch that curves inward, or any re-entrant
     corner, so it stays labelled as a schematic. */

  function convexHull(points) {
    var pts = (points || []).filter(function (p) {
      return p && isFinite(p[0]) && isFinite(p[1]);
    }).slice();
    if (pts.length < 3) return null;

    pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });

    /* Drop exact duplicates, which otherwise create zero-length edges. */
    var uniq = [pts[0]];
    for (var i = 1; i < pts.length; i += 1) {
      var last = uniq[uniq.length - 1];
      if (Math.abs(pts[i][0] - last[0]) > 1e-12 || Math.abs(pts[i][1] - last[1]) > 1e-12) {
        uniq.push(pts[i]);
      }
    }
    if (uniq.length < 3) return null;

    function cross(o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }

    var lower = [];
    for (var l = 0; l < uniq.length; l += 1) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], uniq[l]) <= 0) {
        lower.pop();
      }
      lower.push(uniq[l]);
    }
    var upper = [];
    for (var u = uniq.length - 1; u >= 0; u -= 1) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], uniq[u]) <= 0) {
        upper.pop();
      }
      upper.push(uniq[u]);
    }
    lower.pop();
    upper.pop();
    var hull = lower.concat(upper);
    return hull.length >= 3 ? hull : null;
  }

  function stressPolygon(sp) {
    if (!sp || !sp.y || !sp.z) return null;
    var pts = [];
    var n = Math.min(sp.y.length, sp.z.length);
    for (var i = 0; i < n; i += 1) {
      if (isFinite(sp.y[i]) && isFinite(sp.z[i])) pts.push([sp.y[i], sp.z[i]]);
    }
    /* Four points is a rectangle's corners and the hull adds nothing over the
       bounding box, so it is left to the existing path. */
    return pts.length >= 5 ? convexHull(pts) : null;
  }

  /* --- why a section cannot be drawn -------------------------------------- */

  /* Returns a human sentence when the API does not carry real geometry, or null
     when it does. These four cases are verified behaviour, not guesses. */
  function notDrawableReason(spec) {
    var type = String(spec.secttype || "").toUpperCase();
    var shape = String(spec.shape || "").toUpperCase();

    if (type === "VALUE" || type === "PSCVALUE") {
      /* Verified on a live model: a VALUE section reports a vSIZE that does NOT
         match its own area — "Pile cap- internal" gives 1.8 x 1.0 = 1.80 m2
         against a real area of 1.25 m2. Drawing it would produce a confident,
         plausible and wrong outline, so it never is. */
      return lx("This is a value-type section: its properties are entered directly, " +
        "and the dimensions the API reports for it do not describe the real shape.");
    }
    if (Number(spec.datatype) === 1 && !hasDimensions(spec.vSize)) {
      return lx("This section comes from a steel catalogue. The API returns its " +
        "catalogue name but not its dimensions, so it cannot be drawn to scale.");
    }
    /* Checked BEFORE the vSIZE test: a guide-curve PSC section has no vSIZE at
       all, so the generic "no dimensions" message would fire first and hide the
       fact that its dimensions are right there, merely unmapped. */
    if (spec.pscDims && !PSC_KEYS[shape] && !matchPscBySignature(spec.pscDims)) {
      var counts = ["a", "b", "c", "d"].map(function (k) {
        return Array.isArray(spec.pscDims[k]) ? spec.pscDims[k].length : 0;
      });
      return lx("This is a PSC section whose guide curve “{shape}” this version cannot " +
        "yet rebuild. Its dimensions are present ({counts} values across vSIZE_PSC_A to _D) " +
        "but that signature matches no guide curve this version knows, so the mapping from " +
        "those arrays to the named dimensions of this particular shape has not been " +
        "established, and guessing it would produce a confident, wrong drawing. " +
        "Sending those four arrays and a screenshot of this section's Section " +
        "Data dialog is enough to add it.", { shape: spec.shape || "?", counts: counts.join("/") });
    }
    if (!spec.vSize || !spec.vSize.length) {
      return lx("The API returned no dimensions for this section.");
    }
    if (!SHAPES[shape]) {
      return lx("Shape code “{shape}” is not one this version can draw.", { shape: spec.shape || "?" }) +
        dimsSentence(shape, spec.vSize);
    }
    return null;
  }

  function hasDimensions(v) {
    return Array.isArray(v) && v.some(function (x) { return num(x) > 0; });
  }

  /* " The dimensions it reports are: H 1, B1 0.3, ..." — empty when the shape's
     names are not known. */
  function dimsSentence(code, values) {
    var t = dimsText(code, values);
    return t ? " " + lx("The dimensions it reports are: {dims}.", { dims: t }) : "";
  }

  /* --- the entry point ----------------------------------------------------- */

  /* How far a reconstruction may sit from the area GEN NX published before it
     is thrown away. Fillets and faceted circles cost a fraction of a percent;
     a misread dimension convention costs tens of percent. 2% separates them
     comfortably. */
  var AREA_TOLERANCE = 0.02;

  /* spec = {
       secttype, shape, datatype,
       vSize:    [..],                        // SECT_I.vSIZE
       pscDims:  {a,b,c,d} | null,            // SECT_I.vSIZE_PSC_A.._D
       polygon:  [[y,z],..] | null,           // from OUTER_POLYGON
       holes:    [[[y,z],..]] | null,
       pscJoints: [bool x8] | null,           // SECT_BEFORE.JOINT
       stressPoints: { y:[n], z:[n] } | null, // SECTPROP y1..yN / z1..zN
       publishedArea: number | null           // the area to check a rebuild against
     } */
  function build(spec) {
    var s = spec || {};

    /* 1. An outline supplied by GEN NX always wins. PSC and composite
          sections carry one, and it is exact — verified by shoelace against the
          published area to better than 0.3% on a live model.

          Composite sections are the exception worth stating on the drawing: the
          supplied OUTER_POLYGON describes only the FIRST (pre-composite) part,
          typically the precast girder. The deck slab acting with it is in the
          section's property set but not in the outline, so an unqualified
          drawing would understate the section by about a third. Verified: "Y2
          composite" draws 0.327 m2 against a composite area of 0.515 m2. */
    /* 0. A general composite (CP_G) is a SET of regions, not one ring: the
          plates of a fabricated box and the slab acting with them. qc-core has
          already turned SECT_I's vertex pool and LINE connectivity into real
          rings — see generalRegions() there for why the pool must never be
          read as a boundary. Each region's own published area is what checked
          that reading, so nothing here is a guess. */
    if (s.regions && s.regions.rings && s.regions.rings.length) {
      var rr = s.regions.rings;
      var made = rr.length === 1 ? lx("region") : lx("{n} regions", { n: rr.length });
      return finish(rr[0], [], "polygon",
        lx("Outline as supplied by GEN NX, assembled from the section's {made}", { made: made }) +
        (s.regions.plates
          ? " — " + lx("{n} of them plates of the given thickness, " +
          "drawn on the line model GEN NX stores for this section rather than " +
          "on its vertex list, which is a pool and not a boundary.", { n: s.regions.plates })
          : ".") ,
        null, rr.slice(1));
    }

    if (s.polygon && s.polygon.length >= 3) {
      return finishWith(s, s.polygon, s.holes || [], "polygon",
        s.isComposite && !hasSlab(s)
          ? lx("Outline as supplied by GEN NX. This is a composite section and " +
          "the outline shows the girder part only — the deck slab acting with " +
          "it is included in the properties but is not part of this shape.")
          : lx("Outline as supplied by GEN NX."));
    }

    /* 2. A PSC section with no supplied outline is still fully defined, by the
          named dimensions of its guide curve. Rebuild it, then check the
          rebuild against the area GEN NX published: a shape that does not
          reproduce its own area has been read wrongly and is not drawn. */
    var pscShape = String(s.shape || "").toUpperCase();
    /* A shape code this version does not know by name is not the end of it. The
       four arrays have a length signature — 10/7/9/7 for a PSC-I, 10/6/9/6 for a
       PSC-MID — and where exactly one known family matches, that mapping is
       worth trying. It is not a guess in the way the old area-fitting was: the
       rebuild still has to reproduce the published area before it is drawn, so
       a wrong match is caught rather than published. Codes that share a
       signature (1CEL and 2CEL) match nothing and fall through. */
    var pscKey = PSC_KEYS[pscShape] ? pscShape : matchPscBySignature(s.pscDims);
    if (pscKey && s.pscDims) {
      var spec = PSC_KEYS[pscKey];
      var dims = pscDimsOf(pscKey, s.pscDims);
      var psc = dims ? spec.build(dims, s.pscJoints, s.pscCells) : null;
      if (psc) {
        var check = areaCheck(psc.outer, psc.holes, s.publishedArea);
        var byName = pscKey === pscShape
          ? ""
          : " " + lx("Shape code “{shape}” is not one this version knows by name, but its " +
          "dimension arrays match a {label} exactly ({sig} values) and the rebuild reproduces " +
          "the published area, so it has been drawn as one.", {
            shape: s.shape || "?", label: labelOf(spec), sig: signatureOf(spec).join("/")
          });
        if (check.ok) {
          return finishWith(s, psc.outer, psc.holes, "psc",
            (check.checked
              ? lx("Outline reconstructed from the section's {label} guide-curve dimensions, " +
                "and checked against the area GEN NX computed ({pct}% difference).", {
                  label: labelOf(spec), pct: check.errorPct.toFixed(2)
                })
              : lx("Outline reconstructed from the section's {label} guide-curve dimensions. " +
                "No published area was available to check it against.", { label: labelOf(spec) })) + byName);
        }
        /* Fall through to the schematic, saying exactly why — and listing the
           dimensions by name, which is the part a reader can actually act on
           when the outline has been withheld. */
        s = shallowCopy(s);
        s.rebuildRejected =
          lx("A {label} outline was reconstructed from this section's dimensions but " +
          "discarded: its area came out {pct}% away from the area GEN NX computed, " +
          "so the dimensions were not read correctly and the drawing would have " +
          "been wrong.", { label: labelOf(spec), pct: check.errorPct.toFixed(1) }) +
          pscDimSentence(pscKey, dims);
      }
    }

    /* 3. Otherwise reconstruct from the shape code, but only where that is
          honest — and to the same standard as a guide-curve rebuild. A vSIZE
          shape is defined by which slot of the array carries which dimension,
          and reading that ordering wrongly fails exactly the way a misread PSC
          convention does: silently, into a plausible drawing. So the same area
          gate applies. Verified that the two sides of the comparison are in
          the same units on this path as on the PSC one: a live SB section of
          vSIZE [1.8, 8.1] publishes Area = 14.580000 m2. */
    /* 2b. A catalogue (DB) section: no dimensions over the API, so they are
           fitted to the published properties and drawn only if the fit holds. */
    var catalogueNote = "";
    if (Number(s.datatype) === 1 && !hasDimensions(s.vSize) && !s.rebuildRejected) {
      var fit = fitCatalogue(s);
      var catName = [s.dbName, s.dbSection].filter(Boolean).join(" ");
      if (fit && fit.ok) {
        return finishWith(s, fit.shape.outer, fit.shape.holes, "fit",
          lx("Catalogue section {name}. The API passes a catalogue section by name only, " +
            "without its dimensions, so they were fitted to the properties GEN NX " +
            "published: {dims}. Differences from the published values: {checks}.", {
              name: catName || fit.code, dims: dimsText(fit.code, fit.values, FIT_EXTRA_NAMES[fit.code]),
              checks: checksText(fit.r)
            }), null, fit.shape.extras);
      }
      if (fit) {
        catalogueNote = " " + lx("Its dimensions could not be fitted to the published " +
          "properties closely enough to draw it ({checks}).", { checks: checksText(fit.r) });
      }
    }

    var why = s.rebuildRejected || notDrawableReason(s);
    if (why && catalogueNote) why += catalogueNote;
    if (!s.rebuildRejected && !why) {
      var code = String(s.shape).toUpperCase();
      var picked = resolveVsize(code, s.vSize, s);
      var built = picked ? picked.shape : null;
      if (built) {
        var vcheck = areaCheck(built.outer, built.holes, s.publishedArea, built.extras);
        /* A shape with more than one reading must also land on the published
           width and depth: two readings can share an area and still be
           different sections. */
        var r = picked.r || {};
        var fits = vcheck.ok && (!picked.multiple ||
          (vcheck.checked && r.width !== undefined && r.depth !== undefined &&
            r.width <= AREA_TOLERANCE && r.depth <= AREA_TOLERANCE));
        if (fits) {
          var extra = "";
          if (picked.multiple) {
            extra += " " + lx("Where the dimensions admit more than one reading, the one that " +
              "reproduces the published area, extreme fibres and second moments was drawn.");
          }
          if (picked.mirrored) {
            extra += " " + lx("Drawn mirrored, so that it matches the published extreme-fibre distances.");
          }
          return finishWith(s, built.outer, built.holes, "vsize",
            (vcheck.checked
              ? lx("Outline reconstructed from the section's {code} dimensions, and checked " +
                "against the area GEN NX computed ({pct}% difference).", {
                  code: code, pct: vcheck.errorPct.toFixed(2)
                })
              : lx("Outline reconstructed from the section's {code} dimensions. " +
                "No published area was available to check it against.", { code: code })) + extra,
            null, built.extras);
        }
        why = (vcheck.ok
          ? lx("An outline was reconstructed from this section's {code} dimensions but " +
            "discarded: no reading of them reproduces the published width and depth, so " +
            "the drawing would have been wrong.", { code: code })
          : lx("An outline was reconstructed from this section's {code} dimensions " +
            "but discarded: its area came out {pct}% away " +
            "from the area GEN NX computed, so the dimensions were not read " +
            "correctly and the drawing would have been wrong.", {
              code: code, pct: vcheck.errorPct.toFixed(1)
            })) + dimsSentence(code, s.vSize);
      } else {
        why = lx("The dimensions for this section are incomplete or inconsistent.") +
          dimsSentence(code, s.vSize);
      }
    }

    /* 4. The envelope through the stress points. On a box girder GEN NX
          reports ten of them and the hull traces the real outer shape, which is
          a great deal more use than a rectangle — but it is still an envelope
          and is labelled as one. */
    var hull = stressPolygon(s.stressPoints);
    if (hull) {
      var n = Math.min(s.stressPoints.y.length, s.stressPoints.z.length);
      /* AN ENVELOPE THAT REPRODUCES THE PUBLISHED AREA IS NOT A GUESS.
         On a VALUE section the stress points are the only geometry the API
         carries, and for a solid one they are its four corners: on twelve of
         them in the model this was written against — the pile caps and the
         abutment sections — the rectangle through the points comes out at the
         published area and the published perimeter exactly. Calling that
         SCHEMATIC undersold it and put a red banner over a correct drawing.

         The gate is the same one every rebuilt shape passes. A box girder's
         ten points hull to more than its area, because the hull cannot know
         about the void, so those stay labelled as the envelopes they are. */
      var hullCheck = areaCheck(hull, [], s.publishedArea);
      if (hullCheck.checked && hullCheck.ok) {
        return finish(hull, [], "stress",
          lx("Outline taken from the {n} stress points GEN NX reports for " +
          "this section — the only geometry the API carries for it — and checked " +
          "against the area GEN NX computed ({pct}% difference). The points themselves " +
          "are marked on the drawing.", { n: n, pct: hullCheck.errorPct.toFixed(2) }) +
          (why ? " " + why : ""), pointsOf(s.stressPoints));
      }
      return finish(hull, [], "hull", (why ? why + " " : "") +
        (hullCheck.checked
          ? lx("The outline below is the envelope through the {n} stress points GEN NX " +
            "reports for it, which follows the real shape but cannot show a void or any " +
            "inward-curving face — it encloses {pct}% more than the area GEN NX computed. " +
            "The points themselves are marked on the drawing.", {
              n: n, pct: hullCheck.errorPct.toFixed(1)
            })
          : lx("The outline below is the envelope through the {n} stress points GEN NX " +
            "reports for it, which follows the real shape but cannot show a void or any " +
            "inward-curving face. The points themselves are marked on the drawing.", { n: n })),
        pointsOf(s.stressPoints));
    }

    /* 5. The stress-point bounding box. Same rule as the hull above: where it
          reproduces the published area it is not a fallback at all. FOUR stress
          points on a solid section ARE its corners — stressPolygon() hands this
          case straight here because a hull of four points is the box — so the
          rectangle through them is the section, and on the twelve VALUE
          sections of the model this was written against it matches the
          published area and the published perimeter exactly. They used to carry
          a red SCHEMATIC banner over a correct drawing. */
    var box = boxFromStressPoints(s.stressPoints);
    if (box) {
      var boxCheck = areaCheck(box, [], s.publishedArea);
      var pts = Math.min(s.stressPoints.y.length, s.stressPoints.z.length);
      if (boxCheck.checked && boxCheck.ok) {
        return finish(box, [], "stress",
          lx("Outline taken from the {n} stress points GEN NX reports for " +
          "this section — the only geometry the API carries for it — and checked " +
          "against the area GEN NX computed ({pct}% difference). The points themselves " +
          "are marked on the drawing.", { n: pts, pct: boxCheck.errorPct.toFixed(2) }) +
          (why ? " " + why : ""), pointsOf(s.stressPoints));
      }
      return finish(box, [], "bbox", why, pointsOf(s.stressPoints));
    }
    return {
      ok: false, source: "none", note: why,
      outer: [], holes: [], markers: [], area: 0, centroid: [0, 0],
      bbox: { minY: 0, maxY: 0, minZ: 0, maxZ: 0 }
    };
  }

  function pointsOf(sp) {
    if (!sp || !sp.y || !sp.z) return [];
    var out = [];
    var n = Math.min(sp.y.length, sp.z.length);
    for (var i = 0; i < n; i += 1) {
      if (isFinite(sp.y[i]) && isFinite(sp.z[i])) out.push([sp.y[i], sp.z[i]]);
    }
    return out;
  }

  function shallowCopy(o) {
    var out = {};
    Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; });
    return out;
  }

  /* The gate that stops a misread dimension convention reaching a drawing. */
  function areaCheck(outer, holes, publishedArea, extras) {
    var a = shoelaceArea(outer);
    (holes || []).forEach(function (h) { a -= shoelaceArea(h); });
    (extras || []).forEach(function (e) { a += shoelaceArea(e); });
    var p = Number(publishedArea);
    if (!(p > 0)) return { ok: true, checked: false, errorPct: 0, area: a };
    var err = Math.abs(a - p) / p;
    return { ok: err <= AREA_TOLERANCE, checked: true, errorPct: err * 100, area: a };
  }

  function boxFromStressPoints(sp) {
    if (!sp || !sp.y || !sp.z || sp.y.length < 2) return null;
    var ys = sp.y.filter(function (v) { return isFinite(v); });
    var zs = sp.z.filter(function (v) { return isFinite(v); });
    if (!ys.length || !zs.length) return null;
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var minZ = Math.min.apply(null, zs), maxZ = Math.max.apply(null, zs);
    if (!(maxY > minY) || !(maxZ > minZ)) return null;
    return rect(minY, minZ, maxY, maxZ);
  }

  /* Move everything so the origin sits on the geometric centroid, which is
     where the renderer draws the axes. Holes are subtracted from both the area
     and the centroid, so a box section reports the centroid of its walls. */
  function hasSlab(s) {
    return !!(s && s.slab && num(s.slab.thickness) > 0);
  }

  /* The deck slab that acts with a composite girder, as extra filled regions in
     the girder's OWN frame (finish() shifts everything to the centroid
     afterwards): a haunch block the width of the girder's top, then the slab.

     It is drawn but deliberately NOT part of what the area gate checks, because
     on a composite steel girder /ope/SECTPROP publishes the BARE STEEL —
     verified on a live model, where the area, the centroid and the perimeter
     all reproduce from the girder alone. Gating the girder and adding the slab
     afterwards is the only order that keeps both the check and the drawing
     honest. */
  function slabRings(outer, slab) {
    if (!slab || !(num(slab.thickness) > 0) || !outer || !outer.length) return null;
    var b = bboxOf(outer);
    var top = b.maxZ;

    /* The girder's width where the slab meets it, so the haunch sits on the top
       flange instead of floating out at the full slab width. */
    var atTop = [];
    outer.forEach(function (p) {
      if (Math.abs(p[1] - top) < 1e-9) atTop.push(p[0]);
    });
    var gy0 = atTop.length ? Math.min.apply(Math, atTop) : b.minY;
    var gy1 = atTop.length ? Math.max.apply(Math, atTop) : b.maxY;

    var out = [];
    var z = top;
    var haunch = num(slab.haunch);
    if (haunch > 0 && gy1 > gy0) {
      out.push(rect(gy0, z, gy1, z + haunch));
      z += haunch;
    }
    var half = num(slab.width) / 2;
    if (!(half > 0)) half = Math.max(Math.abs(b.minY), Math.abs(b.maxY));
    var mid = (gy0 + gy1) / 2;
    out.push(rect(mid - half, z, mid + half, z + num(slab.thickness)));
    return out;
  }

  /* `parts` are further filled regions that belong to the section itself — the
     second angle of a gapped double angle, a stiffener plate. They are drawn
     and counted exactly like the slab rings, but do not make it a deck slab. */
  function finishWith(s, outer, holes, source, note, markers, parts) {
    var rings = slabRings(outer, s.slab);
    var out;
    if (rings && rings.length) {
      note += " " + (num(s.slab.haunch) > 0
        ? lx("The deck slab acting with the girder is drawn on top of it, from the " +
          "section's own slab data — {w} wide by {t} thick on a {h} haunch.", {
            w: fmtDim(s.slab.width), t: fmtDim(s.slab.thickness), h: fmtDim(s.slab.haunch)
          })
        : lx("The deck slab acting with the girder is drawn on top of it, from the " +
          "section's own slab data — {w} wide by {t} thick.", {
            w: fmtDim(s.slab.width), t: fmtDim(s.slab.thickness)
          })) + " " +
        lx("Any percentage quoted above compares the GIRDER against the area " +
        "GEN NX publishes for this section, which is the girder alone; the " +
        "outline drawn includes the slab. Both are dimensioned: the girder's " +
        "depth and the finished depth on the right, the slab's depth on the " +
        "left, and across the bottom the soffit and the overall width.");
    }
    out = finish(outer, holes, source, note, markers, (parts || []).concat(rings || []));
    /* Says that `outer` is a girder and the extras are a deck slab on top of
       it — which a drawing needs before it can dimension the two separately.
       It is NOT true of every shape with extras: a COMPOSITE-GEN's extras are
       further parts of the same section, and its `outer` is only the first of
       them, so calling that one "the girder" would dimension a 0.02 m plate as
       the depth of a 2.59 m box. */
    if (rings && rings.length) {
      out.deckSlab = {
        width: num(s.slab.width), thickness: num(s.slab.thickness),
        haunch: num(s.slab.haunch), rings: rings.length
      };
    }
    return out;
  }

  /* `extras` are further FILLED regions drawn alongside the outer ring and not
     inside it: the plates of a fabricated box, or the deck slab sitting on top
     of a composite girder. They are part of the section, so they count towards
     the area, the centroid and the bounding box — a slab left out of the bbox
     would be drawn off the edge of the frame. */
  function finish(outer, holes, source, note, markers, extras) {
    var aOuter = shoelaceArea(outer);
    var cOuter = shoelaceCentroid(outer);
    var netA = aOuter;
    var mY = cOuter[0] * aOuter;
    var mZ = cOuter[1] * aOuter;

    (holes || []).forEach(function (h) {
      var ah = shoelaceArea(h);
      var ch = shoelaceCentroid(h);
      netA -= ah;
      mY -= ch[0] * ah;
      mZ -= ch[1] * ah;
    });

    (extras || []).forEach(function (r) {
      var ar = shoelaceArea(r);
      var cr = shoelaceCentroid(r);
      netA += ar;
      mY += cr[0] * ar;
      mZ += cr[1] * ar;
    });

    var cy = netA > 1e-15 ? mY / netA : cOuter[0];
    var cz = netA > 1e-15 ? mZ / netA : cOuter[1];

    var o = shift(outer, cy, cz);
    var hs = (holes || []).map(function (h) { return shift(h, cy, cz); });
    var ex = (extras || []).map(function (r) { return shift(r, cy, cz); });

    var box = bboxOf(o);
    ex.forEach(function (r) {
      var b = bboxOf(r);
      if (b.minY < box.minY) box.minY = b.minY;
      if (b.maxY > box.maxY) box.maxY = b.maxY;
      if (b.minZ < box.minZ) box.minZ = b.minZ;
      if (b.maxZ > box.maxZ) box.maxZ = b.maxZ;
    });

    return {
      ok: true,
      source: source,
      note: note,
      outer: o,
      holes: hs,
      extras: ex,
      /* The stress points themselves, in the same centroid frame. Drawn on top
         of a schematic so the reader can see the coordinates the envelope was
         built from, and judge it for themselves. */
      markers: (markers || []).map(function (p) { return [p[0] - cy, p[1] - cz]; }),
      area: netA,
      centroid: [0, 0],          /* by construction, after the shift */
      centroidWas: [cy, cz],     /* where it sat in the incoming frame */
      bbox: box
    };
  }

  /* Sources that are NOT the real outline, and must be labelled as such
     wherever they are drawn. */
  function isSchematic(source) { return source === "bbox" || source === "hull"; }

  return {
    build: build,
    implementedShapes: implementedShapes,
    shapeName: shapeName,
    DIM_NAMES: DIM_NAMES,
    implementedPscShapes: implementedPscShapes,
    pscDimsOf: pscDimsOf,
    matchPscBySignature: matchPscBySignature,
    isSchematic: isSchematic,
    AREA_TOLERANCE: AREA_TOLERANCE,
    notDrawableReason: notDrawableReason,
    CIRCLE_SEGMENTS: CIRCLE_SEGMENTS,
    _internal: {
      shoelaceArea: shoelaceArea,
      shoelaceCentroid: shoelaceCentroid,
      circle: circle,
      rect: rect,
      bboxOf: bboxOf,
      convexHull: convexHull,
      stressPolygon: stressPolygon,
      areaCheck: areaCheck,
      buildPscI: buildPscI,
      buildPscTee: buildPscTee,
      buildPscCellBox: buildPscCellBox,
      signatureOf: signatureOf,
      PSC_KEYS: PSC_KEYS,
      polyProps: polyProps,
      compareToPublished: compareToPublished,
      resolveVsize: resolveVsize,
      fitCatalogue: fitCatalogue,
      SHAPES: SHAPES
    }
  };
});
