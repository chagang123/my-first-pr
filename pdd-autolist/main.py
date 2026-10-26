"""拼多多自动上架

用法：
  python main.py 检查 <资料文件夹>   读一遍所有商品资料，出「检查报告.xlsx」，不碰拼多多
  python main.py 上架 <资料文件夹>   （等第一次远程采集完发布页再接上）

资料文件夹里直接放店透视导出的 zip 或解压后的文件夹都行。
价格默认用表格里的拼单价/单买价；设置.json 里「价格.来源」改成「公式」，就按公式从原价重新算。
"""
import json
import sys
import time
from pathlib import Path

import openpyxl
from openpyxl.styles import Font

from loader import calc_price, find_products, read_product

HERE = Path(__file__).resolve().parent
SETTINGS = json.loads((HERE / "设置.json").read_text(encoding="utf-8"))
RECORD_FILE = HERE / "上架记录.json"

sys.stdout.reconfigure(encoding="utf-8")


def load_record():
    """{店铺名: {商品ID: 上架时间}}，中途断了重开不会重复上"""
    if RECORD_FILE.exists():
        return json.loads(RECORD_FILE.read_text(encoding="utf-8"))
    return {}


def save_record(record):
    RECORD_FILE.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


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
    return errors, warns


def cmd_check(root: Path):
    folders = find_products(root, HERE / "解压")
    if not folders:
        print("没找到商品资料：文件夹里要有店透视导出的 zip 或文件夹")
        return
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "商品"
    ws.append(["商品ID", "标题", "SKU数", "主图", "详情图", "SKU图", "能不能上", "问题"])
    ws2 = wb.create_sheet("SKU明细")
    ws2.append(["商品ID", "SKU", "原价", "拼单价", "单买价", "库存", "规格编码", "SKU图"])
    ok = 0
    for f in folders:
        try:
            p = read_product(f)
            apply_price(p)
        except Exception as e:
            ws.append(["", f.name, "", "", "", "", "不能", f"读取失败：{e}"])
            print("✗", f.name, e)
            continue
        errors, warns = check(p)
        ok += not errors
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
    print(f"\n共 {len(folders)} 个商品，能上 {ok} 个。报告：{out}")


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("检查", "上架"):
        print(__doc__)
        return
    root = Path(sys.argv[2])
    if sys.argv[1] == "检查":
        cmd_check(root)
    else:
        print("上架功能要等远程采集完发布页面再接上")


if __name__ == "__main__":
    main()
