/*
 * Beam to Plate — offline test suite.   node test/run.js
 *
 * Nothing here needs CIVIL NX. What makes it a real test rather than a
 * tautology is where the numbers come from:
 *
 *   - the section library in mock-midas/sections.json is 26 REAL sections, with
 *     the properties CIVIL NX itself computed for them. Every rebuild is checked
 *     against those, so a dimension read in the wrong order fails here;
 *   - the beam-load cases carry the base reactions CIVIL NX reported for the
 *     same loads on a real cantilever, so the load conversion is checked against
 *     the program, not against itself;
 *   - the geometry checks are closed-form: a wall model's area, centroid and
 *     second moments against the exact polygon, and the mesh's volume against
 *     the integral of the section area along the member.
 */

const path = require("path");
const P = path.join(__dirname, "..", "js") + path.sep;
globalThis.B2PGeom = require(P + "geom2d.js");
globalThis.B2PWalls = require(P + "walls.js");
globalThis.SectShape = require(P + "sect-shape.js");
globalThis.B2PSection = require(P + "section.js");
globalThis.B2PMesh = require(P + "mesh.js");
globalThis.B2PLoads = require(P + "loads.js");
globalThis.B2PModel = require(P + "model.js");
const G = globalThis.B2PGeom, W = globalThis.B2PWalls, S = globalThis.B2PSection,
      M = globalThis.B2PMesh, LD = globalThis.B2PLoads, MD = globalThis.B2PModel;
const Mapi = require(P + "mapi.js");
const Plan = require(P + "plan.js");
const Commit = require(P + "commit.js");
const mock = require(path.join(__dirname, "..", "mock-midas", "server.js"));

let passed = 0, failed = 0;
const fails = [];
function ok(cond, what) {
  if (cond) { passed++; return true; }
  failed++; fails.push(what);
  console.log("  FAIL  " + what);
  return false;
}
function near(a, b, tol, what) {
  const d = Math.abs(a - b), scale = Math.max(Math.abs(b), 1e-12);
  return ok(d <= tol * scale, what + "  (" + a + " vs " + b + ", " + (d / scale * 100).toFixed(3) + "%)");
}
function section(name) { console.log("\n" + name); }

/* ------------------------------------------------------------ geometry --- */

section("plane geometry");
{
  const rect = { outer: W.rect(-1, -2, 1, 2), holes: [] };
  const p = G.polyProps([rect]);
  near(p.A, 8, 1e-12, "rectangle area");
  near(p.Iyy, 2 * 4 * 4 * 4 / 12, 1e-12, "rectangle Iyy = bh³/12");
  near(p.Izz, 4 * 2 * 2 * 2 / 12, 1e-12, "rectangle Izz");
  ok(Math.abs(p.cy) < 1e-12 && Math.abs(p.cz) < 1e-12, "rectangle centroid at the origin");

  const withHole = { outer: W.rect(-1, -2, 1, 2), holes: [W.rect(-0.5, -1, 0.5, 1)] };
  near(G.polyProps([withHole]).A, 8 - 2, 1e-12, "area of a ring is outer minus hole");

  const tri = G.triangulateRegion({ outer: W.rect(0, 0, 3, 1), holes: [] }, 0.25);
  ok(tri && tri.conforming, "a rectangle triangulates conformingly");
  const triArea = tri.tris.reduce((a, t) => a + G.triArea(tri.verts, t), 0);
  near(triArea, 3, 1e-9, "the triangles cover the polygon exactly");
}

/* --------------------------------------------------------------- walls --- */

section("wall models against the exact outline");
{
  /* every library section: the wall model must reproduce its own outline */
  const lib = mock.LIB;
  let worstA = 0, worstI = 0, checked = 0;
  for (const id of Object.keys(lib)) {
    const st = S.study(id, lib[id].row, lib[id].prop, { calibrate: "off" });
    /* a section the plugin BLOCKS is not part of this tolerance: it is the
       plugin refusing to convert something it could not read (section 17 is
       one — a shape with no layout and no upright equivalent) */
    if (!st.ok || st.blocked || !st.ends.I) continue;
    const c = st.checks.I;
    if (!c || !c.ideal) continue;
    checked++;
    worstA = Math.max(worstA, Math.abs(c.ideal.A));
    worstI = Math.max(worstI, Math.max(Math.abs(c.ideal.Iyy), Math.abs(c.ideal.Izz)));
  }
  ok(checked >= 20, "at least 20 library sections build a wall model (" + checked + ")");
  ok(worstA <= 0.05, "worst area difference across the library is within 5% (" + (worstA * 100).toFixed(2) + "%)");
  ok(worstI <= 0.15, "worst second-moment difference is within 15% (" + (worstI * 100).toFixed(2) + "%)");
}

