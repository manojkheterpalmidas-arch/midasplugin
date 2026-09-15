/* ==========================================================================
   Beam to Plate — wiring
   --------------------------------------------------------------------------
   DOM wiring only. Everything that computes lives in section.js, mesh.js,
   plan.js, commit.js and draw.js, so `node test/run.js` exercises the whole
   conversion without a browser.

   The model tables are read ONCE per Plan and held in memory for as long as the
   options are being adjusted — and are NEVER written to localStorage, because a
   restored copy of a model looks identical to a fresh one while describing
   whatever was open when the window closed. commit.js re-reads everything it is about to
   touch immediately before it writes, which is what makes holding them here
   safe.
   ========================================================================== */
(function (root) {
  "use strict";

  var Mapi = root.B2PMapi;
  var Plan = root.B2PPlan;
  var Commit = root.B2PCommit;
  var Draw = root.B2PDraw;
  var Section = root.B2PSection;

  /* Above this the plan is refused rather than built: buildPlan is synchronous,
     and a synchronous minute is a plugin whose close button does not respond. */
  var MAX_PLATES = 150000;
  var WARN_PLATES = 30000;

  var S = {
    mapi: null, connected: false,
    tables: null, beams: null,
    sections: null, plan: null, selected: null,
    overrides: Object.create(null),
    committed: false
  };

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ host bridge */

  /** Post to the host bridge. Returns false when there is no bridge, which is
   *  normal in a plain browser and a real fault inside CIVIL NX. */
  function toHost(message) {
    var w = root.chrome && root.chrome.webview;
    if (!w || typeof w.postMessage !== "function") return false;
    try { w.postMessage(message); return true; }
    catch (e) { return false; }
  }

  function wireHost() {
    $("btn-close").addEventListener("click", function () {
      if (!toHost("REQ_EXIT")) {
        /* window.close() is a NO-OP in WebView2 — kept only for the plain-browser
           development case, and never as the primary path. */
        try { root.close(); } catch (e) { /* ignored */ }
      }
      setTimeout(function () {
        showError({
          message: "This window did not close.",
          hint: "The plugin asked the CIVIL NX host to close it (REQ_EXIT) and the " +
                "host did not act. Close the panel from CIVIL NX instead. In a plain " +
                "browser tab there is no host to ask, and this message is expected."
        });
      }, 800);
    });

    /* REQ_WND_MOVE only works from mousedown; from pointerdown it does nothing
       while REQ_EXIT keeps working, so the bridge looks healthy. Bound to
       #drag-surface, which is a SIBLING of the header controls. */
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

  /* THE MAIN THREAD IS THE UI THREAD. Yield with a MessageChannel message, not
     setTimeout: a resolved promise is a microtask and does not yield at all, and
     setTimeout(0) is clamped to one second whenever the window is not visible. */
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

  /** Run `worker` over `items` in slices, yielding between them. */
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
    } catch (err) {
      S.connected = false;
      setStatus("bad", "Not connected");
      showError(err);
    }
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
        progress("Reading /db/" + key + " (" + done + " of " + total + ")", done / total * 0.8);
      });
      await yieldToUi();

      if (S.tables.ELEM.status === "absent" || S.tables.NODE.status === "absent") {
        /* 404 means the PLUGIN used a wrong key — a bug to surface, not a model
           that happens to be empty. */
        throw new Error("CIVIL NX does not recognise /db/NODE or /db/ELEM on this " +
          "build. That is a fault in the plugin, not in the model.");
      }
      S.beams = Plan.beams(S.tables);
      fillSectionPicker();
      rebuild();
      progress("Model read · " + S.mapi.calls + " requests", 1);
    } catch (err) {
      showError(err);
    } finally {
      $("btn-plan").disabled = false;
    }
  }

  /** Sections that beams in the model actually use, for the "By section" list. */
  function fillSectionPicker() {
    var counts = Object.create(null);
    S.beams.forEach(function (b) {
      if (b.skip) return;
      counts[b.sect] = (counts[b.sect] || 0) + 1;
    });
    var sel = $("sel-sects");
    sel.textContent = "";
    var sectRows = (S.tables.SECT && S.tables.SECT.rows) || {};
    Object.keys(counts).sort(function (a, b) { return Number(a) - Number(b); })
      .forEach(function (sid) {
        var row = sectRows[sid] || {};
        var opt = document.createElement("option");
        opt.value = sid;
        opt.textContent = sid + " · " + (row.SECT_NAME || "unnamed") +
          " (" + counts[sid] + " beam" + (counts[sid] === 1 ? "" : "s") + ")";
        sel.appendChild(opt);
      });

    var convertible = S.beams.filter(function (b) { return !b.skip; }).length;
    $("sel-note").textContent = S.beams.length + " elements read · " + convertible +
      " are beams that can be meshed · " + Object.keys(counts).length + " sections in use";
  }

  /* ------------------------------------------------------------------ plan */

  function options() {
    return {
      longSize: num($("opt-long").value, 0),
      transSize: num($("opt-trans").value, 0),
      pipeFacets: num($("opt-facets").value, 16),
      mergeTol: num($("opt-tol").value, 1e-4),
      originRef: $("opt-origin").value,
      minLong: 1, minTrans: 1,
      overrides: S.overrides,
      existingThik: (S.tables && S.tables.THIK && S.tables.THIK.rows) || {}
    };
  }

  function selection() {
    var mode = document.querySelector('input[name="sel-mode"]:checked').value;
    if (mode === "ids") {
      var parsed = Plan.parseIds($("sel-ids").value);
      return { mode: "ids", ids: parsed.ids, bad: parsed.bad };
    }
    if (mode === "sect") {
      var sects = Array.prototype.slice.call($("sel-sects").selectedOptions)
        .map(function (o) { return o.value; });
      return { mode: "sect", sects: sects };
    }
    return { mode: "all" };
  }

  /** Rebuild the plan from the tables already in memory. Cheap enough to run on
   *  every option change, and guarded by an estimate so it cannot run away. */
  function rebuild() {
    if (!S.tables || !S.beams) return;
    clearError();
    var opts = options();
    var sel = selection();

    if (sel.bad && sel.bad.length) {
      showError({ message: "Could not read the element list: \"" + sel.bad.join('", "') +
        "\" is not an id or a range.", hint: "Use numbers and ranges: 101-118, 205, 300." });
      return;
    }

    S.selected = Plan.select(S.beams, sel);
    var sectIds = [];
    S.selected.forEach(function (b) {
      if (sectIds.indexOf(b.sect) === -1) sectIds.push(b.sect);
    });
    S.sections = Plan.studySections((S.tables.SECT && S.tables.SECT.rows) || {}, sectIds, opts);
    renderSections();

    var est = Plan.estimate(S.selected, S.sections, opts);
    if (est.plates > MAX_PLATES) {
      S.plan = null;
      $("plan-panel").hidden = true;
      $("btn-commit").disabled = true;
      showError({
        message: "That would build about " + fmtInt(est.plates) + " plates, which is " +
          "more than this plugin will put on the UI thread in one go.",
        hint: "Convert fewer beams at a time, or use a coarser mesh size. The limit " +
          "is " + fmtInt(MAX_PLATES) + " plates."
      });
      return;
    }

    S.plan = Plan.buildPlan(S.selected, S.sections, opts);
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

      tr.appendChild(cell(st.name + "  (" + sid + ")" +
        (st.sectType ? "\n" + st.sectType : "")));

      /* Shape picker: this is what makes the plugin usable where the dimension
         tables in section.js are wrong, or where the model publishes no SHAPE. */
      var shapeCell = document.createElement("td");
      var sel = document.createElement("select");
      var none = document.createElement("option");
      none.value = ""; none.textContent = "— not converted —";
      sel.appendChild(none);
      Object.keys(Section.SHAPES).forEach(function (code) {
        var o = document.createElement("option");
        o.value = code;
        o.textContent = Section.SHAPES[code].label + " (" + code + ")";
        if (st.shape === code) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () {
        var ov = S.overrides[sid] || (S.overrides[sid] = {});
        ov.shape = sel.value || null;
        if (sel.value && !ov.dims) {
          /* Re-read the published vSIZE under the newly chosen shape, so the
             user starts from the model's own numbers rather than from blanks. */
          ov.dims = Section.dimsFromVSize(sel.value, st.vSIZE || []);
        }
        rebuild();
      });
      shapeCell.appendChild(sel);
      tr.appendChild(shapeCell);

      /* Dimensions, editable. */
      var dimCell = document.createElement("td");
      if (st.shape && Section.SHAPES[st.shape]) {
        var wrap = document.createElement("div");
        wrap.className = "dims";
        Section.SHAPES[st.shape].keys.forEach(function (k) {
          var lab = document.createElement("label");
          lab.className = "dim";
          lab.appendChild(document.createTextNode(k));
          var inp = document.createElement("input");
          inp.type = "number";
          inp.step = "0.001";
          inp.value = st.dims && st.dims[k] != null ? st.dims[k] : 0;
          inp.addEventListener("change", function () {
            var ov = S.overrides[sid] || (S.overrides[sid] = {});
            ov.dims = Object.assign({}, st.dims, ov.dims);
            ov.dims[k] = Number(inp.value);
            ov.shape = ov.shape || st.shape;
            rebuild();
          });
          lab.appendChild(inp);
          wrap.appendChild(lab);
        });
        dimCell.appendChild(wrap);
        if (st.shape === "B") {
          dimCell.appendChild(note("C is not used: the webs are placed against the " +
            "outer faces and the area check is left to catch it."));
        }
        if (st.shape === "SB") {
          dimCell.appendChild(note("A solid rectangle becomes ONE plate through the " +
            "mid-plane, of thickness B. Area-exact, but an idealisation."));
        }
      } else {
        var r = document.createElement("span");
        r.className = "reason";
        r.textContent = st.reason || "not interpreted";
        dimCell.appendChild(r);
      }
      tr.appendChild(dimCell);

      tr.appendChild(cell(st.area != null ? fmtNum(st.area, 6) : "—", "num"));

      /* The gate. A section that fails it is not converted unless the user
         deliberately accepts it — and accepting is per section, not global. */
      var gateCell = document.createElement("td");
      if (!st.gate) {
        gateCell.appendChild(badge("neutral", "—"));
      } else if (st.gate.status === "pass") {
        gateCell.appendChild(badge("ok", "area matches"));
        gateCell.appendChild(note("published " + fmtNum(st.gate.published, 6) +
          " · out by " + (st.gate.err * 100).toFixed(2) + "%"));
      } else if (st.gate.status === "fail") {
        gateCell.appendChild(badge("bad", "area is out by " +
          (st.gate.err * 100).toFixed(1) + "%"));
        gateCell.appendChild(note("published " + fmtNum(st.gate.published, 6) +
          ", this wall model gives " + fmtNum(st.gate.derived, 6) +
          ". The dimensions are probably in a different order than assumed."));
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
        gateCell.appendChild(accept);
      } else {
        gateCell.appendChild(badge("warn", "no area published"));
        gateCell.appendChild(note("this section publishes no area, so nothing checks " +
          "the dimensions. Read them off the section dialog before converting."));
      }
      tr.appendChild(gateCell);

      var svgCell = document.createElement("td");
      svgCell.className = "sect-svg";
      svgCell.innerHTML = Draw.sectionSvg(st.model, { width: 170, height: 130, label: st.name });
      tr.appendChild(svgCell);

      body.appendChild(tr);
    });
  }

  /* ------------------------------------------------------------------ plan */

  function renderPlan() {
    var plan = S.plan;
    $("plan-panel").hidden = false;
    var t = plan.totals;

    var stats = [
      ["Beams converted", fmtInt(t.converted)],
      ["Nodes", fmtInt(t.nodes)],
      ["Plates", fmtInt(t.plates)],
      ["Thicknesses", fmtInt(t.thicknesses)],
      /* The invariant, shown rather than merely checked: plate volume against
         section area x member length. A mesh that is geometrically wrong shows
         up here before anything is written. */
      ["Volume check", t.expected > 0
        ? (Math.abs(t.worstError) < 1e-6 ? "exact" : "out by " +
           (t.worstError * 100).toFixed(4) + "%")
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

    $("mesh-preview").innerHTML = Draw.meshSvg(plan.pool, plan.plates,
      { width: 700, height: 250 });

    var problems = Plan.problems(plan, S.beams, S.selected);
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
      ? "Write " + fmtInt(t.nodes) + " nodes and " + fmtInt(t.plates) + " plates"
      : "Write to model";
    if (ok && t.plates > WARN_PLATES) {
      $("btn-commit").title = "A mesh this size takes a while to write. The window " +
        "stays responsive; leave it displayed, because a hidden WebView2 window " +
        "throttles everything to about one step a second.";
    }
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
        sources: S.selected.filter(function (b) {
          return S.plan.elements.some(function (e) { return e.id === b.id && e.ok; });
        }),
        groupName: $("opt-group").value.trim(),
        reuseExisting: $("opt-reuse").checked,
        deleteSources: $("opt-delete").checked,
        mergeTol: num($("opt-tol").value, 1e-4)
      }, { progress: progress, yieldTo: yieldToUi });
      renderReport(report);
      /* The plan now describes a model that has changed under it — a second
         press must re-read rather than write the same mesh twice. */
      S.plan = null;
      $("btn-commit").disabled = true;
      $("btn-commit").textContent = "Written · press Plan to start again";
    } catch (err) {
      showError(err);
      $("btn-commit").disabled = false;
    } finally {
      $("btn-plan").disabled = false;
    }
  }

  function renderReport(report) {
    $("report-panel").hidden = false;
    var stats = [
      ["Nodes written", fmtInt(report.nodesWritten)],
      ["Nodes reused", fmtInt(report.nodesReused)],
      ["Plates written", fmtInt(report.plates)],
      ["Plates verified", fmtInt(report.verified)],
      ["Thicknesses", fmtInt(report.thicknesses.length)],
      ["Beams deleted", fmtInt(report.deleted)],
      ["Group", report.group || "—"]
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
  function fmtInt(v) { return Number(v || 0).toLocaleString(); }
  function fmtNum(v, p) {
    if (v == null || !isFinite(v)) return "—";
    return Number(v).toFixed(p == null ? 4 : p);
  }
  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }

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
    $("btn-capture").addEventListener("click", capture);

    /* Every option rebuilds the plan from the tables already in memory — no
       re-read, so it is instant, and the preview always matches the controls. */
    ["opt-long", "opt-trans", "opt-facets", "opt-tol", "opt-origin", "sel-ids", "sel-sects"]
      .forEach(function (id) {
        $(id).addEventListener("change", rebuild);
      });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="sel-mode"]'),
      function (r) {
        r.addEventListener("change", function () {
          $("sel-sects").disabled = r.value !== "sect";
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

  root.B2PApp = { yieldToUi: yieldToUi, runChunked: runChunked, toHost: toHost };
})(typeof globalThis !== "undefined" ? globalThis : this);
