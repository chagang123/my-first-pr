(function () {
'use strict';

// ============ 常量 ============
var W = 390, H = 720;
var SCREW_R = 15;
var PLATE_W = 36;
var BOX_Y = 58;
var BOX_XS = [105, 285];
var HOLE_DX = [-38, 0, 38];
var SLOT_Y = 150;
var SLOT_GAP = 44;
var BASE_SLOTS = 5;
var REVIVE_SLOTS = 3;
var BOARD = { x0: 10, y0: 186, x1: 380, y1: 712 };

var SCREW_COLORS = [
  { fill: '#ff3b4f', dark: '#b3192b' },
  { fill: '#3d8bff', dark: '#1d56b3' },
  { fill: '#ffc93c', dark: '#b88a0e' },
  { fill: '#35c97a', dark: '#1b8650' },
  { fill: '#ff8a3d', dark: '#b8561a' },
  { fill: '#b07a52', dark: '#73492c' },
  { fill: '#ff76b8', dark: '#b8407c' },
  { fill: '#2fd1c9', dark: '#168f89' }
];
var PLATE_COLORS = ['#e9dcc4', '#d5e0e6', '#eadbd3', '#dcdbe8', '#e3e0c8', '#d9d2c6'];

// ============ 小红书端能力 ============
var xhs = window.xhs || null;
var miniTool = (xhs && xhs.miniTool) ? xhs.miniTool : null;
var STORE_KEY = 'screw_jam_save';

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

async function clientAtLeast(minVersion) {
  var v = await getBuildVersion();
  return Math.floor(v / 1000) >= minVersion;
}

async function canUse(method, minVersion) {
  if (!miniTool || typeof miniTool[method] !== 'function') return false;
  return clientAtLeast(minVersion);
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
var saveState = { level: 1, best: 0, muted: false };

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
  pick: function () { beep(1400, 0.05, 'square', 0.05); setTimeout(function () { beep(900, 0.06, 'triangle', 0.1); }, 40); },
  blocked: function () { beep(180, 0.12, 'sawtooth', 0.06); },
  box: function () { beep(660, 0.1, 'triangle', 0.14); setTimeout(function () { beep(990, 0.14, 'triangle', 0.14); }, 90); },
  drop: function () { beep(300, 0.25, 'sine', 0.1, 90); },
  win: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { beep(f, 0.18, 'triangle', 0.14); }, i * 110); }); },
  fail: function () { beep(330, 0.35, 'sine', 0.14, 140); }
};

// ============ 随机数（关卡可复现） ============
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ============ 几何 ============
function rectDist(px, py, p) {
  var dx = px - p.cx, dy = py - p.cy;
  var c = Math.cos(p.ang), s = Math.sin(p.ang);
  var lx = dx * c + dy * s;
  var ly = -dx * s + dy * c;
  var qx = Math.max(Math.abs(lx) - p.len / 2, 0);
  var qy = Math.max(Math.abs(ly) - PLATE_W / 2, 0);
  return Math.sqrt(qx * qx + qy * qy);
}

// ============ 关卡生成 ============
function levelParams(n) {
  return {
    plates: Math.min(7 + n * 2, 24),
    colors: Math.min(4 + Math.floor(n / 2), 7),
    shuffle: Math.min(4 + n * 2, 14),
    spread: Math.max(0.42, 0.62 - n * 0.02)
  };
}

// 瞎点玩家的通关率上限；会想的玩家的目标通关率（逐关降低，有下限，保证始终有解）
function levelBar(n) {
  return {
    randMax: n <= 1 ? 0.3 : (n === 2 ? 0.12 : 0.05),
    smartTarget: Math.max(0.35, 0.95 - n * 0.07)
  };
}

