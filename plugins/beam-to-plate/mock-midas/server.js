/*
 * Mock MIDAS CIVIL NX API + static file server, for Beam to Plate.
 *
 *   node mock-midas/server.js
 *   http://localhost:8773/index.html?mapiKey=mock-key&redirectTo=http://localhost:8773/civil
 *
 * It reproduces the API's awkward behaviours rather than being convenient. Every
 * one of these was measured on a live CIVIL NX:
 *
 *   - an error is HTTP 200 with an `error` key, never a 4xx
 *   - a table the model has nothing for is HTTP 200 {"message":""}
 *   - an unknown table KEY is 404 (the plugin's bug, not the model's state)
 *   - a valid key with a dead session verifies, with status:"disconnected"
 *   - PUT UPSERTS by id, and MERGES: a GRUP write merges its lists, a CNLD write
 *     merges a node's items by ID, and a RIGD write merges slave nodes into an
 *     existing link with the same DOF
 *   - DELETE /db/ELEM/<id> removes one row and takes that element's beam loads,
 *     temperatures, releases and offsets with it; /db/ELEM/key/<id> is a 404
 *   - /ope/SECTPROP returns numbers as TEXT, and its columns change with the
 *     section: Value, Value(I)/Value(J), Value(Before)/Value(After)
 *
 * THE SECTION LIBRARY IS REAL. `sections.json` holds 26 sections exactly as
 * CIVIL NX returned them from /db/SECT, each with the properties CIVIL NX itself
 * computed in /ope/SECTPROP (metres). Nothing in it was produced by this
 * plugin's own code, which is what makes the checks in the test suite a real
 * test: read a dimension list in the wrong order and the published properties
 * no longer agree.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.MOCK_PORT || 8773);
const ROOT_DIR = path.resolve(__dirname, "..");
const LIB = JSON.parse(fs.readFileSync(path.join(__dirname, "sections.json"), "utf8"));

const state = {
  session: process.env.MOCK_SESSION || "connected",
  /* NOT a live behaviour: the real API usually honours the id you send. Setting
     this makes new records land somewhere else entirely, which proves the plugin
     reads its ids back instead of trusting the ones it sent. */
  shiftNewIds: Number(process.env.MOCK_SHIFT || 0),
  selection: { NODE_LIST: [], ELEM_LIST: [] }
};

/* ------------------------------------------------------------------ model -- */

const NODES = {}, ELEMS = {}, SECTS = {}, SECTPROP = {};
const pad = (ns) => ns.concat([0, 0, 0, 0, 0, 0, 0, 0]).slice(0, 8);
let nodeId = 1, elemId = 101;

function node(x, y, z) { NODES[String(nodeId)] = { X: x, Y: y, Z: z }; return nodeId++; }
function beam(i, j, sect, matl, angle) {
  ELEMS[String(elemId)] = { TYPE: "BEAM", MATL: matl || 1, SECT: sect, NODE: pad([i, j]), ANGLE: angle || 0 };
  return elemId++;
}

/* one beam per library section, laid out on a grid; plus the awkward cases */
const sectionIds = Object.keys(LIB).map(Number).sort((a, b) => a - b);
const beamOf = {};
sectionIds.forEach((sid, k) => {
  SECTS[String(sid)] = LIB[sid].row;
  SECTPROP[String(sid)] = LIB[sid].prop;
  const y = k * 12;
  const a = node(0, y, 0), b = node(10, y, 0);
  beamOf[sid] = beam(a, b, sid, sid > 20 ? 2 : 1);
});

/* a continuous pair sharing a node, a vertical column, and a member at beta 90 */
const c1 = node(0, -12, 0), c2 = node(8, -12, 0), c3 = node(16, -12, 0);
const contA = beam(c1, c2, 1), contB = beam(c2, c3, 1);
const v1 = node(0, -24, 0), v2 = node(0, -24, 7);
const column = beam(v1, v2, 7, 2);
const s1 = node(0, -36, 0), s2 = node(6, -36, 0);
const skew = beam(s1, s2, 3, 1, 90);

