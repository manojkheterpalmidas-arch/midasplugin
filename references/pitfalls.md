# Pre-flight checklist

Every line here cost someone real time. Read before shipping.

## API

- [ ] The client parses the **body** and tests for `error` — it does not branch
      on HTTP status. Errors arrive as **200** (sometimes 201) with an `error`
      key.
- [ ] A `message` field is **not** treated as an error. Only `error`/`ERROR`/
      `Error` are. Otherwise a successful commit reports failure, the user
      commits again, and the data is duplicated.
- [ ] 404 is surfaced as **"the plugin used a wrong table key"**, not as "the
      model has none". Empty is 200 `{"message":""}`.
- [ ] Connection checks `status === "connected"`, not just `keyVerified`.
- [ ] `?redirectTo=` always wins over any remembered base.
- [ ] `EXPORT_PATH` is stripped from every outgoing body, in the client.
- [ ] POST paths are whitelisted if the plugin claims to be non-mutating.
- [ ] Every requested result series is **checked for in the response** — an
      unaddressable series is dropped silently with no error.
- [ ] The `(CB)` / `(CB:max)` suffix is computed from **recursive**
      envelope-valuedness, not from the combination's own type.
- [ ] Load-case names are not parsed with a greedy paren regex — real names
      contain parentheses.
- [ ] Selections carry a **namespace**. Element and elastic-link ids collide, on
      the order of hundreds per model.
- [ ] `PUT` is known to **upsert, not replace**; a rebuild deletes GRUP, ELEM,
      NODE first if that is the intent.
- [ ] Table `HEAD` columns are found **by name** — `No.`/`Node`/`Elem` differ per
      table.
- [ ] Node result tokens carry the coordinate suffix: `REACTIONG`,
      `DISPLACEMENTG`.

## Correctness

- [ ] Every reconstruction is **gated against a published quantity** and
      discarded when it misses, falling back to something the reader can check.
- [ ] "Not applicable" is distinguished from "pass" over an empty population.
- [ ] A resolved load state is never re-read **by name** at another location —
      that returns the other location's own extreme, measured 72% out.
- [ ] Near-ties have a stated policy. They are common, not a corner case.
- [ ] Combination types that cannot yield a coexistent state (ABS, SRSS) are
      **refused**, not approximated.
- [ ] Anything unverified against a live model says so, in the readme and in the
      UI. Construction stages are usually the unverified one.

## Host

- [ ] Drag posts **`REQ_WND_MOVE`** (not `REQ_MOVE`) from a **`mousedown`**
      handler (not `pointerdown`), gated on `button === 0 || 1`, and ignores
      clicks on controls.
- [ ] Close posts `REQ_EXIT`. Both are wrapped in try/catch so the plugin still
      runs in a plain browser.
- [ ] Window size in `manifest.json` is 1280×760 or smaller.
- [ ] No CDN links. Everything vendored.
- [ ] The model is not cached in `localStorage` — a restored copy looks identical
      to a fresh one while describing a different model.
- [ ] Long operations are measured with the window **displayed**; hidden windows
      throttle timers to ~1/s and rAF is suspended.
- [ ] If it exports files, there is a copyable text fallback — whether the host
      window permits a download is unverified.

## Packaging

- [ ] Built with `pack.ps1`, **not `Compress-Archive`** (backslash separators).
- [ ] `verify-zip.ps1` run: every entry matches the source hash, no dev files
      leaked.
- [ ] `index.html` is at the **zip root**.
- [ ] Version is in step across `manifest.json`, the header line in
      `index.html`, `package.json`, the readme, and any metadata the plugin
      writes into its own output.
- [ ] Earlier versions left in place. The user runs from the zip; overwriting
      destroys their rollback.

## Development environment (Windows)

- [ ] Sources are UTF-8 **without BOM**, CRLF. Anything spliced in must match
      both.
- [ ] **Never** use PowerShell 5.1 `Get-Content` / `Out-File` on these sources if
      the machine's ANSI codepage is not UTF-8 — PS reads UTF-8 as the ANSI
      codepage and every em-dash and `×` comes back as mojibake. One splice that
      way corrupted a source file wholesale. `Copy-Item` is byte-exact and safe.
- [ ] Bash heredocs eat backslashes — write files with a proper file-writing tool.
- [ ] A local `package.json` with `"type": "commonjs"` exists if any parent
      folder declares `"type": "module"`, or every `require()` in the test
      harness returns an empty namespace.
- [ ] Preview over **HTTP**, never `file://` — it serves stale snapshots of some
      scripts while refreshing others.
