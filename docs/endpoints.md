# Zotero JS Bridge endpoint reference

This file is the complete reference for the eight HTTP endpoints that the Zotero JS Bridge plugin (v1.12) registers on Zotero's own local server, with each endpoint's purpose, parameters, response shape, and error codes.

## The endpoint layer

Zotero already runs an HTTP server on `127.0.0.1:23119` for its connector API. The plugin registers eight paths on that server, so a local script can execute JavaScript inside a running Zotero, merge duplicates, read the error console, query the library, and run health checks. All eight ride on Zotero's own server: nothing new is bound, and no socket is held open, so Zotero still exits cleanly.

Four endpoints can write (`exec`, `merge`, `apply`, `enrich`); the other four are read-only (`ping`, `logs`, `query`, `doctor`). Read-only mode closes the write paths and leaves the read ones open.

Requests whose `User-Agent` starts with `Mozilla/`, or that carry an `Origin` header, are dropped by Zotero's own CSRF guard before they reach the plugin. Command-line clients are unaffected; browser-side callers need `x-zotero-connector-api-version`, as with any Zotero plugin endpoint.

## Endpoint summary

| Method(s) | Path | Auth | Writes |
| --- | --- | --- | --- |
| GET | `/zoterojs/ping` | none | no |
| POST | `/zoterojs/exec` | `X-ZoteroJS-Token` | yes |
| POST | `/zoterojs/merge` | `X-ZoteroJS-Token` | yes |
| GET, POST | `/zoterojs/logs` | `X-ZoteroJS-Token` | no; `clear=true` counts as a write |
| GET, POST | `/zoterojs/query` | `X-ZoteroJS-Token` | no |
| GET, POST | `/zoterojs/doctor` | `X-ZoteroJS-Token` | no |
| POST | `/zoterojs/apply` | `X-ZoteroJS-Token` | yes, including a dry run |
| GET, POST | `/zoterojs/enrich` | `X-ZoteroJS-Token` | yes, on both verbs |

## Authentication, gates, and error codes

Every endpoint except `ping` requires the request header `X-ZoteroJS-Token`. The value is the plugin's token: it lives in the Zotero pref `extensions.zotero.jsbridge.token` and is mirrored to `<data-dir>/zoterojs-token.txt`, which is where the bundled client reads it. The comparison against the stored token is constant-time. Regenerating the token revokes the old one immediately — a client still holding the old value starts receiving `403`.

Authentication is checked before the gate, so a request with a missing or incorrect token receives `403` even when the endpoint or the whole bridge is switched off. The gate reads the prefs on every request, so a change in the preferences pane takes effect on the next call:

| Code | Condition | Extra body fields |
| --- | --- | --- |
| `503` | the master switch `extensions.zotero.jsbridge.enabled` is `false` | `error`, `pref` |
| `404` | that endpoint's own pref `extensions.zotero.jsbridge.endpoint.<name>` is `false` | `error`, `pref` |
| `403` | the bridge is in read-only mode (`extensions.zotero.jsbridge.readonly`) and the call counts as a write | `error`, `pref` |

The write-gated endpoints are `exec`, `merge`, `apply`, and `enrich`. `apply` and `enrich` are refused even for a dry run: read-only mode means the endpoint is not available, not that a rehearsal is allowed. `enrich` is gated as a write on both verbs, because its scan form extracts the full text of hundreds of PDFs and takes minutes. `logs` is gated as a read, and only its `clear` parameter is refused in read-only mode.

A missing or invalid token produces `403` with `{"ok": false, "error": "missing or invalid X-ZoteroJS-Token"}`. Bad parameters produce `400`; an unexpected internal failure produces `500` with `error` and `stack`.

Every JSON response is capped at `extensions.zotero.jsbridge.limit.responseKB` KB, default 1500 and clamped to 10–20000. When a payload exceeds the cap, the response keeps `ok` and adds `truncated: true` plus a `note`; `logs` is clipped to at most the last 50 entries within 4000 characters (with `logsOmitted` when entries are dropped), and `result` is re-serialized to depth 2.

## The `ping` endpoint

