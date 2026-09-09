/* ==========================================================================
   Concurrent Forces — the result-source registry and the item set
   --------------------------------------------------------------------------
   Pure. Everything the plugin knows about WHERE a result comes from lives in
   one table here: which /post/TABLE token serves it, which id space its items
   belong to, what its HEAD columns are called, which quantities it carries and
   what units those quantities are in.

   Adding a result source is adding an entry to SOURCES. Nothing else in the
   plugin names a table or a component.

   Three rules from the estate that this module exists to keep:

   - HEAD COLUMNS DIFFER PER TABLE. `Elem`/`Part` are not universal — a link
     table uses `No.`, a node table has no part column at all, and the plate
     table's part column is `Node`. Never index by position; every source
     carries its own column names and says which it could not find.
   - A SELECTION MEMBER CARRIES ITS NAMESPACE. Element, link and node ids are
     separate spaces that collide — 536 collisions on one real model — so a
     bare number that exists in two of them addresses the wrong object
     silently. A bare number is an element; N12 is a node, L5 a general link,
     EL5 an elastic link, E5 an explicit element.
   - A QUANTITY A SOURCE DOES NOT CARRY IS ABSENT, NOT ZERO. A truss has no
     moment and a free node has no reaction. Those cells carry a reason.
   ========================================================================== */
