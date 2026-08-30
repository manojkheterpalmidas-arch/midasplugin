/* ==========================================================================
   MIDAS CIVIL NX plugin template — MAPI client
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

  /* The only paths this plugin may POST to. Keep this honest — it is what backs
     the "non-mutating" claim in the header. */
  var ALLOWED_POST = ["/post/TABLE", "/view/CAPTURE"];

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
    var r = await fetch(this.base + "/db/" + key, { headers: { "MAPI-Key": this.key } });
    var text = await r.text();
    this.bytes += text.length;

    var body = null;
    try { body = JSON.parse(text); } catch (e) { /* left null */ }

    if (r.status === 404) return { rows: null, status: "absent", reason: "no such table key" };
    if (!body) return { rows: null, status: "error", reason: "unparseable response" };
    if (body.error) {
      return { rows: null, status: "error", reason: errText(body.error) };
    }
    if (body[key] && typeof body[key] === "object") return { rows: body[key], status: "ok" };
    if (body.message === "") return { rows: null, status: "empty" };
    return { rows: null, status: "empty", reason: JSON.stringify(body).slice(0, 200) };
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
   * @param {Object} arg
   *   token      TABLE_TYPE, e.g. "BEAMFORCE", "REACTIONG"
   *   keys       element or node ids
   *   series     LOAD_CASE_NAMES, ALREADY SUFFIXED — see references/result-tables.md
   *   stageStep  optional construction-stage key
   * @returns {{HEAD: Array, DATA: Array}|null}  null = nothing was addressable
   */
  Mapi.prototype.postTable = async function (arg) {
    var label = "plg";                    /* our own response label, not a token */
    var Argument = {
      /* TABLE_NAME is a label WE choose; the reply comes back keyed by it. It is
         NOT the table token — that is TABLE_TYPE. */
      TABLE_NAME: label,
      TABLE_TYPE: arg.token,
      /* UNIT:{} makes the call fail; send real units. */
      UNIT: { FORCE: this.unit.FORCE, DIST: this.unit.DIST },
      NODE_ELEMS: { KEYS: (arg.keys || []).map(Number) },
      LOAD_CASE_NAMES: (arg.series || []).slice(),
      /* Nine significant figures at any magnitude, rather than the model's
         display format (2 dp for forces). Needed if the plugin self-validates. */
      STYLES: { FORMAT: "Scientific", PLACE: 8 }
    };
    if (arg.stageStep) {
      Argument.STAGE_STEP = [arg.stageStep];
      Argument.OPT_CS = true;
    }

    var body = await this.post("/post/TABLE", { Argument: Argument }, arg);
    var t = body && body[label];
    /* An unaddressable series is dropped SILENTLY — {"message":""}, HTTP 200, no
       error. In a mixed request the good series still come back, so a missing
       row is the only signal. Callers must check what they asked for. */
    if (!t || !t.HEAD) return null;
    return t;
  };

  /** POST /view/CAPTURE — the only image route on the API. Nothing hits disk. */
  Mapi.prototype.capture = async function (opts) {
    opts = opts || {};
    var Argument = {};
    if (opts.figureName) {
      /* A saved user figure carries its own display state — do NOT send
         SET_MODE/SET_HIDDEN alongside FIGURE_NAME. */
      Argument.FIGURE_NAME = opts.figureName;
    } else {
      Argument.SET_MODE = opts.mode || "pre";
      Argument.SET_HIDDEN = false;
    }
    if (opts.width) Argument.WIDTH = opts.width;
    if (opts.height) Argument.HEIGHT = opts.height;
    var body = await this.post("/view/CAPTURE", { Argument: Argument }, {});
    return body && body.base64String ? body.base64String : null;
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
    keyFromLocation: keyFromLocation
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.PlgMapi = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
