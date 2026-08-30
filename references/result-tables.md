# Result tables — `POST /post/TABLE`

How a plugin reads analysis results. Measured on a live CIVIL NX 2026 model
(1736 plates, 580 elastic links, 78 combinations). The Argument shape below came
from MIDAS's own shipped Load Combination Analyzer bundle, not from guesswork.

## The Argument shape

```json
{"Argument":{
  "TABLE_NAME": "myplugin",
  "TABLE_TYPE": "ELASTICLINK",
  "UNIT": { "FORCE": "kN", "DIST": "m" },
  "NODE_ELEMS": { "KEYS": [12, 13, 14] },
  "LOAD_CASE_NAMES": ["EC_ENV_U610A(CB:max)"],
  "STYLES": { "FORMAT": "Scientific", "PLACE": 8 }
}}
```

- **`TABLE_NAME` is a response label you choose.** The reply comes back as
  `{ "<TABLE_NAME>": { "HEAD": [...], "DATA": [[...]] } }`. It is **not** the
  table token — that is `TABLE_TYPE`.
- **`UNIT: {}` fails**, and a stray `EXPORT_PATH` makes the call fail too.
- Construction stage entry is `"STAGE_STEP": ["<step>"]` plus `"OPT_CS": true`.
- `STYLES` overrides the model's display precision. `Scientific` / `PLACE: 8`
  gives nine significant figures at any magnitude — necessary if the plugin
  self-validates its arithmetic against what MIDAS reports.

The model must be **analysed**. Unanalysed, tables answer
`"[T] Cannot generate table data as there is no analysis result."`

## Table tokens

Tokens are not guessable and a wrong one is not obviously wrong — it answers
`"there was an error creating utbl. (ex PostMode ...)"`, which reads like an
un-analysed model.

Verified node-table tokens carry a **coordinate suffix**:

| Want | Token | Components |
|---|---|---|
| Reactions | **`REACTIONG`** | `FX FY FZ MX MY MZ` |
| Displacements | **`DISPLACEMENTG`** | `DX DY DZ RX RY RZ` |

The bare `REACTION` / `DISPLACEMENT` **do not exist**. Neither do `REACTIONL` /
`DISPLACEMENTL`, which answer `{"message":""}`. Same trap as
`PLATEFORCE` / `PLATEFORCEL`.

Other tokens confirmed in use: `ELASTICLINK`, `BEAMFORCE`, `PLATEFORCE`,
`TNDN_COORDINATES` (recognised but fails opaquely with `"Unknown Error"` on every
argument shape tried against an **un**analysed model — unverified against an
analysed one).

## HEAD key columns differ per table

Never assume `Elem` / `Part`:

| Table | Item column | Part column |
|---|---|---|
| `ELASTICLINK` | `No.` | `Node` |
| plate / beam | `Elem` | `Node` |
| node tables | `Node` | — |

Parse `HEAD` and find the columns by name.

## Load-case series naming

Request suffixes: `Name(ST)`, `Name(CB)`, `Name(CB:max)`, `Name(CB:min)`,
`Name(CB:all)`.

Response labels **drop the kind**: `Name` or `Name(max)`.

**Load case names may themselves contain parentheses** — e.g.
`Lateral Earth Pressure (LHS)(1)`. Never parse the label with a greedy paren
regex.

## The addressing trap: the suffix must match envelope-valuedness exactly

Get it wrong and the call returns `{"message": ""}` with **HTTP 200 — silently.
No error, no partial result.** In a mixed request the bad series are dropped and
the good ones returned, so **a missing row is the only signal**.

Measured:

| Request | Result |
|---|---|
| `ULS610-1(CB)` — Add of pure static cases | OK |
| `ULS610-1(CB:max)` — same, with a sense | **nothing** |
| `ENV-Hydro-1(CB)` — Envelope, no sense | **nothing** |
| `ENV-Hydro-1(CB:max)` | OK |
| `ULS610-Hydr-3(CB)` — envelope-valued Add | **nothing** |
| `ULS610-Hydr-3(CB:max)` | OK |

**"Envelope-valued" propagates.** A case is envelope-valued if its `ANAL` is in
`{MV, SM, RS}`, if it is an `iTYPE:1` combination, **or if any child of it is
envelope-valued**. An Add containing an Envelope is itself a max/min pair — MIDAS
agrees, by refusing to address it without a sense.

So: compute envelope-valuedness recursively over the combination tree from
`/db/LCOM-*`, and pick the suffix from that. Always check that every requested
series came back.

## Envelopes: resolving a load state, and the mistake that looks right

MIDAS propagates envelope children through a parent Add referencing them with
`ANAL:"CB"`: `PAR(max) == max(A_max, B_max)` and `PAR(min) == min(A_min, B_min)`,
exact on every component tested.

**Every envelope leaf is requestable by name.** Confirmed on a 98-child
envelope: all 194 addressed series returned rows, and the governing child
reproduced the envelope's reported extreme to exactly 0 at 9 s.f. across 6
components × 2 parts × 2 senses.

**But re-reading a resolved name at another location is WRONG.** This is the
trap, and it silently produces plausible numbers. The governing child is usually
itself envelope-valued, so re-reading it elsewhere returns *that location's own
independent extreme*, not the coexistent value. Measured at one link with a
driver at another: re-read-by-name gave **1.633 kN** where the true concurrent
value was **0.948 kN** — a 72% overstatement, and 7.47 kN out on the other sense.

The correct resolution **descends recursively**, pinning each Envelope to the
one child that governs *at the driver item*, multiplying factors down the path,
until every leaf is single-valued. The state is then a flat weighted sum of
static cases, re-read in one call per element type plus a client-side weighted
sum — **the same number of round trips**. Self-validating the reconstruction
against NX's own envelope value measured 0.0 to 1.7e-9 relative.

Near-ties are **common, not a corner case** — 14 in the first 72 driver items on
a real model. Decide and state a policy.

Combination types that cannot yield a coexistent state at all, and should be
refused rather than approximated: `ABS` (sign discarded) and `SRSS` (quadratic).

## Id namespaces collide

**Elastic links share an id space with elements.** On one real model 536 ids
were *both* a plate element and an elastic link. A selection carrying bare
numbers will silently address the wrong objects. Give every selection member its
**namespace** (element / link / node) and skip members of the wrong namespace
even when the number exists in the right one.

Related: on that model `/db/ELNK` rows carried `NODE ANGLE LINK R_S SDR bSHEAR
DR` and **no `BNGR_NAME`**, and `/db/BNGR` was empty — so selecting links by
boundary group had nothing to work with. `/db/CONS` was the usable node selector.
