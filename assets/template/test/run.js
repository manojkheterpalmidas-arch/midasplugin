/*
 * Offline regression suite.
 *
 *   node test/run.js
 *
 * The shipped modules are run against the mock over REAL HTTP, so the MAPI
 * client, the status handling and the HEAD parsing are under test rather than
 * stubbed. Nothing here needs CIVIL NX.
 *
 * If every require() below comes back as an empty object, a PARENT folder's
 * package.json says "type": "module" and the local one saying "commonjs" has
 * gone missing. That is the cause, every time.
 */
const path = require("path");

const JS = path.join(__dirname, "..", "js");
const MapiM = require(path.join(JS, "mapi.js"));
const Model = require(path.join(JS, "model.js"));
const mock = require(path.join(__dirname, "..", "mock-midas", "server.js"));

const PORT = 8779;

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
const section = (t) => console.log("\n— " + t);

(async () => {
  await new Promise((r) => mock.server.listen(PORT, r));
  const base = `http://localhost:${PORT}/civil`;
  const mapi = new MapiM.Mapi({ key: "mock-key", base });

  section("connection");
  const v = await mapi.verify();
  eq(v.program, "civil", "verify reports the program");

  /* A key keeps verifying after CIVIL NX closes. Checking keyVerified alone
     reports a dead session as connected and then falls over on the first read. */
  mock.state.session = "disconnected";
  let threw = null;
  try { await mapi.verify(); } catch (e) { threw = e; }
  ok(threw && /session is disconnected/i.test(threw.message),
     "a valid key with a dead session is refused", threw && threw.message);
  mock.state.session = "connected";

  section("read statuses are distinguished");
  const nodes = await mapi.db("NODE");
  eq(nodes.status, "ok", "a populated table reads ok");
  eq(Object.keys(nodes.rows).length, 24, "24 nodes");

  const thik = await mapi.db("THIK");
  /* 200 {"message":""} — the table exists, the model has nothing of that kind. */
  eq(thik.status, "empty", "an unpopulated table is empty, not absent");

  const bogus = await mapi.db("NOSUCHTABLE");
  /* 404 means WE used a wrong key. A plugin reading this as "the model has
     none" has it exactly backwards. */
  eq(bogus.status, "absent", "an unknown table key is absent (a plugin bug)");

  section("model read gates its endpoints");
  const model = await Model.readModel(mapi);
  eq(model.total, Model.ENDPOINTS.length, "every endpoint accounted for");
  const byKey = Object.fromEntries(model.summary.map((r) => [r.key, r]));
  eq(byKey.NODE.count, 24, "nodes counted");
  eq(byKey.THIK.note, "none in this model", "an empty table says so honestly");
  eq(byKey["LCOM-GEN"].count, 2, "combinations read because load cases exist");

  const ext = Model.extents(model.tables.NODE.rows);
  eq(ext.size[0], 25, "extents across the deck");

  section("write semantics");
  await mapi.put("NODE", { 99: { X: 1, Y: 2, Z: 3 } });
  const after = await mapi.db("NODE");
  eq(Object.keys(after.rows).length, 25, "PUT upserts — it does not clear the table");

  let putErr = null;
  try { await mapi.put("NODE", null); } catch (e) { putErr = e; }
  /* The rejection arrives as HTTP 200 with an error key. A client branching on
     response.ok would have counted this as a success. */
  ok(putErr && /wrong field/i.test(putErr.message), "a rejected write throws", putErr && putErr.message);
  ok(putErr && /not recognised/i.test(putErr.hint || ""), "the error carries an actionable hint");

  section("result tables");
  const good = await mapi.postTable({ token: "BEAMFORCE", keys: [101, 102], series: ["ULS-1(CB)"] });
  ok(good && good.HEAD, "an addressable series returns a table");
  eq(good.DATA.length, 2, "one row per element");

  /* ENV-1 is an envelope: it may ONLY be addressed with a sense. The wrong
     suffix is not an error — the series is dropped silently. */
  const wrongSuffix = await mapi.postTable({ token: "BEAMFORCE", keys: [101], series: ["ENV-1(CB)"] });
  eq(wrongSuffix, null, "an envelope without a sense is dropped silently");

  const rightSuffix = await mapi.postTable({ token: "BEAMFORCE", keys: [101], series: ["ENV-1(CB:max)"] });
  ok(rightSuffix && rightSuffix.DATA.length === 1, "the same envelope with a sense returns rows");

  /* Mixed request: the bad series is dropped and the good one returned, so the
     ONLY signal is a missing row. Plugins must check what they asked for. */
  const mixed = await mapi.postTable({ token: "BEAMFORCE", keys: [101], series: ["ULS-1(CB)", "ENV-1(CB)"] });
  eq(mixed.DATA.length, 1, "a mixed request silently drops only the bad series");

  let tokErr = null;
  try { await mapi.postTable({ token: "REACTION", keys: [1], series: ["ULS-1(CB)"] }); }
  catch (e) { tokErr = e; }
  ok(tokErr && /utbl/i.test(tokErr.message), "a bare REACTION token is refused");
  ok(tokErr && /REACTIONG/.test(tokErr.hint || ""), "the hint names the real token");

  section("safety rails");
  let wl = null;
  try { await mapi.post("/db/NODE", { Assign: {} }, {}); } catch (e) { wl = e; }
  ok(wl && /not permitted to POST/i.test(wl.message), "POST paths are whitelisted");

  /* EXPORT_PATH is what makes CIVIL NX write a file to the user's disk. The
     client strips it, so the mock — which rejects it — never sees one. */
  const stripped = await mapi.post("/post/TABLE", {
    Argument: {
      TABLE_NAME: "plg", TABLE_TYPE: "BEAMFORCE", UNIT: { FORCE: "kN", DIST: "m" },
      NODE_ELEMS: { KEYS: [101] }, LOAD_CASE_NAMES: ["ULS-1(CB)"],
      EXPORT_PATH: "C:\\Users\\somebody\\leak.csv"
    }
  }, {});
  ok(stripped && stripped.plg, "EXPORT_PATH is stripped before every send");

  section("host query string");
  eq(MapiM.keyFromLocation("?mapiKey=abc&redirectTo=http://x/civil"), "abc", "key read from the query string");
  eq(MapiM.baseFromLocation("?redirectTo=http://x/civil/"), "http://x/civil", "redirectTo wins, trailing slash trimmed");
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