function genCandidate(n, seed, shuffleScale) {
  var rng = mulberry32(seed);
  var prm = levelParams(n);
  if (shuffleScale !== undefined) prm.shuffle = Math.round(prm.shuffle * shuffleScale);
  var plates = [];
  var screws = [];
  var midX = (BOARD.x0 + BOARD.x1) / 2, midY = (BOARD.y0 + BOARD.y1) / 2;
  var angles = [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4, 0, Math.PI / 2];

  for (var i = 0; i < prm.plates; i++) {
    var len = 100 + Math.floor(rng() * 130);
    var ang = angles[Math.floor(rng() * angles.length)] + (rng() - 0.5) * 0.3;
    var hx = Math.abs(Math.cos(ang)) * len / 2 + PLATE_W / 2;
    var hy = Math.abs(Math.sin(ang)) * len / 2 + PLATE_W / 2;
    var rx = (BOARD.x1 - BOARD.x0) / 2 - hx - 6;
    var ry = (BOARD.y1 - BOARD.y0) / 2 - hy - 6;
    var cx = midX + (rng() * 2 - 1) * Math.max(rx, 0) * Math.min(1, prm.spread * 1.5);
    var cy = midY + (rng() * 2 - 1) * Math.max(ry, 0) * prm.spread;
    plates.push({
      id: i, layer: i, cx: cx, cy: cy, len: len, ang: ang,
      color: PLATE_COLORS[Math.floor(rng() * PLATE_COLORS.length)],
      count: len < 150 ? 2 : 3,
      holes: []
    });
  }

  var total = 0;
  plates.forEach(function (p) { total += p.count; });
  var k = 0;
  while (total % 3 !== 0) {
    var p = plates[k % plates.length];
    if (p.count === 2 && p.len >= 120) { p.count = 3; total++; }
    k++;
    if (k > plates.length * 2) { plates[0].count++; total++; }
  }

  plates.forEach(function (p) {
    var c = Math.cos(p.ang), s = Math.sin(p.ang);
    var span = p.len - 34;
    for (var j = 0; j < p.count; j++) {
      var t = p.count === 1 ? 0 : -span / 2 + span * j / (p.count - 1);
      var sc = { id: screws.length, plate: p.id, x: p.cx + c * t, y: p.cy + s * t, color: 0, rot: rng() * Math.PI };
      p.holes.push({ x: sc.x, y: sc.y });
      screws.push(sc);
    }
  });

  // 每颗螺丝被哪些更上层的板子压着，几何关系不变，预先算好
  var coverBy = screws.map(function (sc) {
    var lay = plates[sc.plate].layer, list = [];
    plates.forEach(function (pl) {
      if (pl.layer > lay && rectDist(sc.x, sc.y, pl) < SCREW_R * 0.8) list.push(pl.id);
    });
    return list;
  });

  // 按一个合法的拆解顺序分颜色，再打乱一部分，逼玩家用暂存区周转
  var left = plates.map(function (p) { return p.count; });
  var removed = [];
  var order = [];
  while (order.length < screws.length) {
    var free = [];
    for (var f = 0; f < screws.length; f++) {
      if (!removed[f] && coverBy[f].every(function (pid) { return left[pid] === 0; })) free.push(f);
    }
    var pick = free[Math.floor(rng() * free.length)];
    removed[pick] = true;
    left[screws[pick].plate]--;
    order.push(pick);
  }

  var queue = [];
  var prev = -1;
  for (var tI = 0; tI < order.length / 3; tI++) {
    var col;
    do { col = Math.floor(rng() * prm.colors); } while (col === prev && prm.colors > 1);
    queue.push(col);
    prev = col;
  }
  var seq = [];
  queue.forEach(function (col) { seq.push(col, col, col); });
  for (var a = 0; a < seq.length; a++) {
    var b = a + Math.floor(rng() * (prm.shuffle + 1));
    if (b < seq.length) { var tmp = seq[a]; seq[a] = seq[b]; seq[b] = tmp; }
  }
  order.forEach(function (sid, idx) { screws[sid].color = seq[idx]; });

  return { plates: plates, screws: screws, queue: queue, coverBy: coverBy };
}

// 按游戏规则快速模拟一局（无动画）。smart 为 false 是瞎点，为 true 是会想的玩家
function simulate(g, smart, rng) {
  var n = g.screws.length;
  var left = g.plates.map(function (p) { return p.count; });
  var removed = [];
  var queue = g.queue.slice();
  var boxes = [null, null];
  var slots = [];
  var done = 0;

  function nextBox(i) { boxes[i] = queue.length ? { c: queue.shift(), n: 0 } : null; }
  function boxFor(c) {
    for (var i = 0; i < 2; i++) if (boxes[i] && boxes[i].c === c && boxes[i].n < 3) return boxes[i];
    return null;
  }
  function settle() {
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < 2; i++) {
        if (boxes[i] && boxes[i].n === 3) { done += 3; nextBox(i); changed = true; }
        var b = boxes[i];
        if (!b) continue;
        for (var j = slots.length - 1; j >= 0 && b.n < 3; j--) {
          if (slots[j] === b.c) { slots.splice(j, 1); b.n++; changed = true; }
        }
      }
    }
  }

  nextBox(0);
  nextBox(1);
  for (var guard = 0; guard <= n; guard++) {
    if (done >= n) return true;
    var free = [];
    for (var s = 0; s < n; s++) {
      if (removed[s]) continue;
      var cb = g.coverBy[s], ok = true;
      for (var q = 0; q < cb.length; q++) if (left[cb[q]] > 0) { ok = false; break; }
      if (ok) free.push(s);
    }
    if (!free.length) return false;
    var pick = -1;
    if (!smart) {
      pick = free[Math.floor(rng() * free.length)];
    } else {
      var boxMoves = free.filter(function (id) { return boxFor(g.screws[id].color); });
      if (boxMoves.length) {
        pick = boxMoves[Math.floor(rng() * boxMoves.length)];
      } else {
        if (slots.length >= BASE_SLOTS) return false;
        var best = -1e9;
        free.forEach(function (id) {
          var c = g.screws[id].color, score = rng() * 1.2;
          slots.forEach(function (x) { if (x === c) score += 2; });
          if (left[g.screws[id].plate] === 1) score += 1;
          if (score > best) { best = score; pick = id; }
        });
      }
    }
    var color = g.screws[pick].color;
    var box = boxFor(color);
    if (box) box.n++;
    else if (slots.length < BASE_SLOTS) slots.push(color);
    else return false;
    removed[pick] = true;
    left[g.screws[pick].plate]--;
    settle();
  }
  return done >= n;
}

