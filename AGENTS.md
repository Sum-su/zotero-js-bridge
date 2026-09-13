# AGENTS.md

Instructions for AI coding agents working **in** this repository. For documentation aimed at models that only need to *read* the project, see [`llms.txt`](llms.txt).

## What this is

A Zotero 7+ bootstrapped plugin that registers nine HTTP endpoints on Zotero's own `127.0.0.1:23119` server, plus a Python client (`zoterojs.py`) for driving them. There is no build step for the plugin itself — Zotero loads `addon/bootstrap.js` directly.

## Commands

```bash
node test_bridge.js              # full test suite; needs no Zotero install
python mutate.py                 # mutation testing; must report all mutants caught
python build.py                  # package the xpi (also syncs updates.json)
python build.py --bump           # bump the version first
python build_llms.py             # regenerate llms-full.txt
python build_llms.py --check     # CI: fail if llms-full.txt is stale
```

Run `node test_bridge.js` and `python mutate.py` before claiming a change works. The suite runs `addon/bootstrap.js` inside a Node `vm` sandbox against a hand-written Zotero stub.

## Invariants — do not break these

- **Never change the plugin id** `zoterojs-bridge@local`. Installed users become orphans.
- **Never change an existing pref name.** Same reason.
- Every endpoint constructor must follow the established shape: `{ supportedMethods: [...], init: async function (options) {…} }`, registered as a **constructor** (the server calls `new this.endpoint()`).
- **`init` must take exactly one formal parameter.** `server.js` takes the object-argument branch only when `init.length === 1`.
- **Auth before switches**: every handler does `checkAuth(options) || gate(path, write)` in that order. Reversing it leaks which endpoints are disabled to callers without a token.
- **`gate(path, true)` for write endpoints, `false` for read ones.** `enrich` passes `true` even for its read-only discovery verb, deliberately.
- **Item writes go through `doApply`**, which supplies the backup and the `collectionsLost` / `parentCollectionsGained` diffing. **Library-level writes** (tag merges in `apply`, file moves in `storage`) cannot use it — it is item-centric — so they must carry the *same* discipline themselves: a backup before the write, and a dry run that reports what would change without changing it.
- `enrich` fills empty fields only. It never overwrites; two-sided differences are reported as `conflict`.
- **The `storage` endpoint is the only one that touches the filesystem**, so a database backup cannot undo it. Real writes there need `dryRun:false` **and** `confirm:true` — two separate gates, because "did not ask to write" and "asked to write but did not confirm" must return different answers. Every operation it performs must be reversible.

## Adding an endpoint

Five places, all required — a missed one fails silently or weakly:

1. The endpoint constructor in `addon/bootstrap.js`, registered in `Zotero.Server.Endpoints`.
2. A default in `addon/prefs.js` for `extensions.zotero.jsbridge.endpoint.<name>`.
3. A switch in `addon/prefs.xhtml`. The `preference="…"` attribute must be **fully qualified**.
4. The path in `ping`'s endpoint list, and in the `disabled` reporting.
5. Documentation: the endpoint table in `README.md` **and** `README.zh-CN.md`, plus `docs/endpoints.md`. `llms.txt` also needs it — it is hand-written, and it carries endpoint counts in four places (the summary line, the "N endpoints" bullet, the write/read-only split, and the `endpoints.md` blurb). Those counts go stale silently, and `build_llms.py --check` only compares `llms-full.txt` against its sources, so it will not catch them.

Preference names are **fully qualified in the pane** (`extensions.zotero.…`) and **short in JS** — `Zotero.Prefs.get` adds the `extensions.zotero.` branch for you. Mixing them up fails silently, because `Zotero.Prefs.set` *creates* a missing pref.

## Testing

- A guard copied into the stub from real Zotero **needs its own mutant** in `mutate.py`; otherwise it is a comment, not a check.
- A mutant whose anchor no longer matches counts as **failure**, not as a skip. Do not add a mutation without verifying it actually lands.
- `mutate.py` currently has **no mutant targeting `enrich`**. If you touch that endpoint, that gap is what you are relying on.
- Fixtures that reference another item must do so **by key**, resolved after `ITEMS` is built. A hard-coded `itemID` silently points nowhere: `itemID`s are assigned at construction, so `parentItemID: 1000` never resolved to anything, and nothing noticed until `linkedFiles` became the first check to actually look up a parent.
- The stub must match real behaviour, not convenient behaviour. A stub shaped wrong makes its tests self-confirming — that has already happened once here (`Item.setType` was wrongly believed to clear `collections`).

## Versioning and release

- Two-part decimal: `1.12 → 1.13 → … → 1.19 → 1.20`. `build.py --bump` only accepts this form.
- `build.py` auto-syncs `updates.json` from `manifest.json`. That file is what installed plugins read for update checks, via `update_url`.
- **Pushing a version bump and creating its GitHub Release must happen together.** Pushing without the Release makes every installed user's update check hit a 404. CI fails if `updates.json` drifts from the manifest.

## Writing files

When a script writes a source or documentation file on Windows, pass `newline="\n"`. The default translates LF to CRLF, producing a whole-file diff that `git status` shows as nothing unusual — this has already caused one bad release artefact. `build_llms.py` and `mutate.py` both do this explicitly.

Generated files that must not be hand-edited: `llms-full.txt` (from `build_llms.py`), `updates.json` (from `build.py`).
