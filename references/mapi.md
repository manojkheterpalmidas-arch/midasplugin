# The MIDAS MAPI — connection, reads, writes, error semantics

Measured against live CIVIL NX 2026 sessions. Not documentation.

## Connection

```
Base URL   https://moa-engineers.midasit.com:443/civil
Header     MAPI-Key: <key>
```

CIVIL NX must be **open**. The key is issued from inside the program
(Tools → MAPI Key) and is per-session-ish: it survives, but the session behind it
does not.

The host hands the plugin its key and base on the query string:

```
index.html?mapiKey=<key>&redirectTo=<base>
```

**A saved base must never override the host's `?redirectTo=`.** Plugins that
remember a base from localStorage and prefer it will connect to the wrong
instance when the host moves.

### Verifying

`/mapikey/verify` sits **outside** the program prefix — reach it by stepping up
out of `/civil`, not by appending:

```js
const url = base.replace(/\/civil$/, "") + "/mapikey/verify";
```

```jsonc
{ "keyVerified": true, "status": "connected", "program": "civil" }
```

**`keyVerified` alone is not enough.** After CIVIL NX closes the key still
verifies, with `status: "disconnected"`, and every subsequent request fails with
`client does not exist`. Gate on `status === "connected"`.

## Error semantics — the single most important section

**Errors come back as HTTP 200 with an `error` key.**

```json
{ "error": { "message": "..." } }
```

A plugin that checks `response.ok` reports every rejected request as a success.

**A success may also carry a `message` field.** Treating any `message` as an
error makes a plugin report failure *after* the write landed; the user commits
again and duplicates the data. Only `error` / `ERROR` / `Error` are error-shaped.

One exception to the 200 rule: on `Assign`-style batch section writes, an error
has been seen returned as **HTTP 201** with an `error` key. Parse the body
regardless of status; never branch on status alone.

### The failure messages, and what each actually means

| Message | Meaning |
|---|---|
| `Wrong Field` | The **key name** is not recognised. Stop guessing values — fix the key. |
| `[Error] <Table>(No:1) data contain errors.` | Keys are fine; the **values or their arrangement** are not. |
| `[Error] Section Dimensions has(have) been incorrectly entered.` | Usually a **JOINT flag on with its dimension zero**. That rejection is itself evidence pairing joints to dimensions. |
| `Failed to get material data for: <name>` | The `STANDARD` DB does not exist in this install (e.g. `EN05(RC)` where only `EN04(RC)` is present). |
| `client does not exist` | The CIVIL NX session is gone even though the key verifies. |
| `second query is wrong` | (post/TABLE) No element of that table's type among the requested keys. |
| `there was an error creating utbl. (ex PostMode ...)` | (post/TABLE) The **table token does not exist**. Reads like an un-analysed model and is not. |
| `Cannot generate table data as there is no analysis result` | (post/TABLE) Genuinely not analysed, or an edit invalidated the results. |

post/TABLE messages are **prefixed with the `TABLE_NAME` you chose**, so never
anchor a match at the start of the string.

## Reading — `GET /db/<TABLE>`

```js
const r = await fetch(base + "/db/" + key, { headers: { "MAPI-Key": key } });
const body = await r.json();
```

Response is keyed by the table name, with **string row ids**:

```json
{ "NODE": { "1": { "X": 0, "Y": 0, "Z": 0 }, "2": { ... } } }
```

Three outcomes, and telling them apart matters:

| Result | Meaning |
|---|---|
| `{ "<KEY>": { ... } }` | rows |
| HTTP 200 `{"message":""}` | the table exists, **the model has no data of that kind** |
| HTTP 404 | **the key is wrong** — a bug in the plugin, surface it |

Any plugin treating 404 as "not defined" has it backwards.

**Paths are case-insensitive** — `/db/MVLDbs` and `/db/MVLDBS` both answer 200.

**A query string on a GET is parsed as an expression, not parameters.**
`?DATA=1` answers 500 `"Expected Rbracket, got: Number"` — it is a JMESPath-style
projection over the response, so it cannot fetch anything the plain GET does not
already return.

### Reading efficiently

