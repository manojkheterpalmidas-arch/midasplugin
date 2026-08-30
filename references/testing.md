# Testing a plugin without CIVIL NX

CIVIL NX is not always open, the model in it is not a fixture, and a live probe
is slow. Every plugin worth shipping needs an offline harness — and the harness
is what makes a live session cheap when you do get one.

## Architecture that makes testing possible

Split the plugin into **pure modules** — no DOM, no network, no globals — and
leave `app.js` as wiring only. A plugin split this way runs its whole
computation under `node test/run.js`.

```
js/mapi.js      network only
js/model.js     reads tables → a neutral model object
js/<domain>.js  the actual engineering (pure)
js/report.js    model → output document (pure)
js/app.js       DOM wiring, no logic
```

**One resolver, dumb renderers.** If a plugin exports to several formats, resolve
the content into one neutral document and make every exporter a walker over it.
No exporter should read the model. A test asserting all formats emit the same
blocks in the same order is what stops them drifting. If you find yourself
passing a flag from the builder into an exporter, the document model is wrong —
fix the model.

## The mock server

`assets/template/mock-midas/server.js` serves the API **and** the plugin folder
from one process, so the whole plugin runs in a browser with CIVIL NX closed:

```
http://localhost:8772/index.html?mapiKey=mock-key&redirectTo=http://localhost:8772/civil
```

Serving both from one process is also a practical necessity — dev-server slots
are limited, and it keeps the ports in step.

**Make the mock arithmetically consistent.** Its value for a combination should
be computed from the values it reports for that combination's children, using
the same semantics the plugin implements, **quantised at every node**. A plugin
that self-validates will then reject a mock that returns plausible-looking
numbers, and a completed run becomes a genuine regression test rather than a
screenshot opportunity.

**Give the mock the scenarios a live model may not have.** Real models are
lopsided; the mock is where you keep the awkward cases:

- an envelope whose governing child differs by part along one member
- a near-tie between two children, within the reported precision
- an Add whose leaves include an envelope-valued case
- combination types the plugin must refuse (ABS, SRSS, moving-load)
- **colliding id spaces** — the same number as an element and as a link
- an empty table, and a table the build does not have (404)

## The Node harness

```
node test/run.js
```

Run the shipped modules against the mock over **real HTTP**, so the MAPI client,
the HEAD parsing and the error handling are under test rather than stubbed.

Two traps in the harness itself:

**`"type": "module"` in a parent `package.json` breaks everything.** Node then
loads these classic scripts as ESM, `module.exports` never fires, and every
`require()` returns an empty namespace — which presents as the plugin's modules
being mysteriously empty. Put a local `package.json` with `"type": "commonjs"` in
the plugin folder. (For a UMD module loaded for its side effect, `require()`
returns `{}` legitimately — read the global it set instead.)

**Verify the channel before believing a result.** A probe harness with a silent
argument-order bug presented as "CIVIL NX rejects everything" for several rounds.
When a live probe starts rejecting uniformly, re-post a known-good payload
verbatim first to prove the channel.

## Browser verification

Serve over HTTP, never `file://`. A `file://` page can serve a **stale snapshot**
of some scripts while refreshing others — UI changes then appear to do nothing
for reasons that have nothing to do with the code.

Where a screenshot is not available, check the DOM and SVG `getBBox()`
numerically instead of eyeballing.

## What only a live model can settle

- whether a table token exists in this build
- whether a write payload is accepted
- what a guide curve's array order is (see `probing.md`)
- anything about construction stages — commonly unverified, and worth saying so
  in the readme rather than implying coverage

Record what was verified, on which model, on which build. Mark the rest
**unverified** and leave it marked.
