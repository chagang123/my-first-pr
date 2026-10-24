const GAME_WIDTH = 390;
const GAME_HEIGHT = 700;
const WALL_THICK = 12;
const DROP_Y = 80;
const DEAD_LINE_Y = 120;

const FRUITS = [
  { name: '樱桃', radius: 20, color: 0xe74c3c, emoji: '🍒', score: 1,  grad: ['#ff6b6b','#c0392b'] },
  { name: '草莓', radius: 27, color: 0xff6b81, emoji: '🍓', score: 3,  grad: ['#ff8a9e','#e84393'] },
  { name: '葡萄', radius: 35, color: 0x8e44ad, emoji: '🍇', score: 6,  grad: ['#a66bbe','#6c3483'] },
  { name: '橙子', radius: 43, color: 0xf39c12, emoji: '🍊', score: 10, grad: ['#ffc048','#e67e22'] },
  { name: '桃子', radius: 50, color: 0xfdcb6e, emoji: '🍑', score: 15, grad: ['#ffeaa7','#fdcb6e'] },
  { name: '苹果', radius: 58, color: 0x27ae60, emoji: '🍎', score: 21, grad: ['#55efc4','#00b894'] },
  { name: '梨',   radius: 66, color: 0xf1c40f, emoji: '🍐', score: 28, grad: ['#ffeaa7','#f1c40f'] },
  { name: '菠萝', radius: 74, color: 0xe67e22, emoji: '🍍', score: 36, grad: ['#ffbe76','#e67e22'] },
  { name: '哈密瓜', radius: 84, color: 0x2ecc71, emoji: '🍈', score: 45, grad: ['#7bed9f','#2ecc71'] },
  { name: '西瓜', radius: 95, color: 0x1abc9c, emoji: '🍉', score: 55, grad: ['#55efc4','#00b894'] },
];

const DROP_MAX_INDEX = 4;

// ============ 音效系统（Web Audio API，不需要外部文件） ============
class SoundFX {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      this.enabled = false;
    }
  }

  ensure() {
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  drop() {
    if (!this.enabled || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(600, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(300, this.ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.15);
  }

  merge(level) {
    if (!this.enabled || !this.ctx) return;
    const baseFreq = 400 + level * 60;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(baseFreq, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, this.ctx.currentTime + 0.08);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.8, this.ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.25);
    osc.start(this.ctx.currentTime);
    osc.stop(this.ctx.currentTime + 0.25);
  }

  levelUp() {
    if (!this.enabled || !this.ctx) return;
    [500, 600, 700, 900].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.type = 'sine';
      const t = this.ctx.currentTime + i * 0.12;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.18, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  }

  gameOver() {
    if (!this.enabled || !this.ctx) return;
    [300, 250, 200].forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.type = 'triangle';
      const t = this.ctx.currentTime + i * 0.15;
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.15, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  }
}

const sfx = new SoundFX();

// ============ 水果纹理生成（离屏 Canvas） ============
function createFruitTexture(scene, idx) {
  const key = `fruit_${idx}`;
  if (scene.textures.exists(key)) return key;

  const fruit = FRUITS[idx];
  const size = fruit.radius * 2 + 4;
  const canvas = scene.textures.createCanvas(key, size, size);
  const ctx = canvas.context;
  const cx = size / 2;
  const cy = size / 2;
  const r = fruit.radius;

  // 渐变底色
  const gradient = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  gradient.addColorStop(0, fruit.grad[0]);
  gradient.addColorStop(1, fruit.grad[1]);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  // 高光
  const hlGrad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, 0, cx - r * 0.3, cy - r * 0.35, r * 0.5);
  hlGrad.addColorStop(0, 'rgba(255,255,255,0.45)');
  hlGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = hlGrad;
  ctx.fill();

  // emoji
  const emojiSize = Math.max(r * 0.9, 12);
  ctx.font = `${emojiSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fruit.emoji, cx, cy + 1);

  canvas.refresh();
  return key;
}

function createPreviewTexture(scene, idx) {
  const key = `preview_${idx}`;
  if (scene.textures.exists(key)) return key;

  const fruit = FRUITS[idx];
  const size = fruit.radius * 2 + 4;
  const canvas = scene.textures.createCanvas(key, size, size);
  const ctx = canvas.context;
  const cx = size / 2;
  const cy = size / 2;
  const r = fruit.radius;

  ctx.globalAlpha = 0.5;
  const gradient = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  gradient.addColorStop(0, fruit.grad[0]);
  gradient.addColorStop(1, fruit.grad[1]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.globalAlpha = 0.6;
  const emojiSize = Math.max(r * 0.9, 12);
  ctx.font = `${emojiSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fruit.emoji, cx, cy + 1);

  canvas.refresh();
  return key;
}