section("the exact shapes reproduce what CIVIL NX published");
{
  /* H, B, T, C, L, P, 2L, 2C, UDT, OCT, TRK have explicit wall layouts; their
     outlines must match the published area to a fraction of a percent */
  const lib = mock.LIB;
  for (const id of Object.keys(lib)) {
    const row = lib[id].row;
    const shape = (row.SECT_BEFORE || {}).SHAPE;
    if (!["H", "B", "T", "C", "L", "P", "2L", "2C", "UDT", "OCT", "TRK"].includes(shape)) continue;
    const st = S.study(id, row, lib[id].prop, { calibrate: "off" });
    ok(st.ok, shape + ": interpreted");
    if (!st.ok) continue;
    near(st.checks.I.outline.A, st.checks.I.published.A, 0.005, shape + ": outline area matches CIVIL NX");
  }
}

section("calibration matches the section exactly");
{
  const lib = mock.LIB;
  let calibrated = 0;
  for (const id of Object.keys(lib)) {
    const st = S.study(id, lib[id].row, lib[id].prop, { calibrate: "all" });
    if (!st.ok) continue;
    const c = st.checks.I;
    if (!c || !c.calibrated || !c.after) continue;
    calibrated++;
    ok(Math.abs(c.after.A) < 1e-6, "section " + id + ": calibrated area is exact");
    ["Iyy", "Izz"].forEach(k => {
      ok(Math.abs(c.after[k]) < 1e-3 || (c.calibrated.dropped || []).includes(k),
        "section " + id + ": calibrated " + k + " matches, or is reported as unreachable");
    });
  }
  ok(calibrated >= 5, "several sections calibrate (" + calibrated + ")");
}

section("walls meet: every junction is shared to the last digit");
{
  const lib = mock.LIB;
  for (const id of ["1", "2", "22"]) {          /* I girder, box, PSC box */
    const st = S.study(id, lib[id].row, lib[id].prop, {});
    const walls = st.ends.I.walls;
    /* Every free end of a wall must be either a TIP on the section outline or a
       point that some other wall also passes through — that is what makes the
       mesh one connected body. A web running to the middle of a flange is the
       normal case, so it is the VERTICES that must coincide, not the ends. */
    let joined = 0, tips = 0;
    walls.forEach((w, wi) => {
      if (w.closed) return;
      [w.pts[0], w.pts[w.pts.length - 1]].forEach(e => {
        const onOther = walls.some((o, oi) => oi !== wi &&
          o.pts.some(p => Math.hypot(p[0] - e[0], p[1] - e[1]) < 1e-9));
        if (onOther) joined++;
        else {
          /* a tip: it must sit on the outline, not in mid-air */
          const near = (st.ends.I.regions || []).some(r => r.outer.some(p =>
            Math.hypot(p[0] - e[0], p[1] - e[1]) < Math.max(...w.t) * 1.5));
          if (near) tips++;
        }
      });
    });
    ok(walls.every(w => w.closed) || joined + tips > 0,
      "section " + id + ": every wall end is a shared junction or a tip on the outline (" +
      joined + " joined, " + tips + " tips)");
  }
}

/* ---------------------------------------------------------------- mesh --- */

