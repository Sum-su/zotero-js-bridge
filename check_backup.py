"""备份文件是不是真能当库用：只读打开 + 完整性 + 拆几张表看一眼。

「备份生成了」和「备份能用」是两件事 —— 文件大小对得上、看不出坏，
不代表它能打开、能查、里面有你以为的那些行。

    python check_backup.py                 # 默认看 <数据目录>/jsbridge-backups/
    python check_backup.py D:\\别处\\备份     # 也可以直接给目录或单个 .sqlite

不改动任何文件：一律 `mode=ro` 打开。
"""
import sqlite3
import sys
import glob
import os

# import zoterojs 会在同目录留一个 __pycache__/。仓库的 .gitignore 挡得住它，
# 但快照目录（复制出来的那份 src/）不是 git 检出的，挡不住——那里不该出现生成物。
sys.dont_write_bytecode = True

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # 老 Python 没有 reconfigure，退化成默认行为
    pass

BACKUP_SUBDIR = "jsbridge-backups"
# 这几张表跨版本一直在。列出来是为了让「备份里到底有什么」一眼可见。
TABLES = ("items", "collections", "collectionItems", "deletedItems", "itemData")


def _data_dirs():
    """Zotero 数据目录的候选顺序——**直接用 zoterojs.py 那一套，不另抄一份**。

    抄一份的下场是两边慢慢漂开：这里认 `E:\\Zotero`，那边早就改成扫遍 C~J 盘了，
    而症状是「脚本说没找到备份」这种看着像备份坏了的话。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    from zoterojs import _candidate_dirs  # noqa: PLC0415 —— 放在函数里，缺文件时只影响"默认找"
    return _candidate_dirs()


def find(pattern=None):
    if pattern:
        if os.path.isdir(pattern):
            return sorted(glob.glob(os.path.join(pattern, "*.sqlite")))
        return [pattern] if os.path.exists(pattern) else []
    for d in _data_dirs():
        hits = sorted(glob.glob(os.path.join(d, BACKUP_SUBDIR, "*.sqlite")))
        if hits:
            return hits
    return []


def check(path):
    size_mb = os.path.getsize(path) / 1048576
    print(f"\n=== {os.path.basename(path)}  {size_mb:.1f} MB ===")
    try:
        # mode=ro：这个脚本永远不该写进备份。uri 形式是 sqlite3 指定的只读开关。
        c = sqlite3.connect("file:" + path.replace("\\", "/") + "?mode=ro", uri=True)
    except sqlite3.Error as e:
        print(f"  ✗ 打不开：{e}")
        return False
    try:
        # 完整性检查慢（要扫全库），但这是「能不能信这份备份」唯一硬证据。
        print("  integrity_check:", c.execute("PRAGMA integrity_check").fetchone()[0])
        for t in TABLES:
            try:
                n = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                print(f"  {t:<16} {n}")
            except sqlite3.Error as e:
                print(f"  {t:<16} 读不到：{e}")
        return True
    finally:
        c.close()


def main():
    try:
        files = find(sys.argv[1] if len(sys.argv) > 1 else None)
    except ImportError:
        print("找不到同目录的 zoterojs.py，没法自动定位数据目录。")
        print("直接告诉它备份在哪：")
        print("  python check_backup.py E:\\Zotero\\jsbridge-backups")
        return 1
    if not files:
        print("没找到备份文件。给个目录或 .sqlite 路径试试：")
        print("  python check_backup.py E:\\Zotero\\jsbridge-backups")
        return 1
    ok = sum(1 for p in files if check(p))
    print(f"\n{ok}/{len(files)} 份通过完整性检查")
    # 验证通过 ≠ 恢复流程演练过。真出事时是手工把文件换回去，那条路没走过。
    print("（验证通过只说明文件能用；恢复流程是否走得通，得另外演练。）")
    return 0 if ok == len(files) else 1


if __name__ == "__main__":
    sys.exit(main())
