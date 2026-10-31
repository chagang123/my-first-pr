(function () {
'use strict';

// ============ 常量 ============
var COLS = 13, ROWS = 21, T = 30;
var W = COLS * T, H = ROWS * T;
var FLOOR = 0, WALL = 1, BLOCK = 2, SPOT = 3;
var PLAYER_R = T * 0.32;
var PLAYER_SPEED = 6 * T;            // 键盘操作时的速度，像素/秒
var DRAG_MAX = 14 * T;               // 跟手拖动的最高速度
var DRAG_CARRY = T * 0.25;           // 划太快时最多补走这么多，超出的直接丢掉，避免手停了人还在滑
var WARN_TILES = 7;
var HIDE_DELAY = 0.25;
var PROTECT_S = 3;

function levelParams(n) {
  return {
    seekers: n <= 1 ? 1 : (n <= 5 ? 2 : (n <= 10 ? 3 : 4)),
    walk: Math.min(1.9 + n * 0.04, 2.4) * T,
    run: Math.min(3.0 + n * 0.03, 3.3) * T,
    range: Math.min(4.6 + n * 0.08, 5.6) * T,
    half: 0.6,
    check: Math.min(0.3 + n * 0.02, 0.45),
    time: Math.min(30 + Math.round(n * 1.5), 45)
  };
}

// ============ 小红书端能力 ============
var xhs = window.xhs || null;
var miniTool = (xhs && xhs.miniTool) ? xhs.miniTool : null;
var STORE_KEY = 'hide_seek_save';

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
    level: Math.max(local.level | 0, remote.level | 0),
    best: Math.max(local.best | 0, remote.best | 0),
    endlessBest: Math.max(Number(local.endlessBest) || 0, Number(remote.endlessBest) || 0),
    muted: local.muted !== undefined ? !!local.muted : !!remote.muted,
    mode: local.mode || remote.mode
  };
}

async function writeCloud(obj) {
  var content = { level: obj.level, best: obj.best, endlessBest: obj.endlessBest, muted: !!obj.muted, mode: obj.mode };
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
var saveState = { level: 1, best: 0, endlessBest: 0, muted: false, mode: 'level' };

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
  hide: function () { beep(420, 0.08, 'sine', 0.1, 300); },
  alert: function () { beep(880, 0.09, 'square', 0.07); setTimeout(function () { beep(1180, 0.12, 'square', 0.07); }, 90); },
  warn: function () { beep(300, 0.1, 'triangle', 0.1); },
  tick: function () { beep(1000, 0.04, 'sine', 0.06); },
  win: function () { [523, 659, 784, 1046].forEach(function (f, i) { setTimeout(function () { beep(f, 0.18, 'triangle', 0.14); }, i * 110); }); },
  fail: function () { beep(330, 0.35, 'sine', 0.14, 140); },
  // 被抓到时的惊吓音：一团不和谐的音加一下噪声
  caught: function () {
    if (!audio || saveState.muted) return;
    [392, 415, 440, 466].forEach(function (f) { beep(f, 0.55, 'sawtooth', 0.05, f * 0.7); });
    noiseHit(audio.destination, audio.currentTime, 0.25, 0.3, 2000, 0);
  }
};

// ============ 氛围音：心跳、低频嗡鸣、脚步声、被追时的低音循环 ============
// 包里不能放音频文件，全部用 Web Audio 现场合成
var noiseBuf = null;
function getNoise() {
  if (!noiseBuf) {
    var len = Math.floor(audio.sampleRate * 0.3);
    noiseBuf = audio.createBuffer(1, len, audio.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function panTo(dest, pan) {
  if (!pan || typeof audio.createStereoPanner !== 'function') return dest;
  var p = audio.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(dest);
  return p;
}

function noiseHit(dest, t, dur, vol, band, pan) {
  var src = audio.createBufferSource();
  src.buffer = getNoise();
  var f = audio.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = band;
  f.Q.value = 1.2;
  var g = audio.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f); f.connect(g); g.connect(panTo(dest, pan));
  src.start(t);
  src.stop(t + dur + 0.02);
}

function toneHit(dest, t, freq, freqEnd, dur, vol, type) {
  var o = audio.createOscillator();
  var g = audio.createGain();
  o.type = type || 'sine';
  o.frequency.setValueAtTime(freq, t);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.02);
}

var CHASE_NOTES = [110, 130.8, 164.8, 130.8, 110, 130.8, 174.6, 164.8];
var amb = { on: false, n: null, tension: 0, chase: 0, nextBeat: 0, nextNote: 0, noteIdx: 0 };

function ambStart() {
  if (!audio || amb.on) return;
  var t = audio.currentTime;
  var master = audio.createGain();
  master.gain.value = saveState.muted ? 0 : 1;
  master.connect(audio.destination);
  // 外界的声音走闷音滤波，躲进柜子时把高频压掉
  var muffle = audio.createBiquadFilter();
  muffle.type = 'lowpass';
  muffle.frequency.value = 16000;
  muffle.connect(master);
  var droneGain = audio.createGain();
  droneGain.gain.setValueAtTime(0, t);
  droneGain.gain.linearRampToValueAtTime(0.035, t + 1.5);
  var droneFilter = audio.createBiquadFilter();
  droneFilter.type = 'lowpass';
  droneFilter.frequency.value = 180;
  droneFilter.connect(droneGain);
  droneGain.connect(muffle);
  var oscs = [55, 55.6, 82.4].map(function (f, i) {
    var o = audio.createOscillator();
    o.type = i === 2 ? 'triangle' : 'sawtooth';
    o.frequency.value = f;
    o.connect(droneFilter);
    o.start(t);
    return o;
  });
  amb.n = { master: master, muffle: muffle, droneGain: droneGain, droneFilter: droneFilter, oscs: oscs };
  amb.on = true;
  amb.tension = 0;
  amb.chase = 0;
  amb.nextBeat = t + 0.5;
  amb.nextNote = t;
  amb.noteIdx = 0;
}

function ambStop(fade) {
  if (!amb.on) return;
  var n = amb.n, t = audio.currentTime, f = fade || 0.3;
  n.master.gain.cancelScheduledValues(t);
  n.master.gain.setValueAtTime(n.master.gain.value, t);
  n.master.gain.linearRampToValueAtTime(0, t + f);
  n.oscs.forEach(function (o) { o.stop(t + f + 0.05); });
  setTimeout(function () { try { n.master.disconnect(); } catch (e) { /* 已断开 */ } }, (f + 0.2) * 1000);
  amb.on = false;
  amb.n = null;
}

function ambUpdate(dt) {
  if (!audio) return;
  if (!amb.on) ambStart();
  var n = amb.n, t = audio.currentTime, p = S.player;

  var nearest = 99, chasing = false;
  S.seekers.forEach(function (s) {
    var d = Math.sqrt((s.x - p.x) * (s.x - p.x) + (s.y - p.y) * (s.y - p.y)) / T;
    if (d < nearest) nearest = d;
    if (s.state === 'chase') chasing = true;
  });
  var target = Math.max(chasing ? 1 : 0, spotDanger() ? 0.9 : 0, Math.max(0, Math.min(1, (7 - nearest) / 6)) * 0.75);
  amb.tension += (target - amb.tension) * Math.min(1, dt * 2);
  amb.chase += ((chasing ? 1 : 0) - amb.chase) * Math.min(1, dt * 3);
  var k = amb.tension;

  n.master.gain.setTargetAtTime(saveState.muted ? 0 : 1, t, 0.05);
  n.muffle.frequency.setTargetAtTime(p.hidden ? 650 : 16000, t, 0.12);
  n.droneGain.gain.setTargetAtTime(0.03 + 0.05 * k, t, 0.3);
  n.droneFilter.frequency.setTargetAtTime(160 + 420 * k, t, 0.3);

  // 心跳：越危险越快越响，不走闷音滤波
  var bpm = 58 + 82 * k, vol = 0.14 + 0.3 * k;
  if (amb.nextBeat < t) amb.nextBeat = t + 0.05;
  while (amb.nextBeat < t + 0.15) {
    toneHit(n.master, amb.nextBeat, 75, 42, 0.16, vol, 'sine');
    toneHit(n.master, amb.nextBeat + 0.17, 68, 40, 0.14, vol * 0.65, 'sine');
    amb.nextBeat += 60 / bpm;
  }

  // 被追时的低音循环
  if (amb.chase > 0.05) {
    if (amb.nextNote < t) amb.nextNote = t + 0.02;
    while (amb.nextNote < t + 0.15) {
      toneHit(n.muffle, amb.nextNote, CHASE_NOTES[amb.noteIdx % CHASE_NOTES.length], 0, 0.16, 0.05 * amb.chase, 'square');
      amb.noteIdx++;
      amb.nextNote += 0.19;
    }
  }

  // 脚步声：附近有人在走就能听到，左右声道跟着人的位置
  S.seekers.forEach(function (s) {
    var d = Math.sqrt((s.x - p.x) * (s.x - p.x) + (s.y - p.y) * (s.y - p.y)) / T;
    if (!s.path || s.state === 'look' || d > 6) { s.stepT = 0; return; }
    s.stepT = (s.stepT || 0) - dt;
    if (s.stepT <= 0) {
      s.stepT = s.state === 'chase' ? 0.24 : 0.4;
      noiseHit(n.muffle, t + 0.01, 0.06, 0.16 * (1 - d / 6) + 0.02, 900 + Math.random() * 400, (s.x - p.x) / (W * 0.5));
    }
  });
}

// ============ 随机数（关卡可复现） ============
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    var t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ============ 地图 ============
function idx(x, y) { return x + y * COLS; }
function inside(x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS; }
function walkable(map, x, y) { return inside(x, y) && (map.tile[idx(x, y)] === FLOOR || map.tile[idx(x, y)] === SPOT); }

function bfs(map, sx, sy) {
  var dist = [];
  for (var i = 0; i < COLS * ROWS; i++) dist.push(-1);
  if (!walkable(map, sx, sy)) return dist;
  var q = [idx(sx, sy)];
  dist[q[0]] = 0;
  for (var h = 0; h < q.length; h++) {
    var c = q[h], cx = c % COLS, cy = (c - cx) / COLS;
    var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var k = 0; k < 4; k++) {
      var nx = cx + nb[k][0], ny = cy + nb[k][1];
      if (walkable(map, nx, ny) && dist[idx(nx, ny)] < 0) {
        dist[idx(nx, ny)] = dist[c] + 1;
        q.push(idx(nx, ny));
      }
    }
  }
  return dist;
}

