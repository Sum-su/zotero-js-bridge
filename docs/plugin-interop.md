# Calling Other Zotero Plugins

The `exec` endpoint receives Zotero's **live global object**, not a copy of it. Every other
installed plugin mounts onto that same object, so a script driven through this bridge can reach
another plugin's exported API, its runtime state, or its menu handlers — with no cooperation from
that plugin and no change to this one.

This page records what that channel actually reaches and the three ways it misleads you. The
audience is plugin authors and anyone writing automation on top of the bridge. Everything below
was measured against a live Zotero 10.0.2 profile with 25 plugins installed, or read from the
shipped source of the plugin concerned.

## Why the channel exists

`exec` does not inject a stub `Zotero`. It passes the real one in as an argument:

```js
const ARG_NAMES = ["Zotero", "Services", "ChromeUtils", … , "log"];
fn = new AsyncFunction(...ARG_NAMES, '"use strict";\n' + code);
return { mode: "AsyncFunction", value: await fn(...argValues(logs)) };
```

The sandbox fallback used when `new Function` is blocked (`bootstrap.js:307-321`) binds the same
object the same way. There is one `Zotero` in the process, so anything another plugin has attached
to it is visible from inside `exec`.

Note the `"use strict"` on the main path: an undeclared assignment throws instead of creating a
global. Declare your variables.

## Start by asking what is there

Do not guess at a plugin's surface. Enumerate it. This is the whole survey, and it is safe — it
reads property names and calls nothing:

```js
const out = {};
for (const k of Object.getOwnPropertyNames(Zotero)) {
  let v;
  try { v = Zotero[k]; } catch (e) { continue; }
  if (!v || typeof v !== "object") continue;
  const hasApi = "api" in v, hasHooks = "hooks" in v, hasData = "data" in v;
  if (!hasApi && !hasHooks) continue;
  const keys = o => { try { return Object.keys(o || {}); } catch (e) { return ["<non-enumerable>"]; } };
  out[k] = { hasData, api: hasApi ? keys(v.api) : null, hooks: hasHooks ? keys(v.hooks) : null };
}
return out;
```

