# Zotero JS Bridge

Run JavaScript inside a running Zotero, from your terminal.

Zotero's plugin API has no out-of-process escape hatch. Anything that isn't
in the connector API — merging duplicate items, moving attachments between
storage backends, bulk-editing fields, calling internal modules — can only be
done from inside the Zotero process. Normally that means opening
**Tools → Developer → Run JavaScript** and pasting code by hand, every time.

This plugin opens four local HTTP endpoints on the HTTP server Zotero already
runs (`127.0.0.1:23119`), so a script can do it instead.

```console
$ python zoterojs.py exec "return Zotero.Libraries.userLibraryID"
1

$ python zoterojs.py merge ABCD1234 EFGH5678 --dry-run
{ "ok": true, "dryRun": true, "report": [{ "key": "EFGH5678", "merged": false, ... }] }
```

> [!WARNING]
> These endpoints execute **arbitrary JavaScript inside Zotero** with full
> access to your library. Any process that can read the token file can delete
> your entire library. Read [Security model](#security-model) before you
> install this. It is a personal automation tool, not a hardened service.

## Requirements

- Zotero 7 or later (developed and verified against **Zotero 10.0.2**)
- Python 3.8+ for the bundled client (any HTTP client works — the protocol is
  three JSON endpoints)

## Install

1. Download `zotero-js-bridge.xpi` from
   [Releases](../../releases/latest).
2. In Zotero: **Tools → Add-ons → ⚙ → Install Add-on From File…**
3. Pick the `.xpi`. Bootstrapped extensions hot-reload — **no restart needed**
   in most cases; if the endpoints don't answer, restart Zotero.

Zotero writes a freshly generated token to `<data-dir>/zoterojs-token.txt`.
The client finds it automatically.

## Usage

```bash
python zoterojs.py ping                            # health check, no token needed
python zoterojs.py exec "return Zotero.version"
python zoterojs.py merge MASTERKEY DUPKEY --dry-run
```

```python
import zoterojs as zjs

zjs.execv("return Zotero.Items.get(1).getField('title')")
zjs.merge("ABCD1234", ["EFGH5678"])                 # real merge
zjs.merge("IJKL9012", ["MNOP3456"], dry_run=True)   # self-check only
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

All four ride on Zotero's own server — nothing new is bound, and no socket is
held open, so Zotero still exits cleanly.

Requests whose `User-Agent` starts with `Mozilla/`, or that carry an `Origin`
header, are dropped by Zotero's own CSRF guard before they reach the plugin.
Command-line clients are unaffected; browser-side callers need
`x-zotero-connector-api-version`, as with any Zotero plugin endpoint.

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

Mitigations that are present: token required on `exec`, `merge`, and `logs`;
constant-time comparison against the stored token; a 1.5 MB response cap; and
endpoint cleanup on `shutdown()`.

> The constant-time comparison is real as of v1.0.6, but it was *claimed* from
> v1.0.0 while the code did a plain `!==` the whole time. If you audited an
> earlier version against this README, the README was wrong, not your audit.

If that trade is wrong for you, don't install it — or set
`extensions.zotero.jsbridge.enabled` to `false` to disable the endpoints while
leaving the plugin installed.

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

## Development

```bash
node test_bridge.js              # 56 tests against stubbed Zotero globals
python make_icon.py --preview    # icon variants sheet, writes nothing
python build.py                  # package the xpi
python build.py --bump           # bump patch version first
python build.py --install        # build, then install into a running Zotero
```

Tests need no Zotero install — they load the real `bootstrap.js` into a Node
`vm` context with stubbed globals, then drive the endpoint constructors
directly. Among other things they assert that every icon the manifest declares
is actually present and is a PNG of the declared pixel size.

Bump the version on every build; Zotero ignores a reinstall with an unchanged
version. `build.py` fails loudly if a manifest-declared icon didn't make it
into the archive — the failure mode it was written to prevent.

## 中文说明

在**正在运行的 Zotero 进程内**执行 JavaScript。

Zotero 的插件 API 没有进程外通道。凡是连接器 API 覆盖不到的——合并重复条目、
搬移附件、批量改字段、调用内部模块——只能从 Zotero 进程内做。常规做法是打开
**工具 → 开发者 → Run JavaScript**，每次手动贴代码。

这个插件在 Zotero 本来就在跑的本地服务器（`127.0.0.1:23119`）上挂了四个 HTTP
端点，让脚本可以代劳。**不另开端口、不持有 socket**，所以不影响 Zotero 退出。

> **安全提醒**：这些端点能在 Zotero 里执行**任意 JS**，可读写你整个库。
> 任何能读到 token 文件的进程都能删掉你的库。这是个人自动化工具，不是加固过的
> 服务——装之前请先读英文部分的 [Security model](#security-model)。

安装：从 [Releases](../../releases/latest) 下载 `.xpi`，**工具 → 插件 → ⚙ →
Install Add-on From File…**。装入后 token 会自动写到 `<数据目录>/zoterojs-token.txt`，
客户端自己会找。

```bash
python zoterojs.py ping
python zoterojs.py exec "return (await Zotero.Items.getAll(1, true)).length"
python zoterojs.py merge 主条目KEY 重复KEY --dry-run
python zoterojs.py logs --min-level warning
```

**最容易踩的坑**：Zotero 10 里 `Zotero.Items.getAll` / `getDeleted` / `getAsync`
都是 **async** 的，`get` / `getByLibraryAndKey` 是同步的。忘了 `await` 不会报错，
只会静默返回 `{}` 或 `undefined`——序列化器现在会把这种情况显式标出来。

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

## License

[MIT](LICENSE)