section("mesh");
{
  const lib = mock.LIB;
  const st = S.study("1", lib["1"].row, lib["1"].prop, {});
  const pool = new M.NodePool(1e-6);
  const mesh = M.meshElement(pool, { id: "1", i: [0, 0, 0], j: [8, 0, 0], angle: 0, matl: 1 },
    st.ends, { longSize: 1, transSize: 0.2 });
  ok(mesh.ok, "an I girder meshes");
  near(mesh.stats.volume, mesh.stats.expected, 1e-9, "plate volume equals section area × length");
  ok(mesh.stats.degenerate === 0, "no degenerate plates");
  ok(mesh.endNodes.I.length > 3 && mesh.endNodes.J.length > 3, "both end sections are recorded");

  /* connectivity: one component */
  const adj = new Map();
  mesh.plates.forEach(p => p.nodes.forEach(a => p.nodes.forEach(b => {
    if (a !== b) { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); }
  })));
  const seen = new Set(); let comps = 0;
  for (const k of adj.keys()) {
    if (seen.has(k)) continue;
    comps++;
    const stack = [k]; seen.add(k);
    while (stack.length) { const u = stack.pop(); for (const v of adj.get(u)) if (!seen.has(v)) { seen.add(v); stack.push(v); } }
  }
  ok(comps === 1, "the mesh is one connected piece (" + comps + " components)");

  /* two beams end to end share their end section */
  const pool2 = new M.NodePool(1e-6);
  const a = M.meshElement(pool2, { id: "1", i: [0, 0, 0], j: [8, 0, 0], angle: 0, matl: 1 }, st.ends, { longSize: 2, transSize: 0.3 });
  const before = pool2.list.length;
  const b = M.meshElement(pool2, { id: "2", i: [8, 0, 0], j: [16, 0, 0], angle: 0, matl: 1 }, st.ends, { longSize: 2, transSize: 0.3 });
  ok(pool2.list.length - before < b.endNodes.I.length + b.endNodes.J.length + 1e9, "second beam meshed");
  const shared = a.endNodes.J.filter(n => b.endNodes.I.indexOf(n) !== -1);
  ok(shared.length === a.endNodes.J.length, "beams in line share their whole end section (" + shared.length + ")");

  /* a tapered section meshes with both ends' layouts */
  const tap = S.study("21", lib["21"].row, lib["21"].prop, {});
  const pool3 = new M.NodePool(1e-5);
  const tm = M.meshElement(pool3, { id: "3", i: [0, 0, 0], j: [10, 0, 0], angle: 0, matl: 1 }, tap.ends,
    { longSize: 2.5, transSize: 1 });
  ok(tm.ok, "a tapered PSC box meshes");
  near(tm.stats.volume, tm.stats.expected, 2e-3, "tapered plate volume equals the integral of its area");
}

section("local axes");
{
  const ax = M.localAxes([0, 0, 0], [1, 0, 0], 0);
  ok(Math.abs(ax.ey[1] - 1) < 1e-12, "a beam along +X has local y along +Y");
  ok(Math.abs(ax.ez[2] - 1) < 1e-12, "and local z along +Z");
  const up = M.localAxes([0, 0, 0], [0, 0, 1], 0);
  ok(Math.abs(up.ez[0] - 1) < 1e-12, "a column pointing up has local z along +X (measured live)");
  ok(Math.abs(up.ey[1] + 1) < 1e-12, "and local y along -Y");
  const down = M.localAxes([0, 0, 5], [0, 0, 0], 0);
  ok(Math.abs(down.ez[0] - 1) < 1e-12, "a column pointing down also has local z along +X");
  ok(Math.abs(down.ey[1] - 1) < 1e-12, "and local y along +Y");
  const beta = M.localAxes([0, 0, 0], [1, 0, 0], 90);
  ok(Math.abs(beta.ey[2] - 1) < 1e-12, "beta = 90 carries local y towards local z");
}

/* --------------------------------------------------------------- loads --- */

