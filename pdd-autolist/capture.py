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


def save_step(page, step: Path):
    """发布页常常开在新标签页，传进来的是最后一个标签页"""
    step.mkdir(exist_ok=True)
    (step / "网址.txt").write_text(page.url, encoding="utf-8")
    (step / "网页.html").write_text(page.content(), encoding="utf-8")
    # SKU 多的时候页面很长，整页截图会超时；截图失败不影响网页和元素列表
    try:
        page.screenshot(path=str(step / "截图.png"), full_page=True, timeout=15000)
    except Exception:
        try:
            page.screenshot(path=str(step / "截图.png"), timeout=10000)
            print("页面太长，只截了屏幕上能看到的部分")
        except Exception:
            print("截图没截上，网页和元素照样存（需要的话自己按 Win+Shift+S 截一张）")
    elements = {}
    for i, frame in enumerate(page.frames):
        try:
            elements[f"{i}:{frame.url}"] = frame.evaluate(ELEMENTS_JS)
        except Exception as e:
            elements[f"{i}:{frame.url}"] = f"读取失败：{e}"
    (step / "元素.json").write_text(json.dumps(elements, ensure_ascii=False, indent=1), encoding="utf-8")


def main():
    shop = sys.argv[1] if len(sys.argv) > 1 else "店铺1"
    out = HERE / "页面采集" / shop / time.strftime("%m%d_%H%M")
    out.mkdir(parents=True, exist_ok=True)
    net_file = (out / "提交请求.jsonl").open("a", encoding="utf-8")

    def on_request(req):
        if req.method == "GET" or "pinduoduo.com" not in req.url:
            return
        try:
            # 上传图片之类的请求内容不是文字，用 post_data 会报错，这里按字节读再尽量转成文字
            body = (req.post_data_buffer or b"")[:200_000].decode("utf-8", errors="replace")
        except Exception as e:
            body = f"读取失败：{e}"
        net_file.write(json.dumps({
            "time": time.strftime("%H:%M:%S"), "method": req.method, "url": req.url, "body": body,
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
        print("【这个黑窗口不要关！关了就停止采集了】")
        print("输入 q 回车结束。保存位置：", out)
        n = 0
        while True:
            if not browser.is_connected():
                print("浏览器已经关了")
                break
            # 登录、跳转时拼多多会关掉旧标签页再开新的，所以每次都重新找，找的过程中页面没了也不算错
            open_pages = [p for p in ctx.pages if not p.is_closed()]
            try:
                line = lines.get_nowait().strip()
            except queue.Empty:
                try:
                    open_pages[-1].wait_for_timeout(300)   # 让浏览器事件继续跑，提交请求才能记下来
                except Exception:
                    time.sleep(0.3)
                continue
            if line.lower() == "q":
                break
            if not open_pages:
                print("现在没有打开的页面，等页面出来再回车一次")
                continue
            n += 1
            try:
                save_step(open_pages[-1], out / f"{n:02d}_{re.sub(r'[\\/:*?\"<>|]', '_', line) or '未命名'}")
                print(f"已保存第 {n} 步：{line or '未命名'}")
            except Exception as e:
                print(f"第 {n} 步没存上（{e.__class__.__name__}），等页面加载完再输入一次")
                n -= 1

        close_edge(browser, edge)
    net_file.close()
    print("采集结束，把这个文件夹打包发回来：", out)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # 双击运行时出错窗口会直接关掉，看不到原因；这里留住窗口，并写进日志
        import traceback
        err = traceback.format_exc()
        print("\n出错了：\n" + err)
        (HERE / "运行日志.txt").write_text(err, encoding="utf-8")
        print("截图发给开发者。窗口 10 分钟后自动关闭，也可以直接点右上角关掉。")
        time.sleep(600)    # 不用 input()：读输入的线程还在等回车，会抢