function findPath(map, sx, sy, tx, ty) {
  var dist = bfs(map, tx, ty);
  if (dist[idx(sx, sy)] < 0) return null;
  var path = [];
  var x = sx, y = sy;
  while (x !== tx || y !== ty) {
    var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]], moved = false;
    for (var k = 0; k < 4; k++) {
      var nx = x + nb[k][0], ny = y + nb[k][1];
      if (inside(nx, ny) && dist[idx(nx, ny)] >= 0 && dist[idx(nx, ny)] === dist[idx(x, y)] - 1) {
        x = nx; y = ny; moved = true;
        path.push({ x: (x + 0.5) * T, y: (y + 0.5) * T, tx: x, ty: y });
        break;
      }
    }
    if (!moved) return null;
  }
  return path;
}

function genMap(n) {
  for (var attempt = 0; attempt < 60; attempt++) {
    var rng = mulberry32(n * 9173 + 7 + attempt * 7919);
    var map = { tile: [], spotKind: {}, blocks: [], spots: [], doors: {} };
    for (var i = 0; i < COLS * ROWS; i++) map.tile.push(FLOOR);
    var x, y;
    for (x = 0; x < COLS; x++) { map.tile[idx(x, 0)] = WALL; map.tile[idx(x, ROWS - 1)] = WALL; }
    for (y = 0; y < ROWS; y++) { map.tile[idx(0, y)] = WALL; map.tile[idx(COLS - 1, y)] = WALL; }

    var hy = [6 + Math.floor(rng() * 3), 13 + Math.floor(rng() * 3)];
    var vx = 5 + Math.floor(rng() * 3);
    var bands = [[1, hy[0] - 1], [hy[0] + 1, hy[1] - 1], [hy[1] + 1, ROWS - 2]];

    hy.forEach(function (row) {
      for (var xx = 1; xx < COLS - 1; xx++) map.tile[idx(xx, row)] = WALL;
    });
    var vWall = bands.map(function () { return rng() < 0.8; });
    bands.forEach(function (b, bi) {
      if (!vWall[bi]) return;
      for (var yy = b[0]; yy <= b[1]; yy++) map.tile[idx(vx, yy)] = WALL;
    });

    function door(xx, yy) { map.tile[idx(xx, yy)] = FLOOR; map.doors[idx(xx, yy)] = true; }
    hy.forEach(function (row) {
      door(1 + Math.floor(rng() * (vx - 2)), row);
      door(vx + 1 + Math.floor(rng() * (COLS - vx - 3)), row);
    });
    bands.forEach(function (b, bi) {
      if (vWall[bi]) door(vx, b[0] + 1 + Math.floor(rng() * Math.max(1, b[1] - b[0] - 1)));
    });

    function nearDoor(xx, yy) {
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) if (map.doors[idx(xx + dx, yy + dy)]) return true;
      return false;
    }

    // 每个房间放一件家具
    var kinds = ['sofa', 'table', 'shelf', 'bed'];
    bands.forEach(function (b, bi) {
      var rooms = vWall[bi] ? [[1, vx - 1], [vx + 1, COLS - 2]] : [[1, COLS - 2]];
      rooms.forEach(function (r) {
        var bw = rng() < 0.5 ? 2 : 1, bh = bw === 2 ? (rng() < 0.4 ? 2 : 1) : 2;
        var w = r[1] - r[0] + 1, h = b[1] - b[0] + 1;
        if (w < bw + 2 || h < bh + 2) return;
        var bx = r[0] + 1 + Math.floor(rng() * (w - bw - 1));
        var by = b[0] + 1 + Math.floor(rng() * (h - bh - 1));
        for (var yy = by; yy < by + bh; yy++) for (var xx = bx; xx < bx + bw; xx++) {
          if (nearDoor(xx, yy)) return;
        }
        for (yy = by; yy < by + bh; yy++) for (xx = bx; xx < bx + bw; xx++) map.tile[idx(xx, yy)] = BLOCK;
        map.blocks.push({ x: bx, y: by, w: bw, h: bh, kind: kinds[Math.floor(rng() * kinds.length)] });
      });
    });

    // 藏身点：贴墙、不挡门、彼此离开一段距离
    var cands = [];
    for (y = 1; y < ROWS - 1; y++) for (x = 1; x < COLS - 1; x++) {
      if (map.tile[idx(x, y)] !== FLOOR || nearDoor(x, y)) continue;
      var touch = 0;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) { if (map.tile[idx(x + d[0], y + d[1])] === WALL) touch++; });
      if (touch > 0) cands.push({ x: x, y: y });
    }
    for (i = cands.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = cands[i]; cands[i] = cands[j]; cands[j] = t; }
    var want = n <= 2 ? 5 : 4;
    cands.forEach(function (c) {
      if (map.spots.length >= want) return;
      for (var k = 0; k < map.spots.length; k++) {
        if (Math.abs(map.spots[k].x - c.x) + Math.abs(map.spots[k].y - c.y) < 5) return;
      }
      map.tile[idx(c.x, c.y)] = SPOT;
      map.spotKind[idx(c.x, c.y)] = rng() < 0.5 ? 'closet' : 'box';
      map.spots.push(c);
    });
    if (map.spots.length < 4) continue;

    // 全图连通检查
    var start = null, total = 0;
    for (i = 0; i < COLS * ROWS; i++) {
      if (map.tile[i] === FLOOR || map.tile[i] === SPOT) { total++; if (!start) start = { x: i % COLS, y: Math.floor(i / COLS) }; }
    }
    var d0 = bfs(map, start.x, start.y), reach = 0;
    d0.forEach(function (v) { if (v >= 0) reach++; });
    if (reach !== total) continue;

    // 出生点：玩家一个，找人的离玩家足够远
    var floors = [];
    for (i = 0; i < COLS * ROWS; i++) if (map.tile[i] === FLOOR) floors.push({ x: i % COLS, y: Math.floor(i / COLS) });
    var p = floors[Math.floor(rng() * floors.length)];
    var dp = bfs(map, p.x, p.y);
    var far = floors.filter(function (f) { return dp[idx(f.x, f.y)] >= 11; });
    if (far.length < 4) continue;
    for (i = far.length - 1; i > 0; i--) { var j2 = Math.floor(rng() * (i + 1)); var t2 = far[i]; far[i] = far[j2]; far[j2] = t2; }
    map.playerStart = p;
    map.seekerStarts = far.slice(0, 4);
    map.floors = floors;
    return map;
  }
  return null;
}

