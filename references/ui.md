# UI conventions

A plugin sits inside CIVIL NX. It should look like it belongs there, and it must
survive being small, dark, and driven by an engineer who is checking someone
else's numbers.

## Shell

Plain HTML/CSS/JS in IIFEs, no build step, no npm, no CDN, works from `file://`
in a pinch. Every plugin here that started with a React/TypeScript/PyScript shell
was later cut back to this. It loads instantly in WebView2, it is patchable by
whoever inherits it, and it has no supply chain.

**A CDN link is a broken plugin** on a machine behind a corporate proxy — which
is most of them. Vendor everything.

Layout that works in a 1280×760 window:

```
┌ header (drag surface) ─ name · version · connection badge · Close ┐
├ action bar ─ what will happen, and the button that does it        │
├ tabs (only if there are genuinely several jobs)                   │
└ one scrolling content area                                        ┘
```

One scrolling screen beats a seven-tab layout for most plugins. Ask before
building a model viewer — it is a lot of work that the host already provides
behind the window.

## Say what the plugin will do, before it does it

The header should carry the read/write claim as a permanent badge —
*"Non-mutating"*, with a tooltip naming the exact paths — and the wording must be
accurate. A plugin that reads with GET and posts only to `/post/TABLE` is
**non-mutating**, not "GET only"; if it later posts `/view/CAPTURE` the claim
still holds but the tooltip must list it. On a check certificate this claim is
the plugin's selling point.

For a writing plugin: preview first, commit second, and tell the user what will
be deleted before it is.

## Reporting outcomes

- **Errors get a hint, not an echo.** Map each known MIDAS message to what the
  user should do about it (see `mapi.md`). `"second query is wrong"` helps nobody.
- **Distinguish "not applicable" from "pass".** A check over an empty population
  reporting a green tick is a lie. One plugin went from fourteen green ticks to
  eleven "not applicable" plus one real finding on a sections-only model — the
  second is the honest report.
- **A skipped read should say why**: *"not read — no elements in the model"* is a
  weaker and truer claim than *"not defined"*.
- Progress lines should count what the user cares about, not endpoints. "47
  endpoints" reads as "47 checks" and generates complaints.

## Tables and numbers

- **Grid columns must use `minmax(min, 1fr)`, never a bare `1fr`.** With most
  columns fixed, text columns collapse to about twenty pixels and headers render
  as "N." and "S1".
- Horizontal scrolling belongs on the table wrapper, so the header travels with
  the rows.
- **Header rows are usually CSS-uppercased** — a "ν" label renders as a Greek
  capital that reads as a Latin N. Spell symbols out in headers.
- Watch the exponential threshold in any number formatter. In millimetre units
  every area and section modulus turns into `1.519e+6` unless the threshold is
  raised.
- Keep a **typed accessor** alongside the formatted one. Excel must never receive
  locale-formatted strings, and `/ope/SECTPROP` returns its numbers as text.
- Make big tables **lazy** (`totalRows` + `getRow(i)`), not materialised.
  Resolving a 60,000-node report then costs about 2 ms.
- Table headers should carry the **full resolved expression**, not just a
  combination name — that is what makes a table auditable by the next reviewer.

## Theming

Follow the OS until the user chooses, then remember the choice; do not follow the
OS after that. `assets/template/js/theme.js` is 50 lines and does exactly this.
Define the palette as CSS custom properties on `:root` and swap them on a
`data-theme` attribute.

## Angles, units and conventions

State every convention in the UI, next to the input, with a diagram if it is at
all ambiguous. A skew angle "measured from square" was consistently read by users
as the complement; the fix was showing both live.

Beware clamped formatters: one plugin's `formatAngle` clamped to the slider's
±60° range and was then reused for a derived complement, silently reporting the
wrong number. A formatter that clamps must be named so nobody reuses it.

## moaui — notes for patching MIDAS's own bundles

MIDAS's shipped plugins use an internal component library. Two behaviours cost
real time:

- **The dropdown's `itemList` must be a `Map` of label → value.** Passing the
  array-of-`{label, value}` shape that the plugins' own string tables use throws
  `TypeError: h.get is not a function` from deep inside the component, with a
  React stack pointing nowhere near the caller. Build it as
  `const m = new Map(); m.set(label, value)`.
- **Component bindings differ per bundle** because the toolchains minify
  differently — in one webpack bundle Typography/Stack/Button/Dropdown were
  `Td`/`tR`/`Ql`/`YL`; in an esbuild bundle they were `Q1`/`ir`/`mo`/…
  **Never carry a name from one bundle to another. Re-derive it each time.**

## Export formats

If the plugin exports documents, three library traps already paid for:

- **docx `standardizeData()` runs every string given as image data through
  `atob()`**, so raw SVG markup throws on any non-Latin1 character (a `×` is
  enough). Pass SVG to `ImageRun` as **UTF-8 bytes**. A lenient `atob` stand-in
  in a Node test will hide this until the browser run.
- **`ImageRun` with `type: "svg"` requires a fallback PNG** — enforced by the
  library, not merely recommended.
- **pdfmake needs all four font style slots declared** even with two faces
  vendored; an italic label otherwise throws at render time.

Cache the resolved document and skip rasterising figures that already carry a
PNG — that is what makes a repeat export feel instant instead of like a second
full run.
