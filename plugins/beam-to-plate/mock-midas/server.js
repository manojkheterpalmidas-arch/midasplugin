/*
 * Mock MIDAS CIVIL NX API + static file server, for Beam to Plate.
 *
 *   node mock-midas/server.js
 *   http://localhost:8773/index.html?mapiKey=mock-key&redirectTo=http://localhost:8773/civil
 *
 * It reproduces the API's awkward behaviours rather than being convenient:
 *
 *   - an error is HTTP 200 with an `error` key, never a 4xx
 *   - a table the model has nothing for is HTTP 200 {"message":""}
 *   - an unknown table KEY is 404 (the plugin's bug, not the model's state)
 *   - a valid key with a dead session verifies, with status:"disconnected"
 *   - PUT UPSERTS, and an Assign at a key that does not exist IGNORES the number
 *     and appends at the next free slot
 *   - DELETE /db/ELEM/<id> removes one row; /db/ELEM/key/<id> is a 404
 *
 * The section library below is the part that makes the test suite worth
 * running. Every section carries a PUBLISHED AREA that was computed by hand
 * from the shape's own formula and written here as a literal — NOT by calling
 * the plugin's own wall model. That is what makes the plugin's area gate a real
 * check: if section.js reads a dimension list in the wrong order, its area
 * moves and the gate here catches it.
 *
 * Section 7 exists to be caught: its vSIZE and its published area genuinely
 * disagree under the plugin's reading, so the gate must fail it and the plan
 * must leave its beam alone.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.MOCK_PORT || 8773);
const ROOT_DIR = path.resolve(__dirname, "..");

const state = {
  session: process.env.MOCK_SESSION || "connected",
  /* NOT a live behaviour: the real API appends at the next free slot, which is
     usually the number the plugin sent anyway. Setting this makes new records
     land somewhere else entirely, which proves the plugin reads its ids back
     instead of trusting the ones it sent. Leave it at 0 for normal use. */
  shiftNewIds: 0
};

/* ------------------------------------------------------------------ model -- */

const NODES = {};
function node(id, x, y, z) { NODES[String(id)] = { X: x, Y: y, Z: z }; }
node(1, 0, 0, 0);    node(2, 10, 0, 0);   node(3, 20, 0, 0);     /* two girders in line */
node(4, 0, 5, 0);    node(5, 8, 9, 0);                           /* a skew member */
node(6, 0, 10, 0);   node(7, 0, 10, 6);                          /* a vertical column */
node(8, 0, 15, 0);   node(9, 6, 15, 0);                          /* beta = 90 */
node(10, 0, 20, 0);  node(11, 4, 20, 0);
node(12, 0, 25, 0);  node(13, 4, 25, 0);
node(14, 0, 30, 0);  node(15, 4, 30, 0);
node(16, 0, 35, 0);  node(17, 4, 35, 0);
node(18, 0, 40, 0);  node(19, 3, 40, 0);  node(20, 3, 42, 0); node(21, 0, 42, 0);
node(22, 0, 45, 0);  node(23, 5, 45, 0);
node(24, 0, 50, 0);  node(25, 3, 50, 0);
node(26, 0, 55, 0);  node(27, 2, 55, 0);

/* Reads come back with NODE zero-padded to eight entries — the real API does
   this, so the mock does too. */
const pad = (ns) => ns.concat([0, 0, 0, 0, 0, 0, 0, 0]).slice(0, 8);

