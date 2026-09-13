# Zotero JS Bridge — Development

Contributor documentation for the Zotero JS Bridge: how the test harness and its stubs work, why mutation testing runs on every change, how the xpi is packaged, what CI enforces, and the version and release rules that keep installed users updating.

## Development commands

```bash
node test_bridge.js              # endpoint suite against stubbed Zotero globals
python mutate.py                 # revert each fix, confirm the suite goes red
python make_icon.py --preview    # icon variant preview; writes only addon/icons/_preview.png
python build.py                  # package the xpi
python build.py --bump           # increment the version, then package
python build.py --install        # build, then install into a running Zotero
python check_backup.py [DIR]     # open each backup read-only, verify integrity
```

The harness needs Node only (CI uses Node 24). The Python scripts need Python 3 (CI uses 3.11); `make_icon.py` additionally needs Pillow. `build.py --install` requires a running Zotero with the bridge live.

## The test harness (`test_bridge.js`)

The suite needs no Zotero install. It reads the real `addon/bootstrap.js` from disk and runs it in a Node `vm` context whose globals are stubs — `Zotero`, `Services`, `Components`, `ChromeUtils`, `IOUtils`, `PathUtils`, and the built-ins the plugin touches:

```js
const ctx = vm.createContext(sandboxGlobals);
vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx, { filename: "bootstrap.js" });
const call = (fn, ...a) => vm.runInContext(fn, ctx)(...a);
```

The suite then calls the real `startup`, takes `Zotero.Server.Endpoints` out of the sandbox, and drives the endpoint constructors directly — `new EP["/zoterojs/ping"]().init({ method, headers, searchParams, data })` — asserting on the returned status and body. Internal helpers are driven through the same context (`call("freeBackupPath", …)`). The manifest is read before `startup` and its version is passed in, so a version bump does not make the suite red. The suite exits non-zero if any test fails.

One manifest test asserts that every icon the manifest declares is present and is a PNG of the declared pixel size:

| Manifest key | File | PNG size |
| --- | --- | --- |
| `"48"` | `icons/favicon@0.5x.png` | 48×48 |
| `"96"` | `icons/favicon.png` | 96×96 |

The check reads bytes 1–3 for the `PNG` signature and the IHDR width and height at byte offsets 16 and 20 (big-endian), comparing each to the manifest key.

## Mutation testing (`mutate.py`)

**Green tests only prove the suite ran.** `mutate.py` reverts 22 individual fixes — one at a time, restoring the file in a `finally` — and checks that the suite turns red for each one. All 22 are currently caught. It is the difference between "the tests pass" and "the tests are watching".

Seventeen mutants edit `addon/bootstrap.js`; five edit `test_bridge.js` itself.

| Target | Mutants | Behaviour reverted (examples) |
| --- | --- | --- |
| `addon/bootstrap.js` | 17 | `apply`'s collection diff and its parent-side half, dry-run paths, automatic-backup abort, `LIKE` binding, backup naming and rotation, `doctor` default checks, `query` condition validation, pref names, collection-id resolution |
| `test_bridge.js` | 5 | the stubbed SQL guard, and four stub behaviours copied from the real library |

The first of the five reverts the stubbed SQL guard to a looser version (`args !== undefined && …`) that once made the stub accept a query the real Zotero rejects; the remaining four undo behaviours copied into the stub from the real library. The principle: **a guard copied into the stub from the real thing needs its own mutant — otherwise it is a comment, not a check.**

### An anchor that stops landing fails the build

Each mutant is anchored on the exact source text of the code it reverts. The runner applies the replacement to the file's current contents; if the anchor is no longer present, the run reports the miss and exits non-zero rather than counting the mutant as skipped or passed, and CI treats that as a build failure. An anchor that no longer matches means the behaviour it pinned has moved, and a guard that quietly stopped watching is the failure mode worth fearing.

The mutant is written with `newline="\n"` and the original is restored in a `finally` with the same argument, so a mutation run does not flip the working copy's line endings to CRLF on Windows.

