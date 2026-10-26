"""页面采集：第一次远程时在客户电脑上用

打开一个 Edge，客户自己登录拼多多商家后台，然后手动走一遍发布商品的流程。
每走到一个新步骤（选完类目、展开 SKU 表格、点了上传图片……），在黑窗口里输入这一步的名字回车，
就把当前页面的网页代码、截图、所有输入框和按钮的信息存下来，带回去写自动上架。
同时记下后台发出去的提交请求（只记地址和提交内容，不记 cookie），方便看清最后提交了什么。

用法：python capture.py [店铺名]     店铺名用来区分登录状态，默认「店铺1」
"""
import json
import queue
import re
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from browser import close_edge, open_edge

# 打包成 exe 后 __file__ 在临时目录里，数据要存到 exe 旁边
HERE = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
START_URL = "https://mms.pinduoduo.com/"

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")

# 列出页面上所有能点、能填的东西，写选择器时照着找
ELEMENTS_JS = r"""
() => {
  const sel = 'input, textarea, select, button, a, [role=button], [role=tab], [role=option], [contenteditable=true], [class*=upload], [class*=Upload]';
  return [...document.querySelectorAll(sel)].map(el => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      name: el.getAttribute('name') || '',
      cls: (el.className && el.className.baseVal === undefined ? el.className : '').slice(0, 150),
      placeholder: el.getAttribute('placeholder') || '',
      aria: el.getAttribute('aria-label') || '',
      dataTestid: el.getAttribute('data-testid') || '',
      text: (el.innerText || el.value || '').trim().slice(0, 60),
      visible: r.width > 0 && r.height > 0,
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    };
  });
}
"""


def main():
    shop = sys.argv[1] if len(sys.argv) > 1 else "店铺1"
    out = HERE / "页面采集" / shop / time.strftime("%m%d_%H%M")
    out.mkdir(parents=True, exist_ok=True)
    net_file = (out / "提交请求.jsonl").open("a", encoding="utf-8")

    def on_request(req):
        if req.method != "GET" and "pinduoduo.com" in req.url:
            net_file.write(json.dumps({
                "time": time.strftime("%H:%M:%S"), "method": req.method, "url": req.url,
                "body": (req.post_data or "")[:200_000],
            }, ensure_ascii=False) + "\n")
            net_file.flush()

    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(line) for line in iter(sys.stdin.readline, "")], daemon=True).start()

    with sync_playwright() as pw:
        browser, ctx, edge = open_edge(pw, HERE / "浏览器数据" / shop, START_URL)
        ctx.on("request", on_request)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        print(f"已打开拼多多商家后台（{shop}）。请先登录，然后点「发布新商品」，一步一步往下走。")
        print("每到一个新步骤：在这里输入这一步叫什么（比如「选类目」「SKU表格」），按回车保存。")
        print("输入 q 回车结束。保存位置：", out)
        n = 0
        while True:
            try:
                line = lines.get_nowait().strip()
            except queue.Empty:
                open_pages = [p for p in ctx.pages if not p.is_closed()]
                if not open_pages:
                    print("浏览器已经关了")
                    break
                open_pages[-1].wait_for_timeout(300)   # 让浏览器事件继续跑，提交请求才能记下来
                continue
            if line.lower() == "q":
                break
            open_pages = [p for p in ctx.pages if not p.is_closed()]
            if not open_pages:
                print("浏览器已经关了")
                break
            page = open_pages[-1]               # 发布页常常开在新标签页，取最后一个
            n += 1
            step = out / f"{n:02d}_{re.sub(r'[\\/:*?\"<>|]', '_', line) or '未命名'}"
            step.mkdir(exist_ok=True)
            (step / "网址.txt").write_text(page.url, encoding="utf-8")
            (step / "网页.html").write_text(page.content(), encoding="utf-8")
            try:
                page.screenshot(path=str(step / "截图.png"), full_page=True)
            except Exception as e:
                print("整页截图失败，只截可见部分：", e)
                page.screenshot(path=str(step / "截图.png"))
            elements = {}
            for i, frame in enumerate(page.frames):
                try:
                    elements[f"{i}:{frame.url}"] = frame.evaluate(ELEMENTS_JS)
                except Exception as e:
                    elements[f"{i}:{frame.url}"] = f"读取失败：{e}"
            (step / "元素.json").write_text(json.dumps(elements, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"已保存第 {n} 步：{line or '未命名'}")

        close_edge(browser, edge)
    net_file.close()
    print("采集结束，把这个文件夹打包发回来：", out)


if __name__ == "__main__":
    main()
