"""在拼多多商家后台发布一个商品（模拟人工点页面）

拼多多的提交接口带反爬签名，没法直接调，只能一步步点。页面结构来自第一次远程采集（采集结果/）：
  第一页 /goods/category   传主图 → 填标题 → 选推荐类目 → 下一步
  第二页 /goods/goods_add  品牌等属性 → 详情图 → 规格类型「型号」+ 规格值 → 价格库存表（每行传预览图）
                           → 商品参考价 → 提交并上架
规格表是虚拟滚动的，行多了只渲染看得见的几行，所以按规格名找行，找不到就往下滚。
"""
import random
import re
import time

START_URL = "https://mms.pinduoduo.com/goods/category"
REMOTE = False   # 通过隧道控制客户电脑上的 Edge 时设成 True：图片要把内容传过去，光传路径客户那边找不到


def _files(paths):
    if not REMOTE:
        return [str(x) for x in paths]
    from browser import file_payload
    return [file_payload(x) for x in paths]


class PublishError(Exception):
    """这个商品没发成功，原因写在消息里，换下一个商品继续"""


def _pause(a=0.4, b=1.0):
    time.sleep(random.uniform(a, b))


def _num(v):
    """82.0 → "82"，74.6 → "74.6"，和客户手填的一样"""
    return f"{v:.2f}".rstrip("0").rstrip(".")


def wait_captcha(page, log):
    """出现滑块就停下来等人拖，不做绕过"""
    slider = page.locator("text=/向右滑动|拖动滑块|完成拼图|安全验证/")
    if slider.count() and slider.first.is_visible():
        log("出现了滑块验证，请在浏览器里手动拖一下，拖完会自动继续……")
        print("\a", end="", flush=True)
        while slider.count() and slider.first.is_visible():
            time.sleep(1)
        log("验证通过，继续")


def _wait(cond, timeout, what):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if cond():
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise PublishError(f"等了 {timeout} 秒，{what}")


def _form_item(page, label):
    """按左边的标签文字找表单项，比如「品牌」「商品参考价」"""
    return page.locator("[data-testid=beast-core-form-item]").filter(
        has=page.locator("label", has_text=re.compile(rf"^\*?{re.escape(label)}$"))).first


def _choose_option(page, text):
    """下拉框展开后点选项；拼多多的下拉选项是 li 或 data-testid 带 option 的元素"""
    opt = page.locator("[data-testid*=option], li[role=option], li").filter(
        has_text=re.compile(rf"^\s*{re.escape(text)}\s*$")).first
    opt.wait_for(state="visible", timeout=8000)
    opt.click()


def _set_select(page, item, value):
    inp = item.locator("input[data-testid=beast-core-select-htmlInput]").first
    if (inp.input_value() or "").strip() == value:
        return
    inp.click()
    if inp.get_attribute("readonly") is None:
        inp.fill(value)
    _pause()
    _choose_option(page, value)


# ---------- 第一页 ----------

def page_one(page, p, cfg, log):
    page.goto(START_URL)
    page.wait_for_load_state("domcontentloaded")
    if "/login" in page.url:
        raise PublishError("没登录：请先在这个浏览器里扫码登录拼多多后台")
    wait_captcha(page, log)

    mains = p.main_images[:10]
    log(f"上传主图 {len(mains)} 张")
    page.locator("section[class*=goodsCarousel] input[type=file]").first.set_input_files(_files(mains))
    # 上传按钮上写着「(5/10)」；传满 10 张时按钮会消失
    upload = page.locator("section[class*=goodsCarousel] input[type=file]")
    _wait(lambda: page.locator(f"text=/\\({len(mains)}\\/10\\)/").count() > 0
          or (len(mains) >= 10 and upload.count() == 0), 120, "主图还没传完")

    title = page.get_by_placeholder(re.compile("商品标题组成"))
    title.fill(p.title)
    title.press("Tab")

    chips = page.locator("[class*=cateItemCard_chooseCategory]")
    _wait(lambda: chips.count() > 0, 30, "拼多多没给出推荐类目")
    want = cfg.get("类目", "推荐第一个").replace(" ", "")
    if want in ("", "推荐第一个"):
        chip = chips.first
    else:
        chip = chips.filter(has_text=want).first
        if not chip.count():
            more = page.get_by_text("查看更多推荐")
            if more.count():
                more.first.click()
                _pause()
            chip = chips.filter(has_text=want).first
        if not chip.count():
            got = " / ".join(c.inner_text().strip() for c in chips.all())
            raise PublishError(f"推荐类目里没有「{want}」，拼多多推荐的是：{got}")
    category = chip.inner_text().strip().replace("\n", "")
    chip.click()
    log(f"类目：{category}")
    _pause()

    page.locator("#bottomSubmitBtnId").click()
    _wait(lambda: "/goods/goods_add" in page.url, 60, "没进到第二页（填写商品信息）")
    page.wait_for_load_state("domcontentloaded")
    _wait(lambda: page.locator("[id=spec]").count() > 0, 60, "第二页没加载出来")
    return category


