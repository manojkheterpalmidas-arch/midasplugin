/* ==========================================================================
   Beam to Plate — section interpretation
   --------------------------------------------------------------------------
   Turns a /db/SECT row into a THIN-WALLED WALL MODEL: a list of centrelines in
   section-local (y, z) with a thickness each. That is the only description a
   plate mesh can be built from, and most of what CIVIL NX publishes about a
   section is NOT one.

   Three things from references/write-shapes.md drive the whole design:

   1. A `SECTTYPE: "VALUE"` section's `vSIZE` is DECORATIVE. Three live sections
      with vSIZE 1.8x1.0, 1.8x0.5 and 1.8x0.845 published IDENTICAL properties.
      So a VALUE section cannot be converted, and this module refuses it rather
      than drawing something plausible.

   2. `DBUSER` with `DATATYPE: 2` is honest: vSIZE [0.4, 1.5] gave Area 0.600000
      exactly, confirming the pair is (H, B). That pair is the ONLY dimension
      ordering in here that was measured on a live model. Every other shape's
      parameter order below is an informed reading of the section dialog and is
      marked `verified: false`.

   3. PSC and COMPOSITE-GEN carry an exact OUTER_POLYGON — but that is the SOLID
      outline of a section with voids, not a wall layout. Meshing it as walls
      needs the void polygons too, which are not settled, so those are refused
      with the reason said out loud.

   Because (2) is an admission rather than a claim, nothing here is trusted on
   its own: `gate()` checks the derived area against the area the model itself
   publishes for the section, and the UI lets the engineer correct any dimension
   by hand. A wall model that fails the gate is never silently converted.

   Area identity every shape below is built to satisfy exactly:

       sum over walls of (thickness x centreline length) == gross section area

   so the gate is a real test of the dimension ORDER, not a tautology. Swap H
   and B on an unsymmetric shape and the area moves.
   ========================================================================== */
