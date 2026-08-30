/*
 * Mock MIDAS CIVIL NX API + static file server.
 *
 * Serves the API AND the plugin folder from one process, so the whole plugin
 * runs in a browser with CIVIL NX closed:
 *
 *   node mock-midas/server.js
 *   http://localhost:8772/index.html?mapiKey=mock-key&redirectTo=http://localhost:8772/civil
 *
 * The point of this file is NOT to be convenient. It is to reproduce the API's
 * awkward behaviours faithfully, so that code which only works against a polite
 * server fails here rather than in front of a user:
 *
 *   - an error is HTTP 200 with an `error` key, never a 4xx
 *   - a table the model has nothing for is HTTP 200 {"message":""}
 *   - an unknown table KEY is 404 (the plugin's bug, not the model's state)
 *   - a series that cannot be addressed is dropped SILENTLY from the response
 *   - a valid key with a dead session verifies, with status:"disconnected"
 *
 * When you extend it, keep it ARITHMETICALLY CONSISTENT: compute combination
 * values from the values reported for the children, and quantise at every node.
 * A mock that returns plausible-looking numbers turns a passing run into a
 * screenshot rather than a regression test.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.MOCK_PORT || 8772);
const ROOT_DIR = path.resolve(__dirname, "..");   /* the plugin folder */

/* Set MOCK_SESSION=disconnected, or flip state.session at runtime, to exercise
   the "key still valid, CIVIL NX gone" path. */
const state = { session: process.env.MOCK_SESSION || "connected" };

/* ------------------------------------------------------------------ model -- */

const NODES = {};
for (let i = 1; i <= 24; i++) {
  NODES[String(i)] = { X: (i - 1) % 6 * 5, Y: Math.floor((i - 1) / 6) * 3.2, Z: 0 };
}

const ELEMS = {};
for (let i = 1; i <= 18; i++) {
  ELEMS[String(100 + i)] = {
    TYPE: "BEAM", MATL: 1, SECT: 1,
    /* Reads come back with NODE zero-padded to 8 entries — the real API does
       this, so the mock does too. Strip the zeros in the plugin. */
    NODE: [i, i + 1, 0, 0, 0, 0, 0, 0],
    ANGLE: 0
  };
}

const TABLES = {
  NODE: NODES,
  ELEM: ELEMS,
  MATL: {
    "1": { TYPE: "CONC", NAME: "C40/50", PARAM: [{ P_TYPE: 1, STANDARD: "EN04(RC)", DB: "C40/50" }] }
  },
  SECT: {
    "1": { SECTTYPE: "DBUSER", SECT_NAME: "Deck girder", SECT_I: { vSIZE: [1.5, 0.4], DATATYPE: 2 } }
  },
  /* Present but empty: the API answers 200 {"message":""}, NOT 404. */
  THIK: {},
  GRUP: { "1": { NAME: "Deck", P_TYPE: 0, N_LIST: [1, 2, 3], E_LIST: [101, 102] } },
  CONS: { "1": { CONSTRAINT: "111111" }, "24": { CONSTRAINT: "111000" } },
  STLD: { "1": { NAME: "DL", TYPE: "D" }, "2": { NAME: "SDL", TYPE: "D" }, "3": { NAME: "LL", TYPE: "L" } },
  "LCOM-GEN": {
    "1": { NAME: "ULS-1", iTYPE: 0, vCOMB: [{ ANAL: "ST", LCNAME: "DL", FACTOR: 1.35 },
                                            { ANAL: "ST", LCNAME: "LL", FACTOR: 1.5 }] },
    /* iTYPE 1 is an ENVELOPE — envelope-valued, so it may only be addressed
       with a sense: ENV-1(CB:max), never ENV-1(CB). */
    "2": { NAME: "ENV-1", iTYPE: 1, vCOMB: [{ ANAL: "CB", LCNAME: "ULS-1", FACTOR: 1.0 },
                                            { ANAL: "ST", LCNAME: "SDL", FACTOR: 1.0 }] }
  }
};

/* Which series are addressable, and with which suffix. Getting this wrong in a
   plugin produces silence, not an error — which is the whole point of mocking it. */
const ENVELOPE_VALUED = new Set(["ENV-1"]);

/* --------------------------------------------------------------- responses -- */

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(text);
}

/* An API error. Note the status: 200, with an error key. That is what CIVIL NX
   really does, and it is why response.ok is useless here. */
function apiError(res, message) {
  json(res, 200, { error: { message } });
}

/* --------------------------------------------------------------- handlers -- */

function handleVerify(req, res) {
  const key = req.headers["mapi-key"];
  if (!key) return json(res, 200, { keyVerified: false });
  /* A key keeps verifying after CIVIL NX closes — only `status` tells the truth. */
  json(res, 200, { keyVerified: true, status: state.session, program: "civil" });
}

