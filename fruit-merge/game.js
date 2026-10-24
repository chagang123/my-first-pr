(function () {
'use strict';

var M = window.Matter;

// ============ 常量 ============
var W = 390;
var H = 700;              // 逻辑高度随屏幕比例调整，见 resizeGame
var WALL = 10;
var PLAY_DEPTH = 560;
var DROP_Y = 62;
var DEAD_Y = 118;
var DROP_COOLDOWN = 450;
var OVER_LIMIT = 1600;     // 水果停在红线上方超过这么久判负
var PROTECT_MS = 3000;

var FRUITS = [
  { name: '樱桃',   r: 20, score: 1,  base: '#d8203a', light: '#ff7d8c', dark: '#8c0d20' },
  { name: '草莓',   r: 27, score: 3,  base: '#ff3d57', light: '#ff9aa6', dark: '#b3132d' },
  { name: '葡萄',   r: 35, score: 6,  base: '#7c3cc8', light: '#bb8cf2', dark: '#46187f' },
  { name: '橙子',   r: 43, score: 10, base: '#ff8a17', light: '#ffc470', dark: '#c45600' },
  { name: '桃子',   r: 50, score: 15, base: '#ff9f86', light: '#ffe0cf', dark: '#e3604f' },
  { name: '苹果',   r: 58, score: 21, base: '#e3302c', light: '#ff8f7a', dark: '#94160f' },
  { name: '梨',     r: 66, score: 28, base: '#d6dc4a', light: '#f6f8a8', dark: '#94a01b' },
  { name: '菠萝',   r: 74, score: 36, base: '#f6b42a', light: '#ffe18c', dark: '#b37208' },
  { name: '哈密瓜', r: 84, score: 45, base: '#c6d66a', light: '#eef5ba', dark: '#83942a' },
  { name: '西瓜',   r: 95, score: 55, base: '#2f9e48', light: '#86da95', dark: '#125a22' }
];
var DROP_WEIGHTS = [20, 20, 20, 20, 20];

function levelTarget(n) { return Math.floor(100 + (n - 1) * 50 * n / 2); }
function levelGravity(n) { return Math.min(1.5 + (n - 1) * 0.1, 3.0); }

// ============ 小红书端能力 ============
var xhs = window.xhs || null;
var miniTool = (xhs && xhs.miniTool) ? xhs.miniTool : null;
var STORE_KEY = 'fruit_merge_save';

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

async function saveData(obj) {
  var str;
  try { str = JSON.stringify(obj); } catch (e) { return false; }
  if (await canUse('setStorage', 9460)) {
    try { await miniTool.setStorage({ key: STORE_KEY, data: str }); return true; } catch (e) { /* 退回本地存储 */ }
  }
  try { localStorage.setItem(STORE_KEY, str); return true; } catch (e) { return false; }
}

async function loadData() {
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
var saveState = { level: 1, best: 0, bestScore: 0, muted: false };

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

var sfx = {
  drop: function () { beep(520, 0.09, 'sine', 0.12, 260); },
  merge: function (tier) {
    var f = 360 + tier * 70;
    beep(f, 0.12, 'triangle', 0.16);
    setTimeout(function () { beep(f * 1.5, 0.14, 'triangle', 0.12); }, 70);
  },
  win: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { beep(f, 0.18, 'triangle', 0.14); }, i * 110); }); },
  fail: function () { beep(330, 0.35, 'sine', 0.14, 140); }
};

// ============ 水果绘制 ============
function seeded(seed) {
  var a = seed;
  return function () {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296;
  };
}

function leaf(c, x, y, len, wid, ang, color) {
  c.save();
  c.translate(x, y);
  c.rotate(ang);
  c.beginPath();
  c.moveTo(0, 0);
  c.quadraticCurveTo(len * 0.5, -wid, len, 0);
  c.quadraticCurveTo(len * 0.5, wid, 0, 0);
  c.fillStyle = color || '#4caf3c';
  c.fill();
  c.strokeStyle = 'rgba(20,60,10,0.45)';
  c.lineWidth = Math.max(1, wid * 0.18);
  c.beginPath();
  c.moveTo(len * 0.1, 0);
  c.lineTo(len * 0.85, 0);
  c.stroke();
  c.restore();
}

function stem(c, x0, y0, x1, y1, cx, cy, w, color) {
  c.beginPath();
  c.moveTo(x0, y0);
  c.quadraticCurveTo(cx, cy, x1, y1);
  c.strokeStyle = color || '#6b4a2b';
  c.lineWidth = w;
  c.lineCap = 'round';
  c.stroke();
}

function ballPath(c, r) {
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
}

function shade(c, r, f) {
  var g = c.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.08, 0, 0, r);
  g.addColorStop(0, f.light);
  g.addColorStop(0.55, f.base);
  g.addColorStop(1, f.dark);
  ballPath(c, r);
  c.fillStyle = g;
  c.fill();
}

function gloss(c, r) {
  c.save();
  c.translate(-r * 0.36, -r * 0.42);
  c.rotate(-0.65);
  c.beginPath();
  c.ellipse(0, 0, r * 0.3, r * 0.15, 0, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.5)';
  c.fill();
  c.restore();
  ballPath(c, r);
  c.strokeStyle = 'rgba(0,0,0,0.28)';
  c.lineWidth = Math.max(1.2, r * 0.045);
  c.stroke();
}

