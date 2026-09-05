/* ==========================================================================
   MIDAS CIVIL NX plugin template — wiring
   --------------------------------------------------------------------------
   DOM wiring only. Anything that computes belongs in a pure module beside this
   one, so `node test/run.js` can exercise it without a browser.
   ========================================================================== */
(function (root) {
  "use strict";

  var Mapi = root.PlgMapi;
  var Model = root.PlgModel;

  var S = {
    mapi: null,
    connected: false,
    model: null
  };

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------------ host bridge */

  /** Post to the host bridge. Returns false when there is no bridge, which is
   *  normal in a plain browser and a real fault inside CIVIL NX.
   *
   *  Everything that talks to the host goes through here so the "is there a
   *  bridge" question is asked in one place. A bare try/catch at each call site
   *  cannot tell a missing bridge from a thrown message. */
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
           was never wired — and is exactly how users report it. Try it for the
           plain-browser case, then SAY SO. */
        try { root.close(); } catch (e) { /* ignored */ }
      }
      /* If the host honoured REQ_EXIT the window is gone and this never runs. */
      setTimeout(function () {
        showError({
          message: "This window did not close.",
          hint: "The plugin asked the CIVIL NX host to close it (REQ_EXIT) and " +
                "the host did not act. Close the panel from CIVIL NX instead. " +
                "In a plain browser tab there is no host to ask, and this " +
                "message is expected."
        });
      }, 800);
    });

    /* REQ_WND_MOVE only works from mousedown. From pointerdown the window
       simply will not drag, while REQ_EXIT from the same bridge keeps working —
       so the bridge looks healthy.

       Bound to #drag-surface, which is a SIBLING of the header controls, so a
       press on the close button is never part of the drag surface at all. The
       target check below is belt and braces; nothing depends on it. */
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
     NO CLICK IS DELIVERED — including the one on the close button. A plugin
     that parses a large result body, or loops over tens of thousands of rows,
     has a window that cannot be closed for the duration, and it will be
     reported as a broken close button rather than as slow code.

     The tell: it works on a small test model and is dead on a real one. A
     symptom that scales with model size is a blocking bug, not a wiring bug.

     Yield with a MessageChannel message, NOT setTimeout:
       - a resolved promise is a MICROtask and does not yield at all;
       - setTimeout(0) is CLAMPED TO ONE SECOND whenever the window is not
         visible, so a few hundred yields become minutes of pure waiting the
         moment the user clicks away from the plugin;
       - a MessageChannel message is a macrotask and is not throttled.
     Input events outrank both, so one turn of the loop is all a click needs. */
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

  /** Run `worker` over `items` in slices, yielding between them.
   *
   *  Size the slice by how long ONE call takes, not by how tidy the number
   *  looks: the aim is to be back in the event loop within a frame or two. */
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
       override ?redirectTo=. */
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
      $("btn-run").disabled = false;
    } catch (err) {
      S.connected = false;
      setStatus("bad", "Not connected");
      showError(err);
    }
  }

  /* -------------------------------------------------------------------- run */

  async function run() {
    if (!S.connected) return;
    $("btn-run").disabled = true;
    $("progress").hidden = false;
    clearError();

    try {
      S.model = await Model.readModel(S.mapi, function (done, total, label) {
        $("progress-line").textContent = "Reading " + label + " (" + done + " of " + total + ")";
        $("progress-fill").style.width = Math.round((done / total) * 100) + "%";
      });
      render(S.model);
      $("progress-line").textContent =
        S.model.read + " of " + S.model.total + " tables read · " +
        S.mapi.calls + " requests";
    } catch (err) {
      showError(err);
    } finally {
      $("btn-run").disabled = false;
    }
  }

  /* ----------------------------------------------------------------- render */

  function render(model) {
    var tbody = $("summary-body");
    tbody.textContent = "";

    model.summary.forEach(function (row) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(row.label));
      tr.appendChild(cell(row.status === "ok" ? String(row.count) : "—", "num"));
      /* "Not applicable" and "not read" are distinguished from a real zero.
         A green tick over an empty population is a lie. */
      tr.appendChild(cell(row.note || "read", "note"));
      tbody.appendChild(tr);
    });

    var ext = Model.extents(model.tables.NODE && model.tables.NODE.rows);
    $("extents").textContent = ext
      ? "Model extents: " + ext.size.map(function (v) { return v.toFixed(3); }).join(" × ")
      : "Model extents: no nodes";

    $("results").hidden = false;
  }

  function cell(text, cls) {
    var td = document.createElement("td");
    td.textContent = text;
    if (cls) td.className = cls;
    return td;
  }

  /* ------------------------------------------------------------------ error */

  function showError(err) {
    var box = $("error");
    box.hidden = false;
    /* An error gets a HINT, not an echo. "second query is wrong" helps nobody. */
    $("error-message").textContent = err.message || String(err);
    $("error-hint").textContent = err.hint || "";
    $("error-hint").hidden = !err.hint;
  }

  function clearError() { $("error").hidden = true; }

  /* ------------------------------------------------------------------- init */

  function init() {
    wireHost();
    $("btn-connect").addEventListener("click", connect);
    $("btn-run").addEventListener("click", run);
    $("in-base").value = Mapi.baseFromLocation(location.search);
    $("in-key").value = Mapi.keyFromLocation(location.search);
    /* Connect on load when the host supplied a key; otherwise wait for the user. */
    if (Mapi.keyFromLocation(location.search)) connect();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(typeof globalThis !== "undefined" ? globalThis : this);