## Stub fidelity

Stubs are written to match the real modules rather than to be convenient.

`PreferencePanes.register` reproduces the duplicate-id throw and the `plugin-pane-<random>-<pluginID>` id generation from `preferencePanes.js`, because those are the two facts that make a naive re-registration on hot reload fail silently: an explicit id collides and throws, and a missing id quietly produces a second pane, so the plugin must unregister its own id.

The `LIKE` guard is copied into the stub verbatim from Firefox's `modules/Sqlite.sys.mjs` — the regex `/\bLIKE\b\s(?![@:?])/i`, throwing `Please enter a LIKE clause with bindings` — so a query that would throw against a real library fails in the harness instead. The guard is unconditional: omitting the params argument does not pass it, and the suite asserts both the rejection and the legal bound-parameter form.

The SQL router matches statements by distinctive text patterns rather than parsing SQL, so the code under test walks the same retrieval paths it would take against a real database.

A stub shaped wrong makes its tests self-confirming. A previous stub cleared `collections` in `Item.setType`, because changing an item's type was believed to detach it; a test asserted that invented behaviour and passed, until the same operation was run against a real library, where `collectionItems` did not move at all. The behaviour that does detach a collection is setting `parentItemID` (a child item cannot be in a collection), and it has a second half on the other item: parenting a standalone attachment transfers its collections to the parent (`item.js:1944`, "remove from any collections where it existed previously and add parent instead"). Measured on a real library: attachment `4WWZ44HC` in collection 307 lost its `collectionItems` row the moment it was given a parent. The diff watches both items for this reason, and the dry run predicts the transfer; the parent's save passes `skipDateModifiedUpdate`, so its `dateModified` never moves and the transfer cannot be found afterwards by looking for recently modified items.

## Harness honesty assertions

Two assertions do not test the plugin at all. They test whether the harness is still honest, because both failure modes are silent.

- **Unmatched SQL is recorded.** The SQL router records every statement it does not recognize. An unmatched query returns an empty array, and an assertion over that empty array passes having verified nothing. The `[8.9]` self-check block asserts that the record is empty.
- **A fully-qualified pref name used as a short name is recorded.** `Zotero.Prefs.get(pref)` without `global` prepends `extensions.zotero.`, so a fully-qualified name reads a different key — and a missing pref falls back to its default, which makes "the switch did not work" and "the switch was never on" look identical. The `Prefs` stub records any read or write of a fully-qualified name where a short one was required, and the suite asserts the record is empty. The pane's `preference="…"` attributes are full names on purpose: they are read with `global=true`.

## Packaging (`build.py`)

`python build.py` writes `zotero-js-bridge.xpi` from `addon/`: `manifest.json`, `bootstrap.js`, `prefs.js`, `prefs.xhtml`, and `icons/favicon*.png`. A hand-rolled zip command is not equivalent — omitting `icons/` produces a package with no icon and no error.

`build.py` fails loudly on two conditions, both chosen because they otherwise present as something that looks fine until a user relies on it — for the pane, a control that looks fine until it is clicked:

- A manifest-declared icon that did not make it into the archive: the installed plugin shows a blank icon.
- A `preference="…"` in the pane with no default in `prefs.js`: the switch is `undefined` once installed, so the pane looks normal and the failure appears only on use.

XML comments in the pane are stripped before this check, so a commented-out `preference="…"` is treated as prose, not as a binding.

**The xpi hash is not a stable identifier for a source revision.** Two builds of the same checkout produce the same hash, but a build of the same *content* from a different checkout does not: the archive stores each entry's mtime, so the hash tracks file timestamps as well as bytes. Before concluding that a published asset was tampered with, unzip both and compare the entries — measured on the v1.12 asset, the archive hashes differed while all six extracted files were byte-identical.

`build.py --bump` increments the manifest version before packaging. `build.py --install` packages, then asks the running bridge to install the xpi through `AddonManager`, and polls `ping` (up to 20 attempts, 0.25 s apart) to report which version is live; `install()` resolves before the new instance has started, so an immediate `ping` can return `404 No endpoint found`.

