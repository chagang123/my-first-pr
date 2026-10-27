"""拼多多自动上架

双击 exe（或 python main.py）出菜单；也可以用命令行：
  python main.py 检查 [资料文件夹]          读一遍所有商品资料，出「检查报告.xlsx」，不碰拼多多
  python main.py 试填 [资料文件夹] [店铺]    填好一个商品停在页面上，不提交，给人检查
  python main.py 上架 [资料文件夹] [店铺]    正式上架，店铺不写就所有店铺轮着上

资料文件夹默认是程序旁边的「待上架」，里面直接放店透视导出的 zip 或解压后的文件夹。
价格默认用表格里的拼单价/单买价；设置.json 里「价格.来源」改成「公式」，就按公式从原价重新算。
"""
import json
import random
import sys
import time
from pathlib import Path

import openpyxl
from openpyxl.styles import Font

from loader import calc_price, find_products, read_product

# 打包成 exe 后 __file__ 在临时目录里，数据要存到 exe 旁边
HERE = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
RECORD_FILE = HERE / "上架记录.json"
LOG_FILE = HERE / "运行日志.txt"
DEFAULT_SETTINGS = {
    "店铺": [{"名称": "店铺1", "每天最多上架": 20}, {"名称": "店铺2", "每天最多上架": 20}],
    "两个商品之间等几秒": [60, 180],
    "价格": {"来源": "表格", "公式": "(原价+1.6+1)/0.85", "取整到": 0.1, "单买价比拼单价高": 1},
    "标题最长字节": 60,
    "加价超过几倍提醒": 3,
    "类目": "推荐第一个",
    "默认属性": {},
}

sys.stdout.reconfigure(encoding="utf-8")


def load_settings():
    f = HERE / "设置.json"
    if not f.exists():
        f.write_text(json.dumps(DEFAULT_SETTINGS, ensure_ascii=False, indent=2), encoding="utf-8")
    return {**DEFAULT_SETTINGS, **json.loads(f.read_text(encoding="utf-8"))}


SETTINGS = load_settings()


def log(msg):
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(time.strftime("%m-%d ") + line + "\n")
    except OSError:
        pass


def load_record():
    """{店铺名: {资料里的商品ID: {"时间", "拼多多商品ID"}}}，中途断了重开不会重复上"""
    if RECORD_FILE.exists():
        return json.loads(RECORD_FILE.read_text(encoding="utf-8"))
    return {}


def save_record(record):
    RECORD_FILE.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


def today_count(record, shop):
    today = time.strftime("%Y-%m-%d")
    return sum(1 for v in record.get(shop, {}).values() if v["时间"].startswith(today))


def apply_price(p):
    cfg = SETTINGS["价格"]
    if cfg["来源"] != "公式":
        return
    for s in p.skus:
        if s.src_price is not None:
            s.group_price = calc_price(cfg["公式"], s.src_price, cfg["取整到"])
            s.single_price = round(s.group_price + cfg["单买价比拼单价高"], 2)


def check(p):
    """返回 (错误, 提醒)。有错误的商品不上架，提醒的照上但写进报告"""
    errors, warns = [], []
    title_bytes = len(p.title.encode("gbk", errors="replace"))
    if title_bytes > SETTINGS["标题最长字节"]:
        warns.append(f"标题 {len(p.title)} 个字（{title_bytes} 字节），超过设置的 {SETTINGS['标题最长字节']}")
    if not p.main_images:
        errors.append("没有主图")
    if not p.detail_images:
        warns.append("没有详情图")
    if not p.skus:
        errors.append("没有 SKU")
    no_img = [s.name for s in p.skus if s.image is None]
    if no_img:
        warns.append(f"{len(no_img)} 个 SKU 没找到图：{'、'.join(no_img[:5])}{'…' if len(no_img) > 5 else ''}")
    no_price = [s.name for s in p.skus if not s.group_price or not s.single_price]
    if no_price:
        errors.append(f"{len(no_price)} 个 SKU 没有价格（表格要用 Excel 打开保存一次，公式才有结果）")
    bad = [s.name for s in p.skus if s.group_price and s.single_price and s.single_price <= s.group_price]
    if bad:
        errors.append(f"{len(bad)} 个 SKU 单买价不比拼单价高")
    ratios = [s.group_price / s.src_price for s in p.skus if s.group_price and s.src_price]
    if ratios and max(ratios) > SETTINGS["加价超过几倍提醒"]:
        warns.append(f"拼单价最高是原价的 {max(ratios):.1f} 倍，确认一下价格公式")
    if any(s.stock is None for s in p.skus):
        errors.append("有 SKU 没填库存")
    names = [s.name for s in p.skus]
    if len(set(names)) != len(names):
        errors.append("有两个 SKU 名字一样，拼多多不让重复")
    return errors, warns