/* elements that are not beams: they must be reported as skipped, not failed */
const p1 = node(0, -48, 0), p2 = node(3, -48, 0), p3 = node(3, -45, 0), p4 = node(0, -45, 0);
ELEMS[String(elemId++)] = { TYPE: "PLATE", MATL: 1, SECT: 1, NODE: pad([p1, p2, p3, p4]), STYPE: 3 };
const t1 = node(0, -54, 0), t2 = node(5, -54, 0);
ELEMS[String(elemId++)] = { TYPE: "TRUSS", MATL: 1, SECT: 1, NODE: pad([t1, t2]), ANGLE: 0 };

const TABLES = {
  NODE: NODES,
  ELEM: ELEMS,
  SECT: SECTS,
  MATL: {
    "1": { TYPE: "STEEL", NAME: "S355", PARAM: [{ P_TYPE: 1, STANDARD: "EN05(S)", DB: "S355" }] },
    "2": { TYPE: "CONC", NAME: "C40/50", PARAM: [{ P_TYPE: 1, STANDARD: "EN04(RC)", DB: "C40/50" }] },
    "3": { TYPE: "CONC", NAME: "C32/40 slab", PARAM: [{ P_TYPE: 1, STANDARD: "EN04(RC)", DB: "C32/40" }] }
  },
  /* Present but empty: the API answers 200 {"message":""}, NOT 404. */
  THIK: {},
  GRUP: { "1": { NAME: "Girders", P_TYPE: 0, N_LIST: [c1, c2, c3], E_LIST: [contA, contB] } },
  BNGR: { "1": { NAME: "Supports", AUTOTYPE: 0 } },
  LDGR: {},
  STLD: { "1": { NO: 1, NAME: "DL", TYPE: "D", DESC: "" }, "2": { NO: 2, NAME: "LL", TYPE: "L", DESC: "" } },
  CONS: {
    [c1]: { ITEMS: [{ ID: 1, GROUP_NAME: "Supports", CONSTRAINT: "1111111" }] },
    [c3]: { ITEMS: [{ ID: 1, GROUP_NAME: "Supports", CONSTRAINT: "0111111" }] },
    [v1]: { ITEMS: [{ ID: 1, GROUP_NAME: "Supports", CONSTRAINT: "1111111" }] }
  },
  CNLD: { [v2]: { ITEMS: [{ ID: 1, LCNAME: "LL", GROUP_NAME: "", FX: 120, FY: 0, FZ: -400, MX: 0, MY: 0, MZ: 0 }] } },
  BMLD: {
    [contA]: { ITEMS: [
      { ID: 1, LCNAME: "DL", GROUP_NAME: "", CMD: "BEAM", TYPE: "UNILOAD", DIRECTION: "GZ",
        USE_PROJECTION: false, USE_ECCEN: false, D: [0, 1, 0, 0], P: [-25, -25, 0, 0] },
      { ID: 2, LCNAME: "LL", GROUP_NAME: "", CMD: "BEAM", TYPE: "CONLOAD", DIRECTION: "GZ",
        USE_PROJECTION: false, USE_ECCEN: false, D: [0.5, 0, 0, 0], P: [-90, 0, 0, 0] }] },
    [contB]: { ITEMS: [
      { ID: 1, LCNAME: "DL", GROUP_NAME: "", CMD: "BEAM", TYPE: "UNILOAD", DIRECTION: "GZ",
        USE_PROJECTION: false, USE_ECCEN: false, D: [0, 1, 0, 0], P: [-25, -25, 0, 0] },
      /* an eccentric lateral load: it must arrive as a torsion on the plates */
      { ID: 2, LCNAME: "LL", GROUP_NAME: "", CMD: "BEAM", TYPE: "UNILOAD", DIRECTION: "GY",
        USE_PROJECTION: false, USE_ECCEN: true, ECCEN_TYPE: 0, ECCEN_DIR: "LZ", I_END: 0.4,
        USE_J_END: false, D: [0, 1, 0, 0], P: [-8, -8, 0, 0] }] },
    [beamOf[22]]: { ITEMS: [
      { ID: 1, LCNAME: "DL", GROUP_NAME: "", CMD: "BEAM", TYPE: "UNILOAD", DIRECTION: "GZ",
        USE_PROJECTION: false, USE_ECCEN: false, D: [0, 1, 0, 0], P: [-150, -150, 0, 0] }] }
  },
  /* a beam with end offsets: the mesh starts away from the node, and the link
     spans the rigid zone */
  OFFS: { [skew]: { ITEMS: [{ ID: 1, GROUP_NAME: "", TYPE: "ELEMENT", RGDYi: 0.5, RGDZi: 0.5, RGDYj: 0, RGDZj: 0 }] } },
  FRLS: { [contB]: { ITEMS: [{ ID: 1, GROUP_NAME: "", bVALUE: false, FLAG_I: "0000010", VALUE_I: [0, 0, 0, 0, 0, 0, 0],
                               FLAG_J: "0000000", VALUE_J: [0, 0, 0, 0, 0, 0, 0] }] } },
  ETMP: { [beamOf[1]]: { ITEMS: [{ ID: 1, LCNAME: "DL", GROUP_NAME: "", TEMPER: 15 }] } },
  RIGD: {},
  ELNK: {},
  NLNK: {},
  /* a tendon on a converted beam: it CANNOT follow it into plates, and the plan
     has to say so before the beam is deleted */
  TDNA: { "1": { NAME: "T1", SHAPE: "ELEMENT", ELEM: [beamOf[22], beamOf[21]], INS_ELEM: beamOf[22] } },
  LLAN: { "1": { NAME: "Lane 1", ELEM: [contA, contB] } },
  ESSF: { [beamOf[1]]: { ITEMS: [{ ID: 1, LCNAME: "DL", SCALE: 0.8 }] } },
  STAG: {},
  SDSP: {}, NMAS: {}, NSPR: {}, GSPR: {}, SSPS: {}, SKEW: {}, NTMP: {}, NBOF: {},
  TDPL: {}, PRST: {}, CSCS: {}, PLCB: {}, EWSF: {}, GTMP: {}, BTMP: {}, IEHG: {}, FIBR: {},
  EDMP: {}, DYNF: {}, TSGR: {}, CMCS: {}, VBEM: {}, LLANID: {}, LLANCH: {}, SLAN: {}
};

