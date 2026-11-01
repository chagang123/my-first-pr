(function () {
'use strict';

// ============ 常量 ============
var W = 390;                 // 场景逻辑宽度
var SH = 640;                // 场景逻辑高度，画布按屏幕比例缩放后居中
var DEG = Math.PI / 180;
var SNAP_DEG = 4;            // 松手时离摆正差几度以内就自动吸正
var SLOT_DIST = 34;          // 拖到离格子多近就吸进去
var FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
var NUM_FONT = '"DIN Alternate", "Helvetica Neue", -apple-system, Roboto, sans-serif';
var INK = '#1c1c1e', RED = '#e5432d', PAPER = '#f3efe6';

// ============ 小红书端能力 ============
var xhs = window.xhs || null;
var miniTool = (xhs && xhs.miniTool) ? xhs.miniTool : null;
var STORE_KEY = 'neat_freak_save';

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
var cloud = { ok: false, id: null, unknown: false, chain: Promise.resolve() };

function hasCloud() {
  return !!(miniTool && typeof miniTool.queryCloudStorage === 'function' &&
    typeof miniTool.addCloudStorage === 'function' && typeof miniTool.updateCloudStorage === 'function');
}

// best 存每关最快秒数，取两边更快的
function mergeSave(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  var best = {}, k;
  var lb = local.best || {}, rb = remote.best || {};
  for (k in lb) best[k] = lb[k];
  for (k in rb) if (!best[k] || (rb[k] && rb[k] < best[k])) best[k] = rb[k];
  return {
    level: Math.max(local.level | 0, remote.level | 0),
    best: best,
    muted: local.muted !== undefined ? !!local.muted : !!remote.muted
  };
}

async function writeCloud(obj) {
  var content = { level: obj.level, best: obj.best, muted: !!obj.muted };
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

// ============ 音效（全部现场合成，包里不能放音频文件） ============
var audio = null;
var saveState = { level: 1, best: {}, muted: false };

function initAudio() {
  if (audio) {
    if (audio.state === 'suspended') audio.resume();
    return;
  }
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { audio = null; }
}

function soundOn() { return audio && !saveState.muted; }

function toneAt(t, freq, freqEnd, dur, vol, type) {
  var o = audio.createOscillator();
  var g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(audio.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

var noiseBuf = null;
function noiseAt(t, dur, vol, kind, freq, freqEnd) {
  if (!noiseBuf) {
    noiseBuf = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  var src = audio.createBufferSource();
  src.buffer = noiseBuf;
  var f = audio.createBiquadFilter();
  f.type = kind;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  var g = audio.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f); f.connect(g); g.connect(audio.destination);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

var sfx = {
  // 转动时一格一格的棘轮声
  tick: function () {
    if (!soundOn()) return;
    noiseAt(audio.currentTime, 0.018, 0.07, 'highpass', 3800);
  },
  pick: function () {
    if (!soundOn()) return;
    toneAt(audio.currentTime, 420, 520, 0.06, 0.06, 'triangle');
  },
  drop: function () {
    if (!soundOn()) return;
    var t = audio.currentTime;
    toneAt(t, 170, 110, 0.12, 0.14, 'triangle');
    noiseAt(t, 0.05, 0.08, 'lowpass', 900);
  },
  // 摆正那一下的「咔哒」，强迫症最想听的一声
  snap: function (n) {
    if (!soundOn()) return;
    var t = audio.currentTime;
    var f = [659.3, 784, 880, 1046.5, 1174.7, 1318.5][Math.min(n || 0, 5)];
    noiseAt(t, 0.03, 0.22, 'bandpass', 2600);
    toneAt(t + 0.012, f, 0, 0.22, 0.12, 'sine');
    toneAt(t + 0.012, f * 2, 0, 0.12, 0.035, 'sine');
  },
  flip: function () {
    if (!soundOn()) return;
    var t = audio.currentTime;
    noiseAt(t, 0.09, 0.06, 'bandpass', 1500, 4000);
    toneAt(t, 300, 360, 0.05, 0.05, 'triangle');
  },
  troll: function () {
    if (!soundOn()) return;
    var t = audio.currentTime;
    toneAt(t, 420, 150, 0.5, 0.09, 'sawtooth');
    toneAt(t + 0.05, 300, 110, 0.5, 0.07, 'triangle');
  },
  win: function () {
    if (!soundOn()) return;
    var t = audio.currentTime;
    [523.3, 659.3, 784, 1046.5].forEach(function (f, i) {
      toneAt(t + i * 0.08, f, 0, 0.45, 0.11, 'triangle');
    });
    [523.3, 659.3, 784].forEach(function (f) { toneAt(t + 0.36, f, 0, 1.0, 0.06, 'sine'); });
  },
  click: function () {
    if (!soundOn()) return;
    noiseAt(audio.currentTime, 0.025, 0.15, 'bandpass', 2600);
  }
};

// ============ 画图小工具 ============
function $(id) { return document.getElementById(id); }

function rr(c, x, y, w, h, r) {
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

// 每关用固定种子，同一关每次歪的样子一样，用时才有得比
function rng(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    var t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function adiff(a, b) {
  var d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ============ 物件画法：都以自己中心为原点 ============
// 阴影只给最底下那层形状，画完底形就关掉
function noShadow(c) { c.shadowColor = 'rgba(0,0,0,0)'; c.shadowBlur = 0; c.shadowOffsetY = 0; }

function paintArt(c, kind, x, y, w, h) {
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  if (kind === 0) {          // 山和太阳
    c.fillStyle = '#f1d6ad'; c.fillRect(x, y, w, h);
    c.fillStyle = '#e98a4f'; c.beginPath(); c.arc(x + w * 0.7, y + h * 0.36, h * 0.16, 0, 7); c.fill();
    c.fillStyle = '#8fa88a';
    c.beginPath(); c.moveTo(x, y + h); c.quadraticCurveTo(x + w * 0.3, y + h * 0.35, x + w * 0.65, y + h); c.fill();
    c.fillStyle = '#5f7f62';
    c.beginPath(); c.moveTo(x + w * 0.3, y + h); c.quadraticCurveTo(x + w * 0.75, y + h * 0.45, x + w * 1.1, y + h); c.fill();
  } else if (kind === 1) {   // 海和小船
    c.fillStyle = '#d8e5ea'; c.fillRect(x, y, w, h);
    c.fillStyle = '#5f8ea8'; c.fillRect(x, y + h * 0.58, w, h);
    c.fillStyle = '#fff';
    c.beginPath(); c.moveTo(x + w * 0.5, y + h * 0.18); c.lineTo(x + w * 0.5, y + h * 0.52); c.lineTo(x + w * 0.3, y + h * 0.52); c.fill();
    c.fillStyle = '#3a3a3a';
    c.beginPath(); c.moveTo(x + w * 0.26, y + h * 0.55); c.lineTo(x + w * 0.62, y + h * 0.55); c.lineTo(x + w * 0.56, y + h * 0.64); c.lineTo(x + w * 0.32, y + h * 0.64); c.fill();
  } else if (kind === 2) {   // 色块
    c.fillStyle = '#efe7da'; c.fillRect(x, y, w, h);
    c.fillStyle = '#2f4858'; c.fillRect(x, y, w * 0.34, h);
    c.fillStyle = '#e98a4f'; c.beginPath(); c.arc(x + w * 0.64, y + h * 0.42, h * 0.22, 0, 7); c.fill();
    c.fillStyle = '#d9b44a'; c.fillRect(x + w * 0.44, y + h * 0.74, w * 0.44, h * 0.1);
  } else {                   // 人像剪影
    c.fillStyle = '#e5d3bd'; c.fillRect(x, y, w, h);
    c.fillStyle = '#3b3b3b';
    c.beginPath(); c.arc(x + w / 2, y + h * 0.4, w * 0.17, 0, 7); c.fill();
    c.beginPath(); c.ellipse(x + w / 2, y + h * 1.02, w * 0.36, h * 0.36, 0, 0, 7); c.fill();
  }
  c.restore();
}

function paintFrame(c, it) {
  var w = it.w, h = it.h;
  c.fillStyle = it.color;
  rr(c, -w / 2, -h / 2, w, h, 3);
  c.fill();
  noShadow(c);
  if (it.color === '#f4f1ea') { c.strokeStyle = '#d6cfc0'; c.lineWidth = 1; c.stroke(); }
  c.fillStyle = '#faf7f1';
  c.fillRect(-w / 2 + 9, -h / 2 + 9, w - 18, h - 18);
  paintArt(c, it.art, -w / 2 + 19, -h / 2 + 19, w - 38, h - 38);
}

function paintNote(c, it) {
  var s = it.w;
  c.fillStyle = it.color;
  c.beginPath();
  c.moveTo(-s / 2, -s / 2);
  c.lineTo(s / 2, -s / 2);
  c.lineTo(s / 2, s / 2 - 12);
  c.lineTo(s / 2 - 12, s / 2);
  c.lineTo(-s / 2, s / 2);
  c.closePath();
  c.fill();
  noShadow(c);
  c.fillStyle = 'rgba(0,0,0,0.12)';
  c.beginPath(); c.moveTo(s / 2, s / 2 - 12); c.lineTo(s / 2 - 12, s / 2 - 12); c.lineTo(s / 2 - 12, s / 2); c.fill();
  // 胶带
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.fillRect(-14, -s / 2 - 6, 28, 12);
  // 随手写的几行字
  c.strokeStyle = 'rgba(28,28,30,0.45)';
  c.lineWidth = 2;
  c.lineCap = 'round';
  var lines = it.lines || [0.7, 0.5, 0.62];
  lines.forEach(function (k, i) {
    var y = -s / 2 + 22 + i * 14;
    c.beginPath();
    c.moveTo(-s / 2 + 12, y);
    c.quadraticCurveTo(-s / 2 + 12 + (s - 24) * k / 2, y - 3, -s / 2 + 12 + (s - 24) * k, y);
    c.stroke();
  });
}

function paintMug(c, it) {
  var w = 44, h = 50;
  c.strokeStyle = it.color;
  c.lineWidth = 7;
  c.beginPath();
  c.arc(w / 2 + 1, 0, 12, -Math.PI / 2, Math.PI / 2);
  c.stroke();
  c.fillStyle = it.color;
  c.beginPath();
  c.moveTo(-w / 2, -h / 2);
  c.lineTo(w / 2, -h / 2);
  c.lineTo(w / 2, h / 2 - 9);
  c.quadraticCurveTo(w / 2, h / 2, w / 2 - 9, h / 2);
  c.lineTo(-w / 2 + 9, h / 2);
  c.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - 9);
  c.closePath();
  c.fill();
  noShadow(c);
  c.fillStyle = 'rgba(255,255,255,0.75)';
  c.fillRect(-w / 2, -6, w, 7);
  c.fillStyle = 'rgba(0,0,0,0.18)';
  c.fillRect(-w / 2, -h / 2, w, 4);
}

function paintBook(c, it) {
  var w = it.w, h = it.h;
  c.fillStyle = it.color;
  rr(c, -w / 2, -h / 2, w, h, 3);
  c.fill();
  noShadow(c);
  c.fillStyle = 'rgba(255,255,255,0.3)';
  c.fillRect(-w / 2, -h / 2 + 12, w, 3);
  c.fillRect(-w / 2, h / 2 - 15, w, 3);
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.fillRect(-w / 2 + 7, -h / 2 + 30, w - 14, Math.min(40, h * 0.25));
}

function paintPencil(c, it) {
  var L = it.h, w = 14, top = -L / 2, bot = L / 2;
  c.fillStyle = '#e8c99a';
  c.beginPath(); c.moveTo(-w / 2, top + 24); c.lineTo(0, top + 2); c.lineTo(w / 2, top + 24); c.fill();
  c.fillStyle = '#3a3a3a';
  c.beginPath(); c.moveTo(-2.6, top + 8); c.lineTo(0, top); c.lineTo(2.6, top + 8); c.fill();
  c.fillStyle = it.color;
  c.fillRect(-w / 2, top + 24, w, L - 24 - 18);
  noShadow(c);
  c.fillStyle = 'rgba(0,0,0,0.14)'; c.fillRect(-w / 2, top + 24, 4, L - 42);
  c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(w / 2 - 4, top + 24, 4, L - 42);
  c.fillStyle = '#b9b5ad'; c.fillRect(-w / 2, bot - 18, w, 7);
  c.fillStyle = '#e79a92'; rr(c, -w / 2, bot - 11, w, 11, 3); c.fill();
}

var TILE = 96;
function paintTile(c, it) {
  var s = TILE, h = s / 2;
  c.fillStyle = '#f8f4ec';
  rr(c, -h + 2, -h + 2, s - 4, s - 4, 8);
  c.fill();
  noShadow(c);
  c.strokeStyle = '#2f4858';
  c.lineWidth = 16;
  c.lineCap = 'butt';
  c.beginPath();
  if (it.shape === 'line') { c.moveTo(-h, 0); c.lineTo(h, 0); }
  else c.arc(h, -h, h, Math.PI / 2, Math.PI);   // 连上边和右边
  c.stroke();
}

function paintCookie(c, it) {
  var r = it.w / 2, bx = r * 0.95, br = r * 0.42;
  c.save();
  c.beginPath();
  c.rect(-r - 4, -r - 4, r * 2 + 8, r * 2 + 8);
  c.arc(bx, 0, br, 0, Math.PI * 2);
  c.clip('evenodd');
  c.fillStyle = '#b97f45';
  c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
  noShadow(c);
  c.fillStyle = '#d9a466';
  c.beginPath(); c.arc(0, -1.5, r - 4, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#5a3a24';
  (it.chips || []).forEach(function (p) {
    c.beginPath(); c.arc(p[0] * r, p[1] * r, 3.6, 0, Math.PI * 2); c.fill();
  });
  c.restore();
}

function paintKey(c, it) {
  var s = 44;
  c.fillStyle = '#cfc7b8';
  rr(c, -s / 2, -s / 2 + 3, s, s, 8); c.fill();
  noShadow(c);
  c.fillStyle = '#fbf9f4';
  rr(c, -s / 2, -s / 2, s, s - 2, 8); c.fill();
  c.fillStyle = INK;
  c.font = '700 18px ' + FONT;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(it.letter, 0, -2);
}

function paintPiece(c, it) {
  c.fillStyle = '#2f4858';
  c.fillRect(-it.w / 2, -it.h / 2, it.w, it.h);
}

// ============ 物件 ============
// kind：rotate 按住转；slot 拖到格子；flip 点一下镜像；turn 点一下转 90°
function mk(o) {
  o.done = false;
  o.a = o.a || 0;
  o.ta = o.ta || 0;
  o.ra = o.a;
  o.rx = o.x; o.ry = o.y;
  o.sx = 1;
  o.pop = 0;
  return o;
}

function frame(x, y, w, h, art, color, deg) {
  return mk({ kind: 'rotate', paint: paintFrame, x: x, y: y, w: w, h: h, art: art, color: color, a: deg * DEG, nail: true });
}

function note(x, y, s, color, deg, lines) {
  return mk({ kind: 'rotate', paint: paintNote, x: x, y: y, w: s, h: s, color: color, a: deg * DEG, lines: lines });
}

function mug(x, y, color, wrong) {
  return mk({ kind: 'flip', paint: paintMug, x: x, y: y, w: 72, h: 54, color: color, f: !!wrong, tf: false });
}

function bookSlot(sx, sy, w, h, color, x, y, deg) {
  return mk({ kind: 'slot', paint: paintBook, x: x, y: y, w: w, h: h, color: color, a: deg * DEG, slot: { x: sx, y: sy } });
}

// ============ 关卡 ============
var NOTE_COLORS = ['#f6dc6b', '#f4b8b0', '#b9dcc4', '#bcd3ea'];
var MUG_COLORS = ['#2f4858', '#e98a4f', '#7d9a7a', '#d9b44a', '#c96f5d', '#8d8577'];

var LEVELS = [
  { name: '墙上的画', bg: 'wall', tip: '按住画框转一转，把它摆正', make: function () {
    return [frame(195, 290, 190, 140, 0, '#2b2b2b', -9)];
  } },
  { name: '三幅画', bg: 'wall', tip: '三幅都要正', make: function () {
    return [
      frame(110, 215, 124, 160, 3, '#7a5536', -8),
      frame(283, 205, 146, 112, 1, '#f4f1ea', 7),
      frame(195, 425, 236, 132, 2, '#2b2b2b', -5)
    ];
  } },
  { name: '便利贴', bg: 'cork', tip: '一张一张转正', make: function (R) {
    var out = [], degs = [-14, 9, -6, 16, -11, 7];
    for (var i = 0; i < 6; i++) {
      out.push(note(108 + (i % 3) * 87, 235 + Math.floor(i / 3) * 170, 76, NOTE_COLORS[i % 4], degs[i],
        [0.4 + R() * 0.5, 0.3 + R() * 0.6, 0.3 + R() * 0.5]));
    }
    return out;
  } },
  { name: '杯子把手', bg: 'shelf', shelves: [300, 500], tip: '点一下杯子，把手都朝右', make: function () {
    var wrong = [1, 2, 5, 6, 7], out = [];
    for (var i = 0; i < 8; i++) {
      out.push(mug(70 + (i % 4) * 82, (i < 4 ? 300 : 500) - 27, MUG_COLORS[i % 6], wrong.indexOf(i) >= 0));
    }
    return out;
  } },
  { name: '书架', bg: 'shelf', shelves: [420], tip: '把书拖上书架，从高到矮排', make: function (R) {
    var sizes = [[36, 196], [30, 178], [42, 162], [28, 150], [36, 136], [32, 120]];
    var colors = ['#2f4858', '#c96f5d', '#d9b44a', '#7d9a7a', '#e98a4f', '#8d8577'];
    var out = [], x = 78;
    var spots = [[96, 490], [292, 500], [190, 568], [110, 586], [290, 584], [200, 470]];
    sizes.forEach(function (s, i) {
      var sx = x + s[0] / 2;
      x += s[0] + 4;
      var p = spots[i];
      out.push(bookSlot(sx, 420 - s[1] / 2, s[0], s[1], colors[i], p[0], p[1], (R() < 0.5 ? -1 : 1) * (70 + R() * 30)));
    });
    return out;
  } },
  { name: '瓷砖', bg: 'tiles', tip: '点瓷砖转一转，把线从左连到右', make: function (R) {
    // [行, 列, 形状, 正确朝向]；弯道 0 朝向连上边和右边，每加 1 顺时针转 90°
    var path = [[0, 0, 'line', 0], [0, 1, 'arc', 2], [1, 1, 'line', 1], [2, 1, 'arc', 0], [2, 2, 'arc', 3], [1, 2, 'line', 1], [0, 2, 'arc', 1]];
    return path.map(function (p) {
      var period = p[2] === 'line' ? 2 : 4;
      var r = (p[3] + 1 + Math.floor(R() * (period - 1))) % 4;
      return mk({ kind: 'turn', paint: paintTile, shape: p[2], x: 195 + (p[1] - 1) * TILE, y: 330 + (p[0] - 1) * TILE,
        w: TILE, h: TILE, r: r, tr: p[3], period: period, a: r * Math.PI / 2 });
    });
  } },
  { name: '卡在 99%', bg: 'screen', tip: '就差最后一格', make: function () {
    return [mk({ kind: 'slot', paint: paintPiece, x: 292, y: 540, w: 26, h: 20, a: 22 * DEG, slot: { x: 70 + 224 + 13, y: 300 } })];
  } },
  { name: '铅笔', bg: 'desk', tip: '把铅笔立好，从长到短排', make: function (R) {
    var lens = [236, 212, 190, 168, 146, 124];
    var colors = ['#d9b44a', '#2f4858', '#c96f5d', '#7d9a7a', '#e98a4f', '#8d8577'];
    var spots = [[300, 150], [110, 560], [250, 590], [330, 470], [70, 170], [190, 140]];
    return lens.map(function (L, i) {
      var p = spots[i];
      return mk({ kind: 'slot', paint: paintPencil, x: p[0], y: p[1], w: 14, h: L, color: colors[i],
        a: (40 + R() * 100) * DEG * (R() < 0.5 ? -1 : 1), slot: { x: 80 + i * 46, y: 470 - L / 2 } });
    });
  } },
  { name: '饼干', bg: 'plate', tip: '让每块饼干的缺口都朝右', make: function (R) {
    var out = [], pos = [[195, 330]];
    for (var k = 0; k < 5; k++) pos.push([195 + Math.cos(k * 1.2566 - 1.57) * 96, 330 + Math.sin(k * 1.2566 - 1.57) * 96]);
    pos.forEach(function (p) {
      var chips = [];
      for (var j = 0; j < 6; j++) {
        var cx = R() * 1.3 - 0.75, cy = R() * 1.3 - 0.65;
        if (cx * cx + cy * cy < 0.5) chips.push([cx, cy]);
      }
      var deg = 40 + R() * 260;
      out.push(mk({ kind: 'rotate', paint: paintCookie, x: p[0], y: p[1], w: 76, h: 76, a: deg * DEG, chips: chips }));
    });
    return out;
  } },
  { name: '键盘', bg: 'keyboard', tip: '把键帽按回原位', make: function (R) {
    var letters = ['Q', 'W', 'E', 'R', 'T', 'Y'];
    var spots = [[300, 160], [90, 520], [200, 140], [320, 560], [80, 210], [210, 590]];
    return letters.map(function (L, i) {
      var p = spots[i];
      return mk({ kind: 'slot', paint: paintKey, x: p[0], y: p[1], w: 44, h: 44, letter: L,
        a: (R() * 70 - 35) * DEG, slot: { x: 60 + i * 54, y: 372 } });
    });
  } },
  { name: '杂七杂八', bg: 'shelf', shelves: [470], tip: '一屋子都歪了', make: function () {
    return [
      frame(110, 180, 116, 148, 3, '#2b2b2b', -6),
      frame(278, 190, 140, 104, 0, '#7a5536', 9),
      note(70, 372, 62, NOTE_COLORS[0], 12),
      note(146, 380, 62, NOTE_COLORS[2], -9),
      mug(214, 443, MUG_COLORS[0], true),
      mug(280, 443, MUG_COLORS[1], false),
      mug(346, 443, MUG_COLORS[3], true)
    ];
  } },
  { name: '最后一幅画', bg: 'wall', tip: '最后一关了，摆正它', troll: 2, make: function () {
    return [frame(195, 290, 200, 150, 0, '#2b2b2b', -11)];
  } }
];

var CHEERS = ['舒服了', '这下顺眼了', '整整齐齐', '终于对上了', '一个都没歪', '看着就爽'];
var SUBS = {
  1: '强迫症第一关，热身。',
  6: '线连上的那一下，整个人都通了。',
  7: '加载完成。其实什么都没加载。',
  10: '键盘回来了，可以打字了。',
  12: '它终于不歪了。你也被我逗了两回。'
};

// ============ 游戏状态 ============
var S = null;

function startLevel(n) {
  var L = LEVELS[n - 1];
  S = {
    n: n, L: L,
    items: L.make(rng(n * 7919 + 17)),
    status: 'play', t: 0, fixed: 0, troll: L.troll || 0,
    drag: null, hintT: 0, hintItem: null, winT: 0
  };
  S.items.forEach(function (it, i) {
    it.z = i;
    // 本来就摆对的（比如把手已经朝右的杯子）直接算好
    if (it.kind === 'flip' && it.f === it.tf) it.done = true;
  });
  hideOverlay();
  $('tip').textContent = L.tip;
  $('level').textContent = '第 ' + n + ' 关 · ' + L.name;
  updateBar();
}

function remaining() {
  var n = 0;
  S.items.forEach(function (it) { if (!it.done) n++; });
  return n;
}

function markDone(it) {
  it.done = true;
  it.pop = 0.3;
  S.fixed++;
  sfx.snap(S.fixed - 1);
  vibrate('light');
  if (S.hintItem === it) { S.hintT = 0; S.hintItem = null; }
  if (S.troll > 0 && remaining() === 0) {
    trollBack(it);
    return;
  }
  updateBar();
  if (remaining() === 0) win();
}

// 最后一关：摆正以后自己又慢慢歪回去，前两次都这样
function trollBack(it) {
  S.troll--;
  var left = S.troll;
  setTimeout(function () {
    if (!S || S.items.indexOf(it) < 0 || S.status !== 'play') return;
    it.done = false;
    it.slow = true;
    it.a += (left % 2 ? 1 : -1) * (left ? 14 : 9) * DEG;
    S.fixed--;
    sfx.troll();
    vibrate('medium');
    toast(left ? '……又歪了？' : '最后一次，真的');
    updateBar();
  }, 900);
}

function win() {
  S.status = 'win';
  sfx.win();
  vibrate('heavy');
  var key = String(S.n);
  var prev = saveState.best[key] || 0;
  S.newBest = !prev || S.t < prev;
  if (S.newBest) saveState.best[key] = Math.round(S.t * 10) / 10;
  S.prevBest = prev;
  saveState.level = Math.min(LEVELS.length, Math.max(saveState.level, S.n + 1));
  saveData(saveState);
  if (S.n === LEVELS.length) toast('好了好了，不逗你了');
  setTimeout(showWin, S.n === LEVELS.length ? 1300 : 700);
}

function updateBar() {
  var left = remaining();
  $('progress').textContent = (left ? '还有 ' + left + ' 个没摆正' : '全摆正了') + ' · ' + S.t.toFixed(1) + ' 秒';
}

// ============ 画布 ============
var cv = $('cv');
var ctx = cv.getContext('2d');
var view = { sc: 1, ox: 0, oy: 0, dpr: 1, cw: 0, ch: 0 };

function resizeGame() {
  var stage = $('stage');
  var cw = stage.clientWidth, ch = stage.clientHeight;
  if (!cw || !ch) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.style.width = cw + 'px';
  cv.style.height = ch + 'px';
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  var top = $('bar').offsetHeight, bottom = 48;
  var sc = Math.min(cw / W, (ch - top - bottom) / SH);
  view = { sc: sc, dpr: dpr, cw: cw, ch: ch, ox: (cw - W * sc) / 2, oy: top + (ch - top - bottom - SH * sc) / 2 };
}

function toScene(clientX, clientY) {
  var r = cv.getBoundingClientRect();
  return { x: (clientX - r.left - view.ox) / view.sc, y: (clientY - r.top - view.oy) / view.sc };
}

// 背景：先用底色铺满整块画布，再按场景坐标画家具
var BG_COLOR = { wall: '#ebe4d6', cork: '#ebe4d6', shelf: '#ebe4d6', desk: '#d9bc8f', tiles: '#e4dfd4', screen: '#d9bc8f', plate: '#e9e2d3', keyboard: '#d9bc8f' };

function paintScene(c, L, done) {
  var bg = L.bg;
  if (bg === 'wall' || bg === 'cork' || bg === 'shelf') {
    c.fillStyle = '#ddd1ba';
    c.fillRect(-600, 600, 1600, 900);
    c.fillStyle = '#cfc1a6';
    c.fillRect(-600, 600, 1600, 6);
  }
  if (bg === 'cork') {
    c.fillStyle = '#a7774c';
    rr(c, 24, 110, 342, 440, 6); c.fill();
    c.fillStyle = '#c9a274';
    c.fillRect(36, 122, 318, 416);
    c.fillStyle = 'rgba(120,80,40,0.18)';
    var R = rng(5);
    for (var i = 0; i < 160; i++) { c.fillRect(36 + R() * 316, 122 + R() * 414, 2, 2); }
  }
  if (bg === 'shelf') {
    (L.shelves || []).forEach(function (y) {
      c.fillStyle = '#a77a52';
      c.fillRect(30, y, 330, 12);
      c.fillStyle = '#8c6442';
      c.fillRect(30, y + 12, 330, 4);
      c.fillStyle = '#9b9387';
      c.fillRect(70, y + 16, 6, 18);
      c.fillRect(314, y + 16, 6, 18);
    });
  }
  if (bg === 'desk' || bg === 'screen' || bg === 'keyboard') {
    c.strokeStyle = 'rgba(120,80,40,0.16)';
    c.lineWidth = 2;
    for (var y = -300; y < 1000; y += 34) {
      c.beginPath();
      c.moveTo(-600, y);
      c.bezierCurveTo(0, y + 12, 200, y - 10, 1000, y + 6);
      c.stroke();
    }
  }
  if (bg === 'tiles') {
    c.fillStyle = '#cfc7b8';
    rr(c, 195 - TILE * 1.5 - 8, 330 - TILE * 1.5 - 8, TILE * 3 + 16, TILE * 3 + 16, 12); c.fill();
    // 不用转的两块素瓷砖
    [[1, 0], [2, 0]].forEach(function (p) {
      c.fillStyle = '#f8f4ec';
      rr(c, 195 + (p[1] - 1) * TILE - TILE / 2 + 2, 330 + (p[0] - 1) * TILE - TILE / 2 + 2, TILE - 4, TILE - 4, 8); c.fill();
    });
    // 起点和终点
    c.fillStyle = '#2f4858';
    c.fillRect(195 - TILE * 1.5 - 30, 330 - TILE - 8, 22, 16);
    c.fillRect(195 + TILE * 1.5 + 8, 330 - TILE - 8, 22, 16);
  }
  if (bg === 'screen') {
    c.fillStyle = '#2a2b2e';
    rr(c, 32, 170, 326, 230, 12); c.fill();
    c.fillStyle = '#f2f3f4';
    c.fillRect(44, 182, 302, 196);
    c.fillStyle = '#2a2b2e';
    c.fillRect(175, 400, 40, 34);
    rr(c, 130, 430, 130, 12, 6); c.fill();
    c.fillStyle = INK;
    c.font = '700 17px ' + FONT;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(done ? '加载完成' : '正在加载…', 195, 250);
    c.font = '700 26px ' + NUM_FONT;
    c.fillText(done ? '100%' : '99%', 195, 345);
    c.fillStyle = '#dfe2e5';
    c.fillRect(70, 290, 250, 20);
    c.fillStyle = '#2f4858';
    c.fillRect(70, 290, 224, 20);
    if (!done) {
      c.setLineDash([4, 4]);
      c.strokeStyle = 'rgba(28,28,30,0.35)';
      c.lineWidth = 1.5;
      c.strokeRect(294.5, 290.5, 25, 19);
      c.setLineDash([]);
    }
  }
  if (bg === 'plate') {
    c.fillStyle = 'rgba(0,0,0,0.06)';
    c.beginPath(); c.arc(195, 336, 168, 0, 7); c.fill();
    c.fillStyle = '#fbfaf6';
    c.beginPath(); c.arc(195, 330, 168, 0, 7); c.fill();
    c.strokeStyle = '#e6e0d3';
    c.lineWidth = 2;
    c.beginPath(); c.arc(195, 330, 140, 0, 7); c.stroke();
  }
  if (bg === 'keyboard') {
    c.fillStyle = '#bfb7a8';
    rr(c, 22, 334, 346, 120, 14); c.fill();
    c.fillStyle = '#d8d1c3';
    rr(c, 22, 330, 346, 116, 14); c.fill();
    // 第二排固定键帽，给个参照
    c.fillStyle = '#fbf9f4';
    for (var k = 0; k < 6; k++) { rr(c, 60 + k * 54 - 22 + 14, 420 - 22, 44, 30, 7); c.fill(); }
  }
}

// 拖动类物件的目标格子画成虚线轮廓
function paintSlots(c) {
  S.items.forEach(function (it) {
    if (it.kind !== 'slot' || it.done || it.paint === paintPiece) return;
    c.save();
    c.translate(it.slot.x, it.slot.y);
    c.setLineDash([5, 5]);
    c.strokeStyle = 'rgba(28,28,30,0.28)';
    c.lineWidth = 1.5;
    if (it.paint === paintKey) {
      rr(c, -22, -22, 44, 44, 8); c.stroke();
      c.fillStyle = 'rgba(28,28,30,0.25)';
      c.font = '700 16px ' + FONT;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(it.letter, 0, 0);
    } else {
      rr(c, -it.w / 2, -it.h / 2, it.w, it.h, 3); c.stroke();
    }
    c.setLineDash([]);
    c.restore();
  });
}

function itemShadow(c, lifted) {
  c.shadowColor = 'rgba(40,30,15,' + (lifted ? 0.28 : 0.18) + ')';
  c.shadowBlur = lifted ? 18 : 8;
  c.shadowOffsetY = lifted ? 10 : 3;
}

function paintItem(c, it, lifted) {
  if (it.nail) {
    var nx = it.x, ny = it.y - it.h / 2 - 34;
    var ca = Math.cos(it.ra), sa = Math.sin(it.ra);
    var ends = [-it.w * 0.3, it.w * 0.3].map(function (dx) {
      var dy = -it.h / 2 + 4;
      return [it.rx + dx * ca - dy * sa, it.ry + dx * sa + dy * ca];
    });
    c.strokeStyle = 'rgba(60,50,40,0.55)';
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(ends[0][0], ends[0][1]); c.lineTo(nx, ny); c.lineTo(ends[1][0], ends[1][1]);
    c.stroke();
    c.fillStyle = '#6d655a';
    c.beginPath(); c.arc(nx, ny, 3, 0, 7); c.fill();
  }
  c.save();
  c.translate(it.rx, it.ry);
  c.rotate(it.ra);
  var k = it.pop > 0 ? 1 + Math.sin((0.3 - it.pop) / 0.3 * Math.PI) * 0.06 : 1;
  c.scale(it.sx * k * (lifted ? 1.05 : 1), k * (lifted ? 1.05 : 1));
  itemShadow(c, lifted);
  it.paint(c, it);
  c.restore();
}

function hintOutline(c, it, t) {
  var a = 0.5 + Math.sin(t * 10) * 0.4;
  c.save();
  c.translate(it.rx, it.ry);
  c.rotate(it.ra);
  c.strokeStyle = 'rgba(229,67,45,' + a.toFixed(2) + ')';
  c.lineWidth = 3;
  rr(c, -it.w / 2 - 8, -it.h / 2 - 8, it.w + 16, it.h + 16, 10);
  c.stroke();
  c.restore();
  if (it.kind === 'slot') {
    c.save();
    c.strokeStyle = 'rgba(229,67,45,' + a.toFixed(2) + ')';
    c.lineWidth = 2;
    c.strokeRect(it.slot.x - it.w / 2 - 5, it.slot.y - it.h / 2 - 5, it.w + 10, it.h + 10);
    c.restore();
  }
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!S) return;
  ctx.fillStyle = BG_COLOR[S.L.bg] || PAPER;
  ctx.fillRect(0, 0, cv.width, cv.height);
  var px = view.dpr * view.sc;
  ctx.setTransform(px, 0, 0, px, view.dpr * view.ox, view.dpr * view.oy);

  paintScene(ctx, S.L, S.status !== 'play' || remaining() === 0);
  paintSlots(ctx);
  var list = S.items.slice().sort(function (a, b) { return a.z - b.z; });
  list.forEach(function (it) { if (S.drag && S.drag.it === it) return; paintItem(ctx, it, false); });
  if (S.drag) paintItem(ctx, S.drag.it, S.drag.it.kind === 'slot');
  if (S.hintT > 0 && S.hintItem) hintOutline(ctx, S.hintItem, S.hintT);
}

function step(dt) {
  if (!S) return;
  if (S.status === 'play') {
    S.t += dt;
    S.barT = (S.barT || 0) + dt;
    if (S.barT > 0.1) { S.barT = 0; updateBar(); }
  }
  S.items.forEach(function (it) {
    var k = it.slow ? Math.min(1, dt * 2.2) : Math.min(1, dt * 16);
    if (!(S.drag && S.drag.it === it && it.kind === 'rotate')) it.ra += (it.a - it.ra) * k;
    if (it.slow && Math.abs(it.a - it.ra) < 0.002) it.slow = false;
    if (!(S.drag && S.drag.it === it)) {
      it.rx += (it.x - it.rx) * Math.min(1, dt * 16);
      it.ry += (it.y - it.ry) * Math.min(1, dt * 16);
    }
    if (it.kind === 'flip') it.sx += ((it.f ? -1 : 1) - it.sx) * Math.min(1, dt * 14);
    if (it.pop > 0) it.pop = Math.max(0, it.pop - dt);
  });
  if (S.hintT > 0) S.hintT = Math.max(0, S.hintT - dt);
}

// ============ 输入 ============
function hitItem(p) {
  var list = S.items.slice().sort(function (a, b) { return b.z - a.z; });
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (it.done) continue;
    var dx = p.x - it.rx, dy = p.y - it.ry;
    var ca = Math.cos(-it.ra), sa = Math.sin(-it.ra);
    var lx = dx * ca - dy * sa, ly = dx * sa + dy * ca;
    var pad = it.w < 50 || it.h < 50 ? 14 : 8;
    if (Math.abs(lx) <= it.w / 2 + pad && Math.abs(ly) <= it.h / 2 + pad) return it;
  }
  return null;
}

var zTop = 100;
function onDown(e) {
  initAudio();
  if (!S || S.status !== 'play' || S.drag) return;
  var p = toScene(e.clientX, e.clientY);
  var it = hitItem(p);
  if (!it) return;
  S.drag = { it: it, start: p, moved: 0, prevAng: Math.atan2(p.y - it.ry, p.x - it.rx), tickAcc: 0, offX: p.x - it.x, offY: p.y - it.y };
  if (it.kind === 'slot') { it.z = ++zTop; sfx.pick(); }
}

function onMove(e) {
  if (!S || !S.drag) return;
  var d = S.drag, it = d.it;
  var p = toScene(e.clientX, e.clientY);
  d.moved = Math.max(d.moved, Math.abs(p.x - d.start.x) + Math.abs(p.y - d.start.y));
  if (it.kind === 'rotate') {
    var r = Math.sqrt((p.x - it.rx) * (p.x - it.rx) + (p.y - it.ry) * (p.y - it.ry));
    var ang = Math.atan2(p.y - it.ry, p.x - it.rx);
    // 手指太靠近中心时角度乱跳，只记位置不转
    if (r > 14) {
      var da = adiff(ang, d.prevAng);
      it.a += da;
      it.ra = it.a;
      d.tickAcc += Math.abs(da);
      if (d.tickAcc > 3 * DEG) { d.tickAcc = 0; sfx.tick(); }
    }
    d.prevAng = ang;
  } else if (it.kind === 'slot') {
    it.x = p.x - d.offX;
    it.y = p.y - d.offY;
    it.rx = it.x; it.ry = it.y;
  }
}

function onUp() {
  if (!S || !S.drag) return;
  var d = S.drag, it = d.it;
  S.drag = null;
  if (S.status !== 'play') return;
  if (it.kind === 'rotate') {
    var off = adiff(it.a, it.ta);
    if (Math.abs(off) < SNAP_DEG * DEG) { it.a -= off; markDone(it); }
  } else if (it.kind === 'slot') {
    var dx = it.x - it.slot.x, dy = it.y - it.slot.y;
    if (Math.sqrt(dx * dx + dy * dy) < SLOT_DIST) {
      it.x = it.slot.x; it.y = it.slot.y;
      it.a = it.a - adiff(it.a, 0);
      it.z = 0;
      markDone(it);
    } else sfx.drop();
  } else if (d.moved < 12) {
    if (it.kind === 'flip') {
      it.f = !it.f;
      sfx.flip();
      if (it.f === it.tf) markDone(it);
    } else if (it.kind === 'turn') {
      it.r = (it.r + 1) % 4;
      it.a += Math.PI / 2;
      sfx.flip();
      if ((it.r - it.tr + 4) % it.period === 0) markDone(it);
    }
  }
}

if (window.PointerEvent) {
  cv.addEventListener('pointerdown', function (e) { e.preventDefault(); onDown(e); });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
} else {
  var touchXY = function (e) { var t = e.changedTouches[0]; return { clientX: t.clientX, clientY: t.clientY }; };
  cv.addEventListener('touchstart', function (e) { e.preventDefault(); onDown(touchXY(e)); }, { passive: false });
  cv.addEventListener('touchmove', function (e) { e.preventDefault(); onMove(touchXY(e)); }, { passive: false });
  cv.addEventListener('touchend', function (e) { e.preventDefault(); onUp(); }, { passive: false });
  cv.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

// ============ 首页：几样歪着的东西，点一下会摆正，过一会儿又歪回去 ============
var hero = { c: null, w: 0, h: 0, items: [] };

function resizeHome() {
  var box = $('home');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  hero.c = setupCanvas($('hero-cv'), w, h).c;
  hero.w = w; hero.h = h;
  var s = Math.min(1.1, w / 390);
  var y0 = h * 0.52;
  hero.s = s;
  hero.items = [
    frame(w * 0.3, y0 - 20 * s, 120, 92, 0, '#2b2b2b', -12),
    note(w * 0.74, y0 - 40 * s, 70, NOTE_COLORS[0], 15),
    mug(w * 0.66, y0 + 70 * s, MUG_COLORS[1], true),
    mk({ kind: 'rotate', paint: paintPencil, x: w * 0.28, y: y0 + 96 * s, w: 14, h: 150, color: '#2f4858', a: 64 * DEG, ta: 90 * DEG })
  ];
  hero.items.forEach(function (it) { it.home = { a: it.a, f: it.f }; it.back = 0; });
}

function stepHome(dt) {
  hero.items.forEach(function (it) {
    if (it.back > 0) {
      it.back -= dt;
      if (it.back <= 0) { it.a = it.home.a; it.f = it.home.f; it.slow = true; }
    }
    var k = it.slow ? Math.min(1, dt * 3) : Math.min(1, dt * 16);
    it.ra += (it.a - it.ra) * k;
    if (it.kind === 'flip') it.sx += ((it.f ? -1 : 1) - it.sx) * Math.min(1, dt * 14);
    if (it.pop > 0) it.pop = Math.max(0, it.pop - dt);
  });
}

function drawHome() {
  var c = hero.c, w = hero.w, h = hero.h;
  if (!c) return;
  c.fillStyle = PAPER;
  c.fillRect(0, 0, w, h);
  // 方格纸
  c.strokeStyle = 'rgba(28,28,30,0.05)';
  c.lineWidth = 1;
  c.beginPath();
  for (var x = 0.5; x < w; x += 24) { c.moveTo(x, 0); c.lineTo(x, h); }
  for (var y = 0.5; y < h; y += 24) { c.moveTo(0, y); c.lineTo(w, y); }
  c.stroke();
  hero.items.forEach(function (it) {
    c.save();
    c.translate(it.x, it.y);
    c.scale(hero.s, hero.s);
    c.translate(-it.x, -it.y);
    paintItem(c, it, false);
    c.restore();
  });
}

$('hero-cv').addEventListener('click', function (e) {
  initAudio();
  var best = null, bd = 1e9;
  hero.items.forEach(function (it) {
    var dx = e.clientX - it.x, dy = e.clientY - it.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = it; }
  });
  if (!best || bd > 110 * 110 || best.back > 0) return;
  best.slow = false;
  if (best.kind === 'flip') best.f = false; else best.a = best.ta;
  best.pop = 0.3;
  best.back = 1.8;
  sfx.snap(2);
});

// 标题里歪着的「死」
var crookTimer = null;
$('crook').addEventListener('click', function () {
  initAudio();
  var el = $('crook');
  if (el.classList.contains('fixed')) return;
  el.classList.add('fixed');
  sfx.snap(3);
  $('crook-note').textContent = '舒服吗？别急，进游戏还有一堆';
  clearTimeout(crookTimer);
  crookTimer = setTimeout(function () {
    el.classList.remove('fixed');
    sfx.troll();
    $('crook-note').textContent = '东西全摆歪了，你来把它们摆正';
  }, 1800);
});

// ============ 主循环 ============
var last = 0, running = true, inGame = false;

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
    if (audio) audio.resume();
    running = true;
    last = 0;
    requestAnimationFrame(loop);
  }
});

// ============ 页面切换 ============
function showHome() {
  inGame = false;
  hideOverlay();
  $('game').classList.add('hidden');
  $('home').classList.remove('hidden');
  renderHome();
  resizeHome();
}

function showGame(n) {
  initAudio();
  $('home').classList.add('hidden');
  $('game').classList.remove('hidden');
  resizeGame();
  startLevel(n);
  inGame = true;
}

function clearedCount() {
  var n = 0;
  for (var k in saveState.best) if (saveState.best[k]) n++;
  return n;
}

function renderHome() {
  var lv = saveState.level, done = clearedCount();
  $('home-best').innerHTML = done
    ? '已摆正 <b>' + done + ' / ' + LEVELS.length + '</b> 关'
    : '一共 ' + LEVELS.length + ' 关，最后一关有坑';
  $('btn-start').textContent = done ? '继续第 ' + lv + ' 关' : '开始摆正';
  $('nav-sound').classList.toggle('muted', !!saveState.muted);
  $('sound-label').textContent = saveState.muted ? '声音关' : '声音开';
  renderFollow();
}

$('btn-start').addEventListener('click', function () { showGame(saveState.level); });
$('btn-back').addEventListener('click', showHome);
$('btn-restart').addEventListener('click', function () { initAudio(); startLevel(S.n); });

$('btn-hint').addEventListener('click', function () {
  if (!S || S.status !== 'play') return;
  var it = null;
  S.items.forEach(function (x) { if (!it && !x.done) it = x; });
  if (!it) return;
  S.hintItem = it;
  S.hintT = 1.8;
  sfx.click();
});

$('nav-sound').addEventListener('click', function () {
  saveState.muted = !saveState.muted;
  saveData(saveState);
  renderHome();
  if (!saveState.muted) { initAudio(); sfx.snap(1); }
});

$('nav-help').addEventListener('click', function () {
  openDialog({
    kicker: '怎么玩',
    title: '把歪的都摆正',
    html: '<ol><li>画框、便利贴、饼干：按住它转，转到差不多正的时候松手，会「咔」一下吸正。</li>' +
          '<li>书、铅笔、键帽：拖到虚线框里。</li>' +
          '<li>杯子、瓷砖：点一下就转。</li>' +
          '<li>卡住了点右上角的灯泡，会告诉你哪个还没摆正。</li>' +
          '<li>每关记最快用时。最后一关……玩了就知道。</li></ol>',
    main: '知道了',
    onMain: closeDialog
  });
});

$('nav-levels').addEventListener('click', function () {
  var unlocked = Math.max(1, saveState.level);
  var html = '<div class="lv-grid">';
  for (var n = 1; n <= LEVELS.length; n++) {
    var b = saveState.best[String(n)];
    var cls = n > unlocked ? 'locked' : (n === unlocked && !b ? 'current' : '');
    var tag = n > unlocked ? '没解锁' : (b ? b.toFixed(1) + ' 秒' : LEVELS[n - 1].name);
    html += '<button type="button" data-lv="' + n + '" class="' + cls + '">' + n + '<small>' + tag + '</small></button>';
  }
  html += '</div>';
  openDialog({
    kicker: '已解锁 ' + unlocked + ' / ' + LEVELS.length + ' 关',
    title: '选关',
    html: html,
    main: '关闭',
    onMain: closeDialog
  });
});

$('dlg-body').addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('button[data-lv]') : null;
  if (!btn) return;
  var n = parseInt(btn.getAttribute('data-lv'), 10);
  if (n > Math.max(1, saveState.level)) { toast('先摆正第 ' + (n - 1) + ' 关'); return; }
  closeDialog();
  showGame(n);
});

function toast(msg) {
  var el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(function () { el.classList.add('hidden'); }, 2000);
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
  $('dialog').classList.remove('hidden');
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
  $('follow-label').textContent = follow.status === 2 ? '我是作者' : (follow.status === 1 ? '已关注' : '关注作者');
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
    kicker: '逼死强迫症的作者',
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
    second: '先去摆正',
    onSecond: closeDialog
  });
}