Health check and capability probe. `ping` needs no token and takes no parameters. It reports the plugin version, the Zotero version, the user library ID, the full endpoint list, which endpoints are currently switched off, and the live value of the read-only switch, so a client can ask what it is allowed to do rather than guessing.

Method: `GET`.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| — | — | — | None. |

Response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` on success |
| `name` | string | `"Zotero JS Bridge"` |
| `version` | string | plugin version — `"1.12"` in this release |
| `zotero` | string | `Zotero.version` |
| `libraryID` | number | user library ID |
| `endpoints` | array | all eight paths |
| `disabled` | array | the subset of paths currently switched off |
| `readonly` | boolean | live value of the read-only switch |

`disabled` and `readonly` are additive fields: clients that predate them see the same shape they always did.

```console
$ python zoterojs.py ping
{ "ok": true, "name": "Zotero JS Bridge", "version": "1.12", "zotero": "10.0.2",
  "libraryID": 1, "endpoints": ["/zoterojs/ping", ...], "disabled": [], "readonly": false }
```

Error codes:

| Code | Condition |
| --- | --- |
| `503` | master switch off |
| `404` | `endpoint.ping` off |

Because no token is required, `ping` cannot return an authentication error. It can be switched off like any other endpoint.

Bundled client: `zjs.ping()`, `python zoterojs.py ping`.

## The `exec` endpoint

Runs arbitrary JavaScript inside the running Zotero process. The code has `Zotero`, `Services`, `ChromeUtils`, `Components`, `Cu`, `Ci`, `Cc`, `PathUtils`, `IOUtils`, `OS`, and `log(...)` in scope. `Cu`, `Ci`, and `Cc` are `Components.utils`, `Components.interfaces`, and `Components.classes`. Values passed to `log(...)` are joined into strings and collected into the response's `logs` array instead of going to a console. Top-level `await` and `return` both work.

The code is compiled with `new AsyncFunction("Zotero", ..., "log", '"use strict";\n' + code)`. It is deliberately unrestricted: it runs with full access to the library and the Zotero process, and it is not a sandbox and does not pretend to be. The response's `mode` field reports which path ran: `"AsyncFunction"` normally, `"sandbox"` if the constructor itself was unavailable and the endpoint fell back to a system-principal `Cu.Sandbox` (exposing `Zotero`, `Services`, `Components`, `PathUtils`, `IOUtils`, and `log`), or `"unavailable"` if both failed.

Method: `POST` with an `application/json` body.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `code` | string | required | JavaScript source; a blank value returns `400` |

Response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` when the code finished without throwing |
| `mode` | string | `"AsyncFunction"`, `"sandbox"`, or `"unavailable"` |
| `ms` | number | wall-clock duration in milliseconds |
| `logs` | array of strings | values collected by `log(...)` during the call |
| `result` | any | the returned value, serialized; present when `ok` is `true` |
| `error` | string | exception message; present when `ok` is `false` |
| `stack` | string | stack of the thrown error; present when `ok` is `false` |

The serializer caps strings at 20000 characters, arrays at 300 entries, objects at 120 keys, and nesting at depth 4; Zotero Item and Collection objects are summarized to a few key fields instead of being dumped. A promise nested in a returned object is replaced by a marker string stating that it was not awaited, rather than serializing to `{}`.

Error codes:

| Code | Condition |
| --- | --- |
| `400` | `code` is missing or blank |
| `403` | missing or invalid token; read-only mode (`exec` is a write) |
| `404` | `endpoint.exec` off |
| `503` | master switch off |

A JavaScript exception is not an HTTP error: the call returns HTTP `200` with `ok: false`, the error message, and the stack.

```console
$ python zoterojs.py exec "return Zotero.Libraries.userLibraryID"
1
```

Bundled client: `zjs.exec(code, timeout=300)`, `zjs.execv(code)` for the bare result; `python zoterojs.py exec "<js>"`.

## The `merge` endpoint

Merges duplicate items behind a self-check. A merge runs only if every check passes. The rule is missing ≠ conflict — two items conflict only when both have a value and the values differ. That matters because online-first articles legitimately have no volume, issue, or pages yet, and a naive comparison rejects them as false duplicates.

