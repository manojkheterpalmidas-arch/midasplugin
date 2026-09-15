/* ==========================================================================
   Beam to Plate — the write
   --------------------------------------------------------------------------
   The only file in the plugin that changes the model. Five rules from
   references/ shape all of it:

   1. RE-READ IMMEDIATELY BEFORE WRITING. A plan built from a read taken minutes
      ago describes a model the user may have edited since. Here that would mean
      meshing a beam that no longer exists, or one whose section was swapped —
      and the failure would surface later, with unrelated wording, and only
      sometimes. So the sources are re-read and compared against the plan, and a
      drift aborts the commit before anything is written.

   2. THE ID YOU SEND IS NOT ALWAYS THE ID YOU GET. `Assign` at a key that does
      not exist makes MIDAS ignore the number and append at the next free slot.
      A plate mesh is nothing but ids, so every id is READ BACK and matched by
      coordinate before it is used in an element.

   3. PUT UPSERTS. It never clears a table, so a re-run adds beside what is there
      rather than replacing it. Thicknesses are therefore reused by VALUE.

   4. ERRORS ARE HTTP 200 WITH AN `error` KEY, and a `message` is a SUCCESS. The
      client handles both; nothing here branches on a status code.

   5. GROUPS ARE WRITTEN LAST, in their own try/catch. The GRUP record shape is
      confirmed on the read side; if this build disagrees, a warning is the right
      outcome, not a rolled-back mesh that was created cleanly.
   ========================================================================== */