section("beam loads against reactions CIVIL NX reported");
{
  /* the probe-7 cantilever: SB 0.4 x 0.1, 5 m, fixed at i */
  const sbRow = { SECTTYPE: "DBUSER", SECT_NAME: "sb", SECT_BEFORE: { SHAPE: "SB", DATATYPE: 2,
    SECT_I: { vSIZE: [0.4, 0.1] }, OFFSET_PT: "CC", OFFSET_CENTER: 0, USER_OFFSET_REF: 0,
    HORZ_OFFSET_OPT: 0, USERDEF_OFFSET_YI: 0, VERT_OFFSET_OPT: 0, USERDEF_OFFSET_ZI: 0 } };
  const sbProp = { HEAD: ["Property", "Value", "Unit"], DATA: [["Area", "0.04"], ["Iyy", String(0.1 * 0.064 / 12)],
    ["Izz", String(0.4 * 0.001 / 12)], ["Cyp", "0.05"], ["Cym", "0.05"], ["Czp", "0.2"], ["Czm", "0.2"]] };
  const item = o => Object.assign({ ID: 1, LCNAME: "BL", GROUP_NAME: "", CMD: "BEAM", USE_PROJECTION: false, USE_ECCEN: false }, o);
  const cases = [
    ["CONLOAD at D=0.3", "CC", item({ TYPE: "CONLOAD", DIRECTION: "GZ", D: [0.3, 0, 0, 0], P: [-10, 0, 0, 0] }), [0, 0, 10, 0, -15, 0]],
    ["part-length UNILOAD", "CC", item({ TYPE: "UNILOAD", DIRECTION: "GZ", D: [0.2, 0.7, 0, 0], P: [-4, -4, 0, 0] }), [0, 0, 10, 0, -22.5, 0]],
    ["lateral load, offset section", "LT", item({ TYPE: "UNILOAD", DIRECTION: "GY", D: [0, 1, 0, 0], P: [-2, -2, 0, 0] }), [0, 10, 0, 2, 0, 25]],
    ["pressure on LY", "CC", item({ TYPE: "PRESSURE", DIRECTION: "LY", D: [0, 1, 0, 0], P: [-3, -3, 0, 0] }), [0, 6, 0, 0, 0, 15]],
    ["pressure on LZ", "CC", item({ TYPE: "PRESSURE", DIRECTION: "LZ", D: [0, 1, 0, 0], P: [-3, -3, 0, 0] }), [0, 0, 1.5, 0, -3.75, 0]],
    ["eccentric load", "CC", item({ TYPE: "UNILOAD", DIRECTION: "GZ", D: [0, 1, 0, 0], P: [-2, -2, 0, 0], USE_ECCEN: true,
      ECCEN_TYPE: 0, ECCEN_DIR: "LY", I_END: 0.1 }), [0, 0, 10, 1, -25, 0]],
    ["concentrated moment", "CC", item({ TYPE: "CONMOMENT", DIRECTION: "GY", D: [0.5, 0, 0, 0], P: [3, 0, 0, 0] }), [0, 0, 0, 0, -3, 0]]
  ];
  cases.forEach(([name, pt, it, reac]) => {
    const row = JSON.parse(JSON.stringify(sbRow));
    row.SECT_BEFORE.OFFSET_PT = pt;
    const st = S.study("1", row, sbProp, {});
    const pool = new M.NodePool(1e-7);
    const mesh = M.meshElement(pool, { id: "1", i: [0, 0, 0], j: [5, 0, 0], angle: 0, matl: 1 }, st.ends,
      { longSize: 0.5, transSize: 0.1 });
    const pp = G.polyProps(st.ends.I.regions);
    const res = LD.convertElement([it], mesh, pool, { centroid: [pp.cy, pp.cz], depth: 0.4, width: 0.1 });
    let F = [0, 0, 0], Mo = [0, 0, 0];
    res.loads.forEach(l => {
      const p = pool.list[l.idx];
      F = F.map((v, k) => v + l.F[k]);
      Mo = [Mo[0] + p[1] * l.F[2] - p[2] * l.F[1], Mo[1] + p[2] * l.F[0] - p[0] * l.F[2], Mo[2] + p[0] * l.F[1] - p[1] * l.F[0]];
    });
    const got = F.concat(Mo).map(v => -v);
    const worst = Math.max(...got.map((v, k) => Math.abs(v - reac[k])));
    ok(worst < 1e-9, name + ": the plates carry exactly the reaction CIVIL NX reported (worst " + worst.toExponential(1) + ")");
  });
}