The checks are same title, same item type, year, volume, issue, pages, DOI, and ISBN. Values are normalized before comparison: whitespace, `_.,;:()[]`, CJK punctuation, and every dash variant — ASCII `-`, en dash `–`, em dash `—`, minus sign `−`, non-breaking hyphen, zero-width space. Normalization matters because Zotero's translators routinely deliver `1–10` (U+2013) where `1-10` was typed, and comparing them literally rejects a genuine duplicate.

The ISBN check is the backstop for the classic disaster: two volumes of the same textbook with identical title and authors, differing only in ISBN and edition. Nothing else in the list separates them — `creators` and `edition` are not compared — so without that check the pair would pass, `master` would survive, and the duplicate volume would go to the trash. With it, the check fails, the duplicate is skipped, and both volumes stay. The backstop has one boundary: if only one volume carries an ISBN, missing ≠ conflict treats the pair as compatible and the check does not fire.

Method: `POST` with an `application/json` body.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `master` | string | required | key of the item that survives |
| `dups` | array of strings | required, non-empty | keys of the items to merge into `master`; each is moved to the trash |
| `dryRun` | boolean | `false` | run every check and report, without merging |

Response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `false` when `master` does not exist or is already in the trash; individual duplicate refusals are `report` entries, not errors |
| `dryRun` | boolean | echo of the request |
| `master` | object | `{key, title}` of the surviving item |
| `report` | array | one entry per duplicate key |
| `attachmentsAfter` | number | attachment count on `master` after the run |
| `backup` | object | present when the automatic backup ran (a real merge with the backup switch on) |

Each `report` entry contains:

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | the duplicate key |
| `merged` | boolean | whether it was merged |
| `why` | string | reason for a refusal: the item does not exist, is already in the trash, failed the self-check, or the merge call threw |
| `checks` | object | per-check booleans, present when the self-check ran |
| `dryRun` | boolean | `true` on a rehearsal entry |
| `attachments` | number | combined attachment count of `master` and the duplicate |
| `collections` | number | combined collection count; dry-run entries only |

The deep dive, including the reasoning behind missing ≠ conflict, is in [the `merge` self-check](merge.md).

Error codes:

| Code | Condition |
| --- | --- |
| `400` | `master` is missing or `dups` is empty |
| `403` | missing or invalid token; read-only mode (`merge` is a write, dry run included) |
| `404` | `endpoint.merge` off |
| `500` | an unexpected exception, including a failed automatic backup — the merge is then aborted |
| — | a missing or trashed `master` returns HTTP `200` with `ok: false` and an `error` string |

```console
$ python zoterojs.py merge ABCD1234 EFGH5678 --dry-run
{ "ok": true, "dryRun": true, "report": [{ "key": "EFGH5678", "merged": false, ... }] }
```

Bundled client: `zjs.merge(master, dups, dry_run=False)`; `python zoterojs.py merge MASTERKEY DUPKEY [DUPKEY ...] [--dry-run]`.

## The `logs` endpoint

Reads Zotero's error console and/or its debug output, so a script can check what a plugin — including this one — actually did without clicking through **Tools → Developer → Error Console**.

```bash
python zoterojs.py logs                         # newest 100 console messages
python zoterojs.py logs --min-level warning     # errors + warnings only
python zoterojs.py logs --grep "JS Bridge"      # anything mentioning the bridge
python zoterojs.py logs --source debug          # Zotero's own debug log
```

Methods: `GET` or `POST`. Parameters work the same over GET or POST (JSON body); a parameter supplied in both places takes its POST body value.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `source` | string | `console` | `console`, `debug`, or `both` |
| `minLevel` | string | `all` | `all` / `debug` / `info` / `warn` / `error` — "at least this severe". Also accepted under the alias `level` |
| `category` | string | — | substring match, case-insensitive |
| `grep` | string | — | substring match on the text (and on `logger`, when present) |
| `since` | number | — | epoch ms; only messages at or after this |
| `limit` | number | `100` | max messages to return, newest kept first (cap 1000) |
| `clear` | boolean | `false` | clear the sources you read — destructive, and refused in read-only mode |