Plugins built from [`zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template)
— which is most of them — register themselves as `Zotero.<PluginName> = { data, hooks, api }`. The
survey finds them by that shape.

## The three shapes, and the first trap

**`api` populated** — callable. This is the only shape you can call directly.

| Plugin | Version | Workspace name | Selected members |
| --- | --- | --- | --- |
| Better Notes | 3.3.3 | `Zotero.BetterNotes` | `template.runItemTemplate`, `convert.md2note`, `convert.item2citation`, `$export.saveMD`, `relation.*`, `editor.*` |
| Magic for Zotero | 2.8.10 | `Zotero.ZoteroMagic` | `AIColumns`, `paperSummary`, `fullTextTranslate`, minerU / doc2X / SimpleTex / PaddleOCR parsers |
| Ethereal Style | 6.0.76 | `Zotero.ZoteroStyle` | `generateAITags`, `generateAIRemark`, `record`, `tabManager` |
| Ethereal Reference | 1.8.17 | `Zotero.ZoteroReference` | `getReferences`, `connectedPapers`, `runReferenceAISummary`, `getColoredTags` |
| Jasminum | 1.1.39 | `Zotero.Jasminum` | `getOutlineFromPDF`, `requestDocument`, `HeadlessBrowserService` |
| Linter for Zotero | 4.0.1 | `Zotero.Linter` | `utils.getTextLanguage` — that is the entire surface |
| Translate for Zotero | 2.4.7 | `Zotero.PDFTranslate` | `translate`, `getServices`, `getVersion` |

> [!IMPORTANT]
> **An `api` object that exists may still be empty.** `"api" in Zotero.X` comes back `true` while
> `Object.keys(Zotero.X.api)` comes back `[]`. Zoplicate 5.1.1 is in exactly this state: it has the
> key, and the author registered nothing under it. A check written as `if (v.api)` passes and the
> first call throws. Test the **keys**, not the presence.

**`api` empty, `data` populated** — readable state, nothing callable. Zoplicate, 塔拉, Green Frog,
Nutstore, PDF2zh and several other scaffolded plugins are in this shape. See the third trap below
before you depend on it.

**Nothing on `Zotero` at all** — not reachable through this channel. Measured: **Chartero v2.11.0
exposes no global whatsoever**, not even an empty one. Neither does DOI Fix, Zotero OCR, or MCP
Bridge for Zotero. A plugin only becomes reachable if its author chose to mount something; there is
no framework-level guarantee that they did.

## Trap two: `hooks` are menu actions, and they have side effects

`hooks` is not a second API. It holds the plugin's lifecycle callbacks *and* the handlers behind
its menu items, with nothing marking which is which. The lifecycle names are recognisable —
`onStartup`, `onShutdown`, `onMainWindowLoad`, `onMainWindowUnload`, `onNotify`, `onPrefsEvent`.
Everything else is a menu action.

```js
Zotero.Linter.hooks        // onLintInBatch, onUpdateInBatch
Zotero.BetterNotes.hooks   // onOpenNote, onShowTemplatePicker, onCreateNoteFromTemplate, …
```

Calling one is equivalent to the user picking that menu item. `onLintInBatch` **writes metadata to
your library.** Treat a hook call as a write operation: it belongs behind an explicit decision, not
inside a read-only sweep. If you only want to know whether a plugin is capable of something, read
`Object.keys(hooks)` and stop.

## Trap three: `data` is internal state, and it may not be populated yet

`data` is the plugin's own working memory, not a contract. It can be empty, stale, or shaped
differently on the next release.

Zoplicate's duplicate-detection results are a clean example of the timing problem. The surface looks
promising:

```js
Zotero.Zoplicate.data.duplicateSets    // → {"1":{"_objects":{}}}   ← empty
Zotero.Zoplicate.data.duplicateCounts  // → {"1":{"total":0,"unique":0}}
```

Both are empty because Zoplicate computes duplicates **lazily**, when its duplicate-search dialog
opens. Read before then, and you get a confident-looking zero. A pipeline built on that reading
concludes "no duplicates" on a library that has plenty. If you consume another plugin's `data`, you
inherit the obligation to know when it is valid — and the plugin does not tell you.

## Do not rebuild what another plugin already owns

The channel is easy enough that the tempting mistake is to re-implement a neighbour's job because
you can reach the data. Check first whether the neighbour already runs on its own.

A worked case. This bridge's `enrich` endpoint writes `title` for scanned books. Linter has a
sentence-case rule whose input is the item's `language` field, and it falls back to English when
that field is empty:

```js
// linter.js:8649
const lang = item.getField("language") || "en-US";
```

The obvious repair is to have `enrich` set `language` whenever it writes a title. Read against the
shipped source, that repair is redundant:

- Linter's own `require-language` rule already does exactly that, with the same detector:

  ```js
  const title = item.getField("title");
  const language = getTextLanguage(title);
  item.setField("language", language);
  ```

- Linter ships that detector as `Zotero.Linter.api.utils.getTextLanguage` — the one public function
  it exposes at all. Measured: `getTextLanguage("MATLAB 数值模拟")` → `"zh"`,
  `getTextLanguage("岩石力学与工程学报")` → `"zh"`, `getTextLanguage("MATLAB")` → `"en"`.

So the field has an owner, and that owner is a whole library sweep away from being applied. Adding
it to `enrich` would have duplicated logic that lives upstream, coupled this plugin to another one
for no gain, and left two implementations to keep in agreement. **Reach for `exec` to call a
capability, not to re-create one.** The honest use of the bridge here is to read which items are
missing `language`, hand that list to Linter, and let the plugin that owns the rule do the writing.

## Limits worth knowing before you build on this

- **`api` is an author's whim, not a standard.** The name, the depth, and the argument conventions
  are unconstrained. Better Notes nests five levels deep; Linter exposes one function. Nothing
  carries a version, so a plugin update can move or remove a member without warning. Pin the
  versions you depend on and re-run the survey after upgrading.
- **`Zotero.Plugins.getRootURI` is async in Zotero 10** — it returns a Promise, like the `Items`
  data APIs. `String()` on the un-awaited result gives you `"[object Promise]"`, and the usual
  downstream symptom is a URI that resolves to nothing. See
  [Zotero internals](zotero-internals.md#zotero-10s-data-apis-are-async).
- **Reaching a plugin that mounts nothing** means importing its module by root URI and
  instantiating it yourself. That is outside what this page covers, and it is a different kind of
  operation: you get a second instance of that plugin's logic, not the running one, so its cached
  state and its registered observers are not yours. The plugins that matter here have not needed it.

## See also

- [Endpoints](endpoints.md) — `exec`'s parameters, the injected names, and the response envelope.
- [Zotero internals](zotero-internals.md) — the async data APIs and other platform traps, measured.
- [README](../README.md) — install, usage, and the security model.
