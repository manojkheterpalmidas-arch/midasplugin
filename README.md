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
SKILL.md                      the workflow and the four rules that cost the most time
references/
  mapi.md                     connection, error semantics, reads, writes, image capture
  result-tables.md            POST /post/TABLE, tokens, load-case series, the envelope trap
  write-shapes.md             verified payloads for NODE, ELEM, MATL, SECT, THIK, GRUP
  host.md                     the plugin-host contract, manifest, packaging, WebView2 quirks
  ui.md                       layout, theming, moaui notes for patching shipped bundles
  testing.md                  the mock + Node harness pattern
  probing.md                  settling an unknown API shape by writing to a scratch model
  pitfalls.md                 the pre-flight checklist
assets/
  template/                   a working plugin: client, mock server, 26-assertion test suite
  scripts/                    pack.ps1 and verify-zip.ps1
```

## Install

Clone into your skills directory:

```bash
git clone https://github.com/<you>/midasplugin ~/.claude/skills/midasplugin
```

Then ask Claude to build a CIVIL NX plugin, or invoke it by name.

The template runs on its own too, with no Claude involved:

```bash
cd assets/template
node mock-midas/server.js     # then open the URL it prints
node test/run.js              # 26 assertions, no CIVIL NX needed
```

## A taste of what's inside

Four behaviours that every plugin gets wrong at least once:

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

## Scope and caveats

Written for **CIVIL NX 2026** on Windows. MIDAS can change behaviour between
builds. Treat every shape here as a strong starting point and re-verify anything
a plugin depends on; where something was never confirmed against a live model it
is marked **unverified**, and should stay marked.

Not affiliated with or endorsed by MIDAS IT.
