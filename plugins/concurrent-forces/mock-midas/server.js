/*
 * Mock MIDAS CIVIL NX API + static file server, for the Concurrent Forces plugin.
 *
 *   node mock-midas/server.js
 *   http://localhost:8772/index.html?mapiKey=mock-key&redirectTo=http://localhost:8772/civil
 *
 * The point of this file is NOT convenience. It reproduces the API's awkward
 * behaviours faithfully, so that code which only works against a polite server
 * fails here rather than in front of a user:
 *
 *   - an error is HTTP 200 with an `error` key, never a 4xx
 *   - a table the model has nothing for is HTTP 200 {"message":""}
 *   - an unknown table KEY is 404 (the plugin's bug, not the model's state)
 *   - a series whose suffix does not match its envelope-valuedness is dropped
 *     SILENTLY from the response
 *   - OPT_CS is a MODE SWITCH: one request answers with the construction-stage
 *     family or with everything else, and the excluded family is simply absent
 *   - a wrong table token answers "there was an error creating utbl", which
 *     reads like an un-analysed model and is not
 *
 * And it is ARITHMETICALLY CONSISTENT. Every combination value is computed from
 * the values reported for its own children, quantised at each node, so the
 * plugin's reconciliation of an envelope against its resolved child is a real
 * test rather than a tautology — and a plugin that reconstructs a state wrongly
 * fails here instead of shipping.
 *
 * The scenarios kept here are the ones a live model may not have:
 *   · an envelope whose governing child differs from element to element
 *   · an envelope of envelopes, two levels deep
 *   · a moving-load leaf buried three levels down an otherwise clean Add
 *   · a settlement case and a response spectrum case
 *   · ABS and SRSS combinations
 *   · a construction stage where a MID-stage step governs, not the last
 *   · a time history case saved with max/min only, beside one saved with steps
 *   · trusses and general links in the same set as beams
 *   · 220 beams for the bulk-query path
 *   · ids that are BOTH an element and a general link
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.MOCK_PORT || 8772);
const ROOT_DIR = path.resolve(__dirname, "..");

/* Set MOCK_SESSION=disconnected to exercise "key still valid, CIVIL NX gone".
   Set MOCK_ANALYSED=0 to exercise the un-analysed model. */
const state = {
  session: process.env.MOCK_SESSION || "connected",
  analysed: process.env.MOCK_ANALYSED !== "0"
};

/* ------------------------------------------------------------------ model -- */

const NODES = {};
for (let i = 1; i <= 30; i++) NODES[String(i)] = { X: (i - 1) * 5, Y: 0, Z: 0 };

const ELEMS = {};
const beam = (i, n) => ({ TYPE: "BEAM", MATL: 1, SECT: 1, NODE: [n, n + 1, 0, 0, 0, 0, 0, 0], ANGLE: 0 });
for (let i = 1; i <= 20; i++) ELEMS[String(i)] = beam(i, i);
for (let i = 21; i <= 26; i++) ELEMS[String(i)] = { TYPE: "TRUSS", MATL: 1, SECT: 2, NODE: [i - 20, i - 19, 0, 0, 0, 0, 0, 0] };
for (let i = 30; i <= 33; i++) ELEMS[String(i)] = { TYPE: "PLATE", MATL: 1, SECT: 1, NODE: [1, 2, 3, 4, 0, 0, 0, 0], STYPE: 3 };
ELEMS["40"] = { TYPE: "SOLID", MATL: 1, SECT: 1, NODE: [1, 2, 3, 4, 5, 6, 7, 8] };
/* 220 beams, for the bulk-query path. */
for (let i = 201; i <= 420; i++) ELEMS[String(i)] = beam(i, ((i - 201) % 29) + 1);

/* GENERAL LINKS SHARE THE ELEMENT ID SPACE. 5, 6 and 7 are each both a beam
   element and a general link on this model, which is exactly the collision that
   makes a bare number ambiguous. */
const GENLINKS = { "5": { NODE: [5, 6], LINK: 1 }, "6": { NODE: [6, 7], LINK: 1 }, "7": { NODE: [7, 8], LINK: 1 } };

