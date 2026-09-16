/* ==========================================================================
   Beam to Plate — drawings
   --------------------------------------------------------------------------
   Two SVGs, both built as strings so nothing here touches the DOM:

     sectionSvg   the section as CIVIL NX describes it (the solid outline) with
                  the PLATE WALLS drawn on top, each at its own thickness, the
                  ties between parts dashed, and the node line marked. Seeing
                  the two together is how an engineer judges an idealisation.
     meshSvg      the plates themselves, in isometric, sampled above a cap so a
                  hundred thousand of them still draw in a moment.
   ========================================================================== */
(function (root) {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ------------------------------------------------------------- section */

  function sectionSvg(model, opts) {
    opts = opts || {};
    var W = opts.width || 200, H = opts.height || 150, pad = 10;
    if (!model || !model.walls || !model.walls.length) {
      return '<svg width="' + W + '" height="' + H + '" role="img" aria-label="no section"></svg>';
    }
    var pts = [];
    (model.regions || []).forEach(function (r) {
      r.outer.forEach(function (p) { pts.push(p); });
      (r.holes || []).forEach(function (h) { h.forEach(function (p) { pts.push(p); }); });
    });
    model.walls.forEach(function (w) { w.pts.forEach(function (p) { pts.push(p); }); });
    pts.push([0, 0]);                       /* the node line is always in frame */
    var minY = Math.min.apply(null, pts.map(function (p) { return p[0]; }));
    var maxY = Math.max.apply(null, pts.map(function (p) { return p[0]; }));
    var minZ = Math.min.apply(null, pts.map(function (p) { return p[1]; }));
    var maxZ = Math.max.apply(null, pts.map(function (p) { return p[1]; }));
    var span = Math.max(maxY - minY, maxZ - minZ) || 1;
    var s = Math.min((W - 2 * pad) / span, (H - 2 * pad) / span);
    var cx = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    var X = function (p) { return (W / 2 + (p[0] - cx) * s).toFixed(2); };
    var Y = function (p) { return (H / 2 - (p[1] - cz) * s).toFixed(2); };

    var out = ['<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
      '" role="img" aria-label="' + esc(opts.label || "section") + '">'];
    (model.regions || []).forEach(function (r) {
      var d = [r.outer].concat(r.holes || []).map(function (ring) {
        return "M" + ring.map(function (p) { return X(p) + "," + Y(p); }).join("L") + "Z";
      }).join(" ");
      out.push('<path d="' + d + '" fill="var(--sect-fill)" fill-rule="evenodd" stroke="var(--sect-line)" stroke-width="0.7"/>');
    });
    var tMax = 0;
    model.walls.forEach(function (w) { w.t.forEach(function (t) { tMax = Math.max(tMax, t); }); });
    model.walls.forEach(function (w) {
      var n = w.pts.length, segs = w.closed ? n : n - 1;
      for (var i = 0; i < segs; i++) {
        var a = w.pts[i], b = w.pts[(i + 1) % n];
        var lw = Math.max(0.8, Math.min(6, (w.t[i] / (tMax || 1)) * 4));
        out.push('<line x1="' + X(a) + '" y1="' + Y(a) + '" x2="' + X(b) + '" y2="' + Y(b) +
          '" stroke="var(--wall-' + (w.part ? "b" : "a") + ')" stroke-width="' + lw.toFixed(2) +
          '" stroke-linecap="round" opacity="0.85"/>');
      }
    });
    (model.connectors || []).forEach(function (c) {
      out.push('<line x1="' + X(c.a) + '" y1="' + Y(c.a) + '" x2="' + X(c.b) + '" y2="' + Y(c.b) +
        '" stroke="var(--tie)" stroke-width="1.2" stroke-dasharray="3,2"/>');
    });
    /* the node line: where the beam's own axis runs through the section */
    out.push('<circle cx="' + X([0, 0]) + '" cy="' + Y([0, 0]) + '" r="3.2" fill="none" stroke="var(--nodeline)" stroke-width="1.6"/>');
    out.push('<line x1="' + (X([0, 0]) - 6) + '" y1="' + Y([0, 0]) + '" x2="' + (Number(X([0, 0])) + 6) + '" y2="' + Y([0, 0]) +
      '" stroke="var(--nodeline)" stroke-width="0.8"/>');
    out.push("</svg>");
    return out.join("");
  }

  /* ---------------------------------------------------------------- mesh */

  function meshSvg(pool, plates, opts) {
    opts = opts || {};
    var W = opts.width || 700, H = opts.height || 250, pad = 14;
    if (!plates || !plates.length) return '<svg width="' + W + '" height="' + H + '"></svg>';
    var cap = opts.cap || 6000;
    var step = Math.max(1, Math.ceil(plates.length / cap));
    var az = (opts.azimuth == null ? 35 : opts.azimuth) * Math.PI / 180;
    var el = (opts.elevation == null ? 22 : opts.elevation) * Math.PI / 180;
    var ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el);
    function proj(p) {
      var x = p[0] * ca + p[1] * sa;
      var y = -p[0] * sa * se + p[1] * ca * se + p[2] * ce;
      return [x, y];
    }
    var shown = [], minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < plates.length; i += step) {
      var q = plates[i].nodes.map(function (ix) { return proj(pool.list[ix]); });
      shown.push({ q: q, depth: plates[i].nodes.reduce(function (a, ix) {
        var p = pool.list[ix]; return a + (-p[0] * sa + p[1] * ca); }, 0) / 4, part: plates[i].part });
      q.forEach(function (p) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      });
    }
    var s = Math.min((W - 2 * pad) / ((maxX - minX) || 1), (H - 2 * pad) / ((maxY - minY) || 1));
    shown.sort(function (a, b) { return a.depth - b.depth; });
    var out = ['<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H +
      '" role="img" aria-label="plate mesh">'];
    shown.forEach(function (sh) {
      var d = "M" + sh.q.map(function (p) {
        return (pad + (p[0] - minX) * s).toFixed(1) + "," + (H - pad - (p[1] - minY) * s).toFixed(1);
      }).join("L") + "Z";
      out.push('<path d="' + d + '" fill="var(--plate-' + (sh.part ? "b" : "a") + ')" stroke="var(--plate-edge)" stroke-width="0.35" opacity="0.9"/>');
    });
    if (step > 1) {
      out.push('<text x="' + (W - 8) + '" y="' + (H - 8) + '" text-anchor="end" font-size="10" fill="var(--muted)">' +
        "showing 1 in " + step + " plates</text>");
    }
    out.push("</svg>");
    return out.join("");
  }

  var api = { sectionSvg: sectionSvg, meshSvg: meshSvg };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PDraw = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
