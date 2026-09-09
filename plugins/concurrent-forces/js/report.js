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

    var groupOf = Object.create(null);
    var typeOf = Object.create(null);
    Object.keys(input.groups || {}).forEach(function (g) {
      (input.groups[g] || []).forEach(function (m) {
        groupOf[m.key] = g;
        typeOf[m.key] = m.typeLabel;
      });
    });

    var gov = input.governing;
    var key = gov ? Conc.describeKey(gov.row.key) : { load: "", stage: "", step: "" };
    var momentUnit = input.units.FORCE + "·" + input.units.DIST;

    /* ------------------------------------------------------------- header */

    var header = [
      { label: "Key element", value: memberText(input.keyElemKey, typeOf) },
      { label: "Key component", value: componentText(input.componentId, input.component,
          input.units, momentUnit) },
      { label: "Criterion", value: criterionText(input.criterion) },
      { label: "Output position", value: positionText(input.position) },
      { label: "Governing value", value: Conc.formatValue(gov ? gov.value : null) + " " +
          (isMoment(input.componentId) ? momentUnit : input.units.FORCE) },
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
      " (moments in " + momentUnit + ")" });
    header.push({ label: "Elements reported",
      value: String(countMembers(input.groups)) + " in the set, " +
        String(input.rows.length) + " rows at this state" });
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

    var present = Object.keys(input.groups || {}).filter(function (g) {
      return (input.groups[g] || []).length;
    });
    var carried = Object.create(null);
    present.forEach(function (g) {
      (El.GROUP_COMPONENTS[g] || []).forEach(function (c) { carried[c] = true; });
    });

    var columns = [
      { id: "elem", label: "Element", kind: "text" },
      { id: "type", label: "Type", kind: "text" },
      { id: "part", label: "Part", kind: "text" }
    ];
    El.COMPONENTS.forEach(function (c) {
      if (!carried[c.column]) return;
      columns.push({
        id: c.column, kind: "number", component: c.id,
        label: c.column + " (" + (isMoment(c.id) ? momentUnit : input.units.FORCE) + ")"
      });
    });

    /* --------------------------------------------------------------- rows */

    var rows = input.rows.map(function (r) {
      var group = r.group || groupOf[r.elemKey] || null;
      var cells = columns.map(function (col) {
        if (col.id === "elem") return { text: r.elemKey, value: r.elemKey };
        if (col.id === "type") return { text: typeOf[r.elemKey] || "", value: typeOf[r.elemKey] || "" };
        if (col.id === "part") return { text: r.part, value: r.part };
        var carriedHere = !group || (El.GROUP_COMPONENTS[group] || []).indexOf(col.id) >= 0;
        if (!carriedHere) {
          /* Never a bare blank: an empty cell reads as "not computed". */
          return { text: "n/a", value: null,
                   reason: El.NOT_CARRIED[group] || "not carried by this element type" };
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
        isKey: r.elemKey === input.keyElemKey,
        emphasis: (r.elemKey === input.keyElemKey && sameRow(r, gov)) ? input.component : null
      };
    });

    return {
      title: "Concurrent forces",
      header: header, notes: notes, columns: columns, rows: rows,
      generated: input.generated || null,
      meta: {
        keyElemKey: input.keyElemKey, component: input.component,
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

  function countMembers(groups) {
    return Object.keys(groups || {}).reduce(function (n, g) {
      return n + (groups[g] || []).length;
    }, 0);
  }

  function isMoment(componentId) { return /^M/.test(String(componentId || "")); }

  function memberText(key, typeOf) {
    var t = typeOf[key];
    return key + (t ? " (" + t + ")" : "");
  }

  function componentText(id, column, units, momentUnit) {
    return id + " — " + column + ", in " + (isMoment(id) ? momentUnit : units.FORCE);
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

  var api = { buildReport: buildReport, toCsv: toCsv, isMoment: isMoment };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.CfReport = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