var painters = [
  // 樱桃：长梗 + 小叶
  function (c, r, f) {
    shade(c, r, f);
    gloss(c, r);
    stem(c, 0, -r * 0.8, r * 0.42, -r * 1.55, r * 0.05, -r * 1.35, r * 0.13, '#5d7f23');
    leaf(c, r * 0.36, -r * 1.42, r * 0.75, r * 0.26, -0.35, '#58b544');
  },
  // 草莓：籽 + 绿萼
  function (c, r, f) {
    shade(c, r, f);
    c.save();
    ballPath(c, r * 0.97);
    c.clip();
    var rows = 5;
    for (var i = 0; i < rows; i++) {
      for (var j = 0; j < rows; j++) {
        var x = (j - (rows - 1) / 2) * r * 0.38 + (i % 2 ? r * 0.19 : 0);
        var y = (i - (rows - 1) / 2) * r * 0.36 + r * 0.12;
        if (x * x + y * y > r * r * 0.72) continue;
        c.beginPath();
        c.ellipse(x, y, r * 0.05, r * 0.08, 0, 0, Math.PI * 2);
        c.fillStyle = '#ffe36e';
        c.fill();
      }
    }
    c.restore();
    gloss(c, r);
    for (var k = 0; k < 6; k++) {
      leaf(c, 0, -r * 0.78, r * 0.55, r * 0.2, -Math.PI / 2 + (k - 2.5) * 0.55, '#3faa3a');
    }
    c.beginPath();
    c.arc(0, -r * 0.82, r * 0.12, 0, Math.PI * 2);
    c.fillStyle = '#2f8a2b';
    c.fill();
  },
  // 葡萄：一串小圆
  function (c, r, f) {
    ballPath(c, r);
    c.fillStyle = f.dark;
    c.fill();
    var pts = [[0, 0], [-0.5, -0.3], [0.5, -0.3], [-0.5, 0.32], [0.5, 0.32], [0, -0.6], [0, 0.62]];
    pts.forEach(function (p) {
      var x = p[0] * r, y = p[1] * r, rr = r * 0.36;
      var g = c.createRadialGradient(x - rr * 0.35, y - rr * 0.4, rr * 0.1, x, y, rr);
      g.addColorStop(0, f.light);
      g.addColorStop(0.6, f.base);
      g.addColorStop(1, f.dark);
      c.beginPath();
      c.arc(x, y, rr, 0, Math.PI * 2);
      c.fillStyle = g;
      c.fill();
      c.beginPath();
      c.arc(x - rr * 0.35, y - rr * 0.38, rr * 0.18, 0, Math.PI * 2);
      c.fillStyle = 'rgba(255,255,255,0.55)';
      c.fill();
    });
    ballPath(c, r);
    c.strokeStyle = 'rgba(0,0,0,0.3)';
    c.lineWidth = Math.max(1.2, r * 0.045);
    c.stroke();
    stem(c, 0, -r * 0.85, r * 0.12, -r * 1.25, r * 0.12, -r * 1.05, r * 0.11, '#6b4a2b');
    leaf(c, r * 0.1, -r * 1.12, r * 0.6, r * 0.22, -0.5, '#5bb247');
  },
  // 橙子：毛孔 + 叶子
  function (c, r, f) {
    shade(c, r, f);
    c.save();
    ballPath(c, r * 0.95);
    c.clip();
    var rnd = seeded(7);
    for (var i = 0; i < 60; i++) {
      var a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.92;
      c.beginPath();
      c.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.025, 0, Math.PI * 2);
      c.fillStyle = 'rgba(150,60,0,0.22)';
      c.fill();
    }
    c.restore();
    gloss(c, r);
    c.beginPath();
    c.arc(0, -r * 0.86, r * 0.08, 0, Math.PI * 2);
    c.fillStyle = '#3f7d22';
    c.fill();
    leaf(c, r * 0.04, -r * 0.88, r * 0.62, r * 0.22, -0.4, '#4fb03e');
  },
  // 桃子：中缝 + 红晕 + 两片叶
  function (c, r, f) {
    shade(c, r, f);
    var g = c.createRadialGradient(r * 0.35, r * 0.1, r * 0.05, r * 0.3, r * 0.1, r * 0.8);
    g.addColorStop(0, 'rgba(255,70,80,0.55)');
    g.addColorStop(1, 'rgba(255,70,80,0)');
    ballPath(c, r);
    c.fillStyle = g;
    c.fill();
    c.beginPath();
    c.moveTo(r * 0.02, -r * 0.92);
    c.bezierCurveTo(-r * 0.25, -r * 0.35, -r * 0.05, r * 0.3, r * 0.2, r * 0.7);
    c.strokeStyle = 'rgba(190,60,60,0.45)';
    c.lineWidth = r * 0.06;
    c.lineCap = 'round';
    c.stroke();
    gloss(c, r);
    leaf(c, 0, -r * 0.9, r * 0.6, r * 0.22, -0.55, '#4caf3c');
    leaf(c, 0, -r * 0.9, r * 0.5, r * 0.19, -2.5, '#3f9a33');
  },
  // 苹果：顶部凹陷 + 梗 + 叶
  function (c, r, f) {
    shade(c, r, f);
    var g = c.createLinearGradient(-r, 0, r, 0);
    g.addColorStop(0, 'rgba(255,220,90,0.28)');
    g.addColorStop(0.4, 'rgba(255,220,90,0)');
    ballPath(c, r);
    c.fillStyle = g;
    c.fill();
    c.beginPath();
    c.ellipse(0, -r * 0.74, r * 0.22, r * 0.1, 0, 0, Math.PI * 2);
    c.fillStyle = 'rgba(80,10,5,0.35)';
    c.fill();
    gloss(c, r);
    stem(c, 0, -r * 0.74, r * 0.1, -r * 1.22, r * -0.04, -r * 1.0, r * 0.09, '#6b4a2b');
    leaf(c, r * 0.06, -r * 1.05, r * 0.55, r * 0.2, -0.3, '#56b445');
  },
  // 梨：斑点 + 梗
  function (c, r, f) {
    shade(c, r, f);
    c.save();
    ballPath(c, r * 0.95);
    c.clip();
    var rnd = seeded(31);
    for (var i = 0; i < 45; i++) {
      var a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.9;
      c.beginPath();
      c.arc(Math.cos(a) * d, Math.sin(a) * d, r * 0.022, 0, Math.PI * 2);
      c.fillStyle = 'rgba(120,90,20,0.35)';
      c.fill();
    }
    c.restore();
    gloss(c, r);
    stem(c, 0, -r * 0.85, -r * 0.08, -r * 1.3, r * 0.08, -r * 1.1, r * 0.08, '#6b4a2b');
    leaf(c, -r * 0.04, -r * 1.12, r * 0.5, r * 0.18, -0.55, '#5aa83f');
  },
  // 菠萝：菱格纹 + 叶冠
  function (c, r, f) {
    for (var k = 0; k < 7; k++) {
      var a = -Math.PI / 2 + (k - 3) * 0.32;
      var len = r * (0.95 - Math.abs(k - 3) * 0.12);
      c.save();
      c.translate(0, -r * 0.72);
      c.rotate(a + Math.PI / 2);
      c.beginPath();
      c.moveTo(-r * 0.1, 0);
      c.lineTo(0, -len);
      c.lineTo(r * 0.1, 0);
      c.closePath();
      c.fillStyle = k % 2 ? '#2f8f3a' : '#43ad45';
      c.fill();
      c.restore();
    }
    shade(c, r, f);
    c.save();
    ballPath(c, r * 0.98);
    c.clip();
    c.strokeStyle = 'rgba(140,80,0,0.55)';
    c.lineWidth = r * 0.04;
    var step = r * 0.36;
    for (var d = -2 * r; d <= 2 * r; d += step) {
      c.beginPath(); c.moveTo(d - r, -r); c.lineTo(d + r, r); c.stroke();
      c.beginPath(); c.moveTo(d + r, -r); c.lineTo(d - r, r); c.stroke();
    }
    c.fillStyle = 'rgba(120,70,0,0.55)';
    for (var x = -2 * r; x <= 2 * r; x += step) {
      for (var y = -2 * r; y <= 2 * r; y += step) {
        var px = x + step / 2, py = y;
        if (px * px + py * py < r * r) { c.beginPath(); c.arc(px, py, r * 0.035, 0, Math.PI * 2); c.fill(); }
      }
    }
    c.restore();
    gloss(c, r);
  },
  // 哈密瓜：网纹
  function (c, r, f) {
    shade(c, r, f);
    c.save();
    ballPath(c, r * 0.97);
    c.clip();
    var rnd = seeded(97);
    c.strokeStyle = 'rgba(255,255,235,0.55)';
    c.lineWidth = r * 0.028;
    c.lineCap = 'round';
    for (var i = -5; i <= 5; i++) {
      var x = i * r * 0.2;
      var bow = x * 0.45;
      c.beginPath();
      c.moveTo(x + (rnd() - 0.5) * r * 0.06, -r);
      c.bezierCurveTo(x + bow + (rnd() - 0.5) * r * 0.12, -r * 0.35,
                      x + bow + (rnd() - 0.5) * r * 0.12, r * 0.35,
                      x + (rnd() - 0.5) * r * 0.06, r);
      c.stroke();
    }
    for (var j = -5; j <= 5; j++) {
      var y = j * r * 0.2;
      var bowy = y * 0.45;
      c.beginPath();
      c.moveTo(-r, y + (rnd() - 0.5) * r * 0.06);
      c.bezierCurveTo(-r * 0.35, y + bowy + (rnd() - 0.5) * r * 0.12,
                      r * 0.35, y + bowy + (rnd() - 0.5) * r * 0.12,
                      r, y + (rnd() - 0.5) * r * 0.06);
      c.stroke();
    }
    c.restore();
    gloss(c, r);
    c.beginPath();
    c.arc(0, -r * 0.9, r * 0.07, 0, Math.PI * 2);
    c.fillStyle = '#7a6a2a';
    c.fill();
  },
  // 西瓜：深色锯齿条纹
  function (c, r, f) {
    shade(c, r, f);
    c.save();
    ballPath(c, r * 0.99);
    c.clip();
    c.fillStyle = 'rgba(10,60,20,0.85)';
    for (var i = -4; i <= 4; i++) {
      var x0 = i * r * 0.3;
      var bend = x0 * 0.35;
      c.beginPath();
      var steps = 12, amp = r * 0.05, w = r * 0.075;
      for (var s = 0; s <= steps; s++) {
        var t = s / steps, y = -r + t * 2 * r;
        var curve = bend * Math.cos((t - 0.5) * Math.PI);
        var x = x0 + curve + (s % 2 ? amp : -amp) - w;
        if (s === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      for (var s2 = steps; s2 >= 0; s2--) {
        var t2 = s2 / steps, y2 = -r + t2 * 2 * r;
        var curve2 = bend * Math.cos((t2 - 0.5) * Math.PI);
        c.lineTo(x0 + curve2 + (s2 % 2 ? amp : -amp) + w, y2);
      }
      c.closePath();
      c.fill();
    }
    c.restore();
    gloss(c, r);
    c.beginPath();
    c.arc(0, -r * 0.92, r * 0.06, 0, Math.PI * 2);
    c.fillStyle = '#5a4a1a';
    c.fill();
  }
];

var SPRITE_PAD = 1.65;
var spriteCache = {};
var spriteCount = 0;

function fruitSprite(tier, pxScale) {
  var key = tier + '@' + pxScale.toFixed(2);
  if (!spriteCache[key]) {
    if (spriteCount > 80) { spriteCache = {}; spriteCount = 0; }
    spriteCount++;
    var f = FRUITS[tier];
    var side = Math.ceil(f.r * 2 * SPRITE_PAD * pxScale);
    var cnv = document.createElement('canvas');
    cnv.width = side; cnv.height = side;
    var c = cnv.getContext('2d');
    c.translate(side / 2, side / 2);
    c.scale(pxScale, pxScale);
    painters[tier](c, f.r, f);
    spriteCache[key] = cnv;
  }
  return spriteCache[key];
}

function paintFruit(c, tier, x, y, ang, pxScale, sizeMul) {
  var f = FRUITS[tier];
  var side = f.r * 2 * SPRITE_PAD * (sizeMul || 1);
  c.save();
  c.translate(x, y);
  if (ang) c.rotate(ang);
  c.drawImage(fruitSprite(tier, pxScale), -side / 2, -side / 2, side, side);
  c.restore();
}

// ============ 通用绘制 ============
function paintGrid(c, w, h, step) {
  c.strokeStyle = 'rgba(255,255,255,0.035)';
  c.lineWidth = 1;
  c.beginPath();
  for (var x = step; x < w; x += step) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); }
  for (var y = step; y < h; y += step) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); }
  c.stroke();
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

