/* ==========================================================================
   Beam to Plate — connecting the mesh to the rest of the model
   --------------------------------------------------------------------------
   Pure. Decides three things from the tables and the mesh:

   1. WHERE RIGID LINKS ARE NEEDED. A plate mesh replaces a beam between two
      nodes; everything else in the model still meets those nodes. A link is
      written at an end when the node carries anything else — a support, a
      spring, a nodal load, another element, an existing link — or when two
      converted beams meet there with meshes that do not share their nodes
      (different sections, a kink, a taper), or when the beam has an end offset
      so the mesh starts away from the node.

      A free end with nothing on it gets no link: a link there would only
      stiffen the section for no reason.

   2. WHICH GROUPS THE NEW PLATES JOIN. Every structure group that held a
      converted beam gets its plates and nodes, so construction stages keep
      working. GRUP writes MERGE their lists (verified live), so only the new
      ids are sent.

   3. WHAT STILL POINTS AT THE BEAM. Tendons, lanes, stage section changes,
      stiffness factors, temperature gradients and prestress all reference
      elements. They cannot follow a beam into plates, so every one of them is
      listed against the element it belongs to — deleting the beam would take
      them with it silently.
   ========================================================================== */
(function (root) {
  "use strict";

  /* Tables that reference NODES — a node carrying any of these must keep its
     place in the model, so the mesh is linked to it. */
  var NODE_TABLES = ["CONS", "NSPR", "GSPR", "SSPS", "CNLD", "SDSP", "NMAS", "SKEW", "NTMP", "NBOF"];

  /* Tables that reference ELEMENTS and CANNOT be carried over to plates. Each
     is listed with what it is, for the warning the user reads. */
  /* [table, what it is, keyedByElement]. The third flag matters: some of these
     are keyed BY the element (a stiffness factor belongs to element 12, so the
     row key is 12) and some hold a LIST of elements under their own id (tendon 1
     runs over elements 12 to 18). Reading a tendon's row key as an element id
     reports the wrong number — and looks right. */
  var ELEMENT_TABLES = [
    ["TDNA", "tendon profiles", false],
    ["TDPL", "tendon prestress loads", false],
    ["PRST", "prestress beam loads", true],
    ["LLAN", "traffic line lanes", false],
    ["LLANID", "traffic line lanes (India)", false],
    ["LLANCH", "traffic line lanes (China)", false],
    ["SLAN", "traffic surface lanes", false],
    ["CSCS", "composite sections for construction stage", true],
    ["PLCB", "pre-composite section data", true],
    ["ESSF", "element stiffness scale factors", true],
    ["EWSF", "effective width scale factors", true],
    ["GTMP", "temperature gradients", true],
    ["BTMP", "beam section temperatures", true],
    ["IEHG", "inelastic hinge assignments", true],
    ["FIBR", "fibre divisions", true],
    ["EDMP", "change-property assignments", true],
    ["DYNF", "railway dynamic factors by element", true],
    ["TSGR", "tapered section groups", false],
    ["CMCS", "construction-stage camber", true],
    ["VBEM", "virtual beams for resultant forces", false]
  ];

  /* Tables that reference elements and ARE carried over. */
  var CARRIED = { BMLD: "beam loads", ETMP: "element temperatures", GRUP: "structure groups",
                  FRLS: "beam end releases", OFFS: "beam end offsets" };

  function rowsOf(tables, key) {
    var t = tables[key];
    return (t && t.rows) || null;
  }

  /** Every node id referenced by something other than the converted beams. */
  function nodeReferences(tables, convertedIds) {
    var ref = Object.create(null);
    function mark(id, what) {
      var k = String(id);
      (ref[k] || (ref[k] = [])).push(what);
    }
    NODE_TABLES.forEach(function (key) {
      var rows = rowsOf(tables, key);
      if (!rows) return;
      Object.keys(rows).forEach(function (id) { mark(id, key); });
    });
    /* links: both ends matter, and a node that is already a master or a slave
       must not become a slave of ours as well */
    var rigd = rowsOf(tables, "RIGD");
    if (rigd) {
      Object.keys(rigd).forEach(function (master) {
        mark(master, "RIGD master");
        (rigd[master].ITEMS || []).forEach(function (it) {
          (it.S_NODE || []).forEach(function (s) { mark(s, "RIGD slave"); });
        });
      });
    }
    ["ELNK", "NLNK"].forEach(function (key) {
      var rows = rowsOf(tables, key);
      if (!rows) return;
      Object.keys(rows).forEach(function (id) {
        (rows[id].NODE || []).forEach(function (n) { if (Number(n) > 0) mark(n, key); });
      });
    });
    /* elements that are NOT being converted */
    var elems = rowsOf(tables, "ELEM") || {};
    Object.keys(elems).forEach(function (id) {
      if (convertedIds[String(id)]) return;
      (elems[id].NODE || []).forEach(function (n) { if (Number(n) > 0) mark(n, "element " + id); });
    });
    return ref;
  }

  /**
   * Plan the rigid links.
   *
   * @param meshes  [{ elem, mesh }] — elem carries { id, nodeIds:[i,j], offsetEnds }
   * @param tables  the model tables
   * @param opts    { linkAll, boundaryGroup }
   * @returns {{ links: [{ node, slaves:[poolIdx], reasons:[] }], freeEnds: [], conflicts: [] }}
   */
  function planLinks(meshes, tables, convertedIds, opts) {
    opts = opts || {};
    var refs = nodeReferences(tables, convertedIds);
    var byNode = Object.create(null);
    meshes.forEach(function (m) {
      ["I", "J"].forEach(function (end) {
        var nodeId = String(m.elem.nodeIds[end === "I" ? 0 : 1]);
        (byNode[nodeId] || (byNode[nodeId] = [])).push({ m: m, end: end });
      });
    });

    var links = [], freeEnds = [], conflicts = [];
    Object.keys(byNode).forEach(function (nodeId) {
      var here = byNode[nodeId];
      var reasons = [];
      if (refs[nodeId]) reasons.push(uniq(refs[nodeId]).join(", "));
      /* meshes that meet here but do not share their end nodes */
      if (here.length > 1) {
        var sets = here.map(function (h) { return h.m.mesh.endNodes[h.end].slice().sort(numeric).join(","); });
        if (uniq(sets).length > 1) reasons.push("the meshes meeting here do not share their end nodes");
      }
      if (here.some(function (h) { return h.m.elem.offsetEnd && h.m.elem.offsetEnd[h.end]; })) {
        reasons.push("the beam has an end offset, so its mesh starts away from the node");
      }
      if (opts.linkAll && !reasons.length) reasons.push("every end is linked (option)");
      if (!reasons.length) {
        freeEnds.push({ node: nodeId, elements: here.map(function (h) { return h.m.elem.id; }) });
        return;
      }
      var slaves = [];
      here.forEach(function (h) {
        h.m.mesh.endNodes[h.end].forEach(function (idx) { if (slaves.indexOf(idx) === -1) slaves.push(idx); });
      });
      /* a node that is already a slave of another rigid link cannot be our
         master as well — MIDAS resolves chains badly, so say so */
      if ((refs[nodeId] || []).indexOf("RIGD slave") !== -1) {
        conflicts.push({ node: nodeId, what: "this node is already the slave of another rigid link; " +
          "the new link makes it a master as well, which MIDAS may refuse" });
      }
      links.push({ node: nodeId, slaves: slaves, reasons: uniq(reasons),
                   elements: here.map(function (h) { return h.m.elem.id; }) });
    });
    return { links: links, freeEnds: freeEnds, conflicts: conflicts };
  }

  /**
   * Section-internal ties (deck slab to girder, the two halves of a double
   * angle), minus the ones an end link already covers.
   */
  function planTies(meshes, links) {
    var covered = Object.create(null);
    links.forEach(function (l) { l.slaves.forEach(function (s) { covered[s] = true; }); });
    var seen = Object.create(null), out = [];
    meshes.forEach(function (m) {
      (m.mesh.connectors || []).forEach(function (c) {
        if (covered[c.slave] || covered[c.master]) return;
        if (seen[c.slave]) return;              /* one master per slave */
        seen[c.slave] = true;
        out.push({ master: c.master, slave: c.slave, source: c.source });
      });
    });
    /* group by master so one record per master node is written */
    var byMaster = Object.create(null), list = [];
    out.forEach(function (t) {
      if (!byMaster[t.master]) { byMaster[t.master] = { master: t.master, slaves: [] }; list.push(byMaster[t.master]); }
      byMaster[t.master].slaves.push(t.slave);
    });
    return list;
  }

  /** Groups that held a converted beam, with the plates and nodes to add. */
  function planGroups(tables, meshes, convertedIds) {
    var rows = rowsOf(tables, "GRUP");
    if (!rows) return [];
    var byElem = Object.create(null);
    meshes.forEach(function (m) { byElem[String(m.elem.id)] = m; });
    var out = [];
    Object.keys(rows).forEach(function (gid) {
      var g = rows[gid] || {};
      var members = (g.E_LIST || []).map(String).filter(function (e) { return convertedIds[e]; });
      if (!members.length) return;
      var nodes = Object.create(null), plates = [];
      members.forEach(function (e) {
        var m = byElem[e];
        if (!m) return;
        m.mesh.plates.forEach(function (p) {
          plates.push(p);
          p.nodes.forEach(function (n) { nodes[n] = true; });
        });
      });
      out.push({ id: gid, name: g.NAME, sourceElements: members,
                 plates: plates, nodes: Object.keys(nodes).map(Number) });
    });
    return out;
  }

  /**
   * Everything that still references a converted beam and cannot follow it.
   * @returns [{ table, label, elements:[id], count }]
   */
  function danglingReferences(tables, convertedIds) {
    var out = [];
    ELEMENT_TABLES.forEach(function (pair) {
      var key = pair[0], label = pair[1], keyedByElement = pair[2];
      var rows = rowsOf(tables, key);
      if (!rows) return;
      var hits = [];
      Object.keys(rows).forEach(function (id) {
        var row = rows[id];
        /* keyed by element id — only where the table IS keyed that way */
        if (keyedByElement && convertedIds[String(id)]) { hits.push(String(id)); return; }
        /* or holding a list of them */
        collectElementLists(row).forEach(function (e) {
          if (convertedIds[String(e)] && hits.indexOf(String(e)) === -1) hits.push(String(e));
        });
      });
      if (hits.length) out.push({ table: key, label: label, elements: hits, count: hits.length });
    });
    return out;
  }

  var LIST_KEYS = /^(ELEM|ELEMLIST|ELEM_LIST|E_LIST|ELEMENT_LIST|ELEMS)$/i;
  function collectElementLists(row, depth) {
    depth = depth || 0;
    var out = [];
    if (!row || typeof row !== "object" || depth > 4) return out;
    Object.keys(row).forEach(function (k) {
      var v = row[k];
      if (Array.isArray(v) && LIST_KEYS.test(k)) {
        v.forEach(function (e) { if (Number(e) > 0) out.push(Number(e)); });
      } else if (Array.isArray(v)) {
        v.forEach(function (x) { collectElementLists(x, depth + 1).forEach(function (e) { out.push(e); }); });
      } else if (v && typeof v === "object") {
        collectElementLists(v, depth + 1).forEach(function (e) { out.push(e); });
      }
    });
    return out;
  }

  /** The beam-end offsets of one element, as vectors from each node. */
  function endOffsets(offsRow, axes) {
    if (!offsRow || !offsRow.ITEMS || !offsRow.ITEMS.length) return null;
    var it = offsRow.ITEMS[0];
    var type = String(it.TYPE || "").toUpperCase();
    if (type === "GLOBAL") {
      return {
        I: [num(it.RGDXi), num(it.RGDYi), num(it.RGDZi)],
        J: [num(it.RGDXj), num(it.RGDYj), num(it.RGDZj)],
        type: "GLOBAL",
        /* verified by analysis: the element end is the NODE PLUS this vector */
        note: null
      };
    }
    /* ELEMENT type: rigid lengths along the member, given separately for the two
       bending planes. One mesh cannot start in two places, so the larger is used
       and the difference reported. */
    var yi = num(it.RGDYi), zi = num(it.RGDZi), yj = num(it.RGDYj), zj = num(it.RGDZj);
    var di = Math.max(yi, zi), dj = Math.max(yj, zj);
    return {
      I: [axes.ex[0] * di, axes.ex[1] * di, axes.ex[2] * di],
      J: [-axes.ex[0] * dj, -axes.ex[1] * dj, -axes.ex[2] * dj],
      type: "ELEMENT",
      note: (Math.abs(yi - zi) > 1e-12 || Math.abs(yj - zj) > 1e-12)
        ? "its end offsets differ between the two bending planes (" + yi + "/" + zi + " and " + yj + "/" + zj +
          "); the mesh uses the larger at each end"
        : null
    };
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function uniq(list) {
    var seen = Object.create(null), out = [];
    list.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
    return out;
  }
  function numeric(a, b) { return a - b; }

  var api = {
    NODE_TABLES: NODE_TABLES, ELEMENT_TABLES: ELEMENT_TABLES, CARRIED: CARRIED,
    nodeReferences: nodeReferences, planLinks: planLinks, planTies: planTies,
    planGroups: planGroups, danglingReferences: danglingReferences, endOffsets: endOffsets
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
