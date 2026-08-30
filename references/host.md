# The plugin host contract

CIVIL NX opens the plugin in an embedded **WebView2** browser window. There is no
SDK. The whole contract is: a query string in, two messages out, and a manifest
that sizes the window.

## What the host gives the plugin

```
index.html?mapiKey=<key>&redirectTo=<base url>
```

```js
const params  = new URLSearchParams(location.search);
const key     = params.get("mapiKey") || "";
const base    = (params.get("redirectTo") || DEFAULT_BASE).replace(/\/+$/, "");
```

A base remembered in `localStorage` must **never** override `?redirectTo=`.

## What the plugin sends the host

Via `chrome.webview.postMessage`, as bare strings:

| Message | Effect |
|---|---|
| `REQ_WND_MOVE` | begin dragging the plugin window |
| `REQ_EXIT` | close the plugin window |

**`REQ_MOVE` is ignored.** One plugin's title bar did nothing for months because
it sent `REQ_MOVE` — while `REQ_EXIT` was right, so the close button worked and
hid the problem.

**`REQ_WND_MOVE` must be posted from a `mousedown` handler.** From
`pointerdown` it does nothing at all, while `REQ_EXIT` from the same bridge keeps
working — so the bridge looks healthy. Gate on the button so a right-click on the
header does not start a drag and swallow the context menu:

```js
header.addEventListener("mousedown", (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  if (e.target.closest("button, input, select, nav, a")) return;
  try { chrome.webview.postMessage("REQ_WND_MOVE"); } catch (_) { /* not hosted */ }
});
```

Always wrap in try/catch — outside the host, `chrome.webview` does not exist and
the plugin must still run in a plain browser for development.

**When a host integration looks wrong, grep a MIDAS-shipped plugin before
guessing.** The authority for both messages is MIDAS's own Load Combination
Analyzer bundle, which posts `REQ_WND_MOVE` from its title bar's `onMouseDown`.

## manifest.json

```json
{
  "short_name": "MyPlugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "One sentence the plugin list will show.",
  "icons": [
    { "src": "favicon.ico", "sizes": "16x16 32x32 48x48 64x64", "type": "image/x-icon" },
    { "src": "icon.svg", "sizes": "any", "type": "image/svg+xml" }
  ],
  "start_url": ".",
  "display": "standalone",
  "theme_color": "#ffffff",
  "background_color": "#eef0f2",
  "width": 1280,
  "height": 760
}
```

`width` / `height` size the plugin window. **1280×760 is a sensible ceiling** —
one plugin shipped at 1180×900 and was cut back because it covered too much of
CIVIL NX to be usable beside the model.

## Packaging

**Files go at the zip root.** `index.html` must be a top-level entry, not inside
a folder.

**Do not use `Compress-Archive` on Windows PowerShell 5.1.** It writes
`vendor\file.js` with backslash separators, which the ZIP spec forbids and which
can stop a subfolder unpacking in the host. Build the archive entry by entry
through .NET with the separator set explicitly — `assets/scripts/pack.ps1` does
this, and `verify-zip.ps1` then confirms every entry matches the source file
hash for hash, and that no development-only file leaked in.

Ship a **versioned** zip and leave earlier versions in place; users run the
plugin from the zip and an overwritten version destroys their rollback. Keep the
version in step across `manifest.json`, the header line in `index.html`, the
readme, and any metadata the plugin writes into its own output.

## WebView2 quirks that bite

- **A hidden or backgrounded plugin window throttles timers to about 1/s.**
  Exports that yield per figure take minutes instead of seconds. It is not a
  hang — measure with the window displayed.
- **`requestAnimationFrame` is suspended when the window is not compositing.**
  Race every rAF against a timer.
- **Nothing in either shipped combination plugin had ever downloaded or opened a
  file**, so whether the host window permits a download is *unverified*. If the
  plugin exports, provide a "show as text" fallback box that the user can copy
  from, and fall back to it when a save is blocked.
- Storage is per-plugin and survives, so `localStorage` is fine for settings —
  but **never cache the model**. A restored copy looks identical to a fresh one
  while describing whatever was open when the window closed.

## Rebuilding or patching a shipped plugin

MIDAS's own plugins ship as **production bundles with no source and no source
map** (esbuild or webpack). Patching one is legitimate and works, with two rules:

1. **Locate every site by code *shape*, not by identifier name.** Both
   toolchains rename locals between builds, so a patch anchored on names breaks
   on the very next release. Write the patch as a script that discovers its
   anchors by regex on structure and **aborts without writing** if any site is
   not found exactly once.
2. **Run `node --check` on the patched bundle before writing it.** A malformed
   injection otherwise surfaces only as a blank panel in the browser.

Keep the patch script, not just the patched file — the developer's next build
overwrites everything.

### Verifying a patch without CIVIL NX

**A React-based plugin's `#root` never mounts outside the MIDAS host — an empty
page is not a patch failure.** Serving the extracted folder as a static site
leaves `#root` empty in the *unpatched* build too, so the blank panel proves
nothing either way and has been misread as a broken patch more than once.

What does work, with the folder served over HTTP:

- `node --check` on the bundle — catches the malformed injection.
- Expose the patched helpers on `globalThis` (`globalThis.__myPatch = {...}`)
  and call them from the page console. They are reachable even though the app
  never mounts, so the new logic can be unit-tested against real inputs.
- `eval` the injected helper block directly in node for bulk cases — a
  3000-row stress run over a naming fitter takes seconds and proves uniqueness
  and length compliance before the plugin ever opens.

Discover the bundle's own running counters by shape and reuse them rather than
introducing new ones, so anything the patch renames stays unique against records
the unpatched code also writes.