function tileAt(map, px, py) {
  var x = Math.floor(px / T), y = Math.floor(py / T);
  if (!inside(x, y)) return WALL;
  return map.tile[idx(x, y)];
}

function blocksMove(map, px, py) {
  var t = tileAt(map, px, py);
  return t === WALL || t === BLOCK;
}

function lineOfSight(map, x0, y0, x1, y1) {
  var dx = x1 - x0, dy = y1 - y0;
  var len = Math.sqrt(dx * dx + dy * dy);
  var steps = Math.ceil(len / (T * 0.2));
  for (var i = 1; i < steps; i++) {
    if (tileAt(map, x0 + dx * i / steps, y0 + dy * i / steps) === WALL) return false;
  }
  return true;
}

function castRay(map, x0, y0, ang, range) {
  var cx = Math.cos(ang), cy = Math.sin(ang), step = T * 0.2;
  for (var d = step; d < range; d += step) {
    var x = x0 + cx * d, y = y0 + cy * d;
    if (tileAt(map, x, y) === WALL) return { x: x, y: y };
  }
  return { x: x0 + cx * range, y: y0 + cy * range };
}

// ============ 游戏状态 ============
var S = null;
var input = { active: false, lastX: 0, lastY: 0, pendX: 0, pendY: 0, keys: {} };

// 无限模式：固定地图，每隔几秒多一个人
var ENDLESS_MAP = 7;
var ENDLESS_EVERY = 5;

function endlessParams() {
  return { seekers: 1, walk: 2.1 * T, run: 3.15 * T, range: 5 * T, half: 0.6, check: 0.4, time: 0 };
}

function startLevel(n, endless) {
  ambStop(0.1);
  var map = genMap(endless ? ENDLESS_MAP : n);
  var prm = endless ? endlessParams() : levelParams(n);
  S = {
    mode: endless ? 'endless' : 'level',
    level: n, prm: prm, map: map,
    player: { x: (map.playerStart.x + 0.5) * T, y: (map.playerStart.y + 0.5) * T, dir: 0, hidden: false, still: 0, moving: false },
    seekers: [],
    left: prm.time, total: prm.time,
    elapsed: 0, nextSpawn: ENDLESS_EVERY, maxSeekers: prm.seekers, noticeT: 0, rank: null,
    status: 'play', revived: false, reviveReady: false,
    protect: 0, spotted: 0, clock: 0, lastTick: 99, warned: false,
    caughtBy: '', floats: []
  };
  for (var i = 0; i < prm.seekers; i++) {
    var st = map.seekerStarts[i];
    S.seekers.push(newSeeker(st));
  }
  hideOverlay();
  updateBar();
}

function newSeeker(st) {
  return {
    x: (st.x + 0.5) * T, y: (st.y + 0.5) * T, home: st,
    dir: Math.random() * Math.PI * 2, state: 'look', lookT: 1 + Math.random(), path: null,
    target: null, checking: false, repath: 0, last: null, knowSpot: null, bubble: '', bubbleT: 0
  };
}

function tileOf(o) { return { x: Math.floor(o.x / T), y: Math.floor(o.y / T) }; }

// 离玩家足够远的空地；地图太小时退而求其次取最远的那一圈
function farTile(minD) {
  var pt = tileOf(S.player), d = bfs(S.map, pt.x, pt.y), maxD = 0, list = [];
  S.map.floors.forEach(function (f) { if (d[idx(f.x, f.y)] > maxD) maxD = d[idx(f.x, f.y)]; });
  var need = Math.min(minD, maxD);
  S.map.floors.forEach(function (f) { if (d[idx(f.x, f.y)] >= need) list.push(f); });
  return list[Math.floor(Math.random() * list.length)];
}

function spawnSeeker() {
  var s = newSeeker(farTile(9));
  say(s, '+1');
  S.seekers.push(s);
  S.maxSeekers = Math.max(S.maxSeekers, S.seekers.length);
  S.nextSpawn += ENDLESS_EVERY;
  S.noticeT = 1.6;
  sfx.warn();
  vibrate('light');
}

function rawSee(s, p) {
  var dx = p.x - s.x, dy = p.y - s.y;
  var d = Math.sqrt(dx * dx + dy * dy);
  if (d < T * 0.9) return true;
  if (d > S.prm.range) return false;
  var a = Math.atan2(dy, dx) - s.dir;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  if (Math.abs(a) > S.prm.half) return false;
  return lineOfSight(S.map, s.x, s.y, p.x, p.y);
}

function canSee(s) {
  if (S.protect > 0 || S.player.hidden) return false;
  return rawSee(s, S.player);
}

function goTo(s, tx, ty, checking) {
  var st = tileOf(s);
  var path = findPath(S.map, st.x, st.y, tx, ty);
  s.path = path && path.length ? path : null;
  s.target = { x: tx, y: ty };
  s.checking = !!checking;
}

