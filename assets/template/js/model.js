/* ==========================================================================
   MIDAS CIVIL NX plugin template — model reader
   --------------------------------------------------------------------------
   Pure apart from the Mapi object handed in, so `node test/run.js` can exercise
   the whole read against the mock. Keep the engineering here and in sibling
   modules; app.js should be wiring only.

   Two ideas worth keeping when you replace this with your own reader:

   1. ENDPOINTS declare what they NEED. A plugin that reads 47 tables to report
      on sections invites the complaint "I defined only sections and it read
      everything". `needs` is handed a function returning the row count of a
      table already read THIS run, and returns null to proceed or a short reason
      to skip. One forward pass — a `needs` may only look at keys above it.

   2. A skipped read is filed under the EXISTING "empty" status with a reason,
      not as a new status value. Downstream code that tests for known statuses
      would otherwise mis-handle every skip.
   ========================================================================== */
(function (root) {
  "use strict";

  var ENDPOINTS = [
    { key: "NODE", label: "Nodes" },
    { key: "ELEM", label: "Elements", needs: function (n) {
        return n("NODE") ? null : "no nodes in the model"; } },
    { key: "MATL", label: "Materials" },
    { key: "SECT", label: "Sections" },
    { key: "THIK", label: "Thicknesses" },
    { key: "GRUP", label: "Structure groups" },
    { key: "CONS", label: "Supports", needs: function (n) {
        return n("NODE") ? null : "no nodes in the model"; } },
    { key: "STLD", label: "Static load cases" },
    { key: "LCOM-GEN", label: "Load combinations", needs: function (n) {
        return n("STLD") ? null : "no load cases defined"; } }
  ];

  function count(rows) {
    return rows ? Object.keys(rows).length : 0;
  }

  /**
   * Read the model.
   * @param {Mapi} mapi
   * @param {Function} [onProgress] called as (done, total, label)
   * @returns {{tables: Object, summary: Array, read: number, skipped: number}}
   */
  async function readModel(mapi, onProgress) {
    var tables = {};
    var n = function (key) {
      var t = tables[key];
      return t && t.status === "ok" ? count(t.rows) : 0;
    };

    for (var i = 0; i < ENDPOINTS.length; i++) {
      var ep = ENDPOINTS[i];
      if (onProgress) onProgress(i, ENDPOINTS.length, ep.label);

      var skip = ep.needs ? ep.needs(n) : null;
      if (skip) {
        /* "not read — <reason>" is a weaker and more honest claim than
           "not defined", which the plugin has not established. */
        tables[ep.key] = { rows: null, status: "empty", skipped: skip };
        continue;
      }
      tables[ep.key] = await mapi.db(ep.key);
    }
    if (onProgress) onProgress(ENDPOINTS.length, ENDPOINTS.length, "done");

    return {
      tables: tables,
      summary: summarise(tables),
      read: ENDPOINTS.filter(function (e) { return !tables[e.key].skipped; }).length,
      total: ENDPOINTS.length
    };
  }

  /** Turn the raw tables into rows a renderer can walk without knowing the API. */
  function summarise(tables) {
    return ENDPOINTS.map(function (ep) {
      var t = tables[ep.key] || { status: "empty" };
      return {
        key: ep.key,
        label: ep.label,
        count: t.status === "ok" ? count(t.rows) : 0,
        status: t.status,
        /* Provenance, in the user's words rather than the API's. */
        note: t.skipped ? "not read — " + t.skipped
            : t.status === "ok" ? ""
            : t.status === "empty" ? "none in this model"
            : t.status === "absent" ? "table key not recognised by this build (plugin bug)"
            : "read failed — " + (t.reason || "unspecified")
      };
    });
  }

  /** Bounding box over /db/NODE, or null. Small example of a pure derivation. */
  function extents(nodeRows) {
    if (!nodeRows) return null;
    var ids = Object.keys(nodeRows);
    if (!ids.length) return null;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    ids.forEach(function (id) {
      var nd = nodeRows[id];
      [Number(nd.X) || 0, Number(nd.Y) || 0, Number(nd.Z) || 0].forEach(function (v, k) {
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      });
    });
    return { min: lo, max: hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
  }

  var api = { ENDPOINTS: ENDPOINTS, readModel: readModel, summarise: summarise, extents: extents };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.PlgModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
