(function () {
'use strict';

// ============ 常量 ============
var W = 390;
var H = 700;                 // 逻辑高度随屏幕比例调整，见 resizeGame
var BASE = 10;               // 底座边长（世界单位）
var LAYER = 1.2;             // 每层厚度
var RANGE = 13;              // 方块来回滑动的距离
var GROW_AFTER = 4;          // 连续完美几次后开始变宽
var GROW = 0.5;
var COS30 = 0.866, SIN30 = 0.5;
// 每局随机一个底色，往上叠时在它附近来回摆，不会摆到紫色去
var HUES = [8, 28, 168, 195, 352];
function hueAt(hue0, n) { return hue0 + 22 * Math.sin(n * 0.22); }

var LEVELS = 20;

// 难度用模拟玩家（按点击时机误差）测过：无限模式一般人 25~35 层，闯关前 5 关基本能过，10 关以后要有手感
// jitterFrom：从第几层起每块速度随机快慢；flipFrom：从第几层起方块可能从另一边滑出来
function endlessCfg() {
  return { target: 0, perfect: 0.22, jitterFrom: 12, flipFrom: 25,
    speed: function (s) { return Math.min(11 + s * 0.28, 27); } };
}

function levelCfg(n) {
  return {
    target: Math.min(9 + 2 * n, 19 + n),
    perfect: Math.max(0.18, 0.3 - 0.005 * n),
    jitterFrom: n >= 4 ? Math.max(3, 12 - n) : 999,
    flipFrom: n >= 7 ? Math.max(4, 20 - n) : 999,
    speed: function (s) { return Math.min(9.5 + 0.35 * n + s * 0.2, 27); }
  };
}

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
    level: Math.max(local.level | 0, remote.level | 0),
    cleared: Math.max(local.cleared | 0, remote.cleared | 0),
    muted: local.muted !== undefined ? !!local.muted : !!remote.muted,
    mode: local.mode || remote.mode
  };
}