const ELEMS = {
  "101": { TYPE: "BEAM", MATL: 1, SECT: 1, NODE: pad([1, 2]), ANGLE: 0 },
  "102": { TYPE: "BEAM", MATL: 1, SECT: 1, NODE: pad([2, 3]), ANGLE: 0 },
  "103": { TYPE: "BEAM", MATL: 1, SECT: 2, NODE: pad([4, 5]), ANGLE: 0 },
  "104": { TYPE: "BEAM", MATL: 2, SECT: 3, NODE: pad([6, 7]), ANGLE: 0 },
  "105": { TYPE: "BEAM", MATL: 1, SECT: 4, NODE: pad([8, 9]), ANGLE: 90 },
  "106": { TYPE: "BEAM", MATL: 1, SECT: 5, NODE: pad([10, 11]), ANGLE: 0 },
  "107": { TYPE: "BEAM", MATL: 1, SECT: 6, NODE: pad([12, 13]), ANGLE: 0 },
  "108": { TYPE: "BEAM", MATL: 1, SECT: 7, NODE: pad([14, 15]), ANGLE: 0 },
  "109": { TYPE: "BEAM", MATL: 1, SECT: 8, NODE: pad([16, 17]), ANGLE: 0 },
  "110": { TYPE: "PLATE", MATL: 1, SECT: 1, NODE: pad([18, 19, 20, 21]), STYPE: 3 },
  "111": { TYPE: "TRUSS", MATL: 1, SECT: 1, NODE: pad([22, 23]), ANGLE: 0 },
  "112": { TYPE: "BEAM", MATL: 1, SECT: 9, NODE: pad([24, 25]), ANGLE: 0 },
  "113": { TYPE: "BEAM", MATL: 1, SECT: 10, NODE: pad([26, 27]), ANGLE: 0 }
};

/* The section library.
 *
 * `Area` values are hand-computed from each shape's own area formula and set
 * here as literals. The plugin must arrive at them independently, from the
 * vSIZE list alone, or its gate fails — which is the point.
 *
 * The rows are deliberately NOT all arranged the same way: vSIZE has been seen
 * at SECT_I and under SECT_BEFORE on live models, so both appear here and the
 * plugin has to find it rather than assume a path. */
const SECTS = {
  /* 2 x 0.4 x 0.025 + (1.2 - 0.05) x 0.014 */
  "1": { SECTTYPE: "DBUSER", SECT_NAME: "PG 1200x400",
         SECT_I: { SHAPE: "H", DATATYPE: 2, vSIZE: [1.2, 0.4, 0.014, 0.025, 0.4, 0.025],
                   STIFF: { Area: 0.0361, Iyy: 0.00827, Izz: 0.000267 } } },
  /* 2 x 0.6 x 0.02 + 2 x (0.9 - 0.04) x 0.012 */
  "2": { SECTTYPE: "DBUSER", SECT_NAME: "Box 900x600",
         SECT_BEFORE: { SHAPE: "B", DATATYPE: 2, vSIZE: [0.9, 0.6, 0.012, 0.02, 0.0, 0.02],
                        STIFF: { Area: 0.04464 } } },
  /* pi x t x (D - t) */
  "3": { SECTTYPE: "DBUSER", SECT_NAME: "CHS 406x12.5",
         SECT_I: { SHAPE: "P", DATATYPE: 2, vSIZE: [0.4064, 0.0125],
                   STIFF: { Area: 0.015468416828112747 } } },
  /* 0.3 x 0.018 + (0.5 - 0.018) x 0.012 */
  "4": { SECTTYPE: "DBUSER", SECT_NAME: "Tee 500x300",
         SECT_I: { SHAPE: "T", DATATYPE: 2, vSIZE: [0.5, 0.3, 0.012, 0.018],
                   STIFF: { Area: 0.011184 } } },
  /* The one ordering measured on a live model: DATATYPE 2, vSIZE (H, B). */
  "5": { SECTTYPE: "DBUSER", SECT_NAME: "Wall 800x400",
         SECT_I: { SHAPE: "SB", DATATYPE: 2, vSIZE: [0.8, 0.4],
                   STIFF: { Area: 0.32 } } },
  /* A VALUE section: properties only. Its vSIZE is the dialog's Size box and
     nothing computes from it — so there is no geometry to convert, and the
     plugin must refuse rather than draw a 1.8 x 1.0 rectangle. */
  "6": { SECTTYPE: "VALUE", SECT_NAME: "Deck (properties)",
         SECT_I: { vSIZE: [1.8, 1.0], STIFF: { Area: 1.25, Iyy: 0.41 } } },
  /* Dimensions and published area that disagree under the plugin's reading.
     A real model gets here by a shape whose parameter order is not what this
     plugin assumes — exactly the failure the gate exists for. */
  "7": { SECTTYPE: "DBUSER", SECT_NAME: "Girder (odd order)",
         SECT_I: { SHAPE: "H", DATATYPE: 2, vSIZE: [0.4, 1.2, 0.025, 0.014, 1.2, 0.014],
                   STIFF: { Area: 0.0361 } } },
  /* PSC: an exact solid OUTER_POLYGON, which is not a wall layout. */
  "8": { SECTTYPE: "PSC", SECT_NAME: "PSC-I girder",
         SECT_BEFORE: { SHAPE: "PSCI",
           SECT_I: { OUTER_POLYGON: [{ VERTEX: [
             { X: -0.6, Y: 0.0 }, { X: 0.6, Y: 0.0 }, { X: 0.6, Y: 0.25 },
             { X: 0.15, Y: 0.55 }, { X: 0.15, Y: 1.45 }, { X: -0.15, Y: 1.45 },
             { X: -0.15, Y: 0.55 }, { X: -0.6, Y: 0.25 }] }],
             STIFF: { Area: 0.6075 } } } },
  /* 2 x 0.09 x 0.012 + (0.3 - 0.024) x 0.008 */
  "9": { SECTTYPE: "DBUSER", SECT_NAME: "PFC 300x90",
         SECT_I: { SHAPE: "C", DATATYPE: 2, vSIZE: [0.3, 0.09, 0.008, 0.012, 0.09, 0.012],
                   STIFF: { Area: 0.004368 } } },
  /* 0.1 x 0.008 + (0.1 - 0.008) x 0.008 */
  "10": { SECTTYPE: "DBUSER", SECT_NAME: "Angle 100x100x8",
          SECT_I: { SHAPE: "L", DATATYPE: 2, vSIZE: [0.1, 0.1, 0.008, 0.008],
                    STIFF: { Area: 0.001536 } } }
};