def read_all(root: Path):
    """读出所有商品，返回 [(商品或None, 文件夹, 错误, 提醒)]"""
    out = []
    for f in find_products(root, HERE / "解压"):
        try:
            p = read_product(f)
            apply_price(p)
        except Exception as e:
            out.append((None, f, [f"读取失败：{e}"], []))
            continue
        out.append((p, f, *check(p)))
    return out


def cmd_check(root: Path):
    items = read_all(root)
    if not items:
        print(f"没找到商品资料：把店透视导出的 zip 放进「{root}」再试")
        return
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "商品"
    ws.append(["商品ID", "标题", "SKU数", "主图", "详情图", "SKU图", "能不能上", "问题"])
    ws2 = wb.create_sheet("SKU明细")
    ws2.append(["商品ID", "SKU", "原价", "拼单价", "单买价", "库存", "规格编码", "SKU图"])
    for p, f, errors, warns in items:
        if p is None:
            ws.append(["", f.name, "", "", "", "", "不能", "\n".join(errors)])
            print("✗", f.name, *errors)
            continue
        ws.append([p.goods_id, p.title, len(p.skus), len(p.main_images), len(p.detail_images),
                   sum(s.image is not None for s in p.skus), "不能" if errors else "能", "\n".join(errors + warns)])
        for s in p.skus:
            ws2.append([p.goods_id, s.name, s.src_price, s.group_price, s.single_price, s.stock, s.code,
                        s.image.name if s.image else "没找到"])
        print("✗" if errors else "✓", p.title, f"{len(p.skus)} 个 SKU", *errors, *warns, sep="  ")
    for sheet in (ws, ws2):
        for c in sheet[1]:
            c.font = Font(bold=True)
    ws.column_dimensions["B"].width = 45
    ws.column_dimensions["H"].width = 60
    ws2.column_dimensions["B"].width = 28
    out = HERE / f"检查报告_{time.strftime('%m%d_%H%M')}.xlsx"
    wb.save(out)
    ok = sum(1 for it in items if it[0] is not None and not it[2])
    print(f"\n共 {len(items)} 个商品，能上 {ok} 个。报告：{out}")


def wait_login(ctx):
    """等到有一个已登录的商家后台页面；扫码登录时拼多多会关掉旧标签页再开新的，所以每次都重新找"""
    asked = False
    while True:
        pages = [p for p in ctx.pages if not p.is_closed()]
        for p in reversed(pages):
            if "mms.pinduoduo.com" in p.url and "/login" not in p.url:
                return p
        if not asked:
            log("请在打开的浏览器里用拼多多商家版 App 扫码登录，登录好会自动继续")
            asked = True
        time.sleep(1)


def cmd_upload(root: Path, shops, do_submit=True):
    from playwright.sync_api import sync_playwright

    from browser import close_edge, open_edge
    from publish import publish

    products = []
    for p, f, errors, warns in read_all(root):
        if p is None or errors:
            log(f"跳过 {p.title if p else f.name}：{'；'.join(errors)}")
            continue
        for w in warns:
            log(f"提醒 {p.title}：{w}")
        products.append(p)
    if not products:
        log(f"没有能上架的商品（先用「检查资料」看看「{root}」里的资料）")
        return

    record = load_record()
    results = []
    gap = SETTINGS["两个商品之间等几秒"]
    with sync_playwright() as pw:
        for shop in shops:
            name = shop["名称"]
            todo = [p for p in products if p.goods_id not in record.get(name, {})]
            if do_submit:
                left = shop["每天最多上架"] - today_count(record, name)
                if left <= 0:
                    log(f"【{name}】今天已经上满 {shop['每天最多上架']} 个，明天再来")
                    continue
                todo = todo[:left]
            else:
                todo = todo[:1]
            if not todo:
                log(f"【{name}】资料里的商品都已经上过了")
                continue
            log(f"【{name}】这次要上 {len(todo)} 个商品")
            browser, ctx, edge = open_edge(pw, HERE / "浏览器数据" / name, "https://mms.pinduoduo.com/home/")
            ctx.on("page", lambda pg: pg.on("dialog", lambda d: d.accept()))   # 离开页面的确认框直接确定
            page = wait_login(ctx)
            page.on("dialog", lambda d: d.accept())
            for i, p in enumerate(todo):
                log(f"【{name}】第 {i + 1}/{len(todo)} 个：{p.title}（{len(p.skus)} 个规格）")
                start = time.time()
                try:
                    category, gid = publish(page, p, SETTINGS, log, do_submit)
                    mins = (time.time() - start) / 60
                    if do_submit:
                        record.setdefault(name, {})[p.goods_id] = {"时间": time.strftime("%Y-%m-%d %H:%M"), "拼多多商品ID": gid}
                        save_record(record)
                        log(f"上架成功，拼多多商品ID {gid}，用了 {mins:.1f} 分钟")
                        results.append([name, p.goods_id, p.title, len(p.skus), category, "成功", gid, ""])
                    else:
                        log(f"已经填好（{mins:.1f} 分钟），没有提交")
                        results.append([name, p.goods_id, p.title, len(p.skus), category, "试填好了", "", ""])
                except Exception as e:
                    msg = str(e).split("\nCall log")[0].strip()
                    shot = HERE / "失败截图" / f"{name}_{p.goods_id}_{time.strftime('%m%d_%H%M%S')}.png"
                    shot.parent.mkdir(exist_ok=True)
                    try:
                        page.screenshot(path=str(shot), full_page=True, timeout=15000)
                    except Exception:
                        shot = None
                    log(f"失败：{msg}" + (f"（截图：{shot.name}）" if shot else ""))
                    results.append([name, p.goods_id, p.title, len(p.skus), "", "失败", "", msg])
                if not do_submit:
                    input("\n检查完浏览器里填的内容后，按回车关闭浏览器（这个商品不会提交）")
                elif i < len(todo) - 1:
                    wait = random.uniform(*gap)
                    log(f"等 {wait:.0f} 秒再上下一个")
                    time.sleep(wait)
            close_edge(browser, edge)

    if results:
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["店铺", "资料商品ID", "标题", "规格数", "类目", "结果", "拼多多商品ID", "失败原因"])
        for r in results:
            ws.append(r)
        for c in ws[1]:
            c.font = Font(bold=True)
        ws.column_dimensions["C"].width = 45
        ws.column_dimensions["E"].width = 30
        ws.column_dimensions["H"].width = 60
        out = HERE / f"上架结果_{time.strftime('%m%d_%H%M')}.xlsx"
        wb.save(out)
        ok = sum(r[5] != "失败" for r in results)
        log(f"完成：成功 {ok} 个，失败 {len(results) - ok} 个。结果表：{out.name}")