function paintStreaks(c, x, y, r, ang) {
  c.save();
  c.strokeStyle = '#fff';
  c.lineCap = 'round';
  for (var i = -1; i <= 1; i++) {
    var a = ang + i * 0.45;
    var r0 = r * 1.3, r1 = r * (i === 0 ? 1.85 : 1.65);
    c.lineWidth = i === 0 ? r * 0.12 : r * 0.08;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
    c.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
    c.stroke();
  }
  c.restore();
}

// ============ 首页大图 ============
function drawHero() {
  var box = $('hero');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  var s = setupCanvas($('hero-cv'), w, h);
  paintHeroArt(s.c, w, h, s.dpr);
}

function paintHeroArt(c, w, h, dpr) {
  var s = { dpr: dpr };
  var g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#131824');
  g.addColorStop(1, '#0d1016');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  paintGrid(c, w, h, 44);

  var u = Math.min(w, h * 0.75) / 390;
  function big(tier, x, y, size, ang) {
    var mul = size / FRUITS[tier].r;
    paintFruit(c, tier, x, y, ang, s.dpr * mul, mul);
  }
  big(9, w * 0.98, h * 0.3, 128 * u, -0.25);
  big(7, w * 0.12, h * 0.06, 70 * u, 0.5);
  big(3, w * 0.58, h * 0.12, 40 * u, 0.2);
  big(5, w * 0.86, h * 0.72, 52 * u, 0.15);
  big(2, w * 0.16, h * 0.33, 34 * u, -0.3);
  big(0, w * 0.6, h * 0.55, 24 * u, 0.1);
  paintStreaks(c, w * 0.6, h * 0.55, 24 * u, -2.3);
  big(1, w * 0.36, h * 0.2, 26 * u, -0.4);

  var g2 = c.createLinearGradient(0, h * 0.45, 0, h);
  g2.addColorStop(0, 'rgba(13,16,22,0)');
  g2.addColorStop(1, 'rgba(13,16,22,0.88)');
  c.fillStyle = g2;
  c.fillRect(0, h * 0.45, w, h * 0.55);
}

