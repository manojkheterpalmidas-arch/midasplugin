# Settling an unknown API shape by probing

Reach for this whenever a payload shape, an array order or a field's meaning is
unknown. It replaced a session of inference that turned out to be wrong in four
separate ways, and it settled the PSC section guide curves **exactly** — 0.000%
error on 48 live sections.

The principle: **do not infer a shape, write it and read the consequences back.**

## The method

1. **Open an empty CIVIL NX model** (not the user's) and POST candidates over
   `/db/<TABLE>`.

2. **Perturbation sweep.** One record per dimension — each a copy of a real
   record with that one slot increased by a small amount — all in **one**
   `Assign` body. Then a single `/ope/SECTPROP` (or equivalent read) returns them
   all. Comparing `Area`, width, depth, perimeter and stress points row by row
   says which slot is a height, which is a width, and which is on the
   extreme-fibre path. About 100 records cost two round trips.

3. **Designed ladder.** From a clean symmetric baseline with obvious hand
   arithmetic, switch dimensions on one at a time. This pins each rule exactly
   rather than merely classifying it.

4. **Clean up.** `DELETE /db/<TABLE>` empties it; re-POST the originals.

## Traps in the method itself

- **An error can come back as HTTP 201 with an `error` key**, and **one bad entry
  rejects the whole `Assign` batch**. Post ladder cases individually.
- **A rejection is evidence.** `"Section Dimensions has(have) been incorrectly
  entered."` usually means a JOINT flag is on with its dimension zero — that
  rejection is what pairs joints to dimensions, and it was the only way to find
  one family's width ordering.
- **Stress points are relative to the centroid.** Add `Center:y` to place them
  from the left edge. They locate the four corners exactly.
- **Prove the channel before believing a uniform failure.** A harness bug
  (arguments in the wrong order) presented as "the program rejects everything".
  Re-post a known-good payload verbatim first.

## Reading a shape without writing at all

Try this before writing probe records: **area + perimeter + centroid pin a
dimensioned shape exactly.** Several section families were settled read-only that
way, from sections already in a real model. Writing is only needed when the model
to hand does not contain the shape in question.

## Gate every rebuild on a published quantity

Whatever the plugin reconstructs — an outline, a property, a geometry — check it
against a number MIDAS publishes independently (area is usually the right one),
and **discard the reconstruction when it misses**. Fall back to listing the
dimensions by name, which is what a reader can actually check against the dialog
in front of them.

This gate is not defensive padding. Over one version it turned two wrong drawings
into two honest dimension listings instead of shipping confident nonsense, and it
is what caught four separate errors in a shape that had shipped for six versions
— every one of them in the direction that made a girder look bigger than it is.

## Matching an unknown code

When a shape code is not recognised, match the record by its **array-length
signature** as a secondary key. Aliases collapse onto one another correctly, and
genuinely distinct shapes that happen to share a signature then match nothing —
which is the right answer, not a failure.

Mark anything settled this way **provisional** in the readme until a live model
confirms it.