# ---------- 第二页 ----------

def fill_properties(page, cfg, log):
    props = {"品牌": "无品牌/无注册商标", **cfg.get("默认属性", {})}
    for label, value in props.items():
        item = _form_item(page, label)
        if not item.count():
            log(f"属性「{label}」这个类目没有，跳过")
            continue
        if item.locator("input[data-testid=beast-core-select-htmlInput]").count():
            _set_select(page, item, value)
        else:
            box = item.locator("input").first
            if not (box.input_value() or "").strip():
                box.fill(value)
        _pause()


def upload_details(page, p, log):
    details = p.detail_images[:50]
    if not details:
        return
    log(f"上传详情图 {len(details)} 张")
    page.locator("[id=detail_pic] input[type=file]").first.set_input_files(_files(details))
    _wait(lambda: page.locator(f"[id=detail_pic] >> text=/{len(details)}\\s*\\/\\s*50/").count() > 0,
          180, "详情图还没传完")


def add_specs(page, p, log):
    spec_box = page.locator("[id=spec]")
    type_input = spec_box.get_by_placeholder("规格类型1")
    if (type_input.input_value() or "") != "型号":
        type_input.click()
        _pause()
        _choose_option(page, "型号")
        _pause()
    log(f"添加 {len(p.skus)} 个规格")
    names = spec_box.get_by_placeholder("请输入规格名称")
    for i, s in enumerate(p.skus):
        box = names.last
        box.fill(s.name)
        box.press("Enter")
        # 填了一个，下面会自动多出一个空的输入框
        _wait(lambda: names.count() >= i + 2 or names.last.input_value() == "", 10, f"规格「{s.name}」没加上")
        if (i + 1) % 10 == 0:
            log(f"  已加 {i + 1} 个")
        time.sleep(random.uniform(0.15, 0.4))


def _find_row(page, name, tries=60):
    """规格表只渲染看得见的行，按规格名找，找不到就往下滚一点再找；滚到底还没有就从头再来一遍"""
    title = page.locator(".sku-row-title").filter(has_text=re.compile(rf"^{re.escape(name)}$"))
    for i in range(tries):
        if title.count():
            row = page.locator("table tbody tr").filter(has=title).first
            row.scroll_into_view_if_needed()
            return row
        if i == tries // 2:
            page.locator("table tbody tr").first.scroll_into_view_if_needed()
        page.mouse.wheel(0, 300)
        time.sleep(0.3)
    raise PublishError(f"价格表里找不到规格「{name}」这一行")


def _fill(inp, value):
    inp.click()
    inp.fill(value)
    inp.press("Tab")


