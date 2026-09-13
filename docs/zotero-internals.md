# Zotero Internals: Platform Traps

A measured reference of the Zotero and Firefox platform traps this project hit while being built — async data APIs in Zotero 10, the misleading `onlyTopLevel` filter, the `LIKE` guard inside Firefox, manifest and endpoint-registration requirements, and preference-pane binding rules — so other Zotero plugin authors do not repeat them.

Plugin authors are the intended audience, with the maintainers of this project a close second. Every entry here is a behaviour that was measured against a live Zotero 10.0.2 library or read from the platform's shipped source; none of it is inferred from documentation. Each trap is stated as a claim, followed by the evidence that establishes it and the form that works instead.

## Zotero 10's data APIs are async

`Zotero.Items.getAll(1)` returns a **Promise**, not an array. Accessing `.length` on it silently yields `undefined`, and it serializes to `{}` — no error, only wrong data.

| API | Signature |
| --- | --- |
| `Zotero.Items.getAll` | `async (libraryID, onlyTopLevel, includeDeleted, asIDs)` |
| `Zotero.Items.getDeleted` | `async (libraryID, asIDs, days, limit)` |
| `Zotero.Items.getAsync` | `async (ids, options)` |
| `Zotero.Items.get` | sync — `(ids)` |
| `Zotero.Items.getByLibraryAndKey` | sync — `(libraryID, key, options)` |

The async conversion is **not limited to the item data APIs**. `Zotero.Plugins.getRootURI` also
returns a Promise in Zotero 10, so the usual "get a URI, hand it to `Services.io.newURI`" sequence
fails with `NS_ERROR_MALFORMED_URI` — `String()` on the un-awaited value gives `"[object Promise]"`,
which is a string, so nothing complains until the URI is parsed.

The serializer in this plugin flags un-awaited promises explicitly instead of returning a silent `{}`:

```text
"[Promise 未 await：Zotero 10 里 getAll / getDeleted / getAsync 等都是 async]"
```

A top-level `return somePromise` is awaited automatically; what breaks is a promise *nested* inside a returned object. Awaiting is the safe default.

## `onlyTopLevel: true` does not mean bibliographic items

`getAll`'s top-level filter joins two tables:

```js
'SELECT A.itemID FROM items A' +
' LEFT JOIN itemNotes B USING (itemID)' +
' LEFT JOIN itemAttachments C ON (C.itemID=A.itemID)' +
' WHERE B.parentItemID IS NULL AND C.parentItemID IS NULL'
```

There is **no `itemAnnotations` join**, so every highlight and underline in the library counts as a top-level item. Measured on a real library:

| | |
| --- | --- |
| `(await Zotero.Items.getAll(1, true)).length` | **11 231** |
| …of which annotations | 10 030 |
| …standalone attachments / notes | 2 / 2 |
| **actual bibliographic items** | **1 197** |

The performance cost is the obvious half: finding the 1 197 items that matter means 10 030 wasted `getAttachments()` calls, and measured, that loop does not finish in usable time. The worse half is that **the number lies** — a tool reporting `itemsProbed: 11231` looks like it scanned the library while it really looked at a tenth of it, and wrong numbers are worse than slow ones.

Filter by type:

```js
for (const it of await Zotero.Items.getAll(1, true, false, false)) {
  if (it.isAttachment() || it.isNote() || it.isAnnotation()) continue;
  // ...a bibliographic item
}
```

A hand-written `itemTypeID` comparison is a trap of its own: `annotation`'s `itemTypeID` is **1**, which reads like "default / ordinary item", so a hand-rolled check tends to wave the annotations straight through.

## The `LIKE` guard is in Firefox, not Zotero

```js
// ✗ rejected: "Please enter a LIKE clause with bindings"
"... WHERE value LIKE '%x%'"
// ✓ the pattern has to be bound
"... WHERE value LIKE ?", ['%x%']
```

The guard lives in **Firefox's** `modules/Sqlite.sys.mjs`, not in Zotero's code, so searching Zotero's own `omni.ja` for it finds nothing. It is a regex:

```js
/\bLIKE\b\s(?![@:?])/i
```

The semantics: `LIKE`, whitespace, and then a character that is not `@`, `:`, or `?` — only `LIKE ?` / `LIKE :n` / `LIKE @n` pass. It is also stricter than "no quotes": a column name or a subquery after `LIKE` is rejected too. And it is **unconditional** — omitting the params argument does not slip past it (`params = null` is only a default; the check runs on the next line).

Two related facts for anyone writing queries against the Zotero database: `deleteLog` **does not exist** in Zotero 10 (`no such table`) — `deletedItems` is the authoritative trash record. This plugin binds every `LIKE` pattern it writes (`ia.path LIKE ?`, with `'storage:%'` in the parameter array).

