# Verified write payloads

Established by sweeping candidates against a live CIVIL NX 2026, not read from
documentation. These are shapes the API **accepts**.

Remember: **an error arrives as HTTP 200 (sometimes 201) with an `error` key**,
and one bad entry rejects a whole batch.

## Nodes

```json
{ "Assign": { "1": { "X": 0.0, "Y": 0.0, "Z": 0.0 } } }
```

## Elements

```json
{ "TYPE": "BEAM",  "MATL": 1, "SECT": 1, "NODE": [i, j],           "ANGLE": 0 }
{ "TYPE": "PLATE", "MATL": 1, "SECT": 1, "NODE": [n1, n2, n3, n4], "STYPE": 3 }
```

`STYPE: 3` is a thick plate.

**Reads come back with `NODE` zero-padded to 8 entries** — strip the trailing
zeros before use.

**A plate references its thickness through the element's `SECT` field.** There is
no separate thickness key on `ELEM`, and `SECT` ids and `THIK` ids are
independent spaces: for a plate, `SECT: 1` means `THIK` 1; for a beam it means
`SECT` 1.

## Materials — `/db/MATL`

```json
{ "TYPE": "CONC", "NAME": "C40/50",
  "PARAM": [ { "P_TYPE": 1, "STANDARD": "EN04(RC)", "DB": "C40/50" } ] }
```

- **`NAME` caps at 16 characters** — a 20-char name is rejected outright.
  (`SECT_NAME` accepts at least 19, so the caps differ per table. Check per
  table; do not assume one limit.)
- `STANDARD` must name a DB the install actually has. `EN05(RC)` answers
  `Failed to get material data for: C40/50` where `EN04(RC)` works.
- User-defined material: `P_TYPE: 2` with `ELAST` / `POISSON` / `THERMAL` / `DEN`.

## Thickness — `/db/THIK`

**`THIK` does not use `VSIZE` or `THIK_IN`** — all six such variants failed.

```json
{ "NAME": "...", "TYPE": "VALUE", "bINOUT": false,
  "T_IN": 250.0, "T_OUT": 0.0, "OFFSET": 0, "O_VALUE": 0.0 }
```

## Structure groups — `/db/GRUP`

```json
{ "NAME": "Deck", "P_TYPE": 0, "N_LIST": [1, 2, 3], "E_LIST": [101, 102] }
```

This shape is confirmed on the read side and used on the write side. If a
plugin's groups do not appear, this record shape is the first thing to check —
write it **after** the geometry and wrap it in its own try/catch so a wrong
schema degrades to a warning rather than rolling back a deck that was created
cleanly.

## Sections — `/db/SECT`

Section payloads vary by `SECTTYPE` and `SHAPE`. Two things to know before
reading or writing any of them:

**`SECTTYPE: "VALUE"` sections carry a `vSIZE` that is wrong.** It is the
dialog's "Size" box and nothing computes from it. One live section reported
`vSIZE = [1.8, 1.0]` (⇒ 1.8 m²) against a real area of 1.25 m². Proof that it is
decorative: three sections with vSIZE 1.8×1.0, 1.8×0.5 and 1.8×0.845 had
**identical** published properties. Never draw or compute a VALUE section from
`vSIZE`.

**But the stress points are exact.** For a solid VALUE section CIVIL NX reports
four, and they are its corners — on all 13 in one model the rectangle through
them equalled the published `Area` *and* `Peri:O` to the digit. Gate the
stress-point outline on the published area like any rebuild: pass ⇒ it is the
outline; fail (a box girder's 10 points hull past its void) ⇒ treat as schematic.

By contrast `DBUSER` with `DATATYPE: 2` is honest: `vSIZE = [0.4, 1.5]` ⇒ 0.6
= Area 0.600000 exactly, confirming the pair is (H, B).

**PSC and COMPOSITE-GEN sections carry an exact outline** at
`SECT_BEFORE.SECT_I.OUTER_POLYGON[0].VERTEX[] = [{X,Y},…]` — verified by shoelace
against `/ope/SECTPROP` Area to 0.00–0.28%. `VERTEX.X` is section-local **y** and
`VERTEX.Y` is local **z**, not global. **The polygon is open** — close it before
use. So a PSC deck section needs no shape-code reconstruction at all.

For `COMPOSITE-GEN` (`SHAPE: "CP_G"`) the `OUTER_POLYGON` is a vertex **pool**
with the connectivity in `SECT_I.LINE`; read naively it draws a bowtie.

`SECT_I.STIFF` duplicates the whole SECTPROP set, so `/ope/SECTPROP` is a
cross-check rather than a hard dependency.

### Shape codes — `PSCI` is not `CI`

| SECTTYPE | SHAPE | What it is |
|---|---|---|
| `PSC` | `PSCI` | standalone PSC-I |
| `PSC` | `1CEL` / `2CEL` / `VALU` | box girders, value section |
| `PSC` | `PSCM` / `PSCT` | PSC-MID, PSC-TEE |
| `COMPOSITE` | `CI` | PSC-I girder acting with a deck slab |
| `COMPOSITE` | `I` / `PC` / `Tub` | composite steel I, PSC value, steel tub |
| `TAPERED` | `CPCI` | tapered composite PSC-I |
| `COMPOSITE-GEN` | `CP_G` | general composite |

`CI` and `PSCI` are different codes for the same guide curve. Every model probed
in one project happened to be composite, so `CI` was the only code seen and was
assumed to be plain PSC-I — a standalone PSC-I model then reported an
unsupported shape the plugin had always been able to draw.

**A composite section's `SECT_BEFORE` is the girder alone.** Drawing from it and
calling the result the section leaves out a whole deck slab. On this API a
"section" is often only part of a section, and the offset point is measured on
the finished one.

**A tapered section is two sections.** `/ope/SECTPROP` sends it as
`[symbol, value_i, value_j]` **with no unit column** — read positionally, the
j-end number lands where the unit belongs. Read `HEAD`, treat a numeric third
column as the other end, and recover the unit from elsewhere in the response.
`Y_VAR`/`Z_VAR` carry the variation law (1 linear, 2 parabolic). Check the j-end
shape against the **j end's own** published area; checking it against the i end
passes a gentle taper and rejects a steep one.

Also from `/ope/SECTPROP`: it returns numbers as **text**, and `Qyb`/`Qzb` are
**length squared** — on a live rectangle they were exactly half the extreme fibre
squared, i.e. Q/b, not Q.

If the plugin needs a guide curve that is not settled here, do not infer it —
probe it. See `probing.md`.

## Tendons — `/db/TDNA`, `/db/TDNT`, `/db/TDPL`

- Profile points carry `R` **and** `RADIUS` as separate keys (plus `OPT`,
  `bBOTZ`) — not one field doubling as angle-or-radius.
- There is **no `CNT` key**.
- `TDNT.D_AREA` is duct **area**, not diameter.
- `TDPL` keys: `LCNAME / GROUP_NAME / TENDON_NAME / TYPE / ORDER / BEGIN / END /
  GROUTING`.

## Name and description length caps

Caps differ per table and are enforced silently in some UIs and hard in others.
Two measured: material `NAME` 16 characters; load combination name **20** and
description **60**. A generated-name scheme that overruns these will be rejected
or truncated at commit — size the scheme to the cap, and leave room for any
prefix MIDAS adds itself.
