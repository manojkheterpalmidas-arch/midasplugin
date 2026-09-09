# midasplugin

A Claude skill for building plugins for **MIDAS CIVIL NX**.

A CIVIL NX plugin is a static web page in a zip: the host opens `index.html` in
an embedded browser, hands it a MAPI key, and the page talks to CIVIL NX over
HTTPS. There is no SDK. Everything hard about the work is in the API's
undocumented behaviour — and that is what this skill carries.

Everything here was **measured against live CIVIL NX 2026 sessions** while
building and patching real plugins. In several places it corrects the published
JSON manual.

## What's in it

```
SKILL.md                      the workflow and the five rules that cost the most time
references/
  mapi.md                     connection, error semantics, reads, writes, image capture
  result-tables.md            POST /post/TABLE, tokens, load-case series, the envelope trap,
                              construction stages and the OPT_CS family split
  write-shapes.md             verified payloads for NODE, ELEM, MATL, SECT, THIK, GRUP, LCOM
  host.md                     the plugin-host contract, manifest, packaging, WebView2 quirks
  ui.md                       layout, theming, moaui notes for patching shipped bundles
  testing.md                  the mock + Node harness pattern
  probing.md                  settling an unknown API shape by writing to a scratch model
  pitfalls.md                 the pre-flight checklist
  example-plugin.md           the worked example, annotated: what a finished zip contains
assets/
  template/                   a working plugin: client, mock server, 26-assertion test suite
  scripts/                    pack.ps1 and verify-zip.ps1
examples/                     a real shipped plugin, as the zip that was released
```

## The worked example

`examples/` holds **Concurrent Force Reporter v1.0.0** — a plugin that actually
shipped — as the exact zip that was released. It is there so that "what am I
handing over at the end?" has an answer you can unzip and look at, rather than a
description you have to trust.

`assets/template/` is where a plugin *starts*. The example is what one *ends up
as*: 20 plain-text files at the zip root, nothing compiled or minified, no
`node_modules`, no test suite, no mock server, and no external requests. The
template's `package.json`, `test/` and `mock-midas/` are how a plugin gets built
and are deliberately absent from the archive the host opens.

```bash
unzip -l examples/MIDAS_CIVIL_NX_Concurrent_Force_Reporter_v1.0.0.zip
```

`references/example-plugin.md` walks through it: the manifest and the window-size
trap Windows display scaling causes, why the read/write claim sits in the header,
why the logic lives in DOM-free modules, why `VALIDATION.md` ships inside the zip
and has to say what was *not* checked — and a ship checklist to run your own
archive against.

Ask Claude to "compare my plugin zip against the example" and it will.

## Install

**Recommended — install as a plugin.** This is the only method that can be
updated in place, so you get corrections as they land.

```bash
claude plugin marketplace add manojkheterpalmidas-arch/midasplugin
claude plugin install midasplugin@midas-plugins
```

Or from inside Claude Code, `/plugin marketplace add manojkheterpalmidas-arch/midasplugin`
then `/plugin install midasplugin@midas-plugins`.

**Alternative — clone into your skills directory.** Simpler, but it is a
snapshot: nothing will tell you when it changes, and you update it by hand.

```bash
git clone https://github.com/manojkheterpalmidas-arch/midasplugin ~/.claude/skills/midasplugin
```

Either way, then ask Claude to build a CIVIL NX plugin, or invoke the skill by
name.

## Update

The skill is corrected whenever a live session turns up something new, so it is
worth pulling occasionally. **Claude does not fetch this repo on its own** — an
installed copy stays exactly as it was until you update it.

If you installed it as a plugin:

```bash
claude plugin update midasplugin@midas-plugins
```

If you cloned it into your skills directory:

```bash
git -C ~/.claude/skills/midasplugin pull
```

**Start a new Claude session afterwards.** A session already running built its
skill list at startup and will not reliably notice the change.

The template runs on its own too, with no Claude involved:

```bash
cd assets/template
node mock-midas/server.js     # then open the URL it prints
node test/run.js              # 26 assertions, no CIVIL NX needed
```

## A taste of what's inside

Five behaviours that every plugin gets wrong at least once:

- **Errors arrive as HTTP 200 with an `error` key.** Checking `response.ok`
  reports every rejected write as a success.
- **A successful write also returns a `message` field.** Treating any `message`
  as failure makes the plugin report an error *after* the data landed — and the
  user commits again and duplicates everything.
- **An absent table returns 200 `{"message":""}`; a wrong table key returns
  404.** So 404 means *your key is wrong*, not *the model has none*.
- **A verified key does not mean a live session.** `/mapikey/verify` still
  answers `keyVerified: true` after CIVIL NX closes, with
  `status: "disconnected"`.
- **`OPT_CS` is a mode switch, not a filter.** One `/post/TABLE` request returns
  the construction-stage series *or* everything else, never both — and the
  family it excludes comes back absent at HTTP 200 with no error. A combination
  mixing stage cases with static ones cannot be read in one call.

## Scope and caveats

Written for **CIVIL NX 2026** on Windows. MIDAS can change behaviour between
builds. Treat every shape here as a strong starting point and re-verify anything
a plugin depends on; where something was never confirmed against a live model it
is marked **unverified**, and should stay marked.

Not affiliated with or endorsed by MIDAS IT

Plugins Made till now - 

CS454 Auto Lane Generator  ----------  Marketplace version 1.0.4 https://support.midasuser.com/hc/ko/articles/61259225090329

CS 454 Load Assessment Combinations  ----------    Marketplace version 1.0.2 https://support.midasuser.com/hc/en-us/articles/60997850893209

CS 454 Moving load generator  ---------- Marketplace version 1.0.3 https://support.midasuser.com/hc/en-us/articles/60998764028185

Eurocode Auto Lane Generator  ----------  Marketplace version 1.0.2 https://support.midasuser.com/hc/ko/articles/61259174909849

Eurocode Load Combinations Plugin  ----------  Marketplace version 2.0.1   https://support.midasuser.com/hc/ko/articles/61259382041369

Eurocode Moving Load Case Generator  ----------  Marketplace version 1.0.1 https://support.midasuser.com/hc/ko/articles/61259043302041

Skew Grillage Geometry   ----------   Marketplace version 1.0.4   https://support.midasuser.com/hc/en-us/articles/60848423734169

Point to Patch Convertor   ----------  Marketplace version 1.0.1 Point to Patch Convertor

Model Report Builder  ----------  Marketplace version 1.0.1  Model Report Builder 

Load Combination Contribution Analyzer ----------   Marketplace version 1.0.2  https://support.midasuser.com/hc/ko/articles/61258768334233

Bulk Tabular Result Exporter  ----------    Marketplace version 1.0.1  https://support.midasuser.com/hc/en-us/articles/60848073556633

## Licence

MIT — see [LICENSE](LICENSE). Use it, fork it, ship plugins with it.