Response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` on success |
| `source` | string | normalized source name |
| `params` | object | echo of the request parameters |
| `console` | object | console results; present unless `source=debug` |
| `debug` | object | debug results; present unless `source=console` |
| `cleared` | array | names of the sources that were cleared, when `clear` was set |
| `clearError` | string | present when clearing threw |

The `console` object contains `total`, `matched`, `returned`, `messages`, and — when matches were dropped — `omitted`:

| Field | Type | Meaning |
| --- | --- | --- |
| `total` | number | messages in the console buffer before filtering |
| `matched` | number | messages that passed the filters |
| `returned` | number | messages in this response |
| `omitted` | number | matched minus returned, when positive |
| `messages` | array | the message objects; the newest `limit` are kept, then returned in chronological order |

Each message comes back with these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `time` | number | epoch milliseconds |
| `iso` | string | ISO 8601 form of `time`, when `time` is nonzero |
| `level` | string | classified severity |
| `message` | string | the text, with the `Log.sys.mjs` prefix stripped when one was present |
| `logger` | string | logger name from that prefix, when present |
| `category` | string | when the console entry has one |
| `source` | string | source name, when the entry has one |
| `line`, `column` | number | script position, when the entry has them |
| `flags` | number | the entry's numeric flags, when present |
| `logLevel` | number | the entry's numeric log level, when present |
| `messageClipped` | number | original length, when a message exceeded 2000 characters |

The `debug` object contains:

| Field | Type | Meaning |
| --- | --- | --- |
| `storing` | boolean | `Zotero.Debug.storing` |
| `count` | number | `Zotero.Debug.count()` |
| `enabled` | number | `Zotero.Debug.enabled` |
| `text` | string | the debug output |
| `note` | string | present when the buffer is empty, explaining how to enable it |
| `textClipped` | number | original length, when the text exceeded 100000 characters and the tail was kept |
| `error` | string | when reading the debug buffer threw |

### `Log.sys.mjs` prefix stripping and level classification

Messages that Firefox's `Log.sys.mjs` wrote carry a `<timestamp>\t<logger>\t<LEVEL>\t` prefix, where LEVEL is one of `FATAL` / `ERROR` / `WARN` / `INFO` / `CONFIG` / `DEBUG` / `TRACE`. That prefix is stripped (the logger name is returned separately as `logger`), and the level is taken from the text rather than from the entry's `logLevel` field, because the two disagree in practice: an `addons.xpi` entry whose body reads `WARN` reports `logLevel = 1`, which is info. Trusting `logLevel` would make `minLevel=warn` silently drop it — the exact entry that filter exists to find. Messages without the prefix fall back to the entry's `flags` (for script errors) and then to `logLevel` (debug=0, info=1, warn=2, error=3).

### The two `logs` sources are not interchangeable

`console` is always populated and needs no configuration. `debug` is empty by default and that is not a bug: the buffer only fills when `extensions.zotero.debug.store` is set, and that pref is one-shot — Zotero reads it at startup and immediately resets it to `false`. Set it, restart Zotero, and one session's worth of output is available. When the buffer is empty the endpoint says so in `debug.note` and explains this, instead of returning nothing.

Debug output is read via `Zotero.Debug.get()`. The `get(maxChars, maxLineLength)` form is not used, because passing `maxLineLength` makes Zotero ellipsize lines in place inside its own buffer, permanently truncating output the user may still be reading. `getConsoleViewerOutput()` is not used because it drains the viewer's queue, which would silently steal lines from an open debug-output window. The no-argument call avoids both; its cost is that it also appends system information and the error report, a few hundred bytes.

`clear` clears only the sources read in the same call — `console` via `Services.console.reset()`, `debug` via `Zotero.Debug.clear()` — and reports them in `cleared`. In read-only mode a `clear` request is refused with `403` while ordinary reads still work. Failures to reach the console or debug APIs are reported inside the corresponding object (`console.error` or `debug.error`), not as HTTP errors.

Error codes:

| Code | Condition |
| --- | --- |
| `400` | `source` is not `console`, `debug`, or `both` |
| `403` | missing or invalid token |
| `403` | `clear` requested while read-only mode is on (`pref` names the read-only pref) |
| `404` | `endpoint.logs` off |
| `503` | master switch off |

Bundled client: `zjs.logs(source="console", min_level="all", limit=100, grep=None, category=None, since=None, clear=False, timeout=60)`; CLI flags `--source`, `--min-level`, `--limit`, `--grep`, `--category`, `--since`, `--clear`.

## The `query` endpoint

Structured read-only search that wraps Zotero's own `Search` object, so callers need no SQL and never touch the SQL layer's traps (a `LIKE` pattern must be bound, literal question marks in strings break parsing, and full-width characters can break the parser). Condition names and operators are not guessed: they are looked up live in `Zotero.SearchConditions` from Zotero's real source. An unknown condition or an unsupported operator returns `400` naming the field's available operators and the list of common condition names. The search is scoped to the user library.

Methods: `GET` or `POST` (JSON body).

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `title`, `doi`, `isbn`, `creator`, `author`, `collection`, `tag`, `itemType`, `type`, `key`, `abstract`, `journal`, `q`, `text`, `year` | string | — | shorthand conditions, mapped to Zotero conditions by the [shorthand mapping](#query-shorthand-conditions) |
| `<name>Op` | string | field-dependent | operator for the matching shorthand, e.g. `titleOp`; the default is `contains` when the field supports it, otherwise `is`, otherwise `true`, otherwise the field's first operator |
| `where` | array | `[]` | extra conditions as `[{field, op, value}, ...]`, for anything the shorthands do not cover |
| `unfiled` | boolean | `false` | restrict to items that are in no collection |
| `fields` | string or array | `[]` | extra fields to return per item |
| `limit` | number | `50` | maximum items returned, clamped to 1–500 |
| `includeCollections` | boolean | `true` | include each item's collections |

### `query` shorthand conditions

| Shorthand | Zotero condition |
| --- | --- |
| `title` | `title` |
| `doi` | `DOI` |
| `isbn` | `ISBN` |
| `creator`, `author` | `creator` |
| `collection` | `collection` (a collection key or name) |
| `tag` | `tag` |
| `itemType`, `type` | `itemType` |
| `key` | `key` |
| `abstract` | `abstractNote` |
| `journal` | `publicationTitle` |
| `q` | `titleCreatorYear` (title + creator + year) |
| `text` | `fulltextContent` |
| `year` | `year` |

At least one condition is required; a request with none returns `400`.

Response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` on success |
| `total` | number | matches before `limit` was applied |
| `returned` | number | items in this response |
| `items` | array | the first `limit` matches |
| `conditions` | array | the conditions actually used, as `[field, op, value]` triples |
| `omitted` | number | `total` minus `returned`, when positive |
| `hint` | string | present with `omitted`; notes that `items[].key` can be fed to `merge` / `apply` |

