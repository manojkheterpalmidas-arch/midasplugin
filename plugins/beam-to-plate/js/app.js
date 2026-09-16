/* ==========================================================================
   Beam to Plate — wiring
   --------------------------------------------------------------------------
   DOM wiring only. Everything that computes lives in the pure modules, so
   `node test/run.js` exercises the whole conversion without a browser.

   The model tables are read ONCE per Plan and held in memory while the options
   are adjusted — never in localStorage, because a restored copy of a model
   looks identical to a fresh one while describing whatever was open when the
   window closed. commit.js re-reads everything it is about to touch
   immediately before it writes, which is what makes holding them here safe.
   ========================================================================== */
(function (root) {
  "use strict";

  var Mapi = root.B2PMapi, Plan = root.B2PPlan, Commit = root.B2PCommit, Draw = root.B2PDraw,
      Section = root.B2PSection;

  /* buildPlan is synchronous, and a synchronous minute is a plugin whose close
     button does not respond. The estimate is exact, so it can be a hard limit. */
  var MAX_PLATES = 150000;
  var WARN_PLATES = 30000;

  var S = {
    mapi: null, connected: false, tables: null, beams: null, sections: null, plan: null,
    selected: null, selection: { nodes: [], elements: [] },
    overrides: Object.create(null), materials: Object.create(null), lastReport: null
  };

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ host bridge */

  function toHost(message) {
    var w = root.chrome && root.chrome.webview;
    if (!w || typeof w.postMessage !== "function") return false;
    try { w.postMessage(message); return true; } catch (e) { return false; }
  }

  function wireHost() {
    $("btn-close").addEventListener("click", function () {
      if (!toHost("REQ_EXIT")) {
        /* window.close() is a NO-OP in WebView2 — kept only for a plain browser. */
        try { root.close(); } catch (e) { /* ignored */ }
      }
      setTimeout(function () {
        showError({
          message: "This window did not close.",
          hint: "The plugin asked the CIVIL NX host to close it (REQ_EXIT) and the host did not " +
                "act. Close the panel from CIVIL NX instead. In a plain browser tab there is no " +
                "host to ask, and this message is expected."
        });
      }, 800);
    });
    /* REQ_WND_MOVE only works from mousedown; from pointerdown it does nothing
       while REQ_EXIT keeps working, so the bridge looks healthy. */
    var drag = $("drag-surface");
    if (drag) {
      drag.addEventListener("mousedown", function (e) {
        if (e.button !== 0 && e.button !== 1) return;
        if (e.target.closest && e.target.closest("button, input, select, nav, a")) return;
        toHost("REQ_WND_MOVE");
      });
    }
  }

  /* ---------------------------------------------------------- long work */

  /* THE MAIN THREAD IS THE UI THREAD. Yield with a MessageChannel message, not
     setTimeout: a resolved promise is a microtask and does not yield at all,
     and setTimeout(0) is clamped to one second when the window is hidden. */
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

  /* ------------------------------------------------------------- connection */

  function setStatus(state, text) {
    var badge = $("conn-badge");
    badge.className = "badge " + state;
    badge.textContent = text;
  }

  async function connect() {
    var key = Mapi.keyFromLocation(location.search) || $("in-key").value.trim();
    var base = Mapi.baseFromLocation(location.search);
    $("in-key").value = key;
    $("in-base").value = base;
    if (!key) { setStatus("warn", "No MAPI key"); return; }
    setStatus("neutral", "Connecting…");
    S.mapi = new Mapi.Mapi({ key: key, base: base });
    try {
      var info = await S.mapi.verify();
      S.connected = true;
      setStatus("ok", "Connected · " + (info.program || "civil"));
      $("btn-plan").disabled = false;
      refreshSelection();
    } catch (err) {
      S.connected = false;
      setStatus("bad", "Not connected");
      showError(err);
    }
  }

  async function refreshSelection() {
    if (!S.connected) return;
    try {
      S.selection = await S.mapi.selection();
      var n = (S.selection.elements || []).length;
      $("sel-note").textContent = n
        ? n + " element(s) selected in CIVIL NX" + (S.beams ? "" : " — press Read model & plan")
        : "Nothing is selected in CIVIL NX right now.";
      if (S.tables) rebuild();
    } catch (err) { showError(err); }
  }

  /* ------------------------------------------------------------------ read */

  async function readAndPlan() {
    if (!S.connected) return;
    $("btn-plan").disabled = true;
    $("btn-commit").disabled = true;
    $("progress").hidden = false;
    $("report-panel").hidden = true;
    clearError();
    progress("Reading the model", 0.05);
    try {
      S.tables = await Plan.readTables(S.mapi, function (done, total, key) {
        progress("Reading /db/" + key + " (" + done + " of " + total + ")", done / total * 0.85);
      });
      await yieldToUi();
      if (S.tables.ELEM.status === "absent" || S.tables.NODE.status === "absent") {
        throw new Error("CIVIL NX does not recognise /db/NODE or /db/ELEM on this build. " +
          "That is a fault in the plugin, not in the model.");
      }
      S.selection = await S.mapi.selection();
      S.beams = Plan.beams(S.tables);
      fillPickers();
      rebuild();
      progress("Model read · " + S.mapi.calls + " requests", 1);
    } catch (err) {
      showError(err);
    } finally {
      $("btn-plan").disabled = false;
    }
  }

  function fillPickers() {
    var counts = Object.create(null);
    S.beams.forEach(function (b) { if (!b.skip) counts[b.sect] = (counts[b.sect] || 0) + 1; });
    var sel = $("sel-sects");
    sel.textContent = "";
    var sectRows = (S.tables.SECT && S.tables.SECT.rows) || {};
    Object.keys(counts).sort(function (a, b) { return Number(a) - Number(b); }).forEach(function (sid) {
      var row = sectRows[sid] || {};
      var opt = document.createElement("option");
      opt.value = sid;
      opt.textContent = sid + " · " + (row.SECT_NAME || "unnamed") + " (" + counts[sid] + " beam" +
        (counts[sid] === 1 ? "" : "s") + ")";
      sel.appendChild(opt);
    });
    var groups = $("sel-groups");
    groups.textContent = "";
    var grupRows = (S.tables.GRUP && S.tables.GRUP.rows) || {};
    Object.keys(grupRows).forEach(function (gid) {
      var g = grupRows[gid] || {};
      if (!(g.E_LIST || []).length) return;
      var o = document.createElement("option");
      o.value = String(g.NAME);
      o.textContent = g.NAME + " (" + g.E_LIST.length + " elements)";
      groups.appendChild(o);
    });
    var convertible = S.beams.filter(function (b) { return !b.skip; }).length;
    $("sel-note").textContent = S.beams.length + " elements read · " + convertible +
      " are beams · " + Object.keys(counts).length + " sections in use · " +
      (S.selection.elements || []).length + " selected in CIVIL NX";
  }

  /* ------------------------------------------------------------------ plan */

  function options() {
    return {
      longSize: num($("opt-long").value, 0),
      transSize: num($("opt-trans").value, 0),
      facets: num($("opt-facets").value, 24),
      mergeTol: num($("opt-tol").value, 1e-4),
      thickTol: num($("opt-thick-tol").value, 0.005),
      calibrate: $("opt-calibrate").value,
      minLong: 1, minTrans: 1,
      overrides: S.overrides,
      convertLoads: $("opt-loads").checked,
      linkAll: $("opt-link-all").checked,
      boundaryGroup: $("opt-bngr").value.trim(),
      materialFor: function (part, study) { return (S.materials[study.id] || {})[part]; }
    };
  }

  function selection() {
    var mode = document.querySelector('input[name="sel-mode"]:checked').value;
    if (mode === "ids") {
      var parsed = Plan.parseIds($("sel-ids").value);
      return { mode: "ids", ids: parsed.ids, bad: parsed.bad };
    }
    if (mode === "sect") {
      return { mode: "sect", sects: pick($("sel-sects")) };
    }
    if (mode === "group") {
      return { mode: "group", groups: pick($("sel-groups")) };
    }
    if (mode === "selection") {
      return { mode: "selection", selected: S.selection.elements || [] };
    }
    return { mode: "all" };
  }
  function pick(sel) {
    return Array.prototype.slice.call(sel.selectedOptions).map(function (o) { return o.value; });
  }

  function rebuild() {
    if (!S.tables || !S.beams) return;
    clearError();
    var opts = options(), sel = selection();
    if (sel.bad && sel.bad.length) {
      showError({ message: "Could not read the element list: \"" + sel.bad.join('", "') + "\" is not an id or a range.",
                  hint: "Use numbers and ranges: 101-118, 205, 300." });
      return;
    }
    S.selected = Plan.select(S.beams, sel, S.tables);
    var sectIds = [];
    S.selected.forEach(function (b) { if (sectIds.indexOf(b.sect) === -1) sectIds.push(b.sect); });
    S.sections = Plan.studySections(S.tables, sectIds, opts);
    renderSections();

    var est = Plan.estimate(S.selected, S.sections, opts);
    if (est.plates > MAX_PLATES) {
      S.plan = null;
      $("plan-panel").hidden = true;
      $("btn-commit").disabled = true;
      showError({
        message: "That would build about " + fmtInt(est.plates) + " plates, which is more than this " +
          "plugin will put on the UI thread in one go.",
        hint: "Convert fewer beams at a time, or use a coarser mesh size. The limit is " +
          fmtInt(MAX_PLATES) + " plates."
      });
      return;
    }
    S.plan = Plan.buildPlan(S.selected, S.sections, S.tables, opts);
    renderPlan();
  }

  /* --------------------------------------------------------------- sections */

  function renderSections() {
    var body = $("sect-body");
    body.textContent = "";
    var ids = Object.keys(S.sections);
    $("sections-panel").hidden = ids.length === 0;

    ids.forEach(function (sid) {
      var st = S.sections[sid];
      var tr = document.createElement("tr");
      tr.appendChild(cell(st.name + "  (" + sid + ")" + (st.sectType ? "\n" + st.sectType : "") +
        (st.tapered ? "\ntapered" : "")));

      var check = st.checks && (st.checks.I || st.checks.J);
      tr.appendChild(cell(sourceLabel(check && check.source)));

      /* dimensions, editable where the section has a shape code */
      var dimCell = document.createElement("td");
      if (st.editable) {
        var wrap = document.createElement("div");
        wrap.className = "dims";
        st.editable.keys.forEach(function (k, i) {
          var lab = document.createElement("label");
          lab.className = "dim";
          lab.appendChild(document.createTextNode(k));
          var inp = document.createElement("input");
          inp.type = "number"; inp.step = "0.001";
          inp.value = st.editable.values[i] != null ? st.editable.values[i] : 0;
          inp.addEventListener("change", function () {
            var ov = S.overrides[sid] || (S.overrides[sid] = {});
            ov.shape = ov.shape || st.editable.code;
            ov.dims = (ov.dims || st.editable.values).slice();
            ov.dims[i] = Number(inp.value);
            rebuild();
          });
          lab.appendChild(inp);
          wrap.appendChild(lab);
        });
        dimCell.appendChild(wrap);
      } else if (!st.ok) {
        dimCell.appendChild(note(st.reason || "not interpreted"));
      } else {
        dimCell.appendChild(note("no dimension list — the geometry came straight from the model"));
      }
      (st.notes || []).forEach(function (n) { dimCell.appendChild(note(n)); });
      if (st.materialSlots && st.materialSlots.length) dimCell.appendChild(materialPicker(st));
      tr.appendChild(dimCell);

      tr.appendChild(checkCell(check, "reading"));
      tr.appendChild(checkCell(check, "ideal", st, sid));

      var svgCell = document.createElement("td");
      svgCell.className = "sect-svg";
      svgCell.innerHTML = Draw.sectionSvg(st.ends && st.ends.I, { width: 180, height: 140, label: st.name });
      tr.appendChild(svgCell);
      body.appendChild(tr);
    });
  }

  function sourceLabel(source) {
    return {
      exact: "its dimensions", outline: "its dimensions", psc: "its guide curve",
      polygon: "the outline in the model", stress: "its stress points",
      catalogue: "the catalogue fit", equivalent: "an EQUIVALENT section", override: "your dimensions"
    }[source] || "—";
  }

  function checkCell(check, which, st, sid) {
    var td = document.createElement("td");
    if (!check) { td.appendChild(badge("neutral", "—")); return td; }
    var r = which === "reading" ? check.reading : (check.after || check.ideal);
    if (!r) {
      td.appendChild(badge("warn", "unchecked"));
      td.appendChild(note(check.summary || "CIVIL NX published no properties for this section"));
      return td;
    }
    var worst = Math.max(Math.abs(r.A || 0), Math.abs(r.Iyy || 0), Math.abs(r.Izz || 0));
    var kind = worst <= 0.02 ? "ok" : worst <= 0.05 ? "warn" : "bad";
    td.appendChild(badge(kind, pct(worst)));
    td.appendChild(note("A " + pct(r.A) + " · Iyy " + pct(r.Iyy) + " · Izz " + pct(r.Izz) +
      (which !== "reading" && check.calibrated ? " · thickness matched to the section" : "")));
    if (which !== "reading" && check.calibrationFailed) td.appendChild(note(check.calibrationFailed));
    if (which !== "reading" && st && st.blocked) {
      var accept = document.createElement("label");
      accept.className = "check";
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!st.accepted;
      box.addEventListener("change", function () {
        var ov = S.overrides[sid] || (S.overrides[sid] = {});
        ov.acceptGate = box.checked;
        rebuild();
      });
      accept.appendChild(box);
      accept.appendChild(document.createTextNode("convert anyway"));
      td.appendChild(accept);
      td.appendChild(note(st.reason || ""));
    }
    return td;
  }

  function materialPicker(st) {
    var wrap = document.createElement("div");
    wrap.className = "dims";
    var matls = (S.tables.MATL && S.tables.MATL.rows) || {};
    st.materialSlots.forEach(function (slot) {
      var lab = document.createElement("label");
      lab.className = "dim wide";
      lab.appendChild(document.createTextNode(slot.label + " material"));
      var sel = document.createElement("select");
      var none = document.createElement("option");
      none.value = "";
      none.textContent = slot.defaultToElement ? "same as the beam" : "— choose —";
      sel.appendChild(none);
      Object.keys(matls).forEach(function (mid) {
        var o = document.createElement("option");
        o.value = mid;
        o.textContent = mid + " · " + (matls[mid].NAME || "unnamed");
        if ((S.materials[st.id] || {})[slot.part] === mid) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () {
        var m = S.materials[st.id] || (S.materials[st.id] = {});
        m[slot.part] = sel.value || null;
        rebuild();
      });
      lab.appendChild(sel);
      wrap.appendChild(lab);
    });
    return wrap;
  }

  /* ------------------------------------------------------------------ plan */

  function renderPlan() {
    var plan = S.plan, t = plan.totals;
    $("plan-panel").hidden = false;
    var stats = [
      ["Beams converted", fmtInt(t.converted)],
      ["Plates", fmtInt(t.plates)],
      ["Nodes", fmtInt(t.nodes)],
      ["Thicknesses", fmtInt(t.thicknesses)],
      ["Rigid links", fmtInt(t.links) + (t.ties ? " + " + fmtInt(t.ties) + " ties" : "")],
      ["Loads moved", fmtInt(t.loads)],
      ["Volume check", t.expected > 0
        ? (Math.abs(t.worstError) < 1e-6 ? "exact" : "out by " + (t.worstError * 100).toFixed(4) + "%")
        : "—"]
    ];
    $("plan-stats").textContent = "";
    stats.forEach(function (s) {
      var d = document.createElement("div");
      d.className = "stat";
      var b = document.createElement("b"); b.textContent = s[1];
      var sp = document.createElement("span"); sp.textContent = s[0];
      d.appendChild(b); d.appendChild(sp);
      $("plan-stats").appendChild(d);
    });

    $("mesh-preview").innerHTML = Draw.meshSvg(plan.pool, plan.plates, { width: 700, height: 250 });

    var notes = $("plan-notes");
    notes.textContent = "";
    if (plan.freeEnds.length) {
      notes.appendChild(note(plan.freeEnds.length + " member end(s) have nothing else attached, so they get no " +
        "rigid link. Their original nodes are removed with the beams unless you keep them."));
    }
    plan.conflicts.forEach(function (c) { notes.appendChild(note("Node " + c.node + ": " + c.what)); });
    if (plan.totals.loadResidual > 0.02) {
      notes.appendChild(note("Some load moments could not be reproduced exactly on the plate nodes " +
        "(worst " + pct(plan.totals.loadResidual) + " of the moment at that station) — a section meshed as a " +
        "single plate cannot carry a moment about its own line."));
    }

    var dbody = $("dangling-body");
    dbody.textContent = "";
    plan.dangling.forEach(function (d) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(d.label + " (/db/" + d.table + ")"));
      tr.appendChild(cell(String(d.count), "num"));
      tr.appendChild(cell(d.elements.slice(0, 10).join(", ") + (d.elements.length > 10 ? " …" : ""), "note"));
      dbody.appendChild(tr);
    });
    $("dangling-table").hidden = plan.dangling.length === 0;

    var problems = Plan.problems(plan, S.beams);
    var pbody = $("problem-body");
    pbody.textContent = "";
    problems.forEach(function (p) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(p.reason));
      tr.appendChild(cell(String(p.count), "num"));
      tr.appendChild(cell(p.sample, "note"));
      pbody.appendChild(tr);
    });
    $("problem-table").hidden = problems.length === 0;

    var ok = t.plates > 0;
    $("btn-commit").disabled = !ok;
    $("btn-commit").textContent = ok
      ? "Write " + fmtInt(t.plates) + " plates" + (t.links ? " and " + fmtInt(t.links) + " links" : "")
      : "Write to model";
    $("btn-commit").title = ok && t.plates > WARN_PLATES
      ? "A mesh this size takes a while to write. The window stays responsive; leave it displayed, " +
        "because a hidden WebView2 window throttles everything to about one step a second."
      : "";
  }

  /* ---------------------------------------------------------------- commit */

  async function commit() {
    if (!S.plan || !S.plan.plates.length) return;
    $("btn-commit").disabled = true;
    $("btn-plan").disabled = true;
    $("progress").hidden = false;
    clearError();
    try {
      var report = await Commit.commit(S.mapi, {
        plan: S.plan,
        sources: S.selected.filter(function (b) { return S.plan.convertedIds[b.id]; }),
        groupName: $("opt-group").value.trim(),
        boundaryGroup: $("opt-bngr").value.trim(),
        reuseExisting: $("opt-reuse").checked,
        deleteSources: $("opt-delete").checked,
        deleteOrphans: $("opt-orphans").checked,
        mergeTol: num($("opt-tol").value, 1e-4)
      }, { progress: progress, yieldTo: yieldToUi });
      S.lastReport = report;
      renderReport(report);
      S.plan = null;
      $("btn-commit").disabled = true;
      $("btn-commit").textContent = "Written · press Plan to start again";
      $("btn-undo").hidden = false;
    } catch (err) {
      showError(err);
      $("btn-commit").disabled = false;
    } finally {
      $("btn-plan").disabled = false;
    }
  }

  async function undo() {
    if (!S.lastReport) return;
    if (!root.confirm("Take the conversion back out of the model? The plates, their nodes, the " +
      "links and the loads this plugin wrote are removed, and the beams are put back.")) return;
    $("btn-undo").disabled = true;
    $("progress").hidden = false;
    try {
      var out = await Commit.undo(S.mapi, S.lastReport, { progress: progress, yieldTo: yieldToUi });
      S.lastReport = null;
      $("btn-undo").hidden = true;
      renderReport({ nodesWritten: 0, nodesReused: 0, plates: 0, verified: 0, thicknesses: [],
        links: 0, ties: 0, loads: 0, temperatures: 0, groups: [], deleted: 0,
        warnings: ["Undone: " + out.plates + " plates and " + out.nodes + " nodes removed, " +
          out.sources + " beams put back."].concat(out.warnings) });
    } catch (err) {
      showError(err);
    } finally {
      $("btn-undo").disabled = false;
    }
  }

  function renderReport(report) {
    $("report-panel").hidden = false;
    var stats = [
      ["Plates written", fmtInt(report.plates)],
      ["Plates verified", fmtInt(report.verified)],
      ["Nodes written", fmtInt(report.nodesWritten)],
      ["Nodes reused", fmtInt(report.nodesReused)],
      ["Rigid links", fmtInt(report.links) + (report.ties ? " + " + fmtInt(report.ties) : "")],
      ["Load nodes", fmtInt(report.loads)],
      ["Beams deleted", fmtInt(report.deleted)],
      ["Groups", (report.groups || []).length ? (report.groups || []).join(", ") : (report.group || "—")]
    ];
    $("report-stats").textContent = "";
    stats.forEach(function (s) {
      var d = document.createElement("div");
      d.className = "stat";
      var b = document.createElement("b"); b.textContent = s[1];
      var sp = document.createElement("span"); sp.textContent = s[0];
      d.appendChild(b); d.appendChild(sp);
      $("report-stats").appendChild(d);
    });
    var list = $("report-warnings");
    list.textContent = "";
    (report.warnings || []).forEach(function (w) {
      var li = document.createElement("li");
      li.textContent = w;
      list.appendChild(li);
    });
  }

  async function capture() {
    try {
      $("btn-capture").disabled = true;
      var b64 = await S.mapi.capture({ mode: "pre", width: 1200, height: 650 });
      if (!b64) throw new Error("CIVIL NX returned no image.");
      var wrap = $("capture-wrap");
      wrap.hidden = false;
      wrap.textContent = "";
      var img = document.createElement("img");
      img.src = "data:image/jpeg;base64," + b64;
      img.alt = "The CIVIL NX viewport after the conversion";
      wrap.appendChild(img);
    } catch (err) {
      showError(err);
    } finally {
      $("btn-capture").disabled = false;
    }
  }

  /* ---------------------------------------------------------------- render */

  function cell(text, cls) {
    var td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }
  function badge(kind, text) {
    var s = document.createElement("span");
    s.className = "badge " + kind;
    s.textContent = text;
    return s;
  }
  function note(text) {
    var s = document.createElement("span");
    s.className = "gate-note";
    s.textContent = text;
    return s;
  }
  function pct(v) { return v == null ? "—" : (Math.abs(v) * 100).toFixed(2) + "%"; }
  function fmtInt(v) { return Number(v || 0).toLocaleString(); }
  function num(v, dflt) { var n = Number(v); return isFinite(n) ? n : dflt; }

  function progress(text, frac) {
    $("progress").hidden = false;
    $("progress-line").textContent = text;
    $("progress-fill").style.width = Math.round((frac || 0) * 100) + "%";
  }
  function showError(err) {
    var box = $("error");
    box.hidden = false;
    $("error-message").textContent = err.message || String(err);
    $("error-hint").textContent = err.hint || "";
    $("error-hint").hidden = !err.hint;
  }
  function clearError() { $("error").hidden = true; }

  /* ------------------------------------------------------------------- init */

  function init() {
    wireHost();
    $("btn-connect").addEventListener("click", connect);
    $("btn-plan").addEventListener("click", readAndPlan);
    $("btn-commit").addEventListener("click", commit);
    $("btn-undo").addEventListener("click", undo);
    $("btn-capture").addEventListener("click", capture);
    $("btn-refresh-sel").addEventListener("click", function (e) { e.preventDefault(); refreshSelection(); });

    ["opt-long", "opt-trans", "opt-facets", "opt-tol", "opt-thick-tol", "opt-calibrate",
     "opt-loads", "opt-link-all", "sel-ids", "sel-sects", "sel-groups"].forEach(function (id) {
      $(id).addEventListener("change", rebuild);
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="sel-mode"]'), function (r) {
      r.addEventListener("change", function () {
        $("sel-sects").disabled = r.value !== "sect";
        $("sel-groups").disabled = r.value !== "group";
        $("sel-ids").disabled = r.value !== "ids";
        rebuild();
      });
    });

    $("in-base").value = Mapi.baseFromLocation(location.search);
    $("in-key").value = Mapi.keyFromLocation(location.search);
    if (Mapi.keyFromLocation(location.search)) connect();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  root.B2PApp = { yieldToUi: yieldToUi, toHost: toHost, state: S };
})(typeof globalThis !== "undefined" ? globalThis : this);
