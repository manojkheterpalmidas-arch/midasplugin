/* ==========================================================================
   Concurrent Forces — MAPI client
   --------------------------------------------------------------------------
   Two API behaviours make naive error handling useless. Both were measured on a
   live CIVIL NX 2026 session, and both are handled here rather than at the call
   sites:

   - Errors arrive as HTTP 200 (sometimes 201) with an `error` key in the body.
     Checking the status code alone reports every rejected request as a success.
   - A SUCCESSFUL write also carries a `message` field. Treating any `message` as
     an error makes the plugin report failure after the data has landed — and the
     user's natural response, committing again, duplicates everything.

   Set ALLOWED_POST to the paths this plugin is permitted to POST to, and keep it
   as short as the plugin's read/write claim. EXPORT_PATH — the argument that
   makes CIVIL NX write a file to the user's disk — is stripped from every body
   on the way out.
   ========================================================================== */
(function (root) {
  "use strict";

  var DEFAULT_BASE = "https://moa-engineers.midasit.com:443/civil";

  /* The only path this plugin may POST to. Keep this honest — it is what backs
     the "non-mutating" claim in the header. /post/TABLE reads results and
     changes nothing; there is no PUT, no DELETE and no route that writes to
     disk anywhere in this plugin. */
  var ALLOWED_POST = ["/post/TABLE"];

  function Mapi(opts) {
    opts = opts || {};
    this.base = (opts.base || DEFAULT_BASE).replace(/\/+$/, "");
    this.key = opts.key || "";
    this.unit = opts.unit || { FORCE: "kN", DIST: "m" };
    this.calls = 0;
    this.bytes = 0;
  }

  Mapi.prototype.headers = function () {
    return { "MAPI-Key": this.key, "Content-Type": "application/json" };
  };

  /* ---------------------------------------------------------------- verify */

  /** Verify the key AND that the session behind it is alive. */
  Mapi.prototype.verify = async function () {
    /* /mapikey/verify sits OUTSIDE the program prefix, so it is reached by
       stepping up out of /civil rather than by appending to it. */
    var url = this.base.replace(/\/(civil|gen|fea)$/, "") + "/mapikey/verify";
    var r = await fetch(url, { headers: { "MAPI-Key": this.key } });
    var body = await r.json().catch(function () { return null; });

    if (!body || body.keyVerified !== true) {
      throw new Error("The MAPI key was not accepted. Check that CIVIL NX is open " +
        "and that the key is the current one.");
    }
    /* A key can verify while the SESSION is gone — CIVIL NX closed, or the model
       reopened. The reply then reads keyVerified:true with status:"disconnected",
       and every subsequent request fails with "client does not exist". Checking
       keyVerified alone reports that as connected and then falls over on the
       first read. */
    if (body.status && String(body.status).toLowerCase() !== "connected") {
      throw new Error("The MAPI key is valid but the CIVIL NX session is " +
        body.status + ". Open the model in CIVIL NX and try again.");
    }
    return body;
  };

  /* ------------------------------------------------------------------ read */

  /**
   * Read a /db/ table.
   *
   * @returns {{rows: Object|null, status: string, reason: string=}}
   *   status "ok"      the table has rows
   *          "empty"   the table exists, the model holds nothing of that kind
   *                    (MIDAS answers HTTP 200 {"message":""})
   *          "absent"  404 — this build has no such table, i.e. WE used a wrong
   *                    key. Surface it as a bug, not as "the model has none".
   *          "error"   the API reported something else
   */
  Mapi.prototype.db = async function (key) {
    this.calls++;
    var url = this.base + "/db/" + key;
    var r = await fetch(url, { headers: { "MAPI-Key": this.key } });
    var text = await r.text();
    this.bytes += text.length;

    var body = null;
    try { body = JSON.parse(text); } catch (e) { /* left null */ }

    /* The URL travels with the result. When a read fails, the single most
       useful thing a user can tell you is what was actually requested — and a
       whole model reading "absent" is nearly always one wrong base, not
       forty-seven wrong table keys. */
    if (r.status === 404) {
      return { rows: null, status: "absent", url: url, reason: "GET " + url + " answered 404" };
    }
    if (!body) return { rows: null, status: "error", url: url, reason: "GET " + url + " did not return JSON (" + r.status + ")" };
    if (body.error) {
      return { rows: null, status: "error", url: url, reason: errText(body.error) };
    }
    if (body[key] && typeof body[key] === "object") return { rows: body[key], status: "ok", url: url };
    if (body.message === "") return { rows: null, status: "empty", url: url };
    return { rows: null, status: "empty", url: url, reason: JSON.stringify(body).slice(0, 200) };
  };

  /* -------------------------------------------------------- base resolution */

  /**
   * Candidate base URLs, in the order they should be tried.
   *
   * The host hands the plugin its base as ?redirectTo=. Whether that base
   * carries the PROGRAM SEGMENT (/civil) is not something a plugin can assume,
   * and getting it wrong fails in a way that reads like a plugin bug rather
   * than a URL problem: /mapikey/verify sits OUTSIDE the segment, so the
   * connection check passes either way, and then EVERY /db/ read answers 404 —
   * which db() correctly reports as "the plugin used a wrong table key",
   * forty-seven times over.
   */
  function baseCandidates(base) {
    var b = String(base || "").replace(/\/+$/, "");
    var out = [b];
    if (!/\/(civil|gen|fea)$/i.test(b)) out.push(b + "/civil");
    else out.push(b.replace(/\/(civil|gen|fea)$/i, ""));
    return out;
  }

  /**
   * Settle which base actually serves /db/, by reading one table that every
   * structural model has.
   *
   * A candidate is right unless it answers 404. Empty (200 {"message":""}) means
   * the base is right and the model holds none of that kind; an `error` means
   * the base is right and something else is wrong — a dead session, say — and
   * trying further bases would only bury it.
   *
   * @returns {{base, tried, changed, resolved}}
   */
  Mapi.prototype.resolveBase = async function (probeKey) {
    probeKey = probeKey || "ELEM";
    var cands = baseCandidates(this.base);
    var given = cands[0];
    var tried = [];

    for (var i = 0; i < cands.length; i++) {
      this.base = cands[i];
      var r = await this.db(probeKey);
      tried.push({ base: cands[i], status: r.status });
      if (r.status !== "absent") {
        this.base = cands[i];
        return { base: cands[i], tried: tried, changed: cands[i] !== given, resolved: true };
      }
    }
    /* Nothing answered. Keep the host's own base — it is the honest default —
       and let the caller report what was tried. */
    this.base = given;
    return { base: given, tried: tried, changed: false, resolved: false };
  };

  /** Read several tables concurrently. */
  Mapi.prototype.dbAll = async function (keys) {
    var self = this;
    var out = {};
    await Promise.all(keys.map(async function (k) { out[k] = await self.db(k); }));
    return out;
  };

  /* ----------------------------------------------------------------- write */

  /**
   * PUT /db/<key>.
   *
   * NOTE: PUT upserts by id. It does NOT clear the table — rebuilding a model
   * with fewer records leaves the old high-numbered ones behind. DELETE first
   * (GRUP, then ELEM, then NODE) if replacement is what you mean.
   */
  Mapi.prototype.put = async function (key, assign) {
    this.calls++;
    var r = await fetch(this.base + "/db/" + key, {
      method: "PUT", headers: this.headers(),
      body: JSON.stringify({ Assign: assign })
    });
    var body = await r.json().catch(function () { return null; });
    if (!body) throw new Error("PUT /db/" + key + " returned a response that is not JSON (" + r.status + ").");
    /* The status code is NOT the signal — a rejected write answers 200/201 with
       an error key, and an accepted one answers with a message. */
    if (body.error) throw new MapiError(errText(body.error), { path: "/db/" + key });
    return body;
  };

  Mapi.prototype.del = async function (key) {
    this.calls++;
    var r = await fetch(this.base + "/db/" + key, {
      method: "DELETE", headers: this.headers()
    });
    var body = await r.json().catch(function () { return null; });
    if (body && body.error) throw new MapiError(errText(body.error), { path: "/db/" + key });
    return body;
  };

  /* ---------------------------------------------------------------- tables */

  /**
   * POST /post/TABLE — an analysis result table. The model must be analysed.
   *
   * ONE CALL PER ELEMENT TYPE PER FAMILY. Every element of that type goes in
   * NODE_ELEMS.KEYS and every selected case in LOAD_CASE_NAMES; looping per
   * element or per load case is the single biggest performance trap in this
   * kind of plugin, and on a 200-element set it is the difference between one
   * request and several thousand.
   *
   * @param {Object} arg
   *   token      TABLE_TYPE, e.g. "BEAMFORCE"
   *   keys       element ids
   *   series     LOAD_CASE_NAMES, ALREADY SUFFIXED
   *   optCs      true to ask for the CONSTRUCTION-STAGE family
   *   stageStep  the stage/step token, mandatory whenever optCs is true
   *   unit       { FORCE, DIST } overriding the client default
   * @returns {{HEAD, DATA}|null}  null = nothing in the request was addressable
   */
  Mapi.prototype.postTable = async function (arg) {
    var label = "cfp";                    /* our own response label, not a token */
    var unit = arg.unit || this.unit;
    var Argument = {
      /* TABLE_NAME is a label WE choose; the reply comes back keyed by it. It is
         NOT the table token — that is TABLE_TYPE. */
      TABLE_NAME: label,
      TABLE_TYPE: arg.token,
      /* UNIT:{} makes the call fail; send real units. Asking MIDAS for the
         user's units is also what makes kN-m and kip-ft both correct without a
         single conversion in this plugin. */
      UNIT: { FORCE: unit.FORCE, DIST: unit.DIST },
      NODE_ELEMS: { KEYS: (arg.keys || []).map(Number) },
      LOAD_CASE_NAMES: (arg.series || []).slice(),
      /* Nine significant figures at any magnitude, rather than the model's
         display format. The plugin reconciles its own arithmetic against what
         MIDAS reports, and 2 dp is not enough to do that honestly. */
      STYLES: { FORMAT: "Scientific", PLACE: 8 }
    };

    /* OPT_CS IS A MODE SWITCH, NOT A FILTER. One request answers with the
       construction-stage family or with everything else, never both, and the
       family it excludes is absent at HTTP 200 with no error at all. And with
       OPT_CS on but no STAGE_STEP every stage comes back interleaved, so
       anything keyed on one stage silently overwrites rows — a stage is
       required here rather than merely recommended. */
    if (arg.optCs) {
      if (!arg.stageStep) {
        throw new Error("A construction-stage result query needs a stage/step. " +
          "Sending OPT_CS without STAGE_STEP returns every stage at once.");
      }
      Argument.OPT_CS = true;
      Argument.STAGE_STEP = [arg.stageStep];
    }

    var body = await this.post("/post/TABLE", { Argument: Argument }, arg);
    var t = body && body[label];
    /* An unaddressable series is dropped SILENTLY — {"message":""}, HTTP 200,
       no error. In a mixed request the good series still come back, so a
       missing row is the only signal. Callers must check what they asked for. */
    if (!t || !t.HEAD) return null;
    return t;
  };

  /**
   * Which of these table tokens exists in this build.
   *
   * Tokens are not guessable and a wrong one is not obviously wrong — it
   * answers "there was an error creating utbl", which reads like an un-analysed
   * model. So the plugin asks rather than assumes: an empty LOAD_CASE_NAMES
   * enumerates what the model publishes, and a token that does not exist fails
   * loudly enough to tell the two apart.
   *
   * @returns {{token, table}|null}
   */
  Mapi.prototype.resolveToken = async function (candidates, keys, opts) {
    opts = opts || {};
    var tried = [];
    for (var i = 0; i < candidates.length; i++) {
      try {
        var t = await this.postTable({
          token: candidates[i], keys: keys, series: [],
          optCs: opts.optCs, stageStep: opts.stageStep, unit: opts.unit
        });
        return { token: candidates[i], table: t, tried: tried };
      } catch (e) {
        tried.push({ token: candidates[i], message: e.message });
        /* "creating utbl" means THIS TOKEN does not exist — try the next.
           Anything else (no analysis result, no element of that type among the
           keys, a dead session) is about the model or the request, and trying
           further tokens would only bury it. */
        if (!/creating utbl/i.test(e.message)) throw e;
      }
    }
    return null;
  };

  /**
   * Every series the model publishes for a family, from one element.
   *
   * This is the cheapest way to tell "this series does not exist" from "this
   * series was dropped", and it is worth doing on the failure path before
   * blaming the request. A combination's definition is not evidence that its
   * constituents produce results.
   */
  Mapi.prototype.enumerateSeries = async function (arg) {
    var t = await this.postTable({
      token: arg.token, keys: arg.keys, series: [],
      optCs: arg.optCs, stageStep: arg.stageStep, unit: arg.unit
    });
    if (!t) return [];
    var col = -1;
    (t.HEAD || []).forEach(function (h, i) {
      if (col < 0 && String(h).trim().toLowerCase() === "load") col = i;
    });
    if (col < 0) return [];
    var seen = Object.create(null), out = [];
    (t.DATA || []).forEach(function (d) {
      var v = String(d[col] == null ? "" : d[col]).trim();
      if (!v || seen[v]) return;
      seen[v] = true;
      out.push(v);
    });
    return out;
  };

  /* ------------------------------------------------------------- POST core */

  Mapi.prototype.post = async function (path, body, ctx) {
    if (ALLOWED_POST.indexOf(path) === -1) {
      /* Deliberate: the whitelist is what backs the plugin's stated read/write
         claim. Adding a path here is a decision, not an accident. */
      throw new Error("This plugin is not permitted to POST to " + path + ".");
    }
    /* Never let CIVIL NX write to the user's disk on our behalf. */
    if (body && body.Argument) delete body.Argument.EXPORT_PATH;

    this.calls++;
    var r = await fetch(this.base + path, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body)
    });
    var text = await r.text();
    this.bytes += text.length;

    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { throw new Error(path + " returned a response that is not JSON (" + r.status + ")."); }

    if (parsed && parsed.error) throw new MapiError(errText(parsed.error), ctx || {});
    return parsed;
  };

  /* ---------------------------------------------------------------- errors */

  function errText(err) {
    if (!err) return "unspecified";
    if (typeof err === "string") return err;
    return String(err.message || JSON.stringify(err));
  }

  /**
   * The messages MIDAS actually sends, translated into what to do about them.
   * MIDAS prefixes post/TABLE messages with the TABLE_NAME we chose, so none of
   * these matches may be anchored at the start of the string.
   */
  function MapiError(message, ctx) {
    var e = new Error(message);
    e.name = "MapiError";
    e.context = ctx || {};

    if (/wrong field/i.test(message)) {
      e.hint = "A key name in the payload is not recognised. This is a field-name " +
               "problem, not a value problem — stop adjusting values.";
    } else if (/data contain errors/i.test(message)) {
      e.hint = "The field names are accepted; the values or their arrangement are not.";
    } else if (/second query is wrong/i.test(message)) {
      e.hint = "The model holds no elements of the type this table reports on, or " +
               "none of the requested ids are of that type.";
    } else if (/creating utbl/i.test(message)) {
      e.hint = "That table token does not exist in this build. Node tables carry a " +
               "coordinate suffix — REACTIONG and DISPLACEMENTG, not REACTION and " +
               "DISPLACEMENT.";
    } else if (/no analysis result/i.test(message)) {
      e.hint = "The model is open but has not been analysed, or an edit since the " +
               "last run invalidated the results.";
    } else if (/client does not exist/i.test(message)) {
      e.hint = "The CIVIL NX session has gone — the program was closed, or the model " +
               "reopened — even though the key itself is still valid. Reconnect.";
    }
    return e;
  }

  /* ------------------------------------------------------- host query string */

  /** The host supplies the base as ?redirectTo=. It must always win. */
  function baseFromLocation(search) {
    var redirect = new URLSearchParams(search || "").get("redirectTo");
    /* A base remembered in localStorage must NEVER override the host's own
       redirectTo — the plugin would then talk to the wrong instance. */
    if (redirect) return redirect.replace(/\/+$/, "");
    return DEFAULT_BASE;
  }

  function keyFromLocation(search) {
    return new URLSearchParams(search || "").get("mapiKey") || "";
  }

  var api = {
    Mapi: Mapi,
    MapiError: MapiError,
    DEFAULT_BASE: DEFAULT_BASE,
    ALLOWED_POST: ALLOWED_POST,
    baseFromLocation: baseFromLocation,
    keyFromLocation: keyFromLocation,
    baseCandidates: baseCandidates
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.PlgMapi = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