Each item contains:

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | string | item key — feed it straight into `merge` / `apply` |
| `itemID` | number | Zotero's numeric ID |
| `itemType` | string | item type name |
| `title` | string | title |
| `date` | string | date field |
| `creators` | array | creator lines |
| `inTrash` | boolean | whether the item is in the trash |
| `parent` | string | parent key, when the item has a parent |
| `collections` | array | `{key, name}` objects, when `includeCollections` is on |
| requested `fields` | any | copied onto the item; a field the item type does not have is returned as a marker string instead of being omitted |

Error codes:

| Code | Condition |
| --- | --- |
| `400` | unknown condition or unsupported operator; the error text names the field's valid operators and the common condition names |
| `400` | no conditions given |
| `400` | the search itself failed |
| `403` | missing or invalid token |
| `404` | `endpoint.query` off |
| `500` | an unexpected exception |
| `503` | master switch off |

Bundled client: `zjs.query(title=None, doi=None, isbn=None, creator=None, collection=None, tag=None, item_type=None, key=None, q=None, unfiled=False, where=None, fields=None, limit=50, include_collections=True, timeout=120)`; CLI `python zoterojs.py query --title 物理化学 --limit 20`.

## The `doctor` endpoint

Read-only library health check. Seven checks are available. By default all of them run except `sync`; `sync` contacts zotero.org, so it must be requested explicitly. The endpoint does not touch the network unless `sync` is named.