function winRate(g, smart, runs, seed) {
  var rng = mulberry32(seed), wins = 0;
  for (var i = 0; i < runs; i++) if (simulate(g, smart, rng)) wins++;
  return wins / runs;
}

// 生成若干候选，挑「会想能过、瞎点难过」的那一个；同一关每次结果相同
var levelCache = {};
function pickLevel(n) {
  if (levelCache[n]) return levelCache[n];
  var bar = levelBar(n);
  var best = null, bestScore = -1e9;
  for (var attempt = 0; attempt < 30; attempt++) {
    // 后一半候选把打乱程度减半，避免高关卡一个能解的都没有
    var g = genCandidate(n, n * 7919 + 13 + attempt * 104729, attempt < 15 ? 1 : 0.5);
    var smartRate = winRate(g, true, 60, attempt + 1);
    if (smartRate === 0) continue;
    var randRate = winRate(g, false, 40, attempt + 77);
    var score = -Math.abs(smartRate - bar.smartTarget) * 4
      - Math.max(0, randRate - bar.randMax) * 10
      + (smartRate >= 0.2 ? 1 : 0);
    if (score > bestScore) { best = g; bestScore = score; }
  }
  // 极端情况下 30 个候选都没解，就退回到不打乱颜色的版本，它一定有解
  if (!best) best = genCandidate(n, n * 7919 + 13, 0);
  levelCache[n] = best;
  return best;
}

// 每次开局复制一份，保证重来时布局一致
function genLevel(n) {
  var g = pickLevel(n);
  return {
    queue: g.queue.slice(),
    plates: g.plates.map(function (p) {
      return { id: p.id, layer: p.layer, cx: p.cx, cy: p.cy, len: p.len, ang: p.ang, color: p.color,
        count: p.count, holes: p.holes.slice(), left: p.count, falling: false, gone: false, vy: 0, spin: 0, alpha: 1 };
    }),
    screws: g.screws.map(function (s) {
      return { id: s.id, plate: s.plate, x: s.x, y: s.y, color: s.color, where: 'board', dx: s.x, dy: s.y,
        rot: s.rot, scale: 1, shake: 0, arrived: false, box: null, hole: -1, slot: -1 };
    })
  };
}

// ============ 游戏状态 ============
var S = null;
var tweens = [];

function newBox(color, idx) {
  return { color: color, idx: idx, count: 0, arrivedN: 0, filled: [], yoff: -50, alpha: 0, leaving: false };
}

function startLevel(n) {
  var g = genLevel(n);
  tweens = [];
  S = {
    level: n,
    plates: g.plates,
    screws: g.screws,
    queue: g.queue.slice(),
    boxes: [null, null],
    slots: [],
    busy: 0,
    status: 'play',
    revived: false,
    reviveReady: false,
    total: g.screws.length,
    done: 0,
    startAt: Date.now(),
    endAt: 0
  };
  for (var i = 0; i < BASE_SLOTS; i++) S.slots.push(null);
  for (var b = 0; b < 2; b++) bringBox(b);
  hideOverlay();
  updateBar();
}

function tween(obj, to, dur, done, ease) {
  var from = {};
  for (var key in to) from[key] = obj[key];
  tweens.push({ o: obj, from: from, to: to, t: 0, dur: dur, done: done, ease: ease || easeOut });
}

function wait(ms, done) { tween({ v: 0 }, { v: 1 }, ms, done); }
function easeOut(k) { return 1 - Math.pow(1 - k, 3); }
function easeIn(k) { return k * k; }

function bringBox(i) {
  if (!S.queue.length) { S.boxes[i] = null; return; }
  var box = newBox(S.queue.shift(), i);
  S.boxes[i] = box;
  S.busy++;
  tween(box, { yoff: 0, alpha: 1 }, 220, function () {
    S.busy--;
    pullFromSlots(box);
    afterSettle();
  });
}

function holePos(box, h) {
  return { x: BOX_XS[box.idx] + HOLE_DX[h], y: BOX_Y + 6 + box.yoff };
}

function slotPos(i) {
  var n = S.slots.length;
  return { x: W / 2 + (i - (n - 1) / 2) * SLOT_GAP, y: SLOT_Y };
}

function flyTo(sc, x, y, done) {
  S.busy++;
  sc.arrived = false;
  tween(sc, { dx: x, dy: y, rot: sc.rot + Math.PI * 3, scale: 0.9 }, 300, function () {
    sc.arrived = true;
    S.busy--;
    if (done) done();
    afterSettle();
  });
}

