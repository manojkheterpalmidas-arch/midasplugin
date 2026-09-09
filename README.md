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
assets/
  template/                   a working plugin: client, mock server, 26-assertion test suite
  scripts/                    pack.ps1 and verify-zip.ps1 (Windows), pack.js (anywhere)
plugins/
  concurrent-forces/          a finished plugin built on the skill, with its release zip
```

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

So does the finished plugin in `plugins/concurrent-forces`:

```bash
cd plugins/concurrent-forces
node mock-midas/server.js     # then open the URL it prints
node test/run.js              # 247 assertions, no CIVIL NX needed
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

## Concurrent Forces — a plugin built on this skill

`plugins/concurrent-forces` is a complete, installable plugin rather than an
example. It reports the **coexistent** results across a set of items: nominate
one key item and one result quantity, and it finds the load case, combination,
stage and step at which that quantity governs there, then reports every other
item in the set **at that same structural state**.

The driver can be any quantity the model publishes — a member force, a plate
force, a general or elastic link force, a node reaction or a displacement — and
the set can mix all of them.

CIVIL NX gives concurrent *components* at a single element; it has never given
concurrent *elements*. Tabulating each element's own maximum side by side
produces a set of numbers that never occurred together — which is the mistake
the plugin exists to prevent.

Its rule is that two results are concurrent only if they share one deterministic
structural state, keyed on `(Load, Stage, Step)`. Moving load, settlement,
response spectrum, ABS, SRSS and step-less time history are **blocked with the
workaround named**, because each is already an envelope at source. Envelope
combinations are **resolved** instead — recursively, to a single-valued leaf or
a weighted sum, gated against the value MIDAS itself publishes, and displayed as
*"ULS_Env resolved to ULS_Comb_07"*.

Install `plugins/concurrent-forces/dist/Concurrent Forces v1.2.1.zip` from the
CIVIL NX Plug-in menu. The plugin's own readme records what is verified and what
was probed at runtime rather than assumed.

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
