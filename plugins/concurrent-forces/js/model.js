/* ==========================================================================
   Concurrent Forces — model reader
   --------------------------------------------------------------------------
   Pure apart from the Mapi object handed in, so `node test/run.js` exercises
   the whole read against the mock over real HTTP.

   Two things this file is careful about.

   1. IT DOES NOT GUESS ENDPOINT NAMES. The load-case tables for moving load,
      settlement, response spectrum and time history are spelled differently
      per design code and per build, so each is PROBED: 404 means this build has
      no such key, HTTP 200 {"message":""} means the build has it and the model
      holds none, and rows mean use it. What was found is reported to the user
      rather than assumed.

      Nothing about the blocking rules depends on those probes succeeding. The
      analysis kind of every constituent is carried by `ANAL` on the parent
      combination's own vCOMB record, and confirmed a second time by the
      (MV)/(SM)/(RS) suffix on the result label. The case tables only make the
      selection list nicer.

   2. A SKIPPED READ SAYS WHY. "not read — the model has no elements" is a
      weaker and more honest claim than "not defined", and it is filed under the
      existing "empty" status rather than a new one, so downstream code testing
      for known statuses does not mis-handle every skip.
   ========================================================================== */
(function (root) {
  "use strict";

  var Combos = root.CfCombos || (typeof require === "function" ? require("./combos.js") : null);

  /* Tables read by key, unconditionally or on a stated dependency. */
  var CORE = [
    { key: "ELEM", label: "Elements" },
    { key: "GRUP", label: "Structure groups" },
    { key: "STLD", label: "Static load cases" },
    { key: "STAG", label: "Construction stages" },
    { key: "UNIT", label: "Unit system" }
  ];

  /* Tables whose KEY is not settled across builds. Each candidate is tried in
     order; the first that does not answer 404 is the one this build has. */
  var PROBES = [
    { id: "GENLINK", label: "General links", kind: null,
      candidates: ["GLNK", "GENLINK", "GLINK"] },
    { id: "MV", label: "Moving load cases", kind: "MV",
      candidates: ["MVLDBS", "MVLDAASH", "MVLDEURO", "MVLDKR", "MVLDCH", "MVLDIRC", "MVLD"] },
    { id: "SM", label: "Settlement load cases", kind: "SM",
      candidates: ["SMLC", "STLDSM", "SMGR"] },
    { id: "RS", label: "Response spectrum load cases", kind: "RS",
      candidates: ["RSLC", "SPLC", "RSCASE"] },
    { id: "TH", label: "Time history load cases", kind: "TH",
      candidates: ["THLC", "THLCASE", "THIST"] }
  ];

  function count(rows) { return rows ? Object.keys(rows).length : 0; }

  /**
   * Read everything the plugin needs to populate its panel.
   *
   * @param {Mapi} mapi
   * @param {Function} [onProgress] (done, total, label)
   */
  async function readModel(mapi, onProgress) {
    var tables = Object.create(null);
    var probes = Object.create(null);
    var steps = CORE.length + PROBES.length + Combos.LCOM_TABLES.length;
    var done = 0;

    function tick(label) { if (onProgress) onProgress(done++, steps, label); }

    for (var i = 0; i < CORE.length; i++) {
      tick(CORE[i].label);
      tables[CORE[i].key] = await mapi.db(CORE[i].key);
    }

    /* All ten combination tables. A plugin that means "every combination" and
       reads only LCOM-GEN loses the steel, concrete and seismic families
       without a word. */
    var combos = [];
    for (var c = 0; c < Combos.LCOM_TABLES.length; c++) {
      var key = Combos.LCOM_TABLES[c];
      tick("Combinations · " + key);
      var t = await mapi.db(key);
      tables[key] = t;
      if (t.status === "ok") combos.push({ table: key, rows: t.rows });
    }

    for (var p = 0; p < PROBES.length; p++) {
      tick(PROBES[p].label);
      probes[PROBES[p].id] = await probe(mapi, PROBES[p]);
    }
    if (onProgress) onProgress(steps, steps, "done");

    var caseTables = PROBES.filter(function (d) { return d.kind; })
      .map(function (d) { return probes[d.id]; })
      .filter(function (r) { return r.rows; })
      .map(function (r) { return { table: r.key, kind: r.kind, rows: r.rows }; });

    return {
      tables: tables,
      combos: combos,
      probes: probes,
      caseTables: caseTables,
      elems: tables.ELEM.status === "ok" ? tables.ELEM.rows : null,
      links: probes.GENLINK.rows,
      groups: structureGroups(tables.GRUP),
      stages: stages(tables.STAG),
      units: units(tables.UNIT),
      summary: summarise(tables, probes),
      analysed: null              /* settled by the first result query, not here */
    };
  }

  /**
   * Try each candidate key until one is not 404.
   *
   * 404 means the BUILD has no such key. HTTP 200 {"message":""} means it has
   * the key and the model holds nothing of that kind — the two are opposite
   * facts and most plugins have them the wrong way round.
   */
  async function probe(mapi, spec) {
    var tried = [];
    for (var i = 0; i < spec.candidates.length; i++) {
      var key = spec.candidates[i];
      var r = await mapi.db(key);
      tried.push({ key: key, status: r.status });
      if (r.status === "absent") continue;
      return {
        id: spec.id, kind: spec.kind, label: spec.label, key: key,
        status: r.status, rows: r.status === "ok" ? r.rows : null, tried: tried
      };
    }
    return {
      id: spec.id, kind: spec.kind, label: spec.label, key: null,
      status: "absent", rows: null, tried: tried
    };
  }

  /* ------------------------------------------------------------- accessors */

  /** Structure groups that contain at least one element, for the picker. */
  function structureGroups(t) {
    if (!t || t.status !== "ok") return [];
    var out = [];
    Object.keys(t.rows).forEach(function (id) {
      var g = t.rows[id];
      var list = (g.E_LIST || []).map(Number).filter(function (n) { return n > 0; });
      if (!g.NAME) return;
      out.push({ id: id, name: String(g.NAME), elements: list });
    });
    return out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  /**
   * Construction stages and the step tokens each one actually publishes.
   *
   * STEP TOKENS FOLLOW bSV_STEP. Where it is false — the default — only the
   * last step exists, and offering "first" produces an empty table that reads
   * like a missing analysis option and sends the user hunting in the wrong
   * place.
   */
  function stages(t) {
    if (!t || t.status !== "ok") return [];
    return Object.keys(t.rows).map(function (id) {
      var s = t.rows[id];
      var name = String(s.NAME || id);
      var saved = s.bSV_STEP === true;
      var tokens = saved ? ["001(first)", "002(last)"] : ["002(last)"];
      return {
        id: id, name: name, savesSteps: saved,
        steps: tokens.map(function (tok) {
          return { token: name + ":" + tok, label: name + " · " + tok };
        })
      };
    });
  }

  /* MIDAS accepts its own spellings on the UNIT argument; the model's own unit
     record uses upper case. Map what is read onto what may be sent. */
  var FORCE_UNITS = ["N", "kN", "kgf", "tonf", "lbf", "kips"];
  var DIST_UNITS = ["mm", "cm", "m", "in", "ft"];

  function pickUnit(value, list, fallback) {
    var v = String(value == null ? "" : value).trim().toLowerCase();
    for (var i = 0; i < list.length; i++) {
      if (list[i].toLowerCase() === v) return list[i];
    }
    return fallback;
  }

  /**
   * The model's own unit system, used to default the dropdowns.
   *
   * Read tolerantly: this record's shape is not settled across builds, so the
   * result says whether it was READ or DEFAULTED and the UI shows which. A
   * silently wrong default here would rescale every number in the report.
   */
  function units(t) {
    var fallback = { FORCE: "kN", DIST: "m", source: "defaulted — the model's unit " +
      "system could not be read, so kN and m are assumed. Set them if that is wrong." };
    if (!t || t.status !== "ok") return fallback;
    var ids = Object.keys(t.rows);
    for (var i = 0; i < ids.length; i++) {
      var row = t.rows[ids[i]];
      if (!row || typeof row !== "object") continue;
      var force = null, dist = null;
      Object.keys(row).forEach(function (k) {
        var lk = k.toLowerCase();
        if (!force && (lk === "force" || lk === "unit_force")) force = row[k];
        if (!dist && (lk === "dist" || lk === "length" || lk === "unit_dist")) dist = row[k];
      });
      if (force || dist) {
        return {
          FORCE: pickUnit(force, FORCE_UNITS, "kN"),
          DIST: pickUnit(dist, DIST_UNITS, "m"),
          source: "read from the model"
        };
      }
    }
    return fallback;
  }

  /* -------------------------------------------------------------- summary */

  function summarise(tables, probes) {
    var out = [];
    CORE.forEach(function (ep) { out.push(line(ep.key, ep.label, tables[ep.key])); });
    Combos.LCOM_TABLES.forEach(function (k) { out.push(line(k, "Combinations · " + k, tables[k])); });
    PROBES.forEach(function (spec) {
      var r = probes[spec.id];
      out.push({
        key: spec.id, label: spec.label,
        count: r.rows ? count(r.rows) : 0,
        status: r.status,
        note: r.key
          ? (r.status === "ok" ? "read from /db/" + r.key
                               : "none in this model (/db/" + r.key + " is empty)")
          : "not in this build — tried " + r.tried.map(function (t) { return t.key; }).join(", ")
      });
    });
    return out;
  }

  function line(key, label, t) {
    t = t || { status: "empty" };
    return {
      key: key, label: label,
      count: t.status === "ok" ? count(t.rows) : 0,
      status: t.status,
      note: t.status === "ok" ? ""
          : t.status === "empty" ? "none in this model"
          : t.status === "absent" ? "table key not recognised by this build (plugin bug)"
          : "read failed — " + (t.reason || "unspecified")
    };
  }

  var api = {
    CORE: CORE, PROBES: PROBES, FORCE_UNITS: FORCE_UNITS, DIST_UNITS: DIST_UNITS,
    readModel: readModel, probe: probe, structureGroups: structureGroups,
    stages: stages, units: units, summarise: summarise
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
