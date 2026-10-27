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


def _click(loc, timeout=5000):
    """先像人一样用鼠标点；远程控制时有些弹窗上的鼠标点击会一直卡住，5 秒点不动就改用脚本触发点击"""
    try:
        loc.click(timeout=timeout)
    except Exception:
        try:
            gone = loc.count() == 0 or not loc.is_visible()
        except Exception:
            gone = True     # 页面都换了
        if gone:
            return          # 鼠标其实点到了（按钮已经跟着页面跳走了），只是没等到回复
        loc.dispatch_event("click", timeout=5000)


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
    _click(opt)


def _set_select(page, item, value):
    inp = item.locator("input[data-testid=beast-core-select-htmlInput]").first
    if (inp.input_value() or "").strip() == value:
        return
    _click(inp)
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

    # 客户的习惯：第一张主图在最后再放一次，首尾都是它
    repeat_first = cfg.get("主图最后再放一次第一张", True) and len(p.main_images) > 1
    mains = p.main_images[:9 if repeat_first else 10]
    upload = page.locator("section[class*=goodsCarousel] input[type=file]")
    total = 0
    for batch in ([mains, [mains[0]]] if repeat_first else [mains]):
        total += len(batch)
        log(f"上传主图 {len(batch)} 张" if total == len(batch) else "主图最后再放一次第一张")
        upload.first.set_input_files(_files(batch))
        # 上传按钮上写着「(5/10)」；传满 10 张时按钮会消失
        _wait(lambda: page.locator(f"text=/\\({total}\\/10\\)/").count() > 0
              or (total >= 10 and upload.count() == 0), 120, "主图还没传完")

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
                _click(more.first)
                _pause()
            chip = chips.filter(has_text=want).first
        if not chip.count():
            got = " / ".join(c.inner_text().strip() for c in chips.all())
            raise PublishError(f"推荐类目里没有「{want}」，拼多多推荐的是：{got}")
    category = chip.inner_text().strip().replace("\n", "")
    _click(chip)
    log(f"类目：{category}")
    _pause()

    _click(page.locator("#bottomSubmitBtnId"))
    # 拼多多有时会关掉这个标签页、在新标签页里打开第二页，所以在所有标签页里找
    ctx = page.context
    found = []

    def on_page_two():
        # 光 sleep 的话 Playwright 收不到跳转消息，page.url 一直是旧的；调一下 wait_for_timeout 让它处理消息
        open_pages = [pg for pg in ctx.pages if not pg.is_closed()]
        if open_pages:
            try:
                open_pages[-1].wait_for_timeout(200)
            except Exception:
                pass
        found[:] = []
        for pg in reversed(ctx.pages):
            try:
                if not pg.is_closed() and "/goods/goods_add" in pg.url and pg.locator("[id=spec]").count():
                    found.append(pg)
                    return True
            except Exception:
                pass
        return False

    # 进第二页时拼多多会先开一个页面再换掉，所以找到以后等 3 秒，确认没被关掉再用
    for _ in range(3):
        _wait(on_page_two, 60, "没进到第二页（填写商品信息）")
        page = found[0]
        time.sleep(3)
        if not page.is_closed() and on_page_two() and found[0] == page:
            break
    page.on("dialog", lambda d: d.accept())
    return category, page


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


def _confirm_modal(page):
    """点拼多多确认框里的确定按钮（data-testid=beast-core-modal-ok-button）。
    远程控制时这个弹窗不响应鼠标点击，也常被判成「不可见」，所以直接用脚本触发点击"""
    btn = page.locator("[data-testid=beast-core-modal-ok-button]")
    _wait(lambda: btn.count() > 0, 5, "没弹出确认框")
    btn.last.dispatch_event("click")


