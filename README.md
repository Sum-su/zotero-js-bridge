# Zotero JS Bridge

**English** | [中文](README.zh-CN.md)

A Zotero plugin that exposes nine local HTTP endpoints for running JavaScript inside a live Zotero process, so scripts can merge items, query the library, edit metadata, take backups, and reclaim disk space from orphaned attachment directories without a human pasting code into **Tools → Developer → Run JavaScript**.

[![release](https://img.shields.io/github/v/release/Sum-su/zotero-js-bridge?label=release)](../../releases/latest)
[![CI](https://github.com/Sum-su/zotero-js-bridge/actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%2B-brightgreen.svg)](https://www.zotero.org/)

## Why this exists

Zotero's plugin API has no out-of-process channel. Anything the connector API does not cover — merging duplicate items, moving attachments, bulk-editing fields, calling internal modules — can only be done from inside the Zotero process. The plugin attaches to the HTTP server Zotero already runs on `127.0.0.1:23119` and registers nine JSON endpoints there. It does not open a new port and does not hold a socket, so Zotero still exits cleanly.

> [!WARNING]
> These endpoints execute **arbitrary JavaScript inside Zotero**, with full access to your library. Any process that can read the token file can delete your entire library. This is a personal automation tool, not a hardened service. Read the [security model](#security-model) before installing.

## Requirements

| | |
| --- | --- |
| Zotero | 7 through 10 (`strict_min_version` `6.999`, `strict_max_version` `10.99.99`); developed and verified on **Zotero 10.0.2** |
| Python | 3.8+ for the bundled client; any HTTP client works, the protocol is nine JSON endpoints |

## Install

1. Download `zotero-js-bridge.xpi` from [Releases](../../releases/latest).
2. In Zotero: **Tools → Add-ons → ⚙ → Install Add-on From File…**
3. Select the `.xpi`. Bootstrapped extensions hot-reload, so a restart is usually unnecessary; if the endpoints do not answer, restart Zotero.

Zotero writes a freshly generated token to `<data-dir>/zoterojs-token.txt`, which the client locates automatically. The plugin adds one pane at **Tools → Preferences → JS Bridge**, containing the switches, the token controls, a **Backup now** button, and a self-check. Every switch takes effect immediately, with no restart.

## Quick start

```bash
python zoterojs.py ping                              # health check; needs no token
python zoterojs.py exec "return Zotero.Libraries.userLibraryID"
python zoterojs.py query --title 物理化学 --limit 20   # structured search, no SQL
python zoterojs.py doctor                            # read-only library health check
python zoterojs.py merge MASTERKEY DUPKEY --dry-run   # self-checked merge
python zoterojs.py apply ops.json                    # dry run until you pass --yes
python zoterojs.py enrich --scan                     # which PDFs need OCR/vision
python zoterojs.py backup                            # VACUUM INTO + rotation
```

`query` prints item keys that feed directly into `merge` and `apply`, so the loop is query → dry-run → confirm → write with no hand conversion.

> [!IMPORTANT]
> **The three writing commands do not share a default, and the difference is safety-relevant.**
> `apply` and `enrich` write-back are dry runs unless you pass `--yes`.
> **`merge` is the exception: it merges for real unless you pass `--dry-run`.** Its `dry_run`
> parameter also defaults to `False` in the Python client. Rehearse a merge explicitly.

The same surface is available as a library:

```python
import zoterojs as zjs

zjs.ping()
zjs.exec("return Zotero.Items.get(1).getField('title')")
zjs.query(title="岩石", limit=20)                            # read-only
zjs.doctor()                                                 # read-only
zjs.merge("ABCD1234", ["EFGH5678"], dry_run=True)
zjs.apply([{"item": "ABCD1234", "set": {"date": "2021"}}])   # dry run is the default
zjs.enrich(scan=True)                                        # read-only discovery
zjs.enrich(findings=[...])                                   # write back
zjs.backup()
```

Full CLI flags and Python signatures: [`docs/endpoints.md`](docs/endpoints.md).

## Endpoints

| Path | Methods | Write? | Purpose |
| --- | --- | :---: | --- |
| `/zoterojs/ping` | GET | | Version, Zotero version, endpoint list, live switch state. The only endpoint that needs no token. |
| `/zoterojs/exec` | POST | ✅ | Run JS with top-level `await` and `return`. Injects `Zotero`, `Services`, `ChromeUtils`, `Components`, `Cu`, `Ci`, `Cc`, `PathUtils`, `IOUtils`, `OS`, and `log()`. |
| `/zoterojs/merge` | POST | ✅ | Merge duplicates behind eight self-checks. **Not dry by default** — pass `dryRun` to rehearse. |
| `/zoterojs/logs` | GET, POST | | Read Zotero's error console and/or debug output. |
| `/zoterojs/query` | GET, POST | | Structured read-only search through Zotero's own `Search`. No SQL. |
| `/zoterojs/doctor` | GET, POST | | Read-only library health checks; does not touch the network by default. |
| `/zoterojs/apply` | POST | ✅ | Bulk metadata writes, dry-run by default, with collection-membership diffing. |
| `/zoterojs/enrich` | GET, POST | ✅ | Fill empty fields from what a vision model read off a scanned PDF. Fill-only, never overwrite. |
| `/zoterojs/storage` | GET, POST | ✅ | Quarantine orphan `storage/` directories and re-point broken linked-file attachments. **The only endpoint that touches the filesystem**, so a real write needs `dryRun:false` and `confirm:true`. |

`backup` is not an endpoint. It is a button in the preference pane plus an automatic-before-write switch.

Every write is additionally guarded: read-only mode returns `403` for `exec`, `merge`, `apply`, `enrich`, and `storage`, including their dry-run forms. Detailed parameters, response shapes, and error codes are in [`docs/endpoints.md`](docs/endpoints.md).

Requests whose `User-Agent` starts with `Mozilla/`, or that carry an `Origin` header, are dropped by **Zotero's own CSRF guard** before they reach the plugin. Command-line clients are unaffected; browser-side callers must send `x-zotero-connector-api-version`, as with any Zotero plugin endpoint.

In-depth references:

- [`docs/merge.md`](docs/merge.md) — the eight self-checks, value normalization, the ISBN backstop.
- [`docs/enrich.md`](docs/enrich.md) — the two modes, the fill-only rule, the three gates and the real errors they were built from.
- [`docs/storage.md`](docs/storage.md) — orphan-directory quarantine and linked-file relocation: why it is reversible, why the match is exact, and why the two write gates are not one.

## Settings

**Tools → Preferences → JS Bridge.** Prefs are read on the request path, so a change applies to the next call; no restart and no re-registration.

| Pref (`extensions.zotero.jsbridge.…`) | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | `false` → all nine endpoints return `503` |
| `readonly` | `false` | `true` → `exec` / `merge` / `apply` / `enrich` / `storage` return `403`; reads still work |
| `endpoint.ping` … `endpoint.storage` | `true` | `false` → that path returns `404` |
| `enrich.minChars` | `1000` | Extracted character count below which a PDF counts as having no text layer |
| `limit.responseKB` | `1500` | Response size cap, clamped to 10–20000 |
| `backup.enabled` | `false` | `true` → back up before every `merge` / `apply` / `enrich` write |
| `backup.keep` | `5` | Backups to retain, clamped to 1–200 |

`ping` reports live switch state, so a client can ask what it is allowed to do instead of guessing. `disabled` lists the paths currently switched off and `readonly` carries the live value of that switch.

The pane also holds the token controls (copy / regenerate / rewrite the token file), a **Backup now** button, and a **self-check** button reporting whether the endpoints are registered, what the switches say, and whether the token file exists. The self-check is deliberately static: it does not fire an HTTP request at `127.0.0.1:23119`, because Zotero's own CSRF guard would block it and a failure would then prove nothing.

## Security model

The threat model is a single-user desktop machine. The consequences should be accepted knowingly:

- **The token is a full-access credential.** It is stored in the pref `extensions.zotero.jsbridge.token` and mirrored to `<data-dir>/zoterojs-token.txt`. Anything that can read that file, or read your prefs, can run arbitrary code inside Zotero and destroy your library.
- **Local-only, but not sandboxed.** Zotero binds its server to `127.0.0.1`, so the endpoints are unreachable from the network. They are reachable by every process on the machine that holds the token.
- **`exec` is deliberately unrestricted.** It is `new AsyncFunction(...)` over your code. That is the entire point; it is not a sandbox and does not pretend to be one.
- **No TLS.** Traffic is loopback plaintext.

Present mitigations: a token on every endpoint except `ping`; constant-time comparison against the stored token; a configurable response cap; a master switch, per-endpoint switches, and a read-only mode; endpoint cleanup on `shutdown()`; dry-run defaults on all three writing endpoints; and backups before writes, where a failed backup aborts the write.

**The switches are a blast-radius control, not a security boundary.** They reduce what a script *you* run can do, which is worth having when handing a terminal to something less careful. They do not contain an attacker who already holds the token — such an attacker can flip the prefs back.

Two precision points:

- **Read-only mode is a refusal, not a sandbox.** It does not parse your code. There is no honest way to decide statically how many side effects a given `exec` can produce, so rather than pretend, it closes the write paths entirely (`exec`, `merge`, `apply`, `enrich`, and `logs --clear`) and leaves the read paths (`ping`, `logs`, `query`, `doctor`) open. `apply` and `enrich` are gated even for a dry run: read-only means "this endpoint is unavailable", not "you may rehearse". `enrich` counts as a write on both verbs, including its discovery mode, because `--scan` extracts the full text of several hundred PDFs and takes minutes.
- **The master switch is enforced on the request path, not at registration.** Disabling the bridge leaves the preference pane in place, which is the only way back — a plugin that removes its own settings UI when disabled cannot be re-enabled from inside Zotero.

Regenerating the token revokes the previous one immediately: the pref and `zoterojs-token.txt` are rewritten, and clients still holding the old token start receiving `403`.

To remove the plugin completely: uninstall it, then delete the pref `extensions.zotero.jsbridge.token` and the `zoterojs-token.txt` file.

## Limitations

- **`enrich` does not render PDFs and does not call a vision model.** Zotero exposes no headless PDF renderer (`Zotero.PDFRenderer` does not exist; `Zotero.PDFWorker` has no render method). Pages must be turned into images by an external script, and so must the model call. The endpoint does exactly two local things: decide which attachments need vision, and write back what vision read.
- **Mutation testing does not yet cover `enrich`.** The 22 mutants in `mutate.py` all predate the endpoint, so a green suite plus 22/22 caught does not mean the newest code is mutation-covered. That endpoint is currently backed by replaying real vision output instead. See [`docs/development.md`](docs/development.md).
- **The `debug` log source is empty by default.** This is not a fault: the buffer only fills when `extensions.zotero.debug.store` is set, and Zotero resets that pref to `false` at startup, so it yields one session's output per restart. The `console` source always works.
- **Read-only mode does not constrain `exec`'s capabilities** beyond refusing to run it — see the security model above.

## Development

```bash
node test_bridge.js              # test suite; needs no Zotero install
python mutate.py                 # revert each fix, confirm the suite goes red
python build.py                  # package the xpi
python build.py --bump           # bump the version first
python build.py --install        # build, then install into a running Zotero
python check_backup.py [DIR]     # open each backup read-only, verify integrity
```

The tests load the real `addon/bootstrap.js` into a Node `vm` context with stubbed Zotero globals and drive the endpoint constructors directly. CI runs the suite, the mutation pass, and a packaging check.

Contributor documentation — harness design, the mutation philosophy, stub fidelity, versioning, and the release ordering rule: [`docs/development.md`](docs/development.md).

## Documentation

| File | Contents |
| --- | --- |
| [`docs/endpoints.md`](docs/endpoints.md) | Complete reference for all nine endpoints: parameters, responses, error codes |
| [`docs/merge.md`](docs/merge.md) | The merge self-checks, normalization, the ISBN backstop |
| [`docs/enrich.md`](docs/enrich.md) | Scanned-PDF metadata enrichment: modes, gates, measurements |
| [`docs/zotero-internals.md`](docs/zotero-internals.md) | Zotero and Firefox platform traps, measured rather than inferred |
| [`docs/plugin-interop.md`](docs/plugin-interop.md) | Reaching other installed plugins from `exec`: what is callable, what only looks callable, and the traps in between |
| [`docs/development.md`](docs/development.md) | Test harness, mutation testing, packaging, CI, versioning |
| [`llms.txt`](llms.txt) | Machine-readable index for language models, with a single-file corpus at [`llms-full.txt`](llms-full.txt) |
| [README.zh-CN.md](README.zh-CN.md) | 中文说明 |

## License

[MIT](LICENSE)
