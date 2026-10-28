"""操作面板：双击 exe 打开的窗口

上架、检查这些活都在 main.py 里，面板只负责：改常用设置、点按钮、在后台线程里跑、把运行记录和进度显示出来。
Playwright 的同步接口要在同一个线程里用完，所以每次点按钮都开一个新线程，从头到尾在里面跑。
"""
import json
import os
import queue
import threading
import time
import tkinter as tk
import traceback
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText

import main as core
from loader import find_products

ACCENT = "#e02e24"      # 拼多多红，只用在「开始上架」按钮和进度条上
INK = "#222222"
MUTED = "#777777"
LINE = "#e5e5e5"
BG = "#ffffff"
FONT = "Microsoft YaHei UI"
VERSION = "1028-1420"   # 每次打包改一下，面板标题上显示，方便确认客户用的是哪一版


class Panel:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.worker = None
        saved = core.SETTINGS.get("资料文件夹")
        self.data_dir = Path(saved) if saved and Path(saved).exists() else core.HERE / "待上架"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.last_result = None

        root.title(f"拼多多自动上架　版本 {VERSION}")
        root.geometry("860x720")
        root.minsize(760, 600)
        root.configure(bg=BG)
        self._style()
        self._build()
        self.refresh_count()

        core.LOG_SINKS.append(lambda line: self.q.put(("log", line)))
        core.PROGRESS = lambda *a: self.q.put(("progress", a))
        core.CONFIRM_CLOSE = self._confirm_close
        root.after(150, self._pump)
        root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ---------- 样子 ----------

    def _style(self):
        st = ttk.Style()
        st.theme_use("clam")
        st.configure(".", font=(FONT, 10), background=BG, foreground=INK)
        st.configure("TFrame", background=BG)
        st.configure("TLabel", background=BG, foreground=INK)
        st.configure("Muted.TLabel", foreground=MUTED)
        st.configure("Title.TLabel", font=(FONT, 15, "bold"))
        st.configure("Section.TLabel", font=(FONT, 10, "bold"))
        st.configure("Big.TLabel", font=(FONT, 12))
        st.configure("TCheckbutton", background=BG, indicatorbackground="#ffffff", indicatorforeground="#ffffff")
        # clam 默认勾上显示一个 ×，看着像没勾；改成勾上时整个小方块变红
        st.map("TCheckbutton", indicatorbackground=[("selected", ACCENT), ("!selected", "#ffffff")],
               background=[("active", BG)])
        st.configure("TButton", padding=(14, 6), background="#f4f4f4", bordercolor=LINE)
        st.map("TButton", background=[("active", "#ebebeb"), ("disabled", "#f7f7f7")])
        st.configure("Primary.TButton", foreground="#ffffff", background=ACCENT, bordercolor=ACCENT,
                     font=(FONT, 10, "bold"))
        st.map("Primary.TButton", background=[("active", "#c4241b"), ("disabled", "#e9a6a2")])
        st.configure("Link.TButton", padding=(4, 2), background=BG, foreground="#2f5fb3", bordercolor=BG,
                     lightcolor=BG, darkcolor=BG, relief="flat", borderwidth=0)
        st.map("Link.TButton", background=[("active", BG)], foreground=[("active", "#1d3f80")])
        st.configure("TEntry", fieldbackground="#ffffff", bordercolor=LINE)
        st.configure("TSpinbox", fieldbackground="#ffffff", bordercolor=LINE)
        st.configure("Red.Horizontal.TProgressbar", troughcolor="#f1f1f1", background=ACCENT,
                     bordercolor="#f1f1f1", lightcolor=ACCENT, darkcolor=ACCENT)

    def _build(self):
        pad = {"padx": 24}
        top = ttk.Frame(self.root)
        top.pack(fill="x", pady=(20, 4), **pad)
        ttk.Label(top, text="拼多多自动上架", style="Title.TLabel").pack(side="left")
        ttk.Label(top, text=f"版本 {VERSION}", style="Muted.TLabel").pack(side="left", padx=(10, 0), pady=(6, 0))
        self.count_lbl = ttk.Label(top, text="", style="Big.TLabel")
        self.count_lbl.pack(side="right")

        # 资料文件夹
        row = ttk.Frame(self.root)
        row.pack(fill="x", pady=(2, 14), **pad)
        ttk.Label(row, text="资料文件夹", style="Muted.TLabel").pack(side="left")
        self.dir_lbl = ttk.Label(row, text=str(self.data_dir))
        self.dir_lbl.pack(side="left", padx=(10, 6))
        ttk.Button(row, text="打开", style="Link.TButton", command=lambda: os.startfile(self.data_dir)).pack(side="left")
        ttk.Button(row, text="换一个", style="Link.TButton", command=self.pick_dir).pack(side="left")
        ttk.Button(row, text="刷新", style="Link.TButton", command=self.refresh_count).pack(side="left")

        ttk.Separator(self.root).pack(fill="x", **pad)

        # 店铺
        sec = ttk.Frame(self.root)
        sec.pack(fill="x", pady=(14, 4), **pad)
        ttk.Label(sec, text="店铺", style="Section.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(sec, text="勾上要上的店。名字用来区分登录状态，改了名要重新扫码", style="Muted.TLabel").grid(
            row=0, column=1, columnspan=4, sticky="w", padx=(12, 0))
        self.shop_rows = []
        for i, shop in enumerate(core.SETTINGS["店铺"], start=1):
            use = tk.BooleanVar(value=True)
            name = tk.StringVar(value=shop["名称"])
            kind = tk.StringVar(value=shop.get("类型", "普通"))
            limit = tk.StringVar(value=str(shop["每天最多上架"]))
            self._check(sec, "", use).grid(row=i, column=0, sticky="w", pady=4)
            box = ttk.Frame(sec)
            box.grid(row=i, column=1, sticky="w", padx=(12, 16))
            ttk.Entry(box, textvariable=name, width=12).pack(side="left")
            ttk.Combobox(box, textvariable=kind, values=["普通", "旗舰"], width=5, state="readonly").pack(
                side="left", padx=(6, 0))
            ttk.Label(sec, text="每天最多上").grid(row=i, column=2, sticky="w")
            ttk.Spinbox(sec, from_=1, to=500, textvariable=limit, width=5).grid(row=i, column=3, sticky="w", padx=6)
            today = core.today_count(core.load_record(), shop["名称"])
            ttk.Label(sec, text=f"个　今天已上 {today} 个", style="Muted.TLabel").grid(row=i, column=4, sticky="w")
            self.shop_rows.append((use, name, limit, kind))

        # 常用设置
        sec2 = ttk.Frame(self.root)
        sec2.pack(fill="x", pady=(14, 4), **pad)
        ttk.Label(sec2, text="上架设置", style="Section.TLabel").grid(row=0, column=0, sticky="w", columnspan=6)
        gap = core.SETTINGS["两个商品之间等几秒"]
        self.gap_a = tk.StringVar(value=str(gap[0]))
        self.gap_b = tk.StringVar(value=str(gap[1]))
        self.disc = tk.StringVar(value=str(core.SETTINGS.get("满件折扣", 9.9)))
        self.jia = tk.BooleanVar(value=core.SETTINGS.get("假一赔十", True))
        self.repeat = tk.BooleanVar(value=core.SETTINGS.get("主图最后再放一次第一张", True))
        ttk.Label(sec2, text="两个商品之间等").grid(row=1, column=0, sticky="w", pady=4)
        ttk.Spinbox(sec2, from_=10, to=3600, textvariable=self.gap_a, width=5).grid(row=1, column=1, padx=6)
        ttk.Label(sec2, text="到").grid(row=1, column=2)
        ttk.Spinbox(sec2, from_=10, to=3600, textvariable=self.gap_b, width=5).grid(row=1, column=3, padx=6)
        ttk.Label(sec2, text="秒（随机，模仿人工）").grid(row=1, column=4, sticky="w")
        ttk.Label(sec2, text="满 2 件打").grid(row=2, column=0, sticky="w", pady=4)
        ttk.Entry(sec2, textvariable=self.disc, width=6).grid(row=2, column=1, padx=6)
        ttk.Label(sec2, text="折").grid(row=2, column=2, sticky="w")
        self._check(sec2, "勾选假一赔十", self.jia).grid(row=3, column=0, columnspan=3, sticky="w", pady=4)
        self._check(sec2, "主图最后再放一次第一张", self.repeat).grid(
            row=3, column=3, columnspan=3, sticky="w", pady=4)

        # 按钮
        btns = ttk.Frame(self.root)
        btns.pack(fill="x", pady=(18, 10), **pad)
        self.b_check = ttk.Button(btns, text="检查资料", command=lambda: self.run("检查"))
        self.b_try = ttk.Button(btns, text="试填一个（不提交）", command=lambda: self.run("试填"))
        self.b_go = ttk.Button(btns, text="开始上架", style="Primary.TButton", command=lambda: self.run("上架"))
        self.b_stop = ttk.Button(btns, text="停止", command=self.stop, state="disabled")
        self.b_go.pack(side="left")
        self.b_try.pack(side="left", padx=(10, 0))
        self.b_check.pack(side="left", padx=(10, 0))
        self.b_stop.pack(side="right")

        # 进度
        prog = ttk.Frame(self.root)
        prog.pack(fill="x", pady=(6, 6), **pad)
        self.prog_lbl = ttk.Label(prog, text="还没开始", style="Muted.TLabel")
        self.prog_lbl.pack(anchor="w")
        self.bar = ttk.Progressbar(prog, style="Red.Horizontal.TProgressbar", maximum=1, value=0)
        self.bar.pack(fill="x", pady=(6, 0))

        bottom = ttk.Frame(self.root)
        bottom.pack(side="bottom", fill="x", pady=(0, 16), **pad)
        ttk.Button(bottom, text="打开最新结果表", style="Link.TButton", command=self.open_result).pack(side="left")
        ttk.Button(bottom, text="失败截图", style="Link.TButton",
                   command=lambda: self._open(core.HERE / "失败截图")).pack(side="left", padx=(8, 0))
        ttk.Button(bottom, text="运行日志", style="Link.TButton",
                   command=lambda: self._open(core.LOG_FILE)).pack(side="left", padx=(8, 0))
        ttk.Button(bottom, text="全部设置（设置.json）", style="Link.TButton",
                   command=lambda: self._open(core.HERE / "设置.json")).pack(side="left", padx=(8, 0))
        ttk.Label(bottom, text="上架时别去点那个浏览器；有滑块验证就手动拖一下", style="Muted.TLabel").pack(side="right")

        # 运行记录
        self.logbox = ScrolledText(self.root, height=12, font=(FONT, 9), relief="flat", bg="#fafafa",
                                   fg=INK, highlightthickness=1, highlightbackground=LINE, wrap="word")
        self.logbox.pack(fill="both", expand=True, pady=(8, 8), **pad)
        self.logbox.configure(state="disabled")

    def _check(self, parent, text, var):
        """用 Windows 自带的勾选框（显示 ✓），ttk 的 clam 主题勾上显示 ×，看着像没勾"""
        return tk.Checkbutton(parent, text=text, variable=var, bg=BG, activebackground=BG, fg=INK,
                              font=(FONT, 10), bd=0, highlightthickness=0, anchor="w")

    # ---------- 动作 ----------

    def refresh_count(self):
        n = len(find_products(self.data_dir, core.HERE / "解压"))
        self.count_lbl.configure(text=f"待上架 {n} 个商品")

    def pick_dir(self):
        d = filedialog.askdirectory(initialdir=self.data_dir, title="选放店透视 zip 的文件夹")
        if d:
            self.data_dir = Path(d)
            self.dir_lbl.configure(text=str(self.data_dir))
            self.refresh_count()

    def save_settings(self):
        """把面板上的值写回设置.json，其余设置保持不动"""
        f = core.HERE / "设置.json"
        cfg = json.loads(f.read_text(encoding="utf-8")) if f.exists() else dict(core.DEFAULT_SETTINGS)
        shops = []
        for use, name, limit, kind in self.shop_rows:
            shops.append({"名称": name.get().strip() or "店铺", "类型": kind.get(), "每天最多上架": int(limit.get())})
        cfg["店铺"] = shops
        a, b = int(self.gap_a.get()), int(self.gap_b.get())
        cfg["两个商品之间等几秒"] = [min(a, b), max(a, b)]
        cfg["满件折扣"] = float(self.disc.get() or 0)
        cfg["假一赔十"] = self.jia.get()
        cfg["主图最后再放一次第一张"] = self.repeat.get()
        # 默认的「待上架」不写进设置：整个文件夹拷到别的电脑上路径会变
        if self.data_dir.resolve() == (core.HERE / "待上架").resolve():
            cfg.pop("资料文件夹", None)
        else:
            cfg["资料文件夹"] = str(self.data_dir)
        f.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        core.reload_settings()

    def chosen_shops(self):
        names = {name.get().strip() for use, name, _, _ in self.shop_rows if use.get()}
        return [s for s in core.SETTINGS["店铺"] if s["名称"] in names]

    def run(self, what):
        if self.worker and self.worker.is_alive():
            return
        try:
            self.save_settings()
        except ValueError:
            messagebox.showwarning("设置有误", "等待秒数、每天上限要填整数，折扣填 5.0～9.9 之间的数")
            return
        shops = self.chosen_shops()
        if what != "检查" and not shops:
            messagebox.showinfo("没选店铺", "先勾上要上架的店铺")
            return
        if what == "上架" and not messagebox.askokcancel(
                "开始上架", f"要给 {'、'.join(s['名称'] for s in shops)} 上架「{self.data_dir.name}」里的商品，"
                          "文件夹里的每个商品都会上一遍（上过的也会再上）。\n\n开始后浏览器会自己操作，别去点它。"):
            return
        core.STOP.clear()
        self.bar.configure(value=0, maximum=1)
        self.prog_lbl.configure(text={"检查": "正在检查资料……", "试填": "正在试填……", "上架": "正在准备……"}[what])
        self._busy(True)

        def job():
            try:
                if what == "检查":
                    out = core.cmd_check(self.data_dir)
                elif what == "试填":
                    out = core.cmd_upload(self.data_dir, shops[:1], do_submit=False)
                else:
                    out = core.cmd_upload(self.data_dir, shops, do_submit=True)
                self.q.put(("done", (what, out)))
            except Exception:
                core.log("出错了：\n" + traceback.format_exc())
                self.q.put(("done", (what, None)))
        self.worker = threading.Thread(target=job, daemon=True)
        self.worker.start()

    def stop(self):
        core.STOP.set()
        self.b_stop.configure(state="disabled")
        self.prog_lbl.configure(text="正在停止：当前这个商品做完就停")

    def open_result(self):
        files = sorted(core.HERE.glob("上架结果_*.xlsx")) or sorted(core.HERE.glob("检查报告_*.xlsx"))
        if self.last_result:
            files.append(self.last_result)
        if files:
            os.startfile(files[-1])
        else:
            messagebox.showinfo("还没有结果", "跑过一次以后这里会有结果表")

    def _open(self, path):
        path = Path(path)
        if path.suffix == "":
            path.mkdir(exist_ok=True)
        if path.exists():
            os.startfile(path)
        else:
            messagebox.showinfo("还没有", f"还没有「{path.name}」")

    def _busy(self, busy):
        for b in (self.b_check, self.b_try, self.b_go):
            b.configure(state="disabled" if busy else "normal")
        self.b_stop.configure(state="normal" if busy else "disabled")

    def _confirm_close(self):
        """试填填完以后，在后台线程里等用户在面板上点确定"""
        ev = threading.Event()
        self.q.put(("confirm", ev))
        ev.wait()

    def _on_close(self):
        if self.worker and self.worker.is_alive():
            if not messagebox.askokcancel("还在运行", "还在上架，关掉窗口会马上停下（当前商品不会提交）。确定关吗？"):
                return
        self.root.destroy()

    # ---------- 后台线程的消息 ----------

    def _pump(self):
        try:
            while True:
                kind, val = self.q.get_nowait()
                if kind == "log":
                    self.logbox.configure(state="normal")
                    self.logbox.insert("end", val + "\n")
                    self.logbox.see("end")
                    self.logbox.configure(state="disabled")
                elif kind == "progress":
                    shop, i, n, ok, fail = val
                    self.bar.configure(maximum=n, value=ok + fail)
                    self.prog_lbl.configure(text=f"【{shop}】第 {i}/{n} 个　成功 {ok}　失败 {fail}")
                elif kind == "confirm":
                    messagebox.showinfo("试填好了", "去浏览器里检查填得对不对。\n\n检查完点「确定」，浏览器会关掉，这个商品不会提交。")
                    val.set()
                elif kind == "done":
                    what, out = val
                    self._busy(False)
                    self.last_result = out
                    self.refresh_count()
                    if what == "检查":
                        self.prog_lbl.configure(text="检查完了" + (f"，报告：{out.name}" if out else ""))
                    elif not self.prog_lbl.cget("text").startswith("【"):
                        self.prog_lbl.configure(text="完成")
        except queue.Empty:
            pass
        self.root.after(150, self._pump)


def run():
    root = tk.Tk()
    Panel(root)
    root.mainloop()


if __name__ == "__main__":
    run()
