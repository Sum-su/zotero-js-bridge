#!/usr/bin/env python3
"""Zotero JS Bridge 客户端。

前提：Zotero 正在运行，且装了 zotero-js-bridge 插件（端点挂在 23119）。

    import zoterojs as zjs
    zjs.ping()
    zjs.exec("return Zotero.Items.get(1).getField('title')")
    zjs.query(title="岩石", limit=20)          # 只读，返回的 key 可喂给 merge / apply
    zjs.doctor()                                # 一键库体检，全部只读
    zjs.merge("ABCD1234", ["EFGH5678"], dry_run=True)
    zjs.apply([{"item": "ABCD1234", "set": {"date": "2021"}}])   # 默认只演练
    zjs.backup()

命令行：
    python zoterojs.py ping
    python zoterojs.py exec "return Zotero.Libraries.userLibraryID"
    python zoterojs.py merge MASTERKEY DUPKEY [DUPKEY ...] [--dry-run]
    python zoterojs.py logs [--source console|debug|both] [--min-level warn]
                            [--limit N] [--grep TEXT] [--category TEXT]
                            [--since EPOCH_MS] [--clear]
    python zoterojs.py query [--title T] [--doi D] [--creator C] [--collection KEY]
                             [--tag T] [--item-type TYPE] [--q TEXT] [--unfiled]
                             [--where 'date=isAfter:2020'] [--fields DOI,ISBN]
                             [--limit N] [--no-collections]
    python zoterojs.py doctor [CHECK ...] [--all] [--days N]
    python zoterojs.py apply ops.json [--yes] [--keep-going]
    python zoterojs.py backup
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("ZOTEROJS_BASE", "http://127.0.0.1:23119")
TOKEN_FILE = "zoterojs-token.txt"


def _profile_bases():
    """各平台上 Zotero profile 的根目录。"""
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            yield os.path.join(appdata, "Zotero", "Zotero", "Profiles")
    elif sys.platform == "darwin":
        yield os.path.join(home, "Library", "Application Support", "Zotero",
                           "Profiles")
    else:
        yield os.path.join(home, ".zotero", "zotero")


def _candidate_dirs():
    """Zotero 数据目录可能被放在任何地方，别写死路径。"""
    override = os.environ.get("ZOTERO_DATA_DIR")
    if override:
        yield override
    home = os.path.expanduser("~")
    yield os.path.join(home, "Zotero")
    yield os.path.join(home, "Documents", "Zotero")
    if sys.platform == "win32":
        for letter in "CDEFGHIJK":
            yield f"{letter}:\\Zotero"


def _profile_prefs_files():
    """profile 里的 prefs.js —— token 也存在这，与数据目录位置无关。"""
    for base in _profile_bases():
        if not os.path.isdir(base):
            continue
        try:
            entries = sorted(os.listdir(base))
        except OSError:
            continue
        for d in entries:
            p = os.path.join(base, d, "prefs.js")
            if os.path.exists(p):
                yield p


def token_from_prefs():
    """从 profile 的 prefs.js 里刨 token。是 token 文件的退路（pref 落盘有延迟）。"""
    for p in _profile_prefs_files():
        try:
            with open(p, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if "extensions.zotero.jsbridge.token" in line:
                        m = re.search(
                            r'"extensions\.zotero\.jsbridge\.token"\s*,\s*"([^"]+)"',
                            line)
                        if m:
                            return m.group(1)
        except OSError:
            continue
    return None


# Windows 控制台默认 GBK，中文结果会变成乱码，强制 UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        if (_s.encoding or "").lower().replace("-", "") != "utf8":
            _s.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass


class ZoteroJSError(RuntimeError):
    pass


def token() -> str:
    """环境变量 > 数据目录里的 token 文件 > profile 的 prefs.js。"""
    override = os.environ.get("ZOTEROJS_TOKEN_FILE")
    if override:
        with open(override, "r", encoding="utf-8") as f:
            return f.read().strip()

    for d in _candidate_dirs():
        p = os.path.join(d, TOKEN_FILE)
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                t = f.read().strip()
            if t:
                return t

    t = token_from_prefs()
    if t:
        return t

    raise ZoteroJSError(
        "找不到 token。已经找过：\n  "
        + "\n  ".join(_candidate_dirs())
        + "\n  "
        + "\n  ".join(_profile_prefs_files())
        + "\nZotero 必须至少启动过一次（token 在插件 startup 时写入）。"
        "\n可用 ZOTEROJS_TOKEN_FILE 环境变量直接指定。"
    )


def _http_error(e: "urllib.error.HTTPError") -> ZoteroJSError:
    """把端点的错误响应说成人话。

    503 / 404 / 403 现在多半不是「出错了」，而是**用户自己在面板上关出来的**
    （总开关 / 端点开关 / 只读模式）。响应体里带着 error 和 pref，
    就摘出来给用户看，别丢一坨 JSON 过去。
    """
    raw = e.read().decode("utf-8", "replace")
    try:
        body = json.loads(raw)
    except ValueError:
        return ZoteroJSError(f"HTTP {e.code}: {raw}")
    if not isinstance(body, dict):
        return ZoteroJSError(f"HTTP {e.code}: {raw}")
    msg = body.get("error") or raw
    pref = body.get("pref")
    hint = f"\n（面板：工具 → 首选项 → JS Bridge；相关 pref：{pref}）" if pref else ""
    return ZoteroJSError(f"HTTP {e.code}: {msg}{hint}")


def _post(path: str, payload: dict, auth: bool = True, timeout: int = 300) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    # 注意：UA 若以 Mozilla/ 开头，或带 Origin 头，Zotero 会直接掐断连接
    req.add_header("User-Agent", "zoterojs-python/1.0")
    if auth:
        req.add_header("X-ZoteroJS-Token", token())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise _http_error(e) from None
    except urllib.error.URLError as e:
        raise ZoteroJSError(
            f"连不上 {BASE}{path}：{e.reason}\nZotero 开着吗？插件装了吗？"
        ) from None


def _get(path: str, params: dict = None, timeout: int = 300,
         auth: bool = True) -> dict:
    """GET 带查询串。值里的 dict / list 自动转 JSON ——
    端点那边（readParams 的 decodeParam）会把看着像结构的字符串解回来，
    所以 where=[{...}] 这种参数用 GET 传得进去，不必改成 POST。"""
    q = {}
    for k, v in (params or {}).items():
        if v is None or v == "" or v == []:
            continue
        q[k] = json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v)
    url = BASE + path + ("?" + urllib.parse.urlencode(q) if q else "")
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "zoterojs-python/1.0")
    if auth:
        req.add_header("X-ZoteroJS-Token", token())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise _http_error(e) from None
    except urllib.error.URLError as e:
        raise ZoteroJSError(
            f"连不上 {BASE}{path}：{e.reason}\nZotero 开着吗？插件装了吗？"
        ) from None


def ping() -> dict:
    """健康检查，不需要 token。"""
    req = urllib.request.Request(BASE + "/zoterojs/ping")
    req.add_header("User-Agent", "zoterojs-python/1.0")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise _http_error(e) from None
    except urllib.error.URLError as e:
        raise ZoteroJSError(
            f"连不上 {BASE}/zoterojs/ping：{e.reason}\n"
            "多半是插件还没装 / Zotero 还没重启。"
        ) from None


def exec(code: str, timeout: int = 300) -> dict:
    """在 Zotero 进程里执行 JS。code 里可以 return，可以 await。

    可用变量：Zotero, Services, ChromeUtils, Components, Cu, Ci, Cc,
              PathUtils, IOUtils, OS, log
    """
    res = _post("/zoterojs/exec", {"code": code}, timeout=timeout)
    if not res.get("ok"):
        raise ZoteroJSError(
            f"{res.get('error')}\n{res.get('stack', '')}".strip()
        )
    return res


def execv(code: str, timeout: int = 300):
    """只要返回值。"""
    return exec(code, timeout=timeout).get("result")


def merge(master: str, dups, dry_run: bool = False) -> dict:
    """合并条目。master 保留，dups 进回收站。

    服务端会自检（标题/类型/年份/卷/期/页/DOI/ISBN），任何一项不过就跳过该条。
    Zotero 里 Ctrl+Z 可撤销。
    """
    if isinstance(dups, str):
        dups = [dups]
    return _post("/zoterojs/merge", {"master": master, "dups": list(dups),
                                     "dryRun": dry_run})


def logs(source: str = "console", min_level: str = "all", limit: int = 100,
         grep: str = None, category: str = None, since: int = None,
         clear: bool = False, timeout: int = 60) -> dict:
    """读 Zotero 的错误控制台 / 调试输出。

    source:    console（默认，永远有货）| debug | both
    min_level: all | debug | info | warn | error —— "至少这么严重"
    limit:     最多回多少条（从最新往回取），上限 1000
    clear:     读完清空对应来源，**不可撤销**

    注意 debug 缓冲默认是空的：它只在 extensions.zotero.debug.store 打开时记录，
    而那个 pref 是一次性的，Zotero 启动读完就自己设回 false。
    """
    payload = {"source": source, "minLevel": min_level, "limit": limit,
               "clear": clear}
    if grep:
        payload["grep"] = grep
    if category:
        payload["category"] = category
    if since:
        payload["since"] = since
    return _post("/zoterojs/logs", payload, timeout=timeout)


def query(title: str = None, doi: str = None, isbn: str = None, creator: str = None,
          collection: str = None, tag: str = None, item_type: str = None,
          key: str = None, q: str = None, unfiled: bool = False,
          where=None, fields=None, limit: int = 50,
          include_collections: bool = True, timeout: int = 120) -> dict:
    """结构化只读查询。**返回的 items[].key 可以直接喂给 merge / apply。**

    参数是简写，服务端会翻成 Zotero 自己的搜索条件（所以不用写 SQL，
    也就碰不到 LIKE 必须带绑定、字符串里的字面问号、全角字符这类坑）。

    title / doi / isbn / creator / collection / tag / item_type / key / q
        q 是「标题+作者+年份」，最像人在搜索框里敲的那种
    unfiled=True     只看未分类
    where=[{"field": "date", "op": "isAfter", "value": "2020"}, ...]
        简写不够用时用这个，field / op 必须是 Zotero.SearchConditions 认识的，
        写错了服务端会 400 并把可用的列出来
    fields=["DOI", "publicationTitle"]   额外回哪些字段
    """
    params = {
        "title": title, "doi": doi, "isbn": isbn, "creator": creator,
        "collection": collection, "tag": tag, "itemType": item_type,
        "key": key, "q": q, "unfiled": "true" if unfiled else None,
        "where": where, "fields": fields, "limit": limit,
        "includeCollections": "true" if include_collections else "false",
    }
    return _get("/zoterojs/query", params, timeout=timeout)


DOCTOR_CHECKS = ["orphanStorage", "unfiled", "attachmentTitle",
                 "duplicateFilenames", "duplicates", "trashWriteback", "sync"]


def doctor(checks=None, all_checks: bool = False, days: int = 30,
           timeout: int = 300) -> dict:
    """一键库体检，全部只读。

    checks 里可选的：orphanStorage（孤儿附件目录）/ unfiled（未分类）/
    attachmentTitle（标题停在导入器默认值的附件）/ duplicateFilenames（同一父条目下的
    同名附件）/ duplicates（同 DOI / ISBN）/ trashWriteback（回收站里还在被改写的条目）/
    sync（**要连 zotero.org，默认不跑**，得点名要）

    不传 checks 就跑除 sync 之外的全部 —— 一个「体检」按钮不该悄悄往外发请求。
    """
    params = {"days": days}
    if all_checks:
        params["all"] = "true"
    elif checks:
        params["checks"] = ",".join(checks) if isinstance(checks, (list, tuple)) else str(checks)
    return _get("/zoterojs/doctor", params, timeout=timeout)


def apply(ops, dry_run: bool = True, stop_on_error: bool = True,
          timeout: int = 300) -> dict:
    """批量改元数据。**默认 dry_run=True** —— 先看它打算改什么，再真改。

    ops 是列表，每项形如：

        {"item": "KEY", "set": {"title": "新标题", "date": "2021"}}
        {"item": "KEY", "setCreators": ["张三", "李四"]}
        {"item": "KEY", "setType": "book"}
        {"item": "KEY", "parent": "父条目KEY"}
        {"item": "KEY", "addToCollection": "集合KEY"}
        {"item": "KEY", "removeFromCollection": "集合KEY"}
        {"item": "KEY", "expect": {"title": "它现在应该长的样子"}, "set": {...}}

    字符串形式的创建者按**单字段模式**写（中文名交给 Zotero 自动拆会被按首字硬拆）。
    expect 不符就跳过那一条 —— 宁可不动，也别对着错的条目下手。

    每条改完会报 collectionsBefore / collectionsAfter。**挂父级（把条目变成别人的子条目）
    会静默摘掉该条目的集合归属** —— 集合里不许有子条目。差分里出现 collectionsLost 就是它，
    按提示用 addToCollection 补回去。
    （`setType` **不会**摘集合，别把它算进去：2026-09-12 真机实测 + 读源码都确认了。）

    ⚠️ 挂父级还有**第二重**副作用，落在**父条目**上：Zotero 会把子条目原有的集合归属
    整个转给父条目（item.js:1944-1967），所以父条目会凭空多出几个集合。
    报告里对应 parentItem / parentCollectionsGained，演练时是 wouldGiveParent。
    挂的时候两个条目都要看，只盯着被写的那一个会漏掉一半。
    """
    return _post("/zoterojs/apply",
                 {"ops": list(ops), "dryRun": dry_run, "stopOnError": stop_on_error},
                 timeout=timeout)


def backup(timeout: int = 600) -> dict:
    """立刻备份整个库（VACUUM INTO，写一份干净的单文件副本，不动正在用的库）。

    落到数据目录的 jsbridge-backups/，文件名带时间戳，按 jsbridge.backup.keep
    轮转（默认留 5 份）。面板上「立即备份」按钮走的是同一段代码。
    """
    r = execv("return await Zotero.JSBridge.backupNow();", timeout=timeout)
    if not isinstance(r, dict):
        raise ZoteroJSError(f"备份返回了意料之外的东西：{r!r}")
    if not r.get("ok"):
        raise ZoteroJSError(f"备份失败：{r.get('error')}\n（目标目录 {r.get('dir')}）")
    return r


def _split(v: str):
    return [s.strip() for s in str(v).split(",") if s.strip()]


def _json_arg(v: str):
    """`--where '[{"field":"date","op":"isAfter","value":"2020"}]'`。
    也收只有一项时的简写：`--where date=isAfter:2020`。"""
    s = str(v).strip()
    if s.startswith("[") or s.startswith("{"):
        try:
            val = json.loads(s)
            return val if isinstance(val, list) else [val]
        except ValueError as e:
            raise SystemExit(f"--where 不是合法 JSON：{e}")
    out = []
    for part in s.split(","):
        if "=" not in part or ":" not in part:
            raise SystemExit(f"--where 看不懂 {part!r}；要么给 JSON，要么写 field=op:value")
        field, rest = part.split("=", 1)
        op, value = rest.split(":", 1)
        out.append({"field": field.strip(), "op": op.strip(), "value": value.strip()})
    return out


def _parse_flags(args, value_flags, bool_flags):
    """命令行小工具。返回 (kwargs, 错误信息)。不认识的长参数一律报错 ——
    静默忽略一个拼错的 --limt 会让用户以为限制生效了。"""
    kw, i = {}, 0
    while i < len(args):
        a = args[i]
        if a in bool_flags:
            k, v = bool_flags[a]
            kw[k] = v
            i += 1
            continue
        if a in value_flags:
            if i + 1 >= len(args):
                return {}, f"{a} 后面要给个值"
            k, cast = value_flags[a]
            try:
                kw[k] = cast(args[i + 1])
            except (ValueError, SystemExit) as e:
                return {}, f"{a} 的值不对：{e}"
            i += 2
            continue
        return {}, f"未知参数: {a}"
    return kw, None


def _main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd = argv[1]
    if cmd == "ping":
        print(json.dumps(ping(), ensure_ascii=False, indent=2))
    elif cmd == "exec":
        if len(argv) < 3:
            print('用法: python zoterojs.py exec "<js>"', file=sys.stderr)
            return 1
        res = exec(argv[2])
        if res.get("logs"):
            for line in res["logs"]:
                print("[log]", line, file=sys.stderr)
        print(json.dumps(res.get("result"), ensure_ascii=False, indent=2))
    elif cmd == "merge":
        args = [a for a in argv[2:] if a != "--dry-run"]
        if len(args) < 2:
            print("用法: python zoterojs.py merge MASTER DUP [DUP...] [--dry-run]",
                  file=sys.stderr)
            return 1
        res = merge(args[0], args[1:], dry_run="--dry-run" in argv)
        print(json.dumps(res, ensure_ascii=False, indent=2))
    elif cmd == "logs":
        kw = {"source": "console", "min_level": "all", "limit": 100}
        rest = argv[2:]
        i = 0
        while i < len(rest):
            a = rest[i]
            if a in ("--source", "--min-level", "--limit", "--grep",
                     "--category", "--since"):
                if i + 1 >= len(rest):
                    print(f"{a} 后面要给个值", file=sys.stderr)
                    return 1
                key = {"--source": "source", "--min-level": "min_level",
                       "--limit": "limit", "--grep": "grep",
                       "--category": "category", "--since": "since"}[a]
                kw[key] = rest[i + 1]
                i += 2
                continue
            if a == "--clear":
                kw["clear"] = True
                i += 1
                continue
            print(f"未知参数: {a}", file=sys.stderr)
            return 1
        kw["limit"] = int(kw["limit"])
        if "since" in kw:
            kw["since"] = int(kw["since"])
        res = logs(**kw)
        if res.get("cleared"):
            print(f"[已清空: {', '.join(res['cleared'])}]", file=sys.stderr)
        for m in (res.get("console") or {}).get("messages", []):
            # 有 logger 就显示 logger，没有才退回 category —— 两者互斥，Log 消息没有 category
            tag = m.get("logger") or m.get("category") or "-"
            print(f"{m.get('iso', '')}  {(m.get('level') or ''):9} "
                  f"{tag:14} {m.get('message')}")
        c = res.get("console")
        if c:
            tail = f"（共 {c['total']} 条，命中 {c['matched']}，显示 {c['returned']}"
            tail += f"，省略 {c['omitted']}）" if c.get("omitted") else "）"
            print(tail, file=sys.stderr)
        d = res.get("debug")
        if d:
            if d.get("note"):
                print(d["note"], file=sys.stderr)
            elif d.get("text"):
                print(d["text"])
    elif cmd == "query":
        kw, err = _parse_flags(argv[2:], {
            "--title": ("title", str), "--doi": ("doi", str), "--isbn": ("isbn", str),
            "--creator": ("creator", str), "--collection": ("collection", str),
            "--tag": ("tag", str), "--item-type": ("item_type", str),
            "--key": ("key", str), "--q": ("q", str),
            "--limit": ("limit", int), "--fields": ("fields", _split),
            "--where": ("where", _json_arg),
        }, {"--unfiled": ("unfiled", True),
            "--no-collections": ("include_collections", False)})
        if err:
            print(err, file=sys.stderr)
            return 1
        res = query(**kw)
        print(f"命中 {res['total']} 条" + (f"，显示前 {res['returned']} 条" if res.get("omitted") else ""),
              file=sys.stderr)
        for it in res["items"]:
            cols = "、".join(c["name"] for c in (it.get("collections") or []))
            who = "; ".join(it.get("creators") or [])
            print(f"{it['key']}  {(it.get('date') or ''):10} {it['itemType']:14} "
                  f"{(it.get('title') or '')[:60]}")
            if who or cols:
                print(f"{'':10}{who}{'  ← ' + cols if cols else ''}")
    elif cmd == "doctor":
        want = [a for a in argv[2:] if not a.startswith("--")]
        kw = {}
        if want:
            kw["checks"] = want
        if "--all" in argv:
            kw["all_checks"] = True
        if "--days" in argv:
            i = argv.index("--days")
            if i + 1 >= len(argv):
                print("--days 后面要给个值", file=sys.stderr)
                return 1
            kw["days"] = int(argv[i + 1])
        res = doctor(**kw)
        print(f"体检完成 · {res['ms']} ms · 跑了 {', '.join(res['ran'])}", file=sys.stderr)
        if "sync" not in res["ran"]:
            print("（sync 要连 zotero.org，要的话加 --all 或直接写 sync）", file=sys.stderr)
        print(json.dumps(res["checks"], ensure_ascii=False, indent=2))
    elif cmd == "apply":
        # 默认 dry-run，真写必须显式 --yes。批量改元数据不该有一次「手滑就改了」的机会。
        path = argv[2] if len(argv) > 2 and not argv[2].startswith("--") else None
        if not path:
            print("用法: python zoterojs.py apply ops.json [--yes] [--keep-going]\n"
                  "  ops.json 是 apply() 的 ops 列表，照它上面的格式写\n"
                  "  默认只演练，确认无误再加 --yes 真写", file=sys.stderr)
            return 1
        with open(path, encoding="utf-8") as f:
            ops = json.load(f)
        if isinstance(ops, dict):
            ops = ops.get("ops", ops)
        res = apply(ops, dry_run="--yes" not in argv,
                    stop_on_error="--keep-going" not in argv)
        if res.get("backup"):
            print(f"[已自动备份] {res['backup']['path']}", file=sys.stderr)
        for r in res["report"]:
            mark = {"applied": "改", "would-change": "会改", "no-change": "不动",
                    "skipped": "跳过", "error": "出错"}.get(r["status"], r["status"])
            print(f"{mark:4} {r['item']}")
            for c in (r.get("changes") or []):
                print(f"       {c.get('field')}: {c.get('from', '')!r} → {c.get('to', '')!r}")
            if r.get("why"):
                print(f"       ⚠ {r['why']}")
            for cid in (r.get("collectionsLost") or []):
                print(f"       ⚠ 丢了集合 {cid}（挂父级会静默摘掉，用 addToCollection 补回去）")
            # 挂父级的第二重副作用，落在**另一个条目**上 —— 2026-09-12 踩到才知道要让差分盯着它
            if r.get("wouldGiveParent"):
                print(f"       ⚠ 演练：挂上去之后，{r.get('parentItem')} 会拿到集合 "
                      f"{r['wouldGiveParent']}")
            for cid in (r.get("parentCollectionsGained") or []):
                print(f"       ⚠ 父条目 {r.get('parentItem')} 被塞进了集合 {cid}"
                      f"（父子条目原有归属转过去的，用 removeFromCollection 摘掉）")
                print(f"         父条目集合 {r.get('parentCollectionsBefore')} → "
                      f"{r.get('parentCollectionsAfter')}")
        print(f"\n改 {res['applied']} · 跳过 {res['skipped']} · 出错 {res['errors']}"
              + ("（演练，未写入；确认后加 --yes）" if res["dryRun"] else ""), file=sys.stderr)
        if res.get("warning"):
            print(res["warning"], file=sys.stderr)
    elif cmd == "backup":
        res = backup()
        print(f"已备份 {(res['bytes'] / 1048576):.1f} MB · {res['ms']} ms")
        print(res["path"])
        removed = res.get("removed") or []
        # remaining 是轮转后的数，到上限时恒等于 kept —— 报轮转前有几份才有信息量。
        if removed:
            print(f"保留最近 {res['kept']} 份，这次删掉 {len(removed)} 份旧的"
                  f"（备份前有 {res['kept'] + len(removed)} 份）", file=sys.stderr)
            for n in removed:
                print(f"[轮转删除] {n}", file=sys.stderr)
        else:
            print(f"保留最近 {res['kept']} 份，目录里现在 {res['remaining']} 份", file=sys.stderr)
    else:
        print(f"未知命令: {cmd}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    # ZoteroJSError 是我们自己抛的、给用户看的话（token 找不到、端点在面板里被关了……），
    # 直接打出来就行，不需要一串 traceback。其它异常照旧往上抛，免得把真 bug 藏起来。
    try:
        sys.exit(_main(sys.argv))
    except ZoteroJSError as e:
        print(f"错误：{e}", file=sys.stderr)
        sys.exit(2)
