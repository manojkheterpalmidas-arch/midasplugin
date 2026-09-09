# Concurrent Forces — MIDAS CIVIL NX

**v1.1.0 · non-mutating**

Reports the **coexistent** forces across a set of elements. You nominate one
*key element* and one force component; the plugin finds the load case,
combination, stage and step at which that component governs there, and reports
the forces in **every other element of the set at that same structural state**.

CIVIL NX does not do this today. Its own tables give concurrent *components* at
a single element — the six forces that coexist at one point — not concurrent
*elements*. Reading each element's own maximum out of a result table and
tabulating them side by side gives a set of numbers that never occurred
together, and that is the mistake this plugin exists to prevent.

## The principle it will not break

> Two results are concurrent only if they come from the **same deterministic
> structural state**.

The join key is `(Load, Stage, Step)` from the result table. A load type that is
already an envelope at source has no single state behind its maximum, so no
other element can be paired with it. Those cases are **blocked, not
approximated** — with a message naming the way round it.

## What it does

1. Reads `/db/ELEM` and routes every member of the set to the result table that
   reports on it — beams to `BEAMFORCE`, trusses and tension/compression-only
   members to the truss force table, general links to the general link force
   table. A set may mix types; the queries fan out and the rows merge on the
   join key. Plates and solids are rejected by name with a reason.
2. Reads all **ten** `LCOM-*` tables and builds the full combination tree.
3. Validates — see below — **before** any bulk result query.
4. Issues **one `POST /post/TABLE` per element type per result family**, with
   every element in `NODE_ELEMS.KEYS` and every selected case in
   `LOAD_CASE_NAMES`. A 220-element set across eight combinations costs three
   requests, not 1760.
5. Builds `(Load, Stage, Step)` on every row, finds the governing row at the key
   element, and filters the merged set to the rows sharing that key.

## Validation — what is blocked, and why

The **tree walk to the leaves** is the check that matters. A combination nested
three levels deep can inherit a blocked constituent while looking perfectly
clean from the outside; nothing on its own name would ever say so. The
`(MV)`/`(SM)`/`(RS)` suffix on the result label is implemented too, as a cheap
second check on a case whose kind the definitions never settled — but it is the
second check, not the first.

| Blocked | Why | The way round it |
|---|---|---|
| Moving load `(MV)` | envelopes over vehicle position | Results → Moving Load Tracer, convert the governing condition to a static case, re-analyse |
| Support settlement `(SM)` | enveloped over the settlement group | define the governing settlement as a specified-displacement static case |
| Response spectrum `(RS)` | sign-less after modal combination | none — use time history |
| Time history with max/min output only | an envelope over the whole record | re-run with step-by-step results saved |
| `ABS` combination | sign discarded | rebuild as an Add |
| `SRSS` combination | quadratic | rebuild as an Add |

Allowed: static cases, Add combinations, construction-stage results (the key
carries `Stage:Step`), and time history **where steps were saved** — which is
checked with a one-element query, because no definition anywhere records it.

## Envelope combinations are resolved, not blocked

An envelope picks the worst constituent per element independently, so filtering
one directly produces a physically impossible set. Its constituents are
discrete, so the plugin resolves rather than rejects:

- it identifies which child governs the key component at the key element,
- **descends recursively** — an envelope of envelopes resolves to a leaf, and an
  Add that is envelope-valued only because a child is resolves to a weighted sum
  of single-valued cases,
- reads the set at that resolved state,
- and displays it prominently: *"ULS_Env resolved to ULS_Comb_07"*, with the
  full expression where the state is a sum.

The descent continues until every term is **single-valued**, because re-reading
a resolved name at another element is wrong and wrong *quietly*: the governing
child is usually itself envelope-valued, so reading it elsewhere returns that
element's own independent extreme. Measured 72 % out on a live model.

Every reconstruction is then **gated against the value MIDAS itself publishes**
for the envelope at the key element. If it misses, the run stops and says so
rather than printing a number that cannot be checked.

**Near ties are common, not a corner case.** The policy: the first candidate in
definition order wins, and every tie is reported in the results header.

## Running it

Inside CIVIL NX: install `dist/Concurrent Forces v1.1.0.zip` from the Plug-in
menu, open it, fill the panel top to bottom, press **Find concurrent forces**.

Without CIVIL NX:

```bash
node mock-midas/server.js
# then open the URL it prints
```

Serve over **HTTP, not `file://`** — a `file://` page can serve a stale snapshot
of some scripts while refreshing others, so UI changes appear to do nothing.

```bash
node test/run.js      # 198 assertions, no CIVIL NX needed
```

Repackage after a change:

```bash
node ../../assets/scripts/pack.js --source . --out "dist/Concurrent Forces v1.1.0.zip"
# on Windows, equivalently:
..\..\assets\scripts\pack.ps1 -Source . -Out "dist\Concurrent Forces v1.1.0.zip"
..\..\assets\scripts\verify-zip.ps1 -Source . -Zip "dist\Concurrent Forces v1.1.0.zip"
```

## What is where

| File | Role |
|---|---|
| `index.html` | the panel, and the read/write claim in the header |
| `js/mapi.js` | the API client — error semantics, the family split, token probing, the POST whitelist |
| `js/model.js` | reads the model; probes the endpoints whose keys differ per build |
| `js/combos.js` | the load model — envelope-valuedness, blocking, envelope resolution |
| `js/elements.js` | the element set — parsing, namespaces, type routing, column lookup |
| `js/concurrent.js` | join keys, the governing row, the concurrent filter |
| `js/report.js` | one neutral document; the table and the CSV are walkers over it |
| `js/chart.js` | the distribution chart, as a spec — no DOM, no markup |
| `js/run.js` | the data flow, with the network injected |
| `js/app.js` | wiring only — no logic |
| `mock-midas/server.js` | the API and the static files from one process |
| `test/run.js` | the offline suite |