// ============ 结算 ============
function hideOverlay() { $('overlay').classList.add('hidden'); }

function showWin() {
  if (!S || S.status !== 'win') return;
  var n = S.n, last = n === LEVELS.length;
  $('r-kicker').textContent = '第 ' + n + ' 关 · ' + S.L.name;
  $('r-title').textContent = last ? '全部摆正' : CHEERS[(n - 1) % CHEERS.length];
  $('r-sub').textContent = SUBS[n] || '下一关更歪。';
  $('r-num').textContent = S.t.toFixed(1);
  $('r-best').innerHTML = S.newBest
    ? (S.prevBest ? '<b>新纪录</b>，之前 ' + S.prevBest.toFixed(1) + ' 秒' : '第一次通关')
    : '最快 ' + saveState.best[String(n)].toFixed(1) + ' 秒';
  var main = $('r-main');
  if (last) {
    main.textContent = '回到第 1 关再来一遍';
    main.onclick = function () { startLevel(1); };
  } else {
    main.textContent = '下一关';
    main.onclick = function () { startLevel(n + 1); };
  }
  $('overlay').classList.remove('hidden');
}

$('r-again').addEventListener('click', function () { startLevel(S.n); });
$('r-home').addEventListener('click', showHome);
$('r-share').addEventListener('click', function () { shareNote(); });

