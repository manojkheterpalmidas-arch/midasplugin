# Plugin Template — MIDAS CIVIL NX

A working starting point. It connects to CIVIL NX, reads the open model and
summarises what it contains. Every piece of it is there because of something
that went wrong on a real plugin — read the comments before deleting anything.

## Run it without CIVIL NX

```bash
node mock-midas/server.js
```

Then open:

```
http://localhost:8772/index.html?mapiKey=mock-key&redirectTo=http://localhost:8772/civil
```

Serve over **HTTP, not `file://`** — a `file://` page can serve a stale snapshot
of some scripts while refreshing others, so UI changes appear to do nothing.

## Run the tests

```bash
node test/run.js
```

26 assertions against the mock over real HTTP. If every `require()` returns an
empty object, a parent folder's `package.json` says `"type": "module"` and the
local `"type": "commonjs"` has gone missing.

## Run it in CIVIL NX

```powershell
..\..\scripts\pack.ps1 -Source . -Out "$env:USERPROFILE\Downloads\My Plugin v1.0.0.zip"
..\..\scripts\verify-zip.ps1 -Source . -Zip "$env:USERPROFILE\Downloads\My Plugin v1.0.0.zip"
```

`pack.ps1` excludes `test/`, `mock-midas/` and `package.json`, builds the archive
with forward-slash separators (`Compress-Archive` does not), and refuses to
finish unless `index.html` is at the zip root.

Install the zip from CIVIL NX's plugin manager.

## What is where

| File | Role |
|---|---|
| `index.html` | markup and the header claim |
| `styles.css` | one palette, swapped on `[data-theme]` |
| `js/mapi.js` | the API client — error semantics, POST whitelist, `EXPORT_PATH` stripping |
| `js/model.js` | pure: reads tables, gates endpoints on what they need, summarises |
| `js/theme.js` | follows the OS until the user chooses |
| `js/app.js` | wiring only — no logic lives here |
| `mock-midas/server.js` | the API and the static files, from one process |
| `test/run.js` | the offline suite |

## Making it yours

1. Rename in `manifest.json`, `index.html` (title, `<h1>`, version line) and
   `package.json`.
2. Replace `icon.svg`.
3. **Decide the read/write claim** and make the header say it. `ALLOWED_POST` in
   `js/mapi.js` is what backs the claim — keep the two in step.
4. Put your engineering in a new pure module beside `model.js`. Keep `app.js` as
   wiring, or the test harness stops being able to reach anything.
5. Extend the mock with the awkward cases your plugin must survive, then test
   against it.

## Things not to undo

- `verify()` gates on `status === "connected"`, not just `keyVerified` — a key
  keeps verifying after CIVIL NX closes.
- `db()` distinguishes **empty** (200 `{"message":""}` — the model has none) from
  **absent** (404 — the plugin used a wrong key). Most plugins have these
  backwards.
- Errors are read from the **body**, never from the HTTP status. CIVIL NX returns
  200 with an `error` key.
- A `message` in a response is **success**, not failure. Treating it as an error
  makes the plugin report failure after the write landed, and the user then
  commits twice.
- Window drag posts `REQ_WND_MOVE` (not `REQ_MOVE`) from a **`mousedown`**
  handler (not `pointerdown`).