function drawDialogArt() {
  var box = $('dlg-art');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  box.innerHTML = '';
  var cnv = document.createElement('canvas');
  box.appendChild(cnv);
  var s = setupCanvas(cnv, w, h);
  var c = s.c;
  c.fillStyle = '#131824';
  c.fillRect(0, 0, w, h);
  paintGrid(c, w, h, 28);
  var row = [[0, 22], [1, 26], [3, 32], [5, 36], [9, 50]];
  var x = 34;
  row.forEach(function (it) {
    var mul = it[1] / FRUITS[it[0]].r;
    paintFruit(c, it[0], x, h - it[1] - 8, 0, s.dpr * mul, mul);
    x += it[1] * 2 + 6;
  });
}

// ============ 游戏状态 ============
var S = null;
var engine = null;
var cv = document.getElementById('cv');
var ctx = cv.getContext('2d');
var view = { scale: 1, ox: 0, oy: 0, dpr: 1 };

function randomTier() {
  var maxTier = 0;
  if (S) S.bodies.forEach(function (b) { if (b.tier > maxTier) maxTier = b.tier; });
  var cap = Math.min(DROP_WEIGHTS.length - 1, Math.max(3, maxTier));
  var sum = 0, i;
  for (i = 0; i <= cap; i++) sum += DROP_WEIGHTS[i];
  var r = Math.random() * sum;
  for (i = 0; i <= cap; i++) { r -= DROP_WEIGHTS[i]; if (r < 0) return i; }
  return 0;
}