function sendToBox(sc, box) {
  var h = box.count++;
  box.filled.push(sc.id);
  sc.where = 'box';
  sc.box = box;
  sc.hole = h;
  var p = holePos(box, h);
  flyTo(sc, p.x, p.y, function () {
    box.arrivedN++;
    if (box.arrivedN === 3) completeBox(box);
  });
}

function pickTarget(sc) {
  for (var i = 0; i < 2; i++) {
    var b = S.boxes[i];
    if (b && !b.leaving && b.color === sc.color && b.count < 3) return { box: b };
  }
  for (var j = 0; j < S.slots.length; j++) {
    if (S.slots[j] === null) return { slot: j };
  }
  return null;
}

function completeBox(box) {
  box.leaving = true;
  S.busy++;
  sfx.box();
  vibrate('medium');
  wait(120, function () {
    tween(box, { yoff: -60, alpha: 0 }, 240, function () {
      box.filled.forEach(function (id) { S.screws[id].where = 'gone'; });
      S.done += 3;
      S.busy--;
      updateBar();
      bringBox(box.idx);
      afterSettle();
    }, easeIn);
  });
}

function pullFromSlots(box) {
  for (var i = 0; i < S.slots.length && box.count < 3; i++) {
    var id = S.slots[i];
    if (id !== null && S.screws[id].arrived && S.screws[id].color === box.color) {
      S.slots[i] = null;
      sendToBox(S.screws[id], box);
    }
  }
}

function isCovered(sc) {
  var lay = S.plates[sc.plate].layer;
  for (var i = 0; i < S.plates.length; i++) {
    var p = S.plates[i];
    if (p.layer > lay && p.left > 0 && rectDist(sc.x, sc.y, p) < SCREW_R * 0.8) return true;
  }
  return false;
}

function tapScrew(sc) {
  if (S.busy > 0 && !pickTarget(sc)) return;
  if (isCovered(sc)) {
    sc.shake = 0.3;
    sfx.blocked();
    return;
  }
  var tgt = pickTarget(sc);
  if (!tgt) {
    // 暂存区已满还拧下一颗放不下的螺丝，直接判输
    sc.shake = 0.3;
    fail();
    return;
  }
  sfx.pick();
  vibrate('light');

  var plate = S.plates[sc.plate];
  plate.left--;
  if (plate.left === 0) dropPlate(plate);

  if (tgt.box) {
    sendToBox(sc, tgt.box);
  } else {
    S.slots[tgt.slot] = sc.id;
    sc.where = 'slot';
    sc.slot = tgt.slot;
    var p = slotPos(tgt.slot);
    flyTo(sc, p.x, p.y, function () {
      S.boxes.forEach(function (b) { if (b && !b.leaving) pullFromSlots(b); });
    });
  }
}

function dropPlate(p) {
  p.falling = true;
  p.ox = p.cx; p.oy = p.cy; p.ang0 = p.ang;
  p.vy = -2;
  p.spin = (Math.random() - 0.5) * 0.08;
  setTimeout(sfx.drop, 80);
}

function afterSettle() {
  if (!S || S.status !== 'play' || S.busy > 0) return;
  if (S.done >= S.total) { win(); return; }
  var full = true;
  for (var i = 0; i < S.slots.length; i++) if (S.slots[i] === null) { full = false; break; }
  if (full && !hasBoxMove()) fail();
}

function hasBoxMove() {
  return S.screws.some(function (sc) {
    if (sc.where !== 'board' || isCovered(sc)) return false;
    return S.boxes.some(function (b) { return b && !b.leaving && b.color === sc.color && b.count < 3; });
  });
}

function win() {
  S.status = 'win';
  S.endAt = Date.now();
  sfx.win();
  vibrate('heavy');
  if (S.level + 1 > saveState.level) saveState.level = S.level + 1;
  if (S.level > saveState.best) saveState.best = S.level;
  saveData(saveState);
  setTimeout(showWin, 500);
}

function fail() {
  S.status = 'fail';
  S.endAt = Date.now();
  sfx.fail();
  vibrate('heavy');
  setTimeout(showFail, 400);
}

function revive() {
  for (var i = 0; i < REVIVE_SLOTS; i++) S.slots.push(null);
  S.slots.forEach(function (id, idx) {
    if (id !== null) {
      var p = slotPos(idx);
      tween(S.screws[id], { dx: p.x, dy: p.y }, 200);
    }
  });
  S.revived = true;
  S.reviveReady = false;
  S.status = 'play';
  hideOverlay();
}

// ============ 通用绘制 ============
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

