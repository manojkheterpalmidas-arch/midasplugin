# Beam to Plate — MIDAS CIVIL NX

**Version 2.0.0** · MIDAS IT EUROPE · [manoj@midasit.com](mailto:manoj@midasit.com)

Replaces beam elements with a plate mesh of their cross-section, and brings the
rest of the model with it: the supports and elements at each end stay connected
through rigid links, the beam loads become nodal loads on the plates, and the
structure groups keep their members so construction stages still work.

It converts **any section CIVIL NX will give geometry for** — rolled and
fabricated steel, PSC girders and box girders, composite and general composite
sections, tapered members, value sections and catalogue sections — and says
plainly, per section, how close the plate model is to the section it replaces.

## Use

1. **Select the beams in CIVIL NX**, or pick them here by section, by structure
   group, or by element id. The plugin reads the live selection.
2. **Read model & plan.** Nothing is written. You get every section's
   interpretation with two checks, the mesh it would build, the links it would
   add, the loads it would move, and what would be left behind.
3. Correct anything that needs correcting — a dimension, a material for a deck
   slab, the mesh size.
4. **Write to model.** Then **Undo the conversion** if you want it back: the
   plates, their nodes, the links and the converted loads are removed and the
   beams are put back, with their loads.

## The two checks, and why there are two

Each section is measured twice against what CIVIL NX itself publishes for it in
`/ope/SECTPROP`:

**Read** — does the outline the plugin built from the section data reproduce the
published area and second moments? A miss here means the dimensions were read
wrongly, and the section is not converted until you say so. This is what catches
a dimension list in an order this plugin does not know.

**Plates** — how far is the plate model from the section? Walls overlap where
they meet and a thick wall is idealised to a line, so a few percent here is
idealisation, not error. Above 15% the section is held back.

**Match beam stiffness** (on by default for idealised shapes) closes the gap: the
plate thicknesses are adjusted — smoothly, by a few percent, the smallest change
that will do it — until the mesh has the section's own area, centroid, Iyy and
Izz. Where the geometry cannot carry a condition (a section meshed as one flat
plate has no lever arm across itself, so its Izz is whatever its thickness gives)
the plugin says so rather than pretending.

## Where the geometry comes from

| Source | Sections |
|---|---|
| Its dimensions, with a wall layout measured on a live CIVIL NX | I/H, box, tee, channel, angle, pipe, double angle, double channel, inverted tee, octagon, track, solid shapes |
| Its guide curve | PSC-I, PSC-MID, PSC-TEE, 1-cell and 2-cell boxes, composite PSC |
| The outline in the model | PSC value sections, general composite parts, anything carrying an `OUTER_POLYGON` |
| Its stress points | a value section whose four points enclose its published area — they are its corners |
| A catalogue fit | `DATATYPE 1` sections: the API gives a name and no dimensions, so they are recovered from the published properties. On a rolled I the shear areas give them directly (`Asz = tw·H`, `Asy = ⅚(B1·tf1 + B2·tf2)`, verified against a live UC 356×406×287) |
| An equivalent section | a value section with no usable geometry: an I, box, channel or tee fitted to its area, second moments and centroid. Labelled **equivalent** everywhere it appears — it is not the real shape |

Outlines that are not a known thin-walled shape are turned into walls by the
**chordal axis** of a conforming triangulation: the centreline of every wall with
its own thickness, with junctions moved to where the walls' centrelines meet and
free ends carried out to the section's face. Compact solids with no voids become
one mid-plane plate whose thickness follows the width at each level, which is
exact for area and both second moments on any shape symmetric about that plane.

## What comes across, and what does not

**Carried over:** beam loads (uniform, trapezoidal, concentrated, moments,
pressure, eccentric, projected), element temperatures, structure groups, beam end
offsets (the mesh starts at the offset end and the link spans the rigid zone).

Beam loads become nodal loads with the **resultant preserved exactly** — the same
force and the same moment about any point. Checked against the base reactions
CIVIL NX reported for the same loads on a real cantilever: eight load types, all
matching to fifteen decimal places.