/* Load cases, by analysis kind. */
const CASES = {
  "DL":              { kind: "ST" },
  "SDL":             { kind: "ST" },
  "LL":              { kind: "ST" },
  "WIND":            { kind: "ST" },
  "TEMP":            { kind: "ST" },
  "HA-UDL":          { kind: "MV" },
  "Settle-1":        { kind: "SM" },
  "RSX":             { kind: "RS" },
  "Quake-TH":        { kind: "TH", steps: null },          /* max/min only */
  "Quake-TH-Steps":  { kind: "TH", steps: ["1", "2", "3", "4", "5"] },
  "Erection":        { kind: "CS" }
};

/* Combinations. iTYPE: 0 Add, 1 Envelope, 2 ABS, 3 SRSS. */
const COMBOS = {
  "1":  { NAME: "ULS_Comb_01", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "ST", LCNAME: "DL", FACTOR: 1.35 }, { ANAL: "ST", LCNAME: "LL", FACTOR: 1.5 }] },
  "2":  { NAME: "ULS_Comb_07", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "ST", LCNAME: "DL", FACTOR: 1.35 }, { ANAL: "ST", LCNAME: "WIND", FACTOR: 1.5 }] },
  "3":  { NAME: "ULS_Comb_12", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "ST", LCNAME: "DL", FACTOR: 1.2 }, { ANAL: "ST", LCNAME: "TEMP", FACTOR: 1.6 }] },
  /* An envelope whose governing child differs from element to element. */
  "4":  { NAME: "ULS_Env", iTYPE: 1, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "CB", LCNAME: "ULS_Comb_01", FACTOR: 1 },
          { ANAL: "CB", LCNAME: "ULS_Comb_07", FACTOR: 1 },
          { ANAL: "CB", LCNAME: "ULS_Comb_12", FACTOR: 1 }] },
  /* An envelope OF envelopes — must resolve all the way to a leaf. */
  "5":  { NAME: "ULS_Env_Outer", iTYPE: 1, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "CB", LCNAME: "ULS_Env", FACTOR: 1 },
          { ANAL: "CB", LCNAME: "ULS_Comb_12", FACTOR: 1.1 }] },
  /* A moving-load leaf three levels down an otherwise clean-looking Add. */
  "6":  { NAME: "MV_Leaf_L3", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "MV", LCNAME: "HA-UDL", FACTOR: 1 }] },
  "7":  { NAME: "MV_Mid_L2", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "CB", LCNAME: "MV_Leaf_L3", FACTOR: 1 },
          { ANAL: "ST", LCNAME: "DL", FACTOR: 1 }] },
  "8":  { NAME: "MV_Top_L1", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "CB", LCNAME: "MV_Mid_L2", FACTOR: 1.35 },
          { ANAL: "ST", LCNAME: "SDL", FACTOR: 1 }] },
  "9":  { NAME: "Settle_Comb", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "SM", LCNAME: "Settle-1", FACTOR: 1 },
          { ANAL: "ST", LCNAME: "DL", FACTOR: 1 }] },
  "10": { NAME: "ABS_Comb", iTYPE: 2, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "ST", LCNAME: "DL", FACTOR: 1 }, { ANAL: "ST", LCNAME: "LL", FACTOR: 1 }] },
  "11": { NAME: "SRSS_Comb", iTYPE: 3, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "ST", LCNAME: "DL", FACTOR: 1 }, { ANAL: "ST", LCNAME: "RSX", FACTOR: 1 }] },
  /* A CB combination whose children are construction-stage cases. It belongs to
     the ORDINARY family even so — OPT_CS on returns nothing for it. */
  "12": { NAME: "CS_Comb", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "CS", LCNAME: "Erection", FACTOR: 1 },
          { ANAL: "ST", LCNAME: "DL", FACTOR: 1 }] },
  /* An Add that is envelope-valued only because one child is. */
  "13": { NAME: "Env_Sum", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "CB", LCNAME: "ULS_Env", FACTOR: 1 },
          { ANAL: "ST", LCNAME: "SDL", FACTOR: 1 }] },
  "14": { NAME: "TH_Comb", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "TH", LCNAME: "Quake-TH", FACTOR: 1 }] },
  "15": { NAME: "TH_Steps_Comb", iTYPE: 0, ACTIVE: "ACTIVE", vCOMB: [
          { ANAL: "TH", LCNAME: "Quake-TH-Steps", FACTOR: 1 }] }
};