def cmd_remote_try(root: Path):
    """开发用：通过隧道连客户电脑上开着的 Edge，试填第一个商品，不提交、不关客户的浏览器"""
    from playwright.sync_api import sync_playwright

    import publish
    from browser import open_remote_edge

    items = [it for it in read_all(root) if it[0] is not None and not it[2]]
    if not items:
        log(f"「{root}」里没有能上的商品")
        return
    p = items[0][0]
    publish.REMOTE = True
    with sync_playwright() as pw:
        browser, ctx, tunnel = open_remote_edge(pw)
        try:
            page = wait_login(ctx)
            page.on("dialog", lambda d: d.accept())
            log(f"远程试填：{p.title}（{len(p.skus)} 个规格）")
            try:
                category, _ = publish.publish(page, p, SETTINGS, log, do_submit=False)
                log(f"填好了，类目 {category}，没有提交，去客户电脑上看")
            except Exception as e:
                log("失败：" + str(e).split("\nCall log")[0].strip())
                shot = HERE / "失败截图" / f"远程_{time.strftime('%m%d_%H%M%S')}.png"
                shot.parent.mkdir(exist_ok=True)
                page.screenshot(path=str(shot), timeout=15000)
                log(f"截图：{shot}")
        finally:
            if tunnel:
                tunnel.terminate()


def pick_shops(arg=None):
    shops = SETTINGS["店铺"]
    if arg:
        found = [s for s in shops if s["名称"] == arg]
        if not found:
            raise SystemExit(f"设置.json 里没有叫「{arg}」的店铺")
        return found
    if len(shops) == 1:
        return shops
    print("\n上哪个店铺？")
    print("  0. 全部店铺（一个店上完再上下一个）")
    for i, s in enumerate(shops, 1):
        print(f"  {i}. {s['名称']}")
    n = input("输入数字回车：").strip()
    return shops if n in ("", "0") else [shops[int(n) - 1]]


def menu():
    root = HERE / "待上架"
    root.mkdir(exist_ok=True)
    print("拼多多自动上架")
    print(f"资料文件夹：{root}（把店透视导出的 zip 放进去）\n")
    print("  1. 检查资料（不碰拼多多）")
    print("  2. 试填一个商品（填好停在页面上，不提交）")
    print("  3. 开始上架")
    n = input("\n输入数字回车：").strip()
    if n == "1":
        cmd_check(root)
    elif n == "2":
        cmd_upload(root, pick_shops()[:1], do_submit=False)
    elif n == "3":
        cmd_upload(root, pick_shops(), do_submit=True)


def main():
    if len(sys.argv) == 1:
        menu()
        input("\n按回车关闭")
        return
    cmd = sys.argv[1]
    root = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "待上架"
    shop = sys.argv[3] if len(sys.argv) > 3 else None
    if cmd == "检查":
        cmd_check(root)
    elif cmd == "试填":
        cmd_upload(root, pick_shops(shop)[:1], do_submit=False)
    elif cmd == "上架":
        cmd_upload(root, pick_shops(shop), do_submit=True)
    elif cmd == "远程试填":
        cmd_remote_try(root)
    else:
        print(__doc__)


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, SystemExit) as e:
        if str(e):
            print(e)
    except Exception:
        import traceback
        err = traceback.format_exc()
        log("出错了：\n" + err)
        input("\n截图发给开发者，按回车关闭")