(function (root) {
  "use strict";

  var BATCH = 300;      /* records per PUT — small enough to localise a rejection */

  /* ------------------------------------------------------------- utilities */

  function nextId(rows) {
    var max = 0;
    Object.keys(rows || {}).forEach(function (k) {
      var n = Number(k);
      if (isFinite(n) && n > max) max = n;
    });
    return max + 1;
  }

  function idSet(rows) {
    var s = Object.create(null);
    Object.keys(rows || {}).forEach(function (k) { s[k] = true; });
    return s;
  }

  function newIds(before, afterRows) {
    return Object.keys(afterRows || {}).filter(function (k) { return !before[k]; })
      .sort(function (a, b) { return Number(a) - Number(b); });
  }

  /** Spatial index over /db/NODE rows, for reuse and for id read-back. */
  function nodeIndex(rows, ids, tol) {
    var Mesh = root.B2PMesh || require("./mesh.js");
    var pool = new Mesh.NodePool(tol);
    var byPoolIdx = Object.create(null);
    (ids || Object.keys(rows || {})).forEach(function (id) {
      var r = rows[id];
      if (!r) return;
      var idx = pool.add([Number(r.X) || 0, Number(r.Y) || 0, Number(r.Z) || 0]);
      /* First id wins: if the model already holds two nodes at one point, the
         mesh joins the lower-numbered one rather than picking arbitrarily. */
      if (byPoolIdx[idx] == null) byPoolIdx[idx] = String(id);
    });
    return {
      find: function (p) {
        var idx = pool.find(p);
        return idx !== -1 && byPoolIdx[idx] != null ? byPoolIdx[idx] : null;
      }
    };
  }

  /* ---------------------------------------------------------------- drift */

  /**
   * Has the model moved under the plan?
   *
   * Compares each source beam against the table as it is NOW. Anything that
   * would change the mesh — the element gone, a different section, a different
   * beta angle, a node moved — aborts. A model the user edited between Plan and
   * Commit is the one case where writing confidently is writing wrongly.
   */
  function drift(sources, elemRows, nodeRows, tol) {
    tol = tol || 1e-6;
    var out = [];
    sources.forEach(function (b) {
      var row = elemRows && elemRows[b.id];
      if (!row) { out.push({ id: b.id, what: "the element no longer exists" }); return; }
      if (String(row.TYPE || "").toUpperCase() !== b.type) {
        out.push({ id: b.id, what: "its element type changed" }); return;
      }
      if (String(row.SECT) !== String(b.sect)) {
        out.push({ id: b.id, what: "its section changed" }); return;
      }
      if (Math.abs((Number(row.ANGLE) || 0) - b.angle) > 1e-9) {
        out.push({ id: b.id, what: "its beta angle changed" }); return;
      }
      var nodes = (row.NODE || []).filter(function (n) { return Number(n) > 0; }).map(String);
      if (nodes.join(",") !== b.nodeIds.join(",")) {
        out.push({ id: b.id, what: "its nodes changed" }); return;
      }
      var moved = [b.i, b.j].some(function (p, k) {
        var r = nodeRows && nodeRows[nodes[k]];
        if (!r) return true;
        return Math.abs((Number(r.X) || 0) - p[0]) > tol ||
               Math.abs((Number(r.Y) || 0) - p[1]) > tol ||
               Math.abs((Number(r.Z) || 0) - p[2]) > tol;
      });
      if (moved) out.push({ id: b.id, what: "one of its nodes moved" });
    });
    return out;
  }

  /* --------------------------------------------------------------- commit */

  /**
   * Write the plan.
   *
   * @param {Mapi} mapi
   * @param {Object} ctx   { plan, sources, groupName, deleteSources, reuseExisting }
   * @param {Object} hooks { progress(text, frac), yieldTo() }
   * @returns {Object} a report: what was written, what was reused, what warned
   */
  async function commit(mapi, ctx, hooks) {
    hooks = hooks || {};
    var say = hooks.progress || function () {};
    var breathe = hooks.yieldTo || function () { return Promise.resolve(); };
    var plan = ctx.plan;
    var tol = ctx.mergeTol || 1e-4;
    var report = { nodesWritten: 0, nodesReused: 0, plates: 0, thicknesses: [],
                   group: null, deleted: 0, warnings: [], calls: 0 };

    /* -- 1. the model as it is NOW, not as the plan remembers it ------------ */
    say("Re-reading the model before writing", 0.02);
    var fresh = await mapi.dbAll(["NODE", "ELEM", "THIK", "GRUP"]);
    if (fresh.NODE.status === "error" || fresh.ELEM.status === "error") {
      throw new Error("The model could not be re-read before writing: " +
        (fresh.NODE.reason || fresh.ELEM.reason));
    }
    var nodeRows = fresh.NODE.rows || {};
    var elemRows = fresh.ELEM.rows || {};

    var moved = drift(ctx.sources, elemRows, nodeRows, tol / 100);
    if (moved.length) {
      var e = new Error("The model changed since the plan was built, so nothing " +
        "was written. " + moved.length + " element(s) differ, starting with " +
        moved[0].id + ": " + moved[0].what + ".");
      e.hint = "Press Plan again to rebuild from the model as it is now.";
      throw e;
    }

    /* -- 2. thicknesses ---------------------------------------------------- */
    say("Writing plate thicknesses", 0.08);
    var thikRows = fresh.THIK.rows || {};
    var thikBefore = idSet(thikRows);
    var toCreate = plan.thicknesses.filter(function (t) {
      /* Reuse is recomputed against the FRESH table: a thickness the plan
         thought it had to create may have appeared since, and vice versa. */
      var match = Object.keys(thikRows).filter(function (id) {
        return Math.abs(Number(thikRows[id].T_IN) - t.t) <= Math.max(1e-9, t.t * 1e-6);
      })[0];
      t.reuseId = match || null;
      return !match;
    });

    if (toCreate.length) {
      var assign = {};
      var id = nextId(thikRows);
      toCreate.forEach(function (t) {
        assign[String(id++)] = {
          NAME: t.name, TYPE: "VALUE", bINOUT: false,
          /* THIK does NOT use VSIZE or THIK_IN — all six such variants were
             rejected on a live model. T_IN/T_OUT is the shape it takes. */
          T_IN: t.t, T_OUT: 0, OFFSET: 0, O_VALUE: 0
        };
      });
      await mapi.put("THIK", assign);
      var afterThik = await mapi.db("THIK");
      var created = newIds(thikBefore, afterThik.rows || {});
      /* Match the ids that appeared to the values we asked for, rather than
         assuming the numbers we sent were honoured. */
      toCreate.forEach(function (t) {
        var found = created.filter(function (cid) {
          var r = (afterThik.rows || {})[cid];
          return r && Math.abs(Number(r.T_IN) - t.t) <= Math.max(1e-9, t.t * 1e-6);
        })[0];
        if (!found) {
          throw new Error("A plate thickness of " + t.t + " was written but could " +
            "not be found in /db/THIK afterwards, so no plates were created.");
        }
        t.reuseId = found;
      });
    }
    report.thicknesses = plan.thicknesses.map(function (t) {
      return { t: t.t, id: t.reuseId, name: t.name, plates: t.plates };
    });

    /* -- 3. nodes ---------------------------------------------------------- */
    say("Placing nodes", 0.15);
    var existing = ctx.reuseExisting ? nodeIndex(nodeRows, null, tol) : null;
    var poolList = plan.pool.list;
    var poolId = new Array(poolList.length);
    var queue = [];

    for (var p = 0; p < poolList.length; p++) {
      if (p % 2000 === 0) await breathe();
      var hit = existing ? existing.find(poolList[p]) : null;
      if (hit) { poolId[p] = hit; report.nodesReused++; }
      else queue.push(p);
    }

    var nodeBefore = idSet(nodeRows);
    var nid = nextId(nodeRows);
    for (var qi = 0; qi < queue.length; qi += BATCH) {
      await breathe();
      var slice = queue.slice(qi, qi + BATCH);
      var nAssign = {};
      slice.forEach(function (idx) {
        var xyz = poolList[idx];
        nAssign[String(nid++)] = { X: xyz[0], Y: xyz[1], Z: xyz[2] };
      });
      await mapi.put("NODE", nAssign);
      report.nodesWritten += slice.length;
      say("Placing nodes (" + Math.min(qi + BATCH, queue.length) + " of " +
          queue.length + ")", 0.15 + 0.35 * (qi / Math.max(1, queue.length)));
    }

    if (queue.length) {
      /* Read back and match by COORDINATE. This is the step that survives the
         append-at-next-free-slot behaviour; without it every element written
         below would reference whatever happens to hold that number. */
      say("Reading back the node ids", 0.52);
      var afterNode = await mapi.db("NODE");
      var appeared = newIds(nodeBefore, afterNode.rows || {});
      var fresh_index = nodeIndex(afterNode.rows || {}, appeared, tol);
      for (var k = 0; k < queue.length; k++) {
        if (k % 2000 === 0) await breathe();
        var idx2 = queue[k];
        var got = fresh_index.find(poolList[idx2]);
        if (!got) {
          throw new Error("A node written at (" + poolList[idx2].map(fmt).join(", ") +
            ") could not be found in /db/NODE afterwards. No plates were created, " +
            "but the nodes that were written are still in the model.");
        }
        poolId[idx2] = got;
      }
    }

    /* -- 4. plates --------------------------------------------------------- */
    say("Writing plates", 0.6);
    var elemBefore = idSet(elemRows);
    var eid = nextId(elemRows);
    var wanted = [];
    for (var pi = 0; pi < plan.plates.length; pi += BATCH) {
      await breathe();
      var pslice = plan.plates.slice(pi, pi + BATCH);
      var eAssign = {};
      pslice.forEach(function (q) {
        var nodes = q.nodes.map(function (ix) { return Number(poolId[ix]); });
        var rec = {
          TYPE: "PLATE", MATL: Number(q.matl) || 1,
          /* A plate's THICKNESS is referenced through the element's SECT field.
             SECT ids and THIK ids are independent spaces: for a plate, SECT: 3
             means THIK 3. There is no separate thickness key on ELEM. */
          SECT: Number(thicknessId(plan.thicknesses, q.t)),
          NODE: nodes,
          STYPE: 3                              /* thick plate */
        };
        eAssign[String(eid++)] = rec;
        wanted.push({ key: nodes.slice().sort(numeric).join(","), rec: rec, plate: q });
      });
      await mapi.put("ELEM", eAssign);
      report.plates += pslice.length;
      say("Writing plates (" + Math.min(pi + BATCH, plan.plates.length) + " of " +
          plan.plates.length + ")", 0.6 + 0.25 * (pi / Math.max(1, plan.plates.length)));
    }

    /* -- 5. verify what landed -------------------------------------------- */
    say("Verifying the plates that landed", 0.88);
    var afterElem = await mapi.db("ELEM");
    var appearedEl = newIds(elemBefore, afterElem.rows || {});
    var byKey = Object.create(null);
    appearedEl.forEach(function (id2) {
      var r = (afterElem.rows || {})[id2] || {};
      var nodes2 = (r.NODE || []).filter(function (n) { return Number(n) > 0; }).map(Number);
      var key = nodes2.slice().sort(numeric).join(",");
      (byKey[key] || (byKey[key] = [])).push(String(id2));
    });

    var elemIds = [];
    var missing = 0;
    wanted.forEach(function (w) {
      var bucket = byKey[w.key];
      if (bucket && bucket.length) elemIds.push(bucket.shift());
      else missing++;
    });
    if (missing) {
      report.warnings.push(missing + " of " + wanted.length + " plates could not be " +
        "found in /db/ELEM after the write. The mesh is incomplete — check the " +
        "model before using it.");
    }
    report.verified = wanted.length - missing;
    report.elemIds = elemIds;

    /* -- 6. the group ------------------------------------------------------ */
    if (ctx.groupName) {
      say("Writing the structure group", 0.92);
      try {
        var grupRows = (fresh.GRUP && fresh.GRUP.rows) || {};
        var gid = null;
        Object.keys(grupRows).forEach(function (g) {
          if (String(grupRows[g].NAME) === ctx.groupName) gid = g;
        });
        var nodeIdsAll = [];
        poolId.forEach(function (v) { if (v != null) nodeIdsAll.push(Number(v)); });
        await mapi.put("GRUP", makeAssign(gid || String(nextId(grupRows)), {
          NAME: ctx.groupName, P_TYPE: 0,
          N_LIST: nodeIdsAll,
          E_LIST: elemIds.map(Number)
        }));
        report.group = ctx.groupName;
      } catch (gerr) {
        /* Written last and caught here on purpose: a wrong GRUP schema must
           degrade to a warning, not roll back a mesh that was created cleanly. */
        report.warnings.push("The structure group could not be written (" +
          gerr.message + "). The nodes and plates are in the model.");
      }
    }

    /* -- 7. the source beams ---------------------------------------------- */
    if (ctx.deleteSources) {
      say("Deleting the source beams", 0.96);
      for (var d = 0; d < ctx.sources.length; d++) {
        if (d % 20 === 0) await breathe();
        try {
          await mapi.delRow("ELEM", ctx.sources[d].id);
          report.deleted++;
        } catch (derr) {
          report.warnings.push("Beam " + ctx.sources[d].id + " could not be deleted (" +
            derr.message + ").");
        }
      }
    }

    say("Done", 1);
    report.calls = mapi.calls;
    return report;
  }

  function thicknessId(thicknesses, t) {
    var match = thicknesses.filter(function (x) {
      return Math.abs(x.t - t) <= Math.max(1e-9, t * 1e-6);
    })[0];
    if (!match || !match.reuseId) {
      throw new Error("No /db/THIK record for a plate thickness of " + t + ".");
    }
    return match.reuseId;
  }

  function makeAssign(id, rec) {
    var a = {};
    a[String(id)] = rec;
    return a;
  }

  function numeric(a, b) { return a - b; }
  function fmt(v) { return Number(v).toFixed(4); }

  var api = {
    BATCH: BATCH,
    nextId: nextId,
    idSet: idSet,
    newIds: newIds,
    nodeIndex: nodeIndex,
    drift: drift,
    commit: commit
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PCommit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
