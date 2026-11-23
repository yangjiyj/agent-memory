#!/usr/bin/env python3
"""打印共享记忆的日报或周报（纯文本），交给你的定时任务推到 IM（飞书/钉钉/Slack/Telegram 机器人等）。

  python3 report.py daily     # 过去 24 小时：新增记忆、会话抽取、设备同步状态、拒收的密钥…
  python3 report.py weekly    # 上周：各项目做了什么、干成的事、还悬着的事、停了的项目

需要一个 reporter 角色的令牌（server.mjs add-device my-reporter reporter），放在 ~/.config/agent-memory/reporter.token。
环境变量 AGENT_MEMORY_HUB 指定中心地址（默认 http://localhost:8790）。只用标准库。
"""

import os
import sys
import urllib.request
from pathlib import Path

HUB = os.environ.get("AGENT_MEMORY_HUB", "http://localhost:8790").rstrip("/")
TOKEN = (Path.home() / ".config/agent-memory/reporter.token").read_text().strip()
PATHS = {"daily": "/v1/report?hours=24", "weekly": "/v1/weekly"}


def main():
    kind = sys.argv[1] if len(sys.argv) > 1 else "daily"
    req = urllib.request.Request(HUB + PATHS[kind], headers={"Authorization": f"Bearer {TOKEN}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.read().decode("utf-8").strip())


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"⚠ 共享记忆中心读不到报告：{e}")
        sys.exit(1)
