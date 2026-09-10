#!/usr/bin/env python3
"""打包 zotero-js-bridge.xpi。

    python build.py              # 按 manifest 里的版本打包
    python build.py --bump       # 先把 patch 位 +1 再打包
    python build.py --install    # 打完直接让正在运行的 Zotero 装（需要 bridge 已在跑）

别手搓 zip 命令 —— 漏掉 icons/ 会打出一个没图标的包，而且不报错。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "addon")
OUT = os.path.join(HERE, "zotero-js-bridge.xpi")

# 打进包里的东西。icons/ 下只收 favicon*，别把预览图捎进去。
FIXED = ["manifest.json", "bootstrap.js", "prefs.js"]

# Windows 控制台默认 GBK，中文输出会变成乱码，和 zoterojs.py 一样强制 UTF-8
for _s in (sys.stdout, sys.stderr):
    try:
        if (_s.encoding or "").lower().replace("-", "") != "utf8":
            _s.reconfigure(encoding="utf-8")
    except (AttributeError, OSError):
        pass


def collect() -> list[str]:
    names = list(FIXED)
    icon_dir = os.path.join(SRC, "icons")
    if os.path.isdir(icon_dir):
        for f in sorted(os.listdir(icon_dir)):
            if f.startswith("favicon") and f.endswith(".png"):
                names.append(f"icons/{f}")
    return names


def bump() -> str:
    p = os.path.join(SRC, "manifest.json")
    with open(p, "r", encoding="utf-8") as fh:
        raw = fh.read()
    m = re.search(r'"version"\s*:\s*"(\d+)\.(\d+)\.(\d+)"', raw)
    if not m:
        sys.exit("manifest 里找不到 x.y.z 形式的 version")
    new = f"{m.group(1)}.{m.group(2)}.{int(m.group(3)) + 1}"
    with open(p, "w", encoding="utf-8") as fh:
        fh.write(raw[:m.start()] + f'"version": "{new}"' + raw[m.end():])
    return new


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bump", action="store_true")
    ap.add_argument("--install", action="store_true",
                    help="调用正在运行的 bridge 就地安装")
    args = ap.parse_args()

    if args.bump:
        print("版本 →", bump())

    with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as fh:
        man = json.load(fh)

    names = collect()
    missing = [n for n in names if not os.path.exists(os.path.join(SRC, n))]
    if missing:
        sys.exit("缺文件: " + ", ".join(missing))

    # 打了包却没有 manifest 声明的图标 —— 装上去就是个空白图标
    for rel in (man.get("icons") or {}).values():
        if rel not in names:
            sys.exit(f"manifest 声明了 {rel}，但没被打进包")

    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            z.write(os.path.join(SRC, n.replace("/", os.sep)), n)

    print(f"{OUT}  {os.path.getsize(OUT)} bytes  v{man['version']}")
    for n in names:
        print("   ", n)

    if args.install:
        sys.path.insert(0, HERE)
        import zoterojs  # noqa: E402

        code = """
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const f = Zotero.File.pathToFile(%s);
const inst = await AddonManager.getInstallForFile(f);
if (!inst) return { ok: false, why: "getInstallForFile 返回 null" };
if (!inst.install()) return { ok: false, why: "install() 失败", error: inst.error, state: inst.state };
return { ok: true, state: inst.state, error: inst.error, version: inst.addon?.version };
""" % json.dumps(OUT)

        print("\n安装:", zoterojs.execv(code))
        print("重启 Zotero 后生效。")


if __name__ == "__main__":
    main()