Methods: `GET` or `POST` (JSON body).

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `checks` | string or array | all except `sync` | check names to run |
| `all` | boolean | `false` | run all seven checks, `sync` included |
| `days` | number | `30`, clamped to 1–3650 | window used by `trashWriteback` |
| `titles` | string or array | `Full Text PDF` | importer-default titles counted by `attachmentTitle` |

The checks:

| Check | Reports |
| --- | --- |
| `orphanStorage` | directories under `<data-dir>/storage` with no matching attachment row (`count`, `scanned`, and a sample of up to 20) |
| `unfiled` | items in no collection, using Zotero's own `unfiled` search condition rather than hand-written SQL (`count` plus a sample of up to 20) |
| `attachmentTitle` | attachment titles still at an importer default, empty titles, and titles that match neither the full filename nor its extensionless form (`count`, `emptyCount`, `mismatchCount`, with samples) |
| `duplicateFilenames` | two identically named attachments under the same parent item (`count` plus a sample) |
| `duplicates` | bibliographic items sharing a DOI or ISBN (grouped, up to 50 groups, the first 5 detailed). Reported as leads, not verdicts — two volumes of one textbook are not duplicates |
| `trashWriteback` | items in the trash (`deletedItems`) modified within the last `days` days, plus the total trash size; plugins that use the trash as private storage show up here |
| `sync` | last sync time, whether unsynced data exists, and the local vs server library version via `api.zotero.org`; requires a login and network access |

Response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` on success |
| `checks` | object | one entry per check that ran, keyed by check name |
| `ran` | array | names of the checks that ran |
| `ms` | number | total duration in milliseconds |
| `note` | string | restates that the check is read-only and that `sync` runs only when requested |

A check that throws is reported as an error string inside its own `checks` entry; the other checks still run.

Error codes:

| Code | Condition |
| --- | --- |
| `400` | unknown check name; the error text lists the valid names |
| `403` | missing or invalid token |
| `404` | `endpoint.doctor` off |
| `500` | an unexpected exception |
| `503` | master switch off |

Bundled client: `zjs.doctor(checks=None, all_checks=False, days=30, timeout=300)`; CLI `python zoterojs.py doctor [CHECK ...] [--all] [--days N]`.

## The `apply` endpoint

Batch metadata writes. The endpoint exists because attaching an item as a child silently strips its collection membership — a collection may not contain an item with a parent — and checking `collectionItems` afterwards is the step everyone forgets. Every op therefore reports a collection membership diff.

Method: `POST` with an `application/json` body.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `ops` | array | required, non-empty | the operations to apply |
| `dryRun` | boolean | `false` at the endpoint; the bundled client and CLI default to a dry run | report what would change, without writing |
| `stopOnError` | boolean | `true` | stop after the first op that errors |
| `tag` | string | `apply` | label recorded on the automatic-backup descriptor |

Each op can carry:

| Op field | Type | Meaning |
| --- | --- | --- |
| `item` or `key` | string | key of the item to edit |
| `set` | object | field → value; only fields whose string value differs are changed |
| `setCreators` | array | creator strings or creator objects; a string is written in single-field mode (`creatorType: author`, `fieldMode: 1`, `lastName`), so a CJK name is not split by Zotero's "first character is the surname" rule |
| `setType` | string or number | item type name or numeric type ID |
| `parent` | string or null | parent item key, or `null` to detach |
| `addToCollection` | string or array | collection key(s) to add |
| `removeFromCollection` | string or array | collection key(s) to remove |
| `expect` | object | field → expected current value; any mismatch skips the op |

Response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` on success |
| `dryRun` | boolean | echo of the request |
| `applied` | number | ops with status `applied` |
| `skipped` | number | ops skipped because `expect` did not match |
| `errors` | number | ops that errored |
| `report` | array | one entry per op |
| `backup` | object | present when the automatic backup ran |
| `warning` | string | present when any record reports `collectionsLost` or `parentCollectionsGained` |