## Continuous integration

`.github/workflows/test.yml` runs on pushes to `main`, on pull requests, and on manual dispatch.

| Job | Steps |
| --- | --- |
| `test` (Node 24) | `node test_bridge.js`; `python3 mutate.py` |
| `build` (Python 3.11) | `py_compile` over `zoterojs.py`, `build.py`, `make_icon.py`, `check_backup.py`, `mutate.py`, then `import zoterojs, build, mutate`; `python build.py`; fail if `updates.json` has a diff; upload `zotero-js-bridge.xpi` as an artifact |

The test job runs the suite and the mutation pass, because the suite alone is not the check: `mutate.py` exits non-zero when a mutant survives or when an anchor no longer matches. The build job re-runs `build.py` and then fails if `git diff` shows `updates.json` changed — `build.py` rewrites that file from the manifest, so a remaining diff means the committed copy and the manifest disagree, which is the "marketplace shows the new version, existing users get no update" bug. The Python scripts have no unit tests; byte-compiling and importing them is the minimum check in CI.

## Versioning

Bump the version on every build: Zotero ignores a reinstall whose version is unchanged. `build.py --bump` accepts only a two-segment version, matching `"(\d+)\.(\d+)"` in `manifest.json` (currently `1.13`). The change from `1.0.11` to `1.12` was a convention change to two-part decimal and was made by hand in `manifest.json`; a three-segment version is rejected rather than bumped, because bumping `1.0.11` to `1.0.12` would break the convention while looking entirely normal. Under the new scheme the second segment is a counter: `1.12 → 1.13 → … → 1.19 → 1.20`, with the carry written `1.20` rather than `1.2`, so the value increases both as a decimal and segment-wise.

## The `updates.json` hazard

`build.py` auto-syncs `updates.json` from `manifest.json` on every run. It parses owner and repo out of the manifest's `update_url`, writes the manifest version into the single update record, and rebuilds the `update_link` as `https://github.com/{owner}/{repo}/releases/download/v{version}/zotero-js-bridge.xpi`, alongside the manifest's `strict_min_version` and `strict_max_version`. More than one update record for the plugin id is a hard error.

Installed plugins read `updates.json` for update checks: the manifest's `update_url` points at it in the repository (`https://raw.githubusercontent.com/Sum-su/zotero-js-bridge/main/updates.json`). **Pushing a version bump without creating the corresponding Release makes every installed user's update check hit a 404. Push and Release must be done together.**

## Mutation coverage gap

The 22 mutants are a record of fixes that were made, not a per-endpoint coverage matrix. No mutant targets the `enrich` endpoint. A green suite with 22 of 22 mutants caught therefore does not mean the newest code is mutation-covered; `enrich` is currently backed by replaying real vision output instead.

## Backup verification (`check_backup.py`)

```bash
python check_backup.py                        # <data dir>/jsbridge-backups/
python check_backup.py D:\somewhere\backups   # a directory or one .sqlite file
```

"Backup created" and "backup usable" are different claims. Each file is opened read-only (`mode=ro` in the SQLite URI), and the script prints the `PRAGMA integrity_check` result and the row count of five tables: `items`, `collections`, `collectionItems`, `deletedItems`, `itemData`. A table it cannot read is reported, not fatal to the file. The default directory is `<data dir>/jsbridge-backups/`, and the data-directory candidates come from `zoterojs.py` rather than a second copy of the list, so the two cannot drift apart. The script exits non-zero if any file fails to open. A pass means the file is usable; it does not mean the restore procedure has been rehearsed.

## See also

- [`zotero-internals.md`](zotero-internals.md) — the Zotero and Firefox platform behaviour the stubs reproduce.
- [`endpoints.md`](endpoints.md) — the endpoint contract the suite asserts.
- [`../README.md`](../README.md) — install, settings, the security model, and limitations.