Read tables **concurrently** with `Promise.all`, and **declare dependencies** so
the plugin does not read 47 tables to report on sections. A `needs(n)` predicate
given the row count of tables already read, returning `null` to proceed or a
short reason to skip, works well in one forward pass — a `needs` may only look at
keys read *above* it. Measured on a real plugin: sections-only 9/47 reads,
geometry-without-loads 28/47.

File a skipped read as the **existing** "empty" status with a reason attached,
not a new status value — downstream code testing for known statuses will
otherwise mis-handle every skip. And say *"not read — no elements in the model"*
rather than *"not defined"*: it is the weaker and more honest claim.

## Writing — `PUT /db/<TABLE>`

Body is the same id-keyed shape as a read:

```json
{ "Assign": { "1": { "X": 0, "Y": 0, "Z": 0 } } }
```

**`PUT` upserts by id; it does not wipe the table.** Rebuilding a model with
fewer elements leaves the old high-numbered ones behind. To replace a model,
`DELETE` first, in dependency order: `GRUP`, `ELEM`, `NODE`.

`DELETE /db/SECT` empties the whole table. `DELETE /db/<TABLE>/<key>` removes a
**single row** — but `DELETE /db/<TABLE>/key/<n>` is a 404, so the key goes
straight on the path with no `key` segment.

**The id you send is not always the id you get.** `Assign` at an **existing**
key overwrites that row. At a **non-existent** key MIDAS **ignores the number
and appends at the next free slot**. A plugin that writes id 900 into an empty
table and then reports "written as 900" is guessing — read the table back if the
id matters downstream.

**One bad entry rejects the whole batch.** When probing or when a failure needs
localising, post entries individually.

Reuse ids by name where the plugin may be run twice: read the existing table,
map `NAME → id`, and keep the id so a second run refreshes the same records
instead of stacking duplicates beside them.

**Re-read the table immediately before writing — never trust the last Read.**
A plugin that writes from a model snapshot taken minutes earlier will skip
creating a record the snapshot still lists but the user has since deleted, and
the dependent write then fails with something unrelated-sounding
("Vehicle has not been selected."). This surfaces as an *intermittent* failure
that no one can reproduce on demand, because it depends on what the user did in
CIVIL NX between the two clicks.

Names and descriptions have **length caps that reject the write** — see
`write-shapes.md`, "Name and description length caps".

## Images — `POST /view/CAPTURE`

The **only** image route on the API.

```json
{ "Argument": { "SET_MODE": "pre", "SET_HIDDEN": false,
                "WIDTH": 1600, "HEIGHT": 900,
                "ANGLE": { "HORIZONTAL": 30, "VERTICAL": 20 } } }
```

Returns `{"base64String": "<JPEG>"}` **in the response — nothing is written to
disk**. Omit WIDTH/HEIGHT to get the CIVIL NX window's own size. Works on an
un-analysed model in `pre` mode, which makes it a good way to prove a build
landed.

With `{"Argument": {"FIGURE_NAME": "<name>"}}` it renders a **saved user figure**
instead of the live viewport — its own shaded view, byte-identical on repeat, and
honouring WIDTH/HEIGHT. Do **not** send `SET_MODE`/`SET_HIDDEN` alongside it; the
figure carries its own display state. An unknown name answers HTTP 200 with
`{"error":{"message":"MIDAS CIVIL NX It's not found Figure Name"}}`.

`/db/UFIG` is the figure **index — name only**, and the name is the handle:
`{"UFIG":{"1":{"NAME":"Test Image"}}}`. No table serves the bytes; roughly sixty
candidate paths were tried and all 404. `POST /view/CAPTURE` is the route.

A `GET` on `/view/CAPTURE` answers 200 `{"message":"error status"}`.

## `EXPORT_PATH`

Several endpoints accept an `EXPORT_PATH` argument that makes **CIVIL NX write a
file to the user's disk**. A plugin claiming to be non-mutating must strip it
from every outgoing body, unconditionally, in the client — not at the call sites.

## Client skeleton

`assets/template/js/mapi.js` implements all of the above. The parts worth
keeping whatever else you change:

- `verify()` gating on `status`, not just `keyVerified`
- `db()` returning `{rows, status}` with `ok` / `empty` / `absent` distinguished
- a POST path **whitelist** that throws on anything not on it
- `delete Argument.EXPORT_PATH` before every send
- an error class that attaches a **hint** per known message, so the UI can say
  what to do rather than echoing MIDAS's wording