function paintScrew(c, x, y, r, colIdx, rot) {
  var col = SCREW_COLORS[colIdx];
  c.save();
  c.translate(x, y);
  c.beginPath();
  c.arc(0, r * 0.14, r, 0, Math.PI * 2);
  c.fillStyle = 'rgba(0,0,0,0.45)';
  c.fill();
  c.beginPath();
  c.arc(0, 0, r, 0, Math.PI * 2);
  c.fillStyle = col.fill;
  c.fill();
  c.lineWidth = Math.max(1.5, r * 0.13);
  c.strokeStyle = col.dark;
  c.stroke();
  c.beginPath();
  c.arc(-r * 0.3, -r * 0.35, r * 0.34, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.32)';
  c.fill();
  c.rotate(rot);
  c.strokeStyle = col.dark;
  c.lineWidth = Math.max(2.5, r * 0.2);
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-r * 0.5, 0); c.lineTo(r * 0.5, 0);
  c.moveTo(0, -r * 0.5); c.lineTo(0, r * 0.5);
  c.stroke();
  c.restore();
}

function paintPlate(c, cx, cy, len, wid, ang, color, alpha) {
  c.save();
  c.globalAlpha = alpha;
  c.translate(cx, cy);
  c.rotate(ang);
  roundRectPath(c, -len / 2, -wid / 2, len, wid, wid / 2);
  c.fillStyle = color;
  c.globalAlpha = alpha * 0.86;
  c.fill();
  c.globalAlpha = alpha;
  c.lineWidth = 1.5;
  c.strokeStyle = 'rgba(255,255,255,0.35)';
  c.stroke();
  c.restore();
}

function paintHole(c, x, y, r) {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = 'rgba(13,16,22,0.45)';
  c.fill();
}

function paintGrid(c, w, h, step) {
  c.strokeStyle = 'rgba(255,255,255,0.035)';
  c.lineWidth = 1;
  c.beginPath();
  for (var x = step; x < w; x += step) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); }
  for (var y = step; y < h; y += step) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); }
  c.stroke();
}

function paintStreaks(c, x, y, r, ang) {
  c.save();
  c.strokeStyle = '#fff';
  c.lineCap = 'round';
  for (var i = -1; i <= 1; i++) {
    var a = ang + i * 0.45;
    var r0 = r * 1.35, r1 = r * (i === 0 ? 1.9 : 1.7);
    c.lineWidth = i === 0 ? r * 0.14 : r * 0.1;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
    c.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
    c.stroke();
  }
  c.restore();
}

function setupCanvas(canvas, w, h) {
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  var c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return c;
}

// ============ 首页大图 ============
function drawHero() {
  var box = $('hero');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  var c = setupCanvas($('hero-cv'), w, h);
  var g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#131824');
  g.addColorStop(1, '#0d1016');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  paintGrid(c, w, h, 44);

  var u = Math.min(w, h * 0.75) / 390;

  // 右上斜板 + 两颗螺丝
  var a1 = -0.62;
  var p1 = { x: w * 0.7, y: h * 0.17, len: 330 * u, wid: 70 * u };
  paintPlate(c, p1.x, p1.y, p1.len, p1.wid, a1, '#e9dcc4', 1);
  [-0.32, 0.32].forEach(function (t, i) {
    var x = p1.x + Math.cos(a1) * p1.len * t, y = p1.y + Math.sin(a1) * p1.len * t;
    paintHole(c, x, y, 26 * u);
    paintScrew(c, x, y, 28 * u, i === 0 ? 2 : 1, 0.4 + i);
  });

  // 左上竖板
  var a2 = 1.15;
  paintPlate(c, w * 0.08, h * 0.08, 250 * u, 64 * u, a2, '#d5e0e6', 0.95);
  paintScrew(c, w * 0.08 + Math.cos(a2) * 70 * u, h * 0.08 + Math.sin(a2) * 70 * u, 25 * u, 3, 0.2);

  // 右侧大红螺丝（出血）
  paintScrew(c, w * 0.97, h * 0.5, 92 * u, 0, 0.35);

  // 正在被拧起的小螺丝
  var sx = w * 0.62, sy = h * 0.6;
  paintScrew(c, sx, sy, 24 * u, 7, 0.9);
  paintStreaks(c, sx, sy, 24 * u, -2.2);

  // 右下斜板
  var a3 = 0.5;
  paintPlate(c, w * 0.88, h * 0.9, 280 * u, 66 * u, a3, '#eadbd3', 1);
  paintScrew(c, w * 0.88 - Math.cos(a3) * 80 * u, h * 0.9 - Math.sin(a3) * 80 * u, 27 * u, 4, 1.1);

  // 底部压暗，让标题更清楚
  var g2 = c.createLinearGradient(0, h * 0.45, 0, h);
  g2.addColorStop(0, 'rgba(13,16,22,0)');
  g2.addColorStop(1, 'rgba(13,16,22,0.85)');
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
  var c = setupCanvas(cnv, w, h);
  c.fillStyle = '#131824';
  c.fillRect(0, 0, w, h);
  paintGrid(c, w, h, 28);
  var ang = -0.18;
  paintPlate(c, w * 0.5, h * 0.55, w * 0.78, 52, ang, '#e9dcc4', 1);
  [-0.3, 0, 0.3].forEach(function (t, i) {
    var x = w * 0.5 + Math.cos(ang) * w * 0.78 * t, y = h * 0.55 + Math.sin(ang) * w * 0.78 * t;
    paintHole(c, x, y, 19);
    paintScrew(c, x, y, 21, [1, 0, 2][i], 0.3 + i);
  });
  paintScrew(c, w * 0.95, h * 0.12, 40, 3, 0.6);
}

