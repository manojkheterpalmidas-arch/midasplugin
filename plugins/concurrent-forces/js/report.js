/* ==========================================================================
   Concurrent Forces — the report document
   --------------------------------------------------------------------------
   Pure. One resolver, dumb renderers: this module turns the analysis into ONE
   neutral document, and both the on-screen table and the CSV are walkers over
   it. Neither reads the model. That is what stops the two drifting apart, and
   a test asserts they carry the same blocks in the same order.

   Two conventions from the estate are load-bearing here:

   - A BLANK CELL STATES ITS OWN OPPOSITE. A truss element carries no shear or
     moment; printing an empty cell reads as "not computed" and gets reported
     as the plugin only producing half its output. Every empty cell carries a
     reason, and the reason is printed.
   - The header carries the FULL RESOLVED EXPRESSION, not just a combination
     name. That is what makes the table auditable by the next reviewer.
   ========================================================================== */
(function (root) {
  "use strict";

  function mod(name, globalName) {
    if (root[globalName]) return root[globalName];
    if (typeof require === "function") return require("./" + name);
    throw new Error(name + " must load before report.js");
  }

  /**
   * Build the report document.
   *
   * @param {Object} input
   *   keyElemKey, component (column name), componentId, criterion, position
   *   governing   {row, value, ties, candidates}
   *   state       the resolved state: { expression, single, resolvedName, terms, ties, notes }
   *               or null when the governing load needed no resolution
   *   rows        the concurrent set, already ordered
   *   groups      { BEAM:[members], TRUSS:[...], GENLINK:[...] }
   *   units       { FORCE, DIST }
   *   selection   [names] the load cases and combinations that were queried
   *   warnings    [string]
   *   missing     { elemKey: [term names] } from a composed state
   */
  function buildReport(input) {
    var Conc = mod("concurrent.js", "CfConcurrent");
    var El = mod("elements.js", "CfElements");

    var typeOf = Object.create(null);
    var sourcesPresent = [];
    /* Which items belong to which source. This is what tells an empty cell
       apart from an absent one: a node IS a member of the reaction source and
       simply produced no row, while a truss element is not a member of the beam
       source at all. Those are different facts and the cell must say which. */
    var memberOf = Object.create(null);
    Object.keys(input.groups || {}).forEach(function (sid) {
      if (!(input.groups[sid] || []).length) return;
      sourcesPresent.push(sid);
      memberOf[sid] = Object.create(null);
      input.groups[sid].forEach(function (m) {
        typeOf[m.key] = m.typeLabel;
        memberOf[sid][m.key] = true;
      });
    });

    var gov = input.governing;
    var key = gov ? Conc.describeKey(gov.row.key) : { load: "", stage: "", step: "" };
    var effect = input.effect;
    var effectUnit = El.unitLabel(effect.unit, input.units);

    /* ------------------------------------------------------------- header */

    var header = [
      { label: "Key item", value: memberText(input.keyElemKey, typeOf) },
      { label: "Key effect", value: effect.label + " — " + effect.sourceLabel +
          ", in " + effectUnit },
      { label: "Criterion", value: criterionText(input.criterion) },
      { label: "Output position", value: El.SOURCES[effect.source].partCols
          ? positionText(input.position)
          : "not applicable — " + effect.sourceLabel +
            (El.SOURCES[effect.source].partCols
              ? " report at the item's nodes"
              : " report one row per item") },
      { label: "Governing value", value: Conc.formatValue(gov ? gov.value : null) +
          " " + effectUnit },
      { label: "Governing load", value: key.load || "(none)" }
    ];

    if (input.state && !input.state.identity) {
      header.push({
        label: "Resolved",
        value: input.state.single
          ? input.envelopeName + " resolved to " + input.state.resolvedName
          : input.envelopeName + " resolved to " + input.state.expression,
        emphasis: true
      });
    }

    header.push({ label: "Stage / step",
      value: (key.stage || key.step) ? [key.stage, key.step].filter(Boolean).join(" / ")
                                     : "not staged — the model reports no stage or step" });
    header.push({ label: "Units", value: input.units.FORCE + ", " + input.units.DIST +
      " — every column carries its own unit in the header" });
    header.push({ label: "Items reported",
      value: String(Object.keys(typeOf).length) + " in the set, " +
        String(input.rows.length) + " rows at this state, from " +
        sourcesPresent.map(function (sid) { return El.SOURCES[sid].label; }).join(" and ") });
    header.push({ label: "Load cases queried",
      value: (input.selection || []).join(", ") || "(none)" });

    /* -------------------------------------------------------------- notes */

    var notes = [];
    if (gov && gov.ties && gov.ties.length) {
      notes.push("Near-tie at the key element: " + (gov.ties.length + 1) +
        " states reproduce the governing value to within " + Conc.TIE_REL +
        " relative (" + gov.ties.map(function (t) { return t.load; }).join(", ") +
        "). The first in query order was used.");
    }
    (input.state && input.state.ties || []).forEach(function (t) {
      notes.push("Near-tie resolving " + t.parent + " (" + t.sense + "): " +
        t.children.join(" and ") + " both reproduce " + Conc.formatValue(t.value) +
        ". The first in definition order was used.");
    });
    (input.state && input.state.notes || []).forEach(function (n) { notes.push(n); });
    Object.keys(input.missing || {}).forEach(function (k) {
      notes.push("Element " + k + " returned no rows for " +
        input.missing[k].join(", ") + " — its total omits those terms and is " +
        "reported for information only.");
    });
    (input.warnings || []).forEach(function (w) { notes.push(w); });

    /* ------------------------------------------------------------ columns */

    /* One column per distinct quantity across the sources actually present, in
       registry order. A reaction FX and a beam Axial are different quantities
       in different units, so they are different columns — merging them on the
       grounds that both are "a force" is how a table starts lying. */
    var columns = [
      { id: "item", label: "Item", kind: "text" },
      { id: "type", label: "Type", kind: "text" }
    ];
    var anyParts = sourcesPresent.some(function (sid) { return !!El.SOURCES[sid].partCols; });
    if (anyParts) columns.push({ id: "part", label: "Part", kind: "text" });

    var seenCol = Object.create(null);
    sourcesPresent.forEach(function (sid) {
      El.SOURCES[sid].components.forEach(function (c) {
        if (seenCol[c.column]) return;
        seenCol[c.column] = true;
        columns.push({
          id: c.column, kind: "number", component: c.id, unit: c.unit,
          /* Which source this column came from, so a cell that has no value can
             say WHY: because the item is of another kind entirely, or because
             its own table returned no row for it. Those are different facts. */
          source: sid,
          label: c.column + " (" + El.unitLabel(c.unit, input.units) + ")"
        });
      });
    });

    /* --------------------------------------------------------------- rows */

    var rows = input.rows.map(function (r) {
      var src = El.SOURCES[r.source] || null;
      var carried = Object.create(null);
      (src ? src.components : []).forEach(function (c) { carried[c.column] = true; });

      var cells = columns.map(function (col) {
        if (col.id === "item") return { text: r.elemKey, value: r.elemKey };
        if (col.id === "type") return { text: typeOf[r.elemKey] || (src ? src.noun : ""),
                                        value: typeOf[r.elemKey] || "" };
        if (col.id === "part") {
          return src && src.partCols
            ? { text: r.part, value: r.part,
                reason: src.partKind === "node"
                  ? "this source reports at the item's nodes, not at an I and a J end"
                  : null }
            : { text: "—", value: null,
                reason: "one row per item: " + (src ? src.label : "this source") +
                        " have no output position" };
        }
        if (!carried[col.id]) {
          /* Never a bare blank: an empty cell reads as "not computed", and a
             design-force table that showed blanks where the quantity simply
             does not exist was reported as producing half its output.

             Two different facts hide behind one empty cell, and the reader
             needs to know which. If the column's own source reads the SAME id
             space as this row, the item could have had this value and its
             table returned no row — a free node publishes no reaction. If the
             source reads a different id space, the quantity does not apply to
             this kind of item at all. */
          var colSrc = El.SOURCES[col.source];
          var belongs = !!(memberOf[col.source] && memberOf[col.source][r.elemKey]);
          return { text: "n/a", value: null,
                   reason: belongs
                     /* The item IS read from that table — it just produced no
                        row there. An unrestrained node is the usual case. */
                     ? colSrc.absent
                     /* The item is not read from that table at all. */
                     : (src ? src.absent : "not carried by this item type") +
                       " (" + col.id + " comes from " +
                       (colSrc ? colSrc.label : "another table") + ")" };
        }
        var v = r.values[col.id];
        if (v == null) {
          return { text: "—", value: null,
                   reason: "the result table returned no value in this column" };
        }
        return { text: Conc.formatValue(v), value: v };
      });

      return {
        cells: cells,
        isKey: r.elemKey === input.keyElemKey && r.source === effect.source,
        emphasis: (r.elemKey === input.keyElemKey && r.source === effect.source &&
                   sameRow(r, gov)) ? effect.column : null
      };
    });

    return {
      title: "Concurrent forces",
      header: header, notes: notes, columns: columns, rows: rows,
      generated: input.generated || null,
      meta: {
        keyElemKey: input.keyElemKey, component: effect.column,
        effectId: effect.id, source: effect.source,
        criterion: input.criterion, position: input.position,
        load: key.load, stage: key.stage, step: key.step,
        units: input.units,
        expression: input.state ? input.state.expression : key.load
      }
    };
  }

  /* The governing ROW, identified by element and part rather than by join key:
     where an envelope was resolved, the reported rows carry the resolved
     state's key and the governing row still carries the envelope's, so
     comparing keys would silently drop the emphasis on exactly the runs where
     it matters most. Every row here is already filtered to one state. */
  function sameRow(r, gov) {
    var Conc = mod("concurrent.js", "CfConcurrent");
    return !!gov && r.elemKey === gov.row.elemKey &&
      Conc.normPart(r.part) === Conc.normPart(gov.row.part);
  }

  function memberText(key, typeOf) {
    var t = typeOf[key];
    return key + (t ? " (" + t + ")" : "");
  }

  function criterionText(id) {
    var c = (root.CfConcurrent || require("./concurrent.js")).CRITERIA
      .filter(function (x) { return x.id === id; })[0];
    return c ? c.label : id;
  }

  function positionText(id) {
    var p = (root.CfConcurrent || require("./concurrent.js")).POSITIONS
      .filter(function (x) { return x.id === id; })[0];
    return p ? p.label : id;
  }

  /* ------------------------------------------------------------------ CSV */

  /**
   * CSV mirroring the on-screen table, with the header block as comment lines.
   *
   * Numbers go out as NUMBERS — Excel must never receive a locale-formatted
   * string, so the typed accessor is used here and the display text is not.
   */
  function toCsv(doc) {
    var out = [];
    out.push("# " + doc.title);
    doc.header.forEach(function (h) { out.push("# " + h.label + ": " + h.value); });
    if (doc.generated) out.push("# Generated: " + doc.generated);
    doc.notes.forEach(function (n) { out.push("# Note: " + n); });
    out.push("# n/a = the component is not carried by that element type; " +
             "an empty value means the result table returned none.");
    out.push(doc.columns.map(function (c) { return csvCell(c.label); }).join(","));
    doc.rows.forEach(function (r) {
      out.push(r.cells.map(function (cell, i) {
        if (doc.columns[i].kind === "number") {
          if (cell.value == null) return cell.text === "n/a" ? "n/a" : "";
          return String(cell.value);
        }
        return csvCell(cell.text);
      }).join(","));
    });
    return out.join("\r\n") + "\r\n";
  }

  function csvCell(s) {
    var t = String(s == null ? "" : s);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  var api = { buildReport: buildReport, toCsv: toCsv };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfReport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
