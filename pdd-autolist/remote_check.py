"""远程连通检查：连上客户电脑的拼多多 Edge，列出打开的页面，存一张当前页面截图。不点、不填任何东西。

用法：python remote_check.py
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from browser import open_remote_edge

sys.stdout.reconfigure(encoding="utf-8")

with sync_playwright() as pw:
    browser, ctx, tunnel = open_remote_edge(pw)
    try:
        print(f"已连上客户的 Edge，{len(ctx.pages)} 个页面：")
        for i, page in enumerate(ctx.pages):
            print(f"  {i + 1}. {page.title()}  {page.url}")
        if ctx.pages:
            out = Path(__file__).parent / "远程截图.png"
            ctx.pages[-1].screenshot(path=out, timeout=30000)
            print(f"截图：{out}")
    finally:
        # 只断开这边的连接，客户的 Edge 不关
        if tunnel:
            tunnel.terminate()