/* the selection the plugin reads from CIVIL NX: two of the girders */
state.selection = { NODE_LIST: [], ELEM_LIST: [contA, contB], ELEM_TYPE: { BEAM_LIST: [contA, contB] } };

/* --------------------------------------------------------------- responses -- */

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}
function apiError(res, message) { json(res, 200, { error: { message } }); }

function handleVerify(req, res) {
  json(res, 200, { user: "mock", program: "civil", keyVerified: true, status: state.session });
}

function nextFree(table) {
  let max = 0;
  Object.keys(table).forEach((k) => { const n = Number(k); if (isFinite(n) && n > max) max = n; });
  return max + 1 + state.shiftNewIds;
}

/* ------------------------------------------------------------------ writes -- */

/** GRUP merges its lists; CNLD merges items by ID; RIGD merges slaves by DOF. */
function mergeRow(key, id, incoming, existing) {
  if (!existing) return incoming;
  if (key === "GRUP") {
    const merge = (a, b) => {
      const out = (a || []).slice();
      (b || []).forEach((x) => { if (out.indexOf(x) === -1) out.push(x); });
      return out;
    };
    return Object.assign({}, existing, incoming, {
      N_LIST: merge(existing.N_LIST, incoming.N_LIST),
      E_LIST: merge(existing.E_LIST, incoming.E_LIST)
    });
  }
  if (key === "CNLD" || key === "ETMP" || key === "FRLS" || key === "OFFS") {
    const items = (existing.ITEMS || []).slice();
    (incoming.ITEMS || []).forEach((it) => {
      const at = items.findIndex((x) => Number(x.ID) === Number(it.ID));
      if (at === -1) items.push(it); else items[at] = it;
    });
    return Object.assign({}, existing, incoming, { ITEMS: items });
  }
  if (key === "RIGD") {
    const items = (existing.ITEMS || []).slice();
    (incoming.ITEMS || []).forEach((it) => {
      const at = items.findIndex((x) => Number(x.DOF) === Number(it.DOF));
      if (at === -1) { items.push(it); return; }
      const slaves = (items[at].S_NODE || []).slice();
      (it.S_NODE || []).forEach((s) => { if (slaves.indexOf(s) === -1) slaves.push(s); });
      items[at] = Object.assign({}, items[at], { S_NODE: slaves });
    });
    return Object.assign({}, existing, { ITEMS: items });
  }
  return incoming;
}

