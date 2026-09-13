# The `merge` endpoint: self-checked duplicate merging

The `merge` endpoint merges duplicate Zotero items into a surviving `master` item, and only after eight self-checks confirm that each duplicate is the same work.

The endpoint is `POST /zoterojs/merge`, takes a JSON body of `{"master": "<KEY>", "dups": ["<KEY>", ...], "dryRun": false}` (`bootstrap.js:1878-1890`), and requires the `X-ZoteroJS-Token` header. It counts as a write endpoint even for a dry run, so read-only mode rejects it with `403` (`bootstrap.js:1882`, `bootstrap.js:208-231`). Parameters and error codes are listed in [the endpoint reference](endpoints.md#the-merge-endpoint). This file describes plugin version 1.13.

## The core rule: missing is not a conflict

Two values conflict only when both sides carry one and the normalized values differ (`bootstrap.js:339`). A field that is absent on one item never blocks a merge:

| `master` value | duplicate value | Outcome |
| --- | --- | --- |
| `12` | missing | pass — only one side has a value |
| missing | `12` | pass — only one side has a value |
| `12` | `12` | pass — equal |
| `1–10` | `1-10` | pass — equal after normalization |
| `Journal of Petrology` | `journal of petrology` | pass — case is normalized away |
| `-` | `12` | pass — `-` normalizes to an empty string and counts as missing |
| `12` | `13` | fail — both sides present and different |

The rule matters because of online-first articles. An article published ahead of print legitimately has no volume, issue, or pages yet, while the record for the same article carries all three. A comparison that demands equality (`volume_master === volume_dup`) reads an empty value against a present one as a difference and rejects the genuine duplicate; the conflict rule ignores the pair unless both items supply a value, so the merge proceeds on the fields both items do have.

## The eight compared fields

The check keys are the literal strings returned in the `checks` object of every report entry (`bootstrap.js:373-382`); they are Chinese, and a caller matching on them must use the exact strings.

| Key in `checks` | Compared value | Rule | Failure meaning |
| --- | --- | --- | --- |
| `标题相同` | `title` | equal after normalization | The titles differ: not the same work. |
| `类型相同` | `itemType` (Zotero item-type ID) | strict equality, not normalized | The item types differ. |
| `年份不冲突` | first four-digit run in the `date` field (`bootstrap.js:340`) | missing ≠ conflict | Both years are present and differ. |
| `卷号不冲突` | `volume` | missing ≠ conflict | Both volumes are present and differ. |
| `期号不冲突` | `issue` | missing ≠ conflict | Both issues are present and differ. |
| `页号不冲突` | `pages` | missing ≠ conflict | Both page ranges are present and differ. |
| `DOI 不冲突` | `DOI` | missing ≠ conflict | Both DOIs are present and differ. |
| `ISBN 不冲突` | `ISBN` | missing ≠ conflict | Both ISBNs are present and differ. |

`creators` and `edition` are not compared. The year is not the whole date field: `yearOf` takes the first four-digit sequence out of `date`, so `2021` and `2021-05-03` agree (`bootstrap.js:340`).

## Normalization before comparison

Every value is cast to a string, lower-cased, and stripped of a fixed noise set before any comparison (`strip`, `bootstrap.js:337`). Both the title equality check and the six conflict checks compare stripped values, so case, spacing, and punctuation differences do not separate duplicates.

| Class | Characters removed |
| --- | --- |
| Whitespace | everything matched by JavaScript `\s` |
| Dash punctuation | the whole Unicode `Pd` category: ASCII hyphen `-` (U+002D), hyphen (U+2010), non-breaking hyphen (U+2011), figure dash (U+2012), en dash `–` (U+2013), em dash `—` (U+2014), horizontal bar (U+2015), small hyphen-minus (U+FE63), fullwidth hyphen-minus (U+FF0D), and the rest of `Pd` |
| Dashes outside `Pd`, listed individually | minus sign `−` (U+2212, category `Sm`), soft hyphen (U+00AD, `Cf`), hyphen bullet (U+2043, `Po`) |
| Format characters | zero-width space (U+200B, `Cf`) |
| ASCII punctuation | `_ . , ; : ( ) [ ] ! ?` |
| Fullwidth and CJK punctuation | `（ ） 【 】 《 》 、 ， 。 ： ； ！ ？` |
| Quotes and middle dot | `"` `'` `’` `·` |

The same character class as written in the source, with the invisible members shown as escapes:

```js
// bootstrap.js:336, the same class with the invisible members written as escapes
const NOISE = /[\s\p{Pd}\u2212\u00AD\u2043\u200B_.,;:()[\]（）【】《》"'’·、，。：；！？!?]/gu;
```

The dash handling is the part that matters most. Zotero's translators routinely deliver `1–10` with an en dash (U+2013) where the same range was typed `1-10` with ASCII U+002D — the code comment names CNKI, JSTOR, and Springer — and a literal string comparison reads those as different values, rejecting a genuine duplicate. An earlier version of the plugin listed only three hyphen characters (U+002D, U+2014, U+FF0D); the current regex matches the entire `Pd` category instead (`bootstrap.js:326-336`). The three characters outside `Pd` are listed by hand, and zero-width space (U+200B) is listed separately because JavaScript's `\s` does not match it although it is common in text copied from web pages (`bootstrap.js:331-335`).

## The ISBN check as the backstop for same-title volumes

Two volumes of the same textbook can carry identical titles and identical creators and differ only in ISBN and edition. Nothing else in the check list separates them: `creators` and `edition` are not compared fields, so if the pair reached the merge it would run, `master` would survive, the duplicate volume would go to the trash, and `Ctrl+Z` in Zotero would be the undo (`zoterojs.py:256`). The ISBN check is what stops that: when both volumes have an ISBN and the ISBNs differ, `ISBN 不冲突` is false and the duplicate is skipped with `自检未通过: ISBN 不冲突`. Both volumes stay in the library.

The backstop has one boundary: if only one volume carries an ISBN, the missing ≠ conflict rule treats the pair as compatible, and the check does not fire.

## `dryRun` reports without writing

With `dryRun` set, the endpoint skips the `mergeItems` import entirely (`bootstrap.js:357-364`), takes no backup (`bootstrap.js:1893-1895`), and writes nothing; each duplicate that passes the checks is reported instead of merged, with `merged: false`, `dryRun: true`, and the attachment and collection counts the merge would consolidate (`bootstrap.js:388-393`). The dry run performs the same eight checks as a real merge.

```bash
python zoterojs.py merge MASTERKEY DUPKEY --dry-run
python zoterojs.py merge MASTERKEY DUPKEY1 DUPKEY2 --dry-run
```

```python
import zoterojs as zjs

zjs.merge("ABCD1234", ["EFGH5678"], dry_run=True)   # self-check only
zjs.merge("ABCD1234", ["EFGH5678"])                 # real merge
```

The dry run is opt-in. `dry_run` defaults to `False` in the Python client (`zoterojs.py:252`) and the endpoint coerces `data.dryRun` to a boolean (`bootstrap.js:1892`), so `python zoterojs.py merge MASTERKEY DUPKEY` and `zjs.merge("ABCD1234", ["EFGH5678"])` perform a real merge. The CLI accepts any number of duplicate keys (`merge MASTER DUP [DUP ...] [--dry-run]`, `zoterojs.py:548-555`); the Python wrapper accepts a single key or an iterable (`zoterojs.py:258-259`) and posts `{"master": ..., "dups": [...], "dryRun": ...}` (`zoterojs.py:260-261`).

A dry run still passes the write gate: read-only mode returns `403`, a disabled endpoint returns `404`, and the master switch returns `503` (`bootstrap.js:208-231`). The switches are listed in [the settings table](../README.md#settings).

## The shape of the response

A passing dry run returns the following object (`bootstrap.js:402-409`):

```json
{
  "ok": true,
  "dryRun": true,
  "master": { "key": "ABCD1234", "title": "Example title" },
  "report": [
    {
      "key": "EFGH5678",
      "merged": false,
      "dryRun": true,
      "checks": {
        "标题相同": true,
        "类型相同": true,
        "年份不冲突": true,
        "卷号不冲突": true,
        "期号不冲突": true,
        "页号不冲突": true,
        "DOI 不冲突": true,
        "ISBN 不冲突": true
      },
      "attachments": 2,
      "collections": 1
    }
  ],
  "attachmentsAfter": 1
}
```

| Top-level field | Value |
| --- | --- |
| `ok` | `true` once the report loop runs; `false` when the call aborts before it — an unusable `master` returns `error` instead of `report` (`bootstrap.js:354-355`), and a malformed request or a failed backup never reaches the loop (`bootstrap.js:1888-1890`, `bootstrap.js:684-694`). |
| `dryRun` | the request flag coerced to boolean. |
| `master` | `{ "key", "title" }` of the item that would survive. |
| `report` | one entry per key in `dups`, in request order (`bootstrap.js:367`). |
| `attachmentsAfter` | `master`'s attachment count after the loop (`master.getAttachments().length`, `bootstrap.js:407`). |
| `backup` | present on a real merge when the automatic-backup pref is on: the descriptor from `backupBefore("merge")` (`bootstrap.js:684-694`, added at `bootstrap.js:1895-1897`). A dry run takes no backup. |

| Report-entry field | Present when | Value |
| --- | --- | --- |
| `key` | always | the duplicate's item key |
| `merged` | always | `true` only after the merge call returned |
| `checks` | the item exists and is not in the trash | the eight booleans above |
| `dryRun` | a dry-run entry that passed the checks | `true` |
| `attachments` | a dry-run pass, or a real merge | attachment count of `master` + duplicate before the merge |
| `collections` | a dry-run pass | collection count of `master` + duplicate |
| `why` | a skipped entry | the reason string |

The actual merge is `mergeItems(master, [dup])` from `chrome://zotero/content/mergeItems.mjs`, with a fallback to `Zotero.Items.merge(master, [dup])` when that module cannot be imported (`bootstrap.js:357-364`, `bootstrap.js:396`). Each duplicate is merged into the same `master` one at a time, so `attachmentsAfter` reflects the accumulation.

## What happens when a check fails: the duplicate is skipped, the batch continues

A failed check skips that one duplicate; it does not abort the call. The loop `continue`s and the remaining duplicates are still checked and merged (`bootstrap.js:383-387`). A `mergeItems` exception is caught per duplicate and reported the same way (`bootstrap.js:398-400`).

| `why` value | Trigger | Reference |
| --- | --- | --- |
| `条目不存在` | the duplicate key is not in the user library | `bootstrap.js:369` |
| `已在回收站` | the duplicate is already in the trash | `bootstrap.js:370` |
| `自检未通过: <names>` | one or more checks false; failed names joined with `、` in the order the checks are defined | `bootstrap.js:383-386` |
| `mergeItems 报错: <message>` | the merge call threw; the loop continues | `bootstrap.js:398-400` |

Two conditions abort the whole request before any item is touched: `master` missing or already in the trash returns `{"ok": false, "error": ...}` with no report (`bootstrap.js:354-355`), and a request without `master` or without `dups` returns `400` (`bootstrap.js:1888-1890`). On a real merge with backups enabled, a failed backup also aborts the write before anything is merged (`bootstrap.js:684-694`).

## See also

- [`endpoints.md`](endpoints.md) — parameters, response fields, and error codes for the `merge` endpoint and the other seven endpoints.
- [`enrich.md`](enrich.md) — the fill-only metadata enrichment endpoint and the gates that guard it.
- [`../README.md`](../README.md) — installation, settings, and the endpoint table.
