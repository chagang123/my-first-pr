(function () {
'use strict';

// ============ 常量 ============
var W = 390;
var H = 700;                 // 逻辑高度随屏幕比例调整，见 resizeGame
var BASE = 10;               // 底座边长（世界单位）
var LAYER = 1.2;             // 每层厚度
var RANGE = 13;              // 方块来回滑动的距离
var PERFECT = 0.3;           // 误差在这个范围内算完美对齐
var GROW_AFTER = 3;          // 连续完美几次后开始变宽
var GROW = 0.6;
var COS30 = 0.866, SIN30 = 0.5;
var HUES = [200, 330, 28, 160, 265];

function speedFor(score) { return Math.min(9 + score * 0.18, 22); }

// ============ 小红书端能力 ============
var xhs = window.xhs || null;
var miniTool = (xhs && xhs.miniTool) ? xhs.miniTool : null;
var STORE_KEY = 'stack_tower_save';

function readBuildVersion(opts) {
  var env = opts && opts.miniToolEnv;
  return Number(env && env.buildVersion) || 0;
}

var buildVersionPromise = null;
function getBuildVersion() {
  if (!buildVersionPromise) {
    buildVersionPromise = (async function () {
      var v = readBuildVersion(xhs && xhs.launchOptions);
      if (v) return v;
      if (!miniTool || typeof miniTool.getLaunchOptions !== 'function') return 0;
      try { return readBuildVersion(await miniTool.getLaunchOptions()); } catch (e) { return 0; }
    })();
  }
  return buildVersionPromise;
}

async function canUse(method, minVersion) {
  if (!miniTool || typeof miniTool[method] !== 'function') return false;
  var v = await getBuildVersion();
  return Math.floor(v / 1000) >= minVersion;
}

async function saveLocal(str) {
  if (await canUse('setStorage', 9460)) {
    try { await miniTool.setStorage({ key: STORE_KEY, data: str }); return true; } catch (e) { /* 退回本地存储 */ }
  }
  try { localStorage.setItem(STORE_KEY, str); return true; } catch (e) { return false; }
}

async function loadLocal() {
  var raw = null;
  if (await canUse('getStorage', 9460)) {
    try {
      var res = await miniTool.getStorage({ key: STORE_KEY });
      raw = res ? res.data : null;
    } catch (e) { raw = null; }
  }
  if (raw === null || raw === undefined || raw === '') {
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
  }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// ============ 云存储（内测能力，需平台为 appId 开通；不可用时只用本地存档） ============
var CLOUD_COLL = 'save';
// ok：本次启动读云端成功才允许写，避免读失败时又新建一条重复存档
// unknown：写入结果未知时本次不再写，下次启动读云端对账
var cloud = { ok: false, id: null, unknown: false, chain: Promise.resolve() };

function hasCloud() {
  return !!(miniTool && typeof miniTool.queryCloudStorage === 'function' &&
    typeof miniTool.addCloudStorage === 'function' && typeof miniTool.updateCloudStorage === 'function');
}

function mergeSave(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  return {
    best: Math.max(local.best | 0, remote.best | 0),
    muted: local.muted !== undefined ? !!local.muted : !!remote.muted
  };
}

async function writeCloud(obj) {
  var content = { best: obj.best, muted: !!obj.muted };
  try {
    var r = cloud.id
      ? await miniTool.updateCloudStorage({ collection: CLOUD_COLL, items: [{ id: cloud.id, content: content }] })
      : await miniTool.addCloudStorage({ collection: CLOUD_COLL, items: [{ content: content }] });
    var it = r && r.data && r.data[0];
    if (it && it.status === 'SUCCESS' && it.id) cloud.id = it.id;
    else if (it && it.status === 'UNKNOWN') cloud.unknown = true;
  } catch (e) {
    var c = e && e.errCode;
    if (c === 2004) cloud.unknown = true;
    else if (c === 1006 || c === 10003) cloud.ok = false;
  }
}

async function saveData(obj) {
  var str;
  try { str = JSON.stringify(obj); } catch (e) { return false; }
  var ok = await saveLocal(str);
  if (cloud.ok && !cloud.unknown) {
    var snapshot = JSON.parse(str);
    cloud.chain = cloud.chain.then(function () { return writeCloud(snapshot); });
  }
  return ok;
}

async function loadData() {
  var local = await loadLocal();
  if (!hasCloud()) return local;
  try {
    var r = await miniTool.queryCloudStorage({ collection: CLOUD_COLL });
    var merged = local;
    ((r && r.items) || []).forEach(function (it) {
      if (!it || !it.content) return;
      merged = mergeSave(merged, it.content);
      if (!cloud.id) cloud.id = it.id;
    });
    cloud.ok = true;
    return merged;
  } catch (e) {
    return local;
  }
}

var canVibrate = false;
function vibrate(type) {
  if (!canVibrate) return;
  try {
    var p = miniTool.vibrateShort({ type: type || 'light' });
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (e) { /* 忽略 */ }
}

// ============ 音效 ============
var audio = null;
var saveState = { best: 0, muted: false };

function initAudio() {
  if (audio) {
    if (audio.state === 'suspended') audio.resume();
    return;
  }
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
}

function beep(freq, dur, type, vol, freqEnd) {
  if (!audio || saveState.muted) return;
  var t = audio.currentTime;
  var o = audio.createOscillator();
  var g = audio.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  g.gain.setValueAtTime(vol || 0.15, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g);
  g.connect(audio.destination);
  o.start(t);
  o.stop(t + dur);
}

// 连续完美时音高按五声音阶往上走
var DING = [523, 587, 659, 784, 880, 1046, 1175, 1318, 1568, 1760];
var sfx = {
  place: function () { beep(220, 0.08, 'triangle', 0.14, 140); },
  perfect: function (combo) {
    var f = DING[Math.min(combo - 1, DING.length - 1)];
    beep(f, 0.22, 'sine', 0.16);
    setTimeout(function () { beep(f * 2, 0.16, 'sine', 0.06); }, 30);
  },
  fail: function () { beep(330, 0.4, 'sine', 0.14, 110); }
};

// ============ 等角立体绘制 ============
function hsl(h, s, l) { return 'hsl(' + Math.round(h) + ',' + s + '%,' + l + '%)'; }

// P：投影参数 { ox, oy, s, camY }，世界坐标 x 向右下、z 向左下、y 向上
function iso(P, x, y, z) {
  return { x: P.ox + (x - z) * COS30 * P.s, y: P.oy + (x + z) * SIN30 * P.s - (y - P.camY) * P.s };
}

function poly(c, pts, fill) {
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (var i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  c.closePath();
  c.fillStyle = fill;
  c.fill();
}

function drawBox(c, P, b, h, alpha) {
  var x0 = b.cx - b.w / 2, x1 = b.cx + b.w / 2, z0 = b.cz - b.d / 2, z1 = b.cz + b.d / 2;
  var yt = b.y + h, yb = b.y;
  if (alpha !== undefined) { c.save(); c.globalAlpha = alpha; }
  poly(c, [iso(P, x1, yt, z0), iso(P, x1, yt, z1), iso(P, x1, yb, z1), iso(P, x1, yb, z0)], hsl(b.hue, 50, 50));
  poly(c, [iso(P, x0, yt, z1), iso(P, x1, yt, z1), iso(P, x1, yb, z1), iso(P, x0, yb, z1)], hsl(b.hue, 48, 40));
  poly(c, [iso(P, x0, yt, z0), iso(P, x1, yt, z0), iso(P, x1, yt, z1), iso(P, x0, yt, z1)], hsl(b.hue, 62, 66));
  if (alpha !== undefined) c.restore();
}

function topOutline(c, P, b, h, pad, color, width) {
  var x0 = b.cx - b.w / 2 - pad, x1 = b.cx + b.w / 2 + pad, z0 = b.cz - b.d / 2 - pad, z1 = b.cz + b.d / 2 + pad;
  var y = b.y + h;
  var pts = [iso(P, x0, y, z0), iso(P, x1, y, z0), iso(P, x1, y, z1), iso(P, x0, y, z1)];
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (var i = 1; i < 4; i++) c.lineTo(pts[i].x, pts[i].y);
  c.closePath();
  c.strokeStyle = color;
  c.lineWidth = width;
  c.stroke();
}

function paintBackdrop(c, w, h, hue) {
  var g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, hsl(hue, 28, 15));
  g.addColorStop(1, hsl(hue, 22, 7));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
}

function roundRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h);
  c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function setupCanvas(canvas, w, h) {
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  var c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c: c, dpr: dpr };
}

// 一座示意塔：首页、弹框、图标共用
function paintSampleTower(c, P, hue0, layers, slide) {
  var b = { cx: 0, cz: 0, w: BASE, d: BASE, y: -14, hue: hue0 };
  drawBox(c, P, b, 14);
  var w = BASE, d = BASE, cx = 0, cz = 0;
  for (var i = 0; i < layers; i++) {
    if (i % 3 === 2) { if (i % 2) { w -= 0.9; cx += 0.45; } else { d -= 0.9; cz -= 0.45; } }
    drawBox(c, P, { cx: cx, cz: cz, w: w, d: d, y: i * LAYER, hue: hue0 + (i + 1) * 6 }, LAYER);
  }
  if (slide) {
    var top = { cx: cx + slide, cz: cz, w: w, d: d, y: layers * LAYER, hue: hue0 + (layers + 1) * 6 };
    drawBox(c, P, top, LAYER);
  }
  return { cx: cx, cz: cz, w: w, d: d, y: layers * LAYER };
}

// ============ 首页大图 ============
function $(id) { return document.getElementById(id); }

function paintHeroArt(c, w, h) {
  paintBackdrop(c, w, h, 210);
  var s = Math.min(w, h * 0.8) / 34;
  var P = { ox: w * 0.64, oy: h * 0.36, s: s, camY: 8 };
  var top = paintSampleTower(c, P, 190, 11, 5.5);
  // 被切掉正在掉落的一小块
  drawBox(c, P, { cx: top.cx - top.w / 2 - 1.6, cz: top.cz + 0.8, w: 2.2, d: top.d, y: top.y - 3.2, hue: 262 }, LAYER, 0.85);
  // 完美对齐时的光圈
  topOutline(c, P, { cx: top.cx, cz: top.cz, w: top.w, d: top.d, y: top.y - LAYER }, LAYER, 0.7, 'rgba(255,255,255,0.75)', 2);

  var g2 = c.createLinearGradient(0, h * 0.5, 0, h);
  g2.addColorStop(0, 'rgba(13,16,22,0)');
  g2.addColorStop(1, 'rgba(13,16,22,0.88)');
  c.fillStyle = g2;
  c.fillRect(0, h * 0.5, w, h * 0.5);
}

function drawHero() {
  var box = $('hero');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  var s = setupCanvas($('hero-cv'), w, h);
  paintHeroArt(s.c, w, h);
}

function drawDialogArt() {
  var box = $('dlg-art');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  box.innerHTML = '';
  var cnv = document.createElement('canvas');
  box.appendChild(cnv);
  var c = setupCanvas(cnv, w, h).c;
  paintBackdrop(c, w, h, 210);
  var P = { ox: w * 0.5, oy: h * 0.48, s: h / 15, camY: 3 };
  paintSampleTower(c, P, 330, 5, 3);
}

// ============ 游戏状态 ============
var S = null;

function startRun() {
  var hue0 = HUES[Math.floor(Math.random() * HUES.length)];
  S = {
    hue0: hue0,
    stack: [{ cx: 0, cz: 0, w: BASE, d: BASE, y: 0, hue: hue0 }],
    cur: null, falling: [], rings: [], floats: [],
    score: 0, combo: 0, maxCombo: 0, perfects: 0,
    status: 'play', revived: false, reviveReady: false, newBest: false, rank: null,
    camY: LAYER, zoom: 1, zoomTarget: 1, camTarget: LAYER, clock: 0
  };
  spawn();
  hideOverlay();
  updateBar();
}

function topLayer() { return S.stack[S.stack.length - 1]; }

function spawn() {
  var t = topLayer();
  var axis = S.score % 2 ? 'z' : 'x';
  S.cur = {
    cx: t.cx, cz: t.cz, w: t.w, d: t.d, y: t.y + LAYER,
    hue: S.hue0 + (S.stack.length) * 6,
    axis: axis, off: -RANGE, dir: 1, speed: speedFor(S.score)
  };
  if (axis === 'x') S.cur.cx = t.cx - RANGE; else S.cur.cz = t.cz - RANGE;
}

function drop() {
  if (!S || S.status !== 'play' || !S.cur) return;
  var t = topLayer(), b = S.cur;
  var key = b.axis === 'x' ? 'cx' : 'cz', size = b.axis === 'x' ? 'w' : 'd';
  var delta = b[key] - t[key];
  var layer = { cx: b.cx, cz: b.cz, w: b.w, d: b.d, y: b.y, hue: b.hue };

  if (Math.abs(delta) <= PERFECT) {
    layer[key] = t[key];
    S.combo++;
    S.perfects++;
    S.maxCombo = Math.max(S.maxCombo, S.combo);
    if (S.combo >= GROW_AFTER) layer[size] = Math.min(BASE, layer[size] + GROW);
    S.rings.push({ b: layer, life: 0.5 });
    S.floats.push({ text: S.combo > 1 ? '完美 ×' + S.combo : '完美', life: 0.9, y: layer.y + LAYER * 2 });
    sfx.perfect(S.combo);
    vibrate('medium');
  } else {
    var overlap = t[size] - Math.abs(delta);
    if (overlap <= 0) {
      S.falling.push({ b: layer, vy: 0 });
      S.cur = null;
      gameOver();
      return;
    }
    S.combo = 0;
    layer[size] = overlap;
    layer[key] = t[key] + delta / 2;
    var cut = { cx: layer.cx, cz: layer.cz, w: layer.w, d: layer.d, y: layer.y, hue: layer.hue };
    cut[size] = Math.abs(delta);
    cut[key] = layer[key] + (delta > 0 ? 1 : -1) * (overlap / 2 + Math.abs(delta) / 2);
    S.falling.push({ b: cut, vy: 0 });
    sfx.place();
    vibrate('light');
  }

  S.stack.push(layer);
  S.score++;
  S.camTarget = layer.y + LAYER;
  spawn();
  updateBar();
}

function gameOver() {
  S.status = 'fail';
  sfx.fail();
  vibrate('heavy');
  // 拉远镜头看整座塔
  var towerH = S.stack.length * LAYER + 6;
  S.zoomTarget = Math.min(1, (H * 0.62) / (towerH * view.s0));
  S.camTarget = (S.stack.length * LAYER) / 2;
  S.newBest = S.score > saveState.best;
  if (S.newBest) { saveState.best = S.score; saveData(saveState); }
  var run = S;
  submitScore(S.score).then(function (r) {
    run.rank = r;
    if (S === run && !$('overlay').classList.contains('hidden') && r) $('r-hint').textContent = resultHint(run);
  });
  setTimeout(showFail, 1100);
}

function revive() {
  S.revived = true;
  S.reviveReady = false;
  S.status = 'play';
  S.zoomTarget = 1;
  S.camTarget = topLayer().y + LAYER;
  S.combo = 0;
  spawn();
  hideOverlay();
  updateBar();
}

// ============ 游戏画布 ============
var cv = $('cv');
var ctx = cv.getContext('2d');
var view = { scale: 1, ox: 0, oy: 0, dpr: 1, s0: 14 };

function resizeGame() {
  var stage = $('stage');
  var cw = stage.clientWidth, ch = stage.clientHeight;
  if (!cw || !ch) return;
  H = Math.round(Math.max(600, Math.min(900, W * ch / cw)));
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.style.width = cw + 'px';
  cv.style.height = ch + 'px';
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  var sc = Math.min(cw / W, ch / H);
  view = { scale: sc, ox: (cw - W * sc) / 2, oy: (ch - H * sc) / 2, dpr: dpr, s0: (W * 0.6) / (2 * BASE * COS30) };
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!S) return;
  var px = view.dpr * view.scale;
  ctx.setTransform(px, 0, 0, px, view.dpr * view.ox, view.dpr * view.oy);

  var topHue = S.cur ? S.cur.hue : topLayer().hue;
  paintBackdrop(ctx, W, H, topHue);

  var P = { ox: W / 2, oy: H * 0.56, s: view.s0 * S.zoom, camY: S.camY };
  var t = topLayer();

  // 掉落块：在塔后面的先画，在前面的后画
  var back = [], front = [];
  S.falling.forEach(function (f) {
    ((f.b.cx + f.b.cz) < (t.cx + t.cz) ? back : front).push(f);
  });
  back.forEach(function (f) { drawBox(ctx, P, f.b, LAYER, 0.9); });

  drawBox(ctx, P, { cx: 0, cz: 0, w: BASE, d: BASE, y: -40, hue: S.hue0 }, 40);
  S.stack.forEach(function (b, i) { if (i > 0) drawBox(ctx, P, b, LAYER); });
  if (S.cur) drawBox(ctx, P, S.cur, LAYER);

  front.forEach(function (f) { drawBox(ctx, P, f.b, LAYER, 0.9); });

  S.rings.forEach(function (r) {
    var k = 1 - r.life / 0.5;
    topOutline(ctx, P, r.b, LAYER, 0.2 + k * 1.6, 'rgba(255,255,255,' + (r.life / 0.5 * 0.85).toFixed(2) + ')', 2.5);
  });

  // 分数
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '900 64px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(String(S.score), W / 2, 70);

  S.floats.forEach(function (f) {
    var p = iso(P, t.cx, f.y + (0.9 - f.life) * 2, t.cz);
    ctx.globalAlpha = Math.min(1, f.life / 0.5);
    ctx.font = '900 20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(f.text, p.x, p.y - 30);
    ctx.fillStyle = '#fff';
    ctx.fillText(f.text, p.x, p.y - 30);
  });
  ctx.globalAlpha = 1;

  if (S.status === 'play' && S.score === 0) {
    ctx.font = '700 16px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText('点一下屏幕，让方块落下', W / 2, H - 50);
  }
}

// ============ 主循环 ============
var last = 0, running = true, inGame = false;

function step(dt) {
  if (!S) return;
  S.clock += dt;
  var b = S.cur;
  if (S.status === 'play' && b) {
    var t = topLayer();
    var key = b.axis === 'x' ? 'cx' : 'cz';
    b.off += b.dir * b.speed * dt;
    if (b.off > RANGE) { b.off = RANGE; b.dir = -1; }
    if (b.off < -RANGE) { b.off = -RANGE; b.dir = 1; }
    b[key] = t[key] + b.off;
  }
  S.falling = S.falling.filter(function (f) {
    f.vy += 40 * dt;
    f.b.y -= f.vy * dt;
    return f.b.y > S.camY - 60;
  });
  S.rings = S.rings.filter(function (r) { r.life -= dt; return r.life > 0; });
  S.floats = S.floats.filter(function (f) { f.life -= dt; return f.life > 0; });
  S.camY += (S.camTarget - S.camY) * Math.min(1, dt * 6);
  S.zoom += (S.zoomTarget - S.zoom) * Math.min(1, dt * 3);
}

function loop(ts) {
  if (!running) return;
  var dt = last ? Math.min(ts - last, 50) / 1000 : 0.016;
  last = ts;
  if (inGame) {
    step(dt);
    render();
  }
  requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    running = false;
  } else if (!running) {
    running = true;
    last = 0;
    requestAnimationFrame(loop);
  }
});

