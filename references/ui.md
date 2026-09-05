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

## Two icons, not one

**`icon.svg` is the plugin-list icon and it is not the title-bar icon.** Ship
both, and check each at the size it is actually used.

MIDAS's own plugins show in the list as a **black rounded tile with a bright
frame and a bold glyph**. The construction is:

```
<rect width="28" height="28" rx="2" fill="black"/>      the tile
<mask>  <rect x=".5" y=".5" width="27" height="27" rx="1.5" stroke="#D9D9D9"/>  </mask>
<g mask="…"><rect x="-1" y="-1" width="30" height="30" fill="url(#frame)"/></g>
…glyph…
```

The frame is **`assets/icon-frame.png`**, shipped with this skill and already
embedded in `assets/template/icon.svg` — copy the template and you get it. It is
the MIDAS logo tile, a 321×321 rainbow square with an **M** on it, and the ring
mask reveals only its one-pixel border; that is why the "frame" turns out to be
a logo when you open the file, and why nobody should try to redraw it as a
gradient.

**Embed it as a data URI, never link it.** An SVG loaded through
`<img src="icon.svg">` cannot fetch external resources, so a linked PNG renders
as nothing at all. That is why MIDAS's own icons embed it, and why the raw file
is here only as a source for someone drawing a new icon by hand.

An icon that is not built this way stands out as not belonging; a pale drawing
on a transparent tile is the usual mistake and looks unfinished beside the rest.

That badge is then **invisible on the plugin's own title bar**, which is
`#21272A`: a black tile on near-black, at the 12 px the bar renders. It loads
perfectly and is reported as a missing icon. So the bar gets its own asset — no
tile, **solid shapes only** because strokes go sub-pixel at 12 px, in the bar's
ink `#BDC2C8`, with internal detail cut out by a `<mask>` rather than painted in
the bar colour so it survives a change of shade.

Which asset a header takes depends on the shell you built. The template's own
header is a light panel with a 28 px icon, so it takes the badge; rebuild the
shell as MIDAS's dark `#21272A` controller bar with a 12 px icon — which the
newer plugins use — and it must take the flat glyph instead. The template ships
both for exactly that reason.

Render candidates at 12 / 16 / 28 **on the background they will actually sit
on** before choosing, and pin which asset goes where in the offline suite —
repointing a dark bar at `icon.svg` looks like a tidy-up and silently blanks it
again.

## Say what the plugin will do, before it does it

The header should carry the read/write claim as a permanent badge —
*"Non-mutating"*, with a tooltip naming the exact paths — and the wording must be
accurate. A plugin that reads with GET and posts only to `/post/TABLE` is
**non-mutating**, not "GET only"; if it later posts `/view/CAPTURE` the claim
still holds but the tooltip must list it. On a check certificate this claim is
the plugin's selling point.

For a writing plugin: preview first, commit second, and tell the user what will
be deleted before it is.

## The moaui house style, measured

The newest plugins in this estate are built on MIDAS's own `moaui` React
components. A plain HTML/CSS/JS plugin can sit beside them convincingly, because
the language is only a dozen values — all of these were read out of a running
moaui plugin with `getComputedStyle`, not eyeballed:

| Part | Value |
|---|---|
| controller bar | `#21272A` on `#BDC2C8`, `2rem` tall, 12 px, icon at 20 px left |
| page | `#F1F1F1` |
| card | `#FFF`, radius 4, `0 2px 4px rgba(0,0,0,.14)`, padding 16 |
| tabs | 48 px tall, 12 px UPPERCASE; active `#1F2937`/700 over a 2 px `#4B9AF4` indicator; enabled `#4B5563`/500; locked `#BDC2C8` |
| buttons | `#EEEEEE` fill, `.8px solid #C4C6C8`, radius 4, 12 px/500, `10px 20px`, **not** uppercase |
| inputs | white, `.8px #C4C6C8`, radius 4, `6px 10px`, 12 px |
| tables | 12 px, 12 px cell padding, `.8px #E0E0E0` rules, `#DDDDDD` header band |
| alerts | MUI standard severities (`#EDF7ED`/`#2E7D32`, `#FFF4E5`/`#ED6C02`, `#FDEDED`/`#D32F2F`, `#E5F6FD`/`#0288D1`) |
| ink ramp | `#111827` / `#1F2937` / `#4B5563` / `#6B7280` / `#BDC2C8` |

