/* ==========================================================================
   MIDAS CIVIL NX plugin template — theme
   --------------------------------------------------------------------------
   Follows the operating system until the user chooses for themselves, then
   remembers the choice and stops following.
   ========================================================================== */
(function (root) {
  "use strict";

  var STORE = "plg.theme";

  function systemPref() {
    return (root.matchMedia && root.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark" : "light";
  }

  function stored() {
    try { return localStorage.getItem(STORE); } catch (e) { return null; }
  }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var btn = document.getElementById("btn-theme");
    if (btn) {
      btn.textContent = theme === "dark" ? "Light" : "Dark";
      btn.title = theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme";
    }
  }

  function init() {
    apply(stored() || systemPref());

    /* Follow the system only while the user has expressed no preference. */
    if (root.matchMedia) {
      var mq = root.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () { if (!stored()) apply(systemPref()); };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    var btn = document.getElementById("btn-theme");
    if (btn) btn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try { localStorage.setItem(STORE, next); } catch (e) { /* private mode */ }
      apply(next);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  root.PlgTheme = { apply: apply, init: init };
})(typeof globalThis !== "undefined" ? globalThis : this);
