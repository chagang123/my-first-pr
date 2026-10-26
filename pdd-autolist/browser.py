"""打开一个普通的 Edge，再连上去控制

不用 Playwright 自己启动浏览器：那样启动的浏览器带自动化标记，拼多多一打开就弹滑块。
这里像人双击一样启动 Edge（只多开一个调试端口），网页看到的就是普通浏览器。
"""
import os
import socket
import subprocess
import time
from pathlib import Path

EDGE_PATHS = [
    Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe",
    Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Microsoft/Edge/Application/msedge.exe",
    Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Edge/Application/msedge.exe",
]


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def close_edge(browser, proc):
    """让 Edge 自己正常退出（会保存登录状态）；没反应再强制结束整棵进程"""
    try:
        browser.new_browser_cdp_session().send("Browser.close")
        proc.wait(timeout=10)
    except Exception:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


def open_edge(pw, profile: Path, url: str):
    """返回 (浏览器, 浏览器上下文, Edge 进程)。profile 是这个店铺自己的登录数据文件夹"""
    edge = next((p for p in EDGE_PATHS if p.exists()), None)
    if edge is None:
        raise RuntimeError("这台电脑上没找到 Edge 浏览器")
    profile.mkdir(parents=True, exist_ok=True)
    port = _free_port()
    proc = subprocess.Popen([
        str(edge), f"--remote-debugging-port={port}", f"--user-data-dir={profile}",
        "--no-first-run", "--no-default-browser-check", "--start-maximized", url,
    ])
    for _ in range(40):
        try:
            browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
            return browser, browser.contexts[0], proc
        except Exception:
            time.sleep(0.5)
    proc.terminate()
    raise RuntimeError("Edge 打开了但连不上，把已经开着的 Edge 窗口都关掉再试")
