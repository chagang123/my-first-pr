"""用第一次远程采集的网页离线检查 publish.py 的定位能不能找到东西

页面是静态快照（关掉 JS），只能检查「找得到」和「读得出」，点击、上传要在客户电脑上实测。
用法：python test_offline.py
"""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

import publish
from loader import Product, Sku

sys.stdout.reconfigure(encoding="utf-8")
SNAP = Path(__file__).resolve().parent / "采集结果/拼多多上架/页面采集/店铺1"
PAGE1 = SNAP / "1026_1553/17_十六/网页.html"
PAGE2 = SNAP / "1026_1617/13_38  假一赔十/网页.html"   # 填好 2 个规格、价格、预览图之后
PAGE2_EMPTY_IMG = SNAP / "1026_1617/05_29/网页.html"  # 预览图还没传

fails = 0


def check(name, ok, detail=""):
    global fails
    fails += not ok
    print(("✓ " if ok else "✗ ") + name + (f"  {detail}" if detail else ""))


def load(ctx, path):
    page = ctx.new_page()
    page.set_content(path.read_text(encoding="utf-8"), wait_until="domcontentloaded")
    return page


with sync_playwright() as pw:
    browser = pw.chromium.launch(channel="msedge")
    ctx = browser.new_context(java_script_enabled=False, viewport={"width": 1600, "height": 1000})
    ctx.route("**/*", lambda r: r.abort() if r.request.resource_type != "document" else r.continue_())

    print("== 第一页（传主图、标题、类目）")
    pg = load(ctx, PAGE1)
    check("主图上传框", pg.locator("section[class*=goodsCarousel] input[type=file]").count() == 1)
    check("主图张数文字 (6/10)", pg.locator("text=/\\(6\\/10\\)/").count() > 0)
    check("标题输入框", pg.get_by_placeholder(__import__("re").compile("商品标题组成")).count() == 1)
    chips = pg.locator("[class*=cateItemCard_chooseCategory]")
    check("推荐类目", chips.count() >= 1, " / ".join(c.inner_text().strip() for c in chips.all()))
    check("下一步按钮", pg.locator("#bottomSubmitBtnId").count() == 1)

    print("== 第二页（属性、详情、规格、价格）")
    pg = load(ctx, PAGE2)
    brand = publish._form_item(pg, "品牌")
    check("品牌下拉框", brand.locator("input[data-testid=beast-core-select-htmlInput]").count() == 1,
          brand.locator("input").first.input_value())
    check("详情图上传框", pg.locator("[id=detail_pic] input[type=file]").count() == 1)
    spec = pg.locator("[id=spec]")
    check("规格类型下拉", spec.get_by_placeholder("规格类型1").input_value() == "型号")
    check("规格名输入框（2 个已填 + 1 个空）", spec.get_by_placeholder("请输入规格名称").count() == 3)
    check("批量设置：库存框", pg.get_by_placeholder("库存", exact=True).count() == 1)
    check("批量设置：规格编码框", pg.get_by_placeholder("规格编码", exact=True).count() == 1)
    check("批量设置按钮", pg.get_by_role("button", name="批量设置").count() == 1)
    check("商品参考价", pg.get_by_placeholder("应大于商品最大单买价").input_value() == "84")
    check("提交并上架按钮", pg.locator("#submit_button").count() == 1)
    check("满件折扣框", pg.get_by_placeholder("5.0~9.9").count() == 1)
    jia = pg.locator("label[data-testid=beast-core-checkbox]").filter(
        has_text=__import__("re").compile(r"^\s*假一赔十\s*$"))
    check("假一赔十勾选框", jia.count() == 1, f"data-checked={jia.first.get_attribute('data-checked')}")

    p = Product(folder=Path("."), goods_id="", title="", shop="", skus=[
        Sku("大扁头自钻(兰锌)M4.2", 13.99, 82, 83, 999, "", image=Path("x.jpg")),
        Sku("大扁头自钻(兰锌)M4.8", 12.49, 74.6, 75.6, 999, "", image=Path("x.jpg")),
    ])
    row = publish._find_row(pg, "大扁头自钻(兰锌)M4.8", tries=2)
    check("按规格名找到行", row.locator("td").nth(2).locator("input").input_value() == "74.6")
    try:
        publish.verify_prices(pg, p, lambda m: None)
        check("提交前核对（价格和页面一致时通过）", True)
    except publish.PublishError as e:
        check("提交前核对（价格和页面一致时通过）", False, str(e))
    p.skus[1].group_price = 70
    try:
        publish.verify_prices(pg, p, lambda m: None)
        check("提交前核对（价格不一致时拦下）", False)
    except publish.PublishError as e:
        check("提交前核对（价格不一致时拦下）", "74.6" in str(e))

    pg = load(ctx, PAGE2_EMPTY_IMG)
    row = publish._find_row(pg, "大扁头自钻(兰锌)M4.2", tries=2)
    check("预览图格子里有上传框", row.locator("td").nth(4).locator("input[type=file]").count() == 1)
    print("== 旗舰店（第一页选分类、第二页主图和标题）")
    QJ = Path(__file__).resolve().parent / "采集结果/旗舰店"
    snaps = {p.name.split("_", 2)[-1]: p for p in QJ.iterdir()} if QJ.exists() else {}
    if "01b_再存一次" in snaps:
        pg = load(ctx, snaps["01b_再存一次"] / "网页.html")
        check("分类搜索框", pg.get_by_placeholder("请输入关键词搜索分类").count() == 1)
        opts = pg.locator("[data-testid=beast-core-search-panel] li")
        check("搜索出来的类目", opts.count() >= 1, opts.first.inner_text().strip() if opts.count() else "")
        check("确认发布该类商品按钮", pg.locator("button[data-e2e-id=e2e-publish-button]").count() == 1)
    if "04" in snaps:
        pg = load(ctx, snaps["04"] / "网页.html")
        box = pg.locator("[id='basic.carousel_gallery']")
        m = __import__("re").search(r"已上传\s*(\d+)\s*/\s*10", box.inner_text())
        check("轮播图上传框和张数", box.locator("input[type=file]").count() == 1 and m is not None,
              f"已上传 {m.group(1) if m else '?'} 张")
        check("第二页标题框", pg.locator("[id='basic.goods_name'] input").count() == 1)
    browser.close()

print(f"\n{'全部通过' if not fails else f'{fails} 项没通过'}")
sys.exit(1 if fails else 0)
