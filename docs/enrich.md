# The `enrich` endpoint

`/zoterojs/enrich` finds scanned PDF attachments that have no usable text layer and writes back the bibliographic metadata that a human or a vision model read off their cover or copyright page, filling empty fields only and never overwriting an existing value.

It is the last resort for the tail of a library that no translator will ever identify: scanned PDFs with no text layer, where the only remaining source of metadata is what a person or a vision model can see on the page images. The endpoint has two modes and one rule. Rendering the pages and calling the vision model are deliberately outside the plugin. The endpoint was added in version 1.12.

## Scope: the plugin decides who needs vision and writes back what vision read

`enrich` is not an OCR endpoint. Rendering and the vision-model call are intentionally not here. The plugin performs exactly two local jobs:

1. decide which attachments need vision, from evidence Zotero already holds (Mode A, read-only);
2. write back what vision read, under the one rule and the three gates (Mode B, dry-run by default).

Two reasons keep the boundary where it is:

- The plugin should not take on new dependencies. Page rendering and model clients bring their own stack, which does not belong inside a Zotero add-on.
- A step that can time out or cost money does not belong inside an HTTP request. A request against named items answers quickly, while rendering a scan and calling a vision model runs for minutes and can cost money per call.

The caller keeps the loop: render the pages with a tool of its choice, ask a vision model for the fields, then post the result back for the gates and the write.

## The rule: fill empty fields, never overwrite

An empty library field is filled from the finding. When both sides carry values and the values differ, the field is reported as `conflict` and left unchanged. Overwriting is `apply`'s job, where the caller names the field and the value explicitly ([endpoints.md](endpoints.md)). Two-sided differences are never merged, guessed, or resolved in favor of the extracted value.

## Mode A: read-only discovery of attachments that need vision

```bash
python zoterojs.py enrich --items KEY1,KEY2    # named items, per-item real answer
python zoterojs.py enrich --scan               # whole library, index prefilter first
```

Python callers use `zjs.enrich(items=["ABCD1234"])` and `zjs.enrich(scan=True)`.

A call needs one of `findings`, `items`, or `scan`; a request with none of the three returns HTTP 400. The endpoint is gated as a write endpoint even for GET requests, because Mode B writes and a full scan runs for minutes, so read-only mode answers 403 for both modes (`addon/bootstrap.js:1959`).

### The judge is the extracted character count, not the full-text index state

The decision input is the number of characters returned by `Zotero.PDFWorker.getFullText` for the attachment, not `Zotero.Fulltext.getIndexedState`. The index state does not separate the two cases. Measured on a real library, both of the first two rows below are normal books, and both report `PARTIAL`:

| Attachment | Extracted chars | `getIndexedState` |
| --- | --- | --- |
| `23NZF8PY` | 100,117 | `PARTIAL` — a normal book, one page has no text |
| `27RCEEVC` | 297,684 | `PARTIAL` — same story |
| `2J4LLG6Q` | 0 | `UNINDEXED` |
| `4BY9B5LC` | 0 | `PARTIAL` |

The last two rows are the same thing (pure scans) with different index states, which is the whole argument against using the state as the judge. An attachment counts as a candidate when the extraction returns fewer than `enrich.minChars` characters; an extraction that fails is reported as a candidate with an `error` field, because the text layer could not be confirmed either way.

The counts come from one scan of one library and are not stable to the character: the source records the same first attachment as 97,248 in `addon/prefs.js` and as 10.0 万 in the scan code's own comment. Treat them as an illustration of the gap rather than as reproducible fixtures — the gap either side of the threshold spans several orders of magnitude, which is why the threshold does not need tuning.

### The `enrich.minChars` threshold

The default is 1000 (`addon/prefs.js:16`, preference `extensions.zotero.jsbridge.enrich.minChars`), overridable per call with `--min-chars N`. Real scans come back at 0 or a few dozen junk characters — one complete scanned book, `2D9U3FZP`, measured 79 characters — while real papers extract tens of thousands. Nothing lives in between, so the threshold does not need tuning.