function buildWorld() {
  if (engine) { M.Composite.clear(engine.world, false); M.Engine.clear(engine); }
  engine = M.Engine.create();
  engine.gravity.y = levelGravity(S.level);
  var t = 60;
  var opts = { isStatic: true, friction: 0.3, restitution: 0.1, label: 'wall' };
  M.Composite.add(engine.world, [
    M.Bodies.rectangle(W / 2, H + t / 2 - WALL, W + t * 2, t, opts),
    M.Bodies.rectangle(WALL - t / 2, H / 2 - 200, t, H + 400, opts),
    M.Bodies.rectangle(W - WALL + t / 2, H / 2 - 200, t, H + 400, opts)
  ]);
  M.Events.on(engine, 'collisionStart', onCollide);
  M.Events.on(engine, 'collisionActive', onCollide);
}

function startLevel(n) {
  S = {
    level: n,
    target: levelTarget(n),
    score: 0,
    bodies: [],
    merges: [],
    parts: [],
    floats: [],
    aimX: W / 2,
    cur: 0,
    next: 0,
    canDrop: true,
    dropAt: -9999,
    clock: 0,
    acc: 0,
    status: 'play',
    revived: false,
    reviveReady: false,
    protectUntil: 0,
    drops: 0,
    maxTier: 0
  };
  buildWorld();
  S.cur = randomTier();
  S.next = randomTier();
  hideOverlay();
  updateBar();
}

function addFruit(tier, x, y, isMerge) {
  var f = FRUITS[tier];
  var b = M.Bodies.circle(x, y, f.r, {
    restitution: 0.12,
    friction: 0.12,
    frictionStatic: 0.4,
    frictionAir: 0.008,
    density: 0.0012,
    label: 'fruit'
  });
  b.tier = tier;
  b.born = isMerge ? -99999 : S.clock;
  b.over = 0;
  b.dead = false;
  M.Composite.add(engine.world, b);
  S.bodies.push(b);
  if (tier > S.maxTier) S.maxTier = tier;
  return b;
}

function removeFruit(b) {
  b.dead = true;
  M.Composite.remove(engine.world, b);
  var i = S.bodies.indexOf(b);
  if (i >= 0) S.bodies.splice(i, 1);
}

function onCollide(ev) {
  for (var i = 0; i < ev.pairs.length; i++) {
    var a = ev.pairs[i].bodyA, b = ev.pairs[i].bodyB;
    if (a.label !== 'fruit' || b.label !== 'fruit') continue;
    if (a.tier !== b.tier || a.dead || b.dead || a.merging || b.merging) continue;
    a.merging = b.merging = true;
    S.merges.push([a, b]);
  }
}

function processMerges() {
  var list = S.merges;
  S.merges = [];
  list.forEach(function (pair) {
    var a = pair[0], b = pair[1];
    if (a.dead || b.dead) return;
    var tier = a.tier;
    var x = (a.position.x + b.position.x) / 2;
    var y = (a.position.y + b.position.y) / 2;
    removeFruit(a);
    removeFruit(b);
    var gain;
    if (tier === FRUITS.length - 1) {
      gain = 100;
      burst(x, y, FRUITS[tier], 26);
    } else {
      var nb = addFruit(tier + 1, x, y, true);
      M.Body.setVelocity(nb, { x: 0, y: -1.5 });
      gain = FRUITS[tier + 1].score;
      burst(x, y, FRUITS[tier + 1], 12);
    }
    sfx.merge(tier);
    vibrate(tier >= 5 ? 'medium' : 'light');
    S.floats.push({ x: x, y: y, text: '+' + gain, life: 700, max: 700 });
    S.score += gain;
    updateBar();
  });
  if (S.status === 'play' && S.score >= S.target) win();
}

function burst(x, y, f, n) {
  for (var i = 0; i < n; i++) {
    var a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 3;
    S.parts.push({
      x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 1,
      r: 2 + Math.random() * 4, color: i % 3 ? f.base : f.light, life: 500, max: 500
    });
  }
}

function drop() {
  if (!S || S.status !== 'play' || !S.canDrop) return;
  var r = FRUITS[S.cur].r;
  var x = Math.max(WALL + r + 1, Math.min(W - WALL - r - 1, S.aimX));
  addFruit(S.cur, x, DROP_Y, false);
  S.cur = S.next;
  S.next = randomTier();
  S.canDrop = false;
  S.dropAt = S.clock;
  S.drops++;
  sfx.drop();
}

function checkOver(dt) {
  if (S.clock < S.protectUntil) {
    S.bodies.forEach(function (b) { b.over = 0; });
    return false;
  }
  for (var i = 0; i < S.bodies.length; i++) {
    var b = S.bodies[i];
    var top = b.position.y - FRUITS[b.tier].r;
    if (S.clock - b.born > 900 && top < DEAD_Y) {
      b.over += dt;
      if (b.over > OVER_LIMIT) return true;
    } else {
      b.over = 0;
    }
  }
  return false;
}

function dangerLevel() {
  var m = 0;
  S.bodies.forEach(function (b) {
    if (S.clock - b.born < 900) return;
    var top = b.position.y - FRUITS[b.tier].r;
    if (top < DEAD_Y + 50) m = Math.max(m, Math.min(1, (DEAD_Y + 50 - top) / 50));
  });
  return m;
}

