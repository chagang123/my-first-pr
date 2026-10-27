"""打开一个普通的 Edge，再连上去控制

不用 Playwright 自己启动浏览器：那样启动的浏览器带自动化标记，拼多多一打开就弹滑块。
这里像人双击一样启动 Edge（只多开一个调试端口），网页看到的就是普通浏览器。
"""
import os
import re
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
        if proc:
            proc.wait(timeout=10)
    except Exception:
        if proc:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


def _attach_running(pw, profile: Path):
    """工具关了但 Edge 还开着时，从进程的启动参数里找出它的调试端口，直接连回去，页面上填的东西不会丢"""
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
         "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | ForEach-Object { $_.CommandLine }"],
        capture_output=True,
    ).stdout.decode("utf-8", errors="replace")
    for line in out.splitlines():
        m = re.search(r"--remote-debugging-port=(\d+)", line)
        if not m or "--type=" in line or str(profile).lower() not in line.lower():
            continue
        try:
            browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{m.group(1)}", timeout=3000)
        except Exception:
            continue
        return browser, browser.contexts[0]
    return None


def open_edge(pw, profile: Path, url: str):
    """返回 (浏览器, 浏览器上下文, Edge 进程)。profile 是这个店铺自己的登录数据文件夹。
    连回已经开着的 Edge 时进程是 None"""
    edge = next((p for p in EDGE_PATHS if p.exists()), None)
    if edge is None:
        raise RuntimeError("这台电脑上没找到 Edge 浏览器")
    profile.mkdir(parents=True, exist_ok=True)
    running = _attach_running(pw, profile)
    if running:
        print("已连上之前开着的 Edge，页面都还在")
        return running[0], running[1], None
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


# ---- 远程模式：Edge 开在客户电脑上，程序在这边跑 ----
# 客户双击「打开拼多多Edge.bat」开出调试端口 19222，「启动反代.bat」把它挂到服务器，
# 这边用 ssh -L 拉到本机同一个端口。两头端口必须一样：Edge 返回的连接地址里写死了它自己的端口。
REMOTE_PORT = 19222
SERVER = "root@45.78.71.169"
SERVER_KEY = Path.home() / ".ssh" / "bwg"


def open_tunnel():
    """把服务器上的 19222 拉到本机，返回 ssh 进程；本机已经通了就返回 None"""
    try:
        with socket.create_connection(("127.0.0.1", REMOTE_PORT), timeout=1):
            return None
    except OSError:
        pass
    proc = subprocess.Popen([
        "ssh", "-N", "-i", str(SERVER_KEY), "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30", "-L", f"{REMOTE_PORT}:127.0.0.1:{REMOTE_PORT}", SERVER,
    ])
    for _ in range(30):
        try:
            with socket.create_connection(("127.0.0.1", REMOTE_PORT), timeout=1):
                return proc
        except OSError:
            if proc.poll() is not None:
                break
            time.sleep(0.5)
    proc.terminate()
    raise RuntimeError("连不上服务器，检查 Karing 有没有开")


def open_remote_edge(pw):
    """连客户电脑上开着的 Edge，返回 (浏览器, 浏览器上下文, ssh 进程)。用完别关浏览器，只断开连接"""
    tunnel = open_tunnel()
    try:
        browser = pw.chromium.connect_over_cdp(f"http://127.0.0.1:{REMOTE_PORT}", timeout=20000)
    except Exception:
        if tunnel:
            tunnel.terminate()
        raise RuntimeError("隧道通了但连不上客户的 Edge：让客户开着「启动反代」，再双击「打开拼多多Edge」")
    return browser, browser.contexts[0], tunnel


def file_payload(path):
    """上传框用：远程时文件在这边，Playwright 只会把路径传过去，客户电脑上找不到。
    改成把文件内容直接发过去，用法 page.set_input_files(sel, [file_payload(p) for p in 图片])"""
    import mimetypes
    path = Path(path)
    return {"name": path.name, "mimeType": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "buffer": path.read_bytes()}
