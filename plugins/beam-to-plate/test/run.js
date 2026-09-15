/*
 * Beam to Plate — offline regression suite.
 *
 *   node test/run.js
 *
 * The shipped modules run against the mock over REAL HTTP, so the MAPI client,
 * the error semantics and the whole write path are under test rather than
 * stubbed. Nothing here needs CIVIL NX.
 *
 * Two checks carry most of the weight, and neither can pass by accident:
 *
 *   THE AREA GATE. Every section's area is computed by the plugin from the
 *   published vSIZE, and compared against an area the mock states as a literal,
 *   hand-computed from the shape's own formula. Read a dimension list in the
 *   wrong order and it fails.
 *
 *   THE VOLUME INVARIANT. Sum over the generated plates of (area x thickness)
 *   must equal the section area times the member length, for every element. A
 *   wrong local axis, a dropped subdivision or a bad node merge breaks it.
 *
 * If every require() below comes back as an empty object, a PARENT folder's
 * package.json says "type": "module" and the local one saying "commonjs" has
 * gone missing. That is the cause, every time.
 */
const path = require("path");
const fs = require("fs");

const JS = path.join(__dirname, "..", "js");
const MapiM = require(path.join(JS, "mapi.js"));
const Section = require(path.join(JS, "section.js"));
const Mesh = require(path.join(JS, "mesh.js"));
const Plan = require(path.join(JS, "plan.js"));
const Commit = require(path.join(JS, "commit.js"));
const Draw = require(path.join(JS, "draw.js"));
const mock = require(path.join(__dirname, "..", "mock-midas", "server.js"));

const PORT = 8781;

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
const near = (a, b, tol, what) =>
  ok(Math.abs(a - b) <= tol, what, `expected ${b} +/- ${tol}, got ${a}`);
const section = (t) => console.log("\n— " + t);

const OPTS = {
  longSize: 2, transSize: 0.2, minLong: 1, minTrans: 1,
  originRef: "bbox", pipeFacets: 16
};

