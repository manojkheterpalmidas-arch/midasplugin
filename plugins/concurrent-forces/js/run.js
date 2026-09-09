/* ==========================================================================
   Concurrent Forces — the run
   --------------------------------------------------------------------------
   The data flow, in one place, with the network injected. Pure enough that
   `node test/run.js` drives the whole thing against the mock over real HTTP;
   app.js only supplies the DOM.

   The order matters and is the specification:

     1  classify the set against /db/ELEM and route each type to its table
     2  walk the combination tree to its leaves and BLOCK what cannot yield a
        coexistent state — before any bulk result query
     3  one /post/TABLE per element type per family, every element and every
        case in the one request
     4  build the (Load, Stage, Step) join key on every row
     5  find the governing row at the key element
     6  if the governing load is envelope-valued, resolve it to a single
        deterministic state and re-read at that state
     7  filter to the rows sharing the governing key — the concurrent set
   ========================================================================== */
(function (root) {
  "use strict";

  function mod(file, name) {
    if (root[name]) return root[name];
    if (typeof require === "function") return require("./" + file);
    throw new Error(file + " must load before run.js");
  }

  /* Which result source a run touches is decided by the set and the driver;
     the tokens themselves live in the source registry in elements.js, so
     adding a result source does not mean editing this file. */

  function fail(message, hint) {
    var e = new Error(message);
    e.name = "ConcurrentForcesError";
    if (hint) e.hint = hint;
    return e;
  }

  /* ------------------------------------------------------------ validation */

  /** Which quantity the criterion is applied to, and where it is read. */
  function resolveEffect(input, driverSource) {
    var El = mod("elements.js", "CfElements");
    if (input.effectId) {
      var hit = El.findComponent(input.effectId);
      if (!hit) throw fail("\"" + input.effectId + "\" is not a result quantity this " +
        "plugin knows.", "Choose one from the key effect list.");
      return hit;
    }
    /* No explicit effect: take the named component from the driver's own
       source, which is what the panel does before anything else is chosen. */
    var src = El.SOURCES[driverSource];
    var c = (src.components.filter(function (x) { return x.id === input.componentId; })[0]) ||
            src.components[0];
    return { source: driverSource, id: driverSource + ":" + c.column, column: c.column,
             label: c.label, unit: c.unit, sourceLabel: src.label };
  }

  /**
   * Everything that can be checked without touching a result table.
   * @returns {{members, classified, keyElemKey, effect, groups, blocked}}
   */
  function validateInputs(input) {
    var El = mod("elements.js", "CfElements");
    var Combos = mod("combos.js", "CfCombos");

    var parsed = El.parseSet(input.setText);
    if (parsed.errors.length) {
      throw fail("The item set could not be read: " + parsed.errors.join(" "),
        "Elements are plain numbers, nodes are N12, general links L12, elastic " +
        "links EL12, and ranges are written 15to20.");
    }
    if (!parsed.members.length) {
      throw fail("The element set is empty.",
        "Type the items to report on, pick a structure group, or both.");
    }

    var cls = El.classify(parsed.members, input);

    if (cls.missing.length) {
      throw fail("Not in the model: " + cls.missing.slice(0, 12).map(function (m) {
        return El.memberLabel(m.member);
      }).join(", ") + (cls.missing.length > 12 ? " and " + (cls.missing.length - 12) +
        " more" : "") + ".", cls.missing[0].reason.charAt(0).toUpperCase() +
        cls.missing[0].reason.slice(1) + ".");
    }
    if (cls.unsupported.length) {
      var u = cls.unsupported[0];
      throw fail("The set contains " + cls.unsupported.length + " item" +
        (cls.unsupported.length === 1 ? "" : "s") + " this plugin cannot report on: " +
        cls.unsupported.slice(0, 12).map(function (x) {
          return El.memberLabel(x.member) + " (" + x.type + ")";
        }).join(", ") + ".", u.reason);
    }

    var keyText = input.keyItemText != null ? input.keyItemText : input.keyElemText;
    var keyParsed = El.parseSet(keyText);
    if (keyParsed.errors.length || keyParsed.members.length !== 1) {
      throw fail("The key item must be a single element, node or link.",
        "One number for an element, N12 for a node, L12 or EL12 for a link.");
    }
    var keyKey = keyParsed.members[0].key;
    var member = cls.byKey[keyKey];
    if (!member) {
      throw fail("Key element " + keyKey + " is not a member of the element set.",
        "The key item nominates whose extreme picks the structural state, so it " +
        "has to be one of the items being reported — that is what makes the " +
        "answer checkable. Add it to the set, or choose a key item from the set.");
    }

    /* The driver names a SOURCE as well as an item. One item can appear in two
       tables — a node carries both a reaction and a displacement — and the
       criterion has to know which quantity it is ranging over. */
    var effect = resolveEffect(input, member.source);
    if (member.sources.indexOf(effect.source) < 0) {
      throw fail("Key item " + keyKey + " has no " + El.SOURCES[effect.source].label +
        " result.", "It is a " + member.typeLabel + ", which this plugin reads from " +
        member.sources.map(function (sid) { return El.SOURCES[sid].label; }).join(" and ") +
        ". Choose a key effect from one of those, or a key item that has this one.");
    }

    if (!input.selection || !input.selection.length) {
      throw fail("No load cases or combinations are selected.",
        "Tick at least one entry in the load case list.");
    }

    /* THE TREE WALK, to the leaves, before any result query. A combination
       three levels deep inherits a blocked constituent while looking clean
       from the outside — its own name carries no suffix at all, so nothing in
       the result table would ever say so. */
    var blocked = [];
    input.selection.forEach(function (name) {
      var b = Combos.blockages(input.loadModel, name);
      if (b.length) blocked.push({ name: name, reasons: b });
    });

    return {
      members: parsed.members, classified: cls, keyElemKey: keyKey,
      effect: effect, driver: member, groups: cls.groups, blocked: blocked
    };
  }

  function blockError(blocked) {
    var first = blocked[0];
    var r = first.reasons[0];
    var via = r.path.length > 1 ? " (reached through " + r.path.join(" → ") + ")" : "";
    return fail("\"" + first.name + "\" cannot give a concurrent set: it depends on " +
      r.leaf + via + ".", r.message);
  }

  /* --------------------------------------------------------------- queries */

  /** Which series to request, split by result family. */
  function partitionSelection(loadModel, selection, sense) {
    var Combos = mod("combos.js", "CfCombos");
    var out = { STD: [], CS: [] };
    selection.forEach(function (name) {
      var fam = Combos.familyOf(loadModel, name);
      var req = Combos.requestSeries(loadModel, name, sense);
      out[fam].push({ name: name, request: req, sense: sense });
      /* An envelope-valued name is a max/min PAIR. Both senses are requested so
         that a Min or Absolute-max criterion has something to choose from —
         asking for only the sense that matches the criterion would quietly
         make "absolute max" mean "max". */
      if (Combos.envelopeValued(loadModel, name)) {
        var other = sense === "min" ? "max" : "min";
        out[fam].push({ name: name, request: Combos.requestSeries(loadModel, name, other),
                        sense: other });
      }
    });
    return out;
  }

  function sensesFor(criterion) { return criterion === "min" ? "min" : "max"; }

  /**
   * One /post/TABLE per element type per family — never per element and never
   * per load case. On a 200-element set across 40 combinations that is the
   * difference between a handful of requests and eight thousand.
   */
  async function queryGroups(ctx, series, opts) {
    var Conc = mod("concurrent.js", "CfConcurrent");
    var El = mod("elements.js", "CfElements");
    var rows = [];
    var calls = [];

    /* One call per SOURCE per family — never per item and never per load case.
       On a 220-item set across forty combinations that is the difference
       between a handful of requests and eight thousand. */
    var sourceIds = El.SOURCE_ORDER.filter(function (sid) {
      return (ctx.groups[sid] || []).length;
    });

    for (var i = 0; i < sourceIds.length; i++) {
      var sid = sourceIds[i];
      var src = El.SOURCES[sid];
      var token = await tokenFor(ctx, sid);
      var keys = ctx.groups[sid].map(function (m) { return m.id; });

      /* The construction-stage family is a different MODE, not a filter, so it
         is a separate call — and it needs a stage, because with OPT_CS on and
         no stage every stage comes back interleaved and rows keyed on one
         stage overwrite each other. */
      var jobs = [];
      if (series.STD.length) {
        jobs.push({ optCs: false, stageStep: null,
                    series: series.STD.map(function (x) { return x.request; }) });
      }
      if (series.CS.length) {
        (opts.stageSteps || []).forEach(function (st) {
          jobs.push({ optCs: true, stageStep: st,
                      series: series.CS.map(function (x) { return x.request; }) });
        });
      }

      for (var j = 0; j < jobs.length; j++) {
        if (ctx.onProgress) {
          ctx.onProgress("Reading " + src.label + " · " +
            (jobs[j].optCs ? jobs[j].stageStep : "static and combination results"));
        }
        if (ctx.yieldToUi) await ctx.yieldToUi();
        var table = await ctx.mapi.postTable({
          token: token, keys: keys, series: jobs[j].series,
          optCs: jobs[j].optCs, stageStep: jobs[j].stageStep, unit: ctx.units
        });
        calls.push({ source: sid, token: token, optCs: jobs[j].optCs,
                     stageStep: jobs[j].stageStep, got: !!table });
        if (!table) continue;
        var parsed = Conc.parseTable(table, { source: src });
        if (parsed.unresolved.length) {
          throw fail("The " + token + " table did not return a " +
            parsed.unresolved.join(" or ") + " column, so its rows cannot be identified.",
            "The columns it returned were: " + parsed.head.join(", ") + ". Table " +
            "columns differ per table and this build's names are not the ones this " +
            "plugin knows for " + src.label + ".");
        }
        rows = rows.concat(parsed.rows);
      }
    }
    return { rows: rows, calls: calls };
  }

  async function tokenFor(ctx, sourceId) {
    var El = mod("elements.js", "CfElements");
    var src = El.SOURCES[sourceId];
    if (ctx.tokens[sourceId]) return ctx.tokens[sourceId];
    var keys = ctx.groups[sourceId].map(function (m) { return m.id; });
    var found = await ctx.mapi.resolveToken(src.tokens, keys.slice(0, 1), { unit: ctx.units });
    if (!found) {
      throw fail("This build has no result table for " + src.label + ".",
        "Tried " + src.tokens.join(", ") + ", and each answered with the \"error " +
        "creating utbl\" that means the token does not exist. Remove those items " +
        "from the set, or report the build so the token can be added.");
    }
    ctx.tokens[sourceId] = found.token;
    return found.token;
  }

  /**
   * Every requested series must be accounted for in the reply. An
   * unaddressable series is dropped SILENTLY at HTTP 200 with no error, so a
   * missing row is the only signal there is.
   */
  async function checkSeriesReturned(ctx, series, rows) {
    var Combos = mod("combos.js", "CfCombos");
    var wanted = series.STD.concat(series.CS);
    var absent = wanted.filter(function (s) {
      return !rows.some(function (r) {
        return Combos.matchesLabel(ctx.loadModel, s.name, s.sense, r.load);
      });
    });
    /* An envelope contributes two senses; only one is needed for the criterion
       in play, so a missing opposite sense is not a failure. */
    var byName = Object.create(null);
    wanted.forEach(function (s) { byName[s.name] = (byName[s.name] || 0) + 1; });
    var lost = absent.filter(function (s) {
      return absent.filter(function (o) { return o.name === s.name; }).length === byName[s.name];
    });
    if (!lost.length) return { partial: absent };

    var published = await diagnose(ctx);
    var names = uniq(lost.map(function (s) { return s.name; }));
    throw fail("The result table returned nothing for " + names.join(", ") + ".",
      published.length
        ? "The model publishes these series for this element: " +
          published.slice(0, 40).join(", ") +
          (published.length > 40 ? " (and " + (published.length - 40) + " more)" : "") +
          ". A combination's definition is not evidence that its constituents " +
          "produced results — one that names cases the analysis never generated " +
          "reads as empty rather than as an error."
        : "The model published no series at all for this element, which means " +
          "the analysis has not been run, or has been invalidated by an edit since.");
  }

  async function diagnose(ctx) {
    try {
      var El = mod("elements.js", "CfElements");
      var sid = El.SOURCE_ORDER.filter(function (k) { return (ctx.groups[k] || []).length; })[0];
      if (!sid) return [];
      return await ctx.mapi.enumerateSeries({
        token: ctx.tokens[sid] || await tokenFor(ctx, sid),
        keys: [ctx.groups[sid][0].id], unit: ctx.units
      });
    } catch (e) { return []; }
  }

  function uniq(list) {
    var seen = Object.create(null);
    return list.filter(function (v) { return seen[v] ? false : (seen[v] = true); });
  }

  /* ------------------------------------------------- time history step audit */

  /**
   * Time history is allowed only where step-by-step results were SAVED.
   *
   * A model holding max/min output only has envelopes, not states, and no
   * amount of filtering recovers a step that was never written. The audit is a
   * one-element query — cheap, and it runs before the bulk read.
   */
  async function auditTimeHistory(ctx, selection) {
    var Combos = mod("combos.js", "CfCombos");
    var Conc = mod("concurrent.js", "CfConcurrent");
    var El = mod("elements.js", "CfElements");

    var th = [];
    selection.forEach(function (name) {
      collectTh(ctx.loadModel, name, th, Object.create(null));
    });
    if (!th.length) return [];

    var sid = El.SOURCE_ORDER.filter(function (k) { return (ctx.groups[k] || []).length; })[0];
    var token = await tokenFor(ctx, sid);
    var table = await ctx.mapi.postTable({
      token: token, keys: [ctx.groups[sid][0].id],
      series: th.map(function (n) { return n + "(TH)"; }), unit: ctx.units
    });
    var rows = table ? Conc.parseTable(table, { source: El.SOURCES[sid] }).rows : [];

    var flagged = [];
    th.forEach(function (name) {
      var mine = rows.filter(function (r) {
        return Combos.matchesLabel(ctx.loadModel, name, null, r.load);
      });
      var steps = uniq(mine.map(function (r) { return String(r.step || "").toLowerCase(); }));
      var stepless = !mine.length || steps.every(function (s) {
        return s === "" || s === "max" || s === "min" || s === "maxmin" || s === "abs";
      });
      if (stepless) { ctx.loadModel.thStepless[name] = true; flagged.push(name); }
    });
    return flagged;
  }

  function collectTh(loadModel, name, out, seen) {
    if (seen[name]) return;
    seen[name] = true;
    var n = loadModel.nodes[name];
    if (!n) return;
    if (!n.isCombo) { if (n.kind === "TH") out.push(name); return; }
    n.children.forEach(function (c) { if (c.name) collectTh(loadModel, c.name, out, seen); });
  }

  /* ----------------------------------------------------- envelope resolution */

  /** Every series in a subtree, so the resolution can prefetch in one call. */
  function subtreeSeries(loadModel, name, sense, out, seen) {
    var Combos = mod("combos.js", "CfCombos");
    out = out || [];
    seen = seen || Object.create(null);
    if (seen[name]) return out;
    seen[name] = true;
    var n = loadModel.nodes[name];
    if (!n) return out;
    var enveloped = Combos.envelopeValued(loadModel, name);
    out.push({ name: name, request: Combos.requestSeries(loadModel, name, enveloped ? sense : null),
               sense: enveloped ? sense : null });
    if (!enveloped) return out;                 /* single-valued: nothing below matters */
    if (!n.isCombo) return out;
    n.children.forEach(function (c) {
      if (c.name) subtreeSeries(loadModel, c.name, sense, out, seen);
    });
    return out;
  }

  /**
   * A measurement callback for combos.resolveState: the value of the driver
   * component at the driver element and part, per requested series.
   *
   * Backed by a cache filled from one bulk prefetch per family, so the
   * recursive descent costs the same number of round trips as reading the
   * envelope directly did.
   */
  function makeMeasure(ctx, driver) {
    var Combos = mod("combos.js", "CfCombos");
    var Conc = mod("concurrent.js", "CfConcurrent");
    var El = mod("elements.js", "CfElements");
    var cache = Object.create(null);

    return { measure: measure, prefetch: prefetch, cache: cache };

    async function prefetch(requests) {
      var std = [], cs = [];
      requests.forEach(function (req) {
        var p = Combos.splitLabel(req);
        (p.kind === "CS" ? cs : std).push(req);
      });
      if (std.length) await load(std, false, null);
      if (cs.length && driver.stageStep) await load(cs, true, driver.stageStep);
    }

    async function load(requests, optCs, stageStep) {
      var src = El.SOURCES[driver.source];
      var token = await tokenFor(ctx, driver.source);
      var table = await ctx.mapi.postTable({
        token: token, keys: [driver.id], series: requests,
        optCs: optCs, stageStep: stageStep, unit: ctx.units
      });
      if (!table) return;
      var parsed = Conc.parseTable(table, { source: src });
      parsed.rows.forEach(function (r) {
        if (src.partCols && Conc.normPart(r.part) !== Conc.normPart(driver.part)) return;
        if (driver.stage && r.stage && r.stage !== driver.stage) return;
        if (driver.step && r.step && r.step !== driver.step) return;
        requests.forEach(function (req) {
          var p = Combos.splitLabel(req);
          if (!Combos.matchesLabel(ctx.loadModel, p.base, p.sense, r.load)) return;
          var v = r.values[ctx.component];
          if (v != null) cache[req] = v;
        });
      });
    }

    async function measure(requests) {
      var pending = requests.filter(function (r) { return !(r in cache); });
      if (pending.length) await prefetch(pending);
      var out = new Map();
      requests.forEach(function (r) { out.set(r, cache[r]); });
      return out;
    }
  }

  /* -------------------------------------------------------------- the run */

  /**
   * @param {Object} input
   *   mapi, elems, links, loadModel, setText, keyElemText, componentId,
   *   criterion, position, selection, units, stageSteps, onProgress, yieldToUi
   */
  async function runAnalysis(input) {
    var Combos = mod("combos.js", "CfCombos");
    var Conc = mod("concurrent.js", "CfConcurrent");
    var El = mod("elements.js", "CfElements");
    var Report = mod("report.js", "CfReport");

    var v = validateInputs(input);
    if (v.blocked.length) throw blockError(v.blocked);

    /* The driver is an ITEM plus an EFFECT, and the effect names its own result
       source. Nothing downstream assumes the driver is a beam, or an element,
       or even a member of a force table — a reaction or a displacement at a
       node picks the state exactly as well, because the join key does all the
       work of making the answer concurrent. */
    var effect = v.effect;
    var component = effect.column;

    var ctx = {
      mapi: input.mapi, loadModel: input.loadModel, groups: v.groups,
      units: input.units, component: component, effect: effect,
      tokens: Object.create(null),
      onProgress: input.onProgress, yieldToUi: input.yieldToUi
    };

    /* Time history needs one small query before the bulk read, because whether
       a case holds steps or only max/min is not in any definition. It is the
       one validation that cannot be done from /db/ alone. */
    if (ctx.onProgress) ctx.onProgress("Checking selected cases");
    var stepless = await auditTimeHistory(ctx, input.selection);
    if (stepless.length) {
      var again = [];
      input.selection.forEach(function (name) {
        var b = Combos.blockages(input.loadModel, name);
        if (b.length) again.push({ name: name, reasons: b });
      });
      if (again.length) throw blockError(again);
    }

    /* Construction-stage cases need a stage. Nothing else does. */
    var needsStages = input.selection.some(function (n) {
      return Combos.familyOf(input.loadModel, n) === "CS";
    });
    if (needsStages && !(input.stageSteps || []).length) {
      throw fail("A construction-stage case is selected but no stage and step is.",
        "Construction-stage results are a separate result family and one request " +
        "answers for one stage. Choose the stages and steps to search.");
    }

    var sense = sensesFor(input.criterion);
    var series = partitionSelection(input.loadModel, input.selection, sense);

    var q = await queryGroups(ctx, series, { stageSteps: input.stageSteps });
    if (!q.rows.length) {
      var pub = await diagnose(ctx);
      throw fail("The result tables came back empty for everything selected.",
        pub.length ? "The model publishes: " + pub.slice(0, 30).join(", ") +
          ". None of the selected cases is among them."
        : "The model has no results for these elements — it has not been analysed, " +
          "or an edit since the last run invalidated them.");
    }
    var partial = await checkSeriesReturned(ctx, series, q.rows);

    if (ctx.onProgress) ctx.onProgress("Locating the governing state");
    var gov = Conc.findGoverning(q.rows, {
      keyElemKey: v.keyElemKey, component: component, source: effect.source,
      criterion: input.criterion, position: input.position
    });
    if (!gov) {
      throw fail("No " + effect.sourceLabel + " row was found for key item " +
        v.keyElemKey + (El.SOURCES[effect.source].partCols ? " at " + input.position : "") +
        ".", "The item returned rows for other positions, or none at all. Check " +
        "the output position, and that the key item is one the selected cases " +
        "produce " + effect.sourceLabel + " for — a node with no restraint " +
        "publishes no reaction, for instance.");
    }

    /* ------------------ resolve, if the governing load is an envelope ------ */

    var govLabel = Combos.splitLabel(gov.row.load);
    var envelopeName = govLabel.base;
    var state = null, rows = q.rows, key = gov.row.key, missing = null;

    if (Combos.envelopeValued(input.loadModel, envelopeName)) {
      if (ctx.onProgress) ctx.onProgress("Resolving " + envelopeName + " to a single state");
      var driver = {
        id: v.driver.id, source: effect.source,
        part: gov.row.part, stage: gov.row.stage, step: gov.row.step,
        stageStep: stageTokenFor(input.stageSteps, gov.row.stage)
      };
      var m = makeMeasure(ctx, driver);
      var govSense = govLabel.sense || sense;
      await m.prefetch(subtreeSeries(input.loadModel, envelopeName, govSense)
        .map(function (s) { return s.request; }));

      state = await Combos.resolveState(input.loadModel, envelopeName, govSense, m.measure);

      /* Read the SET at the resolved state. Re-reading the envelope's own name
         at another element would return that element's independent extreme
         instead of the coexistent value — measured 72% out on a live model —
         so what is re-read here is only ever single-valued. */
      if (ctx.onProgress) ctx.onProgress("Reading the set at " + state.expression);
      var termSeries = { STD: [], CS: [] };
      state.terms.forEach(function (t) {
        var fam = Combos.familyOf(input.loadModel, t.name);
        termSeries[fam].push({ name: t.name, request: Combos.requestSeries(input.loadModel, t.name, null),
                               sense: null });
      });
      var tq = await queryGroups(ctx, termSeries, { stageSteps: input.stageSteps });
      var combined = Conc.combineTerms(tq.rows, state.terms, {
        label: state.expression,
        matches: function (r, name) {
          return Combos.matchesLabel(input.loadModel, name, null, r.load);
        }
      });
      rows = combined.rows;
      missing = combined.missing;
      key = state.expression + Conc.SEP + (gov.row.stage || "") + Conc.SEP + (gov.row.step || "");

      /* Gate the reconstruction against what MIDAS itself published, and say
         so in the report rather than assuming it held. */
      var check = rows.filter(function (r) {
        return r.elemKey === v.keyElemKey && r.source === effect.source &&
               r.key === key &&
               Conc.normPart(r.part) === Conc.normPart(gov.row.part);
      })[0];
      if (!check || check.values[component] == null) {
        throw fail("The resolved state produced no row at the key element, so it " +
          "cannot be checked against the envelope value MIDAS reports.",
          "Rather than print forces from a state that cannot be verified, the " +
          "run is stopped. Select the governing child combination directly.");
      }
      if (!Combos.close(check.values[component], gov.value)) {
        throw fail("The resolved state gives " + Conc.formatValue(check.values[component]) +
          " at the key element where " + envelopeName + " reports " +
          Conc.formatValue(gov.value) + ".",
          "The reconstruction is gated against the value MIDAS publishes and it " +
          "missed, so the result is discarded rather than reported. Select the " +
          "governing child combination directly and check it by hand.");
      }
      state.check = { reconstructed: check.values[component], published: gov.value };
    }

    /* --------------------------------- the concurrent set ------------------ */

    var order = v.members.map(function (m) { return m.key; });
    var set = Conc.concurrentSet(rows, key, { order: order, position: input.position });

    var reported = uniq(set.map(function (r) { return r.elemKey; }));
    var silent = order.filter(function (k) { return reported.indexOf(k) < 0; });

    var warnings = [];
    if (silent.length) {
      warnings.push("No row at this state for " + silent.join(", ") +
        " — those members produced no result for the governing load, which is " +
        "not the same as producing zero.");
    }
    if (v.classified.collisions.length) {
      /* Element, node and link ids are separate spaces that collide. Each
         member was taken as typed, which is right — but silence here is how a
         set addresses the wrong objects without anybody noticing. */
      var seenC = Object.create(null);
      var lines = [];
      v.classified.collisions.forEach(function (c) {
        var sig = c.id + "|" + c.taken + "|" + c.also;
        if (seenC[sig]) return;
        seenC[sig] = true;
        lines.push(El.keyOf(c.taken, c.id) + " also exists as " +
          El.NS_LABEL[c.also] + " " + c.id + " (" + El.keyOf(c.also, c.id) + ")");
      });
      warnings.push("Colliding ids, each taken as typed: " +
        lines.slice(0, 8).join("; ") +
        (lines.length > 8 ? " and " + (lines.length - 8) + " more" : "") + ".");
    }
    if (partial && partial.partial && partial.partial.length) {
      warnings.push("The opposite sense of " + uniq(partial.partial.map(function (s) {
        return s.name; })).join(", ") + " was not returned; only the sense the " +
        "criterion needs was used.");
    }
    (input.loadModel.warnings || []).forEach(function (w) { warnings.push(w); });

    var doc = Report.buildReport({
      keyElemKey: v.keyElemKey, component: component, effect: effect,
      criterion: input.criterion, position: input.position,
      governing: gov, state: state, envelopeName: envelopeName,
      rows: set, groups: v.groups, units: input.units,
      selection: input.selection, warnings: warnings, missing: missing,
      generated: input.generated || null
    });

    return {
      report: doc, governing: gov, state: state, key: key, effect: effect,
      rows: set, allRows: rows, calls: q.calls, tokens: ctx.tokens,
      classified: v.classified, warnings: warnings
    };
  }

  /** The stage/step token that covers a stage name reported in a result row. */
  function stageTokenFor(stageSteps, stage) {
    if (!stage) return (stageSteps || [])[0] || null;
    var hit = (stageSteps || []).filter(function (t) {
      return String(t).indexOf(stage) === 0;
    })[0];
    return hit || (stageSteps || [])[0] || null;
  }

  var api = {
    fail: fail, resolveEffect: resolveEffect,
    validateInputs: validateInputs, blockError: blockError,
    partitionSelection: partitionSelection, sensesFor: sensesFor,
    subtreeSeries: subtreeSeries, auditTimeHistory: auditTimeHistory,
    runAnalysis: runAnalysis, stageTokenFor: stageTokenFor
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfRun = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
