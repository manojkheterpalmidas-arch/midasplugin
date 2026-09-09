/*
 * Concurrent Forces — offline regression suite.
 *
 *   node test/run.js
 *
 * The shipped modules run against the mock over REAL HTTP, so the MAPI client,
 * the HEAD parsing, the OPT_CS family split and the silent-drop behaviour are
 * under test rather than stubbed. Nothing here needs CIVIL NX.
 *
 * Every test case named in the plugin's brief has a section below, and each one
 * checks the plugin's answer against a number obtained INDEPENDENTLY from the
 * mock rather than against the plugin's own arithmetic — otherwise a passing
 * run is a tautology rather than a regression test.
 *
 * If every require() below comes back as an empty object, a PARENT folder's
 * package.json says "type": "module" and the local one saying "commonjs" has
 * gone missing. That is the cause, every time.
 */
const path = require("path");
const fs = require("fs");

const JS = path.join(__dirname, "..", "js");
const MapiM = require(path.join(JS, "mapi.js"));
const Combos = require(path.join(JS, "combos.js"));
const El = require(path.join(JS, "elements.js"));
const Conc = require(path.join(JS, "concurrent.js"));
const Report = require(path.join(JS, "report.js"));
const Model = require(path.join(JS, "model.js"));
const Run = require(path.join(JS, "run.js"));
const ChartM = require(path.join(JS, "chart.js"));
const DiagM = require(path.join(JS, "diag.js"));
const mock = require(path.join(__dirname, "..", "mock-midas", "server.js"));

const PORT = 8781;
const BASE = `http://localhost:${PORT}/civil`;

let passed = 0, failed = 0;
const failures = [];

function ok(cond, what, detail) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(what);
    console.log("  FAIL  " + what + (detail ? "\n        " + detail : ""));
  }
}
const eq = (a, b, what) => ok(a === b, what, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const near = (a, b, what, rel) => ok(
  a != null && b != null && Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1e-12) * (rel || 1e-9),
  what, `expected ${b}, got ${a}`);
const section = (t) => console.log("\n— " + t);

function newMapi(units) {
  return new MapiM.Mapi({ key: "mock-key", base: BASE, unit: units || { FORCE: "kN", DIST: "m" } });
}

/** What app.js does on connect, without a DOM. */
async function setup(units) {
  const mapi = newMapi(units);
  const model = await Model.readModel(mapi);
  let published = await mapi.enumerateSeries({ token: "BEAMFORCE", keys: [1], unit: mapi.unit });
  const firstStep = model.stages[0].steps[0].token;
  published = published.concat(await mapi.enumerateSeries({
    token: "BEAMFORCE", keys: [1], unit: mapi.unit, optCs: true, stageStep: firstStep
  }));
  const loadModel = Combos.buildLoadModel({
    stld: model.tables.STLD.rows, combos: model.combos,
    caseTables: model.caseTables, publishedLabels: published
  });
  return { mapi, model, loadModel };
}

function analyse(ctx, over) {
  return Run.runAnalysis(Object.assign({
    mapi: ctx.mapi, elems: ctx.model.elems, nodes: ctx.model.nodes,
    links: ctx.model.links, elinks: ctx.model.elinks,
    loadModel: ctx.loadModel, componentId: "My", criterion: "max", position: "both",
    units: ctx.mapi.unit, stageSteps: []
  }, over));
}

