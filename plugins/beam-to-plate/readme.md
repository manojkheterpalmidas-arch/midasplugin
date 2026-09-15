# Beam to Plate — MIDAS CIVIL NX

Replaces beam elements with a plate mesh of their cross-section **walls**: a
girder becomes two flanges and a web, a box becomes four walls, a pipe becomes a
faceted ring. Built with the `midasplugin` skill, from `assets/template`.

It **writes to the model** — `/db/NODE`, `/db/ELEM`, `/db/THIK` and `/db/GRUP` —
and nothing is written until you press **Write to model**. The only POST it is
permitted to make is `/view/CAPTURE`, and the only delete it can express is a
single `/db/ELEM` row. Those limits are whitelists in `js/mapi.js`, and the
offline suite asserts them.

## What it does

1. Reads `NODE`, `ELEM`, `SECT`, `MATL`, `THIK` and `GRUP`.
2. Interprets every section used by the selection as a **wall model** —
   centrelines in section-local (y, z) with a thickness each.
3. **Checks each wall model's area against the area the model publishes for that
   section**, and refuses to convert one that misses.
4. Meshes each beam: stations along the member, pieces across each wall, nodes
   shared wherever walls or members meet.
5. Shows the cross-sections, the mesh, the counts and a volume check.
6. On Write: re-reads the model, writes thicknesses, nodes and plates, **reads
   every id back**, verifies the plates landed, then writes the group.

## The area check, and why it is the centre of the design

Of everything this plugin needs to know about a section, exactly one thing has
been measured on a live CIVIL NX: for a `DBUSER` section with `DATATYPE: 2`,
`vSIZE = [0.4, 1.5]` published `Area 0.600000` exactly, so the pair is **(H, B)**.

Every other dimension order in `js/section.js` — the six numbers of an I-girder,
the box, the channel, the tee, the angle, the pipe — is an informed reading of
the section dialog and is marked `verified: false` in the code. They are the
kind of thing that is right until it is not, and a wrong order produces a
section of plausible size and wrong shape.

So nothing is trusted on its own:

- every wall layout is built so that **sum(thickness x centreline length) equals
  the shape's exact gross area**, which makes the area a real function of the
  dimension order;
- that area is compared against what the model publishes for the section
  (`SECT_I.STIFF`, which duplicates the `/ope/SECTPROP` set);
- a section that misses by more than 2% is **not converted** — it is shown in
  red with both numbers, and you either correct the dimensions in place or tick
  "convert anyway" deliberately;
- a section that publishes **no** area reports "no area published", never a pass.

A dimension list read in millimetres against coordinates in metres misses by a
factor of a million, so the same check catches that too.

**If a shape's dimensions come out wrong on your model, type them in.** The
dimension cells are editable, the check reruns as you type, and the conversion
proceeds from what you entered. That is the intended workflow for any section
whose order this plugin has not settled — and if you settle one, the fix belongs
in `SHAPES` in `js/section.js` with `verified: true`.

## What it converts