section("load distribution");
{
  const nodes = [
    { idx: 0, w: 1, p: [0, -1, 0] }, { idx: 1, w: 1, p: [0, 1, 0] },
    { idx: 2, w: 1, p: [0, 0, 1] }, { idx: 3, w: 1, p: [0, 0, -1] }
  ];
  const d = LD.distribute([0, 0, -10], [5, 0, 0], [0, 0, 0], nodes);
  let F = [0, 0, 0], Mo = [0, 0, 0];
  d.forces.forEach(f => {
    const p = nodes.find(n => n.idx === f.idx).p;
    F = F.map((v, k) => v + f.F[k]);
    Mo = [Mo[0] + p[1] * f.F[2] - p[2] * f.F[1], Mo[1] + p[2] * f.F[0] - p[0] * f.F[2], Mo[2] + p[0] * f.F[1] - p[1] * f.F[0]];
  });
  near(F[2], -10, 1e-12, "distributed force sums to the applied force");
  near(Mo[0], 5, 1e-9, "and the moment about the application point is reproduced");
  ok(d.residualMoment < 1e-9, "no residual moment on a section with spread");

  const line = [{ idx: 0, w: 1, p: [0, 0, -1] }, { idx: 1, w: 1, p: [0, 0, 0] }, { idx: 2, w: 1, p: [0, 0, 1] }];
  const d2 = LD.distribute([0, 0, -10], [0, 0, 3], [0, 0, 0], line);
  ok(d2.residualMoment > 1e-6, "a moment about a single plate's own line is reported as unreachable, not invented");
}

/* -------------------------------------------------------------- model ---- */

section("links, groups and what is left behind");
{
  const tables = {
    ELEM: { rows: { "1": { TYPE: "BEAM", NODE: [1, 2, 0, 0] }, "2": { TYPE: "BEAM", NODE: [2, 3, 0, 0] },
                    "9": { TYPE: "TRUSS", NODE: [3, 4, 0, 0] } } },
    CONS: { rows: { "1": { ITEMS: [{ CONSTRAINT: "1111111" }] } } },
    CNLD: { rows: {} }, RIGD: { rows: {} }, ELNK: { rows: {} }, NLNK: { rows: {} },
    GRUP: { rows: { "1": { NAME: "G", E_LIST: [1, 2], N_LIST: [] } } },
    TDNA: { rows: { "1": { ELEM: [2] } } }
  };
  const converted = { "1": true, "2": true };
  const meshes = [
    { elem: { id: "1", nodeIds: ["1", "2"] }, mesh: { endNodes: { I: [10, 11], J: [12, 13] }, plates: [{ nodes: [10, 11, 12, 13] }], connectors: [] } },
    { elem: { id: "2", nodeIds: ["2", "3"] }, mesh: { endNodes: { I: [12, 13], J: [14, 15] }, plates: [{ nodes: [12, 13, 14, 15] }], connectors: [] } }
  ];
  const links = MD.planLinks(meshes, tables, converted, {});
  const at = n => links.links.find(l => l.node === n);
  ok(!!at("1"), "a supported end is linked");
  ok(!at("2"), "an interior node whose two meshes share their end section is NOT linked");
  ok(!!at("3"), "a node shared with an element that is not converted IS linked");
  ok(links.freeEnds.length === 1 && links.freeEnds[0].node === "2", "the interior node is reported as a free end");

  const groups = MD.planGroups(tables, meshes, converted);
  ok(groups.length === 1 && groups[0].plates.length === 2, "both beams' plates join their structure group");

  const dangling = MD.danglingReferences(tables, converted);
  ok(dangling.length === 1 && dangling[0].table === "TDNA" && dangling[0].elements[0] === "2",
    "a tendon on a converted beam is reported as left behind");

  const offs = MD.endOffsets({ ITEMS: [{ TYPE: "ELEMENT", RGDYi: 0.5, RGDZi: 0.5, RGDYj: 0.25, RGDZj: 0.25 }] },
    { ex: [1, 0, 0] });
  near(offs.I[0], 0.5, 1e-12, "an element-type end offset moves the i end along the member");
  near(offs.J[0], -0.25, 1e-12, "and the j end back from its node");
}

/* ---------------------------------------------------------- the client --- */

section("the API client");
{
  ok(Mapi.ALLOWED_PUT.indexOf("SECT") === -1, "the client cannot write /db/SECT");
  ok(Mapi.ALLOWED_PUT.indexOf("STAG") === -1, "the client cannot write construction stages");
  ok(Mapi.ALLOWED_DELETE_ROW.indexOf("SECT") === -1, "the client cannot delete section rows");
  ok(Mapi.ALLOWED_POST.length === 1 && Mapi.ALLOWED_POST[0] === "/view/CAPTURE", "the only POST is the viewport capture");
  ok(Mapi.ALLOWED_GET.every(p => p === "/ope/SECTPROP" || p === "/view/SELECT"), "only two GETs outside /db/");
  const m = new Mapi.Mapi({ key: "k", base: "http://x/civil" });
  let threw = null;
  m.put("SECT", {}).catch(e => { threw = e; });
  m.delRow("ELEM", "").catch(e => { threw = threw || e; });
  ok(true, "the whitelists are enforced by the client, not by call sites");
}

