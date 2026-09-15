/* ==========================================================================
   Beam to Plate — drawings
   --------------------------------------------------------------------------
   Two pictures, both built as SVG strings so they can be produced without a DOM
   and asserted in the offline suite.

   They are not decoration. The area gate catches a wrong dimension ORDER, but
   nothing numeric catches a section drawn the right size the wrong way up, or a
   beta angle applied with the wrong sign — those are exactly the failures a
   glance at a picture catches instantly. So the plugin draws the cross-section
   it is about to extrude, and the mesh it is about to write, BEFORE it writes.
   ========================================================================== */
(function (root) {
  "use strict";

  /* Colours come from the stylesheet's custom properties so both drawings
     follow the theme; no palette is hard-coded here. */
  var INK = "var(--ink)", SOFT = "var(--ink-soft)", LINE = "var(--line)",
      ACCENT = "var(--accent)", FILL = "var(--wall-fill)";

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function n(v) { return (Math.round(v * 1000) / 1000).toString(); }

  /* ------------------------------------------------------- cross-section */

  /**
   * Draw a wall model in section-local axes: local y to the right, local z up.
   *
   * The origin marker is the NODE LINE — the point the beam's own nodes run
   * through. Where it sits relative to the outline is the section's offset, and
   * that is a user choice here rather than a fact read from the model, so it is
   * drawn rather than assumed.
   */
  function sectionSvg(model, opts) {
    opts = opts || {};
    var W = opts.width || 300, H = opts.height || 220, pad = 22;
    if (!model || !model.walls || !model.walls.length) {
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
        '" role="img" aria-label="no section"><text x="' + (W / 2) + '" y="' + (H / 2) +
        '" text-anchor="middle" fill="' + SOFT + '" font-size="12">no geometry</text></svg>';
    }

    var bb = model.bbox;
    /* The origin is part of what must be visible: a node line outside the
       outline is a legitimate and important thing to see. */
    var lo = [Math.min(bb.min[0], 0), Math.min(bb.min[1], 0)];
    var hi = [Math.max(bb.max[0], 0), Math.max(bb.max[1], 0)];
    var spanY = Math.max(hi[0] - lo[0], 1e-9), spanZ = Math.max(hi[1] - lo[1], 1e-9);
    var s = Math.min((W - 2 * pad) / spanY, (H - 2 * pad) / spanZ);
    var cx = (lo[0] + hi[0]) / 2, cz = (lo[1] + hi[1]) / 2;

    function X(y) { return W / 2 + (y - cx) * s; }
    function Y(z) { return H / 2 - (z - cz) * s; }   /* local z is UP on screen */

    var parts = [];
    model.walls.forEach(function (w) {
      for (var i = 1; i < w.pts.length; i++) {
        var a = w.pts[i - 1], b = w.pts[i];
        var dy = b[0] - a[0], dz = b[1] - a[1];
        var L = Math.hypot(dy, dz);
        if (!(L > 0)) continue;
        var ny = -dz / L * w.t / 2, nz = dy / L * w.t / 2;
        var pts = [[a[0] + ny, a[1] + nz], [b[0] + ny, b[1] + nz],
                   [b[0] - ny, b[1] - nz], [a[0] - ny, a[1] - nz]]
          .map(function (p) { return n(X(p[0])) + "," + n(Y(p[1])); }).join(" ");
        parts.push('<polygon points="' + pts + '" fill="' + FILL + '" stroke="' + INK +
                   '" stroke-width="0.8" stroke-linejoin="round"><title>' +
                   esc(w.name + " — " + (w.t * 1000).toFixed(1) + " thick (model units x1000)") +
                   '</title></polygon>');
      }
    });

    /* The node line, and the local axes it carries. */
    var ox = X(0), oy = Y(0);
    parts.push('<g stroke="' + ACCENT + '" stroke-width="1">' +
      '<line x1="' + n(ox - 9) + '" y1="' + n(oy) + '" x2="' + n(ox + 9) + '" y2="' + n(oy) + '"/>' +
      '<line x1="' + n(ox) + '" y1="' + n(oy - 9) + '" x2="' + n(ox) + '" y2="' + n(oy + 9) + '"/>' +
      '<circle cx="' + n(ox) + '" cy="' + n(oy) + '" r="2.5" fill="' + ACCENT + '" stroke="none"/></g>');
    parts.push('<g fill="' + SOFT + '" font-size="10" font-family="system-ui, sans-serif">' +
      '<text x="' + n(W - pad + 4) + '" y="' + n(H / 2 + 3) + '">y</text>' +
      '<text x="' + n(W / 2 - 3) + '" y="' + n(pad - 8) + '">z</text></g>');
    parts.push('<g stroke="' + LINE + '" stroke-width="0.6" stroke-dasharray="3 3">' +
      '<line x1="' + n(pad - 8) + '" y1="' + n(H / 2) + '" x2="' + n(W - pad + 8) + '" y2="' + n(H / 2) + '"/>' +
      '<line x1="' + n(W / 2) + '" y1="' + n(pad - 6) + '" x2="' + n(W / 2) + '" y2="' + n(H - pad + 6) + '"/></g>');

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-label="' + esc(opts.label || "cross-section") + '">' +
      parts.join("") + '</svg>';
  }

  /* ------------------------------------------------------------- the mesh */

  /**
   * Isometric wireframe of the generated mesh.
   *
   * Painter's algorithm, back to front — enough to read the shape and to see
   * immediately whether a section is oriented as intended along the member.
   * Large meshes are SAMPLED rather than drawn whole: this runs on the UI
   * thread, and a drawing that blocks it is a plugin whose close button does
   * not work.
   */
  function meshSvg(pool, plates, opts) {
    opts = opts || {};
    var W = opts.width || 640, H = opts.height || 260, pad = 14;
    var cap = opts.cap || 1500;

    if (!plates || !plates.length) {
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
        '"><text x="' + (W / 2) + '" y="' + (H / 2) + '" text-anchor="middle" fill="' +
        SOFT + '" font-size="12">nothing to draw</text></svg>';
    }

    var step = Math.max(1, Math.ceil(plates.length / cap));
    var shown = [];
    for (var i = 0; i < plates.length; i += step) shown.push(plates[i]);

    /* Classic isometric: global Z stays up the page. */
    var c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
    function proj(p) { return [(p[0] - p[1]) * c30, (p[0] + p[1]) * s30 - p[2]]; }
    function depth(p) { return p[0] + p[1] + p[2]; }

    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    shown.forEach(function (q) {
      q.nodes.forEach(function (ix) {
        var u = proj(pool.list[ix]);
        lo[0] = Math.min(lo[0], u[0]); hi[0] = Math.max(hi[0], u[0]);
        lo[1] = Math.min(lo[1], u[1]); hi[1] = Math.max(hi[1], u[1]);
      });
    });
    var s = Math.min((W - 2 * pad) / Math.max(hi[0] - lo[0], 1e-9),
                     (H - 2 * pad) / Math.max(hi[1] - lo[1], 1e-9));
    function sx(u) { return pad + (u[0] - lo[0]) * s; }
    function sy(u) { return H - pad - (u[1] - lo[1]) * s; }

    var ordered = shown.map(function (q) {
      var d = q.nodes.reduce(function (a, ix) { return a + depth(pool.list[ix]); }, 0) / 4;
      return { q: q, d: d };
    }).sort(function (a, b) { return b.d - a.d; });

    var body = ordered.map(function (o) {
      var pts = o.q.nodes.map(function (ix) {
        var u = proj(pool.list[ix]);
        return n(sx(u)) + "," + n(sy(u));
      }).join(" ");
      return '<polygon points="' + pts + '" fill="' + FILL + '" fill-opacity="0.85" stroke="' +
             INK + '" stroke-width="0.35" stroke-linejoin="round"/>';
    }).join("");

    var note = step > 1
      ? '<text x="' + (W - 8) + '" y="' + (H - 6) + '" text-anchor="end" fill="' + SOFT +
        '" font-size="10" font-family="system-ui, sans-serif">showing 1 plate in ' + step +
        ' of ' + plates.length + '</text>'
      : "";

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
      '" role="img" aria-label="generated plate mesh">' + body + note + '</svg>';
  }

  var api = { sectionSvg: sectionSvg, meshSvg: meshSvg };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PDraw = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