Each `report` entry contains `item` and `status` — one of `applied`, `would-change` (dry run), `no-change`, `skipped`, `error` — plus:

| Field | Type | Meaning |
| --- | --- | --- |
| `changes` | array | `{field, from, to}` per change; collection ops also carry `collectionID` |
| `collections` | array | current collection membership, on dry-run entries |
| `collectionsBefore`, `collectionsAfter` | array | membership before and after the write |
| `collectionsLost` | array | membership dropped by the write that the op did not itself request |
| `parentItem` | string | the parent, when the op set one |
| `wouldGiveParent` | array | dry run: collections the parent would receive |
| `parentCollectionsBefore`, `parentCollectionsAfter`, `parentCollectionsGained` | array | the parent side of attaching a child: Zotero transfers the child's collection membership to the parent, and the parent's save skips the date-modified update, so the transfer cannot be found afterwards by looking for recently changed items |
| `mismatch` | array | for skipped entries: `{field, want, got}` |
| `why` | string | human-readable reason for a skip or error |

A failed automatic backup aborts the whole call with `500`; nothing is written.

Error codes:

| Code | Condition |
| --- | --- |
| `400` | `ops` is missing or empty |
| `403` | missing or invalid token; read-only mode (`apply` is a write, dry run included) |
| `404` | `endpoint.apply` off |
| `500` | an unexpected exception, including a failed automatic backup |
| `503` | master switch off |

```bash
python zoterojs.py apply ops.json [--yes] [--keep-going]
```

Bundled client: `zjs.apply(ops, dry_run=True, stop_on_error=True, timeout=300)`. The CLI writes only when `--yes` is passed; without it the run is a rehearsal.

## The `enrich` endpoint

Scanned-PDF metadata completion. The endpoint has two modes and one rule.

**Mode A — find candidates** (writes nothing): name items with `items=` for a fast per-item answer, or scan the whole library with `scan=1`. The judge is the character count extracted from `Zotero.PDFWorker.getFullText`; a scan pre-filters on `Zotero.Fulltext.getIndexedState` first. The results page lists attachment keys, real file paths, extracted character counts, and index states.

**Mode B — write back what vision read**: send `findings`, one entry per item with the fields extracted from page images. Writes go through the same code as `apply` — backup and collection diffing — so an `enrich` write gets a backup tagged `enrich` and the same `collectionsLost` / `parentCollectionsGained` warnings. The per-op `expect` guard is **not** in play: it is read off each op (`bootstrap.js:1224`) and the ops this endpoint generates carry only `item`, `set`, and `setCreators`.

**The rule: fill empty fields, never overwrite.** Two-sided differences become `conflict` and are reported, not written. Overwriting is `apply`'s job, where it is stated explicitly. `strict` (default `true`) holds back any finding that fails a pre-condition gate.

Methods: `GET` or `POST` (JSON body). Both verbs are gated as a write, because the scan form is expensive even though it writes nothing.

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `findings` | array | — | mode B: one entry per item (`item`, `pages`, `title`, `publisher`, `year`, `month`, `isbn`, `authors`, `evidence`, ...); when present, write-back mode |
| `items` | string or array | — | mode A: item keys to name (comma-separated or a JSON array) |
| `scan` | boolean | `false` | mode A: scan the whole library |
| `includeIndexed` | boolean | `false` | scan mode: skip the `getIndexedState` pre-filter |
| `missingOnly` | boolean | `true` | mode A: skip items whose fillable fields are already complete |
| `minChars` | number | `enrich.minChars` pref, default `1000` | an attachment whose extracted character count falls under this counts as having no text layer |
| `limit` | number | `100`, clamped to 1–1000 | page size in scan mode |
| `offset` | number | `0` | paging offset in scan mode |
| `dryRun` | boolean | `false` at the endpoint; the bundled client and CLI default to a dry run | mode B: report without writing |
| `strict` | boolean | `true` | mode B: run the pre-condition gates |
| `stopOnError` | boolean | `true` | mode B: passed through to the `apply` write path |

