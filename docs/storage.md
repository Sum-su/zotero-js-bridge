# The `storage` endpoint: reversible quarantine, exact-match relocation

`/zoterojs/storage` cleans up Zotero's `storage` directory: it moves orphan attachment directories into a quarantine area, moves them back on request, and re-points broken linked-file attachments at files that still exist on disk. It is the only endpoint that touches the filesystem, and the only one a database backup cannot undo.

The endpoint answers `GET` and `POST`, reads its parameters from the query string or a JSON body, and requires the `X-ZoteroJS-Token` header. It is gated as a write on both verbs (`gate("/zoterojs/storage", true)`, `addon/bootstrap.js:2438`): its default `list` op only reads, but the same entry can move files, so read-only mode refuses every op, `list` included. Parameters, response fields, and error codes are in [the endpoint reference](endpoints.md#the-storage-endpoint). This file explains why it behaves the way it does.

## Why this exists: the orphans accumulate and nothing else cleans them

A directory under `<data-dir>/storage/` is an orphan when its 8-character name matches no attachment row — the check joins `items` against `itemAttachments` (`addon/bootstrap.js:890-896`). Measured on a real library on 2026-09-13: 327 orphan directories holding 447 files and 3.53 GB. (An earlier survey of the same library counted 329 directories, 448 files and 3.6 GB a few days before; the figures drift up on their own, which is the point of the next sentence.) The count only grows in normal use, because directories left behind by history stay; the number worth watching is the change across an operation, not its absolute value (`addon/bootstrap.js:934-935`).

Nothing built in would have reclaimed any of it. The check's own note (`addon/bootstrap.js:934-940`) records what the built-ins do cover: Zotero 10 has no `Zotero.FileIntegrity`; `Zotero.Schema.integrityCheck` checks the database schema and never touches the filesystem; `Zotero.FullText.purgeOrphanedContent` covers only the regenerable `.zotero-ft-cache` / `.zotero-reader-state` files. What is left after all of those — the actual attachment files — has no cleaner at all, which is why this endpoint exists.

## Why quarantine instead of delete: size is a hint, not proof

The measurement that shaped the design: of 288 orphan PDFs, 173 had a file of the same byte size still in the live library, and 115 did not — including an 87 MB textbook (`addon/bootstrap.js:1280-1281`). The comparison is byte size (`orphanRedundancy`, `addon/bootstrap.js:951-969`).

Same size is evidence that a duplicate might exist; it is not proof of one — two different works can land on the same byte count. So the irreversible step is not taken: nothing in this endpoint deletes content. `quarantine` moves, `restore` moves back, and the undo is a first-class operation rather than a hope.

The size question is exactly what `doctor`'s `orphanStorage deep` answers as a lead list: `duplicateBySize` for the files that might be duplicates, `unmatchedBySize` for the ones with no same-size file anywhere in the live library — the set to inspect before deleting anything by hand.

## The two-gate write rule

Every op that can write treats "rehearse" as the default. A real write must pass **both** gates:

- `dryRun: false` — an explicit statement that a write is intended, as with `apply`;
- `confirm: true` — the second gate, which `apply` does not have.

`wantsWrite` reads the first (`addon/bootstrap.js:1308`); the second is checked after it, separately (`addon/bootstrap.js:1353`). They are two checks because the two failures must give different answers:

| Request | Answer |
| --- | --- |
| `dryRun` absent or `true` | HTTP 200, `dryRun: true`, the full report of what would move |
| `dryRun: false` without `confirm` | HTTP 400, `ok: false`, an error naming `confirm` and VACUUM |
| `dryRun: false` + `confirm: true` | the write runs |

"Did not ask to write" is a rehearsal; "asked to write and did not confirm" is a refusal. One combined gate could not tell those apart, or would report the refusal as an uneventful dry run.

The extra gate exists because of what `apply` relies on: the automatic backup is SQLite's `VACUUM INTO`, a copy of the database (`addon/bootstrap.js:1277-1279`). File moves are not in the database, so no backup could put a moved directory back. The manifest-and-`restore` pair is this endpoint's undo mechanism, and every operation here is designed to be reversible.

## The four ops

| Op | What it does | What a real write moves |
| --- | --- | --- |
| `list` | reports the quarantine batches | nothing |
| `quarantine` | moves orphan directories into a new timestamped batch | `storage/<key>` to `jsbridge-quarantine/<stamp>/<key>` |
| `restore` | moves a batch back into `storage/`, guided by its manifest | the reverse |
| `relocate` | re-points broken linked-file attachments at files found under a caller-named directory | no files; the item's `attachmentPath` |

An unknown `op` returns 400 listing the four names, and a request without `op` does `list` (`addon/bootstrap.js:1471-1476`). Every response carries `ok`; a refused write answers 400 with `ok: false` and an `error` string, and nothing else — the refusal is a different shape from the dry run it is refusing.

Response fields, by op:

| Field | Op | Type | Meaning |
| --- | --- | --- | --- |
| `ok` | all | boolean | `true` on success; `false` on a `400` refusal |
| `op` | all | string | the op that ran |
| `dryRun` | `quarantine`, `restore`, `relocate` | boolean | `true` on a rehearsal, `false` on a real write |
| `error` | a failed call | string | the refusal or failure reason |
| `count` | `list` | number | quarantine batches present; `0` when the root does not exist |
| `root` | `list` | string | the quarantine root |
| `root` | `quarantine` (real) | string | the batch directory that was created |
| `stamps` | `list` | array | one entry per batch: `{stamp, dirs, bytes, mb, at}`, or `{stamp, manifest: "读不到"}` when its manifest cannot be read |
| `note` | `list` | string | what the batches are, and how `restore` uses the manifest |
| `dirs`, `bytes` | `quarantine`, `restore` | number | directories that would move / are in the manifest, and their total size |
| `files`, `mb` | `quarantine` | number | file count and megabyte total of the same set |
| `sample` | `quarantine` | array | up to 20 rows of `{dir, bytes, files}` |
| `stamp` | `quarantine` (real), `restore` | string | the batch timestamp (`YYYYMMDD-HHMMSS`) |
| `quarantined` | `quarantine` (real) | number | directories actually moved |
| `failed`, `failedSample` | `quarantine`, `restore`, `relocate` (real) | number, array | operations that failed; up to 10 rows, `{dir, why}` for the directory ops and `{key, why}` for `relocate` |
| `undo` | `quarantine` (real) | string | a ready-to-paste `restore` command for this batch |
| `restored` | `restore` (real) | number | directories moved back |
| `partial` | `restore` (real) | string | present when some directories failed to move back; the manifest is kept |
| `searched` | `relocate` | string | the directory searched |
| `scanned` | `relocate` | number | files found under it |
| `broken` | `relocate` | number | broken linked-file attachments considered |
| `matched` | `relocate` | number | broken attachments with an exact basename match |
| `plan` | `relocate` | array | one row per broken attachment: `{key, want, found}`, `found: null` when nothing matched |
| `relocated` | `relocate` (real) | number | items re-pointed |
| `done` | `relocate` (real) | array | `{key, to}` per re-pointed item |

### `list`

Reads the quarantine root `<data-dir>/jsbridge-quarantine/` and summarizes each batch directory: `count`, then one `stamps` entry per batch with `stamp`, `dirs`, `bytes`, `mb`, and `at` from the manifest — or `{stamp, manifest: "读不到"}` when the manifest cannot be read. A quarantine root that has never been created is `count: 0`, not an error. `list` itself writes nothing, but it is still refused in read-only mode, because the gate is per endpoint, not per op (`addon/bootstrap.js:2432-2438`).

### `quarantine`

Walks only the orphan subtrees, never the whole `storage/` tree. Measured on a real library on 2026-09-13: the orphan subtrees are 447 files / 3.53 GB / 220 ms, while the full tree is 3820 files / 13.67 GB / ~2.0 s — nine times the I/O for contents that cannot appear in this check's output, since a live directory is by definition not an orphan (`addon/bootstrap.js:898-907`).

Only `deep` needs the live directories, which is why it is a separate switch — and it walks the full tree on every call, so "the full traversal times out" is not a claim this code can make. An earlier version of that comment did make it, alongside a 3.6 GB figure that belongs to the orphan subset rather than the whole tree.

The dry run (the default) reports what would move: `dirs`, `files`, `bytes`, `mb`, and a `sample` of up to 20 `{dir, bytes, files}` rows. Those counts cover each whole directory, cache files included, because the whole directory is what moves — the numbers answer "how much will this free". (Doctor's `orphanStorage` splits content from cache instead, because it answers a different question: how much is irreplaceable.)

A real write creates `<data-dir>/jsbridge-quarantine/<stamp>/`, moves each orphan directory into it, then writes the manifest (below), and answers with `stamp`, `quarantined`, `failed`, `failedSample`, `root`, and `undo` — a ready-to-paste `restore` command. A directory that fails to move stays where it was, is reported in `failedSample`, and is recorded nowhere else; the loop continues past it.

### `restore`

Requires `stamp`; without one the call returns 400 with a pointer at `list`, and an unreadable `manifest.json` for that stamp returns 400 naming the manifest. The dry run reports `dirs` and `bytes` from the manifest. The real write moves every directory in the manifest back into `<data-dir>/storage/`.

If a destination already exists, the move fails and is reported in `failedSample` rather than forced — either a previous restore already returned that directory, or Zotero reissued the 8-character key to a new item. When any move fails, the response carries a `partial` string and the manifest stays in place, so `restore` can be run again. The manifest is deleted only after every directory moved back (`addon/bootstrap.js:1400-1403`).

### `relocate`

Repairs linked-file attachments (`linkMode` 2) whose path does not resolve. It handles those only; `storage:` attachments are a different failure with a different fix (re-import the attachment), and it never touches them.

The caller must name the directory to search (`dir`; there is no default), and the search stays under it — never the whole disk. A file matches when its basename is **exactly** equal, lowercased on both sides because Windows paths are case-insensitive (`addon/bootstrap.js:1437-1447`).

Fuzzy matching is deliberately absent, because it is worse than not repairing: a fuzzy "repair" points the item at a *different* paper — the entry looks healthy and opens the wrong file. A broken link that stays broken is visible; a wrong link is not (`addon/bootstrap.js:1411-1413`).

The dry run reports `searched`, `scanned`, `broken`, `matched`, and `plan` — one `{key, want, found}` row per broken attachment, with `found: null` where no exact match exists. The real write moves no files: it sets `attachmentPath` on each matched item and saves it, reporting `relocated`, `done`, `failed`, and `failedSample`.

Linked URLs (`linkMode` 3) are not part of this op, and their reachability is not tested anywhere: that needs the network, and this endpoint — like the `doctor` check that reports them — stays offline.

## The manifest: written after the move, only about what moved

Each quarantine batch is a timestamped directory holding the moved trees plus a `manifest.json`, written **after** the moves (`addon/bootstrap.js:1362-1370`). It records `stamp`, `at` (ISO time), `from` (the storage root the directories came from), and `dirs` — only the directories that actually moved, each `{dir, bytes, files}` — with its own `bytes` and `files` totals **recomputed over that succeeded subset**.

Both details matter. A manifest that listed a directory which never moved would send `restore` after something that is not there; a manifest whose totals came from the dry run instead of the moved subset would make `restore` report a "restored N MB" that never existed. A directory that failed to move is still in `storage/` and absent from the manifest, so the two sides always agree about where it is.

`restore` reads the manifest as its only instruction and deletes it only after everything is back. A partial restore leaves the manifest in place for another attempt; a batch whose manifest is missing cannot be restored at all, which is why `list` reports `manifest: "读不到"` rather than a silent zero.

## Two traps that shaped `walkFiles`

Both are recorded in the code (`addon/bootstrap.js:852-857`), and both were hit on real hardware:

- `IOUtils.stat().type` for an ordinary file is the literal string `"regular"` — not `"regularFile"`. The wrong literal does not throw; every file simply fails to match and every size total comes out as a confident zero. This happened on 2026-09-13.
- `Zotero.File.iterateDirectory` returns something that is **not iterable** — a `for...of` over it throws `is not iterable`. The directory traversal is therefore hand-rolled on `IOUtils.getChildren` (`walkFiles`, `addon/bootstrap.js:865`).

`walkFiles` treats its root strictly for the caller's sake: an unreadable root throws, so a mistyped `dir` reports an error instead of "scanned 0, matched 0", which would read as "nothing to fix". Unreadable subtrees are skipped, because a permissions problem inside the data should fail the directory, not the call (`addon/bootstrap.js:860-864`).

## What this endpoint does not do

- It does not delete. Quarantine replaces delete with a reversible move, and no op removes content files.
- It does not fuzzy-match files, and it does not search the whole disk; `relocate` searches exactly the directory it is given.
- It does not test linked URLs, which would require the network.
- It does not repair `storage:` attachments whose file is missing — that is import damage, and the fix is to re-import.
- It does not run by itself. Nothing is scheduled; nothing moves until a caller passes both gates.

## See also

- [endpoints.md](endpoints.md) — parameters, response fields, and error codes for this and the other eight endpoints.
- [zotero-internals.md](zotero-internals.md) — the Zotero and Firefox platform traps, including the async data APIs this code awaits.
- [../README.md](../README.md) — project overview, settings, and the security model.