// ============ 输入 ============
function onTap() { initAudio(); drop(); }

if (window.PointerEvent) {
  cv.addEventListener('pointerdown', function (e) { e.preventDefault(); onTap(); });
} else {
  cv.addEventListener('touchstart', function (e) { e.preventDefault(); onTap(); }, { passive: false });
  cv.addEventListener('mousedown', onTap);
}
window.addEventListener('keydown', function (e) {
  if ((e.key === ' ' || e.key === 'Enter') && inGame) { e.preventDefault(); onTap(); }
});

// ============ 页面切换 ============
var ARROW = '<svg class="arrow" viewBox="0 0 24 24"><path d="M3 12h16M13 6l6 6-6 6"/></svg>';

function showHome() {
  inGame = false;
  hideOverlay();
  $('game').classList.add('hidden');
  $('home').classList.remove('hidden');
  renderHome();
  drawHero();
}

function showGame() {
  initAudio();
  $('home').classList.add('hidden');
  $('game').classList.remove('hidden');
  resizeGame();
  startRun();
  inGame = true;
}

function renderHome() {
  $('home-best').innerHTML = saveState.best > 0
    ? '最高叠到 <b>' + saveState.best + ' 层</b>'
    : '点一下屏幕，方块就落下';
  $('btn-start').innerHTML = '开始堆塔' + ARROW;
  $('nav-sound').classList.toggle('muted', !!saveState.muted);
  $('sound-label').textContent = saveState.muted ? '声音 关' : '声音 开';
  renderFollow();
}