// ============ 分享图与发笔记 ============
function makeShareImage() {
  var c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  var x = c.getContext('2d');
  x.fillStyle = PAPER;
  x.fillRect(0, 0, 900, 1200);
  // 把摆好的场景截进来
  var sw = W * view.sc * view.dpr, sh = SH * view.sc * view.dpr;
  var gh = 820, gw = gh * W / SH;
  x.drawImage(cv, view.ox * view.dpr, view.oy * view.dpr, sw, sh, (900 - gw) / 2, 340, gw, gh);
  x.textBaseline = 'top';
  x.fillStyle = INK;
  x.font = '900 64px ' + FONT;
  x.fillText('逼死强迫症', 60, 60);
  x.font = '700 40px ' + FONT;
  x.fillText('第 ' + S.n + ' 关 · ' + S.L.name, 60, 150);
  x.fillStyle = RED;
  x.font = '700 110px ' + NUM_FONT;
  x.fillText(S.t.toFixed(1), 60, 205);
  var tw = x.measureText(S.t.toFixed(1)).width;
  x.fillStyle = INK;
  x.font = '700 40px ' + FONT;
  x.fillText('秒摆正', 80 + tw, 262);
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

async function shareNote() {
  if (!miniTool || typeof miniTool.postNote !== 'function') {
    toast('请在小红书里打开再发笔记');
    return false;
  }
  try {
    var url = await toFilePath(makeShareImage());
    await miniTool.postNote({
      title: '我用' + S.t.toFixed(1) + '秒把它摆正了',
      content: '小工具「逼死强迫症」第' + S.n + '关「' + S.L.name + '」，看着歪的东西真的浑身难受。你来试试多久能摆正？ #强迫症 #小游戏 #解压',
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
    saveState.level = Math.min(LEVELS.length, Math.max(1, d.level | 0));
    saveState.best = (d.best && typeof d.best === 'object') ? d.best : {};
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
