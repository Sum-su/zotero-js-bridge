#!/usr/bin/env python3
"""Zotero JS Bridge 客户端。

前提：Zotero 正在运行，且装了 zotero-js-bridge 插件（端点挂在 23119）。

    import zoterojs as zjs
    zjs.ping()
    zjs.exec("return Zotero.Items.get(1).getField('title')")
    zjs.merge("ABCD1234", ["EFGH5678"], dry_run=True)

命令行：
    python zoterojs.py ping
    python zoterojs.py exec "return Zotero.Libraries.userLibraryID"
    python zoterojs.py merge MASTERKEY DUPKEY [DUPKEY ...] [--dry-run]
    python zoterojs.py logs [--source console|debug|both] [--min-level warn]
                            [--limit N] [--grep TEXT] [--category TEXT]
                            [--since EPOCH_MS] [--clear]
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
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