async function throws(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/** One value straight from the API, with no plugin code between. */
async function raw(mapi, opts) {
  const t = await mapi.postTable({
    token: opts.token || "BEAMFORCE", keys: [opts.elem], series: [opts.series],
    optCs: opts.optCs, stageStep: opts.stageStep, unit: mapi.unit
  });
  if (!t) return null;
  const ix = {};
  t.HEAD.forEach((h, i) => { ix[h] = i; });
  const row = t.DATA.find((d) =>
    /* A node table has no Part column at all, so a part filter must be skipped
       rather than compared against undefined. */
    (opts.part == null || String(d[ix.Part]) === opts.part) &&
    (opts.step == null || String(d[ix.Step]) === opts.step));
  return row ? Number(row[ix[opts.column]]) : null;
}

(async () => {
  await new Promise((r) => mock.server.listen(PORT, r));

  /* ==================================================================== */
  section("connection and read semantics");
  {
    const mapi = newMapi();
    const v = await mapi.verify();
    eq(v.program, "civil", "verify reports the program");

    /* A key keeps verifying after CIVIL NX closes. Checking keyVerified alone
       reports a dead session as connected and falls over on the first read. */
    mock.state.session = "disconnected";
    const dead = await throws(() => mapi.verify());
    ok(dead && /session is disconnected/i.test(dead.message),
      "a valid key with a dead session is refused", dead && dead.message);
    mock.state.session = "connected";

    eq((await mapi.db("ELEM")).status, "ok", "a populated table reads ok");
    eq((await mapi.db("LCOM-STEEL")).status, "empty",
      "an unpopulated table is empty (200 message:\"\"), not absent");
    eq((await mapi.db("GLNK")).status, "absent",
      "an unknown table key is absent (404 — the plugin's bug, not the model's)");

    const wl = await throws(() => mapi.post("/db/ELEM", { Assign: {} }, {}));
    ok(wl && /not permitted to POST/i.test(wl.message),
      "POST paths are whitelisted — this plugin may only reach /post/TABLE");
    eq(MapiM.ALLOWED_POST.length, 1, "the whitelist is exactly one path");

    const stripped = await mapi.post("/post/TABLE", {
      Argument: {
        TABLE_NAME: "cfp", TABLE_TYPE: "BEAMFORCE", UNIT: { FORCE: "kN", DIST: "m" },
        NODE_ELEMS: { KEYS: [1] }, LOAD_CASE_NAMES: ["DL(ST)"],
        EXPORT_PATH: "C:\\Users\\somebody\\leak.csv"
      }
    }, {});
    ok(stripped && stripped.cfp, "EXPORT_PATH is stripped before every send");

    const tok = await throws(() => mapi.postTable({ token: "NOSUCH", keys: [1], series: ["DL(ST)"] }));
    ok(tok && /utbl/i.test(tok.message), "a token that does not exist is refused");
  }

  /* ==================================================================== */
  section("model read — probes, units, stages");
  const ctx = await setup();
  {
    eq(ctx.model.probes.GENLINK.key, "GENLINK",
      "the general link table was FOUND BY PROBING past /db/GLNK, which 404s here");
    eq(ctx.model.probes.MV.key, "MVLDBS", "the moving-load case table was located");
    eq(ctx.model.units.FORCE, "kN", "the force unit came from the model");
    eq(ctx.model.units.source, "read from the model", "and it says where it came from");
    eq(ctx.model.stages.length, 3, "three construction stages");

    /* STEP TOKENS FOLLOW bSV_STEP. Offering "first" where it is false produces
       an empty table that reads like a missing analysis option. */
    const cs1 = ctx.model.stages.find((s) => s.name === "CS1");
    const cs2 = ctx.model.stages.find((s) => s.name === "CS2");
    eq(cs1.steps.length, 1, "a stage that saved no steps offers only the last step");
    eq(cs2.steps.length, 2, "a stage with bSV_STEP true offers first and last");

    const lcom = ctx.model.summary.filter((r) => /^LCOM-/.test(r.key));
    eq(lcom.length, 10, "all ten combination tables are read, not just LCOM-GEN");
  }

  /* ==================================================================== */
  section("envelope-valuedness and addressing");
  {
    const m = ctx.loadModel;
    eq(Combos.envelopeValued(m, "ULS_Comb_01"), false, "an Add of static cases is single-valued");
    eq(Combos.envelopeValued(m, "ULS_Env"), true, "an Envelope is envelope-valued");
    eq(Combos.envelopeValued(m, "Env_Sum"), true,
      "envelope-valuedness PROPAGATES: an Add containing an Envelope is a max/min pair");
    eq(Combos.envelopeValued(m, "MV_Top_L1"), true,
      "and it propagates from a moving-load leaf three levels down");

    eq(Combos.requestSeries(m, "ULS_Comb_01"), "ULS_Comb_01(CB)", "a single-valued Add takes (CB)");
    eq(Combos.requestSeries(m, "ULS_Env", "max"), "ULS_Env(CB:max)", "an envelope needs a sense");
    eq(Combos.requestSeries(m, "DL"), "DL(ST)", "a static case takes (ST)");
    eq(Combos.requestSeries(m, "Erection"), "Erection(CS)", "a stage case takes (CS)");

    /* Getting the suffix wrong is SILENCE, not an error. */
    eq(await ctx.mapi.postTable({ token: "BEAMFORCE", keys: [1], series: ["ULS_Env(CB)"] }), null,
      "an envelope addressed without a sense is dropped silently");
    ok(await ctx.mapi.postTable({ token: "BEAMFORCE", keys: [1], series: ["ULS_Env(CB:max)"] }),
      "the same envelope with a sense returns rows");
    const mixed = await ctx.mapi.postTable({
      token: "BEAMFORCE", keys: [1], series: ["ULS_Comb_01(CB)", "ULS_Env(CB)"] });
    eq(new Set(mixed.DATA.map((d) => d[1])).size, 1,
      "a mixed request silently drops only the bad series");

    /* Real load case names contain parentheses; a greedy regex eats half a name. */
    eq(Combos.splitLabel("Lateral Earth Pressure (LHS)(1)").base,
      "Lateral Earth Pressure (LHS)(1)", "a name's own parentheses are never stripped");
    eq(Combos.splitLabel("ENV(max)").sense, "max", "a sense token is stripped");
  }

  /* ==================================================================== */
  section("family split — OPT_CS is a mode switch, not a filter");
  {
    const std = await ctx.mapi.postTable({
      token: "BEAMFORCE", keys: [1], series: ["DL(ST)", "Erection(CS)"] });
    const loads = new Set(std.DATA.map((d) => d[1]));
    ok(loads.has("DL") && !loads.has("Erection(CS)"),
      "with OPT_CS off, the CS series is absent at HTTP 200 with no error");

    const cs = await ctx.mapi.postTable({
      token: "BEAMFORCE", keys: [1], series: ["DL(ST)", "Erection(CS)"],
      optCs: true, stageStep: "CS1:002(last)" });
    const csLoads = new Set(cs.DATA.map((d) => d[1]));
    ok(csLoads.has("Erection(CS)") && !csLoads.has("DL"),
      "with OPT_CS on, the static series is the one that disappears");

    /* A CB combination is in the ORDINARY family even when every child is CS. */
    eq(Combos.familyOf(ctx.loadModel, "CS_Comb"), "STD",
      "a CB combination of CS children is requested in the non-CS family");
    eq(Combos.familyOf(ctx.loadModel, "Erection"), "CS", "a CS case is in the CS family");

    const nostage = await throws(() => ctx.mapi.postTable({
      token: "BEAMFORCE", keys: [1], series: ["Erection(CS)"], optCs: true }));
    ok(nostage && /needs a stage/i.test(nostage.message),
      "OPT_CS is never sent without a stage — every stage would come back at once");
  }

  /* ==================================================================== */
  section("TEST CASE · simple continuous beam, static cases only");
  let staticRun;
  {
    staticRun = await analyse(ctx, {
      setText: "1, 2, 3, 4, 5to8", keyElemText: "3", componentId: "My",
      criterion: "max", position: "both",
      selection: ["DL", "SDL", "LL", "WIND", "TEMP"]
    });
    const gov = staticRun.governing;
    ok(gov, "a governing row was found");
    eq(staticRun.report.meta.stage, "", "static results carry no stage");

    /* Hand-check against the result table: the governing value must be the one
       the API itself reports for that case, element and part. */
    const check = await raw(ctx.mapi, {
      elem: 3, part: gov.row.part, column: "Moment-y",
      series: gov.row.load + "(ST)"
    });
    near(gov.value, check, "the governing value matches the API's own number for that row");

    /* And it must actually be the maximum over everything queried. */
    const all = [];
    for (const c of ["DL", "SDL", "LL", "WIND", "TEMP"]) {
      for (const part of ["Part I", "Part J"]) {
        all.push(await raw(ctx.mapi, { elem: 3, part, column: "Moment-y", series: c + "(ST)" }));
      }
    }
    near(gov.value, Math.max(...all), "it is the maximum over every case and both parts");

    /* Every other element is reported AT THAT SAME STATE, not at its own extreme. */
    const other = await raw(ctx.mapi, {
      elem: 6, part: "Part I", column: "Shear-z", series: gov.row.load + "(ST)" });
    const reported = staticRun.rows.find((r) => r.elemKey === "6" && r.part === "Part I");
    near(reported.values["Shear-z"], other,
      "element 6's shear is the COEXISTENT value at the governing load");

    const ownMax = Math.max(...await Promise.all(["DL", "SDL", "LL", "WIND", "TEMP"].map((c) =>
      raw(ctx.mapi, { elem: 6, part: "Part I", column: "Shear-z", series: c + "(ST)" }))));
    ok(reported.values["Shear-z"] !== ownMax,
      "and it is NOT element 6's own independent extreme — which is the whole point");

    eq(staticRun.rows.map((r) => r.elemKey).filter((v, i, a) => a.indexOf(v) === i).join(","),
      "1,2,3,4,5,6,7,8", "rows are sorted in the order the user entered the set");
    eq(staticRun.rows.length, 16, "eight elements at two parts");
    ok(staticRun.report.rows.find((r) => r.isKey) != null, "the key element's row is flagged");
    eq(staticRun.report.rows.filter((r) => r.emphasis === "Moment-y").length, 1,
      "exactly one cell — the governing one — is emphasised");
  }

  /* ==================================================================== */
  section("TEST CASE · mixed set of beams, trusses and general links");
  {
    const out = await analyse(ctx, {
      setText: "1, 2, 21, 22, L5, L6", keyElemText: "1", componentId: "Fx",
      criterion: "max", position: "both", selection: ["ULS_Comb_01", "ULS_Comb_07"]
    });
    const kinds = new Set(out.rows.map((r) => r.source));
    ok(kinds.has("BEAM") && kinds.has("TRUSS") && kinds.has("GENLINK"),
      "all three element types are merged into one answer");
    eq(out.tokens.TRUSS, "TRUSSFORCE", "the truss token was resolved");
    eq(out.tokens.GENLINK, "GENERALLINKFORCE",
      "the general-link token was found by probing PAST the first candidate");

    /* Column names differ per table: the link table calls its item column
       "No." and the truss table calls its one force column "Force". */
    const truss = out.rows.find((r) => r.source === "TRUSS");
    ok(truss && truss.values["Axial"] != null,
      "the truss table's \"Force\" column was found as Axial by name");
    const link = out.rows.find((r) => r.source === "GENLINK");
    ok(link && link.elemKey === "L5", "the link table's \"No.\" column was found, and namespaced");

    /* A truss carries no shear or moment. That is ABSENT, not zero, and the
       report must print the reason rather than a blank that reads as
       "not computed". */
    const trussRow = out.report.rows.find((r) => r.cells[0].text === "21");
    const mzCol = out.report.columns.findIndex((c) => c.id === "Moment-z");
    eq(trussRow.cells[mzCol].text, "n/a", "a component a truss cannot carry reads n/a");
    ok(/axial force only/i.test(trussRow.cells[mzCol].reason || ""),
      "and the cell carries the reason");

    /* 5 is BOTH a beam element and a general link on this model. */
    ok(out.warnings.some((w) => /also exists? as/i.test(w) || /collid/i.test(w)),
      "the colliding id space is reported rather than silently resolved",
      JSON.stringify(out.warnings));
    const bare = await analyse(ctx, {
      setText: "5, 6", keyElemText: "5", componentId: "Fx", criterion: "max",
      position: "both", selection: ["ULS_Comb_01"] });
    eq(bare.rows[0].source, "BEAM", "a bare number means the ELEMENT, never the link");
  }

  /* ==================================================================== */
  section("TEST CASE · envelope with a clear single governing child");
  {
    const out = await analyse(ctx, {
      setText: "1to8", keyElemText: "3", componentId: "My", criterion: "max",
      position: "both", selection: ["ULS_Env"]
    });
    ok(out.state, "the envelope was resolved rather than filtered directly");
    eq(out.state.single, true, "it resolved to a single child");
    ok(["ULS_Comb_01", "ULS_Comb_07", "ULS_Comb_12"].includes(out.state.resolvedName),
      "and the child is one of the envelope's own", out.state.resolvedName);

    /* The reconstruction is gated against what MIDAS published. */
    near(out.state.check.reconstructed, out.state.check.published,
      "the resolved state reproduces the envelope value at the key element");

    const headline = out.report.header.find((h) => h.label === "Resolved");
    ok(headline && /ULS_Env resolved to ULS_Comb_/.test(headline.value),
      "the resolved child is stated prominently in the header", headline && headline.value);
    ok(headline.emphasis, "and it is marked for emphasis");
    /* The emphasis must survive resolution: the reported rows carry the
       RESOLVED state's key while the governing row still carries the
       envelope's, so a key comparison would drop it on exactly these runs. */
    eq(out.report.rows.filter((r) => r.emphasis === "Moment-y").length, 1,
      "the governing cell is still emphasised after an envelope is resolved");

    /* THE TRAP: re-reading the envelope's own name at another element gives
       that element's independent extreme, not the coexistent value. */
    const elem7 = out.rows.find((r) => r.elemKey === "7" && r.part === "Part I");
    const trueValue = await raw(ctx.mapi, {
      elem: 7, part: "Part I", column: "Moment-y",
      series: out.state.resolvedName + "(CB)" });
    near(elem7.values["Moment-y"], trueValue,
      "element 7 is reported at the RESOLVED child");
    const naive = await raw(ctx.mapi, {
      elem: 7, part: "Part I", column: "Moment-y", series: "ULS_Env(CB:max)" });
    ok(Math.abs(naive - trueValue) > 1e-6,
      "and re-reading ULS_Env by name at element 7 would have given a different, " +
      "physically impossible number");
  }

  /* ==================================================================== */
  section("TEST CASE · nested envelope, two levels deep");
  {
    const out = await analyse(ctx, {
      setText: "1to6", keyElemText: "2", componentId: "Fz", criterion: "max",
      position: "both", selection: ["ULS_Env_Outer"]
    });
    ok(out.state, "the outer envelope resolved");
    eq(Combos.envelopeValued(ctx.loadModel, out.state.resolvedName || ""), false,
      "the resolution descended until the state is SINGLE-VALUED, never stopping " +
      "at an envelope child");
    ok(out.state.path.length >= 2,
      "the descent went through more than one level", JSON.stringify(out.state.path));
    near(out.state.check.reconstructed, out.state.check.published,
      "and it still reconciles against the outer envelope's own published value");
  }

  /* ==================================================================== */
  section("TEST CASE · an envelope-valued Add resolves to a weighted sum");
  {
    const out = await analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["Env_Sum"]
    });
    ok(out.state && out.state.terms.length >= 2,
      "Env_Sum resolved to more than one term — it is a sum, not one child");
    ok(out.state.terms.every((t) => !Combos.envelopeValued(ctx.loadModel, t.name)),
      "every term of the resolved state is single-valued");
    near(out.state.check.reconstructed, out.state.check.published,
      "the weighted sum reproduces what MIDAS reports for Env_Sum");
    ok(/\+/.test(out.report.meta.expression),
      "the header carries the full resolved expression, not just a name",
      out.report.meta.expression);
  }

  /* ==================================================================== */
  section("TEST CASE · moving load three levels deep must block");
  {
    const err = await throws(() => analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["MV_Top_L1"]
    }));
    ok(err, "the run is refused");
    ok(/Moving Load Tracer/.test(err.hint || ""),
      "with the moving-load message and its workaround", err && err.hint);

    const b = Combos.blockages(ctx.loadModel, "MV_Top_L1");
    eq(b[0].leaf, "HA-UDL", "the blocked leaf is named");
    eq(b[0].path.join(" → "), "MV_Top_L1 → MV_Mid_L2 → MV_Leaf_L3 → HA-UDL",
      "and the whole path to it is reported — nothing on MV_Top_L1's own name says so");
    eq(Combos.blockages(ctx.loadModel, "MV_Mid_L2").length, 1, "the middle level blocks too");
  }

  /* ==================================================================== */
  section("TEST CASE · settlement selected directly must block");
  {
    const err = await throws(() => analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["Settle-1"]
    }));
    ok(err && /specified-displacement/.test(err.hint || ""),
      "the settlement message names the workaround", err && err.hint);
    ok(/enveloped over the settlement group/.test(err.hint || ""),
      "and says why it is blocked");

    const rs = await throws(() => analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["RSX"] }));
    ok(rs && /sign-less after modal combination/.test(rs.hint || ""),
      "response spectrum is blocked with no workaround offered", rs && rs.hint);

    const abs = await throws(() => analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["ABS_Comb"] }));
    ok(abs && /discards sign/.test(abs.hint || ""), "ABS is refused, not approximated");

    const srss = await throws(() => analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["SRSS_Comb"] }));
    ok(srss && /quadratically/.test(srss.hint || ""), "SRSS is refused, not approximated");
  }

  /* ==================================================================== */
  section("TEST CASE · construction stage governing at a mid-stage step");
  {
    const steps = ["CS1:002(last)", "CS2:001(first)", "CS2:002(last)", "CS3:002(last)"];

    /* Find a component whose extreme at element 4 sits at a MID-stage step,
       so the test is about the case the brief names and not the easy one. */
    let chosen = null;
    for (const comp of El.SOURCES.BEAM.components) {
      const vals = [];
      for (const st of steps) {
        const [stage, step] = st.split(":");
        for (const part of ["Part I", "Part J"]) {
          vals.push({ st, part, v: await raw(ctx.mapi, {
            elem: 4, part, column: comp.column, series: "Erection(CS)",
            optCs: true, stageStep: st, step }) });
        }
      }
      const best = vals.reduce((a, b) => (b.v > a.v ? b : a));
      if (best.st !== "CS3:002(last)") { chosen = { comp, best }; break; }
    }
    ok(chosen, "the fixture has a component governing before the last stage");

    const out = await analyse(ctx, {
      setText: "1to6", keyElemText: "4", componentId: chosen.comp.id, criterion: "max",
      position: "both", selection: ["Erection"], stageSteps: steps
    });
    near(out.governing.value, chosen.best.v,
      "the governing value is the extreme across every stage and step queried");
    eq(out.report.meta.stage, chosen.best.st.split(":")[0],
      "the governing stage is the mid-stage one, not the last");
    eq(out.report.meta.step, chosen.best.st.split(":")[1], "and the governing step with it");
    ok(out.rows.every((r) => r.stage === out.report.meta.stage && r.step === out.report.meta.step),
      "every reported row is at that same stage and step — the key includes Stage:Step");

    const noStage = await throws(() => analyse(ctx, {
      setText: "1to6", keyElemText: "4", componentId: "My", criterion: "max",
      position: "both", selection: ["Erection"], stageSteps: [] }));
    ok(noStage && /no stage and step is/.test(noStage.message),
      "a stage case with no stage chosen is refused rather than guessed");
  }

  /* ==================================================================== */
  section("TEST CASE · time history saved with max/min only must block");
  {
    const err = await throws(() => analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["Quake-TH"]
    }));
    ok(err, "the run is refused");
    ok(/step-by-step results saved/.test(err.hint || ""),
      "with the re-run message", err && err.hint);
    eq(ctx.loadModel.thStepless["Quake-TH"], true,
      "the audit recorded that this case holds no steps");

    /* The same model's other time history case DID save steps, and must run. */
    const good = await analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["Quake-TH-Steps"]
    });
    ok(good.governing.row.step !== "" && good.governing.row.step !== "max",
      "a stepped time history governs at a real step", good.governing.row.step);
    ok(good.rows.every((r) => r.step === good.governing.row.step),
      "and every reported row is at that step — the key includes Step");

    const wrapped = await throws(() => analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["TH_Comb"] }));
    ok(wrapped && /step-by-step results saved/.test(wrapped.hint || ""),
      "and a combination wrapping the stepless case blocks too");
  }

  /* ==================================================================== */
  section("TEST CASE · key element not in the set");
  {
    const err = await throws(() => analyse(ctx, {
      setText: "1, 2, 3", keyElemText: "9", componentId: "My", criterion: "max",
      position: "both", selection: ["DL"]
    }));
    ok(err && /not a member of the element set/i.test(err.message),
      "the key element must be a member of the set", err && err.message);
    ok(/Add it to the set/.test(err.hint || ""), "and the message says what to do about it");
  }

  /* ==================================================================== */
  section("TEST CASE · 200+ elements across many combinations");
  {
    const before = ctx.mapi.calls;
    const combos = ["ULS_Comb_01", "ULS_Comb_07", "ULS_Comb_12", "DL", "SDL", "LL", "WIND", "TEMP"];
    const out = await analyse(ctx, {
      setText: "201to420", keyElemText: "300", componentId: "My", criterion: "max",
      position: "both", selection: combos
    });
    const spent = ctx.mapi.calls - before;
    eq(out.rows.length, 440, "220 elements at two parts");
    ok(spent <= 3, "the whole run cost " + spent + " requests, not one per element " +
      "or per load case (that would be " + (220 * combos.length) + ")");
    eq(out.calls.filter((c) => c.source === "BEAM").length, 1,
      "one /post/TABLE for the whole beam set");
    ok(out.rows.every((r) => r.key === out.key),
      "every one of the 440 rows carries the governing join key");
  }

  /* ==================================================================== */
  section("TEST CASE · min and absolute max pick different states");
  {
    /* Element 1's Moment-y: the maximum and the minimum sit under DIFFERENT load
       cases on this fixture, which is the case the brief asks for — a criterion
       that changes the answer, not just the sign. */
    const common = {
      setText: "1to8", keyElemText: "1", componentId: "My", position: "both",
      selection: ["DL", "SDL", "LL", "WIND", "TEMP"]
    };
    const mx = await analyse(ctx, Object.assign({}, common, { criterion: "max" }));
    const mn = await analyse(ctx, Object.assign({}, common, { criterion: "min" }));
    const ab = await analyse(ctx, Object.assign({}, common, { criterion: "absmax" }));

    ok(mx.key !== mn.key, "max and min govern at different states",
      mx.key + " vs " + mn.key);
    ok(mn.governing.value < 0 && mx.governing.value > 0,
      "and with opposite signs");
    const bigger = Math.abs(mn.governing.value) > Math.abs(mx.governing.value) ? mn : mx;
    eq(ab.key, bigger.key, "absolute max lands on whichever of the two is larger in magnitude");
    near(Math.abs(ab.governing.value), Math.abs(bigger.governing.value),
      "with the same magnitude");
  }

  /* ==================================================================== */
  section("TEST CASE · kN-m against kip-ft");
  {
    const metric = await analyse(ctx, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["ULS_Comb_01"], units: { FORCE: "kN", DIST: "m" }
    });
    const imperial = await setup({ FORCE: "kips", DIST: "ft" });
    const imp = await analyse(imperial, {
      setText: "1to4", keyElemText: "2", componentId: "My", criterion: "max",
      position: "both", selection: ["ULS_Comb_01"], units: { FORCE: "kips", DIST: "ft" }
    });
    eq(imp.key, metric.key, "the governing state is the same whatever the units");

    const kipsPerKn = mock.FORCE_FACTOR.kips;
    const ftPerM = mock.DIST_FACTOR.ft;
    near(imp.governing.value, metric.governing.value * kipsPerKn * ftPerM,
      "the moment scales by force × length", 1e-6);

    const mForce = metric.rows.find((r) => r.elemKey === "3" && r.part === "Part I").values["Axial"];
    const iForce = imp.rows.find((r) => r.elemKey === "3" && r.part === "Part I").values["Axial"];
    near(iForce, mForce * kipsPerKn, "and an axial force scales by force alone", 1e-6);

    ok(/kips/.test(imp.report.header.find((h) => h.label === "Units").value),
      "the header states the units the numbers are in");
    ok(/kips·ft/.test(imp.report.columns.find((c) => c.id === "Moment-y").label),
      "and the moment column names force × length");
  }

  /* ==================================================================== */
  section("errors are specific");
  {
    const empty = await throws(() => analyse(ctx, {
      setText: "  ", keyElemText: "1", selection: ["DL"] }));
    ok(empty && /element set is empty/i.test(empty.message), "an empty set says so");

    const solid = await throws(() => analyse(ctx, {
      setText: "1, 40", keyElemText: "1", selection: ["DL"] }));
    ok(solid && /cannot report on/i.test(solid.message),
      "an element type with no result table this plugin reads is rejected by name");
    ok(/no result table this plugin reads/.test(solid.hint || ""),
      "with a reason, not just a refusal", solid && solid.hint);

    /* The driver names a source as well as an item, and the two have to agree. */
    const wrongSource = await throws(() => analyse(ctx, {
      setText: "1, 2", keyItemText: "1", effectId: "REACTION:FZ",
      criterion: "max", position: "both", selection: ["DL"] }));
    ok(wrongSource && /has no node reactions result/i.test(wrongSource.message),
      "asking for a reaction at a beam element is refused", wrongSource && wrongSource.message);
    ok(/beam elements/.test(wrongSource.hint || ""),
      "and the message names what that item does have", wrongSource && wrongSource.hint);

    const noSuch = await throws(() => analyse(ctx, {
      setText: "1, 2", keyItemText: "1", effectId: "NOPE:Frog",
      criterion: "max", position: "both", selection: ["DL"] }));
    ok(noSuch && /not a result quantity/i.test(noSuch.message),
      "an unknown effect id is refused rather than silently defaulted");

    const gone = await throws(() => analyse(ctx, {
      setText: "1, 9999", keyElemText: "1", selection: ["DL"] }));
    ok(gone && /Not in the model/i.test(gone.message), "an element number not in the model");

    const noCases = await throws(() => analyse(ctx, {
      setText: "1, 2", keyElemText: "1", selection: [] }));
    ok(noCases && /No load cases/i.test(noCases.message), "no selection at all");

    const badSet = await throws(() => analyse(ctx, {
      setText: "1, frog", keyElemText: "1", selection: ["DL"] }));
    ok(badSet && /could not be read/i.test(badSet.message), "unparseable set text");

    /* Un-analysed model. */
    mock.state.analysed = false;
    const unanalysed = await throws(() => analyse(ctx, {
      setText: "1, 2", keyElemText: "1", componentId: "My", criterion: "max",
      position: "both", selection: ["DL"] }));
    ok(unanalysed && /no analysis result/i.test(unanalysed.message),
      "an un-analysed model is reported as exactly that", unanalysed && unanalysed.message);
    ok(/has not been analysed/.test(unanalysed.hint || ""), "with an actionable hint");
    mock.state.analysed = true;
  }

  /* ==================================================================== */
  section("the resolution refuses what it cannot reconcile");
  {
    /* A synthetic model where the parent's extreme matches NO child and is not
       the sum either. The plugin must refuse rather than print a number that
       cannot be checked. */
    const m = Combos.buildLoadModel({
      stld: { 1: { NAME: "A" }, 2: { NAME: "B" } },
      combos: [{ table: "LCOM-GEN", rows: {
        1: { NAME: "ENV", iTYPE: 1, vCOMB: [
          { ANAL: "ST", LCNAME: "A", FACTOR: 1 }, { ANAL: "ST", LCNAME: "B", FACTOR: 1 }] }
      } }]
    });
    const values = { "ENV(CB:max)": 99, "A(ST)": 10, "B(ST)": 20 };
    const err = await throws(() => Combos.resolveState(m, "ENV", "max",
      (reqs) => new Map(reqs.map((r) => [r, values[r]]))));
    ok(err && /No child of "ENV" reproduces/.test(err.message),
      "an envelope whose value no child reproduces is refused", err && err.message);

    /* And the measured MIDAS behaviour — an Add that propagates one child's
       extreme rather than summing — is resolved through that child. */
    const m2 = Combos.buildLoadModel({
      stld: { 1: { NAME: "S" } },
      combos: [{ table: "LCOM-GEN", rows: {
        1: { NAME: "E", iTYPE: 1, vCOMB: [{ ANAL: "ST", LCNAME: "S", FACTOR: 1 }] },
        2: { NAME: "ADD", iTYPE: 0, vCOMB: [
          { ANAL: "CB", LCNAME: "E", FACTOR: 1 }, { ANAL: "ST", LCNAME: "S", FACTOR: 1 }] }
      } }]
    });
    const v2 = { "ADD(CB:max)": 7, "E(CB:max)": 7, "S(ST)": 7 };
    const st2 = await Combos.resolveState(m2, "ADD", "max",
      (reqs) => new Map(reqs.map((r) => [r, v2[r]])));
    ok(st2.notes.some((n) => /propagates one child's extreme/.test(n)),
      "the propagating reading is used and SAID, not silently assumed",
      JSON.stringify(st2.notes));
    eq(st2.terms.length, 1, "and it resolves to that one child");
  }

  /* ==================================================================== */
  section("near ties have a stated policy");
  {
    const m = Combos.buildLoadModel({
      stld: { 1: { NAME: "A" }, 2: { NAME: "B" } },
      combos: [{ table: "LCOM-GEN", rows: {
        1: { NAME: "ENV", iTYPE: 1, vCOMB: [
          { ANAL: "ST", LCNAME: "A", FACTOR: 1 }, { ANAL: "ST", LCNAME: "B", FACTOR: 1 }] }
      } }]
    });
    const values = { "ENV(CB:max)": 50, "A(ST)": 50, "B(ST)": 50 };
    const st = await Combos.resolveState(m, "ENV", "max",
      (reqs) => new Map(reqs.map((r) => [r, values[r]])));
    eq(st.resolvedName, "A", "a tie resolves to the first child in definition order");
    eq(st.ties.length, 1, "and the tie is recorded, not swallowed");
    eq(st.ties[0].children.join(","), "A,B", "with both contenders named");
  }

  /* ==================================================================== */
  section("the report and the CSV carry the same document");
  {
    const doc = staticRun.report;
    const csv = Report.toCsv(doc);
    const lines = csv.split("\r\n");
    const comments = lines.filter((l) => l.startsWith("#"));
    ok(comments.length >= doc.header.length,
      "the header block is present as comment lines");
    ok(comments.some((l) => /^# Key item:/.test(l)), "including the key item");
    ok(comments.some((l) => /^# Governing load:/.test(l)), "and the governing load");
    ok(comments.some((l) => /^# Units:/.test(l)), "and the units");

    const headerRow = lines[comments.length];
    eq(headerRow.split(",").length, doc.columns.length,
      "the CSV column count mirrors the on-screen table");
    const body = lines.slice(comments.length + 1).filter(Boolean);
    eq(body.length, doc.rows.length, "and the row count too");
    eq(body[0].split(",")[0], doc.rows[0].cells[0].text, "in the same order");

    /* Excel must never receive a locale-formatted string. */
    const mzCol = doc.columns.findIndex((c) => c.id === "Moment-z");
    const raw0 = body[0].split(",")[mzCol];
    ok(raw0 === "" || raw0 === "n/a" || String(Number(raw0)) === raw0.replace(/^(-?)0+(\d)/, "$1$2") ||
       isFinite(Number(raw0)), "numbers go out typed, not display-formatted", raw0);
    ok(Number(raw0) !== Number(doc.rows[0].cells[mzCol].text) ||
       doc.rows[0].cells[mzCol].value === Number(raw0),
      "the CSV uses the typed accessor, not the rounded display text");
  }

  /* ==================================================================== */
  section("the governing condition is ANY result quantity");
  {
    /* The point of this section: the driver is an item plus an effect, and the
       effect names its own result table. Nothing downstream assumes a beam, an
       element, or even a member force — the join key is what makes the answer
       concurrent, and it does not care where the driver came from. */
    eq(El.SOURCE_ORDER.length, 7, "seven result sources are registered");
    eq(El.allComponents().length, 39, "39 quantities can drive a run");

    /* ---- a NODE REACTION drives, and elements report at that state ------ */
    const byReaction = await analyse(ctx, {
      setText: "N1, N15, N30, 1, 2, 3", keyItemText: "N1",
      effectId: "REACTION:FZ", criterion: "max", position: "both",
      selection: ["DL", "SDL", "LL", "WIND", "TEMP"]
    });
    eq(byReaction.effect.source, "REACTION", "the driver is a node reaction");
    const govN = byReaction.governing;
    const rawN = await raw(ctx.mapi, {
      token: "REACTIONG", elem: 1, part: undefined, column: "FZ",
      series: govN.row.load + "(ST)" });
    near(govN.value, rawN, "the governing reaction matches the API's own number");

    /* Every element in the set is reported AT THE STATE THE REACTION PICKED. */
    const beamRow = byReaction.rows.find((r) => r.elemKey === "2" && r.part === "Part I");
    const coex = await raw(ctx.mapi, {
      elem: 2, part: "Part I", column: "Moment-y", series: govN.row.load + "(ST)" });
    near(beamRow.values["Moment-y"], coex,
      "a beam moment coexisting with the governing reaction");
    ok(byReaction.rows.every((r) => r.key === byReaction.key),
      "nodes and elements share one join key — that is what makes them concurrent");

    /* A node carries BOTH sources; their columns are disjoint, so both are
       read and the criterion ranges over only the one the driver named. */
    const sources = new Set(byReaction.rows.map((r) => r.source));
    ok(sources.has("REACTION") && sources.has("DISPLACEMENT") && sources.has("BEAM"),
      "reactions, displacements and beam forces in one answer",
      JSON.stringify([...sources]));

    /* A free node publishes NO reaction row. That is absent, not zero. */
    const free = await analyse(ctx, {
      setText: "N7, N1", keyItemText: "N1", effectId: "REACTION:FZ",
      criterion: "max", position: "both", selection: ["DL"] });
    ok(!free.rows.some((r) => r.elemKey === "N7" && r.source === "REACTION"),
      "an unrestrained node returns no reaction row");
    const freeDoc = free.report;
    const n7 = freeDoc.rows.find((r) => r.cells[0].text === "N7");
    const fzCol = freeDoc.columns.findIndex((c) => c.id === "FZ");
    eq(n7.cells[fzCol].text, "n/a", "and its reaction cell reads n/a, never blank");
    ok(/not restrained/.test(n7.cells[fzCol].reason || ""),
      "with the reason printed", n7.cells[fzCol].reason);

    /* ---- a DISPLACEMENT drives -------------------------------------- */
    const byDisp = await analyse(ctx, {
      setText: "N5, N6, 4, 5", keyItemText: "N5", effectId: "DISPLACEMENT:DZ",
      criterion: "absmax", position: "both", selection: ["ULS_Comb_01", "ULS_Comb_07"] });
    eq(byDisp.effect.source, "DISPLACEMENT", "a displacement can drive too");
    eq(byDisp.report.meta.component, "DZ", "and the report knows which quantity it was");
    ok(/rad|m\b/.test(byDisp.report.columns.find((c) => c.id === "RX").label),
      "a rotation column is labelled in radians, not in force",
      byDisp.report.columns.find((c) => c.id === "RX").label);

    /* ---- an ELASTIC LINK drives, and its part column is a NODE -------- */
    const byLink = await analyse(ctx, {
      setText: "EL201, EL202, 1", keyItemText: "EL201", effectId: "ELASTICLINK:Axial",
      criterion: "max", position: "both", selection: ["ULS_Comb_01"] });
    eq(byLink.tokens.ELASTICLINK, "ELASTICLINK", "the elastic link token resolved");
    ok(byLink.rows.some((r) => r.source === "ELASTICLINK"), "and its rows came back");
    /* Its part is a node number, not an I or a J end. Filtering those rows on
       an I/J output position would throw every one of them away. */
    const elRow = byLink.rows.find((r) => r.source === "ELASTICLINK");
    ok(!/^Part [IJ]$/.test(elRow.part),
      "the elastic link's part is a node, not an end", elRow.part);
    eq(elRow.partKind, "node", "which the row records");

    /* 201 is BOTH a beam element and an elastic link on this model. */
    eq(byLink.rows.find((r) => r.elemKey === "EL201").source, "ELASTICLINK",
      "EL201 addresses the LINK");
    const asElem = await analyse(ctx, {
      setText: "201", keyItemText: "201", effectId: "BEAM:Axial",
      criterion: "max", position: "both", selection: ["ULS_Comb_01"] });
    eq(asElem.rows[0].source, "BEAM", "and a bare 201 addresses the ELEMENT");
    ok(byLink.warnings.some((w) => /also exists as/.test(w)),
      "the three-way collision is reported", JSON.stringify(byLink.warnings));

    /* ---- a PLATE drives, in per-unit-length units --------------------- */
    const byPlate = await analyse(ctx, {
      setText: "30, 31, 1", keyItemText: "30", effectId: "PLATE:Mxx",
      criterion: "max", position: "both", selection: ["ULS_Comb_01"] });
    eq(byPlate.tokens.PLATE, "PLATEFORCE", "the plate token resolved");
    const mxx = byPlate.report.columns.find((c) => c.id === "Mxx");
    eq(mxx.label, "Mxx (kN·m/m)",
      "a plate moment is labelled per unit length, not as a plain moment");
    const fxx = byPlate.report.columns.find((c) => c.id === "Fxx");
    eq(fxx.label, "Fxx (kN/m)", "and an in-plane force per unit length too");

    /* A beam in the same set has no plate components, and vice versa. */
    const beamDocRow = byPlate.report.rows.find((r) => r.cells[0].text === "1");
    const mxxCol = byPlate.report.columns.findIndex((c) => c.id === "Mxx");
    eq(beamDocRow.cells[mxxCol].text, "n/a", "a beam has no Mxx");
    ok(/per unit length/.test(beamDocRow.cells[mxxCol].reason || "") ||
       /not carried/.test(beamDocRow.cells[mxxCol].reason || ""),
      "with the reason", beamDocRow.cells[mxxCol].reason);

    /* ---- the output position does not apply where there is no I/J end -- */
    const posHeader = byReaction.report.header.find((h) => h.label === "Output position");
    ok(/not applicable/.test(posHeader.value),
      "a node driver reports the output position as not applicable", posHeader.value);
  }

  /* ==================================================================== */
  section("units are per quantity, not per table");
  {
    const metric = await analyse(ctx, {
      setText: "N1, 1", keyItemText: "N1", effectId: "REACTION:FZ",
      criterion: "max", position: "both", selection: ["ULS_Comb_01"],
      units: { FORCE: "kN", DIST: "m" } });
    const mm = await setup({ FORCE: "N", DIST: "mm" });
    const small = await analyse(mm, {
      setText: "N1, 1", keyItemText: "N1", effectId: "REACTION:FZ",
      criterion: "max", position: "both", selection: ["ULS_Comb_01"],
      units: { FORCE: "N", DIST: "mm" } });

    near(small.governing.value, metric.governing.value * 1000,
      "a reaction force scales with FORCE alone", 1e-6);

    const mRow = metric.rows.find((r) => r.source === "DISPLACEMENT");
    const sRow = small.rows.find((r) => r.source === "DISPLACEMENT");
    near(sRow.values.DZ, mRow.values.DZ * 1000,
      "a displacement scales with LENGTH", 1e-6);
    near(sRow.values.RX, mRow.values.RX,
      "and a rotation does not scale at all — it is already dimensionless", 1e-9);

    const mMoment = metric.rows.find((r) => r.source === "BEAM" && r.part === "Part I");
    const sMoment = small.rows.find((r) => r.source === "BEAM" && r.part === "Part I");
    near(sMoment.values["Moment-y"], mMoment.values["Moment-y"] * 1000 * 1000,
      "a member moment scales with FORCE x LENGTH", 1e-6);
  }

  /* ==================================================================== */
  section("a run that finds nothing says WHY");
  {
    /* One symptom — "no result row found" — hides three different faults, and
       the reader cannot tell them apart from outside the plugin. Each has to
       name its own evidence, or the next hour goes on doubting the model. */
    const base = {
      setText: "1, 2, 3", keyItemText: "1", criterion: "max", position: "both",
      selection: ["DL", "SDL", "LL"]
    };

    /* 1 — the driver's own column is not in the HEAD at all. Silent before
           this: every value read undefined, every row was skipped, and the run
           reported "no row found" for a table that had returned plenty. */
    mock.state.dropColumn = "Moment-y";
    const dropped = await throws(() => analyse(ctx,
      Object.assign({}, base, { effectId: "BEAM:Moment-y" })));
    mock.state.dropColumn = null;
    ok(dropped && /has no "Moment-y" column/.test(dropped.message),
      "a missing driver column is named, not swallowed", dropped && dropped.message);
    ok(/It returned these columns: Elem, Load/.test(dropped.hint || ""),
      "and the columns that DID come back are listed",
      dropped && dropped.hint);

    /* The run still works for a column that IS there. */
    mock.state.dropColumn = "Moment-y";
    const still = await analyse(ctx, Object.assign({}, base, { effectId: "BEAM:Axial" }));
    mock.state.dropColumn = null;
    ok(still.governing, "and another quantity in the same table still runs");
    ok(still.warnings.some((w) => /returned no Moment-y column/.test(w)),
      "and the absent column is reported once, by name, rather than only " +
      "cell by cell", JSON.stringify(still.warnings));

    /* 2 — the item returns rows, but at output positions the filter excludes. */
    /* A build whose part tokens are spelled differently must not lose every
       row to the default output position. The filter is relaxed and the run
       SAYS it relaxed it — the concurrent set does not depend on the position. */
    mock.state.partLabels = ["Start", "End"];
    const oddParts = await analyse(ctx,
      Object.assign({}, base, { effectId: "BEAM:Axial", position: "both" }));
    mock.state.partLabels = null;
    ok(oddParts.governing, "an unfamiliar part vocabulary still produces an answer");
    ok(oddParts.warnings.some((w) => /output position was ignored/.test(w)),
      "and the run says the position was ignored rather than doing it silently",
      JSON.stringify(oddParts.warnings));
    ok(oddParts.rows.some((r) => r.part === "Start") &&
       oddParts.rows.some((r) => r.part === "End"),
      "both output points are reported");

    /* 3 — the column is present and empty in every row. */
    mock.state.blankColumn = "Axial";
    const blank = await throws(() => analyse(ctx,
      Object.assign({}, base, { effectId: "BEAM:Axial" })));
    mock.state.blankColumn = null;
    ok(blank && /column is empty in every one/.test(blank.message),
      "an empty column is distinguished from a missing one", blank && blank.message);

    /* Number("") is 0. A blank in a numeric column must NOT arrive as a real,
       plottable, exportable force of exactly nothing — that is worse than no
       value at all, because it is indistinguishable from a genuine zero. */
    const blankRow = Conc.parseTable(
      { HEAD: ["Elem", "Load", "Part", "Axial"], DATA: [["1", "DL", "Part I", ""]] },
      { source: El.SOURCES.BEAM });
    eq(blankRow.rows[0].values.Axial, null, "an empty cell is null, never zero");
    const zeroRow = Conc.parseTable(
      { HEAD: ["Elem", "Load", "Part", "Axial"], DATA: [["1", "DL", "Part I", 0]] },
      { source: El.SOURCES.BEAM });
    eq(zeroRow.rows[0].values.Axial, 0, "and a genuine zero is still a zero");

    /* 4 — the item produced nothing in this source, but did in another. */
    const nodeOnly = await throws(() => analyse(ctx, {
      setText: "N1, 1", keyItemText: "N7", effectId: "REACTION:FZ",
      criterion: "max", position: "both", selection: ["DL"] }));
    ok(nodeOnly && /not a member of the element set/i.test(nodeOnly.message),
      "an item outside the set is still caught first");

    const freeNode = await throws(() => analyse(ctx, {
      setText: "N7", keyItemText: "N7", effectId: "REACTION:FZ",
      criterion: "max", position: "both", selection: ["DL"] }));
    ok(freeNode && /no row at all for key item N7/.test(freeNode.message),
      "an unrestrained node driving a reaction is told plainly",
      freeNode && freeNode.message);
    ok(/node displacements/.test(freeNode.hint || ""),
      "and pointed at the source that DID answer for it", freeNode && freeNode.hint);
  }

  /* ==================================================================== */
  section("column names are matched, not assumed");
  {
    /* A header that carries its unit — "Moment-y (kN*m)" — is the same column.
       Matching it on the raw header with a boundary check is what keeps "Fx"
       from quietly claiming a plate's "Fxx" and filing an in-plane force under
       an axial heading. */
    mock.state.headerUnits = true;
    const withUnits = await analyse(ctx, {
      setText: "1, 2, 3", keyItemText: "1", effectId: "BEAM:Moment-y",
      criterion: "max", position: "both", selection: ["DL", "SDL", "LL"] });
    mock.state.headerUnits = false;
    ok(withUnits.governing, "a unit-suffixed header still resolves");

    const plain = await analyse(ctx, {
      setText: "1, 2, 3", keyItemText: "1", effectId: "BEAM:Moment-y",
      criterion: "max", position: "both", selection: ["DL", "SDL", "LL"] });
    near(withUnits.governing.value, plain.governing.value,
      "and gives the same answer as the plain header");

    const fx = El.resolveColumns(["Elem", "Load", "Node", "Fxx", "Fyy"], {
      item: El.SOURCES.PLATE.itemCols, part: El.SOURCES.PLATE.partCols,
      components: ["Fxx", "Fyy"] });
    eq(fx.index.Fxx, 3, "a plate's Fxx is its own column");
    const axial = El.resolveColumns(["Elem", "Load", "Part", "Fxx"], {
      item: El.SOURCES.BEAM.itemCols, part: El.SOURCES.BEAM.partCols,
      components: ["Axial"] });
    eq(axial.missing.join(","), "Axial",
      "and \"Fx\" as a synonym for Axial does NOT claim it");
  }

  /* ==================================================================== */
  section("the API base is settled, not assumed");
  {
    /* The failure this exists to stop: the host's redirectTo does not carry the
       program segment, /mapikey/verify sits OUTSIDE that segment so the
       connection check passes, and then EVERY /db/ read answers 404 — which is
       honestly reported as "the plugin used a wrong table key", once per table,
       for the whole model. */
    eq(MapiM.baseCandidates("https://x.com:443/civil").join(" "),
      "https://x.com:443/civil https://x.com:443",
      "a base with the program segment is tried as given first");
    eq(MapiM.baseCandidates("https://x.com:443/").join(" "),
      "https://x.com:443 https://x.com:443/civil",
      "a base without it gets the segment appended as the second candidate");

    const bare = new MapiM.Mapi({ key: "mock-key", base: `http://localhost:${PORT}` });
    /* verify() passes on the WRONG base, which is exactly why it cannot be the
       thing that settles it. */
    const v = await bare.verify();
    eq(v.status, "connected", "verify succeeds even on a base with no program segment");
    const probeBad = await bare.db("ELEM");
    eq(probeBad.status, "absent", "and every table read 404s from there");
    ok(/answered 404/.test(probeBad.reason || ""),
      "the failure carries the URL that was actually requested", probeBad.reason);

    const res = await bare.resolveBase("ELEM");
    eq(res.base, BASE, "resolveBase recovers the working base");
    eq(res.changed, true, "and reports that it had to change it");
    eq(bare.base, BASE, "the client is left pointing at the working base");
    eq((await bare.db("ELEM")).status, "ok", "so the model reads");

    const good = new MapiM.Mapi({ key: "mock-key", base: BASE });
    const res2 = await good.resolveBase("ELEM");
    eq(res2.changed, false, "a base that already works is left alone");

    const nowhere = new MapiM.Mapi({ key: "mock-key", base: `http://localhost:${PORT}/nope` });
    const res3 = await nowhere.resolveBase("ELEM");
    eq(res3.resolved, false, "when nothing answers it says so");
    eq(nowhere.base, `http://localhost:${PORT}/nope`,
      "and keeps the host's own base rather than inventing one");
  }

  /* ==================================================================== */
  section("structure groups are read tolerantly and reported honestly");
  {
    const groups = ctx.model.groups;
    ok(groups.length >= 4, "the model's groups are read", String(groups.length));
    const deck = groups.find((g) => g.name === "Deck");
    eq(deck.elements.length, 12, "a group's element list is read");
    eq(deck.elementKey, "E_LIST", "and the key it came from is recorded");

    /* The key is not worth betting the picker on: a group reading as empty
       because its list arrived under an unexpected name is indistinguishable,
       in the UI, from a group that really is empty. */
    const odd = Model.structureGroups({ status: "ok", rows: {
      1: { NAME: "Alt key", ELIST: [4, 5, 6] },
      2: { NAME: "String list", E_LIST: "7 8 9to11" },
      3: { NAME: "Nodes only", N_LIST: [1, 2], E_LIST: [] },
      4: { NAME: "Unknown shape", MYSTERY: 1 }
    } });
    eq(odd.find((g) => g.name === "Alt key").elements.join(","), "4,5,6",
      "an element list under another name is still found");
    eq(odd.find((g) => g.name === "String list").elements.join(","), "7,8,9,10,11",
      "a list given as text, ranges included, is parsed");
    eq(odd.length, 4, "every group is offered, empty ones included");
    ok(/node\(s\) only/.test(odd.find((g) => g.name === "Nodes only").note),
      "a node-only group says so rather than vanishing");
    ok(/no element list under any name/.test(odd.find((g) => g.name === "Unknown shape").note),
      "and an unrecognised record lists the keys it does carry",
      odd.find((g) => g.name === "Unknown shape").note);
  }

  /* ==================================================================== */
  section("the distribution chart");
  {
    const doc = staticRun.report;
    const spec = ChartM.buildChart(doc, "Moment-y", { width: 900, height: 220 });
    eq(spec.empty, false, "a chart is produced");
    eq(spec.bars.length, doc.rows.length, "one bar per reported row");
    eq(spec.bars.filter((b) => b.isKey).length, 2,
      "the key element's bars are marked (both parts)");
    ok(spec.bars.some((b) => b.isGoverning), "and the governing row is identified");

    /* Bars hang off the zero line in the right direction: this is a signed
       concurrent value, and a chart that drew magnitudes would hide the very
       thing the plugin exists to show. */
    const neg = spec.bars.filter((b) => !b.missing && b.value < 0);
    const pos = spec.bars.filter((b) => !b.missing && b.value > 0);
    ok(neg.length && pos.length, "the fixture has both senses");
    ok(neg.every((b) => Math.abs(b.y - spec.zeroY) < 0.001),
      "negative bars start at the zero line and hang below it");
    ok(pos.every((b) => b.y + b.h <= spec.zeroY + 0.001),
      "positive bars end at the zero line");
    ok(spec.ticks.some((t) => Math.abs(t.value) < 1e-12), "a zero gridline is drawn");

    /* A truss carries no moment. Those cells are ABSENT, not zero, and the
       chart must skip them rather than draw a bar at zero. */
    const mixed = await analyse(ctx, {
      setText: "1, 2, 21, 22", keyElemKey: undefined, keyElemText: "1",
      componentId: "Fx", criterion: "max", position: "both",
      selection: ["ULS_Comb_01"] });
    const trussChart = ChartM.buildChart(mixed.report, "Moment-z", { width: 600, height: 200 });
    ok(trussChart.missing > 0, "rows with no value in that column are counted");
    eq(trussChart.bars.filter((b) => b.missing).length, trussChart.missing,
      "and drawn as nothing rather than as zero");

    eq(ChartM.buildChart(doc, "NoSuchColumn", {}).empty, true,
      "an unknown column produces an empty spec, not a crash");
  }

  /* ==================================================================== */
  section("the plugin can report what the build actually returned");
  {
    /* This session cannot reach a live CIVIL NX, and neither can anyone
       debugging a model on someone else's machine. The probe is how the
       questions no documentation settles get answered: which tokens exist,
       what the columns are called, what the Part column carries. */
    const probes = await Run.probeSources({
      mapi: ctx.mapi, elems: ctx.model.elems, nodes: ctx.model.nodes,
      links: ctx.model.links, elinks: ctx.model.elinks, unit: ctx.mapi.unit,
      units: ctx.mapi.unit
    });
    eq(probes.length, El.SOURCE_ORDER.length, "every source is probed");

    const beam = probes.find((p) => p.source === "BEAM");
    eq(beam.token, "BEAMFORCE", "the token it settled on is recorded");
    ok(beam.head.length > 5, "the HEAD it returned is recorded", beam.head.join(","));
    eq(beam.missing.length, 0, "and which columns were not recognised");
    eq(beam.parts.join(","), "Part I,Part J",
      "the PART TOKENS are recorded — the one thing that decides whether an " +
      "output position filter works at all");
    ok(beam.sample, "with a sample row, so the values can be sanity-checked");
    ok(beam.series.length > 10, "and what the model publishes");

    /* The probe records the tokens it had to try and discard. */
    const link = probes.find((p) => p.source === "GENLINK");
    eq(link.token, "GENERALLINKFORCE", "a probed-past token is resolved");
    ok(link.tried.some((t) => /creating utbl/.test(t.message)),
      "and the ones that failed are recorded with what they said",
      JSON.stringify(link.tried));

    /* A plate's part column carries node numbers, not I and J. */
    const plate = probes.find((p) => p.source === "PLATE");
    ok(plate.parts.every((x) => /^\d+$/.test(x)),
      "a plate's part tokens are node numbers", JSON.stringify(plate.parts));

    /* A node table has no part column at all. */
    const react = probes.find((p) => p.source === "REACTION");
    eq(react.parts, null, "a node source records no part tokens");

    /* A source the model has nothing for says so rather than erroring. */
    const empty = await Run.probeSources({
      mapi: ctx.mapi, elems: {}, nodes: null, links: null, elinks: null,
      units: ctx.mapi.unit });
    ok(empty.every((p) => p.skipped), "an empty model skips every source with a reason");

    /* An unrecognised column name is what the probe exists to surface. */
    mock.state.dropColumn = "Moment-y";
    const gapped = await Run.probeSources({
      mapi: ctx.mapi, elems: ctx.model.elems, nodes: ctx.model.nodes,
      links: ctx.model.links, elinks: ctx.model.elinks, units: ctx.mapi.unit });
    mock.state.dropColumn = null;
    eq(gapped.find((p) => p.source === "BEAM").missing.join(","), "Moment-y",
      "a column this build does not carry is named");

    /* ---- and it renders to something a person can paste back ---------- */
    const text = DiagM.buildDiagnostics({
      version: "1.3.0", base: BASE,
      baseInfo: { tried: [{ base: BASE, status: "ok" }], changed: false, resolved: true },
      model: ctx.model, probes: probes,
      lastError: { message: "something went wrong", hint: "here is why" },
      generated: "2026-01-01T00:00:00Z"
    });
    ok(/BEAMFORCE/.test(text), "the report names the tokens");
    ok(/Part I/.test(text), "and the part tokens");
    ok(/HEAD/.test(text), "and the HEAD");
    ok(/something went wrong/.test(text), "and the last error");
    ok(/bSV_STEP/.test(text), "and which stages saved steps");
    ok(/read from the model/.test(text), "and where the units came from");
    ok(!/undefined/.test(text), "with no undefined leaking into it");
    ok(text.length > 800 && text.length < 40000,
      "at a size a person can paste", String(text.length));
  }

  /* ==================================================================== */
  section("window shell");
  /* STRUCTURAL, because the close button is the most-broken part of a CIVIL NX
     plugin and every one of these failures shipped on a real one. */
  {
    const rootDir = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
    const app = fs.readFileSync(path.join(rootDir, "js", "app.js"), "utf8");

    ok(/id="btn-close"/.test(html), "a close control exists at all");
    ok(/<title>[^<]+<\/title>/.test(html), "document.title is set — the host shows it");

    const drag = /<div id="drag-surface"[\s\S]*?<\/div>\s*<\/div>/.exec(html) ||
                 /<div id="drag-surface"[\s\S]*?<\/div>/.exec(html);
    ok(!!drag, "#drag-surface exists");
    ok(drag && !/id="btn-close"/.test(drag[0]),
      "the close button is NOT inside the drag surface (a drag would start on it)");
    ok(html.indexOf('id="drag-surface"') < html.indexOf('id="btn-close"'),
      "the close button follows the drag surface as a sibling");
    ok(/getElementById\("drag-surface"\)/.test(app),
      "the drag handler is bound to #drag-surface, not to the whole header");

    ok(/function toHost\(/.test(app), "host messages go through one bridge helper");
    ok(/typeof w\.postMessage !== "function"/.test(app),
      "toHost DETECTS a missing bridge rather than relying on a thrown error");
    ok(/did not close/.test(app),
      "an unhonoured REQ_EXIT reports itself — window.close() is a no-op in WebView2");
    ok(/REQ_EXIT/.test(app) && /REQ_WND_MOVE/.test(app), "both host messages are used");
    ok(!/REQ_MOVE"/.test(app), "REQ_MOVE is not sent — the host ignores it");
    ok(/addEventListener\("mousedown"/.test(app), "the drag is from mousedown, not pointerdown");
    ok(/new MessageChannel\(\)/.test(app),
      "yieldToUi uses MessageChannel — setTimeout is clamped to 1s when hidden");
    ok(/function runChunked\(/.test(app) && /runChunked\(doc\.rows/.test(app),
      "and the result table, which scales with the model, is built through it");

    /* Inside CIVIL NX the host supplies the endpoint and the key, so the row
       offering them is hidden by default and shown only when there is no key on
       the query string. A key is a credential and is never rendered. */
    ok(/id="conn-row"[^>]*\shidden/.test(html),
      "the endpoint and key row is hidden by default");
    ok(/\$\("conn-row"\)\.hidden = !!hostKey/.test(app),
      "and is revealed only when the host supplied no key");
    ok(!/key-print/.test(html) && !/key-print/.test(app),
      "the key is not displayed at all, not even as a fingerprint");
    ok(/type="password"/.test(html), "the development key field is masked");

    /* The chart is built from a spec and rendered as NODES. An element label or
       a load name must never be able to become markup. */
    ok(/createElementNS/.test(app), "the chart is built from SVG nodes");
    ok(!/innerHTML/.test(app), "nothing in the wiring assigns innerHTML");
    ok(/chart\.js/.test(html), "the chart module ships");

    /* The run control must not sit in a panel that any option can hide. */
    const foot = /<footer class="run-foot">[\s\S]*?<\/footer>/.exec(html);
    ok(foot && /id="btn-run"/.test(foot[0]),
      "the run control is in the persistent footer, not inside a hideable panel");

    /* Both icons ship, each checked at the size it is actually used. */
    const badge = fs.readFileSync(path.join(rootDir, "icon.svg"), "utf8");
    const glyph = fs.readFileSync(path.join(rootDir, "icon-bar.svg"), "utf8");
    ok(/fill="black"/.test(badge), "the list badge carries the house black tile");
    ok(/data:image\/png;base64,/.test(badge),
      "the list badge EMBEDS the house frame rather than linking it");
    ok(!/fill="black"/.test(glyph), "the dark-bar glyph carries no tile");
    ok(/#BDC2C8/i.test(glyph), "the dark-bar glyph is in the bar's ink colour");
    ok(/icon\.svg/.test(html) && !/icon-bar\.svg"/.test(html),
      "this light header takes the badge, and the bar glyph ships for a dark shell");

    /* No CDN links: a plugin behind a corporate proxy must still render. */
    ok(!/https?:\/\/(?!localhost)[^"']*\.(js|css)/.test(html),
      "nothing is loaded from a CDN");

    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
    ok(manifest.width <= 1280 && manifest.height <= 760, "the window is 1280x760 or smaller");
    ok(html.indexOf("v" + manifest.version) > 0,
      "the version in index.html matches manifest.json");
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
    eq(pkg.version, manifest.version, "and package.json matches too");
    ok(app.indexOf('VERSION = "' + manifest.version + '"') > 0,
      "and the version the diagnostics report prints matches the manifest");
    eq(pkg.type, "commonjs", "the local package.json keeps these files CommonJS");
  }

  /* ==================================================================== */
  section("host query string");
  {
    eq(MapiM.keyFromLocation("?mapiKey=abc&redirectTo=http://x/civil"), "abc",
      "key read from the query string");
    eq(MapiM.baseFromLocation("?redirectTo=http://x/civil/"), "http://x/civil",
      "redirectTo wins, trailing slash trimmed");
    eq(MapiM.baseFromLocation(""), MapiM.DEFAULT_BASE, "falls back to the default base");
  }

  /* ---------------------------------------------------------------------- */
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log("  · " + f)); process.exitCode = 1; }
  mock.server.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  mock.server.close();
});