def add_specs(page, p, log):
    spec_box = page.locator("[id=spec]")
    rows = spec_box.locator(".goods-spec-row")
    # 照客户手动的做法：页面自带「型号」「尺寸」两行时删掉第一行，规格值都填在剩下那一行里
    if rows.count() > 1:
        n = rows.count()
        log(f"删掉第一个规格类型「{rows.first.locator('input').first.input_value()}」")
        _click(rows.first.get_by_text("删除规格类型"))
        _confirm_modal(page)
        _wait(lambda: rows.count() == n - 1, 10, "删除规格类型后页面没变化")
        # 删完确认框有时还挂在页面上，点「取消」关掉（不能再点「删除」，会把剩下那行也删了）
        close = page.locator("[data-testid=beast-core-modal-close-button]")
        if close.count():
            close.last.dispatch_event("click")
        _pause()
    if not rows.count():
        _click(spec_box.get_by_role("button", name=re.compile("添加规格类型")))
        _wait(lambda: rows.count() == 1, 10, "点了「添加规格类型」没出来新的一行")
        _click(rows.first.locator("input[data-testid=beast-core-select-htmlInput]").first)
        _pause()
        _choose_option(page, "型号")
        _pause()
    row = rows.first
    log(f"规格类型用「{row.locator('input').first.input_value()}」")

    names = row.get_by_placeholder("请输入规格名称")
    # 接着跑的时候页面上可能已经有一部分规格值，跳过已经有的
    have = {v.strip() for v in names.evaluate_all("els => els.map(e => e.value)") if v.strip()}
    todo = [s for s in p.skus if s.name not in have]
    log(f"添加 {len(todo)} 个规格" + (f"（页面上已经有 {len(have)} 个）" if have else ""))
    for i, s in enumerate(todo):
        before = names.count()
        box = names.last
        box.fill(s.name)
        box.press("Enter")
        # 填了一个，下面会自动多出一个空的输入框
        _wait(lambda: names.count() > before or names.last.input_value() == "", 10, f"规格「{s.name}」没加上")
        if (i + 1) % 10 == 0:
            log(f"  已加 {i + 1}/{len(todo)} 个")
        time.sleep(random.uniform(0.15, 0.4))


# 价格表在自己的滚动框里（表格外面一层 overflow:auto 的 div），鼠标滚轮滚的是整个网页，滚不动它，
# 所以直接改这个框的 scrollTop。dy 为 None 时回到最顶上；返回 [当前位置, 最大位置]
_SCROLL_JS = """(dy) => {
  const t = document.querySelector('table tbody');
  if (!t) return [0, 0];
  let box = t.parentElement;
  while (box && !(box.scrollHeight > box.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(box).overflowY)))
    box = box.parentElement;
  if (!box) { t.scrollIntoView(); return [0, 0]; }
  box.scrollTop = dy === null ? 0 : box.scrollTop + dy;
  return [box.scrollTop, box.scrollHeight - box.clientHeight];
}"""


def _scroll_table(page, dy):
    pos = page.evaluate(_SCROLL_JS, dy)
    time.sleep(0.4)     # 等虚拟列表把新位置的行渲染出来
    return pos


def _scroll_table_top(page):
    _scroll_table(page, None)


def _find_row(page, name, tries=60):
    """规格表只渲染看得见的行，按规格名找，找不到就往下滚一点再找；滚到底还没有就从头再来一遍"""
    title = page.locator(".sku-row-title").filter(has_text=re.compile(rf"^{re.escape(name)}$"))
    for i in range(tries):
        if title.count():
            row = page.locator("table tbody tr").filter(has=title).first
            row.scroll_into_view_if_needed()
            return row
        if i == 0:
            _scroll_table_top(page)
            continue
        top, end = _scroll_table(page, 300)
        if top >= end:          # 滚到底了还没有，就从头再来一遍
            _scroll_table_top(page)
    raise PublishError(f"价格表里找不到规格「{name}」这一行")


def _fill(inp, value):
    # fill 自己会聚焦输入框，不用先点（有残留弹窗挡着时点击要等很久）
    inp.fill(value)
    inp.press("Tab")


def _fill_if_diff(inp, value):
    try:
        same = abs(float(inp.input_value()) - float(value)) < 0.001
    except ValueError:
        same = inp.input_value() == value
    if not same:
        _fill(inp, value)


def _close_stale_modal(page):
    """页面上挂着没关掉的确认框就点「取消」关掉，免得挡住后面的点击"""
    close = page.locator("[data-testid=beast-core-modal-close-button]")
    if close.count():
        close.last.dispatch_event("click")
        _pause()


_ROWS_JS = """() => [...document.querySelectorAll('table tbody tr')].map(r => {
  const t = r.querySelector('.sku-row-title');
  const ins = [...r.querySelectorAll('input:not([type=file])')].map(i => i.value);
  const img = !!(r.children[4] && r.children[4].querySelector('img, [class*=imgContainer]'));
  return t ? [t.innerText.trim(), ins[0] || '', ins[1] || '', ins[2] || '', img] : null;
}).filter(Boolean)"""