(async () => {
  await new Promise((r) => mock.server.listen(PORT, r));
  const base = `http://localhost:${PORT}/civil`;
  const mapi = new MapiM.Mapi({ key: "mock-key", base });

  async function planFor(opts, selection) {
    const tables = await Plan.readTables(mapi);
    const all = Plan.beams(tables);
    const selected = Plan.select(all, selection || { mode: "all" });
    const sectIds = [];
    selected.forEach((b) => { if (!sectIds.includes(b.sect)) sectIds.push(b.sect); });
    const o = Object.assign({}, OPTS, opts, {
      existingThik: (tables.THIK && tables.THIK.rows) || {}
    });
    const sections = Plan.studySections(tables.SECT.rows, sectIds, o);
    return { tables, all, selected, sections, opts: o, plan: Plan.buildPlan(selected, sections, o) };
  }

  /* ------------------------------------------------------------ connection */

  section("connection");
  const v = await mapi.verify();
  eq(v.program, "civil", "verify reports the program");

  mock.state.session = "disconnected";
  let threw = null;
  try { await mapi.verify(); } catch (e) { threw = e; }
  ok(threw && /session is disconnected/i.test(threw.message),
     "a valid key with a dead session is refused", threw && threw.message);
  mock.state.session = "connected";

  const thik0 = await mapi.db("THIK");
  eq(thik0.status, "empty", "an unpopulated table is empty, not absent");
  const bogus = await mapi.db("NOSUCHTABLE");
  eq(bogus.status, "absent", "an unknown table key is absent (a plugin bug)");

  /* ------------------------------------------------------------- sections */

  section("sections are read wherever the row keeps them");
  const sectRows = (await mapi.db("SECT")).rows;

  const s1 = Section.readRow("1", sectRows["1"]);
  eq(s1.shape, "H", "vSIZE found under SECT_I");
  eq(s1.published, 0.0361, "the published area is found under SECT_I.STIFF");

  const s2 = Section.readRow("2", sectRows["2"]);
  eq(s2.shape, "B", "vSIZE found under SECT_BEFORE — the path is not assumed");

  section("the area gate is a real check on the dimension order");
  const cases = [
    ["1", "H", 0.0361], ["2", "B", 0.04464], ["3", "P", 0.015468416828112747],
    ["4", "T", 0.011184], ["5", "SB", 0.32], ["9", "C", 0.004368], ["10", "L", 0.001536]
  ];
  cases.forEach(([id, shape, area]) => {
    const st = Section.readRow(id, sectRows[id]);
    const built = Section.buildWalls(st.shape, st.dims, { pipeFacets: 16 });
    eq(st.shape, shape, `section ${id} reads as ${shape}`);
    near(built.area, area, area * 1e-9,
      `section ${id}: the wall model's area equals the published area exactly`);
    eq(Section.gate(built.area, st.published).status, "pass", `section ${id} passes the gate`);
  });

  /* Section 7's vSIZE and its published area genuinely disagree under this
     plugin's reading. This is the case the whole gate exists for. */
  const s7 = Section.readRow("7", sectRows["7"]);
  const b7 = Section.buildWalls(s7.shape, s7.dims, {});
  const g7 = Section.gate(b7.area, s7.published);
  eq(g7.status, "fail", "a dimension list in an unexpected order FAILS the gate");
  ok(g7.err > 0.15, "and the miss is large enough to be unmistakable", String(g7.err));

  /* Dimensions in millimetres against coordinates in metres miss by 10^6. */
  const mm = {};
  Object.keys(s1.dims).forEach((k) => { mm[k] = s1.dims[k] * 1000; });
  const gmm = Section.gate(Section.buildWalls("H", mm, {}).area, s1.published);
  eq(gmm.status, "fail", "a unit mismatch fails the gate too");

  section("sections that cannot be converted are refused, with the reason");
  const s6 = Section.readRow("6", sectRows["6"]);
  eq(s6.ok, false, "a VALUE section is refused");
  ok(/vSIZE is the dialog's Size box|properties only/.test(s6.reason),
     "and the refusal says why rather than guessing a rectangle", s6.reason);

  const s8 = Section.readRow("8", sectRows["8"]);
  eq(s8.ok, false, "a PSC section is refused");
  ok(/OUTER_POLYGON|void/.test(s8.reason), "and names the polygon problem", s8.reason);

  section("a section with no published area reports no gate, never a pass");
  eq(Section.gate(0.5, null).status, "none", "no published area means no gate");
  eq(Section.gate(0.5, 0).status, "none", "a zero published area means no gate");

  /* ----------------------------------------------------------- local axes */

  section("element local axes");
  const axX = Mesh.localAxes([0, 0, 0], [10, 0, 0], 0);
  eq(axX.ey.join(","), "0,1,0", "a beam along +X has local y along +Y");
  eq(axX.ez.join(","), "0,0,1", "and local z up");

  const axV = Mesh.localAxes([0, 0, 0], [0, 0, 6], 0);
  near(axV.ez[0], 1, 1e-12, "a vertical member takes local z along global X");
  near(axV.ey[1], -1, 1e-12, "and local y along -Y, completing the right-handed set");

  const ax90 = Mesh.localAxes([0, 0, 0], [10, 0, 0], 90);
  near(ax90.ez[1], -1, 1e-12, "beta = 90 rotates local z onto -Y");
  near(ax90.ey[2], 1, 1e-12, "and local y onto +Z");

  section("the node pool merges what should be merged");
  const pool = new Mesh.NodePool(1e-4);
  eq(pool.add([1, 2, 3]), 0, "a first point is index 0");
  eq(pool.add([1, 2, 3]), 0, "the same point again is the same index");
  eq(pool.add([1 + 5e-5, 2, 3]), 0, "a point within tolerance merges");
  eq(pool.add([1 + 5e-3, 2, 3]), 1, "a point outside tolerance does not");
  eq(pool.find([9, 9, 9]), -1, "find() does not insert");
  eq(pool.list.length, 2, "and leaves the pool untouched");

  /* ----------------------------------------------------------------- mesh */

  section("the volume invariant holds for every element");
  const P = await planFor();
  const converted = P.plan.elements.filter((e) => e.ok);
  eq(converted.length, 8, "eight of the model's beams convert");
  converted.forEach((e) => {
    ok(Math.abs(e.stats.error) < 1e-9,
      `element ${e.id}: plate volume equals section area x length`,
      `out by ${(e.stats.error * 100).toFixed(6)}%`);
  });
  ok(P.plan.totals.worstError < 1e-9, "so the plan's worst-case volume error is nil");

  section("what cannot be converted is reported, not silently dropped");
  const problems = Plan.problems(P.plan, P.all, P.selected);
  const reasons = problems.map((p) => p.reason).join(" | ");
  ok(/not a beam element \(PLATE\)/.test(reasons), "an existing plate is skipped as not a beam", reasons);
  ok(/not a beam element \(TRUSS\)/.test(reasons), "so is a truss", reasons);
  ok(/area check/.test(reasons), "the beam on the gate-failing section is not converted", reasons);
  ok(P.plan.elements.some((e) => e.id === "108" && !e.ok),
     "and that beam is element 108");
  ok(P.plan.elements.some((e) => e.id === "107" && !e.ok),
     "the VALUE-section beam is not converted either");

  section("plates are well formed");
  ok(P.plan.plates.every((q) => new Set(q.nodes).size === 4),
     "every plate has four distinct nodes");
  ok(P.plan.plates.every((q) => q.t > 0), "every plate has a thickness");
  ok(P.plan.plates.some((q) => q.matl === 2),
     "a plate carries its source beam's material, not a default");

  section("beams that meet share their end section");
  const two = await planFor({}, { mode: "ids", ids: { 101: true, 102: true } });
  const one = await planFor({}, { mode: "ids", ids: { 101: true } });
  ok(two.plan.totals.nodes < 2 * one.plan.totals.nodes,
     "two beams in line share a station rather than doubling the nodes",
     `${two.plan.totals.nodes} vs ${2 * one.plan.totals.nodes}`);
  eq(two.plan.totals.nodes, 2 * one.plan.totals.nodes - (one.plan.totals.nodes /
     one.plan.elements[0].stats.stations),
     "exactly one station's worth of nodes is shared");

  section("mesh density follows the requested sizes");
  const coarse = await planFor({ longSize: 10, transSize: 10 },
    { mode: "ids", ids: { 101: true } });
  const fine = await planFor({ longSize: 1, transSize: 0.1 },
    { mode: "ids", ids: { 101: true } });
  ok(fine.plan.totals.plates > coarse.plan.totals.plates * 10,
     "a finer mesh makes many more plates",
     `${fine.plan.totals.plates} vs ${coarse.plan.totals.plates}`);
  ok(Math.abs(coarse.plan.totals.worstError) < 1e-9,
     "and the coarse mesh still satisfies the volume invariant");

  section("the estimate matches what gets built");
  const est = Plan.estimate(P.selected, P.sections, P.opts);
  eq(est.plates, P.plan.totals.plates, "the plate estimate is exact, so it can be a limit");
  ok(est.nodes >= P.plan.totals.nodes, "the node estimate is an upper bound");

  section("thicknesses are collected by value");
  const ts = P.plan.thicknesses;
  ok(ts.every((t) => t.name.length <= 16), "every generated name fits the tightest cap");
  ok(ts.every((t, i) => i === 0 || ts[i - 1].t < t.t), "thicknesses are distinct and sorted");
  const reuse = Plan.collectThicknesses([{ t: 0.025 }], { "4": { T_IN: 0.025, NAME: "PL25" } });
  eq(reuse[0].reuseId, "4", "an existing thickness of the same value is reused, not duplicated");

  /* ----------------------------------------------------------- selections */

  section("element id selection");
  eq(Plan.parseIds("101-103, 205").count, 4, "a range and a single id");
  eq(Plan.parseIds("101, deck").bad[0], "deck", "a token that is not an id is REPORTED");
  eq(Plan.parseIds("110-101").bad[0], "110-101", "a backwards range is reported too");

  const bySect = await planFor({}, { mode: "sect", sects: ["3"] });
  eq(bySect.plan.totals.converted, 1, "selecting one section converts one beam");

  /* --------------------------------------------------------- safety rails */

  section("safety rails");
  eq(MapiM.ALLOWED_POST.join(","), "/view/CAPTURE",
     "the only POST this plugin may make is the screenshot");
  let wl = null;
  try { await mapi.put("SECT", { 1: {} }); } catch (e) { wl = e; }
  ok(wl && /not permitted to write/.test(wl.message), "writing an unlisted table is refused");

  let dl = null;
  try { await mapi.delRow("NODE", 1); } catch (e) { dl = e; }
  ok(dl && /not permitted to delete/.test(dl.message), "deleting from an unlisted table is refused");

  let bare = null;
  try { await mapi.delRow("ELEM", ""); } catch (e) { bare = e; }
  ok(bare && /numeric id/.test(bare.message),
     "a delete without an id is refused — the bare path empties the whole table");
  ok(typeof mapi.del !== "function", "there is no whole-table delete on the client at all");

  const client = fs.readFileSync(path.join(JS, "mapi.js"), "utf8");
  ok(/delete body\.Argument\.EXPORT_PATH/.test(client),
     "EXPORT_PATH is stripped in the client, not at the call sites");

  /* -------------------------------------------------------------- writing */

  section("committing writes what the plan described");
  mock.reset();
  const W = await planFor({}, { mode: "ids", ids: { 101: true } });
  const sources = W.selected.filter((b) =>
    W.plan.elements.some((e) => e.id === b.id && e.ok));
  const report = await Commit.commit(mapi, {
    plan: W.plan, sources, groupName: "B2P mesh", reuseExisting: false, mergeTol: 1e-4
  }, {});

  eq(report.plates, W.plan.totals.plates, "every planned plate was written");
  eq(report.verified, W.plan.totals.plates, "and every one was found in /db/ELEM afterwards");
  eq(report.warnings.length, 0, "with no warnings");
  eq(report.group, "B2P mesh", "the structure group was written");

  const afterNodes = (await mapi.db("NODE")).rows;
  const afterElems = (await mapi.db("ELEM")).rows;
  const afterThik = (await mapi.db("THIK")).rows;
  eq(Object.keys(afterNodes).length, 27 + report.nodesWritten, "the nodes landed");
  const newPlates = Object.keys(afterElems).filter((id) => Number(id) > 113);
  eq(newPlates.length, W.plan.totals.plates, "the plates landed");
  ok(newPlates.every((id) => afterElems[id].TYPE === "PLATE"), "as PLATE elements");
  ok(newPlates.every((id) => afterElems[id].STYPE === 3), "thick plates");
  ok(newPlates.every((id) => String(afterElems[id].SECT) in afterThik),
     "and each one's SECT resolves to a THIK record — that is how a plate carries " +
     "its thickness");

  section("ids are read back, never assumed");
  /* The mock lands new records somewhere other than the numbers that were sent.
     A plugin that trusted the id it wrote would now build plates on the wrong
     nodes — and the volume check below would not notice, because the plates
     would still be plates. Only the coordinates tell the truth. */
  mock.reset();
  mock.state.shiftNewIds = 7;
  const W2 = await planFor({}, { mode: "ids", ids: { 106: true } });
  const src2 = W2.selected.filter((b) => W2.plan.elements.some((e) => e.id === b.id && e.ok));
  const r2 = await Commit.commit(mapi, {
    plan: W2.plan, sources: src2, groupName: "", reuseExisting: false, mergeTol: 1e-4
  }, {});
  eq(r2.verified, W2.plan.totals.plates, "every plate is still found after an id shift");

  const nodes2 = (await mapi.db("NODE")).rows;
  const elems2 = (await mapi.db("ELEM")).rows;
  const wrote = Object.keys(elems2).filter((id) => Number(id) > 113);
  let coordsRight = true;
  wrote.forEach((id) => {
    const ns = elems2[id].NODE.filter((n) => Number(n) > 0);
    ns.forEach((n) => { if (!nodes2[String(n)]) coordsRight = false; });
  });
  ok(coordsRight, "and every plate references a node that exists");
  /* The mesh of beam 106 lies in the plane y = 20; if the ids had been assumed
     rather than read back, the plates would reference the original frame's
     nodes, which do not. */
  const planeOk = wrote.every((id) => elems2[id].NODE.filter((n) => Number(n) > 0)
    .every((n) => Math.abs(nodes2[String(n)].Y - 20) < 1e-9));
  ok(planeOk, "and sits in the plane of the beam it came from");
  mock.state.shiftNewIds = 0;

  section("existing nodes can be reused rather than duplicated");
  mock.reset();
  const W3 = await planFor({ transSize: 0.2 }, { mode: "ids", ids: { 106: true } });
  const src3 = W3.selected.filter((b) => W3.plan.elements.some((e) => e.id === b.id && e.ok));
  const r3 = await Commit.commit(mapi, {
    plan: W3.plan, sources: src3, groupName: "", reuseExisting: true, mergeTol: 1e-4
  }, {});
  ok(r3.nodesReused >= 2,
     "the beam's own end nodes are reused where the mesh passes through them",
     String(r3.nodesReused));
  eq(r3.nodesWritten + r3.nodesReused, W3.plan.totals.nodes,
     "written plus reused accounts for every node in the plan");

  section("a model that changed under the plan aborts the write");
  mock.reset();
  const W4 = await planFor({}, { mode: "ids", ids: { 101: true } });
  const src4 = W4.selected.filter((b) => W4.plan.elements.some((e) => e.id === b.id && e.ok));
  mock.TABLES.ELEM["101"].SECT = 4;             /* the user swapped the section */
  let driftErr = null;
  try {
    await Commit.commit(mapi, { plan: W4.plan, sources: src4, groupName: "",
      reuseExisting: false, mergeTol: 1e-4 }, {});
  } catch (e) { driftErr = e; }
  ok(driftErr && /changed since the plan/.test(driftErr.message),
     "the commit refuses", driftErr && driftErr.message);
  ok(driftErr && /section changed/.test(driftErr.message), "and says what changed");
  eq(Object.keys((await mapi.db("THIK")).rows || {}).length, 0,
     "and nothing at all was written first");
  mock.TABLES.ELEM["101"].SECT = 1;

  section("deleting the source beams is opt-in and does what it says");
  mock.reset();
  const W5 = await planFor({}, { mode: "ids", ids: { 101: true } });
  const src5 = W5.selected.filter((b) => W5.plan.elements.some((e) => e.id === b.id && e.ok));
  const r5 = await Commit.commit(mapi, { plan: W5.plan, sources: src5, groupName: "",
    reuseExisting: true, deleteSources: true, mergeTol: 1e-4 }, {});
  eq(r5.deleted, 1, "the source beam was deleted");
  ok(!(await mapi.db("ELEM")).rows["101"], "and is gone from /db/ELEM");
  mock.reset();
  mock.TABLES.ELEM["101"] = { TYPE: "BEAM", MATL: 1, SECT: 1,
    NODE: [1, 2, 0, 0, 0, 0, 0, 0], ANGLE: 0 };

  /* --------------------------------------------------------------- drawing */

  section("the drawings");
  const svg = Draw.sectionSvg(P.sections["1"].model, {});
  ok(/<svg/.test(svg) && /<polygon/.test(svg), "a section draws as filled walls");
  ok(/no geometry/.test(Draw.sectionSvg(null, {})), "and an absent model says so");
  const mesh = Draw.meshSvg(P.plan.pool, P.plan.plates, { cap: 50 });
  ok(/showing 1 plate in/.test(mesh),
     "a large mesh is sampled rather than drawn whole — it runs on the UI thread");

  /* ---------------------------------------------------------- window shell */

  section("window shell");
  /* STRUCTURAL, because the close button is the most-broken part of a CIVIL NX
     plugin and every one of these failures shipped on a real one. */
  {
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const app = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");

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
    ok(/function runChunked\(/.test(app), "a chunking helper exists");
    ok(/MAX_PLATES/.test(app),
       "and a hard ceiling stops a huge selection blocking the UI thread instead");

    /* The run controls must not be inside a panel that an option can hide. */
    const runPanel = /<section class="panel run">[\s\S]*?<\/section>/.exec(html);
    ok(runPanel && /id="btn-commit"/.test(runPanel[0]),
       "the Write button lives in the always-visible run panel");

    ok(fs.existsSync(path.join(root, "icon.svg")), "the plugin-list badge exists");
    ok(fs.existsSync(path.join(root, "icon-bar.svg")), "the dark-bar glyph exists");
    const badge = fs.readFileSync(path.join(root, "icon.svg"), "utf8");
    ok(/data:image\/png;base64,/.test(badge),
       "the list badge embeds the house frame rather than linking it");

    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    ok(manifest.width <= 1280 && manifest.height <= 760, "the window is 1280x760 or smaller");
    ok(new RegExp(manifest.version.replace(/\./g, "\\.")).test(html),
       "the version in index.html matches manifest.json");
    ok(!/https?:\/\/(?!localhost)/.test(html.replace(/<!--[\s\S]*?-->/g, "")),
       "no CDN links — everything is vendored");
    /* The word appears in app.js's own comment explaining why it must not; the
       check is for an actual call. */
    ok(!/localStorage\s*\./.test(app),
       "the model is never cached in localStorage; only the theme uses it");
  }

  section("host query string");
  eq(MapiM.keyFromLocation("?mapiKey=abc&redirectTo=http://x/civil"), "abc",
     "key read from the query string");
  eq(MapiM.baseFromLocation("?redirectTo=http://x/civil/"), "http://x/civil",
     "redirectTo wins, trailing slash trimmed");
  eq(MapiM.baseFromLocation(""), MapiM.DEFAULT_BASE, "falls back to the default base");

  /* ---------------------------------------------------------------------- */
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log("  · " + f)); process.exitCode = 1; }
  mock.server.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  mock.server.close();
});
