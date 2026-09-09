/* ==========================================================================
   Concurrent Forces — wiring
   --------------------------------------------------------------------------
   DOM wiring only. Everything that computes lives in a pure module beside this
   one, so `node test/run.js` exercises the whole analysis without a browser.
   ========================================================================== */
(function (root) {
  "use strict";

  var Mapi = root.PlgMapi;
  var Model = root.CfModel;
  var Combos = root.CfCombos;
  var El = root.CfElements;
  var Conc = root.CfConcurrent;
  var Report = root.CfReport;
  var Run = root.CfRun;
  var Chart = root.CfChart;

  var S = {
    mapi: null, connected: false, model: null, loadModel: null,
    selection: Object.create(null), stageSteps: Object.create(null),
    blocked: Object.create(null), result: null, csv: ""
  };

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ host bridge */

  /** Post to the host bridge. Returns false when there is NO bridge, which is
   *  normal in a plain browser and a real fault inside CIVIL NX. Everything
   *  that talks to the host goes through here, so "is there a bridge" is asked
   *  in one place — a bare try/catch at each call site cannot tell a missing
   *  bridge from a thrown message. */
  function toHost(message) {
    var w = root.chrome && root.chrome.webview;
    if (!w || typeof w.postMessage !== "function") return false;
    try { w.postMessage(message); return true; }
    catch (e) { return false; }
  }

  function wireHost() {
    /* The host listens for REQ_EXIT and REQ_WND_MOVE. REQ_MOVE is IGNORED — a
       plugin sending it has a title bar that silently does nothing. */
    $("btn-close").addEventListener("click", function () {
      if (!toHost("REQ_EXIT")) {
        /* window.close() is a NO-OP in WebView2. On its own this branch is a
           button that fails silently, which is indistinguishable from one that
           was never wired. Try it for the plain-browser case, then SAY SO. */
        try { root.close(); } catch (e) { /* ignored */ }
      }
      /* If the host honoured REQ_EXIT the window is gone and this never runs. */
      setTimeout(function () {
        showError({
          message: "This window did not close.",
          hint: "The plugin asked the CIVIL NX host to close it (REQ_EXIT) and the " +
                "host did not act. Close the panel from CIVIL NX instead. In a plain " +
                "browser tab there is no host to ask, and this message is expected."
        });
      }, 800);
    });

    /* REQ_WND_MOVE only works from mousedown. From pointerdown the window
       simply will not drag, while REQ_EXIT from the same bridge keeps working,
       so the bridge looks healthy.

       Bound to #drag-surface, a SIBLING of the header controls, so a press on
       the close button is never part of the drag surface at all. */
    var drag = document.getElementById("drag-surface");
    if (drag) {
      drag.addEventListener("mousedown", function (e) {
        if (e.button !== 0 && e.button !== 1) return;
        if (e.target.closest && e.target.closest("button, input, select, nav, a")) return;
        toHost("REQ_WND_MOVE");
      });
    }
  }

  /* ---------------------------------------------------------- long work */

  /* THE MAIN THREAD IS THE UI THREAD. While it is blocked nothing repaints and
     NO CLICK IS DELIVERED — including the one on the close button. Parsing one
     large result body is enough, and on a 220-element set across forty
     combinations the body is large.

     The tell: it works on the small test model and is dead on a real one. A
     symptom that scales with model size is a blocking bug, not a wiring bug.

     Yield with a MessageChannel message, NOT setTimeout:
       - a resolved promise is a MICROtask and does not yield to input at all;
       - setTimeout(0) is CLAMPED TO ONE SECOND whenever the window is not
         visible, so a few hundred yields become minutes of pure waiting;
       - a MessageChannel message is a macrotask and is not throttled. */
  var yieldChannel = typeof MessageChannel === "function" ? new MessageChannel() : null;
  var yieldQueue = [];
  if (yieldChannel) {
    yieldChannel.port1.onmessage = function () {
      var fn = yieldQueue.shift();
      if (fn) fn();
    };
  }

  function yieldToUi() {
    return new Promise(function (resolve) {
      if (!yieldChannel) { setTimeout(resolve, 0); return; }
      yieldQueue.push(resolve);
      yieldChannel.port2.postMessage(0);
    });
  }

  /** Run `worker` over `items` in slices, yielding between them. Size the slice
   *  by how long ONE call takes, not by how tidy the number looks. */
  async function runChunked(items, size, worker, onProgress) {
    for (var i = 0; i < items.length; i += size) {
      await yieldToUi();
      if (onProgress) onProgress(i, items.length);
      await worker(items.slice(i, i + size));
    }
  }

  /* ------------------------------------------------------------- connection */

  function setStatus(state, text) {
    var badge = $("conn-badge");
    badge.className = "badge " + state;
    badge.textContent = text;
  }

  async function connect() {
    /* The host supplies both on the query string. A remembered base must never
       override ?redirectTo=. Neither is shown when the host supplied them —
       there is nothing for the user to decide, and a key is a credential. */
    var hostKey = Mapi.keyFromLocation(location.search);
    var key = hostKey || ($("in-key").value || "").trim();
    var base = hostKey ? Mapi.baseFromLocation(location.search)
                       : (($("in-base").value || "").trim() || Mapi.baseFromLocation(location.search));

    if (!key) {
      setStatus("warn", "No MAPI key");
      $("model-line").textContent = "No MAPI key was supplied. Inside CIVIL NX the " +
        "host provides one; outside it, paste one above.";
      return;
    }

    setStatus("neutral", "Connecting…");
    clearError();
    S.mapi = new Mapi.Mapi({ key: key, base: base });
    try {
      var info = await S.mapi.verify();

      /* SETTLE THE BASE BEFORE READING ANYTHING. Whether the host's redirectTo
         carries the program segment (/civil) is not something to assume, and
         guessing wrong fails in the most misleading way available:
         /mapikey/verify sits outside the segment so the connection check passes,
         and then every single /db/ read answers 404 — which is honestly
         reported as "the plugin used a wrong table key", once per table, for a
         whole model. One probe read settles it. */
      progress("Locating the API", 0);
      S.baseInfo = await S.mapi.resolveBase("ELEM");

      S.connected = true;
      setStatus("ok", "Connected · " + (info.program || "civil"));
      await loadModel();
    } catch (err) {
      S.connected = false;
      setStatus("bad", "Not connected");
      showError(err);
    }
  }

  async function loadModel() {
    progress("Reading the model", 0);
    S.model = await Model.readModel(S.mapi, function (done, total, label) {
      progress("Reading " + label, done / total);
    });

    /* The published-series enumeration: what the model ACTUALLY produced, as
       opposed to what its combinations name. It also carries the (MV)/(SM)/(RS)
       suffix, which is the cheap second check on a case whose kind the
       definitions never settled. It is best-effort — an un-analysed model has
       none, and that is reported rather than treated as a failure. */
    var published = [];
    try {
      var probe = firstProbeElement();
      if (probe) {
        published = await S.mapi.enumerateSeries({
          token: probe.token, keys: [probe.id], unit: currentUnits()
        });
        /* The construction-stage family is a different MODE, so it needs its
           own enumeration — asking for both at once returns one of them and
           drops the other at HTTP 200 with no error. */
        var firstStep = S.model.stages.length && S.model.stages[0].steps.length
          ? S.model.stages[0].steps[0].token : null;
        if (firstStep) {
          published = published.concat(await S.mapi.enumerateSeries({
            token: probe.token, keys: [probe.id], unit: currentUnits(),
            optCs: true, stageStep: firstStep
          }));
        }
      }
    } catch (e) {
      note("The model published no result series: " + e.message);
    }

    S.loadModel = Combos.buildLoadModel({
      stld: S.model.tables.STLD.status === "ok" ? S.model.tables.STLD.rows : null,
      combos: S.model.combos,
      caseTables: S.model.caseTables,
      publishedLabels: published
    });

    renderModelSummary();
    renderGroups();
    renderUnits();
    renderCases();
    renderStages();
    $("btn-run").disabled = false;
    progress(S.model.summary.length + " tables read · " + S.mapi.calls + " requests", 1);
  }

  /** One element to probe with — a beam if there is one, else anything routed. */
  function firstProbeElement() {
    var rows = S.model.elems;
    if (!rows) return null;
    var ids = Object.keys(rows);
    for (var i = 0; i < ids.length; i++) {
      var type = String(rows[ids[i]].TYPE || "").toUpperCase();
      var route = El.ELEM_ROUTING[type];
      if (route && route.source === "BEAM") return { id: Number(ids[i]), token: "BEAMFORCE" };
    }
    return null;
  }

  /* ----------------------------------------------------------------- render */

  function renderModelSummary() {
    var tbody = $("model-body");
    tbody.textContent = "";
    S.model.summary.forEach(function (row) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(row.label));
      tr.appendChild(cell(row.status === "ok" ? String(row.count) : "—", "num"));
      /* "not read" and "not in this build" are distinguished from a real zero.
         A tick over an empty population is a lie. */
      var note = cell(row.note || "read", "note");
      if (row.url) note.title = row.url;
      tr.appendChild(note);
      tbody.appendChild(tr);
    });

    var b = S.baseInfo || {};
    $("endpoint-line").textContent = "Endpoint: " + S.mapi.base +
      (b.changed ? "  (the host gave " + b.tried[0].base + ", which answered 404 — the " +
        "program segment was missing, so it was added)" : "") +
      (b.resolved === false ? "  — NOTHING answered here: tried " +
        b.tried.map(function (t) { return t.base; }).join(" and ") : "");

    var elems = S.model.tables.ELEM;
    var groups = S.model.groups;
    var withElems = groups.filter(function (g) { return g.elements.length; }).length;

    var parts = [];
    if (elems.status !== "ok") {
      /* The headline case: if elements did not read, nothing below it will, and
         saying so once is worth more than forty-seven identical rows. */
      parts.push("The element table did not read (" + (elems.reason || elems.status) +
        "). Nothing else in this panel can be trusted until that is fixed.");
    } else {
      parts.push(Object.keys(elems.rows).length + " elements.");
      parts.push(groups.length
        ? groups.length + " structure group(s), " + withElems + " with elements."
        : "No structure groups in this model.");
    }
    parts.push("Units " + S.model.units.FORCE + ", " + S.model.units.DIST +
      " — " + S.model.units.source + ".");
    if (S.model.stages.length) parts.push(S.model.stages.length + " construction stage(s).");
    parts.push(S.model.probes.GENLINK.rows
      ? Object.keys(S.model.probes.GENLINK.rows).length + " general link(s) at /db/" +
        S.model.probes.GENLINK.key + "."
      : "No general links.");
    $("model-line").textContent = parts.join(" ");
  }

  function renderGroups() {
    var sel = $("in-group");
    sel.textContent = "";
    sel.appendChild(option("", S.model.groups.length
      ? "— choose one of " + S.model.groups.length + " —"
      : "— no structure groups in this model —"));
    S.model.groups.forEach(function (g) {
      /* Every group is listed, empty ones included, with the reason on the
         option. A group quietly missing from this list is what gets reported
         as "it is not reading my groups". */
      var o = option(g.name, g.name + " (" + g.elements.length + " element" +
        (g.elements.length === 1 ? "" : "s") + ")");
      if (g.note) o.title = g.note;
      sel.appendChild(o);
    });
  }

  function renderUnits() {
    /* THE DRIVER IS ANY RESULT QUANTITY, not just a beam member force. The list
       is grouped by source so it is obvious that a reaction and a beam moment
       are read from different tables — and the effect a user picks is what
       decides which table the criterion ranges over. */
    var sel = $("in-component");
    sel.textContent = "";
    El.SOURCE_ORDER.forEach(function (sid) {
      var src = El.SOURCES[sid];
      var g = document.createElement("optgroup");
      g.label = src.label + (src.verified ? "" : "  (token probed, not verified)");
      src.components.forEach(function (c) {
        var o = option(sid + ":" + c.column, c.label);
        o.title = src.label + " · column \"" + c.column + "\" · " +
          El.unitLabel(c.unit, currentUnits());
        g.appendChild(o);
      });
      sel.appendChild(g);
    });
    sel.value = "BEAM:Moment-y";
    fill($("in-position"), Conc.POSITIONS.map(function (p) {
      return { value: p.id, label: p.label };
    }));
    $("in-position").value = "both";

    var radios = $("in-criterion");
    radios.textContent = "";
    Conc.CRITERIA.forEach(function (c, i) {
      var lab = document.createElement("label");
      var input = document.createElement("input");
      input.type = "radio";
      input.name = "criterion";
      input.value = c.id;
      if (!i) input.checked = true;
      lab.appendChild(input);
      lab.appendChild(document.createTextNode(c.label));
      radios.appendChild(lab);
    });

    fill($("in-force"), Model.FORCE_UNITS.map(function (u) { return { value: u, label: u }; }));
    fill($("in-dist"), Model.DIST_UNITS.map(function (u) { return { value: u, label: u }; }));
    $("in-force").addEventListener("change", retitleEffects);
    $("in-dist").addEventListener("change", retitleEffects);
    $("in-force").value = S.model.units.FORCE;
    $("in-dist").value = S.model.units.DIST;
    $("unit-line").textContent = "Defaulted from the model: " + S.model.units.source +
      ". Moments are reported in force × length.";
  }

  /** Keep each effect's unit tooltip in step with the chosen unit system. */
  function retitleEffects() {
    var u = currentUnits();
    Array.prototype.forEach.call($("in-component").getElementsByTagName("option"), function (o) {
      var c = El.findComponent(o.value);
      if (!c) return;
      o.title = c.sourceLabel + " · column \"" + c.column + "\" · " + El.unitLabel(c.unit, u);
    });
  }

  /**
   * The case list. Each entry shows how it will be addressed and, when it is
   * blocked, why — with the whole path to the offending leaf, because that is
   * the part the user cannot see from the combination's own name.
   */
  function renderCases() {
    var tbody = $("case-body");
    tbody.textContent = "";
    S.blocked = Object.create(null);

    var filter = $("in-filter").value.trim().toLowerCase();
    var hide = $("in-hide-blocked").checked;

    S.loadModel.order.forEach(function (name) {
      var node = S.loadModel.nodes[name];
      /* A name that turned up only in the published series, with no kind on its
         label and no definition anywhere, cannot be proved not to be an
         envelope. Leave it out rather than offer something that will be
         refused the moment it is ticked. */
      if (node.origin === "published result series" && !node.isCombo &&
          node.kind === "UNKNOWN") return;
      var reasons = Combos.blockages(S.loadModel, name);
      S.blocked[name] = reasons;
      if (hide && reasons.length) return;
      if (filter && name.toLowerCase().indexOf(filter) < 0) return;

      var tr = document.createElement("tr");
      if (reasons.length) tr.className = "blocked";

      var tick = document.createElement("td");
      tick.className = "tick";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.value = name;
      box.disabled = !!reasons.length;
      box.checked = !!S.selection[name];
      box.addEventListener("change", function () {
        if (box.checked) S.selection[name] = true; else delete S.selection[name];
        renderSelectionCount();
        renderStages();
      });
      tick.appendChild(box);
      tr.appendChild(tick);

      tr.appendChild(cell(name));
      tr.appendChild(cell(node.isCombo ? (node.combType || "ADD") + " combination" : node.kind + " case"));
      tr.appendChild(cell(Combos.requestSeries(S.loadModel, name, "max"), "mono"));

      var status = cell(reasons.length ? shortReason(reasons[0]) : "available",
        reasons.length ? "reason" : "note");
      if (reasons.length) status.title = Combos.blockTooltip(reasons);
      tr.appendChild(status);

      tbody.appendChild(tr);

      /* The tree, one level down, read-only — so a reviewer can see what a
         combination is made of without leaving the plugin. */
      if (node.isCombo && node.children.length) {
        node.children.forEach(function (c) { tbody.appendChild(childRow(c, 1)); });
      }
    });
    renderSelectionCount();
  }

  function childRow(child, depth) {
    var tr = document.createElement("tr");
    tr.className = "child";
    tr.appendChild(cell(""));
    tr.appendChild(cell("↳ " + (child.factor === 1 ? "" : child.factor + " × ") + child.name,
      "indent-" + Math.min(depth, 3)));
    tr.appendChild(cell(child.anal));
    tr.appendChild(cell(""));
    tr.appendChild(cell(""));
    return tr;
  }

  function shortReason(r) {
    var map = {
      MV: "moving load — envelope at source",
      SM: "settlement — enveloped over the group",
      RS: "response spectrum — sign-less",
      TH_NOSTEP: "time history saved without steps",
      ABS: "ABS combination — sign discarded",
      SRSS: "SRSS combination — quadratic",
      UNKNOWN: "constituent of unknown kind",
      CYCLE: "self-referencing definition"
    };
    return "blocked: " + (map[r.code] || r.code) + " (" + r.leaf + ")";
  }

  function renderSelectionCount() {
    var n = Object.keys(S.selection).length;
    $("sel-count").textContent = n + " selected";
    $("sel-count").className = "badge " + (n ? "ok" : "neutral");
  }

  /** Stage and step choices, offered only when a stage case is selected. */
  function renderStages() {
    var needs = Object.keys(S.selection).some(function (n) {
      return Combos.familyOf(S.loadModel, n) === "CS";
    });
    $("stage-block").hidden = !needs;
    if (!needs) return;

    var box = $("stage-list");
    box.textContent = "";
    S.model.stages.forEach(function (st) {
      st.steps.forEach(function (step) {
        var lab = document.createElement("label");
        var input = document.createElement("input");
        input.type = "checkbox";
        input.value = step.token;
        input.checked = S.stageSteps[step.token] !== false;
        S.stageSteps[step.token] = input.checked;
        input.addEventListener("change", function () {
          S.stageSteps[step.token] = input.checked;
        });
        lab.appendChild(input);
        lab.appendChild(document.createTextNode(step.label +
          (st.savesSteps ? "" : " (only step saved)")));
        box.appendChild(lab);
      });
    });
  }

  /* -------------------------------------------------------------------- run */

  function currentUnits() {
    return {
      FORCE: $("in-force").value || (S.model ? S.model.units.FORCE : "kN"),
      DIST: $("in-dist").value || (S.model ? S.model.units.DIST : "m")
    };
  }

  function selectedStageSteps() {
    return Object.keys(S.stageSteps).filter(function (k) { return S.stageSteps[k]; });
  }

  async function run() {
    if (!S.connected) return;
    $("btn-run").disabled = true;
    clearError();
    progress("Starting", 0);

    try {
      var units = currentUnits();
      S.mapi.unit = units;
      var out = await Run.runAnalysis({
        mapi: S.mapi,
        elems: S.model.elems,
        nodes: S.model.nodes,
        links: S.model.links,
        elinks: S.model.elinks,
        loadModel: S.loadModel,
        setText: $("in-set").value,
        keyItemText: $("in-key-elem").value,
        effectId: $("in-component").value,
        criterion: (document.querySelector("input[name=criterion]:checked") || {}).value || "max",
        position: $("in-position").value,
        selection: Object.keys(S.selection),
        units: units,
        stageSteps: selectedStageSteps(),
        generated: new Date().toISOString(),
        onProgress: function (line) { progress(line, null); },
        yieldToUi: yieldToUi
      });
      S.result = out;
      await renderResult(out.report);
      progress("Done · " + out.rows.length + " rows at the governing state · " +
        S.mapi.calls + " requests", 1);
    } catch (err) {
      showError(err);
      progress("Stopped", 0);
    } finally {
      $("btn-run").disabled = false;
    }
  }

  /* ----------------------------------------------------------------- report */

  async function renderResult(doc) {
    /* The one number the user came for, said once and said large, before the
       supporting detail. A header block of twelve equal-weight rows makes the
       reader hunt for it. */
    var govValue = doc.header.filter(function (h) { return h.label === "Governing value"; })[0];
    var govLoad = doc.header.filter(function (h) { return h.label === "Governing load"; })[0];
    var stage = doc.header.filter(function (h) { return h.label === "Stage / step"; })[0];
    var resolved = doc.header.filter(function (h) { return h.label === "Resolved"; })[0];
    $("verdict-value").textContent = govValue ? govValue.value : "";
    var effectHead = doc.header.filter(function (h) { return h.label === "Key effect"; })[0];
    $("verdict-where").textContent = "at " + doc.meta.keyElemKey +
      " · " + (effectHead ? effectHead.value.split(",")[0] : doc.meta.component) +
      " · " + (govLoad ? govLoad.value : "") +
      (stage && /^[^n]/.test(stage.value) ? " · " + stage.value : "");
    $("verdict-resolved").textContent = resolved ? resolved.value : "";
    $("verdict-resolved").hidden = !resolved;

    var head = $("result-head");
    head.textContent = "";
    doc.header.forEach(function (h) {
      var div = document.createElement("div");
      if (h.emphasis) div.className = "emphasis";
      var dt = document.createElement("dt");
      dt.textContent = h.label;
      var dd = document.createElement("dd");
      dd.textContent = h.value;
      div.appendChild(dt);
      div.appendChild(dd);
      head.appendChild(div);
    });

    var notes = $("result-notes");
    notes.textContent = "";
    doc.notes.forEach(function (n) {
      var li = document.createElement("li");
      li.textContent = n;
      notes.appendChild(li);
    });

    var hr = $("result-head-row");
    hr.textContent = "";
    doc.columns.forEach(function (c) {
      var th = document.createElement("th");
      th.textContent = c.label;
      if (c.kind === "number") th.className = "num";
      hr.appendChild(th);
    });

    var body = $("result-body");
    body.textContent = "";
    /* Chunked: a 220-element set at two parts is 440 rows, and building them in
       one synchronous pass is long enough to swallow a click on Close. */
    await runChunked(doc.rows, 60, function (slice) {
      slice.forEach(function (r) {
        var tr = document.createElement("tr");
        if (r.isKey) tr.className = "key-row";
        r.cells.forEach(function (c, i) {
          var td = document.createElement("td");
          td.textContent = c.text;
          var cls = [];
          if (doc.columns[i].kind === "number") cls.push("num");
          if (c.reason) { cls.push("na"); td.title = c.reason; }
          if (r.emphasis && doc.columns[i].id === r.emphasis) cls.push("emph");
          if (cls.length) td.className = cls.join(" ");
          tr.appendChild(td);
        });
        body.appendChild(tr);
      });
    });

    /* The chart is offered per component, defaulting to the one that governed. */
    var plottable = doc.columns.filter(function (c) { return c.kind === "number"; });
    fill($("chart-component"), plottable.map(function (c) {
      return { value: c.id, label: c.label };
    }));
    $("chart-component").value = doc.meta.component;
    drawChart(doc, doc.meta.component);

    S.csv = Report.toCsv(doc);
    $("csv-text").value = S.csv;
    $("csv-line").textContent = doc.rows.length + " rows ready to export.";
    $("csv-block").hidden = true;
    $("csv-block").open = false;

    var results = $("results");
    results.hidden = false;
    /* An action whose only effect is off-screen reads as broken. */
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ------------------------------------------------------------------ chart */

  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs) {
    var el = document.createElementNS(SVGNS, name);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  /** Render the spec chart.js computed. Nodes, never markup — an element label
   *  or a load name must not be able to become HTML. */
  function drawChart(doc, columnId) {
    var svg = $("chart");
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var width = Math.max(360, (svg.parentNode.clientWidth || 900) - 4);
    var spec = Chart.buildChart(doc, columnId, { width: width, height: 220 });
    var col = doc.columns.filter(function (c) { return c.id === columnId; })[0];

    if (spec.empty) {
      $("chart-note").textContent = "Nothing to plot: " + spec.reason + ".";
      svg.setAttribute("viewBox", "0 0 10 10");
      svg.setAttribute("height", "0");
      return;
    }

    svg.setAttribute("viewBox", "0 0 " + spec.width + " " + spec.height);
    svg.setAttribute("width", String(spec.width));
    svg.setAttribute("height", String(spec.height));
    svg.setAttribute("aria-label", "Concurrent " + (col ? col.label : columnId) +
      " across the element set at the governing state");

    /* Gridlines and value labels. */
    spec.ticks.forEach(function (t) {
      svg.appendChild(svgEl("line", {
        x1: spec.plot.x, x2: spec.plot.x + spec.plot.w, y1: t.y, y2: t.y,
        "class": Math.abs(t.value) < 1e-12 ? "ch-zero" : "ch-grid"
      }));
      var label = svgEl("text", { x: spec.plot.x - 8, y: t.y + 4, "class": "ch-tick" });
      label.textContent = Conc.formatValue(t.value);
      svg.appendChild(label);
    });

    spec.bars.forEach(function (b, i) {
      if (!b.missing) {
        var cls = "ch-bar" + (b.isKey ? " ch-key" : "") + (b.negative ? " ch-neg" : "");
        var rect = svgEl("rect", { x: b.x, y: b.y, width: b.w, height: b.h, "class": cls });
        var title = svgEl("title");
        title.textContent = b.label + ": " + Conc.formatValue(b.value) +
          (b.isKey ? "  (key element)" : "");
        rect.appendChild(title);
        svg.appendChild(rect);
      }
      if (i % spec.labelEvery === 0) {
        var t = svgEl("text", {
          x: b.x + b.w / 2, y: spec.height - 8,
          "class": "ch-xlabel" + (b.isKey ? " ch-key-label" : "")
        });
        t.textContent = b.label;
        svg.appendChild(t);
      }
    });

    $("chart-note").textContent =
      "Every bar is the value at the SAME structural state — not each element's " +
      "own extreme. The key element is highlighted." +
      (spec.missing ? "  " + spec.missing + " of " + spec.count + " rows carry no " +
        "value in this column and are not drawn." : "");
  }

  /* Whether the host window permits a download is UNVERIFIED, so the export
     offers the file and always leaves a copyable text fallback beside it —
     and the status line says what actually happened rather than claiming a
     save that may never have occurred. */
  function exportCsv() {
    if (!S.csv) return;
    var name = "concurrent-forces-" + (S.result.report.meta.keyElemKey || "set") + ".csv";
    var saved = false;
    try {
      var blob = new Blob([S.csv], { type: "text/csv;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      saved = true;
    } catch (e) { saved = false; }

    $("csv-line").textContent = saved
      ? "A download of " + name + " was offered. If nothing was saved, this host " +
        "window blocks downloads — use Show as text and copy from there."
      : "This host window would not start a download. Use Show as text and copy " +
        "from the box below.";
    if (!saved) showCsvText();
  }

  /** Copy to the clipboard, and report what ACTUALLY happened — a claimed copy
   *  that silently failed is worse than no button. */
  async function copyCsv() {
    if (!S.csv) return;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard API");
      await navigator.clipboard.writeText(S.csv);
      $("csv-line").textContent = "Copied " + S.csv.length + " characters to the clipboard.";
    } catch (e) {
      $("csv-line").textContent = "The clipboard was not available here (" +
        (e.message || e) + "). The text is selected below — copy it by hand.";
      showCsvText();
    }
  }

  function showCsvText() {
    $("csv-block").hidden = false;
    $("csv-block").open = true;
    var ta = $("csv-text");
    ta.scrollIntoView({ behavior: "smooth", block: "nearest" });
    ta.focus();
    ta.select();
    $("csv-line").textContent = S.csv.length + " characters, selected and ready to copy.";
  }

  /* ------------------------------------------------------------------ bits */

  function progress(line, fraction) {
    $("progress-line").textContent = line;
    if (fraction != null) $("progress-fill").style.width = Math.round(fraction * 100) + "%";
  }

  function note(text) {
    var el = $("model-line");
    el.textContent = el.textContent + " " + text;
  }

  function cell(text, cls) {
    var td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  function option(value, label) {
    var o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    return o;
  }

  function fill(select, items) {
    select.textContent = "";
    items.forEach(function (i) { select.appendChild(option(i.value, i.label)); });
  }

  function showError(err) {
    var box = $("error");
    box.hidden = false;
    /* An error gets a HINT, not an echo. "second query is wrong" helps nobody. */
    $("error-message").textContent = err.message || String(err);
    $("error-hint").textContent = err.hint || "";
    $("error-hint").hidden = !err.hint;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function clearError() { $("error").hidden = true; }

  /* ------------------------------------------------------------------- init */

  function validateKeyElement() {
    var line = $("key-line");
    var text = $("in-key-elem").value.trim();
    if (!text) {
      line.textContent = "Its extreme picks the structural state.";
      line.className = "hint tight";
      return;
    }
    var parsed = El.parseSet(text);
    var set = El.parseSet($("in-set").value);
    if (parsed.errors.length || parsed.members.length !== 1) {
      line.textContent = "One item: 12 for an element, N12 a node, L12 a general " +
        "link, EL12 an elastic link.";
      line.className = "hint tight bad-text";
      return;
    }
    var key = parsed.members[0].key;
    var inSet = set.members.some(function (m) { return m.key === key; });
    line.textContent = inSet
      ? key + " is in the set."
      : key + " is NOT in the set — the key item must be one of the items being " +
        "reported, which is what makes the answer checkable.";
    line.className = "hint tight" + (inSet ? "" : " bad-text");
  }

  function describeSet() {
    var parsed = El.parseSet($("in-set").value);
    $("set-line").textContent = parsed.errors.length
      ? parsed.errors.join(" ")
      : parsed.members.length + " member(s), reported in the order entered.";
  }

  function init() {
    wireHost();
    $("btn-connect").addEventListener("click", connect);
    $("btn-connect-dev").addEventListener("click", connect);
    $("btn-run").addEventListener("click", run);
    $("btn-csv").addEventListener("click", exportCsv);
    $("btn-csv-copy").addEventListener("click", copyCsv);
    $("btn-csv-show").addEventListener("click", showCsvText);
    $("chart-component").addEventListener("change", function () {
      if (S.result) drawChart(S.result.report, $("chart-component").value);
    });
    root.addEventListener("resize", function () {
      if (S.result) drawChart(S.result.report, $("chart-component").value);
    });
    $("btn-none").addEventListener("click", function () {
      S.selection = Object.create(null);
      renderCases();
      renderStages();
    });
    $("in-filter").addEventListener("input", function () { if (S.loadModel) renderCases(); });
    $("in-hide-blocked").addEventListener("change", function () { if (S.loadModel) renderCases(); });
    $("in-set").addEventListener("input", describeSet);
    $("in-set").addEventListener("blur", validateKeyElement);
    $("in-key-elem").addEventListener("blur", validateKeyElement);
    $("btn-group-add").addEventListener("click", function () { addGroup(false); });
    $("btn-group-replace").addEventListener("click", function () { addGroup(true); });

    /* The endpoint and key row exists only for the plain-browser case. Inside
       CIVIL NX the host supplies both and there is nothing to decide. */
    var hostKey = Mapi.keyFromLocation(location.search);
    $("conn-row").hidden = !!hostKey;
    if (!hostKey) $("in-base").value = Mapi.baseFromLocation(location.search);
    if (hostKey) connect();
  }

  /** Put a structure group's elements into the set, and say what happened when
   *  nothing does — a button that silently no-ops reads as a broken plugin. */
  function addGroup(replace) {
    var name = $("in-group").value;
    var line = $("set-line");
    if (!name || !S.model) {
      line.textContent = "Choose a structure group first.";
      line.className = "hint bad-text";
      return;
    }
    var g = S.model.groups.filter(function (x) { return x.name === name; })[0];
    if (!g) return;
    if (!g.elements.length) {
      line.textContent = "\"" + g.name + "\" added nothing: " +
        (g.note || "it holds no elements") + ".";
      line.className = "hint bad-text";
      return;
    }
    var cur = replace ? "" : $("in-set").value.trim();
    $("in-set").value = (cur ? cur + ", " : "") + g.elements.join(", ");
    describeSet();
    validateKeyElement();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  root.CfApp = { yieldToUi: yieldToUi, runChunked: runChunked, toHost: toHost };
})(typeof globalThis !== "undefined" ? globalThis : this);