function updateBar() {
  $('level').textContent = '第 ' + S.score + ' 层';
  $('progress').textContent = '最佳 ' + Math.max(saveState.best, S.score) + ' 层' + (S.combo > 1 ? ' · 连续完美 ' + S.combo : '');
  $('bar-fill').style.width = (saveState.best ? Math.min(100, S.score / saveState.best * 100) : 0) + '%';
}

$('btn-start').addEventListener('click', showGame);
$('btn-back').addEventListener('click', showHome);
$('btn-restart').addEventListener('click', function () { initAudio(); startRun(); });
$('nav-rank').addEventListener('click', function () { openRank('day'); });

$('nav-sound').addEventListener('click', function () {
  saveState.muted = !saveState.muted;
  saveData(saveState);
  renderHome();
  if (!saveState.muted) { initAudio(); sfx.place(); }
});

$('nav-help').addEventListener('click', function () {
  openDialog({
    kicker: '怎么玩',
    title: '玩法说明',
    html: '<ol><li>方块会左右来回滑，点一下屏幕它就落下。</li>' +
          '<li>没对齐的部分会被切掉，方块越来越窄，越往上越难。</li>' +
          '<li>正好对齐会「叮」一声，连续对齐 ' + GROW_AFTER + ' 次以上，方块会慢慢变宽回来。</li>' +
          '<li>方块完全没放上去就结束了，发一篇笔记可以复活一次。</li>' +
          '<li>叠了多少层会上排行榜。</li></ol>',
    main: '知道了',
    onMain: closeDialog
  });
});

