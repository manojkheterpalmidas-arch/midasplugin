/* ==========================================================================
   Concurrent Forces — the diagnostics report
   --------------------------------------------------------------------------
   Pure. Turns what the plugin learned about a model into one plain-text block
   the user can copy and paste back.

   Why this exists: the API's behaviour differs between builds in ways no
   documentation settles — which table tokens exist, what the HEAD columns are
   called, which tokens the Part column carries. When a run fails on a model
   nobody else can reach, the fastest possible fix is for the plugin itself to
   report the evidence, rather than for the next hour to go on guesses passed
   back and forth.

   It prints what was OBSERVED and never what was assumed. Every line here is
   something the API actually returned.
   ========================================================================== */
(function (root) {
  "use strict";

  function mod(file, name) {
    if (root[name]) return root[name];
    if (typeof require === "function") return require("./" + file);
    throw new Error(file + " must load before diag.js");
  }

  var RULE = "----------------------------------------------------------------";

  /**
   * @param {Object} d
   *   version    plugin version string
   *   base       the resolved endpoint
   *   baseInfo   { tried, changed, resolved } from Mapi.resolveBase
   *   model      the object readModel returned, or null
   *   probes     [{ source, item, token, tried, head, sample, resolved,
   *                 missing, parts, series, error }]
   *   lastError  { message, hint } or null
   *   lastRun    { effect, criterion, position, key, rows, calls, warnings } or null
   *   generated  ISO timestamp
   */
  function buildDiagnostics(d) {
    var El = mod("elements.js", "CfElements");
    var out = [];
    var p = function (line) { out.push(line == null ? "" : String(line)); };

    p("Concurrent Forces — diagnostics");
    p("plugin version : " + (d.version || "?"));
    p("generated      : " + (d.generated || "?"));
    p(RULE);

    /* ------------------------------------------------------------ endpoint */
    p("ENDPOINT");
    p("  in use       : " + (d.base || "(not connected)"));
    if (d.baseInfo && d.baseInfo.tried) {
      d.baseInfo.tried.forEach(function (t) {
        p("  tried        : " + t.base + "  ->  " + t.status);
      });
      if (d.baseInfo.changed) {
        p("  NOTE         : the host's own base did not serve /db/; the program " +
          "segment was added.");
      }
      if (d.baseInfo.resolved === false) {
        p("  NOTE         : nothing answered at any candidate.");
      }
    }
    p("");

    /* --------------------------------------------------------------- model */
    if (d.model) {
      p("MODEL");
      var u = d.model.units || {};
      p("  units        : " + u.FORCE + ", " + u.DIST + "  (" + u.source + ")");
      p("  stages       : " + (d.model.stages || []).length);
      (d.model.stages || []).forEach(function (st) {
        p("    " + st.name + "  bSV_STEP=" + st.savesSteps + "  steps: " +
          st.steps.map(function (x) { return x.token; }).join(", "));
      });
      p("  groups       : " + (d.model.groups || []).length);
      (d.model.groups || []).slice(0, 12).forEach(function (g) {
        p("    " + g.name + "  " + g.elements.length + " element(s)" +
          (g.elementKey ? "  from " + g.elementKey : "") +
          (g.note ? "  — " + g.note : ""));
      });
      p("  tables read  :");
      (d.model.summary || []).forEach(function (r) {
        p("    " + pad(r.label, 30) + pad(r.status, 8) +
          (r.status === "ok" ? String(r.count) : "") +
          (r.note ? "  " + r.note : ""));
      });
      p("");
    }

    /* -------------------------------------------------------- the tables */
    p("RESULT TABLES — what this build actually returned");
    p("");
    (d.probes || []).forEach(function (pr) {
      var src = El.SOURCES[pr.source] || { label: pr.source, tokens: [] };
      p("  [" + pr.source + "] " + src.label);
      if (pr.skipped) { p("    skipped     : " + pr.skipped); p(""); return; }
      p("    probed with : item " + pr.item);
      if (pr.tried && pr.tried.length) {
        pr.tried.forEach(function (t) {
          p("    token tried : " + t.token + "  ->  " + shorten(t.message, 90));
        });
      }
      if (pr.error) { p("    ERROR       : " + shorten(pr.error, 200)); p(""); return; }
      p("    token       : " + pr.token);
      p("    HEAD        : " + (pr.head || []).join(" | "));
      p("    resolved    : " + Object.keys(pr.resolved || {}).map(function (k) {
        return k + "=" + pr.resolved[k];
      }).join(", "));
      p("    NOT FOUND   : " + ((pr.missing || []).length ? pr.missing.join(", ") : "none"));
      if (pr.parts && pr.parts.length) {
        p("    part tokens : " + pr.parts.map(function (x) {
          return "\"" + x + "\""; }).join(", "));
      }
      if (pr.sample) p("    sample row  : " + JSON.stringify(pr.sample));
      if (pr.series) {
        p("    publishes   : " + pr.series.length + " series" +
          (pr.series.length ? " — " + pr.series.slice(0, 12).join(", ") +
            (pr.series.length > 12 ? ", …" : "") : ""));
      }
      p("");
    });

    /* ----------------------------------------------------------- last run */
    if (d.lastRun) {
      p("LAST RUN");
      p("  key item     : " + d.lastRun.keyElemKey);
      p("  key effect   : " + d.lastRun.effect);
      p("  criterion    : " + d.lastRun.criterion + "   position: " + d.lastRun.position);
      p("  governing    : " + d.lastRun.key);
      p("  rows         : " + d.lastRun.rows);
      (d.lastRun.calls || []).forEach(function (c) {
        p("  call         : " + c.source + " via " + c.token +
          (c.optCs ? " [CS " + c.stageStep + "]" : " [static/CB]") +
          "  ->  " + (c.got ? "rows" : "NOTHING"));
      });
      (d.lastRun.warnings || []).forEach(function (w) { p("  note         : " + shorten(w, 200)); });
      p("");
    }

    if (d.lastError) {
      p("LAST ERROR");
      p("  " + d.lastError.message);
      if (d.lastError.hint) p("  hint: " + d.lastError.hint);
      p("");
    }

    p(RULE);
    p("Nothing above is assumed — every line is something the API returned.");
    return out.join("\n");
  }

  function pad(s, n) {
    s = String(s == null ? "" : s);
    while (s.length < n) s += " ";
    return s;
  }

  function shorten(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  var api = { buildDiagnostics: buildDiagnostics };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfDiag = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
