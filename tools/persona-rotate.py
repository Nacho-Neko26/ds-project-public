# -*- coding: utf-8 -*-
"""人格文件轮转：把当前 persona.md 存成 persona.yesterday.md（前一天备份）。

规则（2026-10-25 用户定）：人格只保留两版 ——
  qq-agent/persona/persona.md           今天的，每天更新
  qq-agent/persona/persona.yesterday.md 前一天的备份

用法：每次要改 persona.md 之前先跑一次本脚本。
    python tools/persona-rotate.py
"""
import shutil
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PERSONA = BASE / 'qq-agent/persona/persona.md'
YESTERDAY = BASE / 'qq-agent/persona/persona.yesterday.md'


def main() -> int:
    if not PERSONA.exists():
        print(f'找不到 {PERSONA}')
        return 1
    if YESTERDAY.exists():
        YESTERDAY.unlink()
    shutil.copy2(PERSONA, YESTERDAY)
    print(f'[{datetime.now():%Y-%m-%d %H:%M:%S}] 已备份当前人格 -> {YESTERDAY.name} '
          f'({PERSONA.stat().st_size} 字节)，可以开始改今天的 persona.md 了')
    return 0


if __name__ == '__main__':
    sys.exit(main())
