# Zotero JS Bridge

[English](README.md) | **中文**

在**正在运行的 Zotero 进程内**执行 JavaScript 的插件：把八个本地 HTTP 端点挂在 Zotero 自带的服务器上，让脚本代劳合并条目、查询库、批量改元数据、备份，而不必每次打开 **工具 → 开发者 → Run JavaScript** 手贴代码。

[![release](https://img.shields.io/github/v/release/Sum-su/zotero-js-bridge?label=release)](../../releases/latest)
[![CI](https://github.com/Sum-su/zotero-js-bridge/actions/workflows/test.yml/badge.svg)](../../actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Zotero](https://img.shields.io/badge/Zotero-7%2B-brightgreen.svg)](https://www.zotero.org/)

## 为什么需要它

Zotero 的插件 API **没有进程外通道**。凡是连接器 API 覆盖不到的——合并重复条目、搬移附件、批量改字段、调用内部模块——只能从 Zotero 进程内做。本插件挂在 Zotero 本来就在跑的 `127.0.0.1:23119` 服务器上，在那里注册八个 JSON 端点。**不另开端口、不持有 socket**，所以不影响 Zotero 退出。

> [!WARNING]
> 这些端点能在 Zotero 里执行**任意 JavaScript**，可读写你整个库。任何能读到 token 文件的进程都能删掉你的库。这是个人自动化工具，不是加固过的服务——装之前请先读[安全模型](#安全模型)。

## 环境要求

| | |
| --- | --- |
| Zotero | 7 到 10（`strict_min_version` `6.999`，`strict_max_version` `10.99.99`）；开发与验证均在 **Zotero 10.0.2** 上完成 |
| Python | 3.8+（只为自带的客户端；协议本身是八个 JSON 端点，任何 HTTP 客户端都能用） |

## 安装

1. 从 [Releases](../../releases/latest) 下载 `zotero-js-bridge.xpi`。
2. 在 Zotero 里打开 **工具 → 插件 → ⚙ → Install Add-on From File…**
3. 选中那个 `.xpi`。引导式扩展会热重载，通常不用重启；若端点没响应，重启一次 Zotero。

Zotero 会生成一个新 token 写到 `<数据目录>/zoterojs-token.txt`，客户端自己会找。插件在 **工具 → 首选项 → JS Bridge** 加一个面板，里面有开关、token 操作、**立即备份**按钮和自检。**改动立即生效，不用重启。**

## 快速上手

```bash
python zoterojs.py ping                              # 健康检查，不需要 token
python zoterojs.py exec "return Zotero.Libraries.userLibraryID"
python zoterojs.py query --title 物理化学 --limit 20   # 结构化查询，不用写 SQL
python zoterojs.py doctor                            # 只读库体检
python zoterojs.py merge 主条目KEY 重复KEY --dry-run   # 带自检的合并
python zoterojs.py apply ops.json                    # 不给 --yes 就是演练
python zoterojs.py enrich --scan                     # 哪些 PDF 该送去 OCR/视觉
python zoterojs.py backup                            # VACUUM INTO + 轮转
```

`query` 打印的 `key` 可以直接喂给 `merge` 和 `apply`，整条流水线是**查询 → 演练 → 确认 → 写**，中间不用手工转换。

> [!IMPORTANT]
> **三个写命令的默认值并不一样，而这个差别关系到安全。**
> `apply` 和 `enrich` 的写回不给 `--yes` 就是演练；
> **`merge` 是例外：不给 `--dry-run` 就是真合并。** 它在 Python 客户端里的
> `dry_run` 参数默认同样是 `False`。要演练请显式加上 `--dry-run`。

同一套能力也可以当库用：

```python
import zoterojs as zjs

zjs.ping()
zjs.exec("return Zotero.Items.get(1).getField('title')")
zjs.query(title="岩石", limit=20)                            # 只读
zjs.doctor()                                                 # 只读
zjs.merge("ABCD1234", ["EFGH5678"], dry_run=True)
zjs.apply([{"item": "ABCD1234", "set": {"date": "2021"}}])   # 默认就是演练
zjs.enrich(scan=True)                                        # 只读，找候选
zjs.enrich(findings=[...])                                   # 写回
zjs.backup()
```

完整的命令行参数与 Python 函数签名见 [`docs/endpoints.md`](docs/endpoints.md)。

## 端点

| 路径 | 方法 | 写？ | 用途 |
| --- | --- | :---: | --- |
| `/zoterojs/ping` | GET | | 版本、Zotero 版本、端点清单、开关的实时状态。**唯一免 token 的端点。** |
| `/zoterojs/exec` | POST | ✅ | 执行 JS，支持顶层 `await` 与 `return`。注入 `Zotero`、`Services`、`ChromeUtils`、`Components`、`Cu`、`Ci`、`Cc`、`PathUtils`、`IOUtils`、`OS` 和 `log()`。 |
| `/zoterojs/merge` | POST | ✅ | 八项自检之后合并重复条目。**默认不是演练**——要演练得显式传 `dryRun`。 |
| `/zoterojs/logs` | GET、POST | | 读 Zotero 的错误控制台与调试输出。 |
| `/zoterojs/query` | GET、POST | | 走 Zotero 自己的 `Search` 做结构化只读查询，**不写 SQL**。 |
| `/zoterojs/doctor` | GET、POST | | 只读库体检；**默认不联网**。 |
| `/zoterojs/apply` | POST | ✅ | 批量改元数据，默认演练，自动报集合归属差分。 |
| `/zoterojs/enrich` | GET、POST | ✅ | 把视觉模型从扫描件上读到的补进空字段。**只填空，永不覆盖。** |

`backup` **不是端点**——它是面板上的按钮，外加一个「写操作前自动备份」的开关。

写端点另有一层保护：只读模式让 `exec` / `merge` / `apply` / `enrich` 一律返 `403`，**连演练形式也拒**。参数、响应形状与错误码详见 [`docs/endpoints.md`](docs/endpoints.md)。

`User-Agent` 以 `Mozilla/` 开头、或带 `Origin` 头的请求，会在到达插件之前被 **Zotero 自己的 CSRF 守卫**拦掉。命令行客户端不受影响；从浏览器侧调用需要带上 `x-zotero-connector-api-version`——这一点对所有 Zotero 插件端点都成立。

深入参考：

- [`docs/merge.md`](docs/merge.md) —— 八项自检、值归一化、ISBN 硬防线。
- [`docs/enrich.md`](docs/enrich.md) —— 两种模式、只填空的规矩、三道闸和它们各自对应的那次真实错误。

## 设置

**工具 → 首选项 → JS Bridge。** pref 是在**请求路径上现读**的，所以改完对下一次调用就生效，不用重启，也不用重新注册端点。

| Pref（`extensions.zotero.jsbridge.…`） | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 设 `false` → 八个端点全返 `503` |
| `readonly` | `false` | 设 `true` → `exec` / `merge` / `apply` / `enrich` 返 `403`，读的口子照开 |
| `endpoint.ping` … `endpoint.enrich` | `true` | 设 `false` → 该路径返 `404` |
| `enrich.minChars` | `1000` | 抽出的字符数低于此值，就认为这个 PDF 没有文本层 |
| `limit.responseKB` | `1500` | 响应上限，钳制在 10–20000 |
| `backup.enabled` | `false` | 设 `true` → 每次 `merge` / `apply` / `enrich` 写入前先备份 |
| `backup.keep` | `5` | 保留份数，钳制在 1–200 |

`ping` 会报出开关的实时状态，调用方**可以问，不用猜**：`disabled` 列出当前被关掉的路径，`readonly` 是只读开关的当前值。

面板里还有 token 操作（复制 / 重新生成 / 重写文件）、**立即备份**按钮，以及一个**自检**按钮——报告八个端点是否注册、开关当前是什么、token 文件在不在。自检**故意不联网**：它不会向 `127.0.0.1:23119` 发请求，因为 Zotero 自己的 CSRF 守卫会把它拦掉，那样一旦失败也说明不了任何问题。

## 安全模型

威胁模型是**单用户桌面机**。由此带来的后果应当被明确接受：

- **token 是全权凭证。** 它存在 pref `extensions.zotero.jsbridge.token` 里，并镜像到 `<数据目录>/zoterojs-token.txt`。任何能读到这个文件（或读到你的 pref）的东西，都能在 Zotero 里执行任意代码并毁掉你的库。
- **仅本机可访问，但没有沙箱。** Zotero 只绑 `127.0.0.1`，所以端点从网络不可达；但本机上任何拿到 token 的进程都能调。
- **`exec` 故意不设限。** 它就是 `new AsyncFunction(...)` 套你的代码。这正是它的用途——它不是沙箱，也不假装是。
- **无 TLS。** 流量是 loopback 明文。

现有的缓解：除 `ping` 外都要 token；对存储的 token 做**常数时间比较**；可配置的响应上限；总开关 + 八个端点开关 + 只读模式；`shutdown()` 时清理端点；三个写端点默认演练；写入前自动备份，且**备份失败就中止这次写**。

**这些开关是「限制爆炸半径」，不是「安全边界」。** 它们管的是*你自己*跑的脚本能捅多大娄子——把终端交给一个没那么小心的东西时有用。它们挡不住已经拿到 token 的人：那个人可以把 pref 改回去。

两处需要说准的地方：

- **只读模式是拒绝服务，不是沙箱。** 它**不解析你的代码**。`exec` 能写出多少种副作用，静态判不全，所以它不假装能判，而是把写入口整个关掉（`exec`、`merge`、`apply`、`enrich`，以及 `logs --clear`），读的口子（`ping`、`logs`、`query`、`doctor`）留着。`apply` 和 `enrich` **连演练形式也被拦**：只读的意思是「这个端点不可用」，而不是「你可以排练」。`enrich` 在两verb 上都算写，包括它的候选发现模式——因为 `--scan` 会把几百个 PDF 的全文抽一遍，要跑好几分钟。
- **总开关是在请求路径上拦，不是不注册端点。** 停用之后面板还在，而那正是唯一能把它打开的地方——一个在停用时卸掉自己设置界面的插件，就再也无法从 Zotero 里启用回来了。

重新生成 token 会**立即吊销**旧的：pref 和 `zoterojs-token.txt` 一起重写，仍持旧 token 的客户端开始收到 `403`。

彻底移除：卸载插件，然后删掉 pref `extensions.zotero.jsbridge.token` 和 `zoterojs-token.txt` 文件。

## 已知限制

- **`enrich` 不渲染 PDF，也不调视觉模型。** Zotero 没有暴露无头 PDF 渲染器（`Zotero.PDFRenderer` 不存在，`Zotero.PDFWorker` 也没有 render 方法）。整页转图片要靠外部脚本，调模型同样在外部。端点只做两件本地事：**判断哪些附件需要视觉**，和**把视觉读到的写回去**。
- **变异验证还没有覆盖 `enrich`。** `mutate.py` 里那 22 个变异体都早于这个端点，所以「测试全绿 + 22/22 全抓」并不等于最新代码也被变异验证盖住了。它目前靠重放真实视觉输出来背书。见 [`docs/development.md`](docs/development.md)。
- **`debug` 日志源默认是空的。** 这不是坏了：它只在 `extensions.zotero.debug.store` 打开时才记录，而 Zotero 启动读完就把该 pref 设回 `false`，所以每次重启只能拿到一个会话的输出。`console` 源则永远有货。
- **只读模式对 `exec` 除了「拒绝执行」之外没有任何约束**——理由见上面的安全模型。

## 开发

```bash
node test_bridge.js              # 测试套件，不需要装 Zotero
python mutate.py                 # 把每处修复改回坏的样子，看测试会不会红
python build.py                  # 打出 xpi
python build.py --bump           # 先升版本号
python build.py --install        # 打包后装进正在运行的 Zotero
python check_backup.py [DIR]     # 只读打开每份备份，验完整性
```

测试把真实的 `addon/bootstrap.js` 载入 Node `vm` 上下文（Zotero 全局对象用 stub 替掉），然后直接驱动端点构造函数。CI 会跑测试、变异验证和一次打包检查。

贡献者文档——测试脚手架设计、变异验证的思路、stub 的保真要求、版本约定、发布顺序规则：见 [`docs/development.md`](docs/development.md)。

## 文档索引

| 文件 | 内容 |
| --- | --- |
| [`docs/endpoints.md`](docs/endpoints.md) | 八个端点的完整参考：参数、响应、错误码 |
| [`docs/merge.md`](docs/merge.md) | 合并自检、归一化、ISBN 硬防线 |
| [`docs/enrich.md`](docs/enrich.md) | 扫描件补全：两种模式、三道闸、实测数据 |
| [`docs/zotero-internals.md`](docs/zotero-internals.md) | Zotero / Firefox 平台陷阱，全部实测而非推测 |
| [`docs/development.md`](docs/development.md) | 测试脚手架、变异验证、打包、CI、版本约定 |
| [`llms.txt`](llms.txt) | 给语言模型用的机器可读索引；全文单文件版在 [`llms-full.txt`](llms-full.txt) |
| [README.md](README.md) | English |

## 许可证

[MIT](LICENSE)
