# The worked example — what a finished plugin zip looks like

`examples/MIDAS_CIVIL_NX_Concurrent_Force_Reporter_v1.0.0.zip` is a **real,
shipped CIVIL NX plugin**, included so that the shape of a finished deliverable
is not left to description. `assets/template/` is where a plugin *starts*; this
zip is what one *ends up as*.

Read it when you need to answer "what exactly am I handing over at the end?".
Unzip it and look — it is 20 plain-text files, nothing compiled, nothing minified.

```bash
unzip -l examples/MIDAS_CIVIL_NX_Concurrent_Force_Reporter_v1.0.0.zip
mkdir -p /tmp/example && unzip -q examples/MIDAS_CIVIL_NX_Concurrent_Force_Reporter_v1.0.0.zip -d /tmp/example
```

## What the plugin does

The Concurrent Force Reporter answers a question CIVIL NX does not: given that
one quantity governs at one item, what is every *other* item in the set doing at
that same instant. It resolves the combination tree down to a single
deterministic state and reports the set there. It is **read-only** — it reads the
model and its results and writes nothing back.

It is a fair example because it is not a toy: 12 JavaScript modules, an envelope
resolver, seven result sources, a chart, a CSV export and a diagnostics report.

## The archive

```
icon.svg           icon-bar.svg      index.html        manifest.json
readme.md          VALIDATION.md     styles.css        ui.css
js/app.js          js/chart.js       js/combos.js      js/concurrent.js
js/diag.js         js/elements.js    js/mapi.js        js/model.js
js/report.js       js/run.js         js/theme.js       js/ui.js
```

**Files sit at the zip root.** `index.html` and `manifest.json` are top-level
entries — not inside a `Concurrent-Force-Reporter/` folder. This is the single
most common packaging mistake and the host will not open a plugin that has it.

**Entry separators are forward slashes** — `js/app.js`, never `js\app.js`.
Windows PowerShell 5.1 `Compress-Archive` writes backslashes, which the ZIP spec
forbids; this archive was built with `assets/scripts/pack.ps1`, which sets the
separators explicitly through .NET. Check any archive you build:

```bash
unzip -l your-plugin.zip | grep '\\' && echo "BACKSLASHES - the host may refuse this"
```

**No build output, no `node_modules`, no test suite, no mock server.** The
template ships `package.json`, `test/run.js` and `mock-midas/server.js` because
they are how the plugin gets *built*; none of them belongs in the archive the
host opens. Nothing here needs a build step — the browser loads the files as
they are.

**Two icons, not one.** `icon.svg` is the plugin-list badge; `icon-bar.svg` is
the flat mark for the plugin's own title bar, which the badge is invisible
against. See `references/host.md`.

**No external requests.** No CDN, no web font, no analytics. Everything the page
needs is in the zip.

## The five things worth copying

### 1. `manifest.json` is short, and the window size is a real decision

```json
{
  "short_name": "ConcurrentForce",
  "name": "Concurrent Force Reporter",
  "version": "1.0.0",
  "description": "Reports the coexistent forces in every element of a set at the single structural state where a chosen component governs at a chosen key element.",
  "icons": [{ "src": "icon.svg", "sizes": "any", "type": "image/svg+xml" }],
  "start_url": ".",
  "display": "standalone",
  "theme_color": "#ffffff",
  "background_color": "#f3f5f7",
  "width": 1200,
  "height": 740
}
```

`width` and `height` are **logical pixels**, so Windows display scaling eats into
them: on a 1920x1080 screen at 125 % the usable desktop is 1536x826, and this
plugin shipped at 1380x880 first — taller than the whole working area — before
being reissued at 1200x740. Pick a size that fits a scaled 1080p desktop with
room for the host chrome, and make the CSS reflow below it rather than assuming
the number is honoured.

### 2. The name says what the tool does

It was called "Concurrent Forces" until review: that names the *topic*, not the
tool. The house pattern across the shipped plugins is a descriptive noun phrase
plus a role word — Generator, Analyzer, Reporter, Assessment. Set the same name
in `manifest.json` (`name` and `short_name`), the `<title>`, the header `<h1>`,
and the readme, and keep them in step.

### 3. The read/write claim is in the header, worded exactly

The header carries a **Read-only** badge, and the readme says what that covers.
An engineer will not run an unfamiliar tool on a live model they cannot
characterise. The client backs the claim up rather than just asserting it: POST
paths are whitelisted and `EXPORT_PATH` is stripped from every body.

### 4. Logic lives in pure modules; `app.js` is wiring

`js/app.js` touches the DOM and nothing else computes there. `combos.js`,
`concurrent.js`, `elements.js`, `report.js`, `chart.js` and `run.js` have no DOM
and no network, which is what lets a Node harness exercise the whole analysis
with CIVIL NX closed. Keep that seam — it is also what makes a bug reproducible.

### 5. `VALIDATION.md` ships inside the zip

It records what was checked, against which model and which build, and — the part
that matters — **what was not**. This archive's copy names the live model it was
verified on (1736 plates, 580 elastic links, 78 combinations), states the worst
reconstruction error, and says plainly that construction stages remain unverified
and that a known parser issue survives in the numerical code.

Anything unverified must be labelled as such in the shipped files, not quietly
presented as fact. A reviewer reading the zip should be able to tell the
difference without asking.

## Version numbering

The public release is **v1.0.0** even though development ran to an internal
1.6.1; the readme keeps the internal history under a heading that says so. Four
places carry the number and all four must agree — `manifest.json`, the version
chip in `index.html`, `VERSION` in `js/app.js`, and the readme's header line.

## Checking your own zip against this one

`assets/scripts/verify-zip.ps1` proves an archive matches its source folder hash
for hash. Beyond that, the questions this example answers:

- [ ] Is `index.html` a **top-level** entry?
- [ ] Are all separators forward slashes?
- [ ] Is `manifest.json` present, with a `width`/`height` that fits a scaled 1080p desktop?
- [ ] Are both icons present?
- [ ] Is there a close button, and is it a sibling of the drag surface?
- [ ] Are `node_modules`, tests and the mock server **excluded**?
- [ ] Does the page make any external request? It should make none.
- [ ] Does the name match across manifest, title, header and readme?
- [ ] Does a readme ship inside the zip, and does it separate verified from unverified?

`references/pitfalls.md` is the full pre-flight checklist.