### Measured cost, and why `--scan` prefilters but `--items` does not

Measured over 1235 PDFs:

| Call | Measured cost |
| --- | --- |
| `Zotero.PDFWorker.getFullText` | ~337 ms per PDF — about 7 minutes for the whole library |
| `Zotero.Fulltext.getIndexedState` | 198 ms for all 1235 — a pure database read |

`--scan` therefore prefilters on the index state: an attachment already `INDEXED` cannot need vision, and the expensive extraction set drops from 1235 to 200, about 67 seconds. The prefilter skips only `INDEXED` attachments; every other state still goes through `getFullText`, because the state cannot distinguish a missing text layer from a book with a few text-less pages. `--items` skips the prefilter entirely: naming an item means the caller wants that attachment's real answer, not an approximation of it. `--include-indexed` turns the prefilter off for `--scan` and is intended for debugging only.

### Discovery flags

| Flag | Effect | Default |
| --- | --- | --- |
| `--items KEY1,KEY2` | probe exactly these items; the CLI splits the comma list before sending, because the endpoint expects an array | — |
| `--scan` | probe the whole user library | — |
| `--include-indexed` | keep `INDEXED` attachments in the scan | off |
| `--missing-only` / `--all-items` | skip items whose type-appropriate fields are already complete / include them | `--missing-only` |
| `--min-chars N` | text-layer threshold for this call | `enrich.minChars`, 1000 |
| `--limit N` / `--offset N` | page the candidate list | 100 / 0 |

`--missing-only` (the default) drops items whose fields are already complete, since vision has nothing to add for them; the external rendering and model calls are the expensive part of the pipeline, so the filter saves the largest cost. It is independent of the text-layer test: an item with complete fields is not probed at all.

### Discovery response

| Key | Meaning |
| --- | --- |
| `ok` | success flag |
| `minChars`, `missingOnly` | effective values used for this run |
| `itemsProbed` | top-level bibliographic items considered; notes, standalone attachments, and annotations are filtered out |
| `attsProbed` | PDF attachments considered on those items, before the index prefilter |
| `skippedIndexed` | attachments dropped by the index prefilter |
| `candidates` | number of candidate entries found |
| `offset`, `limit`, `page`, `truncated` | pagination state; `page` carries the candidate rows |
| `errorReport` | item keys that do not exist, when any were named |

Each candidate row holds `item`, `type`, `title`, `missing` (the fields the item type expects but the item lacks, `addon/bootstrap.js:1350`), and `atts`. Each attachment row holds `akey`, `file` (the real file path), `chars`, `state`, `filename` and, on extraction failure, `error`. The file path is resolved through `getFilePathAsync`, which handles linked attachments and relative paths, so an external renderer can open it directly (`addon/bootstrap.js:1444`).

### Why rendering is not part of the plugin

Zotero exposes no headless PDF renderer: `Zotero.PDFRenderer` does not exist, and `Zotero.PDFWorker` has no render method. Pages have to be turned into images outside Zotero, with PyMuPDF or an equivalent tool, and the vision-model call belongs to the same external script. The endpoint hands out the resolved file path of every candidate attachment so that script has a starting point; [zotero-internals.md](zotero-internals.md) covers the surrounding Zotero API surface.

## Mode B: writing back what vision read (dry-run by default)

```bash
python zoterojs.py enrich findings.json           # compare and report; no write
python zoterojs.py enrich findings.json --yes     # apply the write ops
```