async function writeCloud(obj) {
  var content = { best: obj.best, level: obj.level, cleared: obj.cleared, muted: !!obj.muted, mode: obj.mode };
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
// best：无限模式最高层数（上排行榜）；level：闯关已解锁到第几关；cleared：最高通过第几关
var saveState = { best: 0, level: 1, cleared: 0, muted: false, mode: 'level' };

function initAudio() {
  if (audio) {
    if (audio.state === 'suspended') audio.resume();
    return;
  }
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
}

function beep(freq, dur, type, vol, freqEnd, delay) {
  if (!audio || saveState.muted) return;
  var t = audio.currentTime + (delay || 0);
  toneAt(sfxOut(), t, freq, freqEnd, dur, vol || 0.15, type || 'sine');
}

// 音效统一走一路总音量，再进 destination
var sfxBus = null;
function sfxOut() {
  if (!sfxBus) { sfxBus = audio.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(audio.destination); }
  return sfxBus;
}

function toneAt(dest, t, freq, freqEnd, dur, vol, type) {
  var o = audio.createOscillator();
  var g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
}

var noiseBuf = null;
function getNoise() {
  if (!noiseBuf) {
    noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// kind：lowpass / highpass / bandpass
function noiseAt(dest, t, dur, vol, kind, freq, freqEnd) {
  var src = audio.createBufferSource();
  src.buffer = getNoise();
  var f = audio.createBiquadFilter();
  f.type = kind;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  var g = audio.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(dest);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

// C 大调五声音阶，和背景音乐同一个调，连续完美时一级一级往上走
var DING = [523.3, 587.3, 659.3, 784, 880, 1046.5, 1174.7, 1318.5, 1568, 1760];
var sfx = {
  // 木块落下的一声闷响，越往上音稍微高一点
  place: function (h) {
    if (!audio || saveState.muted) return;
    var t = audio.currentTime, k = Math.min(1, (h || 0) / 40);
    toneAt(sfxOut(), t, 190 + k * 60, 80, 0.14, 0.22, 'triangle');
    noiseAt(sfxOut(), t, 0.07, 0.16, 'bandpass', 1100 + k * 400);
  },
  // 多出来的一截被切掉
  cut: function () {
    if (!audio || saveState.muted) return;
    noiseAt(sfxOut(), audio.currentTime + 0.02, 0.22, 0.09, 'highpass', 6000, 1800);
  },
  perfect: function (combo) {
    if (!audio || saveState.muted) return;
    var t = audio.currentTime;
    var f = DING[Math.min(combo - 1, DING.length - 1)];
    toneAt(sfxOut(), t, 160, 90, 0.1, 0.12, 'triangle');
    toneAt(sfxOut(), t, f, 0, 0.5, 0.14, 'sine');
    toneAt(sfxOut(), t + 0.03, f * 2, 0, 0.3, 0.05, 'sine');
    toneAt(sfxOut(), t + 0.03, f * 1.5, 0, 0.35, 0.035, 'triangle');
  },
  // 方块开始变宽
  grow: function () {
    if (!audio || saveState.muted) return;
    var t = audio.currentTime + 0.12;
    [1046.5, 1318.5, 1568, 2093].forEach(function (f, i) { toneAt(sfxOut(), t + i * 0.045, f, 0, 0.22, 0.04, 'sine'); });
  },
  fail: function () {
    if (!audio || saveState.muted) return;
    var t = audio.currentTime;
    toneAt(sfxOut(), t, 330, 70, 0.7, 0.12, 'sawtooth');
    toneAt(sfxOut(), t, 220, 55, 0.8, 0.14, 'triangle');
    noiseAt(sfxOut(), t + 0.05, 0.6, 0.22, 'lowpass', 900, 120);
  },
  clear: function () {
    if (!audio || saveState.muted) return;
    var t = audio.currentTime;
    [523.3, 659.3, 784, 1046.5].forEach(function (f, i) {
      toneAt(sfxOut(), t + i * 0.09, f, 0, 0.5, 0.13, 'triangle');
      toneAt(sfxOut(), t + i * 0.09, f * 2, 0, 0.3, 0.03, 'sine');
    });
    [523.3, 659.3, 784].forEach(function (f) { toneAt(sfxOut(), t + 0.4, f, 0, 1.1, 0.07, 'sine'); });
  },
  click: function () { beep(660, 0.06, 'triangle', 0.08); }
};

// ============ 背景音乐：现场合成，跟着塔的高度变快、加乐器 ============
// 和弦走 C - Am - F - G，每小节 16 个十六分音符
var CHORDS = [
  { root: 130.8, notes: [261.6, 329.6, 392, 523.3] },
  { root: 110, notes: [220, 261.6, 329.6, 440] },
  { root: 87.3, notes: [174.6, 220, 261.6, 349.2] },
  { root: 98, notes: [196, 246.9, 293.7, 392] }
];
var ARP = [0, 1, 2, 3, 2, 1, 2, 3];
var music = { on: false, n: null, next: 0, step: 0, heat: 0 };

function musicStart() {
  if (!audio || saveState.muted || music.on) return;
  var t = audio.currentTime;
  var master = audio.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.exponentialRampToValueAtTime(0.55, t + 0.6);
  master.connect(audio.destination);
  // 垫底的长音，换和弦时滑过去
  var padF = audio.createBiquadFilter();
  padF.type = 'lowpass';
  padF.frequency.value = 700;
  var padG = audio.createGain();
  padG.gain.value = 0.045;
  padF.connect(padG); padG.connect(master);
  var pads = [0, 1].map(function (i) {
    var o = audio.createOscillator();
    o.type = 'triangle';
    o.frequency.value = CHORDS[0].notes[i] / 2;
    o.detune.value = i ? 6 : -6;
    o.connect(padF);
    o.start(t);
    return o;
  });
  music.n = { master: master, pads: pads, padF: padF };
  music.on = true;
  music.step = 0;
  music.next = t + 0.08;
}

function musicStop(fade) {
  if (!music.on) return;
  music.on = false;
  var n = music.n, t = audio.currentTime;
  n.master.gain.cancelScheduledValues(t);
  n.master.gain.setValueAtTime(n.master.gain.value, t);
  n.master.gain.linearRampToValueAtTime(0.0001, t + (fade || 0.3));
  n.pads.forEach(function (o) { o.stop(t + (fade || 0.3) + 0.05); });
  setTimeout(function () { try { n.master.disconnect(); } catch (e) { /* 已断开 */ } }, ((fade || 0.3) + 0.2) * 1000);
}

// heat 0~1：越接近目标 / 叠得越高，节奏越快、乐器越多
function musicUpdate(heat) {
  if (!music.on) return;
  music.heat += (heat - music.heat) * 0.05;
  var h = music.heat;
  var bpm = 100 + h * 36;
  var sixteenth = 60 / bpm / 4;
  var n = music.n, out = n.master;
  while (music.next < audio.currentTime + 0.12) {
    var t = music.next, st = music.step % 16;
    var chord = CHORDS[Math.floor(music.step / 16) % 4];
    if (st === 0) {
      n.pads[0].frequency.setTargetAtTime(chord.notes[0] / 2, t, 0.08);
      n.pads[1].frequency.setTargetAtTime(chord.notes[2] / 2, t, 0.08);
      n.padF.frequency.setTargetAtTime(600 + h * 900, t, 0.3);
    }
    // 底鼓
    if (st === 0 || st === 8 || (h > 0.35 && (st === 4 || st === 12)) || (h > 0.75 && st === 14)) {
      toneAt(out, t, 140, 42, 0.2, 0.32, 'sine');
    }
    // 军鼓（拍手）
    if (h > 0.55 && (st === 4 || st === 12)) noiseAt(out, t, 0.12, 0.09, 'bandpass', 1800);
    // 踩镲：反拍
    if (st % 4 === 2) noiseAt(out, t, 0.04, 0.05 + h * 0.03, 'highpass', 7500);
    if (h > 0.6 && st % 2 === 1) noiseAt(out, t, 0.025, 0.025, 'highpass', 9000);
    // 贝斯
    if (st === 0 || st === 6 || st === 10) toneAt(out, t, chord.root, 0, sixteenth * 3, 0.13, 'triangle');
    // 琶音：中段才进来，后面变成十六分
    var every = h > 0.7 ? 1 : 2;
    if (h > 0.2 && st % every === 0) {
      var idx = ARP[(st / every) % ARP.length];
      toneAt(out, t, chord.notes[idx] * 2, 0, sixteenth * 1.6, 0.03 + h * 0.015, 'square');
    }
    music.next += sixteenth;
    music.step++;
  }
}

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
  var sat = b.sat || 0;
  poly(c, [iso(P, x1, yt, z0), iso(P, x1, yt, z1), iso(P, x1, yb, z1), iso(P, x1, yb, z0)], hsl(b.hue, 50 + sat, 50));
  poly(c, [iso(P, x0, yt, z1), iso(P, x1, yt, z1), iso(P, x1, yb, z1), iso(P, x0, yb, z1)], hsl(b.hue, 48 + sat, 40));
  poly(c, [iso(P, x0, yt, z0), iso(P, x1, yt, z0), iso(P, x1, yt, z1), iso(P, x0, yt, z1)], hsl(b.hue, 62 + sat, 66));
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

// 天空：上浅下深，和塔同一个色相；同时同步给页面背景（结算、首页文字都压在它上面）
function skyTop(hue) { return hsl(hue - 8, 42, 64); }
function skyBot(hue) { return hsl(hue + 14, 46, 38); }

function paintBackdrop(c, w, h, hue) {
  var g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, skyTop(hue));
  g.addColorStop(1, skyBot(hue));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
}

var skyHue = null;
function setSky(hue) {
  hue = Math.round(hue);
  if (hue === skyHue) return;
  skyHue = hue;
  var st = document.documentElement.style;
  st.setProperty('--sky-top', skyTop(hue));
  st.setProperty('--sky-bot', skyBot(hue));
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

// 一座示意塔：弹框、图标共用
function paintSampleTower(c, P, layers, hue0, slide) {
  drawBox(c, P, { cx: 0, cz: 0, w: BASE, d: BASE, y: -30, hue: hue0 }, 30);
  var w = BASE, d = BASE, cx = 0, cz = 0;
  for (var i = 0; i < layers; i++) {
    if (i % 3 === 2) { if (i % 2) { w -= 0.9; cx += 0.45; } else { d -= 0.9; cz -= 0.45; } }
    drawBox(c, P, { cx: cx, cz: cz, w: w, d: d, y: i * LAYER, hue: hueAt(hue0, i + 1) }, LAYER);
  }
  if (slide) drawBox(c, P, { cx: cx + slide, cz: cz, w: w, d: d, y: layers * LAYER, hue: hueAt(hue0, layers + 1) }, LAYER);
  return { cx: cx, cz: cz, w: w, d: d, y: layers * LAYER };
}

function $(id) { return document.getElementById(id); }

// ============ 首页：整屏是一座自己在叠的塔 ============
var home = { c: null, w: 0, h: 0, hue: 195, stack: [], cur: null, camY: 0, rings: [], fade: 0 };

function resizeHome() {
  var box = $('home');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  home.c = setupCanvas($('hero-cv'), w, h).c;
  home.w = w; home.h = h;
}

function demoReset() {
  var hues = HUES.filter(function (x) { return x !== home.hue; });
  home.hue = hues[Math.floor(Math.random() * hues.length)];
  home.stack = [];
  for (var i = 1; i <= 4; i++) home.stack.push({ cx: 0, cz: 0, w: 8, d: 8, y: i * LAYER, hue: hueAt(home.hue, i) });
  home.camY = 5 * LAYER;
  home.rings = [];
  demoSpawn();
  setSky(home.hue);
}

function demoSpawn() {
  var n = home.stack.length;
  var axis = n % 2 ? 'z' : 'x';
  home.cur = { cx: 0, cz: 0, w: 8, d: 8, y: (n + 1) * LAYER, hue: hueAt(home.hue, n + 1), axis: axis, off: -RANGE, dir: 1, wait: 0.35 + Math.random() * 0.7 };
}

function stepHome(dt) {
  var b = home.cur;
  if (home.fade > 0) {
    home.fade -= dt;
    if (home.fade <= 0) demoReset();
  } else if (b) {
    var prev = b.off;
    b.off += b.dir * 8 * dt;
    if (b.off > RANGE) { b.off = RANGE; b.dir = -1; }
    if (b.off < -RANGE) { b.off = -RANGE; b.dir = 1; }
    b.wait -= dt;
    // 第二次以后经过正中间就落下，看起来像有人在玩
    if (b.wait <= 0 && prev * b.off <= 0) {
      b.off = 0;
      var layer = { cx: 0, cz: 0, w: 8, d: 8, y: b.y, hue: b.hue };
      home.stack.push(layer);
      home.rings.push({ b: layer, life: 0.5 });
      if (home.stack.length >= 16) { home.cur = null; home.fade = 1.2; }
      else demoSpawn();
    }
    if (b.axis === 'x') b.cx = b.off; else b.cz = b.off;
  }
  var target = (home.stack.length + 1) * LAYER;
  home.camY += (target - home.camY) * Math.min(1, dt * 4);
  home.rings = home.rings.filter(function (r) { r.life -= dt; return r.life > 0; });
}

function drawHome() {
  var c = home.c, w = home.w, h = home.h;
  if (!c) return;
  paintBackdrop(c, w, h, home.hue);
  var s = Math.min(w, h * 0.6) / 30;
  var P = { ox: w * 0.5, oy: h * 0.4, s: s, camY: home.camY };
  c.save();
  if (home.fade > 0) c.globalAlpha = Math.min(1, home.fade / 0.5);
  drawBox(c, P, { cx: 0, cz: 0, w: 8, d: 8, y: -60, hue: home.hue }, 60 + LAYER);
  home.stack.forEach(function (b) { drawBox(c, P, b, LAYER); });
  if (home.cur) drawBox(c, P, home.cur, LAYER);
  home.rings.forEach(function (r) {
    topOutline(c, P, r.b, LAYER, 0.2 + (1 - r.life / 0.5) * 1.6, 'rgba(255,255,255,' + (r.life / 0.5 * 0.85).toFixed(2) + ')', 2);
  });
  c.restore();
  // 底下压一层和天空同色的渐变，按钮和文字压在塔上也看得清
  var hb = Math.round(home.hue + 14);
  var g = c.createLinearGradient(0, h * 0.52, 0, h * 0.78);
  g.addColorStop(0, 'hsla(' + hb + ',46%,38%,0)');
  g.addColorStop(1, 'hsla(' + hb + ',46%,38%,0.92)');
  c.fillStyle = g;
  c.fillRect(0, h * 0.52, w, h * 0.48);
}

function drawDialogArt() {
  var box = $('dlg-art');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  box.innerHTML = '';
  var cnv = document.createElement('canvas');
  box.appendChild(cnv);
  var c = setupCanvas(cnv, w, h).c;
  var hue = skyHue === null ? 195 : skyHue;
  paintBackdrop(c, w, h, hue);
  var P = { ox: w * 0.5, oy: h * 0.5, s: h / 20, camY: 5 };
  paintSampleTower(c, P, 5, hue, 3);
}

// ============ 游戏状态 ============
var S = null;

// level 为 0 表示无限模式
function startRun(level) {
  var hue0 = HUES[Math.floor(Math.random() * HUES.length)];
  S = {
    level: level, cfg: level ? levelCfg(level) : endlessCfg(),
    hue0: hue0,
    stack: [{ cx: 0, cz: 0, w: BASE, d: BASE, y: 0, hue: hue0 }],
    cur: null, falling: [], rings: [], floats: [],
    score: 0, combo: 0, maxCombo: 0, perfects: 0,
    status: 'play', revived: false, reviveReady: false, newBest: false, rank: null,
    camY: LAYER, zoom: 1, zoomTarget: 1, camTarget: LAYER, clock: 0, shake: 0, oyK: 0.56
  };
  spawn();
  hideOverlay();
  updateBar();
  musicStop(0.05);
  musicStart();
}

function topLayer() { return S.stack[S.stack.length - 1]; }

function spawn() {
  var t = topLayer(), c = S.cfg, n = S.score;
  var axis = n % 2 ? 'z' : 'x';
  var speed = c.speed(n);
  if (n >= c.jitterFrom) speed *= 0.85 + Math.random() * 0.35;
  var side = (n >= c.flipFrom && Math.random() < 0.5) ? 1 : -1;
  S.cur = {
    cx: t.cx, cz: t.cz, w: t.w, d: t.d, y: t.y + LAYER,
    hue: hueAt(S.hue0, S.stack.length),
    axis: axis, off: side * RANGE, dir: -side, speed: speed
  };
  if (axis === 'x') S.cur.cx = t.cx + side * RANGE; else S.cur.cz = t.cz + side * RANGE;
}

function drop() {
  if (!S || S.status !== 'play' || !S.cur) return;
  if (S.clock < 0.3) return;   // 刚进来那一下点「开始」的手不算
  var t = topLayer(), b = S.cur;
  var key = b.axis === 'x' ? 'cx' : 'cz', size = b.axis === 'x' ? 'w' : 'd';
  var delta = b[key] - t[key];
  var layer = { cx: b.cx, cz: b.cz, w: b.w, d: b.d, y: b.y, hue: b.hue };

  if (Math.abs(delta) <= S.cfg.perfect) {
    layer[key] = t[key];
    S.combo++;
    S.perfects++;
    S.maxCombo = Math.max(S.maxCombo, S.combo);
    var grew = S.combo >= GROW_AFTER && layer[size] < BASE;
    if (grew) layer[size] = Math.min(BASE, layer[size] + GROW);
    S.rings.push({ b: layer, life: 0.5 });
    S.floats.push({ text: grew ? '变宽了' : (S.combo > 1 ? '完美 ×' + S.combo : '完美'), life: 0.9, y: layer.y + LAYER * 2 });
    sfx.perfect(S.combo);
    if (grew) sfx.grow();
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
    sfx.place(S.score);
    sfx.cut();
    S.shake = 0.12;
    vibrate('light');
  }

  S.stack.push(layer);
  S.score++;
  S.camTarget = layer.y + LAYER;
  if (S.level && S.score >= S.cfg.target) {
    S.cur = null;
    updateBar();
    levelClear();
    return;
  }
  spawn();
  updateBar();
}

function heat() {
  if (!S) return 0;
  if (S.level) return Math.min(1, S.score / S.cfg.target);
  return Math.min(1, S.score / 35);
}

// 结束时拉远镜头看整座塔
function pullBack() {
  // 结算页上面是成绩、下面是按钮，塔要缩在中间那一段里
  var towerH = S.stack.length * LAYER + 10;
  S.zoomTarget = Math.min(0.75, (H * 0.27) / (towerH * view.s0));
  S.camTarget = (S.stack.length * LAYER) / 2 + 2;
}

function levelClear() {
  S.status = 'win';
  musicStop(0.2);
  sfx.clear();
  vibrate('heavy');
  pullBack();
  S.newBest = S.level > saveState.cleared;
  saveState.cleared = Math.max(saveState.cleared, S.level);
  saveState.level = Math.min(LEVELS, Math.max(saveState.level, S.level + 1));
  saveData(saveState);
  setTimeout(showWin, 1000);
}

function gameOver() {
  S.status = 'fail';
  musicStop(0.15);
  sfx.fail();
  vibrate('heavy');
  S.shake = 0.35;
  pullBack();
  var run = S;
  if (!S.level) {
    S.newBest = S.score > saveState.best;
    if (S.newBest) { saveState.best = S.score; saveData(saveState); }
    submitScore(S.score).then(function (r) {
      run.rank = r;
      if (S === run && !$('overlay').classList.contains('hidden') && r) $('r-hint').textContent = resultHint(run);
    });
  }
  setTimeout(showFail, 1100);
}

function revive() {
  S.revived = true;
  S.reviveReady = false;
  S.clock = 0;
  S.status = 'play';
  S.zoomTarget = 1;
  S.camTarget = topLayer().y + LAYER;
  S.combo = 0;
  spawn();
  hideOverlay();
  updateBar();
  musicStart();
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
  view = { scale: sc, ox: (cw - W * sc) / 2, oy: (ch - H * sc) / 2, dpr: dpr, s0: (W * 0.6) / (2 * BASE * COS30), cw: cw, ch: ch };
  // 顶栏压在画布上，分数要放在顶栏下面
  view.top = Math.max(0, ($('bar').offsetHeight - view.oy) / sc);
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!S) return;
  var topHue = S.cur ? S.cur.hue : topLayer().hue;
  // 天空铺满整块画布（含左右/上下留出来的边），不只是逻辑区域
  paintBackdrop(ctx, cv.width, cv.height, topHue);
  setSky(topHue);
  var px = view.dpr * view.scale;
  var sx = 0, sy = 0;
  if (S.shake > 0) { sx = (Math.random() - 0.5) * S.shake * 30; sy = (Math.random() - 0.5) * S.shake * 30; }
  ctx.setTransform(px, 0, 0, px, view.dpr * (view.ox + sx), view.dpr * (view.oy + sy));

  var P = { ox: W / 2, oy: H * S.oyK, s: view.s0 * S.zoom, camY: S.camY };
  var t = topLayer();

  // 掉落块：在塔后面的先画，在前面的后画
  var back = [], front = [];
  S.falling.forEach(function (f) {
    ((f.b.cx + f.b.cz) < (t.cx + t.cz) ? back : front).push(f);
  });
  back.forEach(function (f) { drawBox(ctx, P, f.b, LAYER, 0.9); });

  // 闯关模式的终点线：画在塔后面，塔叠上去就盖住了
  if (S.level && S.status === 'play') {
    var gy = S.cfg.target * LAYER;
    var gb = { cx: 0, cz: 0, w: BASE, d: BASE, y: gy };
    ctx.setLineDash([6, 6]);
    topOutline(ctx, P, gb, LAYER, 0.6, 'rgba(255,255,255,0.55)', 2);
    ctx.setLineDash([]);
    var gp = iso(P, -BASE / 2 - 0.6, gy + LAYER, -BASE / 2 - 0.6);
    ctx.font = '800 14px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('终点 ' + S.cfg.target + ' 层', gp.x, gp.y - 8);
  }

  drawBox(ctx, P, { cx: 0, cz: 0, w: BASE, d: BASE, y: -40, hue: S.hue0 }, 40 + LAYER);
  S.stack.forEach(function (b, i) { if (i > 0) drawBox(ctx, P, b, LAYER); });
  if (S.cur) drawBox(ctx, P, S.cur, LAYER);

  front.forEach(function (f) { drawBox(ctx, P, f.b, LAYER, 0.9); });

  S.rings.forEach(function (r) {
    var k = 1 - r.life / 0.5;
    topOutline(ctx, P, r.b, LAYER, 0.2 + k * 1.6, 'rgba(255,255,255,' + (r.life / 0.5 * 0.85).toFixed(2) + ')', 2.5);
  });

  // 分数（结算时由结算页显示，这里不画）
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (S.status === 'play') {
    ctx.fillStyle = '#fff';
    ctx.font = '700 76px "DIN Alternate", "Helvetica Neue", -apple-system, Roboto, sans-serif';
    ctx.fillText(String(S.score), W / 2, view.top + 52);
  }

  S.floats.forEach(function (f) {
    var p = iso(P, t.cx, f.y + (0.9 - f.life) * 2, t.cz);
    ctx.globalAlpha = Math.min(1, f.life / 0.5);
    ctx.font = '900 20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
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
  if (S.shake > 0) S.shake = Math.max(0, S.shake - dt);
  S.oyK += ((S.status === 'play' ? 0.56 : 0.47) - S.oyK) * Math.min(1, dt * 3);
  if (S.status === 'play') musicUpdate(heat());
}

function loop(ts) {
  if (!running) return;
  var dt = last ? Math.min(ts - last, 50) / 1000 : 0.016;
  last = ts;
  if (inGame) {
    step(dt);
    render();
  } else if (!$('home').classList.contains('hidden')) {
    stepHome(dt);
    drawHome();
  }
  requestAnimationFrame(loop);
}

document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    running = false;
    if (audio && audio.state === 'running') audio.suspend();
  } else if (!running) {
    if (audio && inGame) audio.resume();
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
  musicStop(0.3);
  hideOverlay();
  $('game').classList.add('hidden');
  $('home').classList.remove('hidden');
  renderHome();
  resizeHome();
  demoReset();
}

function showGame(level) {
  initAudio();
  $('home').classList.add('hidden');
  $('game').classList.remove('hidden');
  resizeGame();
  startRun(level);
  inGame = true;
}

function renderHome() {
  var endless = saveState.mode === 'endless';
  $('tab-level').classList.toggle('active', !endless);
  $('tab-endless').classList.toggle('active', endless);
  if (endless) {
    $('home-best').innerHTML = saveState.best > 0
      ? '无限模式最高 <b>' + saveState.best + ' 层</b>'
      : '没有终点，越往上越快，看你能叠多高';
    $('btn-start').innerHTML = '开始无限模式' + ARROW;
  } else {
    var lv = saveState.level;
    $('home-best').innerHTML = '第 ' + lv + ' 关 · 叠到 <b>' + levelCfg(lv).target + ' 层</b>过关' +
      (saveState.cleared ? '　已通关 ' + saveState.cleared + ' / ' + LEVELS : '');
    $('btn-start').innerHTML = (lv > 1 ? '继续第 ' + lv + ' 关' : '开始挑战') + ARROW;
  }
  $('btn-sound').classList.toggle('muted', !!saveState.muted);
  renderFollow();
}

function updateBar() {
  if (!S.level) {
    $('level').textContent = '无限模式';
    $('progress').textContent = '最佳 ' + Math.max(saveState.best, S.score) + ' 层' + (S.combo > 1 ? ' · 连续完美 ' + S.combo : '');
    $('bar-fill').style.width = (saveState.best ? Math.min(100, S.score / saveState.best * 100) : 0) + '%';
    return;
  }
  var left = Math.max(0, S.cfg.target - S.score);
  $('level').textContent = '第 ' + S.level + ' 关';
  $('progress').textContent = (left ? '还差 ' + left + ' 层' : '到顶了') + (S.combo > 1 ? ' · 连续完美 ' + S.combo : '');
  $('bar-fill').style.width = Math.min(100, S.score / S.cfg.target * 100) + '%';
}

function restartRun() { initAudio(); startRun(S.level); }

$('btn-start').addEventListener('click', function () {
  showGame(saveState.mode === 'endless' ? 0 : saveState.level);
});
$('btn-back').addEventListener('click', showHome);
$('btn-restart').addEventListener('click', restartRun);
$('nav-rank').addEventListener('click', function () { openRank('day'); });

['tab-level', 'tab-endless'].forEach(function (id) {
  $(id).addEventListener('click', function () {
    var m = $(id).getAttribute('data-mode');
    if (saveState.mode === m) return;
    saveState.mode = m;
    saveData(saveState);
    renderHome();
  });
});

$('btn-sound').addEventListener('click', function () {
  saveState.muted = !saveState.muted;
  saveData(saveState);
  renderHome();
  if (saveState.muted) musicStop(0.1);
  else { initAudio(); sfx.perfect(3); }
});

$('nav-help').addEventListener('click', function () {
  openDialog({
    kicker: '怎么玩',
    title: '玩法说明',
    html: '<ol><li>方块会来回滑，点一下屏幕它就落下。</li>' +
          '<li>没对齐的部分会被切掉，方块越来越窄。完全没放上去就结束了。</li>' +
          '<li>正好对齐会「叮」一声，连续对齐 ' + GROW_AFTER + ' 次以上，方块会变宽一点。</li>' +
          '<li>闯关模式叠到终点线就过关，一共 ' + LEVELS + ' 关。后面的关会忽快忽慢，还会从另一边滑出来。</li>' +
          '<li>无限模式没有终点，叠了多少层会上排行榜。</li>' +
          '<li>输了发一篇笔记可以复活一次。</li></ol>',
    main: '知道了',
    onMain: closeDialog
  });
});

$('nav-levels').addEventListener('click', function () {
  var unlocked = Math.max(1, saveState.level);
  var html = '<div class="lv-grid">';
  for (var n = 1; n <= LEVELS; n++) {
    var cls = n > unlocked ? 'locked' : (n <= saveState.cleared ? 'done' : '');
    if (n === unlocked) cls += ' current';
    var tag = n > unlocked ? '未解锁' : (n <= saveState.cleared ? '已过' : levelCfg(n).target + '层');
    html += '<button type="button" data-lv="' + n + '" class="' + cls + '">' + n + '<small>' + tag + '</small></button>';
  }
  html += '</div>';
  openDialog({
    kicker: '已解锁 ' + unlocked + ' / ' + LEVELS + ' 关',
    title: '选择关卡',
    html: html,
    main: '关闭',
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
  $('bar').classList.add('hidden');
}

function hideOverlay() { $('overlay').classList.add('hidden'); $('bar').classList.remove('hidden'); }

function resultHint(run) {
  var r = run.rank;
  var rankText = '';
  if (r && r.status === 'EXACT') rankText = '今天排第 ' + r.rank + ' 名';
  else if (r && r.status === 'OVER_LIMIT') rankText = '今天排在 10000 名以外';
  if (run.newBest) return '新纪录！' + (rankText ? ' · ' + rankText : '');
  return rankText || ('离最佳还差 ' + Math.max(0, saveState.best - run.score) + ' 层');
}

function failStats() {
  return [['完美对齐', S.perfects + ' 次'], ['最长连续完美', S.maxCombo + ' 次'],
    S.level ? ['本关目标', S.cfg.target + ' 层'] : ['历史最佳', saveState.best + ' 层']];
}

function showFail() {
  var canRevive = !S.revived;
  var lv = S.level;
  var o = {
    kicker: lv ? '第 ' + lv + ' 关' : '无限模式',
    num: String(S.score),
    unit: '层',
    tag: !lv && S.newBest ? '新纪录' : '没过',
    title: '没放上去',
    sub: canRevive ? '发一篇笔记就能接着往上叠。' : '这局的复活机会用过了，再来一局吧。',
    stats: failStats(),
    pct: lv ? S.score / S.cfg.target : (saveState.best ? S.score / saveState.best : 1),
    hint: lv ? '离终点还差 ' + (S.cfg.target - S.score) + ' 层' : resultHint(S)
  };
  if (canRevive) {
    o.main = '发笔记复活'; o.mainArrow = true; o.onMain = onReviveClick;
    o.note = '发布成功后手动继续 · 每局一次';
    o.second = '重新开始'; o.onSecond = restartRun;
  } else {
    o.main = '重新开始'; o.mainArrow = true; o.onMain = restartRun;
    o.second = '发笔记晒成绩'; o.onSecond = function () { shareNote(false); };
  }
  if (!lv) { o.third = '看排行榜'; o.onThird = function () { openRank('day'); }; }
  o.fourth = '返回主页'; o.onFourth = showHome;
  fillSheet(o);
}

function showWin() {
  var lv = S.level, last = lv >= LEVELS;
  var o = {
    kicker: '第 ' + lv + ' 关',
    num: String(S.score),
    unit: '层',
    tag: last ? '全部通关' : '过关',
    title: last ? '全部叠完了' : '叠到顶了',
    sub: last ? LEVELS + ' 关全过了，去无限模式冲排行榜吧。' : '下一关要叠到 ' + levelCfg(lv + 1).target + ' 层，方块也更快。',
    stats: [['完美对齐', S.perfects + ' 次'], ['最长连续完美', S.maxCombo + ' 次'], ['已通关', saveState.cleared + ' / ' + LEVELS]],
    pct: saveState.cleared / LEVELS,
    hint: S.perfects >= S.score * 0.6 ? '一大半都是完美对齐，手很稳' : '多卡几个完美，方块会变宽回来'
  };
  if (last) {
    o.main = '去无限模式'; o.mainArrow = true;
    o.onMain = function () { saveState.mode = 'endless'; saveData(saveState); startRun(0); };
  } else {
    o.main = '下一关'; o.mainArrow = true; o.onMain = function () { startRun(lv + 1); };
  }
  o.second = '发笔记晒成绩'; o.onSecond = function () { shareNote(false); };
  o.third = '再玩一次这关'; o.onThird = restartRun;
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
  var lvBtn = e.target.closest ? e.target.closest('button[data-lv]') : null;
  if (lvBtn) {
    var n = parseInt(lvBtn.getAttribute('data-lv'), 10);
    if (n > Math.max(1, saveState.level)) { toast('先通过第 ' + (n - 1) + ' 关才能玩'); return; }
    closeDialog();
    saveState.mode = 'level';
    showGame(n);
    return;
  }
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
  paintBackdrop(x, 900, 1200, hueAt(S.hue0, S.stack.length));

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
      title: S.status === 'win' ? '叠叠高过了第' + S.level + '关' : '叠叠高叠到了' + S.score + '层',
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
  if (inGame) resizeGame(); else resizeHome();
});

(async function boot() {
  var d = await loadData();
  if (d) {
    saveState.best = Math.max(0, d.best | 0);
    saveState.cleared = Math.min(LEVELS, Math.max(0, d.cleared | 0));
    saveState.level = Math.min(LEVELS, Math.max(1, d.level | 0, saveState.cleared + 1));
    saveState.muted = !!d.muted;
    saveState.mode = d.mode === 'endless' ? 'endless' : 'level';
  }
  await applyTopInset();
  canVibrate = await canUse('vibrateShort', 9500);
  showHome();
  requestAnimationFrame(loop);
  await initFollow();
  setTimeout(maybeAskFollow, 350);
})();

})();