def _table_state(page):
    """规格表是虚拟滚动的，从头滚到尾，每滚一下用一次脚本读出看得见的所有行：{规格名: 库存/拼单价/单买价/有没有图}"""
    state = {}
    rows = page.locator("table tbody tr")
    if not rows.count():
        return state
    _scroll_table_top(page)
    same = 0
    for _ in range(80):
        before = len(state)
        for name, stock, gp, sp, img in page.evaluate(_ROWS_JS):
            state[name] = {"stock": stock, "gp": gp, "sp": sp, "img": img}
        same = same + 1 if len(state) == before else 0
        top, end = _scroll_table(page, 400)
        if top >= end:
            same += 1           # 到底了，再读一次就结束
        if same >= 2:
            break
    return state


def fill_prices(page, p, log):
    _close_stale_modal(page)
    stocks = {s.stock for s in p.skus}
    codes = {s.code for s in p.skus}
    batch = page.locator(".batch-set").first
    if len(stocks) == 1 and batch.count():
        # 库存、规格编码都一样就用表格上方的「批量设置」一次填完
        page.get_by_placeholder("库存", exact=True).fill(str(stocks.pop()))
        if len(codes) == 1 and next(iter(codes)):
            page.get_by_placeholder("规格编码", exact=True).fill(next(iter(codes)))
        _click(page.get_by_role("button", name="批量设置"))
        _pause()
        per_row_stock = per_row_code = False
    else:
        per_row_stock = per_row_code = True

    # 先扫一遍整张表，已经填对、有图的行直接跳过（断线重连后不用一行行重新核对）
    state = _table_state(page)

    def done(s):
        st = state.get(s.name)
        if not st:
            return False
        try:
            ok = (abs(float(st["gp"]) - s.group_price) < 0.001 and abs(float(st["sp"]) - s.single_price) < 0.001
                  and float(st["stock"]) == s.stock)
        except ValueError:
            return False
        return ok and (s.image is None or st["img"])
    todo = [s for s in p.skus if not done(s)]
    if len(todo) < len(p.skus):
        log(f"  {len(p.skus) - len(todo)} 行已经填好，跳过，还剩 {len(todo)} 行")

    for i, s in enumerate(todo):
        row = _find_row(page, s.name)
        cells = row.locator("td")
        # 接着跑的时候已经填对的格子、已经有图的行就跳过，不重复传图
        if per_row_stock:
            _fill_if_diff(cells.nth(1).locator("input"), str(s.stock))
        _fill_if_diff(cells.nth(2).locator("input"), _num(s.group_price))
        _fill_if_diff(cells.nth(3).locator("input"), _num(s.single_price))
        if per_row_code and s.code:
            _fill_if_diff(cells.nth(5).locator("input"), s.code)
        if s.image is not None and not cells.nth(4).locator("img, [class*=imgContainer]").count():
            f = cells.nth(4).locator("input[type=file]")
            if f.count():
                f.first.set_input_files(_files([s.image]))
        if (i + 1) % 10 == 0:
            log(f"  已填 {i + 1}/{len(todo)} 行价格")
        time.sleep(random.uniform(0.2, 0.5))

    ref = max(s.single_price for s in p.skus) + 1
    _fill(page.get_by_placeholder("应大于商品最大单买价"), _num(ref))


def fill_service(page, cfg, log):
    """满件折扣、假一赔十（客户要求：满 2 件 9.9 折，勾上假一赔十）"""
    disc = cfg.get("满件折扣", 9.9)
    if disc:
        _fill_if_diff(page.get_by_placeholder("5.0~9.9"), _num(disc))
        log(f"满件折扣 {_num(disc)} 折")
    if cfg.get("假一赔十", True):
        box = page.locator("label[data-testid=beast-core-checkbox]").filter(has_text=re.compile(r"^\s*假一赔十\s*$")).first
        if not box.count():
            log("页面上没有「假一赔十」，跳过")
        elif box.get_attribute("data-checked") != "true":
            _click(box)
            _wait(lambda: box.get_attribute("data-checked") == "true", 5, "「假一赔十」没勾上")
            log("勾上假一赔十")