## What changed in v1.1.0

**The API base is settled by probing, not assumed.** This was a real failure on
a live model, and it failed in the most misleading way available: the host's
`redirectTo` did not carry the program segment (`/civil`), `/mapikey/verify`
sits *outside* that segment so the connection check passed, and then every
single `/db/` read answered 404 — which the client honestly reports as *"the
plugin used a wrong table key"*, once per table, for the whole model. One probe
read of `/db/ELEM` now settles which base actually serves the API before
anything else is read, and the panel says so when it had to change it.

Every read result also carries the URL it requested, so a failed read can be
diagnosed from a screenshot rather than from a guess.

**Structure groups are read tolerantly and listed honestly.** The element list
is looked for under every plausible key and parsed whether it arrives as an
array or as text with ranges. Every group is offered, empty ones included, with
the reason on the row — a group silently missing from the picker is exactly what
gets reported as *"it is not reading my groups"*. **Replace** joins **Add**, and
a pick that adds nothing says why instead of doing nothing.

**The endpoint and key are no longer shown.** Inside CIVIL NX the host supplies
both on the query string, so there is nothing to decide; the row appears only
when no key was supplied — that is, when the page is being driven from a plain
browser for development. The key is never rendered, not even as a fingerprint.
The resolved endpoint moved into *What was read from the model*, where it is
diagnostics rather than a control.

**A distribution chart.** One component's value along the set at the governing
state, signed, with the key element highlighted and any component selectable.
It is built from a spec in `js/chart.js` and rendered as SVG *nodes* — an
element label or a load name can never become markup. Rows with no value in a
column (a truss has no moment) are counted and skipped rather than drawn at
zero.

**Export made plain:** *Download CSV*, *Copy CSV* and *Show as text* side by
side under the table, each reporting what actually happened rather than claiming
a save or a copy that may not have occurred.

**Fixed:** an element marked `hidden` in the markup rendered anyway wherever the
stylesheet set `display` on it — the connection row among them.

## Verified, and not

Built on the `midasplugin` skill, whose API behaviour was **measured against
live CIVIL NX 2026 sessions**. What this plugin depends on, and how sure it is:

**Verified against a live model** (by the skill, not by this plugin's own
sessions): the `/post/TABLE` Argument shape; `BEAMFORCE` as a token; errors
arriving as HTTP 200 with an `error` key; 404 meaning a wrong table key;
`status: "connected"` being the real connection test; the envelope suffix rules
and their silent-drop failure; `OPT_CS` being a mode switch rather than a
filter; `bSV_STEP` governing which step tokens exist; the ten `LCOM-*` tables;
combination `iTYPE` and `ANAL` values.

**Not verified — probed at runtime instead, and reported in the panel:**

- **The truss and general-link table tokens.** Only `BEAMFORCE` is confirmed.
  The plugin tries `TRUSSFORCE`, then variants, and `GENLINKFORCE`, then
  variants, using the fact that a token that does not exist answers "error
  creating utbl". Whichever answers is used and named in the run.
- **The general-link, moving-load, settlement, response-spectrum and
  time-history case table keys.** These are spelled differently per design code
  and per build, so each is probed: 404 means this build has no such key, and
  the panel says which key answered. **Nothing about the blocking rules depends
  on these probes** — the analysis kind of every constituent comes from `ANAL`
  on its parent combination and from the result label's own suffix.
- **`/db/UNIT`'s record shape.** Read tolerantly, and the panel states whether
  the units were read from the model or defaulted.
- **The `STAGE_STEP` token format** (`<stage name>:<step token>`). The tokens
  offered are shown verbatim, so a mismatch is visible rather than silent.

**Not available at all:** selection sync. The plugin host's whole contract is a
query string in and two window messages out (`REQ_WND_MOVE`, `REQ_EXIT`); there
is no message that reports what is selected in the model window. The *Select in
model window* button is therefore present but disabled, with that explanation on
it, rather than absent or broken.

**Not tested against a live model.** Everything above was exercised against the
offline mock, which reproduces the API's awkward behaviours deliberately — the
silent drops, the family split, the 404-versus-empty distinction — and is
arithmetically consistent, so the envelope reconciliation is a real check. It is
not a substitute for a connected CIVIL NX. Re-verify the probed items on first
use.

## Things not to undo

- `verify()` gates on `status === "connected"`, not just `keyVerified`.
- Errors are read from the **body**, never from the HTTP status.
- The suffix is computed from **recursive** envelope-valuedness, not from a
  combination's own `iTYPE`.
- Every requested series is checked for in the response. An unaddressable series
  is dropped silently, so a missing row is the only signal there is.
- CS and non-CS series are requested in **separate calls**, and `OPT_CS` is
  never sent without a stage.
- Selections carry a **namespace** — a bare number is an element, `L5` is a
  general link, and the two id spaces collide.
- The window drag posts `REQ_WND_MOVE` (not `REQ_MOVE`) from a **`mousedown`**
  handler, and the ✕ is a sibling of the drag surface.
- Long work is chunked and yields with a `MessageChannel` message. Blocking the
  main thread makes the close button unclickable, and it is reported as a broken
  close button.