/* Construction stages. bSV_STEP decides which step tokens exist at all: where
   it is false — the default — only 002(last) does, and every other token
   returns an empty table for every stage. */
const STAGES = {
  "1": { NAME: "CS1", bSV_STEP: false },
  "2": { NAME: "CS2", bSV_STEP: true },
  "3": { NAME: "CS3", bSV_STEP: false }
};

const TABLES = {
  NODE: NODES,
  ELEM: ELEMS,
  GENLINK: GENLINKS,                 /* NOTE: /db/GLNK is 404 on this build */
  MATL: { "1": { TYPE: "CONC", NAME: "C40/50" } },
  SECT: { "1": { SECT_NAME: "Deck girder" }, "2": { SECT_NAME: "Brace" } },
  GRUP: {
    "1": { NAME: "Deck", P_TYPE: 0, N_LIST: [], E_LIST: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    "2": { NAME: "Bracing", P_TYPE: 0, N_LIST: [], E_LIST: [21, 22, 23, 24, 25, 26] },
    "3": { NAME: "Bulk deck", P_TYPE: 0, N_LIST: [], E_LIST: range(201, 420) },
    "4": { NAME: "Plates", P_TYPE: 0, N_LIST: [], E_LIST: [30, 31, 32, 33] }
  },
  STLD: namedRows(Object.keys(CASES).filter((n) => CASES[n].kind === "ST").map((n) => ({ NAME: n, TYPE: "D" }))),
  STAG: STAGES,
  UNIT: { "1": { FORCE: "KN", DIST: "M", HEAT: "KJ", TEMPER: "C" } },
  MVLDBS: namedRows([{ NAME: "HA-UDL" }]),
  SMLC: namedRows([{ NAME: "Settle-1" }]),
  RSLC: namedRows([{ NAME: "RSX" }]),
  THLC: namedRows([{ NAME: "Quake-TH" }, { NAME: "Quake-TH-Steps" }]),
  "LCOM-GEN": COMBOS,
  /* Present but empty — HTTP 200 {"message":""}, not 404. */
  "LCOM-STEEL": {}, "LCOM-CONC": {}, "LCOM-SRC": {}, "LCOM-FDN": {},
  "LCOM-STLCOMP": {}, "LCOM-CFSTEEL": {}, "LCOM-SEISMIC": {}, "LCOM-LINEAR": {},
  "LCOM-ALU": {}
};

function range(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; }
function namedRows(list) {
  const o = {};
  list.forEach((r, i) => { o[String(i + 1)] = r; });
  return o;
}

/* -------------------------------------------------------------- arithmetic -- */

const COMPONENTS = ["Axial", "Shear-y", "Shear-z", "Torsion", "Moment-y", "Moment-z"];
const AMP = { "Axial": 800, "Shear-y": 150, "Shear-z": 250, "Torsion": 40, "Moment-y": 900, "Moment-z": 300 };
const MOMENT = { "Torsion": 1, "Moment-y": 1, "Moment-z": 1 };

const FORCE_FACTOR = { N: 1000, kN: 1, kgf: 101.9716213, tonf: 0.1019716213, lbf: 224.8089431, kips: 0.2248089431 };
const DIST_FACTOR = { mm: 1000, cm: 100, m: 1, in: 39.37007874, ft: 3.280839895 };

const hash = (s) => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h); };
/* Quantise at EVERY node, so the plugin's own reconciliation is a real check. */
const q = (v) => Number(v.toPrecision(9));

/** The raw value of a LEAF case, in kN and m. */
function leafValue(name, elem, part, comp, stage, step) {
  const spec = CASES[name];
  if (!spec) return null;
  let salt = name + "|" + elem + "|" + part + "|" + comp;
  if (spec.kind === "CS") salt += "|" + stage + "|" + step;
  if (spec.kind === "TH" && spec.steps) salt += "|" + step;
  const seed = hash(salt);
  const v = ((seed % 20001) / 10000 - 1) * AMP[comp];
  return q(v);
}