There is **no bold primary button** anywhere in those plugins — even Commit is
the same grey outlined button.

Worth copying beyond the colours: the **tabbed wizard**. One card, tabs across
the top, each tab disabled until its prerequisite is met, and each panel opening
with a severity banner that says what state it is in and where to go next
("Factors are ready. Proceed to Groups & Relations."). It carries a long input
sequence far better than one scrolling page, and the banner removes most of the
"what do I do now" support traffic.

**To see a compiled plugin's UI without CIVIL NX**, serve the extracted zip from
a static server that also answers `/health` → 200, `/mapikey/verify` →
`{keyVerified:true, status:"connected", program:"civil"}` and `/db/<TOKEN>` →
`{TOKEN:{…}}`, then open it with `?mapiKey=x&redirectTo=http://localhost:PORT`.
**`redirectTo` must carry the scheme** or `getBaseUri` logs "Invalid origin" and
the body stays blank. Then read the tokens out of the live DOM rather than
guessing them from screenshots.

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
- **A blank cell states its own opposite.** A missing value usually means
  something definite — "this face carries no demand", "not applicable here" —
  and an empty cell reads as "not computed". Print the reason. One plugin's
  design-force table showed blanks where the applied field opposed that face,
  and was reported as only producing half its output.
- **An action whose only effect is off-screen reads as broken.** A button that
  fills a `<details>` below the fold looks inert; it was reported as "CSV not
  working" while building 143 kB correctly every time. Scroll the result into
  view, select it, and say in a status line what actually happened — including
  whether a clipboard write succeeded, rather than claiming one that may not
  have.
- **Never put the run control inside a section that any option can hide.** One
  plugin kept its Assess button in a panel that was hidden unless a particular
  method was selected — and the default selection did not select it, so the
  plugin rendered with no way to run it. Long-running actions belong in a
  persistent footer.
- **Show only what the user must decide.** Inside CIVIL NX the host supplies the
  base URL and the key on the query string; offering them as editable fields is
  noise, and a remembered base must never override `?redirectTo=` anyway. Show
  the endpoint read-only, the key as a short fingerprint (it is a credential),
  and a **Refresh** that re-verifies and re-reads the model.
- **A native `<select multiple>` is the one control that never matches the rest
  of the card**, and it is unusable past a few dozen entries. Use a filterable
  table with a checkbox per row; it also gives you somewhere to show what each
  row will actually do.

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

### Keep the patch, not the patched bundle

When a shipped plugin has no source, the maintainable artefact is a **patch
script**, not the modified bundle. One script per release, applied to the
**pristine** bundle rather than stacked on the previous release's output:

- every replacement asserts its anchor occurs **exactly once**, and the script
  refuses a partial apply, so a bundle that has moved on fails loudly instead of
  silently half-patching;
- it asserts the source is pristine, so it cannot be run twice;
- added code is written in the bundle's own style — ASCII with `\uXXXX` escapes
  if that is what the bundle uses — so the file stays single-encoding;
- `node --check` the output before shipping it.

When a new upstream bundle arrives, re-run the script against that. Diffing
minified output is not a recovery plan.

Prefix every identifier the patch introduces (`_myplugin*`) and assert the prefix
is absent from the pristine bundle. That makes collisions impossible and makes
the patch's own footprint greppable.

### A theme layer that tags by index is a trap for later additions

A common pattern for restyling a shipped bundle is a small script that walks the
DOM and marks structural nodes. If it marks **by index** — `children[0..2]` as
header/content/footer — then any later change that inserts an element beside them
silently relabels the real content node as the footer and takes the layout with
it. Two defences, both cheap: render additions *inside* an existing region rather
than beside it, and mark your own nodes with a **class**, since the theme layer
owns the attribute and rewrites it.

Related: a status flag is only as good as its writers. In one bundle the
key-verification gate called the model loader directly, fire-and-forget, and only
one of the two call paths set the `busy` atom — so a spinner keyed on that atom
stayed hidden for the entire ten-second startup read. Drive progress UI from a
value the *loader itself* sets, not from a flag one of its callers happens to
set.

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