function pickPatrol(s) {
  var map = S.map;
  if (Math.random() < S.prm.check && map.spots.length) {
    var sp = map.spots[Math.floor(Math.random() * map.spots.length)];
    goTo(s, sp.x, sp.y, true);
  } else {
    var st = tileOf(s), f;
    for (var k = 0; k < 8; k++) {
      f = map.floors[Math.floor(Math.random() * map.floors.length)];
      if (Math.abs(f.x - st.x) + Math.abs(f.y - st.y) > 5) break;
    }
    goTo(s, f.x, f.y, false);
  }
  s.state = 'patrol';
}

function say(s, text) { s.bubble = text; s.bubbleT = 1.2; }

function updateSeeker(s, dt) {
  var p = S.player;
  var sees = canSee(s);
  if (sees) {
    if (s.state !== 'chase') { say(s, '!'); sfx.alert(); vibrate('medium'); S.spotted++; }
    s.state = 'chase';
    s.last = { x: p.x, y: p.y };
    s.repath -= dt;
    if (s.repath <= 0) {
      var pt = tileOf(p);
      goTo(s, pt.x, pt.y, false);
      s.repath = 0.25;
    }
  }

  if (s.state === 'look') {
    s.lookT -= dt;
    s.dir += Math.sin(S.clock * 3 + s.x) * dt * 2.2;
    if (s.lookT <= 0) pickPatrol(s);
  } else if (s.path) {
    var wp = s.path[0];
    var dx = wp.x - s.x, dy = wp.y - s.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    var speed = s.state === 'chase' ? S.prm.run : S.prm.walk;
    var stepLen = speed * dt;
    var want = Math.atan2(dy, dx);
    var da = want - s.dir;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    s.dir += da * Math.min(1, dt * 10);
    if (d <= stepLen) {
      s.x = wp.x; s.y = wp.y;
      s.path.shift();
      if (!s.path.length) s.path = null;
    } else {
      s.x += dx / d * stepLen;
      s.y += dy / d * stepLen;
    }
  } else {
    // 走到目标了
    var st = tileOf(s), pt2 = tileOf(p);
    if (p.hidden && st.x === pt2.x && st.y === pt2.y && (s.checking || s.knowSpot || s.state === 'chase')) {
      caught(s, 'spot');
      return;
    }
    var wasChase = s.state === 'chase';
    if (wasChase && !sees) say(s, '?');
    s.knowSpot = null;
    s.checking = false;
    s.state = 'look';
    s.lookT = wasChase ? 1.6 : 0.9;
  }

  if (s.bubbleT > 0) s.bubbleT -= dt;

  if (S.protect <= 0 && !p.hidden) {
    var ddx = p.x - s.x, ddy = p.y - s.y;
    if (ddx * ddx + ddy * ddy < (T * 0.55) * (T * 0.55)) caught(s, 'touch');
  }
}

function caught(s, how) {
  if (S.status !== 'play') return;
  S.caughtBy = how;
  say(s, '抓到了');
  fail();
}

function movePlayer(dt) {
  var p = S.player;
  var mx = 0, my = 0;

  // 跟手：手指挪多少，小人就走多少
  var pl = Math.sqrt(input.pendX * input.pendX + input.pendY * input.pendY);
  if (pl > 0.2) {
    var maxStep = DRAG_MAX * dt;
    var k = pl > maxStep ? maxStep / pl : 1;
    mx = input.pendX * k; my = input.pendY * k;
    input.pendX -= mx; input.pendY -= my;
    var rest = Math.sqrt(input.pendX * input.pendX + input.pendY * input.pendY);
    if (rest > DRAG_CARRY) { input.pendX *= DRAG_CARRY / rest; input.pendY *= DRAG_CARRY / rest; }
  } else {
    input.pendX = 0; input.pendY = 0;
  }

  var kx = 0, ky = 0;
  if (input.keys.left) kx -= 1;
  if (input.keys.right) kx += 1;
  if (input.keys.up) ky -= 1;
  if (input.keys.down) ky += 1;
  var km = Math.sqrt(kx * kx + ky * ky);
  if (km > 0) { mx += kx / km * PLAYER_SPEED * dt; my += ky / km * PLAYER_SPEED * dt; }

  var m = Math.sqrt(mx * mx + my * my);
  p.moving = m > 0.05;

  if (p.moving) {
    p.dir = Math.atan2(my, mx);
    var nx = p.x + mx, ny = p.y + my;
    if (!hitsWall(nx, p.y)) p.x = nx;
    if (!hitsWall(p.x, ny)) p.y = ny;
    p.still = 0;
    if (p.hidden) p.hidden = false;
  } else {
    p.still += dt;
  }

  var onSpot = tileAt(S.map, p.x, p.y) === SPOT;
  if (onSpot && !p.moving && p.still >= HIDE_DELAY && !p.hidden) {
    // 吸附到藏身点中心
    var t = tileOf(p);
    p.x = (t.x + 0.5) * T; p.y = (t.y + 0.5) * T;
    S.seekers.forEach(function (s) {
      if (S.protect <= 0 && rawSee(s, p)) {
        s.knowSpot = t;
        s.state = 'chase';
        goTo(s, t.x, t.y, true);
        say(s, '!');
      }
    });
    p.hidden = true;
    sfx.hide();
  }
}

function hitsWall(x, y) {
  var r = PLAYER_R;
  return blocksMove(S.map, x - r, y - r) || blocksMove(S.map, x + r, y - r) ||
         blocksMove(S.map, x - r, y + r) || blocksMove(S.map, x + r, y + r);
}

function spotDanger() {
  var p = S.player;
  if (!p.hidden) return false;
  var pt = tileOf(p);
  return S.seekers.some(function (s) {
    if (!s.target || s.target.x !== pt.x || s.target.y !== pt.y) return false;
    if (!(s.checking || s.knowSpot || s.state === 'chase')) return false;
    var st = tileOf(s);
    return Math.abs(st.x - pt.x) + Math.abs(st.y - pt.y) <= WARN_TILES;
  });
}

function step(dt) {
  if (!S || S.status !== 'play') return;
  S.clock += dt;
  if (S.protect > 0) S.protect -= dt;
  movePlayer(dt);
  for (var i = 0; i < S.seekers.length && S.status === 'play'; i++) updateSeeker(S.seekers[i], dt);
  if (S.status !== 'play') return;

  var danger = spotDanger();
  if (danger && !S.warned) { S.warned = true; sfx.warn(); vibrate('light'); }
  if (!danger) S.warned = false;

  if (S.noticeT > 0) S.noticeT -= dt;
  if (S.mode === 'endless') {
    S.elapsed += dt;
    if (S.elapsed >= S.nextSpawn) spawnSeeker();
  } else {
    S.left -= dt;
    var whole = Math.ceil(S.left);
    if (whole <= 5 && whole !== S.lastTick && whole > 0) { S.lastTick = whole; sfx.tick(); }
    if (S.left <= 0) { S.left = 0; win(); }
  }
  if (S.status === 'play') ambUpdate(dt);
  updateBar();
}

function endlessScore() { return Math.round(S.elapsed * 10) / 10; }

function win() {
  S.status = 'win';
  ambStop(0.6);
  sfx.win();
  vibrate('heavy');
  if (S.level + 1 > saveState.level) saveState.level = S.level + 1;
  if (S.level > saveState.best) saveState.best = S.level;
  saveData(saveState);
  setTimeout(showWin, 500);
}