function win() {
  S.status = 'win';
  sfx.win();
  vibrate('heavy');
  if (S.level + 1 > saveState.level) saveState.level = S.level + 1;
  if (S.level > saveState.best) saveState.best = S.level;
  if (S.score > saveState.bestScore) saveState.bestScore = S.score;
  saveData(saveState);
  setTimeout(showWin, 600);
}

function fail() {
  S.status = 'fail';
  sfx.fail();
  vibrate('heavy');
  if (S.score > saveState.bestScore) { saveState.bestScore = S.score; saveData(saveState); }
  setTimeout(showFail, 500);
}

function revive() {
  var cut = DEAD_Y + 170;
  S.bodies.slice().forEach(function (b) {
    if (b.position.y - FRUITS[b.tier].r < cut) {
      burst(b.position.x, b.position.y, FRUITS[b.tier], 8);
      removeFruit(b);
    }
  });
  S.revived = true;
  S.reviveReady = false;
  S.protectUntil = S.clock + PROTECT_MS;
  S.status = 'play';
  S.canDrop = true;
  hideOverlay();
}

// ============ 主循环 ============
var STEP = 1000 / 60;
var last = 0, running = true, inGame = false;

function step(dt) {
  if (!S) return;
  if (S.status === 'play') {
    S.acc += dt;
    while (S.acc >= STEP) {
      M.Engine.update(engine, STEP);
      S.acc -= STEP;
      S.clock += STEP;
      processMerges();
      if (S.status !== 'play') break;
      if (checkOver(STEP)) { fail(); break; }
    }
    if (!S.canDrop && S.clock - S.dropAt > DROP_COOLDOWN) S.canDrop = true;
  }
  S.parts = S.parts.filter(function (p) {
    p.life -= dt;
    p.x += p.vx * dt / 16; p.y += p.vy * dt / 16; p.vy += 0.15 * dt / 16;
    return p.life > 0;
  });
  S.floats = S.floats.filter(function (f) { f.life -= dt; f.y -= 0.05 * dt; return f.life > 0; });
}

function render() {
  var px = view.dpr * view.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(px, 0, 0, px, view.dpr * view.ox, view.dpr * view.oy);
  if (!S) return;

  // 容器
  roundRectPath(ctx, WALL - 4, 0, W - WALL * 2 + 8, H - WALL + 4, 14);
  ctx.fillStyle = '#151922';
  ctx.fill();
  ctx.save();
  roundRectPath(ctx, WALL - 4, 0, W - WALL * 2 + 8, H - WALL + 4, 14);
  ctx.clip();
  paintGrid(ctx, W, H, 30);
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  ctx.fillRect(0, 0, W, DEAD_Y);
  ctx.restore();

  // 红线
  var danger = S.status === 'play' ? dangerLevel() : 0;
  ctx.save();
  ctx.setLineDash([8, 7]);
  ctx.lineWidth = 2;
  var pulse = danger > 0 ? 0.45 + 0.55 * Math.abs(Math.sin(S.clock / 120)) * danger : 0.3;
  ctx.strokeStyle = 'rgba(255,59,79,' + pulse.toFixed(2) + ')';
  ctx.beginPath();
  ctx.moveTo(WALL, DEAD_Y);
  ctx.lineTo(W - WALL, DEAD_Y);
  ctx.stroke();
  ctx.restore();

  // 下一个
  ctx.fillStyle = '#8b93a1';
  ctx.font = '600 12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('下一个', W - 44, 18);
  var nf = FRUITS[S.next];
  var nmul = Math.min(1, 17 / nf.r);
  paintFruit(ctx, S.next, W - 44, 48, 0, px * nmul, nmul);

  // 瞄准与待落水果
  if (S.status === 'play') {
    var r = FRUITS[S.cur].r;
    var ax = Math.max(WALL + r + 1, Math.min(W - WALL - r - 1, S.aimX));
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ax, DROP_Y + r + 4);
    ctx.lineTo(ax, H - WALL);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = S.canDrop ? 1 : 0.35;
    paintFruit(ctx, S.cur, ax, DROP_Y, 0, px);
    ctx.restore();
  }

  // 水果
  S.bodies.forEach(function (b) {
    paintFruit(ctx, b.tier, b.position.x, b.position.y, b.angle, px);
  });

  // 粒子与飘字
  S.parts.forEach(function (p) {
    ctx.globalAlpha = p.life / p.max;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.font = '900 20px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  S.floats.forEach(function (f) {
    ctx.globalAlpha = Math.min(1, f.life / f.max * 1.6);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(f.text, f.x, f.y);
    ctx.fillStyle = '#fff';
    ctx.fillText(f.text, f.x, f.y);
  });
  ctx.globalAlpha = 1;

  // 复活保护倒计时
  if (S.status === 'play' && S.clock < S.protectUntil) {
    var left = Math.ceil((S.protectUntil - S.clock) / 1000);
    ctx.fillStyle = '#66dcff';
    ctx.font = '800 15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText('保护中 ' + left, W / 2, DEAD_Y + 18);
  }
}