function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () { el.classList.add('hidden'); }, 2200);
}

// ============ 弹框 ============
function openDialog(o) {
  $('dlg-kicker').textContent = o.kicker || '';
  $('dlg-title').textContent = o.title || '';
  $('dlg-body').innerHTML = o.html || '';
  var main = $('dlg-main');
  main.textContent = o.main || '';
  main.disabled = false;
  main.onclick = o.onMain || null;
  var second = $('dlg-second');
  second.textContent = o.second || '';
  second.classList.toggle('hidden', !o.second);
  second.onclick = o.onSecond || null;
  $('dlg-art').classList.toggle('hidden', !o.art);
  $('dialog').classList.remove('hidden');
  if (o.art) drawDialogArt();
}

function closeDialog() { $('dialog').classList.add('hidden'); }

// ============ 关注作者（客户端 9.51+） ============
var follow = { supported: false, status: -1, pending: false };

async function initFollow() {
  follow.supported = await canUse('followAuthor', 9510) && typeof miniTool.getFollowStatus === 'function';
  if (follow.supported) {
    try {
      var r = await miniTool.getFollowStatus();
      follow.status = r && typeof r.follow_status === 'number' ? r.follow_status : -1;
    } catch (e) { follow.status = -1; }
  }
  renderFollow();
}

