#!/usr/bin/env python3
"""把 README 与 docs/ 拼成 llms-full.txt —— 给语言模型一次读完的单文件版本。

为什么要有一份拼好的：模型读仓库时通常一次只抓一个文件，既慢又容易漏掉交叉引用；
而 llms.txt（人写的索引）只说明「哪个文件讲什么」，不含正文。
两者分工：llms.txt 是索引，llms-full.txt 是全文，后者由这个脚本生成、不许手改。

输出必须是**确定的**：不写时间戳、不写行数、不写机器信息 —— 否则 CI 里那条
「重新生成后 git diff 必须为空」永远会红，而一条永远会红的检查等于没有检查。

用法：
    python build_llms.py            # 重新生成 llms-full.txt
    python build_llms.py --check    # 只检查是否已是最新（CI 用，不写文件）
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "llms-full.txt")

REPO = "Sum-su/zotero-js-bridge"
BRANCH = "main"
RAW = f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/"
SITE = f"https://github.com/{REPO}/"

# README 打头（模型最先要知道这个项目是什么），中文版垫底（同一份内容的另一种语言，
# 放最后就不会抢在英文正文前面），中间是 docs/ 下按文件名排序的全部文档。
HEAD = ["README.md"]
TAIL = ["README.zh-CN.md"]


def docs_files() -> list[str]:
    d = os.path.join(HERE, "docs")
    if not os.path.isdir(d):
        return []
    return [f"docs/{n}" for n in sorted(os.listdir(d)) if n.endswith(".md")]


def abso(target: str, srcdir: str) -> str:
    """把一个可能在正文里失效的相对链接，换成绝对地址。

    llms-full.txt 里没有目录结构，`docs/merge.md` 这种写法对读者（尤其模型）毫无
    指向性；换成 raw 地址后至少能顺着抓下去。锚点保留 —— 虽然 raw 页面不认它，
    但它说明了「要的是那个文件的哪一节」，这个信息本身有用。
    """
    if not target or target.startswith(("#", "http://", "https://", "mailto:")):
        return target
    path, _, frag = target.partition("#")
    if path.startswith("../../"):          # 站点根下的路径，如 ../../releases/latest
        return SITE + path[6:] + (("#" + frag) if frag else "")
    resolved = os.path.normpath(os.path.join(srcdir, path)).replace(os.sep, "/")
    if not os.path.exists(os.path.join(HERE, resolved)):
        return target                       # 指不到实处的就别改，宁可原样留着
    return RAW + resolved + (("#" + frag) if frag else "")


LINK = re.compile(r"\]\(([^)\s]+)\)")


def rewrite(text: str, srcdir: str) -> str:
    return LINK.sub(lambda m: "](" + abso(m.group(1), srcdir) + ")", text)


def build() -> str:
    files = HEAD + docs_files() + TAIL
    parts = [
        "# Zotero JS Bridge — 全文（llms-full.txt）",
        "",
        "本文件由 `build_llms.py` 生成，**不要手改**：改了会在 CI 里被 diff 检查挡下。",
        "手写的索引在 [llms.txt](" + RAW + "llms.txt)，那里说明每个文件分别讲什么。",
        "正文里的相对链接已换成绝对地址，可直接抓取。",
        "",
    ]
    for rel in files:
        p = os.path.join(HERE, rel)
        with open(p, encoding="utf-8", newline="") as f:
            body = f.read().replace("\r\n", "\n").rstrip("\n")
        srcdir = os.path.dirname(rel) or "."
        parts += [
            "",
            "=" * 78,
            f"# 源文件：{rel}",
            f"# {RAW}{rel}",
            "=" * 78,
            "",
            rewrite(body, srcdir),
            "",
        ]
    return "\n".join(parts).rstrip("\n") + "\n"


def main(argv) -> int:
    text = build()
    old = None
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8", newline="") as f:
            old = f.read().replace("\r\n", "\n")
    if "--check" in argv:
        if old == text:
            print("llms-full.txt 已是最新")
            return 0
        print("llms-full.txt 与源文件不一致，跑一下 python build_llms.py 并提交",
              file=sys.stderr)
        return 1
    if old == text:
        print("llms-full.txt 无变化")
        return 0
    # newline="\n"：不让 Windows 把 LF 翻成 CRLF，否则每次生成都是一次无意义的 diff
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"llms-full.txt 已更新（{len(text.splitlines())} 行，{len(text.encode('utf-8'))} 字节）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
