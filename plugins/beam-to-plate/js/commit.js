/* ==========================================================================
   Beam to Plate — the write
   --------------------------------------------------------------------------
   The only file that changes the model. The rules it is built around, all
   measured on a live CIVIL NX rather than read from documentation:

   1. RE-READ IMMEDIATELY BEFORE WRITING. A plan built minutes ago describes a
      model the user may have edited since. The sources are re-read and compared
      with the plan, and any drift aborts before anything is written.

   2. THE ID YOU SEND IS NOT ALWAYS THE ID YOU GET. Every node id is read back
      and matched by COORDINATE before it is used in a plate.

   3. WRITES MERGE. `PUT /db/GRUP` merges its lists, `PUT /db/CNLD` merges a
      node's items by ID, and `PUT /db/RIGD` merges slave nodes into an existing
      link on the same master. So the plugin sends only what it adds — and picks
      item ids that are not already in use on that node.

   4. ERRORS ARRIVE AS HTTP 200 WITH AN `error` KEY, and a `message` is a
      SUCCESS. The client handles both; nothing here branches on a status code.

   5. ORDER MATTERS. Thicknesses, then nodes, then plates, then the links and
      loads that reference them, then the groups, and the source beams LAST:
      deleting a beam takes its beam loads with it (verified), so the converted
      loads must already be in place.

   Everything written is recorded in an UNDO RECORD as it goes, so a conversion
   can be taken back out of the model in the same session.
   ========================================================================== */