/** Is this name a max/min pair? Recursive — envelope-valuedness propagates. */
const envCache = new Map();
function envelopeValued(name, seen) {
  if (envCache.has(name)) return envCache.get(name);
  seen = seen || new Set();
  if (seen.has(name)) return true;
  seen.add(name);
  let out;
  const c = comboByName(name);
  if (!c) {
    const k = CASES[name] && CASES[name].kind;
    out = k === "MV" || k === "SM" || k === "RS";
  } else if (c.iTYPE !== 0) {
    out = true;
  } else {
    out = c.vCOMB.some((ch) => envelopeValued(ch.LCNAME, seen));
  }
  seen.delete(name);
  if (!seen.size) envCache.set(name, out);
  return out;
}

const comboByName = (n) => Object.values(COMBOS).find((c) => c.NAME === n) || null;

/**
 * The value MIDAS would report, computed from the children's own reported
 * values and quantised at every node.
 *
 * `sense` is "max" / "min" for an envelope-valued name, null otherwise.
 */
function valueOf(name, sense, elem, part, comp, stage, step) {
  const c = comboByName(name);
  if (!c) {
    const spec = CASES[name];
    if (!spec) return null;
    const v = leafValue(name, elem, part, comp, stage, step);
    if (v == null) return null;
    /* A leaf that is already an envelope at source has no single state behind
       it — it reports a magnitude in each direction and nothing in between. */
    if (spec.kind === "MV" || spec.kind === "SM" || spec.kind === "RS") {
      return sense === "min" ? q(-Math.abs(v)) : q(Math.abs(v));
    }
    if (spec.kind === "TH" && !spec.steps) {
      return String(step).toLowerCase() === "min" ? q(-Math.abs(v)) : q(Math.abs(v));
    }
    return v;
  }

  const kids = c.vCOMB.map((ch) => ({
    factor: ch.FACTOR,
    value: valueOf(ch.LCNAME, envelopeValued(ch.LCNAME) ? sense : null, elem, part, comp, stage, step),
    valueMax: valueOf(ch.LCNAME, envelopeValued(ch.LCNAME) ? "max" : null, elem, part, comp, stage, step),
    valueMin: valueOf(ch.LCNAME, envelopeValued(ch.LCNAME) ? "min" : null, elem, part, comp, stage, step)
  }));
  if (kids.some((k) => k.value == null)) return null;

  if (c.iTYPE === 1) {
    const vals = kids.map((k) => k.factor * (sense === "min" ? k.valueMin : k.valueMax));
    return q(sense === "min" ? Math.min(...vals) : Math.max(...vals));
  }
  if (c.iTYPE === 2) {
    const all = kids.map((k) => Math.abs(k.factor * k.valueMax))
      .concat(kids.map((k) => Math.abs(k.factor * k.valueMin)));
    const m = Math.max.apply(null, all);
    return q(sense === "min" ? -m : m);
  }
  if (c.iTYPE === 3) {
    const m = Math.sqrt(kids.reduce((s, k) => s + Math.pow(k.factor * k.valueMax, 2), 0));
    return q(sense === "min" ? -m : m);
  }
  /* Add: the weighted sum of what the children report, quantised. */
  return q(kids.reduce((s, k) => s + k.factor * k.value, 0));
}

/* ---------------------------------------------------------------- series -- */

/** Split a requested series into name, kind and sense. */
function parseSeries(s) {
  const m = /^([\s\S]*)\((ST|CS|CB|MV|SM|RS|TH)(?::(max|min|all))?\)$/.exec(String(s));
  if (!m) return null;
  return { name: m[1], kind: m[2], sense: m[3] || null };
}

/** The label the response carries: the KIND is dropped for ST and CB. */
function responseLabel(p) {
  const keepKind = p.kind !== "ST" && p.kind !== "CB";
  const base = keepKind ? p.name + "(" + p.kind + ")" : p.name;
  return p.sense ? (keepKind ? p.name + "(" + p.kind + ":" + p.sense + ")"
                             : p.name + "(" + p.sense + ")") : base;
}

