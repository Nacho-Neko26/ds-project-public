#!/usr/bin/env python3
import sqlite3, sys, os

dbs = [
    "/root/.dsh-meow/memory.db",
    "/root/qq-agent/workspace/.dsh-meow/memory.db",
    "/root/qq-agent/.dsh-meow/memory.db",
]
levels = ["soul", "user", "project", "fact", "lesson", "topic", "rules"]

for db in dbs:
    print("---", db, "---")
    if not os.path.exists(db):
        print("  (不存在)")
        continue
    try:
        c = sqlite3.connect(db)
        for t in levels:
            try:
                n = c.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                print(f"  {t}: {n}")
            except Exception as e:
                print(f"  {t}: err {e}")
        # windows 表
        try:
            n = c.execute("SELECT COUNT(*) FROM windows").fetchone()[0]
            print(f"  windows: {n}")
        except Exception as e:
            print(f"  windows: err {e}")
        # 文件大小
        sz = os.path.getsize(db)
        print(f"  size: {sz} bytes")
        c.close()
    except Exception as e:
        print("  connect err", e)