| Shape | Wall model |
|---|---|
| `H` I / H | two flanges and a web |
| `B` box | two flanges and two webs (the dialog's `C` is not used) |
| `T` tee | flange and web |
| `C` channel | two flanges and a web |
| `L` angle | two legs |
| `P` pipe | a faceted ring at the mid-wall radius |
| `SB` solid rectangle | **one** plate through the mid-plane, of thickness B |

## What it refuses, and why

These are refusals with reasons, not failures:

- **`VALUE` sections.** Their `vSIZE` is the dialog's Size box and nothing
  computes from it — three live sections with different `vSIZE` published
  identical properties. There is no geometry to convert.
- **PSC.** The `OUTER_POLYGON` is exact, but it is the *solid* outline of a
  section with voids. Meshing a box girder as plates needs the void outlines
  too, and those are not settled.
- **COMPOSITE.** `SECT_BEFORE` is the girder alone; converting from it would
  silently drop the deck slab.
- **COMPOSITE-GEN.** The `OUTER_POLYGON` is a vertex pool with the connectivity
  in `SECT_I.LINE`; read naively it draws a bowtie.
- **TAPERED.** Two sections, i and j. It needs a mesh that varies along the
  member.
- **Solid round, double angle, double channel.**
- Anything that is not a `BEAM` element, and any beam whose nodes are missing.

## Limitations you must know before using the output

- **The plate mesh is not connected to the rest of the frame.** Nodes are shared
  where the generated geometry coincides (and, with "Reuse existing nodes" on,
  with nodes the model already had at the same point), but a beam meeting the
  mesh end-on connects at one node only. Joining a beam to a plate end section
  properly needs **rigid links, which this plugin does not write**.
- **Loads, supports and releases on a converted beam are not migrated.** They
  stay on the beam. If you delete the beam they are left pointing at nothing.
  Deleting the sources is off by default for that reason.
- The wall model is a **thin-walled idealisation**: root fillets, haunches,
  tapers and stiffeners are not represented, and a solid section becomes a plate
  whose weak-axis behaviour is a thickness rather than a shape.
- Section **stiffeners and diaphragms** are not generated.

## Verified, and not

Measured on a live CIVIL NX 2026 (through the skill's references):

- error semantics, `/db/` read statuses, `PUT` upsert and the
  append-at-next-free-slot behaviour — the whole write path is built on these;
- the THIK record shape (`T_IN`/`T_OUT`, not `VSIZE`/`THIK_IN`);
- a plate's thickness is referenced through the element's `SECT` field, and
  `SECT` ids and `THIK` ids are independent spaces;
- `DBUSER` `DATATYPE: 2` `vSIZE` is (H, B).

**Not verified, and stated in the UI as well as here:**

- every dimension order except `SB` (see above);
- the **sign of the beta angle** rotation. A wrong sign spins the section about
  the member and changes nothing numeric — check the picture, not the numbers;
- the **fallback axes for a member parallel to global Z**. Local z is taken along
  global X, which is the documented convention for a vertical member, but it was
  not measured;
- **which point of the section the node line passes through.** It is offered as
  a choice — centre of the section (the dialog's Center-Center) or the centroid
  — defaulted to the first. Getting it wrong shifts the mesh sideways; it does
  not distort it.

Settling any of these is a probe, not a guess: write a scratch model, perturb
one dimension at a time, read the published properties back. See
`references/probing.md` in the skill.

## Run it without CIVIL NX

```bash
node mock-midas/server.js
```

Then open — over **HTTP, never `file://`**:

```
http://localhost:8773/index.html?mapiKey=mock-key&redirectTo=http://localhost:8773/civil
```

The mock carries ten sections covering every supported shape, a VALUE section, a
PSC section, and one section whose published area and dimension list genuinely
disagree, so the area check has something real to catch.

## Run the tests

```bash
node test/run.js
```

134 assertions against the mock over real HTTP. The two that matter most:

- **the area gate** — each section's area, computed by the plugin from `vSIZE`,
  against an area the mock states as a hand-computed literal;
- **the volume invariant** — for every element, the sum over generated plates of
  (area x thickness) must equal section area x member length. A wrong local
  axis, a dropped subdivision or a bad node merge breaks it.

## Run it in CIVIL NX

```powershell
..\..\assets\scripts\pack.ps1 -Source . -Out "$env:USERPROFILE\Downloads\Beam to Plate v1.0.0.zip"
..\..\assets\scripts\verify-zip.ps1 -Source . -Zip "$env:USERPROFILE\Downloads\Beam to Plate v1.0.0.zip"
```

`pack.ps1` excludes `test/`, `mock-midas/` and `package.json`, writes
forward-slash separators (`Compress-Archive` does not) and refuses to finish
unless `index.html` is at the zip root.

## What is where

| File | Role |
|---|---|
| `js/mapi.js` | the API client — error semantics, and the POST/PUT/DELETE whitelists that back the header claim |
| `js/section.js` | SECT row → wall model, the shape tables, and the area gate |
| `js/mesh.js` | element local axes, the node pool, and the mesh itself |
| `js/plan.js` | reading, selecting, the section study, the size estimate, the plan |
| `js/commit.js` | the only file that writes: drift check, id read-back, verification |
| `js/draw.js` | the cross-section and mesh drawings |
| `js/app.js` | wiring only |
| `mock-midas/server.js` | the API and the static files, from one process |
| `test/run.js` | the offline suite |

## Things not to undo

- The area gate. Without it the plugin is a confident guess about six numbers.
- The id read-back in `commit.js`. `Assign` at a key that does not exist ignores
  the number and appends at the next free slot, and a plate mesh is nothing but
  ids.
- The drift check. A plan built minutes ago describes a model the user may have
  edited since.
- `MAX_PLATES` in `app.js`. `buildPlan` is synchronous, and a synchronous minute
  is a plugin whose close button does not respond.
- The group being written **last**, in its own try/catch, so a schema
  disagreement degrades to a warning rather than losing a mesh that landed
  cleanly.