function validate(key, id, rec) {
  if (key === "NODE") {
    if (["X", "Y", "Z"].some((k) => typeof rec[k] !== "number" || !isFinite(rec[k]))) {
      return "[Error] NODE(No:" + id + ") data contain errors.";
    }
  }
  if (key === "ELEM") {
    const type = String(rec.TYPE || "").toUpperCase();
    if (!type) return "Wrong Field";
    const nodes = (rec.NODE || []).filter((n) => Number(n) > 0);
    if (type === "PLATE") {
      if (nodes.length < 3 || nodes.length > 4) return "[Error] ELEM(No:" + id + ") data contain errors.";
      if (rec.STYPE === undefined) return "Wrong Field";
      if (nodes.some((n) => !NODES[String(n)])) return "[Error] ELEM(No:" + id + ") data contain errors.";
      if (!TABLES.THIK[String(rec.SECT)]) return "[Error] ELEM(No:" + id + ") data contain errors.";
    }
    if (type === "BEAM" && nodes.length !== 2) return "[Error] ELEM(No:" + id + ") data contain errors.";
  }
  if (key === "THIK") {
    if (rec.VSIZE !== undefined || rec.THIK_IN !== undefined) return "Wrong Field";
    if (typeof rec.T_IN !== "number" || !(rec.T_IN > 0)) return "[Error] THIK(No:" + id + ") data contain errors.";
  }
  if (key === "RIGD") {
    const items = rec.ITEMS || [];
    if (!items.length) return "Wrong Field";
    for (const it of items) {
      if (!NODES[String(id)]) return "[Error] RIGD(No:" + id + ") data contain errors.";
      if (!(it.S_NODE || []).length) return "[Error] RIGD(No:" + id + ") data contain errors.";
      if (String(it.DOF || "").length !== 6) return "[Error] RIGD(No:" + id + ") data contain errors.";
    }
  }
  if (key === "CNLD") {
    for (const it of rec.ITEMS || []) {
      if (!it.LCNAME) return "Wrong Field";
      if (!NODES[String(id)]) return "[Error] CNLD(No:" + id + ") data contain errors.";
    }
  }
  return null;
}

function handleDb(req, res, rest) {
  const parts = rest.split("/").filter(Boolean);
  const key = (parts[0] || "").toUpperCase();
  const rowKey = parts[1];

  if (!Object.prototype.hasOwnProperty.call(TABLES, key)) {
    return json(res, 404, { error: { message: "404 Not Found, Please check your request url." } });
  }
  if (state.session !== "connected") return apiError(res, "client does not exist");
  const table = TABLES[key];

  if (req.method === "GET") {
    if (rowKey !== undefined) {
      if (!table[rowKey]) return json(res, 200, { message: "" });
      return json(res, 200, { [key]: { [rowKey]: table[rowKey] } });
    }
    if (!Object.keys(table).length) return json(res, 200, { message: "" });
    return json(res, 200, { [key]: table });
  }

  if (req.method === "DELETE") {
    if (rowKey === undefined) {
      /* The real API empties the table here. The plugin's client refuses to
         send this at all, so the mock refuses it too rather than modelling a
         behaviour nothing is allowed to use. */
      return apiError(res, "this mock does not implement whole-table DELETE");
    }
    if (parts[1] === "key") return json(res, 404, { error: { message: "404 Not Found, Please check your request url." } });
    /* A comma-separated list deletes every id on it — measured live. */
    const ids = String(rowKey).split(",");
    const removed = {};
    let any = false;
    for (const one of ids) {
      const had = table[one];
      if (!had) continue;
      any = true;
      removed[one] = had;
      delete table[one];
      if (key === "ELEM") {
        /* deleting an element takes its element-keyed data with it */
        ["BMLD", "ETMP", "FRLS", "OFFS", "ESSF"].forEach((k) => { delete TABLES[k][one]; });
      }
    }
    if (!any) return apiError(res, "Not Found Key");
    return json(res, 200, { [key]: removed });
  }

  if (req.method === "PUT" || req.method === "POST") {
    return readBody(req, (body) => {
      const assign = body && body.Assign;
      if (!assign || typeof assign !== "object") return apiError(res, "Wrong Field");
      const written = {};
      for (const id of Object.keys(assign)) {
        const rec = assign[id];
        const problem = validate(key, id, rec);
        /* ONE bad entry rejects the whole batch — as the real API does */
        if (problem) return json(res, 200, { error: { message: problem } });
        const exists = Object.prototype.hasOwnProperty.call(table, id);
        const target = exists ? id : String(state.shiftNewIds ? nextFree(table) : id);
        table[target] = mergeRow(key, target, rec, exists ? table[target] : null);
        written[target] = table[target];
      }
      return json(res, 200, { [key]: written });
    });
  }
  return apiError(res, "error status");
}