function fail() {
  S.status = 'fail';
  ambStop(0.08);
  sfx.caught();
  vibrate('heavy');
  if (S.mode === 'endless') {
    var score = endlessScore();
    S.newBest = score > (saveState.endlessBest || 0);
    if (S.newBest) { saveState.endlessBest = score; saveData(saveState); }
    var run = S;
    submitEndless(score).then(function (r) {
      run.rank = r;
      if (S === run && !$('overlay').classList.contains('hidden') && r) $('r-hint').textContent = endlessHint(run);
    });
    setTimeout(showEndlessFail, 700);
    return;
  }
  setTimeout(showFail, 700);
}

function revive() {
  S.seekers.forEach(function (s, i) {
    var st = S.mode === 'endless' ? farTile(9) : S.map.seekerStarts[i];
    s.x = (st.x + 0.5) * T; s.y = (st.y + 0.5) * T;
    s.state = 'look'; s.lookT = 1.2; s.path = null; s.knowSpot = null; s.checking = false; s.bubble = '';
  });
  S.revived = true;
  S.reviveReady = false;
  S.protect = PROTECT_S;
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

function paintGrid(c, w, h, step) {
  c.strokeStyle = 'rgba(255,255,255,0.035)';
  c.lineWidth = 1;
  c.beginPath();
  for (var x = step; x < w; x += step) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, h); }
  for (var y = step; y < h; y += step) { c.moveTo(0, y + 0.5); c.lineTo(w, y + 0.5); }
  c.stroke();
}

