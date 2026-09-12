# Zotero JS Bridge

Run JavaScript inside a running Zotero, from your terminal.

Zotero's plugin API has no out-of-process escape hatch. Anything that isn't
in the connector API — merging duplicate items, moving attachments between
storage backends, bulk-editing fields, calling internal modules — can only be
done from inside the Zotero process. Normally that means opening
**Tools → Developer → Run JavaScript** and pasting code by hand, every time.

This plugin opens eight local HTTP endpoints on the HTTP server Zotero already
runs (`127.0.0.1:23119`), so a script can do it instead.

```console
$ python zoterojs.py exec "return Zotero.Libraries.userLibraryID"
1

$ python zoterojs.py merge ABCD1234 EFGH5678 --dry-run
{ "ok": true, "dryRun": true, "report": [{ "key": "EFGH5678", "merged": false, ... }] }

$ python zoterojs.py query --title 物理化学 --limit 2   # no SQL required
$ python zoterojs.py doctor                             # read-only library health check
$ python zoterojs.py apply ops.json                     # dry-run until you pass --yes
$ python zoterojs.py backup                             # VACUUM INTO + rotation
```

Four of the eight can write (`exec` / `merge` / `apply` / `enrich`); the other
four are read-only (`ping` / `logs` / `query` / `doctor`). Read-only mode closes
the write paths and leaves the read ones open.