function handleSectProp(req, res) {
  if (req.method !== "GET") return json(res, 200, { message: "error status" });
  return json(res, 200, { SECTPROP: SECTPROP });
}

function handleSelect(req, res) {
  if (req.method !== "GET") return json(res, 200, { message: "error status" });
  return json(res, 200, { SELECT: state.selection });
}

function handleCapture(req, res) {
  if (req.method !== "POST") return json(res, 200, { message: "error status" });
  return readBody(req, (body) => {
    const arg = (body && body.Argument) || {};
    if (arg.EXPORT_PATH) return apiError(res, "EXPORT_PATH reached the API — the client must strip it");
    if (arg.FIGURE_NAME) return apiError(res, "MIDAS CIVIL NX It's not found Figure Name");
    /* a 1x1 JPEG, enough to prove the round trip */
    return json(res, 200, { base64String:
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
      "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==" });
  });
}

/* --------------------------------------------------------------- transport -- */

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const file = path.join(ROOT_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(file).toLowerCase();
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".json": "application/json", ".svg": "image/svg+xml" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function readBody(req, done) {
  let buf = "";
  req.on("data", (c) => { buf += c; });
  req.on("end", () => {
    try { done(buf ? JSON.parse(buf) : null); }
    catch (e) { done(null); }
  });
}

function reset() {
  Object.keys(TABLES.THIK).forEach((k) => delete TABLES.THIK[k]);
  Object.keys(TABLES.RIGD).forEach((k) => delete TABLES.RIGD[k]);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,PUT,POST,DELETE",
      "Access-Control-Allow-Headers": "MAPI-Key,Content-Type" });
    return res.end();
  }
  if (p === "/mapikey/verify") return handleVerify(req, res);
  if (p.startsWith("/civil/db/")) return handleDb(req, res, p.slice("/civil/db/".length));
  if (p === "/civil/ope/SECTPROP") return handleSectProp(req, res);
  if (p === "/civil/view/SELECT") return handleSelect(req, res);
  if (p === "/civil/view/CAPTURE") return handleCapture(req, res);
  if (p.startsWith("/civil/")) return json(res, 404, { error: { message: "404 Not Found, Please check your request url." } });
  return serveStatic(req, res, p);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log("mock CIVIL NX on http://localhost:" + PORT);
    console.log("  plugin: http://localhost:" + PORT + "/index.html?mapiKey=mock-key&redirectTo=http://localhost:" + PORT + "/civil");
    console.log("  " + Object.keys(SECTS).length + " sections, " + Object.keys(ELEMS).length + " elements, " +
      Object.keys(NODES).length + " nodes");
  });
}

module.exports = { server, TABLES, state, reset, LIB, SECTPROP, beamOf,
                   continuous: [contA, contB], column: column, skew: skew };
