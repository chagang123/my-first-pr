"""开发用：通过隧道把客户 Edge 当前页面存一份（网页、截图、元素列表），录旗舰店发布流程用

客户在他电脑上一步步操作，到一个新步骤就跟我说一声，我这边运行一次：
  python remote_capture.py 旗舰店 选类目
存到 采集结果/<店名>/<月日_时分秒>_<步骤名>/，和 capture.py 存的格式一样。只读不点。
"""
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from browser import open_remote_edge
from capture import ELEMENTS_JS

sys.stdout.reconfigure(encoding="utf-8")
HERE = Path(__file__).resolve().parent


def main():
    shop = sys.argv[1] if len(sys.argv) > 1 else "旗舰店"
    step = re.sub(r'[\\/:*?"<>|]', "_", sys.argv[2] if len(sys.argv) > 2 else "未命名")
    with sync_playwright() as pw:
        browser, ctx, tunnel = open_remote_edge(pw)
        try:
            pages = [p for p in ctx.pages if not p.is_closed() and "pinduoduo.com" in p.url]
            if not pages:
                print("客户的 Edge 里没有拼多多页面")
                return
            # 发布页常开在新标签页里；取客户眼前正在看的那个标签，看不出来就取发布页
            def visible(pg):
                try:
                    return pg.evaluate("document.visibilityState") == "visible"
                except Exception:
                    return False
            shown = [p for p in pages if visible(p)]
            goods = [p for p in pages if "/goods/" in p.url]
            visible_goods = [p for p in goods if p in shown]
            page = (visible_goods or goods or shown or pages)[-1]
            out = HERE / "采集结果" / shop / f"{time.strftime('%m%d_%H%M%S')}_{step}"
            out.mkdir(parents=True, exist_ok=True)
            (out / "网址.txt").write_text(page.url, encoding="utf-8")
            (out / "网页.html").write_text(page.content(), encoding="utf-8")
            try:
                page.screenshot(path=str(out / "截图.png"), full_page=True, timeout=30000)
            except Exception:
                print("整页截图没截上（页面太长或 Edge 被挡住），网页和元素照样存了")
            elements = {}
            for i, frame in enumerate(page.frames):
                try:
                    elements[f"{i}:{frame.url}"] = frame.evaluate(ELEMENTS_JS)
                except Exception as e:
                    elements[f"{i}:{frame.url}"] = f"读取失败：{e}"
            (out / "元素.json").write_text(json.dumps(elements, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"存好了：{out.relative_to(HERE)}  （{page.url}）")
        finally:
            if tunnel:
                tunnel.terminate()


if __name__ == "__main__":
    main()