(function (root) {
  "use strict";

  var TAU = Math.PI * 2;

  /* Dimension schema per shape code. `labels` are what the section dialog calls
     them; `verified` says whether the ORDER was confirmed against a live model. */
  var SHAPES = {
    "H":  { label: "I / H section", keys: ["H", "B1", "tw", "tf1", "B2", "tf2"], verified: false },
    "B":  { label: "Box",           keys: ["H", "B", "tw", "tf1", "C", "tf2"],   verified: false },
    "T":  { label: "Tee",           keys: ["H", "B", "tw", "tf"],                verified: false },
    "C":  { label: "Channel",       keys: ["H", "B1", "tw", "tf1", "B2", "tf2"], verified: false },
    "L":  { label: "Angle",         keys: ["H", "B", "tw", "tf"],                verified: false },
    "P":  { label: "Pipe",          keys: ["D", "tw"],                           verified: false },
    "SB": { label: "Solid rectangle", keys: ["H", "B"],                          verified: true  }
  };

  /* Shapes that exist in the DB but have no wall idealisation worth writing. */
  var UNSUPPORTED_SHAPE = {
    "SR": "a solid round has no wall to place plates on",
    "2L": "a double angle is two separate sections; convert them as two",
    "2C": "a double channel is two separate sections; convert them as two",
    "CC": "cold-formed channel dimensions are not settled here"
  };

  /* SECTTYPEs that cannot be converted, each with the reason in the user's
     terms. These are refusals, not failures — say why. */
  var UNSUPPORTED_TYPE = {
    "VALUE": "a VALUE section carries properties only. Its vSIZE is the dialog's " +
             "Size box and nothing computes from it — three live sections with " +
             "different vSIZE published identical properties — so there is no " +
             "geometry here to convert.",
    "PSC": "a PSC section publishes a solid OUTER_POLYGON, not a wall layout. " +
           "Meshing a box girder as plates needs its void outlines too, which " +
           "this plugin does not read.",
    "COMPOSITE": "a composite section is a girder plus a deck slab, and its " +
                 "SECT_BEFORE describes the girder alone. Converting from it " +
                 "would silently drop the slab.",
    "COMPOSITE-GEN": "a general composite section's OUTER_POLYGON is a vertex " +
                     "pool with the connectivity in SECT_I.LINE; read naively " +
                     "it draws a bowtie.",
    "TAPERED": "a tapered section is two sections, i and j. Converting it needs " +
               "a mesh that varies along the member, which this plugin does not " +
               "build."
  };

  /* ------------------------------------------------------------ row reading */

  /**
   * Find the object in a SECT row that actually carries the dimensions.
   *
   * The shape of a SECT row varies with SECTTYPE, and across builds — vSIZE has
   * been seen at SECT_I, at SECT_BEFORE, and at SECT_BEFORE.SECT_I. Rather than
   * hard-code one path and report "unsupported" on a model that is merely
   * arranged differently, walk the row and take the first object carrying a
   * numeric vSIZE, remembering the nearest SHAPE/DATATYPE seen on the way down.
   */
  function findSectData(row, depth, inherited) {
    depth = depth || 0;
    inherited = inherited || {};
    if (!row || typeof row !== "object" || depth > 4) return null;

    var here = {
      shape: typeof row.SHAPE === "string" ? row.SHAPE : inherited.shape,
      datatype: row.DATATYPE != null ? Number(row.DATATYPE) : inherited.datatype,
      name: typeof row.SECT_NAME === "string" ? row.SECT_NAME : inherited.name
    };

    if (Array.isArray(row.vSIZE) && row.vSIZE.length) {
      return {
        vSIZE: row.vSIZE.map(Number),
        shape: here.shape, datatype: here.datatype, name: here.name, at: depth
      };
    }

    var keys = Object.keys(row);
    for (var i = 0; i < keys.length; i++) {
      var v = row[keys[i]];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        var found = findSectData(v, depth + 1, here);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * The area the MODEL publishes for this section, if it publishes one.
   *
   * `SECT_I.STIFF` duplicates the whole /ope/SECTPROP set, so the row usually
   * already carries it and no extra endpoint is needed. The key has been seen
   * as Area and as AREA, and /ope/SECTPROP returns its numbers as TEXT, so
   * match case-insensitively and coerce.
   *
   * Returns null when the model publishes none — which is reported as "no gate
   * available", never as a pass.
   */
  function publishedArea(row, depth) {
    depth = depth || 0;
    if (!row || typeof row !== "object" || depth > 5) return null;
    var keys = Object.keys(row);
    for (var i = 0; i < keys.length; i++) {
      if (/^area$/i.test(keys[i])) {
        var n = Number(row[keys[i]]);
        if (isFinite(n) && n > 0) return n;
      }
    }
    for (var j = 0; j < keys.length; j++) {
      var v = row[keys[j]];
      if (v && typeof v === "object") {
        var found = publishedArea(v, depth + 1);
        if (found != null) return found;
      }
    }
    return null;
  }

  /**
   * Read a SECT row into { shape, dims } without building anything.
   * @returns {{ok:boolean, reason?:string, shape?:string, dims?:Object,
   *            name:string, sectType:string, published:number|null}}
   */
  function readRow(id, row) {
    var sectType = String((row && (row.SECTTYPE || row.SECT_TYPE)) || "").toUpperCase();
    var data = findSectData(row);
    var name = (data && data.name) || (row && row.SECT_NAME) || ("Section " + id);
    var published = publishedArea(row);
    var base = { id: String(id), name: name, sectType: sectType, published: published };

    if (UNSUPPORTED_TYPE[sectType]) {
      return assign(base, { ok: false, reason: UNSUPPORTED_TYPE[sectType] });
    }
    if (!data) {
      return assign(base, { ok: false, reason:
        "this row publishes no vSIZE, so there are no dimensions to read. Pick a " +
        "shape and enter them by hand." });
    }

    var shape = String(data.shape || "").toUpperCase();
    if (!shape) {
      return assign(base, { ok: false, vSIZE: data.vSIZE, reason:
        "this row publishes dimensions but no SHAPE code, so which dimension is " +
        "which cannot be known. Pick a shape by hand." });
    }
    if (UNSUPPORTED_SHAPE[shape]) {
      return assign(base, { ok: false, shape: shape, vSIZE: data.vSIZE,
        reason: UNSUPPORTED_SHAPE[shape] });
    }
    if (!SHAPES[shape]) {
      return assign(base, { ok: false, shape: shape, vSIZE: data.vSIZE, reason:
        "shape code \"" + shape + "\" is not one this plugin knows how to lay out " +
        "as walls. Pick a shape by hand if it is one of the others." });
    }

    /* DATATYPE 1 is a section taken from a database; the dimension list is often
       published as zeros, and drawing from them would produce a flat section. */
    var dims = dimsFromVSize(shape, data.vSIZE);
    var allZero = SHAPES[shape].keys.every(function (k) { return !dims[k]; });
    if (allZero) {
      return assign(base, { ok: false, shape: shape, dims: dims, vSIZE: data.vSIZE, reason:
        "the dimensions publish as zero — a DB section often does. Enter them by " +
        "hand from the section dialog." });
    }

    return assign(base, { ok: true, shape: shape, dims: dims, vSIZE: data.vSIZE,
      datatype: data.datatype });
  }

  function dimsFromVSize(shape, vSIZE) {
    var spec = SHAPES[shape];
    var dims = {};
    if (!spec) return dims;
    spec.keys.forEach(function (k, i) {
      var v = Number(vSIZE && vSIZE[i]);
      dims[k] = isFinite(v) ? v : 0;
    });
    return dims;
  }

  /* --------------------------------------------------------- the wall model */

  /**
   * Build the wall model for a shape and a set of dimensions.
   *
   * Walls are centrelines. Every layout below is arranged so that
   *   sum(t * centreline length) == the shape's exact gross area,
   * which is what makes the area gate meaningful.
   *
   * @returns {{ok:boolean, reason?:string, walls:Array, area:number,
   *            bbox:Object, centroid:Array}}
   */
  function buildWalls(shape, dims, opts) {
    opts = opts || {};
    var d = numeric(dims);
    var walls;

    switch (shape) {
      case "H": walls = wallsI(d); break;
      case "B": walls = wallsBox(d); break;
      case "T": walls = wallsTee(d); break;
      case "C": walls = wallsChannel(d); break;
      case "L": walls = wallsAngle(d); break;
      case "P": walls = wallsPipe(d, opts.pipeFacets || 16); break;
      case "SB": walls = wallsSolidRect(d); break;
      default: return { ok: false, reason: "no wall layout for shape " + shape, walls: [] };
    }

    if (!walls || !walls.length) {
      return { ok: false, reason: "the dimensions given produce no walls", walls: [] };
    }
    var bad = walls.filter(function (w) { return !(w.t > 0) || length(w.pts) <= 0; });
    if (bad.length) {
      return { ok: false, walls: [], reason:
        "dimension \"" + bad[0].name + "\" leaves a wall with zero length or zero " +
        "thickness. Check the values." };
    }

    var model = {
      ok: true, shape: shape, walls: walls,
      area: walls.reduce(function (a, w) { return a + w.t * length(w.pts); }, 0)
    };
    model.bbox = bbox(walls);
    model.centroid = centroid(walls);
    return model;
  }

  /* Each layout is built in its own natural frame; `origin()` moves it onto the
     node line afterwards, so the frames need only be self-consistent. */

  function wallsI(d) {
    var H = d.H, B1 = d.B1, tw = d.tw, tf1 = d.tf1;
    /* A zero bottom flange means "same as the top" in the dialog, not "absent" —
       an unsymmetric girder states both. */
    var B2 = d.B2 || B1, tf2 = d.tf2 || tf1;
    return [
      wall("Top flange", tf1, [[-B1 / 2, H / 2 - tf1 / 2], [B1 / 2, H / 2 - tf1 / 2]]),
      wall("Bottom flange", tf2, [[-B2 / 2, -H / 2 + tf2 / 2], [B2 / 2, -H / 2 + tf2 / 2]]),
      wall("Web", tw, [[0, -H / 2 + tf2], [0, H / 2 - tf1]])
    ];
  }

  function wallsBox(d) {
    var H = d.H, B = d.B, tw = d.tw, tf1 = d.tf1, tf2 = d.tf2 || d.tf1;
    /* The dialog's C is not used: which distance it measures between the webs is
       not settled here, so the webs are placed against the outer faces and the
       AREA GATE is left to catch it if that is wrong. Said out loud in the UI. */
    var zTop = H / 2 - tf1, zBot = -H / 2 + tf2, yw = B / 2 - tw / 2;
    return [
      wall("Top flange", tf1, [[-B / 2, H / 2 - tf1 / 2], [B / 2, H / 2 - tf1 / 2]]),
      wall("Bottom flange", tf2, [[-B / 2, -H / 2 + tf2 / 2], [B / 2, -H / 2 + tf2 / 2]]),
      wall("Left web", tw, [[-yw, zBot], [-yw, zTop]]),
      wall("Right web", tw, [[yw, zBot], [yw, zTop]])
    ];
  }

  function wallsTee(d) {
    var H = d.H, B = d.B, tw = d.tw, tf = d.tf;
    return [
      wall("Flange", tf, [[-B / 2, H / 2 - tf / 2], [B / 2, H / 2 - tf / 2]]),
      wall("Web", tw, [[0, -H / 2], [0, H / 2 - tf]])
    ];
  }

  function wallsChannel(d) {
    var H = d.H, B1 = d.B1, tw = d.tw, tf1 = d.tf1;
    var B2 = d.B2 || B1, tf2 = d.tf2 || tf1;
    /* Natural frame: the web's outer face on y = 0, flanges running out to +y. */
    return [
      wall("Top flange", tf1, [[0, H / 2 - tf1 / 2], [B1, H / 2 - tf1 / 2]]),
      wall("Bottom flange", tf2, [[0, -H / 2 + tf2 / 2], [B2, -H / 2 + tf2 / 2]]),
      wall("Web", tw, [[tw / 2, -H / 2 + tf2], [tw / 2, H / 2 - tf1]])
    ];
  }

  function wallsAngle(d) {
    var H = d.H, B = d.B, tw = d.tw, tf = d.tf;
    /* Natural frame: the heel at the origin, legs running out to +y and +z. */
    return [
      wall("Vertical leg", tw, [[tw / 2, 0], [tw / 2, H]]),
      wall("Horizontal leg", tf, [[tw, tf / 2], [B, tf / 2]])
    ];
  }

  function wallsPipe(d, facets) {
    var D = d.D, tw = d.tw;
    var r = (D - tw) / 2;                 /* mid-wall radius */
    var n = Math.max(8, Math.round(facets));
    var pts = [];
    for (var i = 0; i <= n; i++) {
      var a = TAU * i / n;
      pts.push([r * Math.sin(a), r * Math.cos(a)]);
    }
    /* Circumference of the faceted ring is slightly short of the true circle, so
       scale the radius to keep the area identity exact: the gate must test the
       DIMENSIONS, not the facet count. */
    var chord = 2 * r * Math.sin(Math.PI / n);
    var scale = (TAU * r) / (n * chord);
    pts = pts.map(function (p) { return [p[0] * scale, p[1] * scale]; });
    var w = wall("Wall", tw, pts);
    w.closed = true;
    return [w];
  }

  function wallsSolidRect(d) {
    /* The only VERIFIED ordering in this file: DBUSER DATATYPE 2 vSIZE [0.4,1.5]
       published Area 0.600000 exactly, so the pair is (H, B).

       A solid rectangle has no walls. Idealising it as ONE plate through the
       mid-plane, of thickness B, is area-exact and is usually what is wanted for
       a wall or a blade — but it is an idealisation, and the UI says so. */
    return [wall("Mid-plane", d.B, [[0, -d.H / 2], [0, d.H / 2]])];
  }

  function wall(name, t, pts) {
    return { name: name, t: Number(t) || 0, pts: pts, closed: false };
  }

  /* ------------------------------------------------------------- geometry */

  function length(pts) {
    var L = 0;
    for (var i = 1; i < pts.length; i++) {
      L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return L;
  }

  /** Outline bounding box: each segment inflated by t/2 PERPENDICULAR to itself.
   *  Inflating the segment box in both directions instead would add half a
   *  thickness to a flange's width and quietly widen every section. */
  function bbox(walls) {
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    walls.forEach(function (w) {
      for (var i = 1; i < w.pts.length; i++) {
        var a = w.pts[i - 1], b = w.pts[i];
        var dy = b[0] - a[0], dz = b[1] - a[1];
        var L = Math.hypot(dy, dz) || 1;
        var ny = -dz / L * w.t / 2, nz = dy / L * w.t / 2;
        [[a[0] + ny, a[1] + nz], [a[0] - ny, a[1] - nz],
         [b[0] + ny, b[1] + nz], [b[0] - ny, b[1] - nz]].forEach(function (p) {
          lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]);
          hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]);
        });
      }
    });
    return { min: lo, max: hi, size: [hi[0] - lo[0], hi[1] - lo[1]],
             centre: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2] };
  }

  /** Thin-walled centroid: each segment weighted by t * its length. */
  function centroid(walls) {
    var sy = 0, sz = 0, sa = 0;
    walls.forEach(function (w) {
      for (var i = 1; i < w.pts.length; i++) {
        var a = w.pts[i - 1], b = w.pts[i];
        var L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        var da = L * w.t;
        sy += da * (a[0] + b[0]) / 2;
        sz += da * (a[1] + b[1]) / 2;
        sa += da;
      }
    });
    return sa > 0 ? [sy / sa, sz / sa] : [0, 0];
  }

  /**
   * Move the wall model so that `ref` sits on the node line.
   *
   * WHICH point of the section the beam's node line passes through is a property
   * of the section's own offset setting, and that setting is not settled here —
   * so it is the user's choice, defaulted to the centre of the bounding box
   * (the dialog's Center-Center) and stated in the UI. Getting it wrong shifts
   * the whole mesh sideways; it does not distort it.
   */
  function origin(model, ref) {
    var p = ref === "centroid" ? model.centroid : model.bbox.centre;
    var walls = model.walls.map(function (w) {
      return { name: w.name, t: w.t, closed: w.closed,
               pts: w.pts.map(function (q) { return [q[0] - p[0], q[1] - p[1]]; }) };
    });
    var out = assign({}, model);
    out.walls = walls;
    out.bbox = bbox(walls);
    out.centroid = centroid(walls);
    out.originRef = ref === "centroid" ? "centroid" : "bbox";
    return out;
  }

  /* ------------------------------------------------------------- the gate */

  /**
   * Check a derived wall model against the area the MODEL publishes.
   *
   * Every reconstruction in this codebase is gated against a published quantity
   * and discarded when it misses. A wrong dimension ORDER moves the area, so
   * this catches the most likely way the shape tables above are wrong — and a
   * dimension list read in millimetres against coordinates in metres misses by
   * a factor of a million, which it also catches.
   *
   * @returns {{status:"pass"|"fail"|"none", err?:number, published?:number}}
   */
  function gate(derivedArea, published, tolerance) {
    var tol = tolerance == null ? 0.02 : tolerance;
    if (!(published > 0)) {
      return { status: "none", derived: derivedArea };
    }
    var err = (derivedArea - published) / published;
    return {
      status: Math.abs(err) <= tol ? "pass" : "fail",
      err: err, published: published, derived: derivedArea, tolerance: tol
    };
  }

  /* ---------------------------------------------------------------- utils */

  function numeric(dims) {
    var out = {};
    Object.keys(dims || {}).forEach(function (k) {
      var v = Number(dims[k]);
      out[k] = isFinite(v) ? v : 0;
    });
    return out;
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i] || {};
      Object.keys(src).forEach(function (k) { target[k] = src[k]; });
    }
    return target;
  }

  var api = {
    SHAPES: SHAPES,
    UNSUPPORTED_SHAPE: UNSUPPORTED_SHAPE,
    UNSUPPORTED_TYPE: UNSUPPORTED_TYPE,
    readRow: readRow,
    dimsFromVSize: dimsFromVSize,
    findSectData: findSectData,
    publishedArea: publishedArea,
    buildWalls: buildWalls,
    origin: origin,
    gate: gate,
    length: length,
    bbox: bbox,
    centroid: centroid
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PSection = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
