(function () {
'use strict';

// ============ 常量 ============
var COLS = 13, ROWS = 21, T = 30;
var W = COLS * T, H = ROWS * T;
var FLOOR = 0, WALL = 1, BLOCK = 2, SPOT = 3;
var PLAYER_R = T * 0.32;
var PLAYER_SPEED = 3.2 * T;          // 像素/秒
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
  hide: function () { beep(420, 0.08, 'sine', 0.1, 300); },
  alert: function () { beep(880, 0.09, 'square', 0.07); setTimeout(function () { beep(1180, 0.12, 'square', 0.07); }, 90); },
  warn: function () { beep(300, 0.1, 'triangle', 0.1); },
  tick: function () { beep(1000, 0.04, 'sine', 0.06); },
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
var input = { active: false, ox: 0, oy: 0, x: 0, y: 0, keys: {} };

function startLevel(n) {
  var map = genMap(n);
  var prm = levelParams(n);
  S = {
    level: n, prm: prm, map: map,
    player: { x: (map.playerStart.x + 0.5) * T, y: (map.playerStart.y + 0.5) * T, dir: 0, hidden: false, still: 0, moving: false },
    seekers: [],
    left: prm.time, total: prm.time,
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
  var vx = 0, vy = 0;
  if (input.active) {
    var dx = input.x - input.ox, dy = input.y - input.oy;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > 6) {
      var k = Math.min(1, len / 40);
      vx = dx / len * k; vy = dy / len * k;
    }
  }
  if (input.keys.left) vx -= 1;
  if (input.keys.right) vx += 1;
  if (input.keys.up) vy -= 1;
  if (input.keys.down) vy += 1;
  var m = Math.sqrt(vx * vx + vy * vy);
  if (m > 1) { vx /= m; vy /= m; m = 1; }
  p.moving = m > 0.05;

  if (p.moving) {
    p.dir = Math.atan2(vy, vx);
    var step = PLAYER_SPEED * dt;
    var nx = p.x + vx * step, ny = p.y + vy * step;
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

  S.left -= dt;
  var whole = Math.ceil(S.left);
  if (whole <= 5 && whole !== S.lastTick && whole > 0) { S.lastTick = whole; sfx.tick(); }
  if (S.left <= 0) { S.left = 0; win(); }
  updateBar();
}

function win() {
  S.status = 'win';
  sfx.win();
  vibrate('heavy');
  if (S.level + 1 > saveState.level) saveState.level = S.level + 1;
  if (S.level > saveState.best) saveState.best = S.level;
  saveData(saveState);
  setTimeout(showWin, 500);
}

function fail() {
  S.status = 'fail';
  sfx.fail();
  vibrate('heavy');
  setTimeout(showFail, 700);
}

function revive() {
  S.seekers.forEach(function (s, i) {
    var st = S.map.seekerStarts[i];
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

  // 拖动摇杆
  if (input.active && S.status === 'play') {
    var r = cv.getBoundingClientRect();
    var ox = (input.ox - r.left - view.ox) / view.scale, oy = (input.oy - r.top - view.oy) / view.scale;
    var kx = (input.x - r.left - view.ox) / view.scale, ky = (input.y - r.top - view.oy) / view.scale;
    var dx = kx - ox, dy = ky - oy, d = Math.sqrt(dx * dx + dy * dy), lim = 40 / view.scale;
    if (d > lim) { kx = ox + dx / d * lim; ky = oy + dy / d * lim; }
    ctx.beginPath(); ctx.arc(ox, oy, lim, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(kx, ky, 16 / view.scale, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(102,220,255,0.55)'; ctx.fill();
  }

  if (S.status === 'play') {
    var tip = '';
    if (S.protect > 0) tip = '隐身中 ' + Math.ceil(S.protect);
    else if (danger) tip = '有人来翻了，快跑';
    else if (!p.hidden && tileAt(S.map, p.x, p.y) === SPOT) tip = '松手就能躲进去';
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
  if (document.hidden) {
    running = false;
  } else if (!running) {
    running = true;
    last = 0;
    requestAnimationFrame(loop);
  }
});

// ============ 输入 ============
function onDown(x, y) { initAudio(); input.active = true; input.ox = input.x = x; input.oy = input.y = y; }
function onMove(x, y) { if (input.active) { input.x = x; input.y = y; } }
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
    : '第 1 关只有 1 个人在找你，先熟悉一下';
  $('btn-start').innerHTML = (saveState.level > 1 ? '继续第 ' + saveState.level + ' 关' : '开始挑战') + ARROW;
  $('nav-sound').classList.toggle('muted', !!saveState.muted);
  $('sound-label').textContent = saveState.muted ? '声音 关' : '声音 开';
  renderFollow();
}

function updateBar() {
  $('level').textContent = '第 ' + S.level + ' 关';
  $('progress').textContent = '还要躲 ' + Math.ceil(S.left) + ' 秒 · ' + S.seekers.length + ' 人在找你';
  $('bar-fill').style.width = Math.min(100, (1 - S.left / S.total) * 100) + '%';
}

$('btn-start').addEventListener('click', function () { showGame(saveState.level); });
$('btn-back').addEventListener('click', showHome);
$('btn-restart').addEventListener('click', function () { initAudio(); startLevel(S.level); });

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
    html: '<ol><li>手指按住屏幕任意位置拖动，小人就往那个方向走。</li>' +
          '<li>被手电照到会被追，被抓到就输；撑到倒计时结束就过关。</li>' +
          '<li>站到衣柜或纸箱上松手，就躲进去了，手电照不到你。</li>' +
          '<li>他们会随机来翻藏身点，藏身点闪红光时赶紧换地方。当着他们的面躲进去没用。</li>' +
          '<li>输了可以发一篇笔记复活一次，找你的人回到起点，你隐身 3 秒。</li></ol>',
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
    $('r-note').textContent = '笔记已发布，点继续接着躲';
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
  x.fillText('躲好', 56, 56);
  x.fillStyle = '#ff3b4f';
  x.fillText('别出声', 56 + x.measureText('躲好').width + 6, 56);
  x.fillStyle = '#ffffff';
  x.font = 'italic 900 130px ' + font;
  x.fillText('第 ' + S.level + ' 关', 50, 120);
  x.font = '800 44px ' + font;
  x.fillStyle = '#66dcff';
  x.fillText(isFail ? '躲了 ' + survived() + ' 秒，还是被抓了' : S.total + ' 秒没被抓到', 56, 282);
  x.fillStyle = '#8b93a1';
  x.font = '600 30px ' + font;
  x.fillText(S.seekers.length + ' 个人在找我' + (isFail ? ' · 你能躲过吗' : ' · 你来试试'), 56, 352);
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
    var title = isFail ? '捉迷藏第' + S.level + '关，谁能躲过' : '捉迷藏第' + S.level + '关没被抓';
    var content = isFail
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
