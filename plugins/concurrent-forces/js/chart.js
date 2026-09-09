/* ==========================================================================
   Concurrent Forces — the distribution chart
   --------------------------------------------------------------------------
   Pure: it computes a SPEC, and app.js turns the spec into SVG nodes. Nothing
   here touches the DOM, so `node test/run.js` can check the geometry — and
   nothing is ever injected as markup, so an element label or a load name
   cannot become HTML.

   What it draws, and why this chart rather than a prettier one: the whole
   point of the plugin is that these values are COEXISTENT, so the useful
   picture is one component's value along the set at that single instant, with
   the key element marked. A reader can then see at a glance where the demand
   actually sits when the key element is at its worst — which is the question
   that made them open the plugin.
   ========================================================================== */
(function (root) {
  "use strict";

  var PAD = { top: 18, right: 14, bottom: 26, left: 62 };
  var MIN_BAR = 2;
  var GAP = 1;

  /**
   * @param {Object} doc     the report document from report.js
   * @param {string} columnId  which component column to plot
   * @param {Object} [opts]  { width, height }
   * @returns {Object} spec
   */
  function buildChart(doc, columnId, opts) {
    opts = opts || {};
    var width = opts.width || 900;
    var height = opts.height || 210;

    var col = -1;
    doc.columns.forEach(function (c, i) { if (c.id === columnId) col = i; });
    if (col < 0) {
      return { empty: true, reason: "no column " + columnId + " in this report" };
    }

    var points = [];
    doc.rows.forEach(function (r) {
      var cell = r.cells[col];
      points.push({
        value: cell.value,
        /* A cell with no value is not a zero. It is left out of the bars and
           counted, so the caption can say how many and why rather than drawing
           a flat line where there is no data. */
        reason: cell.value == null ? (cell.reason || "no value") : null,
        label: r.cells[0].text + " " + r.cells[2].text,
        isKey: !!r.isKey,
        isGoverning: !!r.emphasis
      });
    });

    var real = points.filter(function (p) { return p.value != null; });
    if (!real.length) {
      return { empty: true, reason: "no plottable values in this column",
               skipped: points.length, width: width, height: height };
    }

    var lo = Math.min(0, Math.min.apply(null, real.map(function (p) { return p.value; })));
    var hi = Math.max(0, Math.max.apply(null, real.map(function (p) { return p.value; })));
    if (lo === hi) { hi = hi + 1; lo = lo - 1; }
    var span = hi - lo;

    var plotW = width - PAD.left - PAD.right;
    var plotH = height - PAD.top - PAD.bottom;
    var step = plotW / points.length;
    var barW = Math.max(MIN_BAR, step - GAP);

    var yOf = function (v) { return PAD.top + (hi - v) / span * plotH; };
    var zeroY = yOf(0);

    /* MORE ROWS THAN PIXELS. At one bar per row a 4180-row set over 1180px
       gives each bar 0.28px of space and a 2px minimum width — so every bar
       overlaps its seven neighbours, the translucent fills stack into a solid
       shape, and the density on screen means nothing at all. Below about
       1.5px per row the chart becomes a MIN-MAX BAND: one column per pixel,
       spanning the true range of the rows that fall in it. Nothing is hidden
       and nothing is invented; the caption says which mode is in use. */
    var dense = step < 1.5;
    var bars = dense ? denseBars() : plainBars();

    function plainBars() {
      return points.map(function (p, i) {
        var x = PAD.left + i * step + (step - barW) / 2;
        if (p.value == null) {
          return { x: x, w: barW, missing: true, label: p.label, reason: p.reason,
                   isKey: p.isKey, isGoverning: p.isGoverning };
        }
        var y = yOf(Math.max(p.value, 0));
        var h = Math.max(1, Math.abs(yOf(p.value) - zeroY));
        return {
          x: x, y: y, w: barW, h: h, value: p.value, label: p.label,
          isKey: p.isKey, isGoverning: p.isGoverning, negative: p.value < 0
        };
      });
    }

    function denseBars() {
      var cols = Math.max(1, Math.floor(plotW));
      var buckets = new Array(cols);
      points.forEach(function (p, i) {
        var c = Math.min(cols - 1, Math.floor(i / points.length * cols));
        var b = buckets[c] || (buckets[c] = {
          lo: Infinity, hi: -Infinity, n: 0, isKey: false, isGoverning: false,
          first: p.label, last: p.label
        });
        b.last = p.label;
        b.isKey = b.isKey || p.isKey;
        b.isGoverning = b.isGoverning || p.isGoverning;
        if (p.value == null) return;
        b.n++;
        if (p.value < b.lo) b.lo = p.value;
        if (p.value > b.hi) b.hi = p.value;
      });

      var out = [];
      buckets.forEach(function (b, c) {
        if (!b) return;
        var x = PAD.left + c;
        if (!b.n) {
          out.push({ x: x, w: 1, missing: true, label: b.first,
                     reason: "no value in this column", isKey: b.isKey });
          return;
        }
        /* The band always reaches the zero line, so a column that is entirely
           positive still reads as a bar rising from zero rather than as a
           floating segment. */
        var top = yOf(Math.max(b.hi, 0));
        var bottom = yOf(Math.min(b.lo, 0));
        out.push({
          x: x, y: top, w: 1, h: Math.max(1, bottom - top),
          value: Math.abs(b.hi) >= Math.abs(b.lo) ? b.hi : b.lo,
          lo: b.lo, hi: b.hi, count: b.n,
          label: b.first === b.last ? b.first : b.first + " … " + b.last,
          isKey: b.isKey, isGoverning: b.isGoverning, negative: b.hi <= 0
        });
      });
      return out;
    }

    return {
      empty: false, width: width, height: height, dense: dense,
      plot: { x: PAD.left, y: PAD.top, w: plotW, h: plotH },
      zeroY: zeroY, bars: bars, min: lo, max: hi,
      ticks: ticksFor(lo, hi, yOf),
      /* Only some x labels fit. Pick a stride that keeps them readable rather
         than drawing 440 overlapping strings. */
      labelEvery: Math.max(1, Math.ceil(bars.length / Math.floor(plotW / 84))),
      missing: points.filter(function (p) { return p.value == null; }).length,
      count: points.length
    };
  }

  /** Zero, the two extremes, and a midpoint each side where there is room. */
  function ticksFor(lo, hi, yOf) {
    var vals = [lo, hi];
    if (lo < 0 && hi > 0) vals.push(0);
    if (hi > 0) vals.push(hi / 2);
    if (lo < 0) vals.push(lo / 2);
    var seen = Object.create(null);
    return vals.filter(function (v) {
      var k = v.toPrecision(6);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).map(function (v) { return { value: v, y: yOf(v) }; });
  }

  var api = { buildChart: buildChart, PAD: PAD };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfChart = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
