---
name: midasplugin
description: Build, test and package plugins for MIDAS CIVIL NX — the MAPI client, the plugin-host contract, verified request and response shapes for /db/, /post/TABLE and /view/CAPTURE, an offline mock so the plugin can be developed without CIVIL NX open, and the zip rules the host actually accepts. Use when creating or modifying a CIVIL NX plugin, calling the MIDAS MAPI, debugging a plugin that reports success but changes nothing in the model, or packaging a plugin for release.
---

# MIDAS CIVIL NX plugin builder

A MIDAS CIVIL NX plugin is **a static web page in a zip**. The host opens
`index.html` in an embedded WebView2 browser, hands it a MAPI key on the query
string, and the page talks to CIVIL NX over HTTPS. There is no plugin SDK, no
build step required, and no runtime the host provides beyond the browser and two
window messages.

That simplicity is the whole opportunity: a folder of plain HTML, CSS and JS,
zipped, is a shippable plugin. Everything hard about this work is in the API's
undocumented behaviour, and that is what the references here carry.

## Read this first: the four rules that cause the most lost time

1. **Errors arrive as HTTP 200 with an `error` key.** Checking `response.ok`
   reports every rejected write as a success. Always parse the body and test for
   `error`. See `references/mapi.md`.
2. **A successful write also returns a `message` field.** Treating any `message`
   as failure makes a plugin report an error *after* the data landed — and the
   user then commits again and duplicates everything. Only `error` is an error.
3. **An absent table returns 200 `{"message":""}`; a wrong table key returns
   404.** So 404 means *your key is wrong* (a bug to surface), not *the model has
   none*. Plugins routinely have this backwards.
4. **A verified key does not mean a live session.** `/mapikey/verify` still
   answers `keyVerified: true` after CIVIL NX closes, with
   `status: "disconnected"`. Check `status === "connected"`.

## Workflow

### 1. Establish what the plugin reads and writes, and say it in the UI

Decide up front whether the plugin is **read-only**, **non-mutating** (reads plus
result-table POSTs, which change nothing) or **writing**. This is not
bookkeeping — engineers will not run a tool on a live model they cannot
characterise, and it drives the code:

- A non-mutating plugin should **whitelist its POST paths in the client** and
  throw on anything else, and strip `EXPORT_PATH` from every body (that is the
  argument that makes CIVIL NX write files to disk).
- A writing plugin needs a **preview before commit**, and needs to know that
  `PUT /db/<T>` **upserts by id and does not clear the table** — rebuilding with
  fewer elements leaves the old high-numbered ones behind.

Put the claim in the header of the UI, worded exactly.

### 2. Scaffold from the template

`assets/template/` is a working plugin: connection handling, the MAPI client,
theming, window drag and close, an offline mock server, and a Node test runner.
Copy it, rename, and start replacing `app.js`.

```bash
cp -r assets/template ../my-plugin
```

Then set the name in `manifest.json`, `index.html` (title + header), and
`package.json`. Window size lives in `manifest.json`; 1280x760 is a good default
— larger and it covers too much of CIVIL NX to be usable beside the model.

### 3. Build against the mock, not the program

`mock-midas/server.js` serves the API *and* the plugin folder from one process,
so the whole plugin runs with CIVIL NX closed. Open it as:

```
http://localhost:8772/index.html?mapiKey=mock-key&redirectTo=http://localhost:8772/civil
```

The mock earns its keep only if it is **arithmetically consistent** — it should
compute combination values from the values it reports for the children, and
quantise at every node, so the plugin's own self-checks are a real test rather
than a tautology. Give it the scenarios a live model may not have (envelopes
whose governing child differs along a member, near-ties, colliding id spaces).

Keep the logic in **pure modules** with no DOM and no network, so `node test/run.js`
can exercise them. `app.js` should be wiring only.

### 4. Verify against a live model before release

The mock cannot settle API behaviour — only a connected CIVIL NX can. When a
shape is unknown, **probe it**: write candidates to a scratch model and read the
published properties back. `references/probing.md` documents the perturbation
sweep method that settled the PSC section guide curves exactly.

Record what you verified, on which model, and on which build. Anything unverified
must be labelled as such in the readme, not quietly presented as fact.

### 5. Package

Windows PowerShell 5.1 `Compress-Archive` writes `vendor\file.js` with
**backslashes**, which the ZIP spec forbids and which can stop folders
unpacking in the host. Use `assets/scripts/pack.ps1`, which builds the archive
entry by entry through .NET with the separators set explicitly, then
`verify-zip.ps1` to prove the zip matches the source hash for hash.

Files go at the **zip root** — `index.html` must be the top-level entry, not
inside a folder.

## References

Load these as needed; do not read them all up front.

| File | What it holds |
|---|---|
| `references/mapi.md` | Connection, error semantics, `/db/` reads, `PUT` writes, `/view/CAPTURE`, the exact failure messages and what each means |
| `references/result-tables.md` | `POST /post/TABLE` — the Argument shape, table tokens, load-case series suffixes, and the envelope-addressing trap that returns silence |
| `references/write-shapes.md` | Verified payloads: NODE, ELEM, MATL, SECT, THIK, GRUP, and the field-name traps |
| `references/host.md` | The plugin host contract: query string, window messages, manifest, packaging, WebView2 quirks |
| `references/ui.md` | Layout and theming conventions that make a plugin look native beside MIDAS's own, plus moaui component notes for patching shipped bundles |
| `references/testing.md` | The mock + Node harness pattern, and how to verify offline |
| `references/probing.md` | How to settle an unknown API shape by writing to a scratch model |
| `references/pitfalls.md` | The consolidated checklist — read before shipping |

## Provenance

Everything in these references was **measured against live CIVIL NX 2026
sessions** between July and August 2026 while building and patching real
plugins, not read from documentation — in several places it corrects the
published JSON manual. MIDAS can change behaviour between builds. Treat the
shapes as strong starting points and re-verify anything a plugin depends on;
where something was never confirmed live it is marked **unverified** and should
stay marked.
