"""读取「店透视」导出的商品资料

一个商品 = 一个文件夹（或一个 zip），里面有：
- 店透-SKU预览-表格-<商品ID>-<日期>.xlsx   每行一个 SKU
- 店透视_仅1_1主图_...   主图
- 店透视_仅SKU图_...     SKU 图，文件名里带 SKU 名（* 之类的字符被换成了 _）
- 店透视_仅详情图_...    详情图
"""
import math
import re
import shutil
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import openpyxl

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp"}
BAD_NAME_CHARS = re.compile(r'[\\/:*?"<>|]')   # Windows 文件名里不能有的字符，店透视会换成 _


@dataclass
class Sku:
    name: str
    src_price: float | None       # 原店价格
    group_price: float | None     # 拼单价
    single_price: float | None    # 单买价
    stock: int | None
    code: str                     # 规格编码
    image: Path | None = None


@dataclass
class Product:
    folder: Path
    goods_id: str
    title: str
    shop: str
    skus: list[Sku] = field(default_factory=list)
    main_images: list[Path] = field(default_factory=list)
    detail_images: list[Path] = field(default_factory=list)


def _num(name):
    m = re.search(r"_(\d+)", name)
    return int(m.group(1)) if m else 0


def _images(folder, keyword):
    for d in folder.iterdir():
        if d.is_dir() and keyword in d.name:
            return sorted((p for p in d.iterdir() if p.suffix.lower() in IMG_EXT), key=lambda p: _num(p.stem))
    return []


def _norm(s):
    return BAD_NAME_CHARS.sub("_", s).replace(" ", "").strip()


def _float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def calc_price(expr, src_price, round_to):
    """按设置里的公式算拼单价，比如 (原价+1.6+1)/0.85*1.2，向上取整到 round_to"""
    if not re.fullmatch(r"[\d.+\-*/() 原价]+", expr):
        raise ValueError(f"价格公式只能有数字、加减乘除、括号和「原价」：{expr}")
    v = eval(expr, {"__builtins__": {}}, {"原价": src_price})
    return round(math.ceil(v / round_to - 1e-9) * round_to, 2)


def read_product(folder: Path) -> Product:
    sheets = list(folder.glob("*.xlsx"))
    if not sheets:
        raise ValueError("文件夹里没有 xlsx 表格")
    ws = openpyxl.load_workbook(sheets[0], data_only=True).active
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h).strip() if h is not None else "" for h in rows[0]]

    def col(name, after=-1):
        for i, h in enumerate(head):
            if i > after and h == name:
                return i
        raise ValueError(f"表格里找不到「{name}」这一列")

    c_title, c_id, c_shop = col("商品信息"), col("商品ID"), col("店铺名称")
    c_sku, c_src = col("SKU信息"), col("价格")
    c_group = col("拼单价")
    c_single = col("单买价")
    c_stock = col("库存", after=c_group)     # 表格里有两列「库存」，拼单价后面那列才是要上架的
    c_code = col("规格编码")

    first = rows[1]
    p = Product(folder=folder, goods_id=str(first[c_id]), title=str(first[c_title]).strip(), shop=str(first[c_shop] or ""))
    for r in rows[1:]:
        if not r[c_sku]:
            continue
        stock = _float(r[c_stock])
        p.skus.append(Sku(
            name=str(r[c_sku]).strip(),
            src_price=_float(r[c_src]),
            group_price=_float(r[c_group]),
            single_price=_float(r[c_single]),
            stock=int(stock) if stock is not None else None,
            code=str(r[c_code] or ""),
        ))

    p.main_images = _images(folder, "主图")
    p.detail_images = _images(folder, "详情图")
    sku_imgs = {_norm(re.sub(r"^SKU图_\d+_", "", f.stem)): f for f in _images(folder, "SKU图")}
    for s in p.skus:
        s.image = sku_imgs.get(_norm(s.name))
    return p


def _unzip(zip_path: Path, dest: Path):
    """店透视的 zip 有的没标 UTF-8，中文名会被当成 cp437 读，这里转回来"""
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            name = info.filename
            if not info.flag_bits & 0x800:
                try:
                    name = name.encode("cp437").decode("gbk")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            target = dest / name
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as src, target.open("wb") as out:
                shutil.copyfileobj(src, out)


def find_products(root: Path, unzip_dir: Path):
    """root 下的每个 zip 先解压到 unzip_dir，再找出所有带 xlsx 的商品文件夹"""
    for z in sorted(root.glob("*.zip")):
        dest = unzip_dir / z.stem
        if not dest.exists():
            _unzip(z, dest)
    folders = {x.parent for base in (root, unzip_dir) if base.exists() for x in base.rglob("店透-SKU预览-表格-*.xlsx")}
    return sorted(folders)