const TABLES = {
  NODE: NODES,
  ELEM: ELEMS,
  SECT: SECTS,
  MATL: {
    "1": { TYPE: "STEEL", NAME: "S355", PARAM: [{ P_TYPE: 1, STANDARD: "EN05(S)", DB: "S355" }] },
    "2": { TYPE: "STEEL", NAME: "S275", PARAM: [{ P_TYPE: 1, STANDARD: "EN05(S)", DB: "S275" }] }
  },
  /* Present but empty: the API answers 200 {"message":""}, NOT 404. */
  THIK: {},
  GRUP: { "1": { NAME: "Girders", P_TYPE: 0, N_LIST: [1, 2, 3], E_LIST: [101, 102] } }
};

/* --------------------------------------------------------------- responses -- */

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

/* An API error. Note the status: 200, with an error key. */
function apiError(res, message) { json(res, 200, { error: { message } }); }

/* --------------------------------------------------------------- handlers -- */

function handleVerify(req, res) {
  const key = req.headers["mapi-key"];
  if (!key) return json(res, 200, { keyVerified: false });
  json(res, 200, { keyVerified: true, status: state.session, program: "civil" });
}

function nextFree(table) {
  let max = 0;
  Object.keys(table).forEach((k) => { const n = Number(k); if (n > max) max = n; });
  return max + 1;
}

function handleDb(req, res, rest) {
  const parts = rest.split("/").filter(Boolean);
  const key = (parts[0] || "").toUpperCase();
  const rowId = parts[1];

  /* DELETE /db/<T>/key/<n> is a 404 on the real API — the key goes straight on
     the path. Reproduced so a plugin built against the manual fails here. */
  if (parts.length > 2 || (parts[1] === "key")) {
    return json(res, 404, { error: { message: "no such endpoint" } });
  }

  if (req.method === "GET") {
    if (!(key in TABLES)) {
      return json(res, 404, { error: { message: "no such table: " + key } });
    }
    const rows = TABLES[key];
    if (!rows || !Object.keys(rows).length) return json(res, 200, { message: "" });
    return json(res, 200, { [key]: rows });
  }

  if (req.method === "PUT") {
    return readBody(req, (body) => {
      const assign = body && body.Assign;
      if (!assign || typeof assign !== "object") return apiError(res, "Wrong Field");
      if (!(key in TABLES)) TABLES[key] = {};
      const table = TABLES[key];

      const bad = validate(key, assign);
      if (bad) return apiError(res, bad);

      /* The whole Assign is resolved against the table AS IT WAS when the batch
         arrived: a key that only collides with a slot this same batch has just
         filled is still a new record, not an overwrite. */
      const before = new Set(Object.keys(table));
      let landed = 0;
      Object.keys(assign).forEach((id) => {
        if (before.has(id)) { table[id] = assign[id]; landed++; return; }
        /* THE ID YOU SEND IS NOT ALWAYS THE ID YOU GET: at a key that does not
           exist, MIDAS ignores the number and appends at the next free slot. */
        const slot = String(nextFree(table) + (state.shiftNewIds || 0));
        table[slot] = assign[id];
        landed++;
      });
      /* A SUCCESSFUL write carries a `message`. A plugin treating any message as
         an error reports failure after the data landed. */
      return json(res, 200, { message: landed + " record(s) assigned" });
    });
  }

  if (req.method === "DELETE") {
    if (!(key in TABLES)) return json(res, 404, { error: { message: "no such table: " + key } });
    if (rowId != null) {
      if (!(rowId in TABLES[key])) return apiError(res, "[Error] " + key + " no data to delete.");
      delete TABLES[key][rowId];
      return json(res, 200, { message: "1 record(s) deleted" });
    }
    /* A bare table DELETE empties the WHOLE table on the real API. */
    TABLES[key] = {};
    return json(res, 200, { message: "table cleared" });
  }

  return apiError(res, "unsupported method");
}