def fill_prices(page, p, log):
    stocks = {s.stock for s in p.skus}
    codes = {s.code for s in p.skus}
    batch = page.locator(".batch-set").first
    if len(stocks) == 1 and batch.count():
        # 库存、规格编码都一样就用表格上方的「批量设置」一次填完
        page.get_by_placeholder("库存", exact=True).fill(str(stocks.pop()))
        if len(codes) == 1 and next(iter(codes)):
            page.get_by_placeholder("规格编码", exact=True).fill(next(iter(codes)))
        page.get_by_role("button", name="批量设置").click()
        _pause()
        per_row_stock = per_row_code = False
    else:
        per_row_stock = per_row_code = True

    for i, s in enumerate(p.skus):
        row = _find_row(page, s.name)
        cells = row.locator("td")
        if per_row_stock:
            _fill(cells.nth(1).locator("input"), str(s.stock))
        _fill(cells.nth(2).locator("input"), _num(s.group_price))
        _fill(cells.nth(3).locator("input"), _num(s.single_price))
        if per_row_code and s.code:
            _fill(cells.nth(5).locator("input"), s.code)
        if s.image is not None:
            f = cells.nth(4).locator("input[type=file]")
            if f.count():
                f.first.set_input_files(_files([s.image]))
        if (i + 1) % 10 == 0:
            log(f"  已填 {i + 1}/{len(p.skus)} 行价格")
        time.sleep(random.uniform(0.2, 0.5))

    ref = max(s.single_price for s in p.skus) + 1
    _fill(page.get_by_placeholder("应大于商品最大单买价"), _num(ref))


def verify_prices(page, p, log):
    """提交前把每一行读回来和表格对一遍，对不上就不提交"""
    bad = []
    for s in p.skus:
        cells = _find_row(page, s.name).locator("td")
        got = [cells.nth(k).locator("input").first.input_value() for k in (1, 2, 3)]
        want = [str(s.stock), _num(s.group_price), _num(s.single_price)]
        try:
            same = all(abs(float(g) - float(w)) < 0.001 for g, w in zip(got, want))
        except ValueError:
            same = False
        if not same:
            bad.append(f"{s.name}：页面上是 库存{got[0]}/拼单{got[1]}/单买{got[2]}，应该是 {'/'.join(want)}")
        if s.image is not None and not cells.nth(4).locator("img, [class*=imgContainer]").count():
            bad.append(f"{s.name}：预览图没传上")
    if bad:
        raise PublishError("提交前核对没通过：\n  " + "\n  ".join(bad[:10]) + ("\n  ……" if len(bad) > 10 else ""))
    log(f"核对通过：{len(p.skus)} 行价格、库存、图片都对")


def submit(page, log):
    page.locator("#submit_button").click()
    end = time.time() + 90
    while time.time() < end:
        if "/goods_add/success" in page.url:
            m = re.search(r"goods_id=(\d+)", page.url)
            return m.group(1) if m else ""
        wait_captcha(page, log)
        # 价格预警之类的二次确认弹窗
        confirm = page.locator("[data-testid=beast-core-modal] button, [class*=Modal] button").filter(
            has_text=re.compile("^(确认|确定|继续提交|确认提交|仍要提交)$"))
        if confirm.count() and confirm.first.is_visible():
            log(f"弹窗：{confirm.first.inner_text().strip()}，点确认")
            confirm.first.click()
        err = page.locator("text=/个错误项未处理/")
        if err.count() and err.first.is_visible():
            msgs = page.locator("[class*=Form_itemError], [data-testid=beast-core-form-item-error]").all_inner_texts()
            msgs = [m.strip() for m in msgs if m.strip()]
            raise PublishError("拼多多提示有错误没处理：" + ("；".join(msgs[:5]) or err.first.inner_text()))
        time.sleep(1)
    raise PublishError("点了提交并上架，90 秒没看到成功页面")


def publish(page, p, cfg, log, do_submit=True):
    """发一个商品，返回 (类目, 商品ID)。do_submit=False 时填完停在页面上不提交，给人检查"""
    category = page_one(page, p, cfg, log)
    wait_captcha(page, log)
    fill_properties(page, cfg, log)
    upload_details(page, p, log)
    add_specs(page, p, log)
    fill_prices(page, p, log)
    verify_prices(page, p, log)
    if not do_submit:
        return category, ""
    return category, submit(page, log)