> [!WARNING]
> These endpoints execute **arbitrary JavaScript inside Zotero** with full
> access to your library. Any process that can read the token file can delete
> your entire library. Read [Security model](#security-model) before you
> install this. It is a personal automation tool, not a hardened service.

## Requirements

- Zotero 7 or later (developed and verified against **Zotero 10.0.2**)
- Python 3.8+ for the bundled client (any HTTP client works — the protocol is
  eight JSON endpoints)

## Install

1. Download `zotero-js-bridge.xpi` from
   [Releases](../../releases/latest).
2. In Zotero: **Tools → Add-ons → ⚙ → Install Add-on From File…**
3. Pick the `.xpi`. Bootstrapped extensions hot-reload — **no restart needed**
   in most cases; if the endpoints don't answer, restart Zotero.

Zotero writes a freshly generated token to `<data-dir>/zoterojs-token.txt`.
The client finds it automatically. The plugin adds one pane under
**Tools → Preferences → JS Bridge** — switches, the token, a **Backup now**
button, and a self-check. Every switch takes effect immediately.

## Usage

```bash
python zoterojs.py ping                            # health check, no token needed
python zoterojs.py exec "return Zotero.version"
python zoterojs.py merge MASTERKEY DUPKEY --dry-run
python zoterojs.py query --title 物理化学 --limit 20
python zoterojs.py doctor [duplicates orphanStorage] [--all] [--days 30]
python zoterojs.py apply ops.json [--yes] [--keep-going]
python zoterojs.py enrich --items KEY1,KEY2      # who needs OCR/vision
python zoterojs.py enrich --scan                 # ... across the whole library
python zoterojs.py enrich findings.json [--yes]  # write back what vision read
python zoterojs.py backup
```

`query` prints item keys that feed straight into `merge` / `apply` — so the
whole loop is query → dry-run → confirm → write, without hand-converting
anything. `apply` and `merge` both default to a dry run; nothing is written
until you pass `--yes`.

```python
import zoterojs as zjs

zjs.execv("return Zotero.Items.get(1).getField('title')")
zjs.merge("ABCD1234", ["EFGH5678"])                 # real merge
zjs.merge("IJKL9012", ["MNOP3456"], dry_run=True)   # self-check only
zjs.query(title="导水裂隙带", limit=5)               # structured, no SQL
zjs.doctor()                                        # full sweep, no network
zjs.apply(ops, dry_run=True)                        # dry run is the default here too
zjs.enrich(items=["ABCD1234"])                      # does this PDF need OCR?
zjs.enrich(findings=read_from_vision)               # fill only the empty fields
zjs.backup()                                        # VACUUM INTO + rotation
```

Inside `exec` you get `Zotero`, `Services`, `ChromeUtils`, `Components`, `Cu`,
`Ci`, `Cc`, `PathUtils`, `IOUtils`, `OS`, and `log(...)` (collected into the
response). Top-level `await` and `return` both work.

### Endpoints

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/zoterojs/ping` | none |
| POST | `/zoterojs/exec` | `X-ZoteroJS-Token` |
| POST | `/zoterojs/merge` | `X-ZoteroJS-Token` |
| GET, POST | `/zoterojs/logs` | `X-ZoteroJS-Token` |
| GET, POST | `/zoterojs/query` | `X-ZoteroJS-Token` |
| GET, POST | `/zoterojs/doctor` | `X-ZoteroJS-Token` |
| POST | `/zoterojs/apply` | `X-ZoteroJS-Token` |
| GET, POST | `/zoterojs/enrich` | `X-ZoteroJS-Token` |

All eight ride on Zotero's own server — nothing new is bound, and no socket is
held open, so Zotero still exits cleanly.

Requests whose `User-Agent` starts with `Mozilla/`, or that carry an `Origin`
header, are dropped by Zotero's own CSRF guard before they reach the plugin.
Command-line clients are unaffected; browser-side callers need
`x-zotero-connector-api-version`, as with any Zotero plugin endpoint.

Every endpoint can be switched off individually, and the whole bridge has a
master switch. See [Settings](#settings).

## Settings

**Tools → Preferences → JS Bridge.** One pane, no restart needed —
the gates read their pref on each request, so flipping a checkbox takes effect
on the next call.

| Pref (`extensions.zotero.jsbridge.…`) | Default | Effect when changed |
| --- | --- | --- |
| `enabled` | `true` | `false` → all eight endpoints return `503` |
| `readonly` | `false` | `true` → `exec` / `merge` / `apply` / `enrich` return `403`; reads still work |
| `endpoint.ping` | `true` | `false` → that path returns `404` |
| `endpoint.exec` | `true` | |
| `endpoint.merge` | `true` | |
| `endpoint.logs` | `true` | |
| `endpoint.query` | `true` | |
| `endpoint.doctor` | `true` | |
| `endpoint.apply` | `true` | |
| `endpoint.enrich` | `true` | |
| `enrich.minChars` | `1000` | Below this extracted char count a PDF counts as having no text layer |
| `limit.responseKB` | `1500` | Response cap, clamped to 10–20000 |
| `backup.enabled` | `false` | `true` → back up before every `merge` / `apply` |
| `backup.keep` | `5` | How many backups to keep, clamped to 1–200 |

`ping` reports the current state, so a client can ask what it's allowed to do
rather than guessing:

```console
$ python zoterojs.py ping
{ "ok": true, "name": "Zotero JS Bridge", "version": "1.0.11", "zotero": "10.0.2",
  "libraryID": 1, "endpoints": ["/zoterojs/ping", ...], "disabled": [], "readonly": false }
```

`disabled` lists the paths that are currently switched off, and `readonly` is
the live value of the read-only switch. Both fields are additive — clients that
predate them see the same shape they always did.

The pane also carries the token (copy / regenerate / rewrite the token file),
a **Backup now** button, and a **self-check** button that reports whether the
eight endpoints are
registered, what the switches say, and whether the token file is there. The
self-check is deliberately static: it does not fire an HTTP request at
`127.0.0.1:23119`, because Zotero's own CSRF guard would kill it and a failure
would then mean nothing.

Two things worth being precise about:

- **Read-only mode is a refusal, not a sandbox.** It does not parse your code.
  There is no honest way to decide statically how many side effects a given
  `exec` can produce, so instead of pretending, it closes the write paths
  entirely (`exec`, `merge`, `apply`, `enrich`, and `logs --clear`) and leaves
  the read paths (`ping`, `logs`, `query`, `doctor`) open. `apply` and `enrich`
  are gated even for a dry run: read-only means "this endpoint is not
  available", not "you may rehearse". `enrich` counts as a write on both verbs,
  even in its read-only discovery mode, because its `--scan` form extracts the
  full text of a few hundred PDFs and takes minutes.
- **The master switch is enforced on the request path, not at registration.**
  Disabling the bridge leaves the pane in place, which is the only way back —
  a plugin that removes its own settings UI when disabled can't be re-enabled
  from inside Zotero.

Regenerating the token revokes the old one immediately: the pref and
`zoterojs-token.txt` are rewritten, and clients still holding the old token
start getting `403`.

## The `merge` self-check

A merge runs only if every check passes. The rule is **missing ≠ conflict** —
two items only conflict when *both* have a value and the values differ. This
matters because online-first articles legitimately have no volume/issue/pages
yet, and a naive comparison rejects them as false duplicates.

```text
same title / same item type / year / volume / issue / pages / DOI / ISBN
```

Values are normalized before comparison: whitespace, `_.,;:()[]`, CJK
punctuation, and **every dash variant** — ASCII `-`, en dash `–`, em dash `—`,
minus sign `−`, non-breaking hyphen, zero-width space. This last part matters
because Zotero's translators routinely deliver `1–10` (U+2013) where you'd
typed `1-10`, and comparing them literally rejects a genuine duplicate.

The ISBN check is the backstop for the classic disaster: two volumes of the
same textbook with identical title and authors, differing only in ISBN and
edition. `master` survives, duplicates go to the trash, and `Ctrl+Z`
undoes it in Zotero.

## The `enrich` endpoint

For the tail of a library that can't be identified any other way: scanned PDFs
with no text layer, where the only remaining source of metadata is what a human
(or a vision model) can *see* on the cover and the copyright page. It has two
modes and one rule.

**The rule: fill empty fields, never overwrite.** Two-sided differences become
`conflict` and are reported, not written. Overwriting is `apply`'s job, where
you've said explicitly that you mean it.

### Mode A — who needs vision (read-only)

```bash
python zoterojs.py enrich --items KEY1,KEY2   # name them (fast: ms per item)
python zoterojs.py enrich --scan              # whole library (slow: see below)
```

The judge is the **extracted character count** from
`Zotero.PDFWorker.getFullText`, not `Zotero.Fulltext.getIndexedState`. The
index state cannot tell the two cases apart — measured on a real library, both
of these come back `PARTIAL`:

| Attachment | Extracted chars | `getIndexedState` |
| --- | --- | --- |
| `23NZF8PY` | 100,117 | `PARTIAL` — a normal book, one page has no text |
| `27RCEEVC` | 297,684 | `PARTIAL` — same story |
| `2J4LLG6Q` | 0 | `UNINDEXED` |
| `4BY9B5LC` | 0 | `PARTIAL` |

The last two are the same thing (pure scans) with *different* states, which is
the whole argument. The threshold is `enrich.minChars` (default 1000): real
scans come back at 0 or a few dozen junk chars, real papers at tens of
thousands, and nothing lives in between, so it doesn't need tuning.

Cost, measured over 1235 PDFs: `getFullText` is ~337 ms each (**~7 minutes**
for the library), while `getIndexedState` is a pure DB read (198 ms for all of
them). So `--scan` prefilters on the index state first — 1235 → 200, about 67
seconds — and `--items` skips the prefilter entirely, because naming an item
means you want *that* attachment's real answer.

Rendering is deliberately **not** here: Zotero exposes no headless PDF
renderer (`Zotero.PDFRenderer` doesn't exist, `Zotero.PDFWorker` has no render
method). Turn the pages into images outside, with PyMuPDF or whatever you
already use.

### Mode B — write back what vision read (writable)

```bash
python zoterojs.py enrich findings.json [--yes]
```

`findings.json` is one entry per item:

```json
[{"item": "ABCD1234",
  "pages": [{"p": 1, "type": "封面"}, {"p": 3, "type": "版权页CIP"}],
  "title": "计算土力学", "publisher": "中国建筑工业出版社",
  "year": "2019", "month": 3, "isbn": "978-7-112-00000-0",
  "authors": ["朱百里"],
  "evidence": "计算土力学/朱百里. —北京：中国建筑工业出版社，2019.3"}]
```

Dry-run by default, like `apply`. What each field turns into:

| Kind | Condition | Action |
| --- | --- | --- |
| `new` | library empty | write |
| `extend` | extracted title extends the library's ("从抛物线谈起" → "从抛物线谈起：混沌动力学引论") | write |
| `same` | normalized-equal either way | nothing |
| `conflict` | both have values, different | report only |
| `review` | `series` | report only |
| `suspect` | gate failed | not evaluated at all — see below |

The title comparison normalizes whitespace, CJK and ASCII punctuation, and
every dash variant, then checks substring containment in both directions. The
`extend` direction is the only one that writes: a cover page that prints only
the main title must not truncate a library title that carries the subtitle.

### The three gates

`strict` (the default) holds back any item that fails one of these:

```text
① saw front matter — 封面 / 书名页 / 扉页 / 版权页 / CIP / 题名页
② the extracted title matches the item's title (normalized substring, either way)
③ no ISBN / publisher / edition / series on a journalArticle
```

These aren't theory. Both were caught on a real library:

- `82L9PCBI` — a journal article whose metadata came from **a bibliography
  line** in its own reference list, which the model reported as "版权页CIP"
  with publisher and ISBN attached. Gate ② **passes** it: the article's title
  genuinely contains the book title it cites. Only gate ③ catches it.
- `H2GCDM5B` — a publisher extracted from an acknowledgment sentence
  ("本书作者感谢清华大学出版社…"), with page types of only 正文 and 目录. Only
  gate ① catches it.

Items that fail a gate land in `gatedReport` with the reasons and the source
line, and produce no ops at all. `strict=false` exists to *prove* the gates
work (the same input should then pass) — don't point it at real data.

`series` is reported but never written: the model reads any prominent line on
a cover as a series, and in practice that meant funding programs and document
types.

Writes go through the same code as `apply` — backup, `expect`, collection
diffing — so an `enrich` write gets a backup tagged `enrich` and the same
`collectionsLost` / `parentCollectionsGained` warnings.

## The `logs` endpoint

Reads Zotero's error console and/or its debug output, so a script can check
what a plugin (including this one) actually did without you clicking through
**Tools → Developer → Error Console**.

```bash
python zoterojs.py logs                         # newest 100 console messages
python zoterojs.py logs --min-level warning     # errors + warnings only
python zoterojs.py logs --grep "JS Bridge"      # anything mentioning the bridge
python zoterojs.py logs --source debug          # Zotero's own debug log
```

Query parameters work the same over GET or POST (JSON body):

| Param | Default | Meaning |
| --- | --- | --- |
| `source` | `console` | `console`, `debug`, or `both` |
| `minLevel` | `all` | `all` / `debug` / `info` / `warn` / `error` — "at least this severe" |
| `category` | — | substring match, case-insensitive |
| `grep` | — | substring match on the text (and on `logger`, when present) |
| `since` | — | epoch ms; only messages at or after this |
| `limit` | `100` | max messages to return, newest kept first (cap 1000) |
| `clear` | `false` | clear the sources you read — **destructive** |

Each message comes back with `time`/`iso`, `level`, `message`, and — when the
console entry has them — `category`, `source`, `line`, `column`. Messages that
Firefox's `Log.sys.mjs` wrote carry a `<timestamp>\t<logger>\t<LEVEL>\t` prefix;
that prefix is stripped (the logger name is returned separately as `logger`),
and the level is taken from the text rather than from the entry's `logLevel`
field, because the two disagree in practice: an `addons.xpi` entry whose body
reads `WARN` reports `logLevel = 1`, which is *info*. Trusting `logLevel` would
make `minLevel=warn` silently drop it — the exact entry that filter exists to
find.

**The two sources are not interchangeable.** `console` is always populated and
needs no configuration. `debug` is empty by default and that is not a bug: the
buffer only fills when `extensions.zotero.debug.store` is set, and that pref is
**one-shot** — Zotero reads it at startup and immediately resets it to `false`.
Set it, restart Zotero, and you get one session's worth of output. When the
buffer is empty the endpoint says so and tells you this instead of returning
nothing.

`debug` output is read via `Zotero.Debug.get()`. `get(maxChars, maxLineLength)`
is *not* used, because passing `maxLineLength` makes Zotero ellipsize lines
**in place** inside its own buffer, permanently truncating output the user may
still be reading; and `getConsoleViewerOutput()` drains the viewer's queue,
which would silently steal lines from an open debug-output window.

## Gotcha: Zotero 10's data APIs are async

`Zotero.Items.getAll(1)` returns a **Promise**, not an array. Accessing
`.length` on it silently yields `undefined`, and it serializes to `{}` — no
error, just wrong data. This is the easiest way to waste an afternoon.

| API | Signature |
| --- | --- |
| `Zotero.Items.getAll` | `async (libraryID, onlyTopLevel, includeDeleted, asIDs)` |
| `Zotero.Items.getDeleted` | `async (libraryID, asIDs, days, limit)` |
| `Zotero.Items.getAsync` | `async (ids, options)` |
| `Zotero.Items.get` | sync — `(ids)` |
| `Zotero.Items.getByLibraryAndKey` | sync — `(libraryID, key, options)` |

The serializer flags un-awaited promises explicitly instead of returning a
silent `{}`:

```text
"[Promise 未 await：Zotero 10 里 getAll / getDeleted / getAsync 等都是 async]"
```

A top-level `return somePromise` is awaited for you. What breaks is a promise
*nested* in a returned object. **When in doubt, `await`.**

### …and `onlyTopLevel: true` does not mean "bibliographic items"

`getAll`'s top-level filter joins two tables:

```js
'SELECT A.itemID FROM items A' +
' LEFT JOIN itemNotes B USING (itemID)' +
' LEFT JOIN itemAttachments C ON (C.itemID=A.itemID)' +
' WHERE B.parentItemID IS NULL AND C.parentItemID IS NULL'
```

There is **no `itemAnnotations` join**, so every highlight and underline in the
library counts as a top-level item. Measured on a real library:

| | |
| --- | --- |
| `(await Zotero.Items.getAll(1, true)).length` | **11 231** |
| …of which annotations | 10 030 |
| …standalone attachments / notes | 2 / 2 |
| **actual bibliographic items** | **1 197** |

The performance cost is the obvious half: finding the 1 197 items that matter
means 10 030 wasted `getAttachments()` calls, and measured, that loop does not
come back. The worse half is that **the number lies** — a tool reporting
`itemsProbed: 11231` looks like it scanned the library while it really looked
at a tenth of it, and wrong numbers are worse than slow ones.

Filter by type:

```js
for (const it of await Zotero.Items.getAll(1, true, false, false)) {
  if (it.isAttachment() || it.isNote() || it.isAnnotation()) continue;
  // ...a bibliographic item
}
```

Do not hand-write an `itemTypeID` comparison instead: `annotation`'s
`itemTypeID` is **1**, which reads like "default / ordinary item", so a
hand-rolled check tends to wave the annotations straight through.

## Security model

The threat model is a single-user desktop machine. That has consequences you
should accept knowingly:

- **The token is a full-access credential.** It is stored in the Zotero pref
  `extensions.zotero.jsbridge.token` and mirrored to
  `<data-dir>/zoterojs-token.txt`. Anything that can read that file — or read
  your prefs — can run arbitrary code in Zotero and destroy your library.
- **Local-only, but not sandboxed.** Zotero binds its server to `127.0.0.1`,
  so the endpoints are not reachable from the network. They are, however,
  reachable by every process on your machine that has the token.
- **`exec` is deliberately unrestricted.** It is `new AsyncFunction(...)` over
  your code. That is the entire point — it is not a sandbox and does not
  pretend to be.
- **No TLS.** Traffic is loopback plaintext.

Mitigations that are present: token required on everything except `ping`;
constant-time comparison against the stored token; a configurable response cap
(1.5 MB by default); a master switch and per-endpoint switches; a read-only mode
that closes the write paths; and endpoint cleanup on `shutdown()`.

Two more that arrived with the v1.0.8–1.0.11 features:

- **`apply` defaults to a dry run.** Writing is opt-in (`--yes`), and every op
  can carry an `expect` block that skips the item unless the current value still
  matches. The report always shows the before → after diff and any
  `collectionItems` membership the write would drop.
- **Backups before writes, and a failed backup aborts the write.** With
  `backup.enabled` on, `merge` and `apply` take a full `VACUUM INTO` snapshot
  first; if that fails, nothing is written. An opt-in safety net that silently
  doesn't catch anything is worse than no safety net.

The switches are a blast-radius control, not a security boundary. They reduce
what a script *you* run can do, and they are worth having when you hand a
terminal to something less careful than you. They do not contain an attacker who
already has the token — anyone holding it can flip the prefs back.

> The constant-time comparison is real as of v1.0.6, but it was *claimed* from
> v1.0.0 while the code did a plain `!==` the whole time. If you audited an
> earlier version against this README, the README was wrong, not your audit.

If that trade is wrong for you, don't install it — or turn off the master
switch in **Tools → Preferences → JS Bridge**, which disables the endpoints
while leaving the plugin installed.

To remove it completely: uninstall the plugin, then delete the pref
`extensions.zotero.jsbridge.token` and the `zoterojs-token.txt` file.

## Notes for plugin authors

Two Zotero-specific traps this project hit, documented so you don't have to:

**A `type: "extension"` manifest must declare all three of these**, or you get
`packagingError` → `Extension is invalid` (`Extension.sys.mjs:1874-1883`):

```json
"applications": {
  "zotero": {
    "id": "...",
    "update_url": "...",              // ← the one everybody forgets
    "strict_max_version": "..."
  }
}
```

**The install-failure message is a single hardcoded string.** `addon-install-disabled`,
`addon-install-blocked`, and `addon-install-failed` all render the same
"may not be compatible with this version of Zotero" text
(`standalone.addonInstallationFailed.body`). It does *not* indicate a version
problem — check the Error Console for the real cause. A missing `update_url`
produces exactly this misleading message.

Endpoint registration, for reference: assign a **constructor** (not an object)
to `Zotero.Server.Endpoints[path]` — the server does `new this.endpoint()` —
and give `init` exactly one formal parameter so it takes the object-argument
branch.

**Preference panes are less forgiving than the docs suggest.** Four things this
project got wrong before reading `chrome/content/zotero/xpcom/preferencePanes.js`:

- The pane is an XHTML **fragment**, not a document. XUL is the default
  namespace, so HTML tags need an explicit prefix (`<html:input>`, `<html:h2>`).
- `register()` given no `id` mints `plugin-pane-<random>-<pluginID>`. A second
  `register()` therefore **does not throw** — it quietly adds a *second* pane to
  the sidebar. Give an explicit `id` and `unregister()` it first, or your users
  accumulate duplicate panes on every hot reload.
- Panes registered by a plugin are removed on shutdown by Zotero's own
  `Plugins.addObserver({ shutdown })`, filtered by `pluginID`. That observer does
  not run on every hot-reload path — `startup()` can be called again without
  `shutdown()` having run, which is the same re-entrancy trap as the endpoint
  table.
- `preference="extensions.zotero.foo"` on a control is bound by Zotero's own
  prefs code (`_syncFromPref` / `_syncToPrefOnModify`); no JS needed, but the
  name must be **fully qualified** and must have a default in `prefs.js`, or the
  control appears to work and writes to a pref nobody reads.
- **The pane uses fully-qualified names; JS must use short ones.** Those two
  call the same pref through different paths:

  ```js
  // preferences.js:447 / :474 — the pane passes global=true
  Zotero.Prefs.get(preference, true);
  Zotero.Prefs.set(preference, value, true);

  // Zotero.Prefs.get — everything else, prefix added for you
  pref = global ? pref : ZOTERO_CONFIG.PREF_BRANCH + pref;   // "extensions.zotero."
  ```

  Mixing them up **fails silently**: `Zotero.Prefs.set` *creates* a missing
  pref, so `set('extensions.zotero.x', v)` followed by a `get` reads back `v`
  while your code — reading the short name — still sees the default. Cost me a
  false "the rotation is broken" diagnosis; `test_bridge.js` now records any
  misuse and fails on it.

**Two SQL traps worth knowing before you write your own queries:**

```js
// ✗ rejected: "Please enter a LIKE clause with bindings"
"... WHERE value LIKE '%x%'"
// ✓ the pattern has to be bound
"... WHERE value LIKE ?", ['%x%']
```

That guard lives in **Firefox's** `modules/Sqlite.sys.mjs`
(`/\bLIKE\b\s(?![@:?])/i`), not in Zotero's code — searching Zotero's own
`omni.ja` for it finds nothing. It is also stricter than "no quotes": a
column name or subquery after `LIKE` is rejected too. And it is **unconditional**
— omitting the params argument does not slip past it (`params = null` is just a
default; the check is on the next line). And `deleteLog` **does not exist** in
Zotero 10 (`no such table`) — `deletedItems` is the authoritative trash record.

## Development

```bash
node test_bridge.js              # 160 tests against stubbed Zotero globals
python mutate.py                 # revert each fix, confirm the suite goes red
python make_icon.py --preview    # icon variants sheet, writes nothing
python build.py                  # package the xpi
python build.py --bump           # bump patch version first
python build.py --install        # build, then install into a running Zotero
python check_backup.py [DIR]     # open each backup read-only, verify integrity
```

**Green tests only prove the suite ran.** `mutate.py` reverts 22 individual
fixes — one at a time, restoring the file in a `finally` — and checks the suite
turns red for each. All 22 are currently caught. It is the difference between
"the tests pass" and "the tests are watching".

Seventeen of them mutate `addon/bootstrap.js`; five mutate `test_bridge.js`
itself. The first of those reverts the stubbed SQL guard to a looser version
that once made the stub accept a query the real Zotero rejects; the rest undo
behaviours copied into the stub from the real library. **A guard copied
into the stub from the real thing needs its own mutant** — otherwise it is a
comment, not a check.

CI runs both, and a mutant that stops landing **fails the build** rather than
being skipped: an anchor that no longer matches means the behaviour it pinned
has moved, and the one thing worth fearing here is a guard that quietly stopped
watching. (The `build` job separately re-runs `build.py` and fails if
`updates.json` drifts from the manifest — the "marketplace shows the new
version, existing users get no update" bug.)

Getting this wrong is not hypothetical. The stub's `Item.setType` used to clear
`collections`, "because changing the type detaches the item". That was invented,
the test asserted the invented behaviour, and it passed — until the same thing
was run against the real library and `collectionItems` turned out not to move at
all. **A stub shaped wrong makes its tests self-confirming.** The behaviour that
*does* detach a collection is setting `parentItemID` (a child item cannot be in
a collection), which is also the only mechanism verified live.

That mechanism turned out to have a **second half, on the other item**.
Parenting a standalone attachment transfers its collections to the *parent*
(`item.js:1944`, "remove from any collections where it existed previously and
add parent instead"), so the attachment leaves a collection and the parent joins
it. `apply`'s diff originally watched only the item being written, so it
reported the loss and said nothing about the gain — the same class of silent
change the endpoint exists to catch, one item over. It now watches the parent
too, and the dry run predicts the transfer. The parent's save passes
`skipDateModifiedUpdate`, so its `dateModified` never moves: you cannot find
this afterwards by looking for recently-changed items.

Tests need no Zotero install — they load the real `bootstrap.js` into a Node
`vm` context with stubbed globals, then drive the endpoint constructors
directly. Among other things they assert that every icon the manifest declares
is actually present and is a PNG of the declared pixel size.

The stubs are written to match the real modules rather than to be convenient —
`PreferencePanes.register` reproduces the duplicate-id throw and the
`plugin-pane-<random>-<pluginID>` id generation from `preferencePanes.js`,
because those two facts are what make a naive re-registration on hot reload fail
silently. Where the real Zotero *rejects* something — like the `LIKE` guard — the
guard is copied into the stub verbatim, so a query that would throw on a real
library fails here instead.

Two assertions don't test the plugin at all; they test whether the harness is
still honest, because both failure modes are silent. The SQL router records any
statement it didn't recognize (an unmatched query returns an empty array and the
assertion passes having verified nothing), and the `Prefs` stub records any
pref read or written with a fully-qualified name where a short one was required
(a missing pref falls back to its default, so "the switch didn't work" and "the
switch was never on" look identical).

Bump the version on every build; Zotero ignores a reinstall with an unchanged
version. `build.py` fails loudly if a manifest-declared icon didn't make it
into the archive, and if a `preference="…"` in the pane has no default in
`prefs.js` — the two failure modes it was written to prevent, both of which
otherwise show up as a control that looks fine until you click it.

## 中文说明

在**正在运行的 Zotero 进程内**执行 JavaScript。

Zotero 的插件 API 没有进程外通道。凡是连接器 API 覆盖不到的——合并重复条目、
搬移附件、批量改字段、调用内部模块——只能从 Zotero 进程内做。常规做法是打开
**工具 → 开发者 → Run JavaScript**，每次手动贴代码。

这个插件在 Zotero 本来就在跑的本地服务器（`127.0.0.1:23119`）上挂了八个 HTTP
端点，让脚本可以代劳。**不另开端口、不持有 socket**，所以不影响 Zotero 退出。
其中能写的是 `exec` / `merge` / `apply` / `enrich`，
只读的是 `ping` / `logs` / `query` / `doctor`。

> **安全提醒**：这些端点能在 Zotero 里执行**任意 JS**，可读写你整个库。
> 任何能读到 token 文件的进程都能删掉你的库。这是个人自动化工具，不是加固过的
> 服务——装之前请先读英文部分的 [Security model](#security-model)。

安装：从 [Releases](../../releases/latest) 下载 `.xpi`，**工具 → 插件 → ⚙ →
Install Add-on From File…**。装入后 token 会自动写到 `<数据目录>/zoterojs-token.txt`，
客户端自己会找。

```bash
python zoterojs.py ping
python zoterojs.py exec "return Zotero.version"
python zoterojs.py merge 主条目KEY 重复KEY --dry-run
python zoterojs.py logs --min-level warning
python zoterojs.py query --title 物理化学 --limit 20
python zoterojs.py doctor
python zoterojs.py apply ops.json          # 不给 --yes 就是演练
python zoterojs.py enrich --items KEY1,KEY2  # 哪些 PDF 该送去 OCR/视觉
python zoterojs.py enrich --scan             # ……扫全库
python zoterojs.py enrich findings.json [--yes]   # 把视觉读到的写回去
python zoterojs.py backup
```

**最容易踩的坑**：Zotero 10 里 `Zotero.Items.getAll` / `getDeleted` / `getAsync`
都是 **async** 的，`get` / `getByLibraryAndKey` 是同步的。忘了 `await` 不会报错，
只会静默返回 `{}` 或 `undefined`——序列化器现在会把这种情况显式标出来。

**同一个 `getAll` 上还有第二个坑，跟 async 无关**：`onlyTopLevel: true`
**不等于「书目条目」**——它只 join 了 `itemNotes` 和 `itemAttachments`，
没 join `itemAnnotations`，于是一万条高亮都被算成顶层条目（本库：`getAll`
报 **11231**，真正的书目条目是 **1197**）。**这个数不能说谎**：一个声称扫了
全库、其实只看了十分之一的工具，会让人得出完全错误的结论。要按类型滤，
细节见英文部分的 Gotcha 一节。

`merge` 的自检判据是「**两边都有值且不同**才算冲突」，缺失不算冲突，
否则网络首发版（天生没有卷期页）会被误判成冲突而拒绝合并。比对前会归一化
空白、各类标点和**全部破折号变体**（ASCII `-`、en dash `–`、em dash `—`、
减号 `−`、非断连字符、零宽空格）——Zotero 抓回来的条目里 `1–10` 常是 U+2013，
跟手打的 `1-10` 逐字符比就会把真重复误杀。ISBN 那条是硬防线：
同一教材上下册标题作者全同，只有 ISBN 和版次不同，绝不能合并。

`logs` 端点有两个来源，可用性不一样：`console` 是**工具 → 错误控制台**那些，
永远有货、不用配置；`debug` 默认是空的，**这不是坏了**——它只在
`extensions.zotero.debug.store` 打开时才记录，而且那个 pref 是**一次性**的，
Zotero 启动读完就自己设回 `false`。设好重启，能拿到一个会话的输出。

**管理面板**在 **工具 → 首选项 → JS Bridge**，改完即生效不用重启：总开关
（关掉后八个端点全 `503`）、只读模式（`exec`/`merge`/`apply`/`enrich` 返 `403`，
读的口子照开）、八个端点各自的开关（关掉返 `404`）、响应上限（默认 1.5 MB）、备份开关与保留份数、
以及 token 的复制 / 重新生成 / 重写文件，外带**立即备份**和自检两个按钮。
两个容易误解的地方：**只读模式是拒绝服务不是沙箱**——它不解析你的代码，
而是把写入口整个关掉；**总开关是在请求路径上拦，不是不注册端点**，
停用后面板还在——不然关掉之后就再没有地方打开了。

**后来几个端点的分工**：`query` 让你**不用写 SQL** 就能查（条件名和算符都现查
`Zotero.SearchConditions`，不认识就报 400 并列出可选项，不猜）；
`doctor` 一次跑完七项只读体检，**默认不联网**（`sync` 要连 zotero.org，得点名要）；
`apply` 批量改元数据，**默认演练**，每条 op 可带 `expect` 前置断言，
并且**自动报出集合归属差分**——因为把条目挂成子条目会**静默摘掉它的集合**。
`query` 吐出的 `key` 可以直接喂给 `merge` / `apply`，几个端点串成
查询 → 演练 → 确认 → 写一条管道。

**`enrich`** 是这条管道的最后一站，专治**翻译器永远认不出来的那批**：
没有文本层的扫描件。它的判据不看 `getIndexedState`（实测有 29.7 万字符却仍是
`PARTIAL` 的正常书），而是看 `PDFWorker.getFullText` 抽出来的字符数。
它只做两件事——**找出候选**（只读），和**把视觉读到的写回去**（默认演练）；
写回只有一条规矩：**只填空字段，永不覆盖**，两边都有值且不同就报成 `conflict`
留给人判。三道闸挡在前面（见过封面/书名页/版权页、书名对得上、字段配得上这个
条目类型），每一道都是用一次真实的错误换来的；`series` 只列不写。
**渲染和视觉调用不在这里**——那是外部脚本的事，本插件只负责"找谁需要"和
"按规矩写回"。详见英文部分的 [The `enrich` endpoint](#the-enrich-endpoint)。

**备份**用 SQLite 的 `VACUUM INTO` 出一份干净单文件副本（不动正在用的库，
目标已存在则拒写），按份数自动轮转。开了「写操作前自动备份」之后，
merge / apply / enrich 会先备一份，**备份失败就中止这次写**——兜不住还照写等于这个开关白开。

## License

[MIT](LICENSE)