/** The value checks CIVIL NX itself applies, as far as they have been measured.
 *  One bad entry rejects the whole batch. */
function validate(key, assign) {
  const ids = Object.keys(assign);
  for (const id of ids) {
    const rec = assign[id] || {};
    if (key === "NODE") {
      if (["X", "Y", "Z"].some((k) => typeof rec[k] !== "number" || !isFinite(rec[k]))) {
        return "[Error] NODE(No:" + id + ") data contain errors.";
      }
    }
    if (key === "ELEM") {
      if (!rec.TYPE) return "Wrong Field";
      const nodes = (rec.NODE || []).filter((n) => Number(n) > 0);
      if (rec.TYPE === "PLATE") {
        if (nodes.length < 3 || nodes.length > 4) {
          return "[Error] ELEM(No:" + id + ") data contain errors.";
        }
        if (nodes.some((n) => !(String(n) in TABLES.NODE))) {
          return "[Error] ELEM(No:" + id + ") data contain errors.";
        }
        if (new Set(nodes.map(String)).size !== nodes.length) {
          return "[Error] ELEM(No:" + id + ") data contain errors.";
        }
        /* A plate's thickness is referenced through SECT, into the THIK table. */
        if (!(String(rec.SECT) in TABLES.THIK)) {
          return "[Error] ELEM(No:" + id + ") data contain errors.";
        }
      }
    }
    if (key === "THIK") {
      /* THIK does NOT use VSIZE or THIK_IN — all six such variants were rejected
         on a live model. */
      if ("VSIZE" in rec || "THIK_IN" in rec) return "Wrong Field";
      if (typeof rec.T_IN !== "number" || !(rec.T_IN > 0)) {
        return "[Error] THIK(No:" + id + ") data contain errors.";
      }
      if (rec.NAME && String(rec.NAME).length > 16) {
        return "Some names exceed the maximum length (16)";
      }
    }
    if (key === "GRUP") {
      if (!rec.NAME) return "Wrong Field";
      if (!Array.isArray(rec.E_LIST) || !Array.isArray(rec.N_LIST)) return "Wrong Field";
    }
  }
  return null;
}

function handleCapture(req, res) {
  readBody(req, (body) => {
    const arg = (body && body.Argument) || {};
    if (arg.EXPORT_PATH) return apiError(res, "EXPORT_PATH is not accepted here");
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

/** Put the model back as it was — the suite writes to it. */
function reset() {
  TABLES.THIK = {};
  Object.keys(TABLES.NODE).forEach((k) => { if (Number(k) > 27) delete TABLES.NODE[k]; });
  Object.keys(TABLES.ELEM).forEach((k) => { if (Number(k) > 113) delete TABLES.ELEM[k]; });
  Object.keys(TABLES.GRUP).forEach((k) => { if (Number(k) > 1) delete TABLES.GRUP[k]; });
  state.shiftNewIds = 0;
}

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

module.exports = { server, state, TABLES, reset };