function paintBody(c, x, y, r, color, dark, dir, eyesOnly) {
  if (!eyesOnly) {
    c.beginPath();
    c.arc(x, y + r * 0.15, r, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fill();
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = color;
    c.fill();
    c.lineWidth = Math.max(1.5, r * 0.12);
    c.strokeStyle = dark;
    c.stroke();
  }
  var ex = Math.cos(dir) * r * 0.32, ey = Math.sin(dir) * r * 0.32;
  var px = -Math.sin(dir) * r * 0.32, py = Math.cos(dir) * r * 0.32;
  [1, -1].forEach(function (sgn) {
    c.beginPath();
    c.arc(x + ex + px * sgn, y + ey + py * sgn, r * 0.26, 0, Math.PI * 2);
    c.fillStyle = '#fff';
    c.fill();
    c.beginPath();
    c.arc(x + ex * 1.35 + px * sgn, y + ey * 1.35 + py * sgn, r * 0.12, 0, Math.PI * 2);
    c.fillStyle = '#111';
    c.fill();
  });
}

function paintCone(c, map, x, y, dir, half, range, alpha) {
  var pts = [];
  for (var a = dir - half; a <= dir + half + 0.001; a += 0.06) pts.push(castRay(map, x, y, a, range));
  var g = c.createRadialGradient(x, y, 4, x, y, range);
  g.addColorStop(0, 'rgba(255,236,150,' + (0.55 * alpha).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(255,236,150,0)');
  c.beginPath();
  c.moveTo(x, y);
  pts.forEach(function (p) { c.lineTo(p.x, p.y); });
  c.closePath();
  c.fillStyle = g;
  c.fill();
}

function paintCloset(c, x, y, s) {
  roundRectPath(c, x + s * 0.08, y + s * 0.04, s * 0.84, s * 0.92, s * 0.08);
  c.fillStyle = '#7a5536';
  c.fill();
  c.strokeStyle = '#4e3420';
  c.lineWidth = 1.5;
  c.stroke();
  c.beginPath();
  c.moveTo(x + s * 0.5, y + s * 0.1);
  c.lineTo(x + s * 0.5, y + s * 0.9);
  c.stroke();
  c.fillStyle = '#e0b46a';
  c.beginPath(); c.arc(x + s * 0.42, y + s * 0.5, s * 0.045, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.arc(x + s * 0.58, y + s * 0.5, s * 0.045, 0, Math.PI * 2); c.fill();
}

function paintBox(c, x, y, s) {
  roundRectPath(c, x + s * 0.1, y + s * 0.12, s * 0.8, s * 0.76, s * 0.06);
  c.fillStyle = '#b98b52';
  c.fill();
  c.strokeStyle = '#7d5a2f';
  c.lineWidth = 1.5;
  c.stroke();
  c.fillStyle = '#dcb67e';
  c.fillRect(x + s * 0.44, y + s * 0.12, s * 0.12, s * 0.76);
}

var BLOCK_COLORS = { sofa: ['#3c5a6b', '#284050'], table: ['#6b4f3a', '#4a3524'], shelf: ['#4c4660', '#332e44'], bed: ['#5b6e8c', '#3c4a63'] };

function paintMap(c, map) {
  c.fillStyle = '#0d1016';
  c.fillRect(0, 0, W, H);
  for (var y = 0; y < ROWS; y++) {
    for (var x = 0; x < COLS; x++) {
      var t = map.tile[idx(x, y)];
      if (t === WALL) continue;
      c.fillStyle = (x + y) % 2 ? '#1b2029' : '#1e232d';
      c.fillRect(x * T, y * T, T, T);
    }
  }
  for (y = 0; y < ROWS; y++) {
    for (x = 0; x < COLS; x++) {
      if (map.tile[idx(x, y)] !== WALL) continue;
      c.fillStyle = '#353d4e';
      c.fillRect(x * T, y * T, T, T);
      c.fillStyle = '#424b5f';
      c.fillRect(x * T, y * T, T, 4);
    }
  }
  map.blocks.forEach(function (b) {
    var col = BLOCK_COLORS[b.kind];
    roundRectPath(c, b.x * T + 3, b.y * T + 3, b.w * T - 6, b.h * T - 6, 6);
    c.fillStyle = col[0];
    c.fill();
    c.strokeStyle = col[1];
    c.lineWidth = 2;
    c.stroke();
    if (b.kind === 'bed') {
      c.fillStyle = '#d9dde6';
      roundRectPath(c, b.x * T + 7, b.y * T + 7, Math.min(b.w, 1) * T - 14 + (b.w - 1) * T, 9, 4);
      c.fill();
    }
  });
}

function paintSpots(c, map, danger, hiddenAt) {
  map.spots.forEach(function (sp) {
    var x = sp.x * T, y = sp.y * T;
    if (map.spotKind[idx(sp.x, sp.y)] === 'closet') paintCloset(c, x, y, T); else paintBox(c, x, y, T);
    if (hiddenAt && hiddenAt.x === sp.x && hiddenAt.y === sp.y) {
      if (danger) {
        c.save();
        c.globalAlpha = 0.45 + 0.4 * Math.abs(Math.sin(S.clock * 9));
        roundRectPath(c, x + 1, y + 1, T - 2, T - 2, 6);
        c.strokeStyle = '#ff3b4f';
        c.lineWidth = 3;
        c.stroke();
        c.restore();
      }
      paintBody(c, x + T / 2, y + T * 0.42, T * 0.26, '', '', Math.PI / 2, true);
    }
  });
}

// ============ 首页大图 ============
function $(id) { return document.getElementById(id); }

function paintHeroArt(c, w, h, dpr) {
  var g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#131824');
  g.addColorStop(1, '#0d1016');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  paintGrid(c, w, h, 44);
  var u = Math.min(w, h * 0.75) / 390;

  // 墙和家具剪影
  c.fillStyle = '#353d4e';
  c.fillRect(0, h * 0.18, w * 0.42, 14 * u);
  c.fillRect(w * 0.42, h * 0.18, 14 * u, h * 0.3);
  roundRectPath(c, w * 0.08, h * 0.26, 90 * u, 52 * u, 10 * u);
  c.fillStyle = '#3c5a6b';
  c.fill();

  // 手电光
  var sx = w * 0.86, sy = h * 0.2, range = 360 * u, dir = 2.35, half = 0.42;
  var cg = c.createRadialGradient(sx, sy, 6, sx, sy, range);
  cg.addColorStop(0, 'rgba(255,236,150,0.55)');
  cg.addColorStop(1, 'rgba(255,236,150,0)');
  c.beginPath();
  c.moveTo(sx, sy);
  c.arc(sx, sy, range, dir - half, dir + half);
  c.closePath();
  c.fillStyle = cg;
  c.fill();
  paintBody(c, sx, sy, 34 * u, '#ff3b4f', '#b3192b', dir);

  // 衣柜里露出一双眼睛
  var s = 120 * u, bx = w * 0.62, by = h * 0.5;
  paintCloset(c, bx, by, s);
  c.fillStyle = '#0b0d12';
  c.fillRect(bx + s * 0.47, by + s * 0.12, s * 0.06, s * 0.76);
  paintBody(c, bx + s * 0.5, by + s * 0.34, s * 0.16, '', '', Math.PI / 2, true);

  paintBox(c, w * 0.08, h * 0.05, 64 * u);

  var g2 = c.createLinearGradient(0, h * 0.45, 0, h);
  g2.addColorStop(0, 'rgba(13,16,22,0)');
  g2.addColorStop(1, 'rgba(13,16,22,0.85)');
  c.fillStyle = g2;
  c.fillRect(0, h * 0.45, w, h * 0.55);
}

function drawHero() {
  var box = $('hero');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  var s = setupCanvas($('hero-cv'), w, h);
  paintHeroArt(s.c, w, h, s.dpr);
}

function drawDialogArt() {
  var box = $('dlg-art');
  var w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  box.innerHTML = '';
  var cnv = document.createElement('canvas');
  box.appendChild(cnv);
  var c = setupCanvas(cnv, w, h).c;
  c.fillStyle = '#131824';
  c.fillRect(0, 0, w, h);
  paintGrid(c, w, h, 28);
  var sx = w * 0.18, sy = h * 0.5, range = w * 0.7;
  var cg = c.createRadialGradient(sx, sy, 4, sx, sy, range);
  cg.addColorStop(0, 'rgba(255,236,150,0.5)');
  cg.addColorStop(1, 'rgba(255,236,150,0)');
  c.beginPath(); c.moveTo(sx, sy); c.arc(sx, sy, range, -0.35, 0.35); c.closePath();
  c.fillStyle = cg; c.fill();
  paintBody(c, sx, sy, 20, '#ff3b4f', '#b3192b', 0);
  paintBox(c, w * 0.72, h * 0.2, 64);
  paintBody(c, w * 0.72 + 32, h * 0.2 + 30, 11, '', '', Math.PI / 2, true);
}

// ============ 游戏画布 ============
var cv = $('cv');
var ctx = cv.getContext('2d');
var view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
var mapLayer = null;

function resizeGame() {
  var stage = $('stage');
  var cw = stage.clientWidth, ch = stage.clientHeight;
  if (!cw || !ch) return;
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  cv.style.width = cw + 'px';
  cv.style.height = ch + 'px';
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  var sc = Math.min(cw / W, ch / H);
  view = { scale: sc, ox: (cw - W * sc) / 2, oy: (ch - H * sc) / 2, dpr: dpr };
  mapLayer = null;
}

function buildMapLayer() {
  var px = view.dpr * view.scale;
  var layer = document.createElement('canvas');
  layer.width = Math.ceil(W * px);
  layer.height = Math.ceil(H * px);
  var c = layer.getContext('2d');
  c.scale(px, px);
  paintMap(c, S.map);
  mapLayer = { canvas: layer, map: S.map };
}

function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!S) return;
  var px = view.dpr * view.scale;
  ctx.setTransform(px, 0, 0, px, view.dpr * view.ox, view.dpr * view.oy);

  if (!mapLayer || mapLayer.map !== S.map) buildMapLayer();
  ctx.drawImage(mapLayer.canvas, 0, 0, W, H);

  var p = S.player;
  var danger = spotDanger();
  paintSpots(ctx, S.map, danger, p.hidden ? tileOf(p) : null);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  S.seekers.forEach(function (s) {
    paintCone(ctx, S.map, s.x, s.y, s.dir, S.prm.half, S.prm.range, s.state === 'chase' ? 1 : 0.75);
  });
  ctx.restore();

  if (!p.hidden) {
    ctx.save();
    if (S.protect > 0) ctx.globalAlpha = 0.35 + 0.35 * Math.abs(Math.sin(S.clock * 10));
    paintBody(ctx, p.x, p.y, PLAYER_R, '#66dcff', '#2a8db3', p.dir);
    ctx.restore();
  }

  S.seekers.forEach(function (s) {
    paintBody(ctx, s.x, s.y, T * 0.36, s.state === 'chase' ? '#ff3b4f' : '#e05a63', '#8f1d2a', s.dir);
    if (s.bubbleT > 0 && s.bubble) {
      ctx.font = '900 ' + (s.bubble.length > 1 ? 13 : 18) + 'px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(s.bubble, s.x, s.y - T * 0.75);
      ctx.fillStyle = s.bubble === '?' ? '#ffd166' : '#fff';
      ctx.fillText(s.bubble, s.x, s.y - T * 0.75);
    }
  });


  if (S.status === 'play') {
    var tip = '';
    if (S.protect > 0) tip = '隐身中 ' + Math.ceil(S.protect);
    else if (danger) tip = '有人来翻了，快跑';
    else if (S.noticeT > 0) tip = '又来一个人找你，现在 ' + S.seekers.length + ' 个';
    else if (!p.hidden && tileAt(S.map, p.x, p.y) === SPOT) tip = '停下来就能躲进去';
    if (tip) {
      ctx.font = '800 15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(tip, W / 2, H - T * 0.5);
      ctx.fillStyle = danger ? '#ff6b7a' : '#66dcff';
      ctx.fillText(tip, W / 2, H - T * 0.5);
    }
  }
}

// ============ 主循环 ============
var last = 0, running = true, inGame = false;

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
  // 切到后台时心跳和嗡鸣也要停，不然后台还在响
  if (audio) {
    try { if (document.hidden) audio.suspend(); else if (inGame) audio.resume(); } catch (e) { /* 部分内核不支持 */ }
  }
  if (document.hidden) {
    running = false;
  } else if (!running) {
    running = true;
    last = 0;
    requestAnimationFrame(loop);
  }
});

// ============ 输入 ============
function onDown(x, y) { initAudio(); input.active = true; input.lastX = x; input.lastY = y; input.pendX = 0; input.pendY = 0; }
function onMove(x, y) {
  if (!input.active) return;
  input.pendX += (x - input.lastX) / view.scale;
  input.pendY += (y - input.lastY) / view.scale;
  input.lastX = x; input.lastY = y;
}
function onUp() { input.active = false; }