`--keep-going` continues the write phase past a per-item error instead of stopping at the first. `--loose` turns off the gates (`strict=false`; see [the three gates](#the-three-gates-front-matter-title-agreement-type-fit)); it exists to prove the gates work and must not be pointed at real data.

### The `findings.json` format

One entry per item:

```json
[{"item": "ABCD1234",
  "pages": [{"p": 1, "type": "封面"}, {"p": 3, "type": "版权页CIP"}],
  "title": "计算土力学", "publisher": "中国建筑工业出版社",
  "year": "2019", "month": 3, "isbn": "978-7-112-00000-0",
  "authors": ["朱百里"],
  "evidence": "计算土力学/朱百里. —北京：中国建筑工业出版社，2019.3"}]
```

The CLI also accepts an object with a `findings` key holding the array. Field names must match the keys the endpoint reads; any other key is ignored.

| findings.json key | Zotero field | Notes |
| --- | --- | --- |
| `item` (or `key`) | — | item key in the user library |
| `pages` | — | gate 1 input; each page carries `p` and `type` |
| `title` | title | filled when empty, extend-only otherwise |
| `publisher` | publisher | on a `thesis` it is written to `university` instead |
| `place` | place | |
| `year`, `month` | date | four-digit year required; a month outside 1–12 is dropped |
| `edition` | edition | |
| `isbn` | ISBN | |
| `series` | series | reported as `review`, never written |
| `authors` | creators | written only when the item has no creators; otherwise reported as `same` |
| `evidence` | — | quoted in `gatedReport`, first 300 characters |

A page `type` matches the front-matter gate when it contains one of the gate's strings as a substring, so `版权页CIP` matches both 版权页 and CIP.

### Field outcomes

| Outcome | Condition | Action |
| --- | --- | --- |
| `new` | the library field is empty | write |
| `extend` | the extracted title extends the library's — "从抛物线谈起" → "从抛物线谈起：混沌动力学引论" | write |
| `same` | the two sides agree: identical values, or the library title already extends the extracted one | nothing |
| `conflict` | both sides have values and the values differ | report only |
| `review` | the field is `series` | report only |
| `nofield` | the item type has no such field | nothing |

Those six are the complete set of `kind` strings the endpoint emits (`bootstrap.js:1484-1508`). A gated finding is absent from the list by construction: it never reaches field comparison, so it carries no field row at all — it is held in `gatedReport` instead (see [the three gates](#the-three-gates-front-matter-title-agreement-type-fit)). Creators never conflict: an item that already has creators is reported as `same` and left untouched.

### The title comparison: `extend` writes, the other direction does not

Gate 2 compares titles after normalization: whitespace, CJK and ASCII punctuation, and dash characters (ASCII hyphen, em dash, fullwidth hyphen-minus) are stripped, the result is lowercased, and the two normalized titles match when either contains the other (`normForCompare`, `addon/bootstrap.js:1361`). The write decision is narrower and checks one direction only: the extracted title must extend the library's title, meaning the extracted string starts with the existing one, which is the `extend` outcome. When the library title already extends the extracted one, the outcome is `same` and nothing is written. This direction matters because a cover or title page that prints only the main title must not truncate a library title that carries the subtitle: the library holds "从抛物线谈起：混沌动力学引论", and a vision reading of a title page printing only "从抛物线谈起" leaves the longer title alone. An empty library title is filled as `new`; every other title disagreement is `conflict`.

### The three gates: front matter, title agreement, type fit

`strict` defaults to true. Every finding passes three checks before any field comparison happens; all three live in `gateFinding` (`addon/bootstrap.js:1397`).

| Check | Function | Plain meaning | Reason string on failure |
| --- | --- | --- | --- |
| 1 front matter | `hasFrontMatter` (`addon/bootstrap.js:1367`) | the page types include one of 封面 / 书名页 / 扉页 / 版权页 / CIP / 题名页 | 没见到前置页（封面 / 书名页 / 版权页）—— 抽出来的很可能是正文里的参考文献或致谢 |
| 2 title agreement | `titleFits` (`addon/bootstrap.js:1377`) | the extracted title and the item title match after normalization, one containing the other | 抽出的书名与条目标题对不上 |
| 3 type fit | `fieldsFitType` (`addon/bootstrap.js:1392`) | a `journalArticle` carries no ISBN, publisher, edition, or series | 这是期刊论文，却抽出了出版社 / ISBN —— 读的多半是被它引用的那本书 |

Gate 3 on a journal article: the item type has no place for a publisher or an ISBN, so an extracted one means the model read the book the article cites, not the article itself.

### Two real hallucinations that justify the gates

The gates trace to two items from a real library, caught on 2026-09-12 in a run over 74 text-layer-free scanned attachments, 45 of which produced fields:

- `82L9PCBI` — a journal article whose metadata came from a bibliography line in its own reference list, which the model reported as "版权页CIP" with a publisher and an ISBN attached. Gate 2 passes it: the article's title genuinely contains the title of the book it cites (弹性力学简明教程). Only gate 3 catches it.
- `H2GCDM5B` — a publisher extracted from an acknowledgment sentence ("本书作者感谢清华大学出版社…"), with page types of only 正文 and 目录. Only gate 1 catches it.

Title similarity alone does not stop this class of error. In the first case the title check passes by construction, because the citing title really does contain the cited title; gates 1 and 3 are what separate a genuine finding from a hallucination.

### Gated findings and `strict=false`

A finding that fails a gate lands in `gatedReport` with its item key, the item's title, the list of reasons, and the finding's `evidence` line (the first 300 characters of it), and it produces no ops. `strict=false` (`--loose`) turns the gates off; it exists to prove the gates work — the same input should then pass — and must not be pointed at real data.

### `series` is reported but never written

`REVIEW_ONLY_FIELDS = ["series"]` (`addon/bootstrap.js:1347`). The model reads any prominent line on a cover as a series; among 23 measured series values on a real library, the field held funding programs (国家自然科学基金重大项目), document types (中华人民共和国国家标准), and publication funds (水利部科技专著出版基金资助项目). A wrong series does not affect search, but it pollutes citation styles, so the endpoint reports it as `review` and writes nothing.

### Writes reuse the `apply` write path

`doEnrich` hands its ops to `doApply` with the tag `enrich` (`addon/bootstrap.js:1580`), so an `enrich` write gets a backup file tagged `enrich` when automatic backup is enabled, and the write is aborted if the backup fails (`addon/bootstrap.js:684`). The write report is the same shape `apply` produces, including its `collectionsLost` and `parentCollectionsGained` warnings when the shared path detects a collection-membership change. The shared path also supports `expect` preconditions; the ops that `enrich` generates do not set them.

### Write-back response

| Key | Meaning |
| --- | --- |
| `ok`, `strict` | status and the effective strictness |
| `findings` | number of entries submitted |
| `gated`, `gatedReport` | findings held back by the gates, each with `why` and `evidence` |
| `checked`, `report` | findings compared field by field, including the ones whose only outcome is `same` |
| `withOps` | findings that produced a write op |
| `tally` | counts per outcome kind |
| `errors`, `errorReport` | entries whose item key did not resolve |
| `apply` | the result of the shared write path: `dryRun`, `applied`, `skipped`, `errors`, `report`, plus `backup` and `warning` when present |

The report keeps entries whose fields are all `same`, so a caller can distinguish "compared and already equal" from "never processed" (`addon/bootstrap.js:1569`).

### Pilot validation

Replaying the 51 real vision outputs through the endpoint gave 36 pass / 15 gated, item-for-item identical to the Python prototype. The 5 divergent rows were all cases where the prototype was wrong: its snapshot had no `place` field and an inaccurate `date`.

## See also

- [endpoints.md](endpoints.md) — the other endpoints, including `apply`, whose write path `enrich` reuses.
- [merge.md](merge.md) — duplicate detection and merge behavior.
- [zotero-internals.md](zotero-internals.md) — the Zotero APIs the plugin relies on.
- [../README.md](../README.md) — project overview and setup.
