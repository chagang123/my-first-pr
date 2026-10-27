"""开发用：连客户的 Edge，只读不点，看发布页规格区和弹窗现在是什么样

用法：python remote_probe.py
"""
import sys

from playwright.sync_api import sync_playwright

from browser import open_remote_edge

sys.stdout.reconfigure(encoding="utf-8")

JS = r"""
() => {
  const out = [];
  const spec = document.querySelector('[id=spec]');
  if (!spec) return '没有规格区，当前页：' + location.href;
  const rows = spec.querySelectorAll('.goods-spec-row');
  out.push('规格类型行数：' + rows.length);
  rows.forEach((r, i) => out.push(`  行${i + 1}：${r.innerText.replace(/\s+/g, ' ').slice(0, 120)}`));
  out.push('按钮：' + [...spec.querySelectorAll('button, a')].map(b => b.innerText.trim()).filter(Boolean).join(' | '));
  const modals = [...document.querySelectorAll('[data-testid*=modal], [class*=Modal], [class*=modal], [class*=Popover], [class*=popover], [role=dialog], [role=tooltip]')]
    .filter(m => m.getBoundingClientRect().width > 0);
  modals.forEach(m => out.push('弹窗 ' + (m.getAttribute('data-testid') || m.className.split(' ')[0]) + '：' + m.innerText.replace(/\s+/g, ' ').slice(0, 200)));
  return out.join('\n');
}
"""

with sync_playwright() as pw:
    browser, ctx, tunnel = open_remote_edge(pw)
    try:
        for page in ctx.pages:
            print(page.url)
            if "goods_add" in page.url:
                print(page.evaluate(JS))
    finally:
        if tunnel:
            tunnel.terminate()