(function (root) {
  "use strict";

  /* Unit kinds, so a column can be labelled correctly whatever it reports.
     Getting this wrong is not cosmetic — a plate moment is per unit length and
     reads as a plain moment unless the header says otherwise. */
  var UNITS = {
    F:      function (u) { return u.FORCE; },
    FL:     function (u) { return u.FORCE + "·" + u.DIST; },
    "F/L":  function (u) { return u.FORCE + "/" + u.DIST; },
    "FL/L": function (u) { return u.FORCE + "·" + u.DIST + "/" + u.DIST; },
    L:      function (u) { return u.DIST; },
    rad:    function () { return "rad"; }
  };

  function unitLabel(kind, units) {
    var fn = UNITS[kind] || UNITS.F;
    return fn(units || { FORCE: "kN", DIST: "m" });
  }

  function comp(id, label, column, unit) {
    return { id: id, label: label, column: column, unit: unit };
  }

  /* The six member-end forces, shared by every table that reports them. */
  var MEMBER_FORCES = [
    comp("Fx", "Fx — axial", "Axial", "F"),
    comp("Fy", "Fy — shear y", "Shear-y", "F"),
    comp("Fz", "Fz — shear z", "Shear-z", "F"),
    comp("Mx", "Mx — torsion", "Torsion", "FL"),
    comp("My", "My — moment y", "Moment-y", "FL"),
    comp("Mz", "Mz — moment z", "Moment-z", "FL")
  ];

  var ITEM_COLS = ["Elem", "Element", "Elem No", "Element No"];
  var LINK_ITEM_COLS = ["No.", "No", "Elem", "Element"];
  var NODE_ITEM_COLS = ["Node", "Node No", "No.", "No"];
  var PART_COLS = ["Part", "Position", "Point", "Location"];

  /**
   * Every result source the plugin can read.
   *
   *   tokens     TABLE_TYPE candidates, tried in order. Tokens are not
   *              guessable and a wrong one answers "error creating utbl",
   *              which reads like an un-analysed model — so each is probed
   *              against the build rather than assumed.
   *   namespace  which id space its items live in
   *   itemCols   HEAD names that identify the item
   *   partCols   HEAD names for the output position, or null where the table
   *              reports one row per item (node tables do)
   *   verified   whether the token is confirmed against a live CIVIL NX by the
   *              skill this plugin was built on. Surfaced in the UI.
   */
  var SOURCES = {
    BEAM: {
      id: "BEAM", label: "beam elements", noun: "beam", kind: "element",
      tokens: ["BEAMFORCE"], verified: true,
      namespace: "elem", itemCols: ITEM_COLS, partCols: PART_COLS, partKind: "ij",
      components: MEMBER_FORCES,
      absent: "not carried — this element type reports no such component"
    },
    TRUSS: {
      id: "TRUSS", label: "truss elements", noun: "truss", kind: "element",
      tokens: ["TRUSSFORCE", "TRUSSFORCES", "TRUSS"], verified: false,
      namespace: "elem", itemCols: ITEM_COLS, partCols: PART_COLS, partKind: "ij",
      components: [comp("Fx", "Fx — axial", "Axial", "F")],
      absent: "not carried — a truss element reports axial force only"
    },
    PLATE: {
      id: "PLATE", label: "plate elements", noun: "plate", kind: "element",
      tokens: ["PLATEFORCE"], verified: true,
      namespace: "elem", itemCols: ITEM_COLS, partCols: ["Node"].concat(PART_COLS),
      /* A plate reports at its NODES, not at an I and a J end, so the
         I/J/both output position does not apply to it. */
      partKind: "node",
      /* Plate results are per unit length, which is why they get their own
         unit kinds rather than borrowing the member-force ones. */
      components: [
        comp("Fxx", "Fxx — in-plane x", "Fxx", "F/L"),
        comp("Fyy", "Fyy — in-plane y", "Fyy", "F/L"),
        comp("Fxy", "Fxy — in-plane shear", "Fxy", "F/L"),
        comp("Mxx", "Mxx — bending x", "Mxx", "FL/L"),
        comp("Myy", "Myy — bending y", "Myy", "FL/L"),
        comp("Mxy", "Mxy — twisting", "Mxy", "FL/L"),
        comp("Vxx", "Vxx — out-of-plane shear x", "Vxx", "F/L"),
        comp("Vyy", "Vyy — out-of-plane shear y", "Vyy", "F/L")
      ],
      absent: "not carried — plate results are per unit length and use their own components"
    },
    GENLINK: {
      id: "GENLINK", label: "general links", noun: "general link", kind: "link",
      tokens: ["GENLINKFORCE", "GENERALLINKFORCE", "GLINKFORCE", "GENLINK"], verified: false,
      namespace: "link", itemCols: LINK_ITEM_COLS, partCols: PART_COLS, partKind: "ij",
      components: MEMBER_FORCES,
      absent: "not carried by this link type"
    },
    ELASTICLINK: {
      id: "ELASTICLINK", label: "elastic links", noun: "elastic link", kind: "link",
      tokens: ["ELASTICLINK"], verified: true,
      namespace: "elink", itemCols: LINK_ITEM_COLS, partCols: ["Node"].concat(PART_COLS),
      partKind: "node",
      components: MEMBER_FORCES,
      absent: "not carried by this link type"
    },
    REACTION: {
      id: "REACTION", label: "node reactions", noun: "node", kind: "node",
      tokens: ["REACTIONG"], verified: true,
      namespace: "node", itemCols: NODE_ITEM_COLS, partCols: null,
      components: [
        comp("RFX", "FX — reaction x", "FX", "F"),
        comp("RFY", "FY — reaction y", "FY", "F"),
        comp("RFZ", "FZ — reaction z", "FZ", "F"),
        comp("RMX", "MX — reaction moment x", "MX", "FL"),
        comp("RMY", "MY — reaction moment y", "MY", "FL"),
        comp("RMZ", "MZ — reaction moment z", "MZ", "FL")
      ],
      absent: "no reaction at this node — it is not restrained"
    },
    DISPLACEMENT: {
      id: "DISPLACEMENT", label: "node displacements", noun: "node", kind: "node",
      tokens: ["DISPLACEMENTG"], verified: true,
      namespace: "node", itemCols: NODE_ITEM_COLS, partCols: null,
      components: [
        comp("DX", "DX — displacement x", "DX", "L"),
        comp("DY", "DY — displacement y", "DY", "L"),
        comp("DZ", "DZ — displacement z", "DZ", "L"),
        comp("RX", "RX — rotation x", "RX", "rad"),
        comp("RY", "RY — rotation y", "RY", "rad"),
        comp("RZ", "RZ — rotation z", "RZ", "rad")
      ],
      absent: "this node returned no displacement row for the governing state"
    }
  };

  var SOURCE_ORDER = ["BEAM", "TRUSS", "PLATE", "GENLINK", "ELASTICLINK",
                      "REACTION", "DISPLACEMENT"];

  /* Which sources serve a namespace. A node serves TWO — reactions and
     displacements are different tables over the same items — so a node in the
     set contributes to both, merged onto one row per node because their
     columns are disjoint. */
  function sourcesFor(namespace) {
    return SOURCE_ORDER.filter(function (id) { return SOURCES[id].namespace === namespace; });
  }

  /** Every component across every source, for the driver's effect list. */
  function allComponents() {
    var out = [];
    SOURCE_ORDER.forEach(function (sid) {
      SOURCES[sid].components.forEach(function (c) {
        out.push({ source: sid, id: sid + ":" + c.column, column: c.column,
                   label: c.label, unit: c.unit, sourceLabel: SOURCES[sid].label });
      });
    });
    return out;
  }

  /** Resolve a driver effect id ("BEAM:Axial") back to its source and column. */
  function findComponent(id) {
    var hit = allComponents().filter(function (c) { return c.id === id; })[0];
    return hit || null;
  }

  /* /db/ELEM TYPE -> the source that reports on it. Anything not listed is
     reported as unsupported BY NAME rather than silently dropped. */
  var ELEM_ROUTING = {
    BEAM:     { source: "BEAM",  label: "beam" },
    TRUSS:    { source: "TRUSS", label: "truss" },
    TENSTR:   { source: "TRUSS", label: "tension-only truss" },
    COMPTR:   { source: "TRUSS", label: "compression-only truss" },
    PLATE:    { source: "PLATE", label: "plate" },
    PLSTRESS: { source: "PLATE", label: "plane stress" },
    PLSTRAIN: { source: "PLATE", label: "plane strain" },
    WALL:     { source: "PLATE", label: "wall" },
    AXISYM:   { source: null, label: "axisymmetric" },
    SOLID:    { source: null, label: "solid" }
  };

  /* --------------------------------------------------------- set parsing -- */

  var NS_PREFIX = { "": "elem", E: "elem", N: "node", L: "link", EL: "elink" };
  var NS_LABEL = { elem: "element", node: "node", link: "general link", elink: "elastic link" };
  var NS_WRITE = { elem: "", node: "N", link: "L", elink: "EL" };

  /**
   * Parse the item-set text.
   *
   *   "10, 12, 15to20"   elements
   *   "N101, N102"       nodes — for reactions and displacements
   *   "L5, EL7"          a general link and an elastic link
   *   "101-104"          a hyphen range works too
   *
   * Order is the order the user typed, which is the order the report sorts in.
   * Duplicates collapse onto their first appearance.
   */
  function parseSet(text) {
    var members = [], errors = [], seen = Object.create(null);
    String(text == null ? "" : text).split(/[,;\n]+/).forEach(function (chunk) {
      var tok = chunk.trim();
      if (!tok) return;
      var range = /^(EL|E|N|L)?\s*(\d+)\s*(?:to|-|~|\.\.)\s*(EL|E|N|L)?\s*(\d+)$/i.exec(tok);
      if (range) {
        var nsA = nsOf(range[1]), nsB = range[3] ? nsOf(range[3]) : nsA;
        if (nsA !== nsB) { errors.push("\"" + tok + "\" mixes namespaces across a range."); return; }
        var a = Number(range[2]), b = Number(range[4]);
        if (b < a) { errors.push("\"" + tok + "\" is a reversed range."); return; }
        if (b - a > 20000) { errors.push("\"" + tok + "\" spans more than 20000 ids."); return; }
        for (var i = a; i <= b; i++) push(nsA, i);
        return;
      }
      var one = /^(EL|E|N|L)?\s*(\d+)$/i.exec(tok);
      if (one) { push(nsOf(one[1]), Number(one[2])); return; }
      errors.push("\"" + tok + "\" is not an item. Write an element as 12, a node " +
        "as N12, a general link as L12, an elastic link as EL12 — or a range such " +
        "as 15to20.");
    });
    return { members: members, errors: errors };

    function nsOf(prefix) { return NS_PREFIX[String(prefix || "").toUpperCase()] || "elem"; }
    function push(ns, id) {
      var key = NS_WRITE[ns] + id;
      if (seen[key]) return;
      seen[key] = true;
      members.push({ ns: ns, id: id, key: key });
    }
  }

  function memberLabel(m) { return NS_WRITE[m.ns] + m.id; }
  function keyOf(ns, id) { return NS_WRITE[ns] + id; }

  /* ------------------------------------------------------ classification -- */

  /**
   * Route every member of the set to the source(s) that report on it.
   *
   * @param {Array} members  from parseSet
   * @param {Object} model   { elems, links, elinks, nodes } — the /db/ rows, any of them null
   * @returns {{groups, unsupported, missing, collisions, byKey}}
   *          groups is keyed by SOURCE id, each an array of members
   */
  function classify(members, model) {
    model = model || {};
    var groups = Object.create(null);
    SOURCE_ORDER.forEach(function (sid) { groups[sid] = []; });
    var unsupported = [], missing = [], collisions = [], byKey = Object.create(null);

    var tables = {
      elem: model.elems, node: model.nodes, link: model.links, elink: model.elinks
    };

    members.forEach(function (m) {
      var here = tables[m.ns];
      var row = here && here[String(m.id)];

      if (!row) {
        missing.push({ member: m, reason: reasonFor(m, tables) });
        return;
      }

      /* Record every OTHER namespace this number also exists in. The id spaces
         collide, so silence here is how a set addresses the wrong objects. */
      Object.keys(tables).forEach(function (ns) {
        if (ns === m.ns) return;
        if (tables[ns] && tables[ns][String(m.id)]) {
          collisions.push({ id: m.id, taken: m.ns, also: ns });
        }
      });

      if (m.ns === "elem") {
        var type = String(row.TYPE || "").toUpperCase();
        var route = ELEM_ROUTING[type];
        if (!route) {
          unsupported.push({ member: m, type: type || "(no TYPE)",
            reason: "element type " + (type || "(none)") + " is not one this plugin " +
              "reports on. It reports beam, truss and plate elements, general and " +
              "elastic links, and node reactions and displacements." });
          return;
        }
        if (!route.source) {
          unsupported.push({ member: m, type: type,
            reason: route.label + " elements have no result table this plugin reads. " +
              "Remove them from the set." });
          return;
        }
        add(m, route.source, route.label, row);
        return;
      }

      /* A node belongs to BOTH node sources; their columns are disjoint, so the
         two reads merge onto one row per node. */
      sourcesFor(m.ns).forEach(function (sid) {
        add(m, sid, NS_LABEL[m.ns], row);
      });
    });

    return { groups: groups, unsupported: unsupported, missing: missing,
             collisions: collisions, byKey: byKey };

    function add(m, sourceId, typeLabel, row) {
      var rec = { ns: m.ns, id: m.id, key: m.key, source: sourceId,
                  typeLabel: typeLabel, row: row };
      groups[sourceId].push(rec);
      /* byKey holds the FIRST source for an item, which is the one a driver
         defaults to; sources[] holds them all. */
      if (!byKey[m.key]) byKey[m.key] = { ns: m.ns, id: m.id, key: m.key,
                                          typeLabel: typeLabel, sources: [] };
      byKey[m.key].sources.push(sourceId);
      if (!byKey[m.key].source) byKey[m.key].source = sourceId;
    }
  }

  function reasonFor(m, tables) {
    var elsewhere = Object.keys(tables).filter(function (ns) {
      return ns !== m.ns && tables[ns] && tables[ns][String(m.id)];
    });
    var base = "no " + NS_LABEL[m.ns] + " " + m.id + " in the model";
    if (!elsewhere.length) return base;
    return base + " (there IS " + article(NS_LABEL[elsewhere[0]]) + " " +
      NS_LABEL[elsewhere[0]] + " " + m.id + " — write it " +
      keyOf(elsewhere[0], m.id) + " to mean that one)";
  }

  function article(word) { return /^[aeiou]/i.test(String(word)) ? "an" : "a"; }

  /* ----------------------------------------------------- column resolution */

  /* Matching is on a normalised form — lowercased, punctuation removed — so
     "Shear-y", "Shear y" and "SHEAR_Y" land on the same column. */
  var SYNONYMS = {
    "Axial":    ["Axial", "Axial Force", "Force", "Fx", "N"],
    "Shear-y":  ["Shear-y", "Shear y", "Shear_y", "Fy", "Vy"],
    "Shear-z":  ["Shear-z", "Shear z", "Shear_z", "Fz", "Vz"],
    "Torsion":  ["Torsion", "Torque", "Mx", "T"],
    "Moment-y": ["Moment-y", "Moment y", "Moment_y", "My"],
    "Moment-z": ["Moment-z", "Moment z", "Moment_z", "Mz"]
  };

  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, ""); }

  /**
   * Find a table's columns by NAME, given the roles a source needs.
   *
   * @param {Array} head
   * @param {Object} roles  { item: [names], part: [names]|null, load, stage, step,
   *                          components: [column names] }
   * @returns {{index, unresolved, head}}  index keys: item, part, Load, Stage,
   *          Step and each component column
   */
  function resolveColumns(head, roles) {
    /* Both forms of each header are kept: the normalised one for matching, and
       the raw one so a header that carries its unit — "Moment-y (kN*m)" — can
       still be recognised. */
    var heads = (head || []).map(function (h, i) {
      return { i: i, raw: String(h == null ? "" : h).toLowerCase().trim(), norm: norm(h) };
    });
    var lookup = Object.create(null);
    heads.forEach(function (h) { if (!(h.norm in lookup)) lookup[h.norm] = h.i; });

    var index = Object.create(null);
    var unresolved = [];          /* required roles that were not found */
    var missing = [];             /* component columns that were not found */
    var used = Object.create(null);

    /* The item column is claimed FIRST, so a plate table whose part column is
       also called "Node" cannot have its item column stolen by the part role,
       and a node table — where the item is "Node" and there is no part — does
       not end up reporting the node number as its own output position. */
    take("item", roles.item || ITEM_COLS, "required");
    if (roles.part) take("part", roles.part, "optional");
    take("Load", ["Load", "Load Name", "Load Case", "LoadCase"], "required");
    take("Stage", ["Stage", "Const. Stage", "Construction Stage", "CS"], "optional");
    take("Step", ["Step", "Step No"], "optional");
    (roles.components || []).forEach(function (c) {
      take(c, SYNONYMS[c] || [c], "component");
    });

    return { index: index, unresolved: unresolved, missing: missing,
             head: (head || []).slice() };

    function take(role, names, level) {
      var i, k;
      /* Pass 1: the header is exactly one of the names we know. */
      for (i = 0; i < names.length; i++) {
        k = norm(names[i]);
        if (k in lookup && !used[k]) { used[k] = true; index[role] = lookup[k]; return; }
      }
      /* Pass 2: the header is one of them WITH ITS UNIT APPENDED. Matched on
         the raw header with a boundary check, so "Fx" cannot quietly claim a
         plate's "Fxx" — which would put an in-plane force under an axial
         heading and never say a word about it. */
      for (i = 0; i < names.length; i++) {
        var want = String(names[i]).toLowerCase().trim();
        if (want.length < 2) continue;
        for (var h = 0; h < heads.length; h++) {
          var got = heads[h];
          if (used[got.norm]) continue;
          if (got.raw.length <= want.length) continue;
          if (got.raw.slice(0, want.length) !== want) continue;
          if (!/[\s(\[]/.test(got.raw.charAt(want.length))) continue;
          used[got.norm] = true;
          index[role] = got.i;
          return;
        }
      }
      if (level === "required") unresolved.push(role);
      else if (level === "component") missing.push(role);
    }
  }

  var api = {
    SOURCES: SOURCES, SOURCE_ORDER: SOURCE_ORDER, ELEM_ROUTING: ELEM_ROUTING,
    MEMBER_FORCES: MEMBER_FORCES, UNITS: UNITS, SYNONYMS: SYNONYMS,
    NS_LABEL: NS_LABEL, NS_WRITE: NS_WRITE,
    unitLabel: unitLabel, sourcesFor: sourcesFor, allComponents: allComponents,
    findComponent: findComponent, parseSet: parseSet, memberLabel: memberLabel,
    keyOf: keyOf, classify: classify, resolveColumns: resolveColumns, norm: norm
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfElements = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