/**
 * Addressability. The suffix must match envelope-valuedness EXACTLY, and the
 * family must match the OPT_CS mode. Anything else is dropped in silence.
 */
function addressable(p, optCs) {
  if (!p) return false;
  const combo = comboByName(p.name);
  const spec = CASES[p.name];
  if (!combo && !spec) return false;

  /* OPT_CS is a mode switch, not a filter. And a CB combination always belongs
     to the ordinary family, even when every child of it is a CS case. */
  const isCs = !combo && spec.kind === "CS";
  if (optCs !== isCs) return false;

  if (combo) {
    if (p.kind !== "CB") return false;
  } else {
    if (p.kind !== spec.kind) return false;
  }
  const enveloped = envelopeValued(p.name);
  return enveloped ? !!p.sense && p.sense !== "all" : !p.sense;
}

/** Every series the model publishes for a family. */
function publishedSeries(optCs) {
  const out = [];
  const add = (name, kind) => {
    const enveloped = envelopeValued(name);
    if (enveloped) { out.push({ name, kind, sense: "max" }); out.push({ name, kind, sense: "min" }); }
    else out.push({ name, kind, sense: null });
  };
  Object.keys(CASES).forEach((n) => {
    const isCs = CASES[n].kind === "CS";
    if (optCs === isCs) add(n, CASES[n].kind);
  });
  if (!optCs) Object.values(COMBOS).forEach((c) => add(c.NAME, "CB"));
  return out;
}

/* Which steps a series reports at. */
function stepsFor(p, stageStep) {
  if (p.kind === "CS") {
    const [stage, step] = String(stageStep || "").split(":");
    return [{ stage: stage || "", step: step || "" }];
  }
  const spec = CASES[p.name];
  if (spec && spec.kind === "TH") {
    /* Saved with steps, or saved with max/min only — the difference this plugin
       has to detect, because no definition anywhere records it. */
    return spec.steps ? spec.steps.map((s) => ({ stage: "", step: s }))
                      : [{ stage: "", step: "max" }, { stage: "", step: "min" }];
  }
  const combo = comboByName(p.name);
  if (combo && combo.vCOMB.some((ch) => { const s = CASES[ch.LCNAME]; return s && s.kind === "TH"; })) {
    const th = combo.vCOMB.map((ch) => CASES[ch.LCNAME]).find((s) => s && s.kind === "TH");
    return th.steps ? th.steps.map((s) => ({ stage: "", step: s }))
                    : [{ stage: "", step: "max" }, { stage: "", step: "min" }];
  }
  return [{ stage: "", step: "" }];
}

/* --------------------------------------------------------------- tables -- */

const TOKENS = {
  /* GENLINKFORCE is deliberately NOT here: the plugin must probe past it to
     GENERALLINKFORCE, the way it would have to on a build that spells it
     differently. A wrong token is not obviously wrong — it answers with the
     "creating utbl" message, which reads like an un-analysed model. */
  BEAMFORCE: { group: "BEAM", item: "Elem", comps: COMPONENTS, parts: ["Part I", "Part J"] },
  TRUSSFORCE: { group: "TRUSS", item: "Elem", comps: ["Axial"], parts: ["Part I", "Part J"],
                /* The truss table names its one force column "Force", so a
                   plugin indexing by position or by the literal "Axial" fails
                   here rather than in front of a user. */
                rename: { "Axial": "Force" } },
  GENERALLINKFORCE: { group: "GENLINK", item: "No.", comps: COMPONENTS, parts: ["Part I", "Part J"] }
};

function elementsOfGroup(group, keys) {
  return keys.filter((k) => {
    const id = String(k);
    if (group === "GENLINK") return !!GENLINKS[id];
    const e = ELEMS[id];
    if (!e) return false;
    if (group === "BEAM") return e.TYPE === "BEAM";
    if (group === "TRUSS") return ["TRUSS", "TENSTR", "COMPTR"].indexOf(e.TYPE) >= 0;
    return false;
  });
}

