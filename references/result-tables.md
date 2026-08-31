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
- Construction stage entry is `"STAGE_STEP": ["<step>"]` plus `"OPT_CS": true` —
  but `OPT_CS` selects which *family* of results the call answers with, and is
  not a filter you can leave on. See **Construction stage results** below before
  using it.
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

## Construction stage results — a second family, not a filter

Measured August 2026 on a staged precast-beam deck: 803 beams, 8 construction
stages, 15 combinations.

**`OPT_CS` is a mode switch.** One request answers with the construction-stage
series *or* with everything else, never both. Ask for both together and the
family the flag excludes is **absent at HTTP 200, with no error** — the same
silence as a bad envelope suffix. Requesting
`["Dead Load(CS)", "Thermal expansion(ST)", "Pedestrian loading(ST)"]` on one
element:

| Request | Rows returned |
|---|---|
| no `OPT_CS` (with or without `STAGE_STEP`) | the two `ST` cases — **CS absent** |
| `"OPT_CS": false` + `STAGE_STEP` | same — CS absent |
| `"OPT_CS": true` + `STAGE_STEP` | `Dead Load` only — **ST absent** |
| `"OPT_CS": true`, no `STAGE_STEP` | `Dead Load` at **every stage at once** |

Consequences for any plugin that decomposes a combination:

- A combination mixing `CS` cases with static ones — which is what a real staged
  bridge combination looks like — **cannot be resolved by one request**.
  Partition the requested series by family and issue one call per family.
- `STAGE_STEP` only narrows *which* stage; it does not switch families. With
  `OPT_CS` on and no `STAGE_STEP` every stage comes back interleaved, so
  anything keyed on a single stage silently overwrites rows. Require a stage.
- **A `CB` combination always belongs to the non-CS family**, even when every
  one of its children is a `CS` case. `summation(CB)` — 17 CS children — returned
  rows with `OPT_CS` off and nothing with it on.

## Enumerating what a model actually publishes

`POST /post/TABLE` with **`"LOAD_CASE_NAMES": []`** returns every series the
model publishes for that family and element. One element is enough. This is the
cheapest way to tell *"this series does not exist"* from *"this series was
dropped"*, and worth doing on the failure path before blaming the request:

```json
{"Argument":{ "TABLE_NAME":"probe", "TABLE_TYPE":"BEAMFORCE",
  "UNIT":{"FORCE":"kN","DIST":"m"}, "NODE_ELEMS":{"KEYS":[301]},
  "LOAD_CASE_NAMES":[], "STYLES":{"FORMAT":"Scientific","PLACE":8} }}
```

On the reference model that returned 8 CS series at every stage, and 51 entries
in the non-CS family covering every static case and every combination.

**A combination's definition is not evidence its constituents produce results.**
The auto-generated `summation` named `Erection Load_1 … _10`, one per stage, and
no stage published any such series. They are scaffolding: where the analysis
accumulates stage-applied loads into `Dead Load`, every one reads zero. Confirmed
two ways — the combination reconciled exactly against only the 7 real series
across 300 items, and a wrapper (below) around `Erection Load_1` returned literal
`0.00000000e+00` rows.

## Reading a CS case at post-stage: the one-term combination

A construction-stage case can be pulled into the *ordinary* result family by
wrapping it in a one-term load combination and reading that by name:

```json
{"Assign":{"<free key>":{ "NAME":"~TMP01", "ACTIVE":"ACTIVE", "bCB":false,
  "iTYPE":0, "DESC":"temporary",
  "vCOMB":[{ "ANAL":"CS", "LCNAME":"Dead Load", "FACTOR":1 }] }}}
```

Then request `~TMP01(CB)` with **no `OPT_CS` and no stage**. Measured:

- it returns the case's **final-stage** value — identical to `Dead Load(CS)` read
  at the last stage that changes it, and onward;
- `PUT /db/LCOM-GEN` is accepted and the results are readable **immediately, with
  no re-analysis**;
- it reaches series the construction-stage table never publishes at all;
- `DELETE /db/LCOM-GEN/<key>` removes one wrapper without touching the others.

This is the only way found to decompose a mixed CS/static combination in one
result family. It is **post-stage only** — a `(CB)` returns nothing when
`OPT_CS` is on, so per-stage work still needs the `OPT_CS` route.

It also **writes to the user's model**, which turns a read-only plugin into a
writing one. Create the wrappers under a recognisable prefix, delete them in a
`finally` so an exception cannot leave them behind, and sweep any survivors at
startup. And see the Base/Final stage restriction in `write-shapes.md` — the
write is refused outright while the model sits inside a construction stage.

## Step tokens follow `bSV_STEP`

Do not offer `001(first)` unconditionally. Where a stage's `/db/STAG` record has
`bSV_STEP: false` — the default — only `002(last)` exists, and every other token
returns an empty table for every stage. Offering one produces an error that reads
like a missing analysis option and sends the user hunting in the wrong place.

## Id namespaces collide

**Elastic links share an id space with elements.** On one real model 536 ids
were *both* a plate element and an elastic link. A selection carrying bare
numbers will silently address the wrong objects. Give every selection member its
**namespace** (element / link / node) and skip members of the wrong namespace
even when the number exists in the right one.

Related: on that model `/db/ELNK` rows carried `NODE ANGLE LINK R_S SDR bSHEAR
DR` and **no `BNGR_NAME`**, and `/db/BNGR` was empty — so selecting links by
boundary group had nothing to work with. `/db/CONS` was the usable node selector.