// ============ 游戏画布 ============
var cv = document.getElementById('cv');
var ctx = cv.getContext('2d');
var view = { scale: 1, ox: 0, oy: 0, dpr: 1 };

function resizeGame() {
  var stage = $('stage');
  var cw = stage.clientWidth, ch = stage.clientHeight;
  if (!cw || !ch) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.style.width = cw + 'px';
  cv.style.height = ch + 'px';
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  var sc = Math.min(cw / W, ch / H);
  view = { scale: sc, ox: (cw - W * sc) / 2, oy: (ch - H * sc) / 2, dpr: dpr };
}

function drawPlate(p) {
  paintPlate(ctx, p.cx, p.cy, p.len, PLATE_W, p.ang, p.color, p.alpha);
  ctx.save();
  ctx.globalAlpha = p.alpha;
  p.holes.forEach(function (h) {
    var hx = h.x, hy = h.y;
    if (p.falling) {
      var dx = h.x - p.ox, dy = h.y - p.oy;
      var c = Math.cos(p.ang - p.ang0), s = Math.sin(p.ang - p.ang0);
      hx = p.cx + dx * c - dy * s;
      hy = p.cy + dx * s + dy * c;
    }
    paintHole(ctx, hx, hy, SCREW_R - 3);
  });
  ctx.restore();
}

function drawScrew(sc, x, y) {
  paintScrew(ctx, x, y, SCREW_R * sc.scale, sc.color, sc.rot);
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.setTransform(view.dpr * view.scale, 0, 0, view.dpr * view.scale, view.dpr * view.ox, view.dpr * view.oy);
  if (!S) return;

  // 盒子
  for (var i = 0; i < 2; i++) {
    var bx = BOX_XS[i];
    ctx.save();
    ctx.setLineDash([5, 5]);
    roundRectPath(ctx, bx - 72, BOX_Y - 30, 144, 64, 12);
    ctx.strokeStyle = '#2a303c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
    var box = S.boxes[i];
    if (!box) continue;
    var col = SCREW_COLORS[box.color];
    ctx.save();
    ctx.globalAlpha = box.alpha;
    roundRectPath(ctx, bx - 72, BOX_Y - 30 + box.yoff, 144, 64, 12);
    ctx.fillStyle = col.fill;
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    roundRectPath(ctx, bx - 72, BOX_Y - 30 + box.yoff, 144, 16, 12);
    ctx.fill();
    for (var h = 0; h < 3; h++) {
      ctx.beginPath();
      ctx.arc(bx + HOLE_DX[h], BOX_Y + 6 + box.yoff, SCREW_R - 1, 0, Math.PI * 2);
      ctx.fillStyle = col.dark;
      ctx.fill();
    }
    ctx.restore();
  }

  // 暂存区
  var used = 0;
  S.slots.forEach(function (id) { if (id !== null) used++; });
  var danger = used >= S.slots.length - 1;
  ctx.fillStyle = danger ? '#ff3b4f' : '#8b93a1';
  ctx.font = '600 13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('暂存区 ' + used + ' / ' + S.slots.length, W / 2, SLOT_Y - 30);
  for (var s = 0; s < S.slots.length; s++) {
    var sp = slotPos(s);
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, SCREW_R + 3, 0, Math.PI * 2);
    ctx.fillStyle = s >= BASE_SLOTS ? '#3a1d25' : '#1c212c';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = s >= BASE_SLOTS ? '#6b2a37' : '#2a303c';
    ctx.stroke();
  }

  // 底板
  roundRectPath(ctx, BOARD.x0, BOARD.y0, BOARD.x1 - BOARD.x0, BOARD.y1 - BOARD.y0, 16);
  ctx.fillStyle = '#151922';
  ctx.fill();
  ctx.save();
  roundRectPath(ctx, BOARD.x0, BOARD.y0, BOARD.x1 - BOARD.x0, BOARD.y1 - BOARD.y0, 16);
  ctx.clip();
  ctx.translate(BOARD.x0, BOARD.y0);
  paintGrid(ctx, BOARD.x1 - BOARD.x0, BOARD.y1 - BOARD.y0, 30);
  ctx.restore();

  // 板子与螺丝（从下往上画）
  S.plates.forEach(function (p) {
    if (p.gone) return;
    drawPlate(p);
    S.screws.forEach(function (sc) {
      if (sc.plate === p.id && sc.where === 'board') {
        var ox = sc.shake > 0 ? Math.sin(sc.shake * 60) * 4 : 0;
        drawScrew(sc, sc.dx + ox, sc.dy);
      }
    });
  });

  S.screws.forEach(function (sc) {
    if (sc.where === 'slot') {
      drawScrew(sc, sc.dx, sc.dy);
    } else if (sc.where === 'box') {
      ctx.save();
      ctx.globalAlpha = sc.arrived ? sc.box.alpha : 1;
      var y = sc.arrived ? holePos(sc.box, sc.hole).y : sc.dy;
      drawScrew(sc, sc.dx, y);
      ctx.restore();
    }
  });
}