function handleDb(req, res, key) {
  if (req.method === "GET") {
    if (!(key in TABLES)) {
      /* 404 means the CALLER used a key this build does not have. It does not
         mean the model has none of them. */
      return json(res, 404, { error: { message: "no such table: " + key } });
    }
    const rows = TABLES[key];
    if (!rows || Object.keys(rows).length === 0) return json(res, 200, { message: "" });
    return json(res, 200, { [key]: rows });
  }

  if (req.method === "PUT") {
    return readBody(req, (body) => {
      const assign = body && body.Assign;
      if (!assign || typeof assign !== "object") return apiError(res, "Wrong Field");
      if (!(key in TABLES)) TABLES[key] = {};
      /* PUT UPSERTS. It does not clear the table — a rebuild with fewer records
         leaves the old high-numbered ones behind. */
      Object.entries(assign).forEach(([id, rec]) => { TABLES[key][id] = rec; });
      /* A SUCCESSFUL write carries a `message`. A plugin treating any message as
         an error reports failure after the data landed. */
      return json(res, 200, { message: Object.keys(assign).length + " record(s) assigned" });
    });
  }

  if (req.method === "DELETE") {
    if (!(key in TABLES)) return json(res, 404, { error: { message: "no such table: " + key } });
    TABLES[key] = {};
    return json(res, 200, { message: "table cleared" });
  }

  return apiError(res, "unsupported method");
}

function handlePostTable(req, res) {
  readBody(req, (body) => {
    const arg = body && body.Argument;
    if (!arg) return apiError(res, "Wrong Field");

    const label = arg.TABLE_NAME || "table";
    /* MIDAS prefixes its message with the TABLE_NAME the CALLER chose, so a
       plugin matching these messages must not anchor at the start. */
    const fail = (m) => apiError(res, `[${label}] ${m}`);

    if (arg.EXPORT_PATH) return fail("EXPORT_PATH is not accepted here");
    if (!arg.UNIT || !Object.keys(arg.UNIT).length) return fail("UNIT is required");

    const KNOWN = ["BEAMFORCE", "PLATEFORCE", "ELASTICLINK", "REACTIONG", "DISPLACEMENTG"];
    if (!KNOWN.includes(arg.TABLE_TYPE)) {
      /* This is what the bare REACTION / DISPLACEMENT return. It reads like an
         un-analysed model and is not. */
      return fail("there was an error creating utbl. (ex PostMode ...)");
    }

    const keys = (arg.NODE_ELEMS && arg.NODE_ELEMS.KEYS) || [];
    if (!keys.length) return fail("second query is wrong");

    /* Drop unaddressable series SILENTLY — no error, no note. A missing row is
       the only signal the plugin will ever get. */
    const series = (arg.LOAD_CASE_NAMES || []).filter(addressable);

    if (!series.length) return json(res, 200, { message: "" });

    const HEAD = ["Elem", "Load", "FX", "FY", "FZ"];
    const DATA = [];
    keys.forEach((k) => {
      series.forEach((s) => {
        const seed = hash(String(k) + s);
        DATA.push([
          String(k),
          s.replace(/\((CB|ST)(:(max|min|all))?\)$/, (_, __, sense) => sense ? `(${sense.slice(1)})` : ""),
          fmt(seed % 971 / 7), fmt(seed % 613 / 11), fmt(seed % 337 / 3)
        ]);
      });
    });
    return json(res, 200, { [label]: { HEAD, DATA } });
  });
}

/** The suffix must match envelope-valuedness EXACTLY, or the series is dropped. */
function addressable(series) {
  const m = /^(.*)\((ST|CB)(?::(max|min|all))?\)$/.exec(series);
  if (!m) return false;
  const [, name, kind, sense] = m;
  if (kind === "ST") return !sense && !!findCase(name);
  const combo = findCombo(name);
  if (!combo) return false;
  const enveloped = ENVELOPE_VALUED.has(name);
  return enveloped ? !!sense : !sense;
}

const findCase = (n) => Object.values(TABLES.STLD).find((c) => c.NAME === n);
const findCombo = (n) => Object.values(TABLES["LCOM-GEN"]).find((c) => c.NAME === n);

function handleCapture(req, res) {
  readBody(req, (body) => {
    const arg = (body && body.Argument) || {};
    if (arg.FIGURE_NAME && arg.FIGURE_NAME !== "Test Image") {
      return apiError(res, "MIDAS CIVIL NX It's not found Figure Name");
    }
    /* A 1x1 JPEG, returned IN THE RESPONSE — the real API writes nothing to disk. */
    return json(res, 200, {
      base64String:
        "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
        "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
        "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
    });
  });
}

/* ----------------------------------------------------------------- static -- */

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png"
};

function serveStatic(req, res, urlPath) {
  const rel = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const file = path.join(ROOT_DIR, rel);
  /* Never serve outside the plugin folder. */
  if (!file.startsWith(ROOT_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ---------------------------------------------------------------- plumbing -- */

function readBody(req, done) {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw || "{}"); } catch (e) { /* left null */ }
    done(body);
  });
}

const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h); };
/* Quantise, so the plugin's own arithmetic checks are a real test. */
const fmt = (v) => Number(v.toFixed(2));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "MAPI-Key, Content-Type",
      "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS"
    });
    return res.end();
  }

  if (p === "/mapikey/verify") return handleVerify(req, res);
  if (p.startsWith("/civil/db/")) return handleDb(req, res, p.slice("/civil/db/".length));
  if (p === "/civil/post/TABLE") return handlePostTable(req, res);
  if (p === "/civil/view/CAPTURE") return handleCapture(req, res);
  if (p.startsWith("/civil/")) return json(res, 404, { error: { message: "no such endpoint" } });

  return serveStatic(req, res, p);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`mock MIDAS on http://localhost:${PORT}/civil`);
    console.log(`plugin        http://localhost:${PORT}/index.html?mapiKey=mock-key&redirectTo=http://localhost:${PORT}/civil`);
  });
}

module.exports = { server, state, TABLES, addressable };