## A `type: "extension"` manifest must declare `id`, `update_url`, and `strict_max_version`

A manifest must declare all three of these under `applications.zotero`, or packaging fails with `packagingError` → `Extension is invalid` (`Extension.sys.mjs:1874-1883`):

```json
"applications": {
  "zotero": {
    "id": "...",
    "update_url": "...",              // ← the one everybody forgets
    "strict_max_version": "..."
  }
}
```

The install-failure message is a single hardcoded string. `addon-install-disabled`, `addon-install-blocked`, and `addon-install-failed` all render the same "may not be compatible with this version of Zotero" text (`standalone.addonInstallationFailed.body`). It does *not* indicate a version problem — check the Error Console for the real cause. A missing `update_url` produces exactly this misleading message.

## Endpoint registration requires a constructor, not an object

`Zotero.Server.Endpoints[path]` must be assigned a **constructor**, not an object — server-side the endpoint is instantiated with `new this.endpoint()`. `init` must have exactly one formal parameter so that it takes the object-argument branch; that parameter is the server's `options` object (`server.js:479`: `{ method, pathname, pathParams, searchParams, headers, data }`).

The endpoints in this plugin are plain prototype objects wrapped in a constructor before assignment:

```js
function Ctor(proto) {
  const F = function () {};
  F.prototype = proto;
  return F;
}
```

## Preference panes are less forgiving than the docs suggest

Five things this project got wrong before reading `chrome/content/zotero/xpcom/preferencePanes.js`:

- The pane is an XHTML **fragment**, not a document. XUL is the default namespace, so HTML tags need an explicit prefix (`<html:input>`, `<html:h2>`).
- `register()` given no `id` mints `plugin-pane-<random>-<pluginID>`. A second `register()` therefore **does not throw** — it quietly adds a *second* pane to the sidebar. Give an explicit `id` and `unregister()` first, or users accumulate duplicate panes on every hot reload.
- Panes registered by a plugin are removed on shutdown by Zotero's own `Plugins.addObserver({ shutdown })`, filtered by `pluginID`. That observer does not run on every hot-reload path — `startup()` can be called again without `shutdown()` having run.
- `preference="extensions.zotero.foo"` on a control is bound by Zotero's own prefs code (`_syncFromPref` / `_syncToPrefOnModify`) with no JS needed, but the name must be **fully qualified** and must have a default in `prefs.js`, or the control appears to work and writes to a pref nobody reads.
- **The pane uses fully-qualified names; JS must use short ones.** The two sides reach the same pref through different paths:

  ```js
  // preferences.js:447 / :474 — the pane passes global=true
  Zotero.Prefs.get(preference, true);
  Zotero.Prefs.set(preference, value, true);

  // Zotero.Prefs.get — everything else, prefix added for you
  pref = global ? pref : ZOTERO_CONFIG.PREF_BRANCH + pref;   // "extensions.zotero."
  ```

  Mixing the two **fails silently**: `Zotero.Prefs.set` *creates* a missing pref, so `set('extensions.zotero.x', v)` followed by a `get` reads back `v` while code reading the short name still sees the default. This is the trap that produced a false "the rotation is broken" diagnosis; `test_bridge.js` now records any misuse and fails on it.

## Changing an item's type does not detach its collections — setting `parentItemID` does

The first half is a fabrication story: the test stub's `Item.setType` used to clear `collections`, "because changing the type detaches the item". That behaviour was invented, the test asserted the invented behaviour, and it passed — until the same operation ran against a real library and `collectionItems` turned out not to move at all. The lesson: **a stub shaped wrong makes its tests self-confirming.**

The live measurement is precise: a `presentation` → `document` → `presentation` round-trip leaves `collectionItems` untouched, and the source agrees — `setType` touches only `itemData` / `creators`. What detaches a collection is the database trigger on `collectionItems` (a collection cannot hold an item that has a parent), so setting `parentItemID` is the actual mechanism, and the only one verified live.

That mechanism has a second half, on the other item. Parenting a standalone attachment transfers its collections to the *parent* (`item.js:1944`, "remove from any collections where it existed previously and add parent instead"), so the attachment leaves a collection and the parent joins it. A collection diff therefore has to watch both items: the `apply` endpoint watches the parent as well, and its dry run predicts the transfer. The parent's save passes `skipDateModifiedUpdate`, so its `dateModified` never moves — the transfer cannot be found afterwards by looking for recently-changed items.

## See also

- [Development](development.md) — the test harness, the mutation suite, and the build.
- [Endpoints](endpoints.md) — the endpoint reference.
- [README](../README.md) — install, usage, and settings.