function loop(ts) {
  if (!running) return;
  var dt = last ? Math.min(ts - last, 50) : 16;
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

// ============ 画布尺寸 ============
function resizeGame() {
  var stage = $('stage');
  var cw = stage.clientWidth, ch = stage.clientHeight;
  if (!cw || !ch) return;
  if (!S || S.bodies.length === 0) {
    H = Math.round(Math.max(600, Math.min(860, W * ch / cw)));
    // 红线以下的空间固定，长屏多出来的高度放在红线上方，保证各机型难度一致
    DEAD_Y = Math.max(118, H - PLAY_DEPTH);
    DROP_Y = DEAD_Y - 56;
  }
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.style.width = cw + 'px';
  cv.style.height = ch + 'px';
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  var sc = Math.min(cw / W, ch / H);
  view = { scale: sc, ox: (cw - W * sc) / 2, oy: (ch - H * sc) / 2, dpr: dpr };
}

// ============ 输入 ============
function toLogicalX(clientX) {
  var r = cv.getBoundingClientRect();
  return (clientX - r.left - view.ox) / view.scale;
}

var pointerDown = false;
function onDown(x) { initAudio(); pointerDown = true; if (S) S.aimX = toLogicalX(x); }
function onMove(x) { if (pointerDown && S) S.aimX = toLogicalX(x); }
function onUp(x) {
  if (!pointerDown) return;
  pointerDown = false;
  if (!S) return;
  S.aimX = toLogicalX(x);
  drop();
}

if (window.PointerEvent) {
  cv.addEventListener('pointerdown', function (e) { e.preventDefault(); onDown(e.clientX); });
  cv.addEventListener('pointermove', function (e) { onMove(e.clientX); });
  window.addEventListener('pointerup', function (e) { onUp(e.clientX); });
} else {
  cv.addEventListener('touchstart', function (e) { e.preventDefault(); onDown(e.changedTouches[0].clientX); }, { passive: false });
  cv.addEventListener('touchmove', function (e) { e.preventDefault(); onMove(e.changedTouches[0].clientX); }, { passive: false });
  cv.addEventListener('touchend', function (e) { onUp(e.changedTouches[0].clientX); });
  cv.addEventListener('mousedown', function (e) { onDown(e.clientX); });
  window.addEventListener('mousemove', function (e) { onMove(e.clientX); });
  window.addEventListener('mouseup', function (e) { onUp(e.clientX); });
}

// ============ 页面切换 ============
function $(id) { return document.getElementById(id); }

function showHome() {
  inGame = false;
  hideOverlay();
  $('game').classList.add('hidden');
  $('home').classList.remove('hidden');
  renderHome();
  drawHero();
}

function showGame(level) {
  initAudio();
  $('home').classList.add('hidden');
  $('game').classList.remove('hidden');
  S = null;
  resizeGame();
  startLevel(level);
  inGame = true;
}

function renderHome() {
  $('home-best').innerHTML = saveState.best > 0
    ? '最高通关 <b>第 ' + saveState.best + ' 关</b> · 单关最高 <b>' + saveState.bestScore + ' 分</b>'
    : '第 1 关目标 ' + levelTarget(1) + ' 分，先热热手';
  $('btn-start').innerHTML = (saveState.level > 1 ? '继续第 ' + saveState.level + ' 关' : '开始挑战') +
    '<svg class="arrow" viewBox="0 0 24 24"><path d="M3 12h16M13 6l6 6-6 6"/></svg>';
  $('nav-sound').classList.toggle('muted', !!saveState.muted);
  $('sound-label').textContent = saveState.muted ? '声音 关' : '声音 开';
  renderFollow();
}

function updateBar() {
  $('level').textContent = '第 ' + S.level + ' 关';
  $('progress').textContent = S.score + ' / ' + S.target + ' 分';
  $('bar-fill').style.width = Math.min(100, S.score / S.target * 100) + '%';
}

$('btn-start').addEventListener('click', function () { showGame(saveState.level); });
$('btn-back').addEventListener('click', showHome);
$('btn-restart').addEventListener('click', function () { initAudio(); startLevel(S.level); });

$('nav-sound').addEventListener('click', function () {
  saveState.muted = !saveState.muted;
  saveData(saveState);
  renderHome();
  if (!saveState.muted) { initAudio(); sfx.drop(); }
});

$('nav-help').addEventListener('click', function () {
  openDialog({
    kicker: '怎么玩',
    title: '玩法说明',
    html: '<ol><li>左右拖动选位置，松手让水果掉下去。</li>' +
          '<li>两个一样的水果碰到一起，会合成大一号的水果并加分。</li>' +
          '<li>樱桃 → 草莓 → 葡萄 → 橙子 → 桃子 → 苹果 → 梨 → 菠萝 → 哈密瓜 → 西瓜。</li>' +
          '<li>本关分数够了就过关；水果堆过红线太久算失败，发一篇笔记可以复活一次。</li></ol>',
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
    kicker: '果果碰碰碰的作者',
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
var ARROW = '<svg class="arrow" viewBox="0 0 24 24"><path d="M3 12h16M13 6l6 6-6 6"/></svg>';

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

  [['r-second', 'second', 'onSecond'], ['r-third', 'third', 'onThird']].forEach(function (b) {
    var el = $(b[0]);
    el.textContent = o[b[1]] || '';
    el.classList.toggle('hidden', !o[b[1]]);
    el.onclick = o[b[2]] || null;
  });
  $('overlay').classList.remove('hidden');
  $('overlay').scrollTop = 0;
}

function hideOverlay() { $('overlay').classList.add('hidden'); }

function showFail() {
  var canRevive = !S.revived;
  var o = {
    kicker: '第 ' + S.level + ' 关 · 本局成绩',
    num: String(S.score),
    unit: '/ ' + S.target + ' 分',
    tag: '差一点',
    title: '水果堆满了',
    sub: canRevive ? '清掉上面一层水果，再给 3 秒保护。' : '这关的复活机会用过了，重来一次吧。',
    stats: [['合出最大', FRUITS[S.maxTier].name], ['放下水果', S.drops + ' 个'], ['最高通关', saveState.best ? '第 ' + saveState.best + ' 关' : '暂无']],
    pct: S.score / S.target,
    hint: '还差 ' + Math.max(0, S.target - S.score) + ' 分过关'
  };
  if (canRevive) {
    o.main = '发笔记复活'; o.mainArrow = true; o.onMain = onReviveClick;
    o.note = '发布成功后手动继续 · 每关一次 · 3 秒保护';
    o.second = '重新开始本关'; o.onSecond = function () { startLevel(S.level); };
    o.third = '返回主页'; o.onThird = showHome;
  } else {
    o.main = '重新开始本关'; o.onMain = function () { startLevel(S.level); };
    o.second = '返回主页'; o.onSecond = showHome;
  }
  fillSheet(o);
}

function showWin() {
  fillSheet({
    kicker: '第 ' + S.level + ' 关 · 本局成绩',
    num: String(S.score),
    unit: '分',
    tag: S.revived ? '通关' : '一命通关',
    title: '第 ' + S.level + ' 关 通过',
    sub: '合出最大的是' + FRUITS[S.maxTier].name + '，放了 ' + S.drops + ' 个水果。',
    stats: [['本关目标', S.target + ' 分'], ['下一关目标', levelTarget(S.level + 1) + ' 分'], ['最高通关', '第 ' + saveState.best + ' 关']],
    pct: 1,
    hint: '下一关水果掉得更快',
    main: '下一关', mainArrow: true,
    onMain: function () { startLevel(S.level + 1); },
    second: '发笔记晒成绩',
    onSecond: function () { shareNote(false); },
    third: '返回主页',
    onThird: showHome
  });
}

async function onReviveClick() {
  var main = $('r-main');
  if (S.reviveReady) { revive(); return; }
  if (!miniTool || typeof miniTool.postNote !== 'function') {
    S.reviveReady = true;
    main.innerHTML = '继续游戏' + ARROW;
    $('r-note').textContent = '当前不在小红书里，预览环境直接给复活';
    return;
  }
  main.disabled = true;
  main.textContent = '正在打开发布页…';
  var ok = await shareNote(true);
  main.disabled = false;
  if (ok) {
    S.reviveReady = true;
    main.innerHTML = '继续游戏' + ARROW;
    $('r-note').textContent = '笔记已发布，点继续接着玩';
  } else {
    main.innerHTML = '发笔记复活' + ARROW;
    toast('没有发布成功，可以再试一次');
  }
}

// ============ 分享图与发笔记 ============
function makeShareImage(isFail) {
  var c = document.createElement('canvas');
  c.width = 900; c.height = 1200;
  var x = c.getContext('2d');
  x.fillStyle = '#0d1016';
  x.fillRect(0, 0, 900, 1200);
  paintGrid(x, 900, 1200, 60);

  var gh = 720, gw = gh * W / H;
  var gx = (900 - gw) / 2, gy = 1200 - gh - 36;
  x.drawImage(cv,
    view.ox * view.dpr, view.oy * view.dpr, W * view.scale * view.dpr, H * view.scale * view.dpr,
    gx, gy, gw, gh);

  var font = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  x.textBaseline = 'top';
  x.fillStyle = '#ffffff';
  x.font = '900 46px ' + font;
  x.fillText('果果', 56, 56);
  x.fillStyle = '#ff3b4f';
  x.fillText('碰碰碰', 56 + x.measureText('果果').width + 6, 56);
  x.fillStyle = '#ffffff';
  x.font = 'italic 900 130px ' + font;
  x.fillText('第 ' + S.level + ' 关', 50, 120);
  x.font = '800 44px ' + font;
  x.fillStyle = '#66dcff';
  x.fillText(isFail ? '还差 ' + (S.target - S.score) + ' 分就过了' : S.score + ' 分通关', 56, 282);
  x.fillStyle = '#8b93a1';
  x.font = '600 30px ' + font;
  x.fillText('合出最大：' + FRUITS[S.maxTier].name + (isFail ? ' · 你能过这关吗' : ' · 你来试试'), 56, 352);
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
    var title = isFail ? '合水果第' + S.level + '关，谁能过' : '合水果第' + S.level + '关通关';
    var content = isFail
      ? '在小工具「果果碰碰碰」卡在第' + S.level + '关，还差' + (S.target - S.score) + '分。你能过吗？ #合成大西瓜 #小游戏'
      : '小工具「果果碰碰碰」第' + S.level + '关过了，拿了' + S.score + '分。来比比？ #合成大西瓜 #小游戏';
    await miniTool.postNote({
      title: title,
      content: content,
      pageType: 'photo_publish',
      mediaInfo: { image_resources: [{ url: url }] }
    });
    return true;
  } catch (e) {
    return false;
  }
}

// ============ 启动 ============
window.addEventListener('resize', function () {
  if (inGame) resizeGame(); else drawHero();
});

(async function boot() {
  var d = await loadData();
  if (d) {
    saveState.level = Math.max(1, d.level | 0);
    saveState.best = Math.max(0, d.best | 0);
    saveState.bestScore = Math.max(0, d.bestScore | 0);
    saveState.muted = !!d.muted;
  }
  canVibrate = await canUse('vibrateShort', 9500);
  showHome();
  requestAnimationFrame(loop);
  await initFollow();
  setTimeout(maybeAskFollow, 350);
})();

})();
