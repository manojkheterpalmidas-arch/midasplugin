# Pre-flight checklist

Every line here cost someone real time. Read before shipping.

## The window shell

![The plugin window shell](images/window-shell.svg)

- [ ] There **is** a close control, visible without scrolling. Check existence
      before correctness; every rule below passes vacuously without one.
- [ ] The close control is a **sibling** of the drag surface, not inside it. A
      test asserts they are not nested — pressing a ✕ that contains an icon
      delivers the `<path>` as the event target, not the button.
- [ ] The drag surface has `align-self: stretch` and fills the bar's height, so
      the strips above and below it drag too.
- [ ] Host messages go through one helper that **detects** a missing bridge.
      `window.close()` is a no-op in WebView2, so a `catch` that falls back to it
      is a button that fails in silence.
- [ ] An unhonoured `REQ_EXIT` reports itself on screen after ~800 ms.
- [ ] `REQ_WND_MOVE` is posted from **`mousedown`** (not `pointerdown`) and
      gated on `button === 0 || 1`.
- [ ] There are **two icons**: the black badge for the plugin list, and a flat
      solid-shape glyph in `#BDC2C8` for the title bar. Checked at 12 px on
      `#21272A` — a badge with a dark tile is invisible there.
- [ ] Long work is **chunked and yields**, with a `MessageChannel` message and
      not `setTimeout`. Anything that blocks for seconds makes the close button
      unclickable and will be reported as a broken close button.
- [ ] The run control is **not** inside a panel that any option can hide.
- [ ] `document.title` is set — the host displays it.

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
- [ ] Result rows are matched to requested cases by the label the **response**
      uses, not the one that was sent. The kind is dropped and only the sense
      survives: `Asphalt(ST)` comes back as `Asphalt`, `ENV-1(CB:max)` as
      `ENV-1(max)`. Build the expected label per case rather than stripping a
      suffix off the reply — names carry their own trailing parentheses.
- [ ] Selections carry a **namespace**. Element and elastic-link ids collide, on
      the order of hundreds per model.
- [ ] `PUT` is known to **upsert, not replace**; a rebuild deletes GRUP, ELEM,
      NODE first if that is the intent.
- [ ] The table is **re-read immediately before writing**, not written from a
      Read taken minutes earlier. A stale snapshot skips a record the user has
      since deleted and fails later with unrelated wording — intermittently, so
      it never reproduces on demand.
- [ ] Ids are **read back** where they matter. `Assign` at a non-existent key
      ignores the number and appends at the next free slot.
- [ ] Single-row delete is `DELETE /db/<TABLE>/<key>` — `/key/<n>` is a 404.
- [ ] Generated names are tested at their **longest** form, not the default —
      every optional suffix is a way to overrun the 20/60 caps. Budget 17 if the
      user can Commit.
- [ ] Over-budget names **merge separators before truncating**, and never
      truncate an identifying token (`V128`→`V12` names a different variant).
- [ ] Moving load: `VEHICLE_LOAD_NUM` is 1, `VEH_BS.LM1_CASE` carries
      single/convoy, and a special vehicle is written as its own shape — not a
      renamed clone.
- [ ] Moving load: an empty `SEL_VEHICLE` and a `SPECIAL_VIHICLE_NAME` that
      names no existing vehicle are both **accepted silently**. Validate before
      sending; the readback will not tell you.
- [ ] Table `HEAD` columns are found **by name** — `No.`/`Node`/`Elem` differ per
      table.
- [ ] Node result tokens carry the coordinate suffix: `REACTIONG`,
      `DISPLACEMENTG`.
- [ ] Construction-stage and non-CS series are requested in **separate calls**.
      `OPT_CS` is a mode switch, not a filter — one call answers with one family
      and drops the other silently.
- [ ] `OPT_CS` is never sent without `STAGE_STEP`; without it every stage comes
      back at once and rows keyed on one stage overwrite each other.
- [ ] A `CB` combination is requested in the **non-CS** family even when all its
      children are `CS`.
- [ ] Step tokens are taken from each stage's `bSV_STEP`. Where it is false only
      `002(last)` exists and everything else returns an empty table.
- [ ] Writes to `LCOM-*` are known to be refused unless the model is at the
      **Base or Final** stage, and the plugin warns beforehand — the active stage
      cannot be read through MAPI.
- [ ] A short `/db/LCOM-*` listing is checked against the **stage** before it is
      treated as data loss. Inside a stage only stage-valid combinations list.

## Correctness

- [ ] Every reconstruction is **gated against a published quantity** and
      discarded when it misses, falling back to something the reader can check.
- [ ] "Not applicable" is distinguished from "pass" over an empty population.
- [ ] A resolved load state is never re-read **by name** at another location —
      that returns the other location's own extreme, measured 72% out.
- [ ] Near-ties have a stated policy. They are common, not a corner case.
- [ ] Combination types that cannot yield a coexistent state (ABS, SRSS) are
      **refused**, not approximated.
- [ ] A series that comes back empty is diagnosed by **enumerating what the model
      publishes** (`LOAD_CASE_NAMES: []`) before the request is blamed. A
      combination can name constituents the analysis never produced.
- [ ] Anything unverified against a live model says so, in the readme and in the
      UI. Construction stages were that gap until August 2026 and are now
      measured — see `result-tables.md`; the remaining unknown is whether a
      stage-scoped result query moves the model's own active stage.

## Host

- [ ] **There is a close control at all**, visible without scrolling. Check this
      before anything below it — the host draws no window chrome, so a plugin
      that omits one cannot be dismissed from inside, and every "wired
      correctly" item here passes vacuously when the controls are simply absent.
      Hand-rolled scaffolds are where it goes missing; the template has it.
- [ ] Drag posts **`REQ_WND_MOVE`** (not `REQ_MOVE`) from a **`mousedown`**
      handler (not `pointerdown`), gated on `button === 0 || 1`, and ignores
      clicks on controls.
- [ ] Close posts `REQ_EXIT`, and the ✕ is excluded from the drag surface so
      pressing it cannot start a window move instead. Both messages are wrapped
      in try/catch so the plugin still runs in a plain browser.
- [ ] `document.title` is set from the manifest `name`, so the title the host
      shows cannot drift from the packaged one.
- [ ] Window size in `manifest.json` is 1280×760 or smaller.
- [ ] No CDN links. Everything vendored.
- [ ] The model is not cached in `localStorage` — a restored copy looks identical
      to a fresh one while describing a different model.
- [ ] Long operations are measured with the window **displayed**; hidden windows
      throttle timers to ~1/s and rAF is suspended.
- [ ] If it exports files, there is a copyable text fallback — whether the host
      window permits a download is unverified.

## Packaging

- [ ] A patched bundle was verified by `node --check` plus calling its injected
      helpers from the console — **not** by looking at the page. `#root` never
      mounts outside the host, patched or not.
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
