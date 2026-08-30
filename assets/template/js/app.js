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

  function wireHost() {
    /* The host listens for REQ_EXIT and REQ_WND_MOVE. REQ_MOVE is IGNORED — a
       plugin sending it has a title bar that silently does nothing. */
    $("btn-close").addEventListener("click", function () {
      try { root.chrome.webview.postMessage("REQ_EXIT"); }
      catch (e) { root.close(); }
    });

    /* REQ_WND_MOVE only works from mousedown. From pointerdown the window
       simply will not drag, while REQ_EXIT from the same bridge keeps working —
       so the bridge looks healthy. Gate on the button so a right-click on the
       header does not start a drag and swallow the context menu. */
    document.querySelector("header.app-head").addEventListener("mousedown", function (e) {
      if (e.button !== 0 && e.button !== 1) return;
      if (e.target.closest("button, input, select, nav, a")) return;
      try { root.chrome.webview.postMessage("REQ_WND_MOVE"); }
      catch (err) { /* not hosted — running in a plain browser */ }
    });
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
