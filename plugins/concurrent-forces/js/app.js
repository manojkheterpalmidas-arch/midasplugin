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

  function fingerprint(key) {
    if (!key) return "—";
    return key.length <= 8 ? "••••" : key.slice(0, 4) + "…" + key.slice(-4);
  }

  async function connect() {
    /* The host supplies both on the query string. A remembered base must never
       override ?redirectTo=. */
    var key = Mapi.keyFromLocation(location.search) || $("in-key").value.trim();
    var base = Mapi.baseFromLocation(location.search);
    $("in-base").value = base;
    $("key-print").textContent = fingerprint(key);

    if (!key) { setStatus("warn", "No MAPI key"); return; }

    setStatus("neutral", "Connecting…");
    clearError();
    S.mapi = new Mapi.Mapi({ key: key, base: base });
    try {
      var info = await S.mapi.verify();
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
      if (route && route.group === "BEAM") return { id: Number(ids[i]), token: "BEAMFORCE" };
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
      tr.appendChild(cell(row.note || "read", "note"));
      tbody.appendChild(tr);
    });
    var u = S.model.units;
    $("model-line").textContent =
      "Units " + u.FORCE + ", " + u.DIST + " — " + u.source + ". " +
      (S.model.stages.length ? S.model.stages.length + " construction stage(s). " : "") +
      (S.model.probes.GENLINK.rows ? Object.keys(S.model.probes.GENLINK.rows).length +
        " general link(s) at /db/" + S.model.probes.GENLINK.key + "." : "No general links.");
  }

  function renderGroups() {
    var sel = $("in-group");
    sel.textContent = "";
    sel.appendChild(option("", "—"));
    S.model.groups.forEach(function (g) {
      sel.appendChild(option(g.name, g.name + " (" + g.elements.length + ")"));
    });
  }

  function renderUnits() {
    fill($("in-component"), El.COMPONENTS.map(function (c) {
      return { value: c.id, label: c.label + " → " + c.column };
    }));
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
    $("in-force").value = S.model.units.FORCE;
    $("in-dist").value = S.model.units.DIST;
    $("unit-line").textContent = "Defaulted from the model: " + S.model.units.source +
      ". Moments are reported in force × length.";
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
        links: S.model.links,
        loadModel: S.loadModel,
        setText: $("in-set").value,
        keyElemText: $("in-key-elem").value,
        componentId: $("in-component").value,
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

    S.csv = Report.toCsv(doc);
    $("csv-text").value = S.csv;
    $("csv-line").textContent = "";
    $("csv-block").hidden = true;
    $("csv-block").open = false;

    var results = $("results");
    results.hidden = false;
    /* An action whose only effect is off-screen reads as broken. */
    results.scrollIntoView({ behavior: "smooth", block: "start" });
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
      line.textContent = "Enter one element number (or L5 for a general link).";
      line.className = "hint tight bad-text";
      return;
    }
    var key = parsed.members[0].key;
    var inSet = set.members.some(function (m) { return m.key === key; });
    line.textContent = inSet
      ? key + " is in the set."
      : key + " is NOT in the element set — the key element must be one of the " +
        "elements being reported.";
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
    $("btn-run").addEventListener("click", run);
    $("btn-csv").addEventListener("click", exportCsv);
    $("btn-csv-show").addEventListener("click", showCsvText);
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
    $("btn-group-add").addEventListener("click", function () {
      var name = $("in-group").value;
      if (!name || !S.model) return;
      var g = S.model.groups.filter(function (x) { return x.name === name; })[0];
      if (!g || !g.elements.length) return;
      var cur = $("in-set").value.trim();
      $("in-set").value = (cur ? cur + ", " : "") + g.elements.join(", ");
      describeSet();
      validateKeyElement();
    });

    $("in-base").value = Mapi.baseFromLocation(location.search);
    $("key-print").textContent = fingerprint(Mapi.keyFromLocation(location.search));
    /* Connect on load when the host supplied a key; otherwise wait. */
    if (Mapi.keyFromLocation(location.search)) connect();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  root.CfApp = { yieldToUi: yieldToUi, runChunked: runChunked, toHost: toHost };
})(typeof globalThis !== "undefined" ? globalThis : this);
