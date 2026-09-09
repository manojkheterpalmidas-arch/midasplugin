/* ==========================================================================
   Concurrent Forces — the element set
   --------------------------------------------------------------------------
   Pure. Parsing the set the user typed, classifying every member against
   /db/ELEM, routing each type to the result table that reports on it, and
   finding the columns of that table by NAME.

   Two rules from the estate that this module exists to keep:

   - HEAD columns differ per table. `Elem` / `Part` are not universal — the
     elastic link table uses `No.` and `Node`. Never index by position; find
     the columns by name and say which ones were not found.
   - A SELECTION MEMBER CARRIES ITS NAMESPACE. Element and link ids share a
     number space — 536 collisions on one real model — so a bare number that
     exists in both addresses the wrong object silently. A bare number here
     means an element; a link is written L<number>.
   ========================================================================== */
(function (root) {
  "use strict";

  /* /db/ELEM TYPE -> what the plugin does with it. Anything not listed is
     reported as unsupported by name rather than silently dropped. */
  var ELEM_ROUTING = {
    BEAM:     { group: "BEAM",  label: "beam" },
    TRUSS:    { group: "TRUSS", label: "truss" },
    TENSTR:   { group: "TRUSS", label: "tension-only truss" },
    COMPTR:   { group: "TRUSS", label: "compression-only truss" },
    PLATE:    { group: null, label: "plate" },
    PLSTRESS: { group: null, label: "plane stress" },
    PLSTRAIN: { group: null, label: "plane strain" },
    AXISYM:   { group: null, label: "axisymmetric" },
    SOLID:    { group: null, label: "solid" },
    WALL:     { group: null, label: "wall" }
  };

  /* The six components the user may nominate, and the column each one is under
     in the result table schema. */
  var COMPONENTS = [
    { id: "Fx", label: "Fx — axial",     column: "Axial" },
    { id: "Fy", label: "Fy — shear y",   column: "Shear-y" },
    { id: "Fz", label: "Fz — shear z",   column: "Shear-z" },
    { id: "Mx", label: "Mx — torsion",   column: "Torsion" },
    { id: "My", label: "My — moment y",  column: "Moment-y" },
    { id: "Mz", label: "Mz — moment z",  column: "Moment-z" }
  ];

  /* Which components each result table actually carries. A truss reports axial
     force only — the other five are not zero, they are ABSENT, and the table
     must say so rather than printing a blank cell that reads as "not computed". */
  var GROUP_COMPONENTS = {
    BEAM:    ["Axial", "Shear-y", "Shear-z", "Torsion", "Moment-y", "Moment-z"],
    TRUSS:   ["Axial"],
    GENLINK: ["Axial", "Shear-y", "Shear-z", "Torsion", "Moment-y", "Moment-z"]
  };

  var GROUP_LABEL = {
    BEAM: "beam elements", TRUSS: "truss elements", GENLINK: "general links"
  };

  var NOT_CARRIED = {
    TRUSS: "not carried — a truss element reports axial force only"
  };

  /* --------------------------------------------------------- set parsing -- */

  /**
   * Parse the element-set text.
   *
   *   "10, 12, 15to20"      elements 10, 12, 15…20
   *   "101-104"             a hyphen range works too
   *   "L5, L8to10"          general LINKS 5, 8…10 — the namespace is explicit
   *
   * Order is the order the user typed, which is the order the report sorts in.
   * Duplicates collapse onto their first appearance.
   *
   * @returns {{members: Array<{ns:string,id:number,key:string}>, errors: string[]}}
   */
  function parseSet(text) {
    var members = [], errors = [], seen = Object.create(null);
    var raw = String(text == null ? "" : text);
    raw.split(/[,;\n]+/).forEach(function (chunk) {
      var tok = chunk.trim();
      if (!tok) return;
      var m = /^([lL]?)\s*(\d+)\s*(?:to|-|~|\.\.)\s*([lL]?)\s*(\d+)$/.exec(tok);
      if (m) {
        var nsA = m[1] ? "link" : "elem";
        var nsB = m[3] ? "link" : "elem";
        if (m[3] && nsB !== nsA) {
          errors.push("\"" + tok + "\" mixes namespaces across a range.");
          return;
        }
        var a = Number(m[2]), b = Number(m[4]);
        if (b < a) { errors.push("\"" + tok + "\" is a reversed range."); return; }
        if (b - a > 20000) { errors.push("\"" + tok + "\" spans more than 20000 ids."); return; }
        for (var i = a; i <= b; i++) push(nsA, i);
        return;
      }
      var s = /^([lL]?)\s*(\d+)$/.exec(tok);
      if (s) { push(s[1] ? "link" : "elem", Number(s[2])); return; }
      errors.push("\"" + tok + "\" is not an element number, a range such as " +
        "15to20, or a link written L5.");
    });
    return { members: members, errors: errors };

    function push(ns, id) {
      var key = ns === "link" ? "L" + id : String(id);
      if (seen[key]) return;
      seen[key] = true;
      members.push({ ns: ns, id: id, key: key });
    }
  }

  /** Render a member the way the user typed it. */
  function memberLabel(m) { return m.ns === "link" ? "L" + m.id : String(m.id); }

  /* ------------------------------------------------------ classification -- */

  /**
   * Route every member of the set to the result table that reports on it.
   *
   * @param {Array} members     from parseSet
   * @param {Object} elemRows   /db/ELEM
   * @param {Object} linkRows   the general link table, or null if the model has none
   * @returns {{groups: Object, unsupported: Array, missing: Array, collisions: Array}}
   */
  function classify(members, elemRows, linkRows) {
    var groups = { BEAM: [], TRUSS: [], GENLINK: [] };
    var unsupported = [], missing = [], collisions = [], byKey = Object.create(null);

    members.forEach(function (m) {
      var inElem = elemRows && elemRows[String(m.id)];
      var inLink = linkRows && linkRows[String(m.id)];

      if (m.ns === "link") {
        if (!inLink) {
          missing.push({ member: m, reason: inElem
            ? "there is no general link " + m.id + " in the model (there is an " +
              "ELEMENT " + m.id + " — drop the L prefix to mean that one)"
            : "no general link " + m.id + " in the model" });
          return;
        }
        if (inElem) collisions.push(m.id);
        groups.GENLINK.push(record(m, "GENLINK", inLink, "general link"));
        return;
      }

      if (!inElem) {
        missing.push({ member: m, reason: inLink
          ? "no element " + m.id + " in the model (there IS a general link " + m.id +
            " — write it L" + m.id + " to mean that one)"
          : "no element " + m.id + " in the model" });
        return;
      }
      if (inLink) collisions.push(m.id);

      var type = String(inElem.TYPE || "").toUpperCase();
      var route = ELEM_ROUTING[type];
      if (!route) {
        unsupported.push({ member: m, type: type || "(no TYPE)",
          reason: "element type " + (type || "(none)") + " is not one this plugin reports on" });
        return;
      }
      if (!route.group) {
        unsupported.push({ member: m, type: type,
          reason: route.label + " elements do not produce member end forces — a " +
            "concurrent set cannot include them. Remove them from the set, or use " +
            "the plate/solid result tables directly." });
        return;
      }
      groups[route.group].push(record(m, route.group, inElem, route.label));
    });

    return { groups: groups, unsupported: unsupported, missing: missing,
             collisions: collisions, byKey: byKey };

    function record(m, group, row, label) {
      var r = { ns: m.ns, id: m.id, key: m.key, group: group, typeLabel: label, row: row };
      byKey[m.key] = r;
      return r;
    }
  }

  /* ----------------------------------------------------- column resolution */

  /* HEAD names as they have been seen, plus the obvious variants. Matching is
     on a normalised form (lowercased, punctuation removed) so "Shear-y",
     "Shear y" and "SHEAR_Y" all land on the same column. */
  var SYNONYMS = {
    Elem:       ["Elem", "Element", "No.", "No", "Elem No", "Element No"],
    Load:       ["Load", "Load Name", "Load Case", "LoadCase"],
    Stage:      ["Stage", "Const. Stage", "Construction Stage", "CS"],
    Step:       ["Step", "Step No"],
    Part:       ["Part", "Position", "Point", "Node", "Location"],
    "Axial":    ["Axial", "Axial Force", "Force", "Fx", "N"],
    "Shear-y":  ["Shear-y", "Shear y", "Shear_y", "Fy", "Vy"],
    "Shear-z":  ["Shear-z", "Shear z", "Shear_z", "Fz", "Vz"],
    "Torsion":  ["Torsion", "Torque", "Mx", "T"],
    "Moment-y": ["Moment-y", "Moment y", "Moment_y", "My"],
    "Moment-z": ["Moment-z", "Moment z", "Moment_z", "Mz"]
  };

  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, ""); }

  /**
   * Find the columns of a returned table by NAME.
   * @returns {{index: Object, unresolved: string[], head: string[]}}
   */
  function resolveColumns(head, wanted) {
    var index = Object.create(null), unresolved = [];
    var lookup = Object.create(null);
    (head || []).forEach(function (h, i) {
      var k = norm(h);
      if (!(k in lookup)) lookup[k] = i;
    });
    (wanted || []).forEach(function (name) {
      var cands = SYNONYMS[name] || [name];
      for (var i = 0; i < cands.length; i++) {
        var k = norm(cands[i]);
        if (k in lookup) { index[name] = lookup[k]; return; }
      }
      unresolved.push(name);
    });
    return { index: index, unresolved: unresolved, head: (head || []).slice() };
  }

  var api = {
    ELEM_ROUTING: ELEM_ROUTING, COMPONENTS: COMPONENTS,
    GROUP_COMPONENTS: GROUP_COMPONENTS, GROUP_LABEL: GROUP_LABEL,
    NOT_CARRIED: NOT_CARRIED, SYNONYMS: SYNONYMS,
    parseSet: parseSet, memberLabel: memberLabel, classify: classify,
    resolveColumns: resolveColumns, norm: norm
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfElements = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