**Left behind, and listed before you write:** tendons and their prestress, lanes,
composite sections for construction stage, stiffness scale factors, temperature
gradients, beam section temperatures, inelastic hinges, fibre divisions, tapered
section groups. None of these can follow a beam into plates. They are reported
against the elements they belong to, because deleting the beam takes them with it.

## Limits worth knowing

- **A plate model is more flexible than a beam model, and that is the point.** A
  wide box girder shows shear lag and cross-section distortion a beam cannot: on
  the verification model the PSC box deflects 8.5% more. The steel sections
  agreed within about 2%.
- **A rigid link makes the section rigid where it lands.** Links are written only
  where a node carries something else; a member end with nothing on it gets none.
- **End releases are not converted.** A released beam end becomes a rigid
  connection. Elements with releases are listed before you write.
- **Lopsided solid sections** — a precast edge beam, say — cannot be represented
  by one plate to better than about 9% on their weak axis. The plugin reports it.
- **Torsion is not matched.** The checks cover area, centroid and both second
  moments; a plate mesh's torsional stiffness is whatever the closed or open
  shape gives.
- Mesh size is yours to choose. A coarse mesh is a poor plate model however
  exactly its section was read.

## Verified against a live CIVIL NX

Built and checked against CIVIL NX 2026 on 15–16 September 2026.

- **Geometry conventions measured, not assumed.** One section per shape code was
  written to a live model and its properties read back: the I section's top
  flange, the box's web spacing (`C` is centre-to-centre — webs at the outer
  faces give Izz 60% too high), the angle's leg at the top, the double shapes'
  gap, the inverted tee's flange. The offset letters, `OFFSET_CENTER` and the
  user-offset reference were settled by analysis, as was the beta-angle sign and
  the local axes of vertical members.
- **A whole model converted and compared.** Four structures — a two-span
  continuous I girder, a simply supported steel box on a top offset, a four-span
  PSC box girder, and a pier at a 30° beta angle under a three-component tip load
  — were analysed as beams, converted (13 beams → 2,784 plates, 2,908 nodes, 10
  links, 2,859 loaded nodes), and analysed again. **Total reactions matched
  exactly.** Deflections: I girder −2.2%, steel box −1.9%, pier −0.3% to −0.7%,
  PSC box +8.5%.
- **Undone and re-checked.** The undo put the model back to the digit: every
  displacement identical to the original beam analysis.

## Run it without CIVIL NX

```
node mock-midas/server.js
```

then open `http://localhost:8773/index.html?mapiKey=mock-key&redirectTo=http://localhost:8773/civil`.

The mock's section library is not invented: it is 26 real sections as CIVIL NX
returned them, each with the properties CIVIL NX computed for it.

```
node test/run.js     # 171 assertions, no CIVIL NX needed
```

## What is where

| File | Role |
|---|---|
| `js/mapi.js` | the API client: error semantics, the write/delete whitelists, batched row deletes |
| `js/geom2d.js` | polygon properties, conforming triangulation, the chordal axis |
| `js/walls.js` | the wall layouts, outline → walls, thickness calibration |
| `js/sect-shape.js` | section outlines (shared with Model Report) |
| `js/section.js` | a `/db/SECT` row → wall models per end, placed on the node line, with the checks |
| `js/mesh.js` | local axes, the node pool, meshing, tapered interpolation |
| `js/loads.js` | beam loads → nodal loads, resultant preserved |
| `js/model.js` | where links are needed, which groups to join, what is left behind |
| `js/plan.js` | reading the model and building the plan — writes nothing |
| `js/commit.js` | the only writer, and the undo |
| `js/draw.js` | the section and mesh drawings |
| `mock-midas/` | the offline CIVIL NX, and its live-derived section library |
| `test/run.js` | the offline suite |

## Things not to undo

- **The two checks.** Without them the plugin is a confident guess about a list
  of numbers whose order it cannot see.
- **The id read-back in `commit.js`.** Node ids are matched by coordinate after
  they are written, never assumed.
- **The drift check.** The model is re-read and compared with the plan before
  anything is written.
- **The client's whitelists.** No whole-table delete exists in it: `DELETE
  /db/SECT` empties a section library, and a delete with a body was measured
  doing exactly that.
- **Loads before deletion.** Deleting a beam deletes its beam loads, so the
  converted loads are written first.