def verify_prices(page, p, log):
    """提交前把每一行读回来和表格对一遍，对不上就不提交。
    从表头往下扫一遍整张表，一次读出看得见的所有行，比一行行去找快，页面也不会来回跳"""
    state = _table_state(page)
    bad = []
    for s in p.skus:
        st = state.get(s.name)
        if not st:
            bad.append(f"{s.name}：价格表里没有这一行")
            continue
        got = [st["stock"], st["gp"], st["sp"]]
        want = [str(s.stock), _num(s.group_price), _num(s.single_price)]
        try:
            same = all(abs(float(g) - float(w)) < 0.001 for g, w in zip(got, want))
        except ValueError:
            same = False
        if not same:
            bad.append(f"{s.name}：页面上是 库存{got[0]}/拼单{got[1]}/单买{got[2]}，应该是 {'/'.join(want)}")
        if s.image is not None and not st["img"]:
            bad.append(f"{s.name}：预览图没传上")
    if bad:
        raise PublishError("提交前核对没通过：\n  " + "\n  ".join(bad[:10]) + ("\n  ……" if len(bad) > 10 else ""))
    log(f"核对通过：{len(p.skus)} 行价格、库存、图片都对")


def submit(page, log):
    _click(page.locator("#submit_button"))
    ctx = page.context
    seen = set()
    end = time.time() + 90
    while time.time() < end:
        # 成功页可能开在新标签页里，所有标签页都看
        for pg in ctx.pages:
            if not pg.is_closed() and "/goods_add/success" in pg.url:
                m = re.search(r"goods_id=(\d+)", pg.url)
                return m.group(1) if m else ""
        wait_captcha(page, log)
        # 价格预警之类的二次确认弹窗：先记下弹窗写了什么，再用脚本点确认（远程时鼠标点不动这种弹窗）
        body = page.locator("[data-testid=beast-core-modal-body]")
        for t in body.all_inner_texts():
            t = " ".join(t.split())
            if t and t not in seen:
                seen.add(t)
                log(f"弹窗：{t}")
        ok = page.locator("[data-testid=beast-core-modal-ok-button]").filter(has_text=re.compile("(确认|确定|继续|提交)"))
        if ok.count():
            log(f"点「{ok.last.inner_text().strip()}」")
            ok.last.dispatch_event("click")
        err = page.locator("text=/个错误项未处理/")
        if err.count() and err.first.is_visible():
            msgs = page.locator("[class*=Form_itemError], [data-testid=beast-core-form-item-error]").all_inner_texts()
            msgs = [m.strip() for m in msgs if m.strip()]
            raise PublishError("拼多多提示有错误没处理：" + ("；".join(msgs[:5]) or err.first.inner_text()))
        page.wait_for_timeout(1000)
    raise PublishError("点了提交并上架，90 秒没看到成功页面")


STEPS = ["第一页", "属性", "详情图", "规格", "价格", "服务", "核对"]
LAST_STEP = "第一页"   # 正在做哪一步，断线重连时从这里接着跑


def publish(page, p, cfg, log, do_submit=True, start="第一页"):
    """发一个商品，返回 (类目, 商品ID)。do_submit=False 时填完停在页面上不提交，给人检查。
    start 是从哪一步开始：调试时卡住了，改完代码在当前页面上接着跑，不用从头再来"""
    if start not in STEPS:
        raise PublishError(f"没有「{start}」这一步，可以从这些步开始：{'、'.join(STEPS)}")
    global LAST_STEP
    todo = STEPS[STEPS.index(start):]
    category = "（接着跑，没重选）"
    if "第一页" in todo:
        LAST_STEP = "第一页"
        category, page = page_one(page, p, cfg, log)
    wait_captcha(page, log)
    if "属性" in todo:
        LAST_STEP = "属性"
        fill_properties(page, cfg, log)
    if "详情图" in todo:
        LAST_STEP = "详情图"
        upload_details(page, p, log)
    if "规格" in todo:
        LAST_STEP = "规格"
        add_specs(page, p, log)
    if "价格" in todo:
        LAST_STEP = "价格"
        fill_prices(page, p, log)
    if "服务" in todo:
        LAST_STEP = "服务"
        fill_service(page, cfg, log)
    LAST_STEP = "核对"
    verify_prices(page, p, log)
    if not do_submit:
        return category, ""
    return category, submit(page, log)


def current_page(ctx, page):
    """发完一个商品后拿最新的标签页（第二页可能开在新标签页里，旧的已经关了）"""
    pages = [pg for pg in ctx.pages if not pg.is_closed()]
    return pages[-1] if pages else page