// ============ 主循环 ============
var last = 0, running = true, inGame = false;

function step(dt) {
  for (var i = tweens.length - 1; i >= 0; i--) {
    var tw = tweens[i];
    tw.t += dt;
    var k = Math.min(tw.t / tw.dur, 1);
    var e = tw.ease(k);
    for (var key in tw.to) tw.o[key] = tw.from[key] + (tw.to[key] - tw.from[key]) * e;
    if (k >= 1) {
      tweens.splice(i, 1);
      if (tw.done) tw.done();
    }
  }
  if (!S) return;
  S.plates.forEach(function (p) {
    if (!p.falling || p.gone) return;
    p.vy += 0.6 * dt / 16;
    p.cy += p.vy * dt / 16;
    p.ang += p.spin * dt / 16;
    p.alpha = Math.max(0, p.alpha - 0.0015 * dt);
    if (p.cy - p.len > H || p.alpha <= 0) p.gone = true;
  });
  S.screws.forEach(function (sc) { if (sc.shake > 0) sc.shake = Math.max(0, sc.shake - dt / 1000); });
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

// ============ 输入 ============
function onTap(clientX, clientY) {
  initAudio();
  if (!S || S.status !== 'play') return;
  var r = cv.getBoundingClientRect();
  var px = (clientX - r.left - view.ox) / view.scale;
  var py = (clientY - r.top - view.oy) / view.scale;
  var hit = null, hitLayer = -1;
  S.screws.forEach(function (sc) {
    if (sc.where !== 'board') return;
    var dx = px - sc.x, dy = py - sc.y;
    if (dx * dx + dy * dy <= (SCREW_R + 6) * (SCREW_R + 6)) {
      var lay = S.plates[sc.plate].layer;
      if (lay > hitLayer) { hit = sc; hitLayer = lay; }
    }
  });
  if (hit) tapScrew(hit);
}

if (window.PointerEvent) {
  cv.addEventListener('pointerdown', function (e) { e.preventDefault(); onTap(e.clientX, e.clientY); });
} else {
  cv.addEventListener('touchstart', function (e) {
    e.preventDefault();
    var t = e.changedTouches[0];
    onTap(t.clientX, t.clientY);
  }, { passive: false });
  cv.addEventListener('mousedown', function (e) { onTap(e.clientX, e.clientY); });
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
  resizeGame();
  startLevel(level);
  inGame = true;
}

function renderHome() {
  $('home-best').innerHTML = saveState.best > 0
    ? '最高通关 <b>第 ' + saveState.best + ' 关</b>'
    : '第 1 关只有 7 块板子，先热热手';
  $('btn-start').innerHTML = (saveState.level > 1 ? '继续第 ' + saveState.level + ' 关' : '开始挑战') + '<svg class="arrow" viewBox="0 0 24 24"><path d="M3 12h16M13 6l6 6-6 6"/></svg>';
  var snd = $('nav-sound');
  snd.classList.toggle('muted', !!saveState.muted);
  $('sound-label').textContent = saveState.muted ? '声音 关' : '声音 开';
  renderFollow();
}

function updateBar() {
  $('level').textContent = '第 ' + S.level + ' 关';
  $('progress').textContent = '拧下 ' + S.done + ' / ' + S.total;
}

$('btn-start').addEventListener('click', function () { showGame(saveState.level); });
$('btn-back').addEventListener('click', showHome);
$('btn-restart').addEventListener('click', function () { initAudio(); startLevel(S.level); });

$('nav-sound').addEventListener('click', function () {
  saveState.muted = !saveState.muted;
  saveData(saveState);
  renderHome();
  if (!saveState.muted) { initAudio(); sfx.pick(); }
});

$('nav-help').addEventListener('click', function () {
  openDialog({
    kicker: '怎么玩',
    title: '玩法说明',
    html: '<ol><li>点没被挡住的螺丝，它会自己飞进同色盒子，一盒装 3 颗。</li>' +
          '<li>没有同色盒子时，螺丝先放进暂存区，暂存区只有 5 格。</li>' +
          '<li>板子上的螺丝拧完，板子会掉下去，露出下面那层。</li>' +
          '<li>暂存区满了以后，再拧一颗放不下的螺丝就算输，所以要先拧能直接进盒子的。</li>' +
          '<li>输了可以发一篇笔记复活一次，暂存区多 3 格。</li></ol>',
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
  // 在小红书里但客户端太旧时没有关注能力，隐藏入口；浏览器预览保留入口方便看效果
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
    kicker: '拧拧螺丝的作者',
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
function secs() { return Math.round(((S.endAt || Date.now()) - S.startAt) / 100) / 10; }

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
  $('r-fill').style.width = Math.round(o.pct * 100) + '%';
  $('r-hint').textContent = o.hint;

  var main = $('r-main');
  main.innerHTML = o.main + (o.mainArrow ? '<svg class="arrow" viewBox="0 0 24 24"><path d="M3 12h16M13 6l6 6-6 6"/></svg>' : '');
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
  var leftN = S.total - S.done;
  var canRevive = !S.revived;
  var o = {
    kicker: '第 ' + S.level + ' 关 · 本局成绩',
    num: String(S.done),
    unit: '/ ' + S.total + ' 颗',
    tag: '差一点',
    title: '暂存区满了',
    sub: canRevive ? '再给 3 个空位，说不定就过了。' : '这关的复活机会用过了，重来一次吧。',
    stats: [['用时', secs() + ' 秒'], ['已装满盒子', (S.done / 3) + ' 个'], ['最高通关', saveState.best ? '第 ' + saveState.best + ' 关' : '暂无']],
    pct: S.done / S.total,
    hint: '还差 ' + leftN + ' 颗通关'
  };
  if (canRevive) {
    o.main = '发笔记复活'; o.mainArrow = true; o.onMain = onReviveClick;
    o.note = '发布成功后手动继续 · 每关一次 · 暂存区 +3 格';
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
    num: String(S.total),
    unit: '颗全拧完',
    tag: S.revived ? '通关' : '一命通关',
    title: '全部拧完',
    sub: S.revived ? '靠复活挺过来的，下一关争取一口气过。' : '一次没复活，手很稳。',
    stats: [['用时', secs() + ' 秒'], ['装满盒子', (S.total / 3) + ' 个'], ['最高通关', '第 ' + saveState.best + ' 关']],
    pct: 1,
    hint: '下一关会多两块板子',
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
    main.innerHTML = '继续游戏<svg class="arrow" viewBox="0 0 24 24"><path d="M3 12h16M13 6l6 6-6 6"/></svg>';
    $('r-note').textContent = '当前不在小红书里，预览环境直接给复活';
    return;
  }
  main.disabled = true;
  main.textContent = '正在打开发布页…';
  var ok = await shareNote(true);
  main.disabled = false;
  if (ok) {
    S.reviveReady = true;
    main.innerHTML = '继续游戏<svg class="arrow" viewBox="0 0 24 24"><path d="M3 12h16M13 6l6 6-6 6"/></svg>';
    $('r-note').textContent = '笔记已发布，点继续接着拧';
  } else {
    main.innerHTML = '发笔记复活<svg class="arrow" viewBox="0 0 24 24"><path d="M3 12h16M13 6l6 6-6 6"/></svg>';
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

  var gh = 700, gw = gh * W / H;
  var gx = (900 - gw) / 2, gy = 1200 - gh - 36;
  x.drawImage(cv,
    view.ox * view.dpr, view.oy * view.dpr, W * view.scale * view.dpr, H * view.scale * view.dpr,
    gx, gy, gw, gh);

  var font = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  x.textBaseline = 'top';
  x.fillStyle = '#ffffff';
  x.font = '900 46px ' + font;
  x.fillText('拧拧', 56, 56);
  x.fillStyle = '#ff3b4f';
  x.fillText('螺丝', 56 + x.measureText('拧拧').width + 6, 56);
  x.fillStyle = '#ffffff';
  x.font = 'italic 900 130px ' + font;
  x.fillText('第 ' + S.level + ' 关', 50, 120);
  x.font = '800 44px ' + font;
  x.fillStyle = '#66dcff';
  x.fillText(isFail ? '卡住了，还差 ' + (S.total - S.done) + ' 颗' : '全部拧完，用时 ' + secs() + ' 秒', 56, 282);
  x.fillStyle = '#8b93a1';
  x.font = '600 30px ' + font;
  x.fillText(isFail ? '拧下 ' + S.done + ' / ' + S.total + ' 颗 · 你能过这关吗' : S.total + ' 颗螺丝 · 你来试试', 56, 352);
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
    var title = isFail ? '拧螺丝第' + S.level + '关，谁能过' : '拧螺丝第' + S.level + '关通关';
    var content = isFail
      ? '在小工具「拧拧螺丝」卡在第' + S.level + '关，还差' + (S.total - S.done) + '颗就过了。你能过吗？ #拧螺丝 #小游戏'
      : '小工具「拧拧螺丝」第' + S.level + '关过了，用时' + secs() + '秒。来比比？ #拧螺丝 #小游戏';
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
    saveState.muted = !!d.muted;
  }
  canVibrate = await canUse('vibrateShort', 9500);
  showHome();
  requestAnimationFrame(loop);
  await initFollow();
  setTimeout(maybeAskFollow, 350);
})();

})();