// ============ 关卡系统 ============
function getLevelTarget(level) {
  // 第1关100分，之后每关递增：100, 200, 350, 550, 800, 1100...
  if (level <= 1) return 100;
  return Math.floor(100 + (level - 1) * 50 * level / 2);
}

function getLevelGravity(level) {
  // 重力从1.5逐步增加，每关+0.1，上限3.0
  return Math.min(1.5 + (level - 1) * 0.1, 3.0);
}

// ============ 最高关卡 ============
function getHighLevel() {
  try { return parseInt(localStorage.getItem('fruit_merge_level') || '0', 10); } catch { return 0; }
}
function setHighLevel(l) {
  try { localStorage.setItem('fruit_merge_level', l.toString()); } catch {}
}
function getHighScore() {
  try { return parseInt(localStorage.getItem('fruit_merge_high') || '0', 10); } catch { return 0; }
}
function setHighScore(s) {
  try { localStorage.setItem('fruit_merge_high', s.toString()); } catch {}
}

// ============ 主场景 ============
class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
    this.score = 0;
    this.level = 1;
    this.levelScore = 0; // 当前关卡内的得分
    this.totalScore = 0; // 累计总分
    this.nextFruitIndex = 0;
    this.currentPreview = null;
    this.canDrop = true;
    this.isGameOver = false;
    this.isLevelClearing = false;
    this.fruitBodies = new Map();
    this.merging = new Set();
  }

  create() {
    sfx.ensure();

    this.matter.world.setBounds(
      WALL_THICK, 0,
      GAME_WIDTH - WALL_THICK * 2, GAME_HEIGHT - WALL_THICK,
      WALL_THICK, false, false, false, true
    );

    // 墙壁物理体
    this.matter.add.rectangle(WALL_THICK / 2, GAME_HEIGHT / 2, WALL_THICK, GAME_HEIGHT, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(GAME_WIDTH - WALL_THICK / 2, GAME_HEIGHT / 2, WALL_THICK, GAME_HEIGHT, { isStatic: true, label: 'wall' });
    this.matter.add.rectangle(GAME_WIDTH / 2, GAME_HEIGHT - WALL_THICK / 2, GAME_WIDTH, WALL_THICK, { isStatic: true, label: 'wall' });

    // 墙壁视觉
    const wallGfx = this.add.graphics();
    wallGfx.fillStyle(0x2c3e50, 1);
    wallGfx.fillRect(0, DEAD_LINE_Y, WALL_THICK, GAME_HEIGHT - DEAD_LINE_Y);
    wallGfx.fillRect(GAME_WIDTH - WALL_THICK, DEAD_LINE_Y, WALL_THICK, GAME_HEIGHT - DEAD_LINE_Y);
    wallGfx.fillRect(0, GAME_HEIGHT - WALL_THICK, GAME_WIDTH, WALL_THICK);
    wallGfx.setDepth(10);

    // 死亡线（虚线效果）
    const lineGfx = this.add.graphics();
    lineGfx.lineStyle(1, 0xff6b6b, 0.35);
    const dashLen = 8, gapLen = 6;
    let lx = WALL_THICK;
    while (lx < GAME_WIDTH - WALL_THICK) {
      lineGfx.beginPath();
      lineGfx.moveTo(lx, DEAD_LINE_Y);
      lineGfx.lineTo(Math.min(lx + dashLen, GAME_WIDTH - WALL_THICK), DEAD_LINE_Y);
      lineGfx.strokePath();
      lx += dashLen + gapLen;
    }
    lineGfx.setDepth(10);

    // 顶部背景
    const topBg = this.add.graphics();
    topBg.fillStyle(0x16213e, 1);
    topBg.fillRect(0, 0, GAME_WIDTH, DEAD_LINE_Y);
    topBg.setDepth(9);

    // 关卡显示
    this.levelText = this.add.text(GAME_WIDTH / 2, 8, `第 ${this.level} 关`, {
      fontSize: '14px', fontFamily: 'Arial, sans-serif', color: '#aaaaaa',
    }).setOrigin(0.5, 0).setDepth(20);

    // 分数
    this.scoreText = this.add.text(GAME_WIDTH / 2, 24, '0', {
      fontSize: '28px', fontFamily: 'Arial, sans-serif', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 0).setDepth(20);

    // 目标分数
    this.levelTarget = getLevelTarget(this.level);
    this.targetText = this.add.text(GAME_WIDTH / 2, 54, `目标 ${this.levelTarget}`, {
      fontSize: '11px', fontFamily: 'Arial, sans-serif', color: '#888888',
    }).setOrigin(0.5, 0).setDepth(20);

    // 最高纪录
    this.highLevel = getHighLevel();
    this.highScore = getHighScore();
    this.highScoreText = this.add.text(30, 16, this.highLevel > 0 ? `最高 第${this.highLevel}关` : '', {
      fontSize: '12px', fontFamily: 'Arial, sans-serif', color: '#666666',
    }).setOrigin(0, 0).setDepth(20);

    // 设置当前关卡重力
    this.matter.world.engine.gravity.y = getLevelGravity(this.level);

    // "下一个"
    this.nextLabel = this.add.text(GAME_WIDTH - 50, 18, '下一个', {
      fontSize: '11px', fontFamily: 'Arial, sans-serif', color: '#888888',
    }).setOrigin(0.5, 0).setDepth(20);

    this.nextFruitIndex = this.randomDropIndex();
    this.nextPreviewSprite = null;
    this.drawNextPreview();

    // 预览
    this.previewX = GAME_WIDTH / 2;
    this.currentFruitIndex = this.randomDropIndex();
    this.previewSprite = null;
    this.drawPreview();

    // 指示线
    this.guideGfx = this.add.graphics().setDepth(5);

    // 合成进度条（显示已合成最大水果）
    this.drawProgressBar();

    // 输入
    this.input.on('pointermove', (pointer) => {
      if (this.isGameOver) return;
      const fruit = FRUITS[this.currentFruitIndex];
      const minX = WALL_THICK + fruit.radius + 2;
      const maxX = GAME_WIDTH - WALL_THICK - fruit.radius - 2;
      this.previewX = Phaser.Math.Clamp(pointer.x, minX, maxX);
      this.drawPreview();
      this.drawGuide();
    });

    this.input.on('pointerup', () => {
      if (this.isGameOver || !this.canDrop) return;
      sfx.ensure();
      this.dropFruit();
    });

    this.matter.world.on('collisionstart', (event) => {
      for (const pair of event.pairs) {
        this.handleCollision(pair.bodyA, pair.bodyB);
      }
    });

    this.time.addEvent({ delay: 1000, callback: this.checkGameOver, callbackScope: this, loop: true });
  }

  randomDropIndex() {
    return Phaser.Math.Between(0, DROP_MAX_INDEX);
  }

  drawPreview() {
    if (this.previewSprite) this.previewSprite.destroy();
    const key = createPreviewTexture(this, this.currentFruitIndex);
    this.previewSprite = this.add.image(this.previewX, DROP_Y, key).setDepth(15);
  }

  drawGuide() {
    this.guideGfx.clear();
    this.guideGfx.lineStyle(1, 0xffffff, 0.1);
    this.guideGfx.beginPath();
    this.guideGfx.moveTo(this.previewX, DROP_Y + FRUITS[this.currentFruitIndex].radius);
    this.guideGfx.lineTo(this.previewX, GAME_HEIGHT - WALL_THICK);
    this.guideGfx.strokePath();
  }

  drawNextPreview() {
    if (this.nextPreviewSprite) this.nextPreviewSprite.destroy();
    const fruit = FRUITS[this.nextFruitIndex];
    const cx = GAME_WIDTH - 50;
    const cy = 55;
    const scale = Math.min(28 / (fruit.radius * 2), 1);
    const key = createFruitTexture(this, this.nextFruitIndex);
    this.nextPreviewSprite = this.add.image(cx, cy, key).setScale(scale).setDepth(20);
  }

  drawProgressBar() {
    if (this.progressContainer) this.progressContainer.destroy();
    this.progressContainer = this.add.container(0, DEAD_LINE_Y - 18).setDepth(11);
    const barW = GAME_WIDTH - WALL_THICK * 2 - 20;
    const startX = WALL_THICK + 10;
    const barH = 6;

    // 背景
    const bg = this.add.graphics();
    bg.fillStyle(0x333333, 0.4);
    bg.fillRoundedRect(startX, 0, barW, barH, 3);
    this.progressContainer.add(bg);

    // 进度
    const progress = Math.min(this.levelScore / this.levelTarget, 1);
    if (progress > 0) {
      const fg = this.add.graphics();
      fg.fillStyle(0xf1c40f, 0.8);
      fg.fillRoundedRect(startX, 0, barW * progress, barH, 3);
      this.progressContainer.add(fg);
    }
  }

  dropFruit() {
    this.canDrop = false;
    const idx = this.currentFruitIndex;
    const fruit = FRUITS[idx];

    sfx.drop();

    const body = this.matter.add.circle(this.previewX, DROP_Y, fruit.radius, {
      restitution: 0.2,
      friction: 0.5,
      density: 0.001 + idx * 0.0005,
      label: 'fruit',
    });
    body.fruitIndex = idx;
    body.dropTime = this.time.now;

    const key = createFruitTexture(this, idx);
    const sprite = this.add.image(0, 0, key);

    // 入场缩放动画
    sprite.setScale(0.3);
    this.tweens.add({ targets: sprite, scaleX: 1, scaleY: 1, duration: 150, ease: 'Back.easeOut' });

    this.fruitBodies.set(body.id, { body, sprite, index: idx });

    this.currentFruitIndex = this.nextFruitIndex;
    this.nextFruitIndex = this.randomDropIndex();
    this.drawNextPreview();

    this.time.delayedCall(500, () => {
      this.canDrop = true;
      this.drawPreview();
      this.drawGuide();
    });

    if (this.previewSprite) { this.previewSprite.destroy(); this.previewSprite = null; }
    this.guideGfx.clear();
  }

  handleCollision(bodyA, bodyB) {
    if (bodyA.label !== 'fruit' || bodyB.label !== 'fruit') return;
    if (bodyA.fruitIndex === undefined || bodyB.fruitIndex === undefined) return;
    if (bodyA.fruitIndex !== bodyB.fruitIndex) return;
    if (this.merging.has(bodyA.id) || this.merging.has(bodyB.id)) return;

    const idx = bodyA.fruitIndex;
    if (idx >= FRUITS.length - 1) return;

    this.merging.add(bodyA.id);
    this.merging.add(bodyB.id);

    const newIdx = idx + 1;
    const newFruit = FRUITS[newIdx];
    const midX = (bodyA.position.x + bodyB.position.x) / 2;
    const midY = (bodyA.position.y + bodyB.position.y) / 2;

    const dataA = this.fruitBodies.get(bodyA.id);
    const dataB = this.fruitBodies.get(bodyB.id);
    if (dataA) dataA.sprite.destroy();
    if (dataB) dataB.sprite.destroy();
    this.fruitBodies.delete(bodyA.id);
    this.fruitBodies.delete(bodyB.id);
    this.matter.world.remove(bodyA);
    this.matter.world.remove(bodyB);
    this.merging.delete(bodyA.id);
    this.merging.delete(bodyB.id);

    const newBody = this.matter.add.circle(midX, midY, newFruit.radius, {
      restitution: 0.2,
      friction: 0.5,
      density: 0.001 + newIdx * 0.0005,
      label: 'fruit',
    });
    newBody.fruitIndex = newIdx;
    newBody.dropTime = 0; // 合成的水果不享受缓冲期

    const key = createFruitTexture(this, newIdx);
    const sprite = this.add.image(midX, midY, key);

    // 合成弹跳动画
    sprite.setScale(0.1);
    this.tweens.add({ targets: sprite, scaleX: 1, scaleY: 1, duration: 250, ease: 'Back.easeOut' });

    this.fruitBodies.set(newBody.id, { body: newBody, sprite, index: newIdx });

    sfx.merge(newIdx);
    this.mergeEffect(midX, midY, newFruit);
    this.floatingScore(midX, midY, newFruit.score);

    this.levelScore += newFruit.score;
    this.totalScore += newFruit.score;
    this.scoreText.setText(this.levelScore.toString());
    this.drawProgressBar();

    if (this.levelScore >= this.levelTarget && !this.isLevelClearing) {
      this.levelComplete();
    }
  }

  mergeEffect(x, y, fruit) {
    const count = 10;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const dist = fruit.radius * 0.6 + Math.random() * 15;
      const size = 2 + Math.random() * 4;
      const dot = this.add.graphics();
      dot.fillStyle(fruit.color, 0.8);
      dot.fillCircle(0, 0, size);
      dot.setPosition(x, y);
      this.tweens.add({
        targets: dot,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist,
        alpha: 0,
        scaleX: 0.2,
        scaleY: 0.2,
        duration: 300 + Math.random() * 150,
        onComplete: () => dot.destroy(),
      });
    }

    // 白色闪光环
    const ring = this.add.graphics();
    ring.lineStyle(2, 0xffffff, 0.5);
    ring.strokeCircle(0, 0, fruit.radius * 0.5);
    ring.setPosition(x, y);
    this.tweens.add({
      targets: ring,
      scaleX: 2,
      scaleY: 2,
      alpha: 0,
      duration: 250,
      onComplete: () => ring.destroy(),
    });
  }

  floatingScore(x, y, score) {
    const txt = this.add.text(x, y, `+${score}`, {
      fontSize: '18px', fontFamily: 'Arial, sans-serif', color: '#ffffff',
      fontStyle: 'bold', stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(30);

    this.tweens.add({
      targets: txt,
      y: y - 50,
      alpha: 0,
      duration: 600,
      ease: 'Power2',
      onComplete: () => txt.destroy(),
    });
  }

  levelComplete() {
    this.isLevelClearing = true;
    this.canDrop = false;
    if (this.previewSprite) { this.previewSprite.destroy(); this.previewSprite = null; }
    this.guideGfx.clear();

    sfx.levelUp();

    // 保存最高关卡
    if (this.level > this.highLevel) {
      this.highLevel = this.level;
      setHighLevel(this.level);
    }
    if (this.totalScore > this.highScore) {
      this.highScore = this.totalScore;
      setHighScore(this.totalScore);
    }

    // 过关提示
    const overlay = this.add.graphics().setDepth(50);
    overlay.fillStyle(0x000000, 0.5);
    overlay.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const container = this.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2).setDepth(51);

    const cardW = 260, cardH = 180;
    const card = this.add.graphics();
    card.fillStyle(0x1e2a3a, 1);
    card.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 16);
    card.lineStyle(1, 0xf1c40f, 0.5);
    card.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 16);
    container.add(card);

    container.add(this.add.text(0, -cardH / 2 + 28, `第 ${this.level} 关 通过！`, {
      fontSize: '26px', fontFamily: 'Arial, sans-serif', color: '#f1c40f', fontStyle: 'bold',
    }).setOrigin(0.5));

    container.add(this.add.text(0, -10, `得分 ${this.levelScore}`, {
      fontSize: '16px', fontFamily: 'Arial, sans-serif', color: '#ffffff',
    }).setOrigin(0.5));

    const nextLevel = this.level + 1;
    const nextTarget = getLevelTarget(nextLevel);
    container.add(this.add.text(0, 15, `下一关目标：${nextTarget}`, {
      fontSize: '13px', fontFamily: 'Arial, sans-serif', color: '#888888',
    }).setOrigin(0.5));

    // 下一关按钮
    const btnY = 50;
    const nextBtn = this.add.graphics();
    nextBtn.fillStyle(0xf1c40f, 1);
    nextBtn.fillRoundedRect(-60, btnY - 18, 120, 36, 8);
    container.add(nextBtn);
    container.add(this.add.text(0, btnY, '下一关', {
      fontSize: '16px', fontFamily: 'Arial, sans-serif', color: '#1a1a2e', fontStyle: 'bold',
    }).setOrigin(0.5));

    container.setScale(0.5);
    container.setAlpha(0);
    this.tweens.add({ targets: container, scaleX: 1, scaleY: 1, alpha: 1, duration: 300, ease: 'Back.easeOut' });

    this.input.once('pointerup', () => {
      this.level = nextLevel;
      this.levelScore = 0;
      this.isLevelClearing = false;
      this.isGameOver = false;

      // 清除所有水果
      for (const [id, data] of this.fruitBodies) {
        data.sprite.destroy();
        this.matter.world.remove(data.body);
      }
      this.fruitBodies.clear();
      this.merging.clear();

      // 更新UI
      overlay.destroy();
      container.destroy();

      this.levelTarget = getLevelTarget(this.level);
      this.levelText.setText(`第 ${this.level} 关`);
      this.scoreText.setText('0');
      this.targetText.setText(`目标 ${this.levelTarget}`);
      this.highScoreText.setText(`最高 第${this.highLevel}关`);
      this.drawProgressBar();

      // 更新重力
      this.matter.world.engine.gravity.y = getLevelGravity(this.level);

      // 重新开始
      this.canDrop = true;
      this.currentFruitIndex = this.randomDropIndex();
      this.nextFruitIndex = this.randomDropIndex();
      this.drawNextPreview();
      this.drawPreview();
      this.drawGuide();
    });
  }

  checkGameOver() {
    if (this.isGameOver || this.isLevelClearing) return;
    for (const [id, data] of this.fruitBodies) {
      const body = data.body;
      if (this.time.now - body.dropTime < 2000) continue;
      if (body.position.y - FRUITS[data.index].radius < DEAD_LINE_Y) {
        this.gameOver();
        return;
      }
    }
  }

  gameOver() {
    if (this.isLevelClearing) return;
    this.isGameOver = true;
    this.canDrop = false;
    if (this.previewSprite) { this.previewSprite.destroy(); this.previewSprite = null; }
    this.guideGfx.clear();

    sfx.gameOver();

    if (this.totalScore > this.highScore) {
      this.highScore = this.totalScore;
      setHighScore(this.totalScore);
    }
    if (this.level > this.highLevel) {
      this.highLevel = this.level;
      setHighLevel(this.level);
    }
    const isNewLevel = this.level >= this.highLevel;

    // 遮罩
    const overlay = this.add.graphics().setDepth(50);
    overlay.fillStyle(0x000000, 0.65);
    overlay.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

    const container = this.add.container(GAME_WIDTH / 2, GAME_HEIGHT / 2).setDepth(51);

    // 结果卡片背景
    const cardW = 280, cardH = 290;
    const card = this.add.graphics();
    card.fillStyle(0x1e2a3a, 1);
    card.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 16);
    card.lineStyle(1, 0x3d5a80, 0.5);
    card.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 16);
    container.add(card);

    container.add(this.add.text(0, -cardH / 2 + 28, '游戏结束', {
      fontSize: '28px', fontFamily: 'Arial, sans-serif', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5));

    container.add(this.add.text(0, -50, `闯到第 ${this.level} 关`, {
      fontSize: '20px', fontFamily: 'Arial, sans-serif', color: '#f1c40f', fontStyle: 'bold',
    }).setOrigin(0.5));

    container.add(this.add.text(0, -20, `总分 ${this.totalScore}`, {
      fontSize: '16px', fontFamily: 'Arial, sans-serif', color: '#ffffff',
    }).setOrigin(0.5));

    container.add(this.add.text(0, 10, isNewLevel ? '新纪录！' : `最高 第${this.highLevel}关`, {
      fontSize: '14px', fontFamily: 'Arial, sans-serif', color: isNewLevel ? '#e74c3c' : '#888888',
    }).setOrigin(0.5));

    // 按钮：重新开始
    const btnY = 70;
    const restartBtn = this.add.graphics();
    restartBtn.fillStyle(0x3d5a80, 1);
    restartBtn.fillRoundedRect(-100, btnY - 18, 95, 36, 8);
    container.add(restartBtn);
    container.add(this.add.text(-52, btnY, '再来一局', {
      fontSize: '15px', fontFamily: 'Arial, sans-serif', color: '#ffffff',
    }).setOrigin(0.5));

    // 按钮：分享截图
    const shareBtn = this.add.graphics();
    shareBtn.fillStyle(0xe74c3c, 1);
    shareBtn.fillRoundedRect(5, btnY - 18, 95, 36, 8);
    container.add(shareBtn);
    container.add(this.add.text(52, btnY, '保存截图', {
      fontSize: '15px', fontFamily: 'Arial, sans-serif', color: '#ffffff',
    }).setOrigin(0.5));

    // 入场动画
    container.setScale(0.5);
    container.setAlpha(0);
    this.tweens.add({ targets: container, scaleX: 1, scaleY: 1, alpha: 1, duration: 300, ease: 'Back.easeOut' });

    this.input.on('pointerup', (pointer) => {
      const localX = pointer.x - GAME_WIDTH / 2;
      const localY = pointer.y - GAME_HEIGHT / 2;

      // 再来一局
      if (localX >= -100 && localX <= -5 && localY >= btnY - 18 && localY <= btnY + 18) {
        this.score = 0;
        this.level = 1;
        this.levelScore = 0;
        this.totalScore = 0;
        this.isGameOver = false;
        this.isLevelClearing = false;
        this.fruitBodies.clear();
        this.merging.clear();
        this.scene.restart();
        return;
      }

      // 保存截图
      if (localX >= 5 && localX <= 100 && localY >= btnY - 18 && localY <= btnY + 18) {
        this.shareScreenshot();
        return;
      }
    });
  }

  shareScreenshot() {
    const renderer = this.game.renderer;
    if (renderer.type === Phaser.CANVAS) {
      this.downloadCanvas(renderer.gameCanvas);
    } else {
      renderer.snapshot((image) => {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        // 底部加水印
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, canvas.height - 36, canvas.width, 36);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(`合成大果果 · 第${this.level}关 · 总分${this.totalScore}`, canvas.width / 2, canvas.height - 14);
        this.downloadCanvas(canvas);
      });
    }
  }

  downloadCanvas(canvas) {
    const link = document.createElement('a');
    link.download = `合成大果果_第${this.level}关_${this.totalScore}分.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  }

  update() {
    for (const [id, data] of this.fruitBodies) {
      data.sprite.setPosition(data.body.position.x, data.body.position.y);
    }
  }
}

const config = {
  type: Phaser.AUTO,
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  parent: 'game-container',
  backgroundColor: '#1a1a2e',
  physics: {
    default: 'matter',
    matter: {
      gravity: { y: 1.5 },
      debug: false,
    },
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: GameScene,
};

new Phaser.Game(config);