Mode A response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` on success |
| `minChars` | number | threshold used |
| `missingOnly` | boolean | echo of the filter |
| `itemsProbed` | number | items examined |
| `attsProbed` | number | attachments examined |
| `skippedIndexed` | number | attachments skipped by the pre-filter |
| `candidates` | number | items with at least one candidate attachment |
| `offset`, `limit` | number | echo of the paging |
| `page` | array | the current page of candidates |
| `truncated` | boolean | whether more candidates exist beyond the page |
| `errorReport` | array | items that were named but do not exist |

Each `page` entry contains `item`, `type`, `title`, `missing` (fillable fields that are empty), and `atts`: `{akey, file, chars, state, filename}`, plus `error` when extraction failed.

Mode B response fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | boolean | `true` on success |
| `strict` | boolean | echo of the request |
| `findings` | number | entries supplied |
| `gated`, `gatedReport` | number, array | findings held back by a gate, with the reasons and the evidence line |
| `checked` | number | findings that passed the gates |
| `withOps` | number | findings that produced a write op |
| `tally` | object | per-kind counts across all checked fields |
| `report` | array | every checked item, with per-field `from` / `to` / `kind` rows; items whose fields all matched are kept, not filtered out |
| `errors`, `errorReport` | number, array | entries that could not be processed |
| `apply` | object | the `apply` report for the write, empty when there is nothing to write |

Error codes:

| Code | Condition |
| --- | --- |
| `400` | write-back mode with an empty `findings`; scan mode with neither `items` nor `scan` |
| `403` | missing or invalid token; read-only mode (both verbs and both modes) |
| `404` | `endpoint.enrich` off |
| `500` | an unexpected exception, including a failed automatic backup |
| `503` | master switch off |

```bash
python zoterojs.py enrich --items KEY1,KEY2      # who needs OCR/vision
python zoterojs.py enrich --scan                 # ... across the whole library
python zoterojs.py enrich findings.json [--yes]  # write back what vision read
```

Bundled client: `zjs.enrich(findings=None, items=None, scan=False, dry_run=True, strict=True, stop_on_error=True, missing_only=None, min_chars=None, include_indexed=False, limit=None, offset=None, timeout=300)`. The CLI writes back only with `--yes`; `--loose` turns the gates off for a negative test. The deep dive — the measured case for using extracted character count over `getIndexedState`, the three gates, and the `series` rule — is in [the `enrich` endpoint](enrich.md).

## Backups are not an HTTP endpoint

`backup` is not one of the eight endpoints. There is no `/zoterojs/backup` path. Backups have two entry points:

- a **Backup now** button in the preferences pane (**Tools → Preferences → JS Bridge**), and
- the automatic-before-write switch `extensions.zotero.jsbridge.backup.enabled` (default `false`). When it is on, `merge`, `apply`, and `enrich` take a full backup before writing, and a failed backup aborts the write — an opt-in safety net that silently misses is worse than none.

The mechanism is SQLite's `VACUUM INTO`: a clean single-file copy at `<data-dir>/jsbridge-backups/zotero-<timestamp>.sqlite`, taken without touching the live database. Rotation keeps `extensions.zotero.jsbridge.backup.keep` copies (default `5`, clamped to 1–200). A name collision gets a numeric suffix instead of overwriting the previous file. The backup descriptor is `{path, bytes, ms, kept, removed, remaining}`, and it appears as the `backup` field of the `merge` / `apply` / `enrich` responses with a `reason` of `merge`, `apply`, or `enrich`. The pane's backup function returns `{ok: true, ...}` or `{ok: false, error, dir}` rather than throwing.

The bundled client's `python zoterojs.py backup` therefore runs through the `exec` endpoint, calling `Zotero.JSBridge.backupNow()`.

## See also

- [The `merge` self-check](merge.md)
- [The `enrich` endpoint](enrich.md)
- [Zotero internals notes](zotero-internals.md)
- [Project README](../README.md)