function isFollowed() { return follow.status === 1 || follow.status === 2; }

function renderFollow() {
  var btn = $('nav-follow');
  btn.classList.toggle('hidden', !!miniTool && !follow.supported);
  btn.classList.toggle('followed', isFollowed());
  $('follow-label').textContent = follow.status === 2 ? '我是作者' : (follow.status === 1 ? '已关注作者' : '关注作者');
}

async function doFollow() {
  if (!follow.supported) {
    toast('预览环境没有关注功能，在小红书里打开就能关注');
    return false;
  }
  if (follow.pending) return false;
  follow.pending = true;
  try {
    var r = await miniTool.followAuthor();
    if (r && typeof r.follow_status === 'number') follow.status = r.follow_status;
    if (follow.status === 1) toast('关注成功，谢谢支持');
    else if (follow.status === -1) toast('关注没成功，稍后再试试');
  } catch (e) {
    if (e && e.errCode === 15404) toast('今天的关注提醒次数用完了');
  }
  follow.pending = false;
  renderFollow();
  return isFollowed();
}

$('nav-follow').addEventListener('click', function () {
  if (isFollowed()) { toast(follow.status === 2 ? '这是你自己做的小游戏' : '已经关注啦，谢谢支持'); return; }
  doFollow();
});

function maybeAskFollow() {
  var inPreview = !miniTool;
  if (!inPreview && (!follow.supported || isFollowed() || follow.status === -1)) return;
  openDialog({
    art: true,
    kicker: '叠叠高的作者',
    title: '关注一下作者',
    html: '作者还会继续做新的小游戏，关注之后，在作者主页就能找到。',
    main: '关注作者',
    onMain: async function () {
      var main = $('dlg-main');
      main.disabled = true;
      var ok = await doFollow();
      main.disabled = false;
      if (ok || !follow.supported) closeDialog();
    },
    second: '先玩游戏',
    onSecond: closeDialog
  });
}

