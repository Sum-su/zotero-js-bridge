"""变异验证：把每处修复改回坏的样子，看测试会不会红。

全绿只能说明测试跑完了。这个脚本回答的是另一个问题：测试到底盯着什么。
用法： python mutate.py   （跑完自动还原被改的那个文件）

被改的不一定是插件：**从真机抄进 stub 的每条守卫，也要有一条变异把它改回去**，
否则那条守卫就只是一句注释，测试并不认它。所以有五条的靶子是 test_bridge.js。

⚠️ 变异是**照着代码原文**锚定的，改了被测代码就可能锚不上。锚不上会明确报
「找不到锚点，跳过」而不是当成通过 —— 那是在提醒你回来同步这一页。
跳过也**算失败**（退出码非 0）：锚点对不上，就说明那条守卫已经没人盯着了，
静默放过才是这里最该防的事。
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
SRC = ROOT / "addon" / "bootstrap.js"
ORIG = SRC.read_text(encoding="utf-8")

# (说明, 原样, 改成[, 文件])
# 第 4 项省略时改 addon/bootstrap.js；stub 自己的守卫要改 test_bridge.js。
MUTANTS = [
    ("apply 不再检测集合丢失",
     "      if (lost.length) {",
     "      if (false) {"),
    ("Collection 对象退回读 .collectionID（真机上永远是 undefined）",
     "  const cid = c.id;",
     "  const cid = c.collectionID;"),
    ("SQL 守卫改成「传了 params 才拦」——注释里那个被证伪的旧说法",
     "  if (/\\bLIKE\\b\\s(?![@:?])/i.test(s)) {",
     "  if (args !== undefined && /\\bLIKE\\b\\s(?![@:?])/i.test(s)) {",
     "test_bridge.js"),
    ("自动备份失败不再中止写操作",
     '    throw new Error(`自动备份失败（${tag}），本次写操作已中止：` + String(e.message || e) +',
     '    logErr(e); return null; void (String(e.message || e) +'),
    ("LIKE 改回字面量（真机上会被 Zotero 的 SQL 守卫抛错）",
     'AND ia.path LIKE ?`, [attType, "storage:%"]);',
     "AND ia.path LIKE 'storage:%'`, [attType]);"),
    ("GET 参数不再解 JSON",
     "  if (s[0] !== \"[\" && s[0] !== \"{\") return v;\n  try { return JSON.parse(s); } catch (e) { return v; }",
     "  return v;"),
    ("备份撞名直接覆盖，不再找空位",
     '    const name = `zotero-${stamp}${i === 1 ? "" : "-" + i}.sqlite`;',
     '    const name = `zotero-${stamp}.sqlite`; if (i > 1) continue;'),
    ("doctor 默认连 sync 一起跑（等于点一下体检就往外发请求）",
     'const DOCTOR_DEFAULT = DOCTOR_CHECKS.filter(c => c !== "sync");',
     "const DOCTOR_DEFAULT = DOCTOR_CHECKS.slice();"),
    ("轮转改成从不删（备份只涨不减）",
     "  const dead = all.slice(0, Math.max(0, all.length - keep));",
     "  const dead = [];"),
    ("query 不校验条件名，直接透传",
     "    const ops = conditionOps(field);\n    if (!ops) { bad.push(`未知条件 ${field}`); return; }",
     "    const ops = conditionOps(field) || [];"),
    ("apply 的 dry-run 也真写",
     "      if (dryRun) {",
     "      if (false) {"),
    ("expect 不符时照改不误",
     "        if (bad.length) {\n          report.push(Object.assign(rec, {",
     "        if (false) {\n          report.push(Object.assign(rec, {"),
    ("attachmentTitle 退回只剥文件名那一边的扩展名",
     "    if (t !== strip(file) && t !== strip(base)) mismatch.push({ key: r.key, title, file });",
     "    if (t !== strip(base)) mismatch.push({ key: r.key, title, file });"),
    ("回收站空着也照讲「别清空回收站」",
     "  if (!total) {",
     "  if (false) {"),
    ("JS 改用 pref 全长（面板才用全长，JS 用短名）",
     'const PREF_READONLY = "jsbridge.readonly";',
     'const PREF_READONLY = "extensions.zotero.jsbridge.readonly";'),
    ("pref 名字打错一个字（读不到就静默回落默认值）",
     'const PREF_ENABLED = "jsbridge.enabled";',
     'const PREF_ENABLED = "jsbridge.enable";'),
    # --- 下面三条改的是 stub 自己：把从真机抄来的行为改回错的/去掉 ---
    ("stub 的 setType 改回「顺手清空集合」（那个被实测证伪的假设）",
     "    this.itemTypeID = tid; this.itemType = TYPE_NAME[tid] || \"journalArticle\";",
     "    this.itemTypeID = tid; this.itemType = TYPE_NAME[tid] || \"journalArticle\";\n    this.collections = [];",
     "test_bridge.js"),
    ("stub 不再模拟「挂父级摘集合」——差分就永远报不出丢失",
     "      this.collections = [];   // 触发器",
     "      void 0;   // 触发器",
     "test_bridge.js"),
    ("stub 去掉「只有 note/attachment/annotation 能挂父级」这条真机校验",
     "    if (v && !CHILD_TYPES.has(this.itemType)) {",
     "    if (false) {",
     "test_bridge.js"),
    ("差分不再盯着父条目（挂父级会把集合塞给它）",
     "      if (op.parent) {",
     "      if (false) {"),
    ("演练不再预告父条目会拿到哪些集合",
     "          extra.wouldGiveParent = before;",
     "          extra.wouldGiveParent = [];"),
    ("stub 不再模拟「挂父级把集合转给父条目」",
     "        for (const cid of (this.collections || [])) {",
     "        for (const cid of ([])) {",
     "test_bridge.js"),
]


def run(name, old, new, rel="addon/bootstrap.js"):
    path = ROOT / rel
    orig = path.read_text(encoding="utf-8")
    if old not in orig:
        print(f"  ?  {name}: 找不到锚点，跳过（说明代码已经和这里写的不一样了）")
        return None
    path.write_text(orig.replace(old, new, 1), encoding="utf-8")
    try:
        p = subprocess.run(["node", "test_bridge.js"], cwd=ROOT,
                           capture_output=True, text=True, encoding="utf-8")
        out = p.stdout or ""
        fails = re.findall(r"^  ✗ (.*)$", out, re.M)
        summary = re.search(r"(\d+) 通过, (\d+) 失败", out)
        if p.returncode == 0:
            print(f"  ✗ {name}: 测试**全绿** —— 这处修复没有任何测试盯着")
            return False
        names = "；".join(f.strip() for f in fails[:3])
        print(f"  ✓ {name} → 转红 {len(fails)} 条：{names}"
              + (f"（共 {len(fails)}）" if len(fails) > 3 else ""))
        if summary:
            print(f"       {summary.group(0)}")
        return True
    finally:
        path.write_text(orig, encoding="utf-8")


def main():
    # Windows 控制台默认 GBK，勾叉和破折号会直接抛 UnicodeEncodeError
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 —— 老 Python 没有 reconfigure，退化成默认行为
        pass
    print("变异验证：把修复改回坏的样子，看测试会不会红\n")
    results = [run(*m) for m in MUTANTS]
    caught = sum(1 for r in results if r is True)
    skipped = sum(1 for r in results if r is None)
    missed = [m[0] for m, r in zip(MUTANTS, results) if r is False]
    print(f"\n{caught}/{len(MUTANTS)} 被测试抓住" + (f"，{skipped} 条跳过" if skipped else ""))
    if skipped:
        print(f"⚠ 有 {skipped} 条的锚点已经找不到 —— 那条守卫现在**没人盯着**了。"
              "跳过不算通过：锚点是照着代码原文写的，对不上就说明这一页该回来同步了。")
    if missed:
        print("没被抓住的：")
        for m in missed:
            print("  -", m)
    return 1 if (missed or skipped) else 0


if __name__ == "__main__":
    sys.exit(main())