function buildTable(spec, keys, seriesIn, optCs, stageStep, unit) {
  const fF = FORCE_FACTOR[unit.FORCE] == null ? 1 : FORCE_FACTOR[unit.FORCE];
  const fD = DIST_FACTOR[unit.DIST] == null ? 1 : DIST_FACTOR[unit.DIST];

  const HEAD = [spec.item, "Load", "Stage", "Step", "Part"].concat(
    spec.comps.map((c) => (spec.rename && spec.rename[c]) || c));

  const ids = elementsOfGroup(spec.group, keys);
  const DATA = [];
  ids.forEach((id) => {
    seriesIn.forEach((p) => {
      stepsFor(p, stageStep).forEach((ss) => {
        spec.parts.forEach((part) => {
          const row = [String(id), responseLabel(p), ss.stage, ss.step, part];
          spec.comps.forEach((comp) => {
            const v = valueOf(p.name, p.sense, id, part, comp, ss.stage, ss.step);
            const scaled = v == null ? null : v * fF * (MOMENT[comp] ? fD : 1);
            row.push(scaled == null ? "" : Number(scaled.toPrecision(9)));
          });
          DATA.push(row);
        });
      });
    });
  });
  return { HEAD, DATA };
}

/* --------------------------------------------------------------- responses -- */

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

/* An API error. Note the status: 200, with an error key. That is what CIVIL NX
   really does, and it is why response.ok is useless here. */
function apiError(res, message) { json(res, 200, { error: { message } }); }

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
  /* This plugin is non-mutating and never sends these; they exist so that a
     regression which starts sending one is caught here rather than on a model. */
  return apiError(res, "This mock serves GET on /db/ only.");
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
    if (!state.analysed) {
      return fail("Cannot generate table data as there is no analysis result.");
    }

    const spec = TOKENS[arg.TABLE_TYPE];
    if (!spec) {
      /* What a token that does not exist answers. It reads like an un-analysed
         model and is not. */
      return fail("there was an error creating utbl. (ex PostMode ...)");
    }

    const keys = (arg.NODE_ELEMS && arg.NODE_ELEMS.KEYS) || [];
    if (!elementsOfGroup(spec.group, keys).length) return fail("second query is wrong");

    const optCs = arg.OPT_CS === true;
    if (optCs && !(arg.STAGE_STEP && arg.STAGE_STEP.length)) {
      /* With OPT_CS on and no stage, every stage comes back interleaved. The
         mock reproduces that rather than erroring, because that is what bites. */
    }
    const stageStep = (arg.STAGE_STEP || [])[0] || null;

    const asked = arg.LOAD_CASE_NAMES || [];
    let series;
    if (!asked.length) {
      /* LOAD_CASE_NAMES:[] enumerates everything the model publishes for this
         family — the cheapest way to tell "does not exist" from "was dropped". */
      series = publishedSeries(optCs);
    } else {
      /* Anything whose suffix does not match its envelope-valuedness, or whose
         family does not match the OPT_CS mode, is dropped SILENTLY. */
      series = asked.map(parseSeries).filter((p) => addressable(p, optCs));
    }
    if (!series.length) return json(res, 200, { message: "" });

    const unit = { FORCE: arg.UNIT.FORCE, DIST: arg.UNIT.DIST };
    return json(res, 200, { [label]: buildTable(spec, keys, series, optCs, stageStep, unit) });
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
  if (p.startsWith("/civil/")) return json(res, 404, { error: { message: "no such endpoint" } });

  return serveStatic(req, res, p);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`mock MIDAS on http://localhost:${PORT}/civil`);
    console.log(`plugin        http://localhost:${PORT}/index.html?mapiKey=mock-key&redirectTo=http://localhost:${PORT}/civil`);
  });
}

module.exports = {
  server, state, TABLES, CASES, COMBOS, STAGES, TOKENS,
  valueOf, envelopeValued, addressable, parseSeries, responseLabel,
  publishedSeries, elementsOfGroup, FORCE_FACTOR, DIST_FACTOR, COMPONENTS
};