// ============ 结算 ============
function fillSheet(o) {
  $('r-kicker').textContent = o.kicker;
  $('r-num').textContent = o.num;
  $('r-unit').textContent = o.unit;
  $('r-tag').textContent = o.tag;
  $('r-title').textContent = o.title;
  $('r-sub').textContent = o.sub;
  var dl = $('r-stats');
  dl.innerHTML = '';
  o.stats.forEach(function (row) {
    var d = document.createElement('div');
    var dt = document.createElement('dt');
    var dd = document.createElement('dd');
    dt.textContent = row[0];
    dd.textContent = row[1];
    d.appendChild(dt);
    d.appendChild(dd);
    dl.appendChild(d);
  });
  $('r-fill').style.width = Math.round(Math.min(1, o.pct) * 100) + '%';
  $('r-hint').textContent = o.hint;

  var main = $('r-main');
  main.innerHTML = o.main + (o.mainArrow ? ARROW : '');
  main.disabled = false;
  main.onclick = o.onMain;
  $('r-note').textContent = o.note || '';

  [['r-second', 'second', 'onSecond'], ['r-third', 'third', 'onThird'], ['r-fourth', 'fourth', 'onFourth']].forEach(function (b) {
    var el = $(b[0]);
    el.textContent = o[b[1]] || '';
    el.classList.toggle('hidden', !o[b[1]]);
    el.onclick = o[b[2]] || null;
  });
  $('overlay').classList.remove('hidden');
  $('overlay').scrollTop = 0;
}

function hideOverlay() { $('overlay').classList.add('hidden'); }

function resultHint(run) {
  var r = run.rank;
  var rankText = '';
  if (r && r.status === 'EXACT') rankText = '今天排第 ' + r.rank + ' 名';
  else if (r && r.status === 'OVER_LIMIT') rankText = '今天排在 10000 名以外';
  if (run.newBest) return '新纪录！' + (rankText ? ' · ' + rankText : '');
  return rankText || ('离最佳还差 ' + Math.max(0, saveState.best - run.score) + ' 层');
}

function showFail() {
  var canRevive = !S.revived;
  var o = {
    kicker: '本局成绩',
    num: String(S.score),
    unit: '层',
    tag: S.newBest ? '新纪录' : '本局',
    title: '没放上去',
    sub: canRevive ? '发一篇笔记就能接着往上叠。' : '这局的复活机会用过了，再来一局吧。',
    stats: [['完美对齐', S.perfects + ' 次'], ['最长连续完美', S.maxCombo + ' 次'], ['历史最佳', saveState.best + ' 层']],
    pct: saveState.best ? S.score / saveState.best : 1,
    hint: resultHint(S)
  };
  if (canRevive) {
    o.main = '发笔记复活'; o.mainArrow = true; o.onMain = onReviveClick;
    o.note = '发布成功后手动继续 · 每局一次';
    o.second = '再来一局'; o.onSecond = startRun;
  } else {
    o.main = '再来一局'; o.mainArrow = true; o.onMain = startRun;
    o.second = '发笔记晒成绩'; o.onSecond = function () { shareNote(false); };
  }
  o.third = '看排行榜'; o.onThird = function () { openRank('day'); };
  o.fourth = '返回主页'; o.onFourth = showHome;
  fillSheet(o);
}

async function onReviveClick() {
  var main = $('r-main');
  if (S.reviveReady) { revive(); return; }
  if (!miniTool || typeof miniTool.postNote !== 'function') {
    S.reviveReady = true;
    main.innerHTML = '继续堆' + ARROW;
    $('r-note').textContent = '当前不在小红书里，预览环境直接给复活';
    return;
  }
  main.disabled = true;
  main.textContent = '正在打开发布页…';
  var ok = await shareNote(true);
  main.disabled = false;
  if (ok) {
    S.reviveReady = true;
    main.innerHTML = '继续堆' + ARROW;
    $('r-note').textContent = '笔记已发布，点继续接着叠';
  } else {
    main.innerHTML = '发笔记复活' + ARROW;
    toast('没有发布成功，可以再试一次');
  }
}