(function (root) {
  "use strict";

  var Plan = root.B2PPlan || (typeof require === "function" ? require("./plan.js") : null);
  var Mesh = root.B2PMesh || (typeof require === "function" ? require("./mesh.js") : null);

  var BATCH = 300;

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

  function nodeIndex(rows, ids, tol) {
    var pool = new Mesh.NodePool(tol);
    var byPoolIdx = Object.create(null);
    (ids || Object.keys(rows || {})).forEach(function (id) {
      var r = rows[id];
      if (!r) return;
      var idx = pool.add([Number(r.X) || 0, Number(r.Y) || 0, Number(r.Z) || 0]);
      if (byPoolIdx[idx] == null) byPoolIdx[idx] = String(id);
    });
    return { find: function (p) { var i = pool.find(p); return i !== -1 && byPoolIdx[i] != null ? byPoolIdx[i] : null; } };
  }

  /* ---------------------------------------------------------------- drift */

  function drift(sources, elemRows, nodeRows, tol) {
    tol = tol || 1e-6;
    var out = [];
    sources.forEach(function (b) {
      var row = elemRows && elemRows[b.id];
      if (!row) { out.push({ id: b.id, what: "the element no longer exists" }); return; }
      if (String(row.TYPE || "").toUpperCase() !== b.type) { out.push({ id: b.id, what: "its element type changed" }); return; }
      if (String(row.SECT) !== String(b.sect)) { out.push({ id: b.id, what: "its section changed" }); return; }
      if (Math.abs((Number(row.ANGLE) || 0) - b.angle) > 1e-9) { out.push({ id: b.id, what: "its beta angle changed" }); return; }
      var nodes = (row.NODE || []).filter(function (n) { return Number(n) > 0; }).map(String);
      if (nodes.join(",") !== b.nodeIds.join(",")) { out.push({ id: b.id, what: "its nodes changed" }); return; }
      var moved = [b.nodeI, b.nodeJ].some(function (p, k) {
        var r = nodeRows && nodeRows[nodes[k]];
        if (!r) return true;
        return Math.abs((Number(r.X) || 0) - p[0]) > tol || Math.abs((Number(r.Y) || 0) - p[1]) > tol ||
               Math.abs((Number(r.Z) || 0) - p[2]) > tol;
      });
      if (moved) out.push({ id: b.id, what: "one of its nodes moved" });
    });
    return out;
  }

  /* --------------------------------------------------------------- commit */

  /**
   * Write the plan.
   * @param ctx { plan, sources, groupName, deleteSources, reuseExisting, mergeTol,
   *              boundaryGroup, convertLoads }
   */
  async function commit(mapi, ctx, hooks) {
    hooks = hooks || {};
    var say = hooks.progress || function () {};
    var breathe = hooks.yieldTo || function () { return Promise.resolve(); };
    var plan = ctx.plan;
    var tol = ctx.mergeTol || 1e-4;
    var report = { nodesWritten: 0, nodesReused: 0, plates: 0, verified: 0, thicknesses: [], links: 0,
                   ties: 0, loads: 0, temperatures: 0, groups: [], group: null, deleted: 0, warnings: [], calls: 0,
                   undo: { nodes: [], plates: [], links: [], loads: [], sources: [], thicknesses: [] } };

    /* -- 1. the model as it is NOW ---------------------------------------- */
    say("Re-reading the model before writing", 0.02);
    var fresh = await mapi.dbAll(["NODE", "ELEM", "THIK", "GRUP", "RIGD", "CNLD", "BNGR", "BMLD", "ETMP", "FRLS", "OFFS"]);
    if (fresh.NODE.status === "error" || fresh.ELEM.status === "error") {
      throw new Error("The model could not be re-read before writing: " + (fresh.NODE.reason || fresh.ELEM.reason));
    }
    var nodeRows = fresh.NODE.rows || {}, elemRows = fresh.ELEM.rows || {};
    var moved = drift(ctx.sources, elemRows, nodeRows, tol / 100);
    if (moved.length) {
      var e = new Error("The model changed since the plan was built, so nothing was written. " +
        moved.length + " element(s) differ, starting with " + moved[0].id + ": " + moved[0].what + ".");
      e.hint = "Press Plan again to rebuild from the model as it is now.";
      throw e;
    }

    /* keep the source rows so the conversion can be undone */
    ctx.sources.forEach(function (b) {
      report.undo.sources.push({
        id: b.id, elem: elemRows[b.id],
        bmld: (fresh.BMLD.rows || {})[b.id] || null, etmp: (fresh.ETMP.rows || {})[b.id] || null,
        frls: (fresh.FRLS.rows || {})[b.id] || null, offs: (fresh.OFFS.rows || {})[b.id] || null
      });
    });

    /* -- 2. boundary group for the links ---------------------------------- */
    var bngrName = ctx.boundaryGroup || "";
    if (bngrName) {
      var bngrRows = fresh.BNGR.rows || {};
      var exists = Object.keys(bngrRows).some(function (k) { return String(bngrRows[k].NAME) === bngrName; });
      if (!exists) {
        try {
          await mapi.put("BNGR", makeAssign(String(nextId(bngrRows)), { NAME: bngrName, AUTOTYPE: 0 }));
        } catch (be) {
          report.warnings.push("The boundary group \"" + bngrName + "\" could not be created (" + be.message +
            "). The links are written without one.");
          bngrName = "";
        }
      }
    }

    /* -- 3. thicknesses ---------------------------------------------------- */
    say("Writing plate thicknesses", 0.06);
    var thikRows = fresh.THIK.rows || {};
    var thikBefore = idSet(thikRows);
    var toCreate = plan.thicknesses.filter(function (t) {
      var match = Object.keys(thikRows).filter(function (id) {
        return Math.abs(Number(thikRows[id].T_IN) - t.t) <= Math.max(1e-12, t.t * 1e-6);
      })[0];
      t.reuseId = match || null;
      return !match;
    });
    if (toCreate.length) {
      var assign = {}, tid = nextId(thikRows);
      toCreate.forEach(function (t) {
        assign[String(tid++)] = { NAME: t.name, TYPE: "VALUE", bINOUT: false,
                                  T_IN: t.t, T_OUT: 0, OFFSET: 0, O_VALUE: 0 };
      });
      await mapi.put("THIK", assign);
      var afterThik = await mapi.db("THIK");
      var created = newIds(thikBefore, afterThik.rows || {});
      report.undo.thicknesses = created;
      toCreate.forEach(function (t) {
        var found = created.filter(function (cid) {
          var r = (afterThik.rows || {})[cid];
          return r && Math.abs(Number(r.T_IN) - t.t) <= Math.max(1e-12, t.t * 1e-6);
        })[0];
        if (!found) throw new Error("A plate thickness of " + t.t + " was written but could not be found in /db/THIK afterwards.");
        t.reuseId = found;
      });
    }
    report.thicknesses = plan.thicknesses.map(function (t) {
      return { t: t.t, id: t.reuseId, name: t.name, plates: t.plates, spread: t.spread };
    });

    /* -- 4. nodes ---------------------------------------------------------- */
    say("Placing nodes", 0.12);
    var existing = ctx.reuseExisting ? nodeIndex(nodeRows, null, tol) : null;
    var poolList = plan.pool.list, poolId = new Array(poolList.length), queue = [];
    for (var p = 0; p < poolList.length; p++) {
      if (p % 2000 === 0) await breathe();
      var hit = existing ? existing.find(poolList[p]) : null;
      if (hit) { poolId[p] = hit; report.nodesReused++; } else queue.push(p);
    }
    var nodeBefore = idSet(nodeRows), nid = nextId(nodeRows);
    for (var qi = 0; qi < queue.length; qi += BATCH) {
      await breathe();
      var slice = queue.slice(qi, qi + BATCH), nAssign = {};
      slice.forEach(function (idx) {
        var xyz = poolList[idx];
        nAssign[String(nid++)] = { X: xyz[0], Y: xyz[1], Z: xyz[2] };
      });
      await mapi.put("NODE", nAssign);
      report.nodesWritten += slice.length;
      say("Placing nodes (" + Math.min(qi + BATCH, queue.length) + " of " + queue.length + ")",
        0.12 + 0.28 * (qi / Math.max(1, queue.length)));
    }
    if (queue.length) {
      say("Reading back the node ids", 0.42);
      var afterNode = await mapi.db("NODE");
      var appeared = newIds(nodeBefore, afterNode.rows || {});
      report.undo.nodes = appeared.slice();
      var freshIndex = nodeIndex(afterNode.rows || {}, appeared, tol);
      for (var k = 0; k < queue.length; k++) {
        if (k % 2000 === 0) await breathe();
        var idx2 = queue[k], got = freshIndex.find(poolList[idx2]);
        if (!got) {
          throw new Error("A node written at (" + poolList[idx2].map(fmt).join(", ") +
            ") could not be found in /db/NODE afterwards. No plates were created.");
        }
        poolId[idx2] = got;
      }
    }

    /* -- 5. plates --------------------------------------------------------- */
    say("Writing plates", 0.48);
    var elemBefore = idSet(elemRows), eid = nextId(elemRows), wanted = [];
    for (var pi = 0; pi < plan.plates.length; pi += BATCH) {
      await breathe();
      var pslice = plan.plates.slice(pi, pi + BATCH), eAssign = {};
      pslice.forEach(function (q) {
        var nodes = q.nodes.map(function (ix) { return Number(poolId[ix]); });
        var bin = Plan.thicknessFor(plan.thicknesses, q.t);
        if (!bin || !bin.reuseId) throw new Error("No /db/THIK record for a plate thickness of " + q.t + ".");
        var rec = { TYPE: "PLATE", MATL: Number(q.matl) || 1, SECT: Number(bin.reuseId),
                    NODE: nodes, STYPE: 3 };
        eAssign[String(eid++)] = rec;
        wanted.push({ key: nodes.slice().sort(numeric).join(","), plate: q });
      });
      await mapi.put("ELEM", eAssign);
      report.plates += pslice.length;
      say("Writing plates (" + Math.min(pi + BATCH, plan.plates.length) + " of " + plan.plates.length + ")",
        0.48 + 0.22 * (pi / Math.max(1, plan.plates.length)));
    }

    /* -- 6. verify what landed -------------------------------------------- */
    say("Verifying the plates", 0.72);
    var afterElem = await mapi.db("ELEM");
    var appearedEl = newIds(elemBefore, afterElem.rows || {});
    report.undo.plates = appearedEl.slice();
    var byKey = Object.create(null);
    appearedEl.forEach(function (id2) {
      var r = (afterElem.rows || {})[id2] || {};
      var nodes2 = (r.NODE || []).filter(function (n) { return Number(n) > 0; }).map(Number);
      (byKey[nodes2.slice().sort(numeric).join(",")] || (byKey[nodes2.slice().sort(numeric).join(",")] = [])).push(String(id2));
    });
    var elemIds = [], missing = 0;
    wanted.forEach(function (w) {
      var bucket = byKey[w.key];
      if (bucket && bucket.length) { var id3 = bucket.shift(); elemIds.push(id3); w.plate.elemId = id3; }
      else missing++;
    });
    if (missing) {
      report.warnings.push(missing + " of " + wanted.length + " plates could not be found in /db/ELEM after " +
        "the write. The mesh is incomplete — check the model before using it.");
    }
    report.verified = wanted.length - missing;
    report.elemIds = elemIds;

    /* -- 7. rigid links ---------------------------------------------------- */
    if (plan.links.length || plan.ties.length) {
      say("Linking the mesh to the model", 0.76);
      var rigdRows = fresh.RIGD.rows || {};
      var all = plan.links.map(function (l) {
        return { master: String(l.node), slaves: l.slaves.map(function (s) { return Number(poolId[s]); }) };
      }).concat(plan.ties.map(function (t) {
        return { master: String(poolId[t.master]), slaves: t.slaves.map(function (s) { return Number(poolId[s]); }) };
      }));
      for (var li = 0; li < all.length; li++) {
        if (li % 40 === 0) await breathe();
        var L = all[li];
        var slaves = L.slaves.filter(function (s) { return s && String(s) !== L.master; });
        if (!slaves.length) continue;
        var existingItems = (rigdRows[L.master] && rigdRows[L.master].ITEMS) || [];
        var itemId = 1 + existingItems.reduce(function (a, it) { return Math.max(a, Number(it.ID) || 0); }, 0);
        try {
          await mapi.put("RIGD", makeAssign(L.master, { ITEMS: [{ ID: itemId, GROUP_NAME: bngrName,
            DOF: 111111, S_NODE: slaves }] }));
          report.undo.links.push({ master: L.master, before: rigdRows[L.master] || null });
          if (li < plan.links.length) report.links++; else report.ties += slaves.length;
        } catch (le) {
          report.warnings.push("The rigid link at node " + L.master + " could not be written (" + le.message + ").");
        }
      }
    }

    /* -- 8. converted loads ------------------------------------------------ */
    if (plan.loads.length) {
      say("Moving the beam loads onto the plates", 0.84);
      var cnldRows = fresh.CNLD.rows || {};
      var byNode = Object.create(null);
      plan.loads.forEach(function (l) {
        var id4 = String(poolId[l.idx]);
        (byNode[id4] || (byNode[id4] = [])).push(l);
      });
      var nodeKeys = Object.keys(byNode);
      for (var ni = 0; ni < nodeKeys.length; ni += 100) {
        await breathe();
        var assignL = {};
        nodeKeys.slice(ni, ni + 100).forEach(function (nodeId) {
          var items = (cnldRows[nodeId] && cnldRows[nodeId].ITEMS) || [];
          var next = 1 + items.reduce(function (a, it) { return Math.max(a, Number(it.ID) || 0); }, 0);
          assignL[nodeId] = { ITEMS: byNode[nodeId].map(function (l) {
            return { ID: next++, LCNAME: l.lcname, GROUP_NAME: l.group,
                     FX: l.F[0], FY: l.F[1], FZ: l.F[2], MX: 0, MY: 0, MZ: 0 };
          }) };
          report.undo.loads.push(nodeId);
        });
        await mapi.put("CNLD", assignL);
        report.loads += Object.keys(assignL).length;
      }
    }

    /* -- 9. element temperatures ------------------------------------------ */
    if ((plan.temperatures || []).length) {
      say("Carrying element temperatures across", 0.88);
      for (var ti = 0; ti < plan.temperatures.length; ti++) {
        var t2 = plan.temperatures[ti];
        var assignT = {};
        t2.plates.forEach(function (p2) { if (p2.elemId) assignT[p2.elemId] = { ITEMS: t2.items }; });
        if (!Object.keys(assignT).length) continue;
        try {
          await mapi.put("ETMP", assignT);
          report.temperatures += Object.keys(assignT).length;
        } catch (te) {
          report.warnings.push("Element temperatures from beam " + t2.source + " could not be carried across (" + te.message + ").");
        }
      }
    }

    /* -- 10. groups -------------------------------------------------------- */
    say("Adding the plates to their groups", 0.92);
    var grupRows = fresh.GRUP.rows || {};
    for (var gi = 0; gi < plan.groups.length; gi++) {
      var g = plan.groups[gi];
      try {
        await mapi.put("GRUP", makeAssign(g.id, { NAME: g.name, P_TYPE: 0,
          N_LIST: g.nodes.map(function (n) { return Number(poolId[n]); }).filter(Boolean),
          E_LIST: g.plates.map(function (p3) { return Number(p3.elemId); }).filter(Boolean) }));
        report.groups.push(g.name);
      } catch (ge) {
        report.warnings.push("Group \"" + g.name + "\" could not be updated (" + ge.message +
          "). The plates are in the model but not in that group.");
      }
    }
    if (ctx.groupName) {
      try {
        var gid = null;
        Object.keys(grupRows).forEach(function (q2) { if (String(grupRows[q2].NAME) === ctx.groupName) gid = q2; });
        var allNodes = [];
        poolId.forEach(function (v) { if (v != null) allNodes.push(Number(v)); });
        await mapi.put("GRUP", makeAssign(gid || String(nextId(grupRows)), { NAME: ctx.groupName, P_TYPE: 0,
          N_LIST: allNodes, E_LIST: elemIds.map(Number) }));
        report.group = ctx.groupName;
      } catch (gerr) {
        report.warnings.push("The structure group could not be written (" + gerr.message + ").");
      }
    }

    /* -- 11. the source beams --------------------------------------------- */
    if (ctx.deleteSources) {
      say("Deleting the source beams", 0.96);
      try {
        var res = await mapi.delRows("ELEM", ctx.sources.map(function (b) { return b.id; }));
        report.deleted = res.deleted;
      } catch (derr) {
        report.warnings.push("The source beams could not be deleted (" + derr.message + "). The plates are " +
          "in the model, so the beams are now duplicated — delete them in CIVIL NX, or press Undo.");
      }
    }

    /* -- 12. the beams' own nodes ----------------------------------------
       A node left behind by a deleted beam, that nothing else references and
       that the mesh did not reuse, is not harmless: it reads as a real node
       with zero displacement in every result table, which looks like an answer
       and is not one. It is removed — but only after a fresh read proves
       nothing points at it. */
    if (ctx.deleteSources && ctx.deleteOrphans !== false) {
      say("Removing the beams' orphaned nodes", 0.98);
      var used = Object.create(null);
      poolId.forEach(function (v) { if (v != null) used[String(v)] = true; });
      var after = await mapi.dbAll(["ELEM", "CONS", "NSPR", "GSPR", "SSPS", "CNLD", "SDSP", "NMAS",
                                    "SKEW", "NTMP", "NBOF", "RIGD", "ELNK", "NLNK", "GRUP"]);
      var referenced = Object.create(null);
      Object.keys(after).forEach(function (key) {
        var rows = after[key].rows;
        if (!rows) return;
        if (key === "ELEM") {
          Object.keys(rows).forEach(function (id) {
            (rows[id].NODE || []).forEach(function (n) { if (Number(n) > 0) referenced[String(n)] = key; });
          });
        } else if (key === "ELNK" || key === "NLNK") {
          Object.keys(rows).forEach(function (id) {
            (rows[id].NODE || []).forEach(function (n) { if (Number(n) > 0) referenced[String(n)] = key; });
          });
        } else if (key === "RIGD") {
          Object.keys(rows).forEach(function (m) {
            referenced[String(m)] = key;
            (rows[m].ITEMS || []).forEach(function (it) {
              (it.S_NODE || []).forEach(function (sn) { referenced[String(sn)] = key; });
            });
          });
        } else if (key === "GRUP") {
          Object.keys(rows).forEach(function (g) {
            (rows[g].N_LIST || []).forEach(function (n) { referenced[String(n)] = key; });
          });
        } else {
          Object.keys(rows).forEach(function (id) { referenced[String(id)] = key; });
        }
      });
      var candidates = Object.create(null);
      ctx.sources.forEach(function (b) { (b.nodeIds || []).forEach(function (n) { candidates[String(n)] = true; }); });
      var orphans = Object.keys(candidates).filter(function (n) { return !referenced[n] && !used[n]; });
      try {
        var ores = await mapi.delRows("NODE", orphans);
        report.orphansRemoved = ores.deleted;
      } catch (oe) {
        report.warnings.push("The beams' leftover nodes could not be removed (" + oe.message + ").");
      }
      report.orphansKept = Object.keys(candidates).filter(function (n) { return referenced[n] || used[n]; }).length;
    }

    say("Done", 1);
    report.calls = mapi.calls;
    report.poolId = poolId;
    return report;
  }

  /**
   * Undo a conversion, in the reverse order it was written. Only what this
   * plugin created is touched: the plates, the nodes it added, the load items
   * and links it wrote, and the beams it deleted are put back.
   */
  async function undo(mapi, report, hooks) {
    hooks = hooks || {};
    var say = hooks.progress || function () {};
    var breathe = hooks.yieldTo || function () { return Promise.resolve(); };
    var out = { plates: 0, nodes: 0, links: 0, loads: 0, sources: 0, warnings: [] };
    var u = report.undo || {};

    say("Removing the plates", 0.1);
    try {
      var pres = await mapi.delRows("ELEM", u.plates || []);
      out.plates = pres.deleted;
    } catch (e) { out.warnings.push("Plates: " + e.message); }
    say("Restoring the rigid links", 0.4);
    for (var l = 0; l < (u.links || []).length; l++) {
      var rec = u.links[l];
      try {
        await mapi.delRow("RIGD", rec.master);
        if (rec.before) await mapi.put("RIGD", makeAssign(rec.master, rec.before));
        out.links++;
      } catch (e2) { out.warnings.push("Rigid link at " + rec.master + ": " + e2.message); }
    }
    say("Removing the converted loads", 0.55);
    try {
      var lres = await mapi.delRows("CNLD", u.loads || []);
      out.loads = lres.deleted;
    } catch (e3) { out.warnings.push("Converted loads: " + e3.message); }
    say("Removing the nodes", 0.7);
    try {
      var nres = await mapi.delRows("NODE", u.nodes || []);
      out.nodes = nres.deleted;
    } catch (e4) {
      /* a node still in use stays behind; that is the safe outcome */
      out.warnings.push("Some nodes are still in use and were kept (" + e4.message + ").");
    }
    say("Putting the beams back", 0.85);
    for (var s = 0; s < (u.sources || []).length; s++) {
      var src = u.sources[s];
      if (!src.elem) continue;
      try {
        await mapi.put("ELEM", makeAssign(src.id, src.elem));
        if (src.bmld) await mapi.put("BMLD", makeAssign(src.id, src.bmld));
        if (src.etmp) await mapi.put("ETMP", makeAssign(src.id, src.etmp));
        if (src.frls) await mapi.put("FRLS", makeAssign(src.id, src.frls));
        if (src.offs) await mapi.put("OFFS", makeAssign(src.id, src.offs));
        out.sources++;
      } catch (e5) { out.warnings.push("Beam " + src.id + ": " + e5.message); }
    }
    say("Done", 1);
    return out;
  }

  function makeAssign(id, rec) { var a = {}; a[String(id)] = rec; return a; }
  function numeric(a, b) { return a - b; }
  function fmt(v) { return Number(v).toFixed(4); }

  var api = { BATCH: BATCH, nextId: nextId, idSet: idSet, newIds: newIds, nodeIndex: nodeIndex,
              drift: drift, commit: commit, undo: undo };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.B2PCommit = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