if (window.PointerEvent) {
  cv.addEventListener('pointerdown', function (e) { e.preventDefault(); onDown(e.clientX, e.clientY); });
  window.addEventListener('pointermove', function (e) { onMove(e.clientX, e.clientY); });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
} else {
  cv.addEventListener('touchstart', function (e) { e.preventDefault(); var t = e.changedTouches[0]; onDown(t.clientX, t.clientY); }, { passive: false });
  cv.addEventListener('touchmove', function (e) { e.preventDefault(); var t = e.changedTouches[0]; onMove(t.clientX, t.clientY); }, { passive: false });
  cv.addEventListener('touchend', onUp);
  cv.addEventListener('mousedown', function (e) { onDown(e.clientX, e.clientY); });
  window.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); });
  window.addEventListener('mouseup', onUp);
}

var KEYMAP = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', a: 'left', d: 'right', w: 'up', s: 'down' };
window.addEventListener('keydown', function (e) { var k = KEYMAP[e.key]; if (k) { input.keys[k] = true; initAudio(); } });
window.addEventListener('keyup', function (e) { var k = KEYMAP[e.key]; if (k) input.keys[k] = false; });

// ============ 页面切换 ============
function showHome() {
  inGame = false;
  ambStop(0.3);
  hideOverlay();
  $('game').classList.add('hidden');
  $('home').classList.remove('hidden');
  renderHome();
  drawHero();
}

function showGame(level, endless) {
  initAudio();
  $('home').classList.add('hidden');
  $('game').classList.remove('hidden');
  resizeGame();
  startLevel(level, endless);
  inGame = true;
}

function fmtSec(v) { return (Math.round(v * 10) / 10).toFixed(1); }

function renderHome() {
  var endless = saveState.mode === 'endless';
  $('tab-level').classList.toggle('active', !endless);
  $('tab-endless').classList.toggle('active', endless);
  if (endless) {
    $('home-best').innerHTML = saveState.endlessBest > 0
      ? '无限模式最佳 <b>' + fmtSec(saveState.endlessBest) + ' 秒</b>'
      : '每 ' + ENDLESS_EVERY + ' 秒多一个人找你，看你能撑多久';
    $('btn-start').innerHTML = '开始无限模式' + ARROW;
  } else {
    $('home-best').innerHTML = saveState.best > 0
      ? '最高通关 <b>第 ' + saveState.best + ' 关</b>'
      : '第 1 关只有 1 个人在找你，先熟悉一下';
    $('btn-start').innerHTML = (saveState.level > 1 ? '继续第 ' + saveState.level + ' 关' : '开始挑战') + ARROW;
  }
  $('nav-sound').classList.toggle('muted', !!saveState.muted);
  $('sound-label').textContent = saveState.muted ? '声音 关' : '声音 开';
  renderFollow();
}

function updateBar() {
  if (S.mode === 'endless') {
    $('level').textContent = '无限模式';
    $('progress').textContent = '已撑 ' + fmtSec(S.elapsed) + ' 秒 · ' + S.seekers.length + ' 人在找你';
    $('bar-fill').style.width = ((S.elapsed % ENDLESS_EVERY) / ENDLESS_EVERY * 100) + '%';
    return;
  }
  $('level').textContent = '第 ' + S.level + ' 关';
  $('progress').textContent = '还要躲 ' + Math.ceil(S.left) + ' 秒 · ' + S.seekers.length + ' 人在找你';
  $('bar-fill').style.width = Math.min(100, (1 - S.left / S.total) * 100) + '%';
}

function restartRun() { initAudio(); startLevel(S.level, S.mode === 'endless'); }

$('btn-start').addEventListener('click', function () {
  if (saveState.mode === 'endless') showGame(1, true); else showGame(saveState.level);
});
$('btn-back').addEventListener('click', showHome);
$('btn-restart').addEventListener('click', restartRun);

['tab-level', 'tab-endless'].forEach(function (id) {
  $(id).addEventListener('click', function () {
    var m = $(id).getAttribute('data-mode');
    if (saveState.mode === m) return;
    saveState.mode = m;
    saveData(saveState);
    renderHome();
  });
});

$('nav-rank').addEventListener('click', function () { openRank('day'); });

$('nav-sound').addEventListener('click', function () {
  saveState.muted = !saveState.muted;
  saveData(saveState);
  renderHome();
  if (!saveState.muted) { initAudio(); sfx.hide(); }
});

$('nav-help').addEventListener('click', function () {
  openDialog({
    kicker: '怎么玩',
    title: '玩法说明',
    html: '<ol><li>手指按住屏幕任意位置拖动，小人跟着手指走；手指停下，小人也停下。</li>' +
          '<li>被手电照到会被追，被抓到就输；撑到倒计时结束就过关。</li>' +
          '<li>走到衣柜或纸箱上停一下，就躲进去了，手电照不到你。</li>' +
          '<li>他们会随机来翻藏身点，藏身点闪红光时赶紧换地方。当着他们的面躲进去没用。</li>' +
          '<li>输了可以发一篇笔记复活一次，找你的人回到起点，你隐身 3 秒。</li>' +
          '<li>无限模式没有终点，每 ' + ENDLESS_EVERY + ' 秒多一个人找你，撑的秒数会上排行榜。</li></ol>',
    main: '知道了',
    onMain: closeDialog
  });
});

// 已解锁到 saveState.level，后面再多露出几关锁住的，让人知道还有
$('nav-levels').addEventListener('click', function () {
  var unlocked = Math.max(1, saveState.level);
  var shown = Math.max(unlocked + 4, 10);
  var html = '<div class="lv-grid">';
  for (var n = 1; n <= shown; n++) {
    var cls = n > unlocked ? 'locked' : (n <= saveState.best ? 'done' : '');
    if (n === unlocked) cls += ' current';
    var tag = n > unlocked ? '未解锁' : (n <= saveState.best ? '已过' : '可玩');
    html += '<button type="button" data-lv="' + n + '" class="' + cls + '">' + n + '<small>' + tag + '</small></button>';
  }
  html += '</div>';
  openDialog({
    kicker: '已解锁 ' + unlocked + ' 关',
    title: '选择关卡',
    html: html,
    main: '关闭',
    onMain: closeDialog
  });
});