// ============ 排行榜（内测能力，需平台为 appId 开通；按叠的层数排） ============
var BOARD = 1;
var PERIODS = [['day', '日榜'], ['week', '周榜'], ['month', '月榜'], ['all', '总榜']];
var rankOff = false;
var rankReq = 0;

function hasRank() {
  return !!(miniTool && typeof miniTool.submitScore === 'function' &&
    typeof miniTool.getRankList === 'function' && typeof miniTool.getMyRank === 'function');
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// 2002 是榜单还没算好，不能当成空榜，按 0.5/1/2/4 秒退避重试
async function withRetry(fn) {
  var waits = [500, 1000, 2000, 4000];
  for (var i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (e && e.errCode === 2002 && i < waits.length) { await sleep(waits[i]); continue; }
      throw e;
    }
  }
}

function rankError(e) {
  var c = e && e.errCode;
  if (c === 1005 || c === 10003) { rankOff = true; return '排行榜还没开通'; }
  if (c === 2002) return '榜单还在计算，稍后再看';
  if (c === 2008) return '排行榜暂时连不上，稍后再试';
  return '排行榜加载失败，稍后再试';
}

async function submitScore(score) {
  if (!hasRank() || rankOff || score <= 0) return null;
  try {
    await miniTool.submitScore({ board: BOARD, score: score });
    return await withRetry(function () { return miniTool.getMyRank({ board: BOARD, period: 'day' }); });
  } catch (e) {
    rankError(e);
    return null;
  }
}

function openRank(period) {
  var tabs = '<div class="rk-periods">';
  PERIODS.forEach(function (p) {
    tabs += '<button type="button" data-period="' + p[0] + '"' + (p[0] === period ? ' class="active"' : '') + '>' + p[1] + '</button>';
  });
  tabs += '</div>';
  openDialog({
    kicker: '叠得越高排越前',
    title: '排行榜',
    html: tabs + '<div class="rk-list" id="rk-list"></div><div class="rk-mine" id="rk-mine"></div>',
    main: '关闭',
    onMain: closeDialog
  });
  loadRank(period);
}

function emptyNote(el, text) {
  el.innerHTML = '';
  var p = document.createElement('p');
  p.className = 'rk-empty';
  p.textContent = text;
  el.appendChild(p);
}

function localBestText() {
  return saveState.best ? '你的最佳 ' + saveState.best + ' 层' : '你还没有成绩';
}

async function loadRank(period) {
  var req = ++rankReq;
  var list = $('rk-list'), mine = $('rk-mine');
  if (!hasRank()) {
    emptyNote(list, '在小红书里打开才能看排行榜');
    mine.textContent = localBestText();
    return;
  }
  if (rankOff) {
    emptyNote(list, '排行榜还没开通');
    mine.textContent = localBestText();
    return;
  }
  emptyNote(list, '加载中…');
  mine.textContent = '';
  try {
    var res = await withRetry(function () { return miniTool.getRankList({ board: BOARD, period: period }); });
    var me = await withRetry(function () { return miniTool.getMyRank({ board: BOARD, period: period }); });
    if (req !== rankReq) return;
    renderRankList(list, (res && res.data) || []);
    renderMyRank(mine, me);
  } catch (e) {
    if (req !== rankReq) return;
    emptyNote(list, rankError(e));
    mine.textContent = localBestText();
  }
}

// 昵称来自其他玩家，一律按纯文本写入，不拼 HTML
function renderRankList(el, rows) {
  el.innerHTML = '';
  if (!rows.length) { emptyNote(el, '这一期还没人上榜，来当第一个'); return; }
  rows.forEach(function (row) {
    var line = document.createElement('div');
    line.className = 'rk-row' + (row.rank <= 3 ? ' top' : '');
    var no = document.createElement('span');
    no.className = 'rk-no';
    no.textContent = row.rank;
    var ava = document.createElement('span');
    ava.className = 'rk-ava';
    var nick = row.nickname || '小红薯';
    ava.textContent = nick.charAt(0);
    if (row.avatar) {
      var img = document.createElement('img');
      img.alt = '';
      img.addEventListener('load', function () { ava.textContent = ''; ava.appendChild(img); });
      img.src = row.avatar;
    }
    var name = document.createElement('span');
    name.className = 'rk-name';
    name.textContent = nick;
    var score = document.createElement('span');
    score.className = 'rk-score';
    score.textContent = Math.round(Number(row.score) || 0) + ' 层';
    line.appendChild(no); line.appendChild(ava); line.appendChild(name); line.appendChild(score);
    el.appendChild(line);
  });
}