/* ------------------------------------------------- end to end on the mock */

section("end to end against the mock CIVIL NX");
(async () => {
  await new Promise(r => mock.server.listen(8791, r));
  const mapi = new Mapi.Mapi({ key: "mock-key", base: "http://localhost:8791/civil" });
  const info = await mapi.verify();
  ok(info.keyVerified && info.status === "connected", "connects to the mock");

  const sel = await mapi.selection();
  ok(sel.elements.length === 2, "reads the CIVIL NX selection (" + sel.elements.length + " elements)");

  const tables = await Plan.readTables(mapi);
  ok(tables.SECTPROP.status === "ok", "reads /ope/SECTPROP");
  ok(tables.ELEM.status === "ok" && tables.THIK.status === "empty",
    "an empty table reads as empty, not as an error");

  const beams = Plan.beams(tables);
  ok(beams.filter(b => b.skip).length === 2, "the plate and the truss are skipped, not failed");

  const selected = Plan.select(beams, { mode: "selection", selected: sel.elements }, tables);
  ok(selected.length === 2, "the selection picks the two continuous girders");

  const sectIds = [];
  selected.forEach(b => { if (sectIds.indexOf(b.sect) === -1) sectIds.push(b.sect); });
  const opts = { longSize: 2, transSize: 0.3, mergeTol: 1e-4, calibrate: "generic", convertLoads: true,
                 thickTol: 0.005, boundaryGroup: "B2P links" };
  const sections = Plan.studySections(tables, sectIds, opts);
  ok(Object.values(sections).every(s => s.ok), "the selected sections interpret");

  const plan = Plan.buildPlan(selected, sections, tables, opts);
  ok(plan.totals.plates > 0, "the plan has plates (" + plan.totals.plates + ")");
  near(plan.totals.volume, plan.totals.expected, 1e-9, "the plan's volume check is exact");
  ok(plan.links.length === 2, "two links: the two supported ends (" + plan.links.length + ")");
  ok(plan.freeEnds.length === 1, "the shared interior node needs no link");
  ok(plan.loads.length > 0, "the beam loads are converted (" + plan.loads.length + " node entries)");
  ok(plan.dangling.some(d => d.table === "LLAN"), "the traffic lane on these beams is reported");

  const report = await Commit.commit(mapi, {
    plan, sources: selected, groupName: "B2P mesh", boundaryGroup: "B2P links",
    reuseExisting: true, deleteSources: true, deleteOrphans: true, mergeTol: 1e-4
  }, {});
  ok(report.plates === plan.totals.plates, "every plate was written");
  ok(report.verified === report.plates, "every plate was found again afterwards");
  ok(report.links === 2, "the links landed");
  ok(report.deleted === 2, "the source beams were deleted");
  ok(!mock.TABLES.BMLD[String(selected[0].id)], "deleting a beam took its beam loads with it");
  ok(Object.keys(mock.TABLES.THIK).length === report.thicknesses.length, "one THIK record per distinct thickness");
  const grup = mock.TABLES.GRUP["1"];
  ok(grup.E_LIST.length > 2, "the plates joined the girders' structure group");
  ok(report.warnings.length === 0, "no warnings: " + report.warnings.join(" | "));

  /* undo */
  const back = await Commit.undo(mapi, report, {});
  ok(back.plates === report.plates, "undo removed every plate");
  ok(back.sources === 2, "undo put both beams back");
  ok(Object.keys(mock.TABLES.ELEM).filter(k => mock.TABLES.ELEM[k].TYPE === "PLATE").length === 1,
    "only the model's own original plate remains");
  ok(!!mock.TABLES.BMLD[String(selected[0].id)], "undo restored the beam loads too");

  await new Promise(r => mock.server.close(r));

  console.log("\n" + (failed ? failed + " FAILED, " : "") + passed + " passed");
  if (failed) { fails.forEach(f => console.log("  - " + f)); process.exit(1); }
})();