$('dlg-body').addEventListener('click', function (e) {
  var btn = e.target.closest ? e.target.closest('button[data-lv]') : null;
  if (!btn) return;
  var n = parseInt(btn.getAttribute('data-lv'), 10);
  if (n > Math.max(1, saveState.level)) { toast('先通过第 ' + (n - 1) + ' 关才能玩'); return; }
  closeDialog();
  showGame(n);
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
    kicker: '躲好别出声的作者',
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

function survived() { return Math.floor(S.total - S.left); }

function showFail() {
  var canRevive = !S.revived;
  var o = {
    kicker: '第 ' + S.level + ' 关 · 本局成绩',
    num: String(survived()),
    unit: '/ ' + S.total + ' 秒',
    tag: '差一点',
    title: S.caughtBy === 'spot' ? '被翻出来了' : '被抓到了',
    sub: canRevive ? '找你的人回到起点，你还能隐身 3 秒。' : '这关的复活机会用过了，重来一次吧。',
    stats: [['被发现', S.spotted + ' 次'], ['找你的人', S.seekers.length + ' 个'], ['最高通关', saveState.best ? '第 ' + saveState.best + ' 关' : '暂无']],
    pct: survived() / S.total,
    hint: '再坚持 ' + Math.ceil(S.left) + ' 秒就过关'
  };
  if (canRevive) {
    o.main = '发笔记复活'; o.mainArrow = true; o.onMain = onReviveClick;
    o.note = '发布成功后手动继续 · 每关一次 · 3 秒隐身';
    o.second = '重新开始本关'; o.onSecond = function () { startLevel(S.level); };
    o.third = '返回主页'; o.onThird = showHome;
  } else {
    o.main = '重新开始本关'; o.onMain = function () { startLevel(S.level); };
    o.second = '返回主页'; o.onSecond = showHome;
  }
  fillSheet(o);
}

function endlessHint(run) {
  var r = run.rank;
  var rankText = '';
  if (r && r.status === 'EXACT') rankText = '今天排第 ' + r.rank + ' 名';
  else if (r && r.status === 'OVER_LIMIT') rankText = '今天排在 10000 名以外';
  if (run.newBest) return '新纪录！' + (rankText ? ' · ' + rankText : '');
  var gap = (saveState.endlessBest || 0) - endlessScore();
  return rankText || ('离最佳还差 ' + fmtSec(Math.max(0, gap)) + ' 秒');
}

function showEndlessFail() {
  var canRevive = !S.revived;
  var o = {
    kicker: '无限模式 · 本局成绩',
    num: fmtSec(S.elapsed),
    unit: '秒',
    tag: S.newBest ? '新纪录' : '本局',
    title: S.caughtBy === 'spot' ? '被翻出来了' : '被抓到了',
    sub: canRevive ? '所有人被送到远处，你还能隐身 3 秒。' : '这局的复活机会用过了，再来一局吧。',
    stats: [['最多同时', S.maxSeekers + ' 人'], ['被发现', S.spotted + ' 次'], ['历史最佳', fmtSec(saveState.endlessBest || 0) + ' 秒']],
    pct: saveState.endlessBest ? S.elapsed / saveState.endlessBest : 1,
    hint: endlessHint(S)
  };
  var again = function () { startLevel(1, true); };
  if (canRevive) {
    o.main = '发笔记复活'; o.mainArrow = true; o.onMain = onReviveClick;
    o.note = '发布成功后手动继续 · 每局一次 · 3 秒隐身';
    o.second = '再来一局'; o.onSecond = again;
  } else {
    o.main = '再来一局'; o.mainArrow = true; o.onMain = again;
    o.second = '发笔记晒成绩'; o.onSecond = function () { shareNote(false); };
  }
  o.third = '看排行榜'; o.onThird = function () { openRank('day'); };
  o.fourth = '返回主页'; o.onFourth = showHome;
  fillSheet(o);
}

function showWin() {
  fillSheet({
    kicker: '第 ' + S.level + ' 关 · 本局成绩',
    num: String(S.total),
    unit: '秒没被抓',
    tag: S.spotted === 0 ? '完美潜伏' : (S.revived ? '通关' : '一命通关'),
    title: '第 ' + S.level + ' 关 通过',
    sub: S.spotted === 0 ? '全程一次都没被发现。' : '被发现了 ' + S.spotted + ' 次，还是溜掉了。',
    stats: [['找你的人', S.seekers.length + ' 个'], ['下一关要躲', levelParams(S.level + 1).time + ' 秒'], ['最高通关', '第 ' + saveState.best + ' 关']],
    pct: 1,
    hint: '下一关他们走得更快',
    main: '下一关', mainArrow: true,
    onMain: function () { startLevel(S.level + 1); },
    second: '发笔记晒成绩',
    onSecond: function () { shareNote(false); },
    third: '返回主页',
    onThird: showHome,
    fourth: ''
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
    $('r-note').textContent = '笔记已发布，点继续接着躲';
  } else {
    main.innerHTML = '发笔记复活' + ARROW;
    toast('没有发布成功，可以再试一次');
  }
}

// ============ 排行榜（内测能力，需平台为 appId 开通；无限模式按撑的秒数排） ============
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

async function submitEndless(score) {
  if (!hasRank() || rankOff) return null;
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
    kicker: '无限模式 · 撑得越久排越前',
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
  return saveState.endlessBest ? '你的最佳 ' + fmtSec(saveState.endlessBest) + ' 秒' : '你还没有无限模式成绩';
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
    score.textContent = fmtSec(Number(row.score) || 0) + ' 秒';
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
    el.appendChild(document.createTextNode(' 名 · ' + fmtSec(Number(me.score) || 0) + ' 秒'));
  } else if (me && me.status === 'OVER_LIMIT') {
    b.textContent = '10000+';
    el.appendChild(document.createTextNode('我排在 '));
    el.appendChild(b);
    el.appendChild(document.createTextNode(' · ' + fmtSec(Number(me.score) || 0) + ' 秒'));
  } else {
    el.textContent = '这一期你还没有成绩，' + (saveState.endlessBest ? '本机最佳 ' + fmtSec(saveState.endlessBest) + ' 秒' : '去无限模式玩一局');
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
  x.fillText('躲好', 56, 56);
  x.fillStyle = '#ff3b4f';
  x.fillText('别出声', 56 + x.measureText('躲好').width + 6, 56);
  var endless = S.mode === 'endless';
  x.fillStyle = '#ffffff';
  x.font = 'italic 900 130px ' + font;
  x.fillText(endless ? fmtSec(S.elapsed) + ' 秒' : '第 ' + S.level + ' 关', 50, 120);
  x.font = '800 44px ' + font;
  x.fillStyle = '#66dcff';
  if (endless) x.fillText('无限模式撑了 ' + fmtSec(S.elapsed) + ' 秒', 56, 282);
  else x.fillText(isFail ? '躲了 ' + survived() + ' 秒，还是被抓了' : S.total + ' 秒没被抓到', 56, 282);
  x.fillStyle = '#8b93a1';
  x.font = '600 30px ' + font;
  x.fillText(endless ? '最后 ' + S.seekers.length + ' 个人一起找我 · 你能撑多久'
    : S.seekers.length + ' 个人在找我' + (isFail ? ' · 你能躲过吗' : ' · 你来试试'), 56, 352);
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
    var endless = S.mode === 'endless';
    var title = endless ? '捉迷藏无限模式撑了' + fmtSec(S.elapsed) + '秒'
      : (isFail ? '捉迷藏第' + S.level + '关，谁能躲过' : '捉迷藏第' + S.level + '关没被抓');
    var content = endless
      ? '小工具「躲好别出声」无限模式，每5秒多一个人找我，撑了' + fmtSec(S.elapsed) + '秒，最后' + S.seekers.length + '个人一起找。你能撑多久？ #捉迷藏 #小游戏'
      : isFail
      ? '在小工具「躲好别出声」第' + S.level + '关躲了' + survived() + '秒还是被抓了。你能躲过吗？ #捉迷藏 #小游戏'
      : '小工具「躲好别出声」第' + S.level + '关，' + S.seekers.length + '个人找我，' + S.total + '秒没被抓到。来比比？ #捉迷藏 #小游戏';
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
    saveState.level = Math.max(1, d.level | 0);
    saveState.best = Math.max(0, d.best | 0);
    saveState.endlessBest = Math.max(0, Number(d.endlessBest) || 0);
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