function renderMyRank(el, me) {
  el.innerHTML = '';
  var b = document.createElement('b');
  if (me && me.status === 'EXACT') {
    el.appendChild(document.createTextNode('我排第 '));
    b.textContent = me.rank;
    el.appendChild(b);
    el.appendChild(document.createTextNode(' 名 · ' + Math.round(Number(me.score) || 0) + ' 层'));
  } else if (me && me.status === 'OVER_LIMIT') {
    b.textContent = '10000+';
    el.appendChild(document.createTextNode('我排在 '));
    el.appendChild(b);
    el.appendChild(document.createTextNode(' · ' + Math.round(Number(me.score) || 0) + ' 层'));
  } else {
    el.textContent = '这一期你还没有成绩，' + (saveState.best ? '本机最佳 ' + saveState.best + ' 层' : '去叠一局');
  }
}

$('dlg-body').addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('button[data-period]') : null;
  if (!btn) return;
  var all = $('dlg-body').querySelectorAll('button[data-period]');
  for (var i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === btn);
  loadRank(btn.getAttribute('data-period'));
});

// ============ 分享图与发笔记 ============
function makeShareImage(isFail) {
  var c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  var x = c.getContext('2d');
  paintBackdrop(x, 900, 1200, S.hue0 + S.stack.length * 6);

  var gh = 760, gw = gh * W / H;
  var gx = (900 - gw) / 2, gy = 1200 - gh - 30;
  x.drawImage(cv,
    view.ox * view.dpr, view.oy * view.dpr, W * view.scale * view.dpr, H * view.scale * view.dpr,
    gx, gy, gw, gh);

  var font = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  x.textBaseline = 'top';
  x.fillStyle = '#ffffff';
  x.font = '900 46px ' + font;
  x.fillText('叠叠', 56, 56);
  x.fillStyle = '#ff3b4f';
  x.fillText('高', 56 + x.measureText('叠叠').width + 6, 56);
  x.fillStyle = '#ffffff';
  x.font = 'italic 900 130px ' + font;
  x.fillText(S.score + ' 层', 50, 120);
  x.font = '800 40px ' + font;
  x.fillStyle = '#66dcff';
  x.fillText(S.perfects ? '完美对齐 ' + S.perfects + ' 次，最多连续 ' + S.maxCombo + ' 次' : '一次完美都没有', 56, 282);
  x.fillStyle = 'rgba(255,255,255,0.65)';
  x.font = '600 30px ' + font;
  x.fillText(isFail ? '你能叠多高' : '来比比谁叠得高', 56, 346);
  return c.toDataURL('image/jpeg', 0.88);
}

async function toFilePath(dataUrl) {
  if (miniTool && typeof miniTool.writeTempFile === 'function') {
    try {
      var r = await miniTool.writeTempFile({ data: dataUrl });
      if (r && r.filePath) return r.filePath;
    } catch (e) { /* 退回 data URI */ }
  }
  return dataUrl;
}

async function shareNote(isFail) {
  if (!miniTool || typeof miniTool.postNote !== 'function') {
    toast('请在小红书里打开再发笔记');
    return false;
  }
  try {
    var url = await toFilePath(makeShareImage(isFail));
    await miniTool.postNote({
      title: '叠叠高叠到了' + S.score + '层',
      content: '小工具「叠叠高」，方块来回滑，点一下落下，没对齐就切掉。我叠到了' + S.score + '层，你能叠多高？ #堆塔 #小游戏',
      pageType: 'photo_publish',
      mediaInfo: { image_resources: [{ url: url }] }
    });
    return true;
  } catch (e) {
    return false;
  }
}

// ============ 避让小红书顶部按钮（getWindowInfo，客户端 9.49+） ============
async function applyTopInset() {
  if (!miniTool) return;
  var root = document.documentElement;
  root.style.setProperty('--top-inset', 'calc(var(--safe-top) + 52px)');
  if (!(await canUse('getWindowInfo', 9490))) return;
  try {
    var info = await miniTool.getWindowInfo();
    var mb = (info && info.menuButtons) || {};
    var bottom = 0;
    ['back', 'me', 'share'].forEach(function (k) {
      if (mb[k] && typeof mb[k].bottom === 'number') bottom = Math.max(bottom, mb[k].bottom);
    });
    if (!bottom && info && typeof info.statusBarHeight === 'number') bottom = info.statusBarHeight;
    if (bottom) root.style.setProperty('--top-inset', Math.ceil(bottom + 6) + 'px');
  } catch (e) { /* 保留默认避让 */ }
}

// ============ 启动 ============
window.addEventListener('resize', function () {
  if (inGame) resizeGame(); else drawHero();
});

(async function boot() {
  var d = await loadData();
  if (d) {
    saveState.best = Math.max(0, d.best | 0);
    saveState.muted = !!d.muted;
  }
  await applyTopInset();
  canVibrate = await canUse('vibrateShort', 9500);
  showHome();
  requestAnimationFrame(loop);
  await initFollow();
  setTimeout(maybeAskFollow, 350);
})();

})();
