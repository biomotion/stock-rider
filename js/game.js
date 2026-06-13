// 機車物理 + 繪製（世界座標 y 向上，繪製時轉成螢幕座標）
import { DX } from './terrain.js';

const GRAVITY = -1900;
const WHEEL_R = 12;
const WHEEL_BASE = 46;       // 前後輪距
const WHEEL_DROP = 12;       // 輪軸相對車身中心的下沉量
const SPRING_K = 9000;
const SPRING_C = 140;
const DRIVE_F = 2600;
const BRAKE_F = 3200;
const MAX_SPEED = 980;
const LEAN_T = 21000;        // 傾斜力矩（空中翻轉、地面翹孤輪/點頭）
const INERTIA = 760;
const JUMP_V = 560;
const HEAD_LOCAL = { x: 4, y: 30 }; // 頭部位置（碰到地形即墜車）

// 角度穩定（移植自 StonkRider 的調校，讓控制不靈敏、不易亂翻）
const W_MAX = 5.8;           // 角速度硬上限（rad/s）— 防翻車的關鍵
const AUTO_LEVEL = 0.18;     // 著地時往地形坡度回正的增益
const GROUND_ADAMP = 0.10;   // 著地角速度阻尼
const AIR_ADAMP = 0.965;     // 空中角速度阻尼（每 1/60 秒）
const AIR_ASSIST = 0.9;      // 空中沒按鍵時微微對齊落點

// 氮氣
const NITRO_MAX = 1;         // 滿格
const NITRO_DRAIN = 0.42;    // 每秒耗用（約 2.4 秒用完）
const NITRO_REGEN = 0.18;    // 每秒回充
const NITRO_FORCE = 1500;    // 沿車身方向推力
const NITRO_COOLDOWN = 0.5;  // 用罄後的冷卻（秒）

const TAU = Math.PI * 2;

export class Game {
  constructor(canvas, terrain, meta, callbacks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.terrain = terrain;
    this.meta = meta; // {stockId, stockName, startPrice, capital}
    this.cb = callbacks; // {onHud, onEnd}

    this.input = { gas: false, brake: false, leanL: false, leanR: false, jump: false, nitro: false };
    this.state = 'riding'; // riding | crashed | finished
    this.particles = [];
    this.popups = [];      // 特技浮動文字
    this.elapsed = 0;
    this.maxX = terrain.spawnX;

    // 分數 / 特技狀態
    this.score = 0;
    this.combo = 1;        // 連段倍率 1..5
    this.flips = 0;        // 累計圈數
    this.nitro = NITRO_MAX;
    this.nitroCooldown = 0;
    this.airTime = 0;      // 本次騰空時間
    this.airRot = 0;       // 本次騰空累積旋轉（弧度，帶正負）
    this.wasGrounded = true;

    // 機車剛體
    const x = terrain.spawnX;
    this.bike = {
      x, y: terrain.heightAt(x) + WHEEL_R + WHEEL_DROP + 1,
      vx: 0, vy: 0,
      a: 0, w: 0,            // 角度（逆時針為正）、角速度
      wheelSpin: 0,
      grounded: false,
      jumpCooldown: 0,
    };

    this.cam = { x, y: this.bike.y, zoom: 1 };
    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
    this.resize();

    this.last = performance.now();
    this.raf = requestAnimationFrame(t => this.loop(t));
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this._resize);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = innerWidth * dpr;
    this.canvas.height = innerHeight * dpr;
    this.canvas.style.width = innerWidth + 'px';
    this.canvas.style.height = innerHeight + 'px';
    this.W = innerWidth;
    this.Hpx = innerHeight;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  loop(t) {
    this.raf = requestAnimationFrame(tt => this.loop(tt));
    let dt = Math.min((t - this.last) / 1000, 0.05);
    this.last = t;

    if (this.state === 'riding') {
      const sub = 10;
      for (let i = 0; i < sub; i++) this.step(dt / sub);
      this.elapsed += dt;
      this.updateHud();
    }
    this.updateCamera(dt);
    this.render();
  }

  // ── 物理 ──
  step(dt) {
    const b = this.bike, T = this.terrain, inp = this.input;
    const cos = Math.cos(b.a), sin = Math.sin(b.a);

    let fx = 0, fy = GRAVITY; // 質量 = 1
    let torque = 0;
    b.grounded = false;
    b.jumpCooldown = Math.max(0, b.jumpCooldown - dt);

    const wheels = [
      { lx: -WHEEL_BASE / 2, ly: -WHEEL_DROP, rear: true },
      { lx: WHEEL_BASE / 2, ly: -WHEEL_DROP, rear: false },
    ];

    for (const wl of wheels) {
      const wx = b.x + wl.lx * cos - wl.ly * sin;
      const wy = b.y + wl.lx * sin + wl.ly * cos;
      const gy = T.heightAt(wx);
      const n = T.normalAt(wx);
      // 輪心到地面的有號距離（沿法線）
      const dist = (wy - gy) * n.y - WHEEL_R;
      if (dist < 0) {
        b.grounded = true;
        const pen = -dist;
        // 接觸點速度
        const rx = wx - b.x, ry = wy - b.y;
        const pvx = b.vx - b.w * ry;
        const pvy = b.vy + b.w * rx;
        const vn = pvx * n.x + pvy * n.y;

        // 彈簧 + 阻尼（法線方向）
        let fn = SPRING_K * pen - SPRING_C * vn;
        if (fn < 0) fn = 0;
        const Fnx = n.x * fn, Fny = n.y * fn;

        // 切線方向（朝 +x）
        const tx = n.y, ty = -n.x;
        const vt = pvx * tx + pvy * ty;

        let ft = 0;
        if (wl.rear && inp.gas && vt < MAX_SPEED) ft += DRIVE_F;
        if (inp.brake) ft += -Math.sign(vt) * Math.min(BRAKE_F, Math.abs(vt) * 18 + 200);
        if (!inp.gas && !inp.brake) ft += -vt * 0.35; // 滾動阻力
        const Ftx = tx * ft, Fty = ty * ft;

        fx += Fnx + Ftx; fy += Fny + Fty;
        torque += rx * Fny - ry * Fnx;
        // 驅動／煞車的翻轉力矩只取 30%，避免一煞車就前滾翻
        torque += (rx * Fty - ry * Ftx) * 0.3;
      }
    }

    // 傾斜：玩家施加力矩決定翻轉方向（←後仰/翹孤輪、→前傾/點頭）
    if (inp.leanL) torque += LEAN_T;
    if (inp.leanR) torque -= LEAN_T;

    // 跳躍：沿地形法線方向施加衝量
    if (inp.jump && b.grounded && b.jumpCooldown <= 0) {
      const n = T.normalAt(b.x);
      b.vx += n.x * JUMP_V * 0.5;
      b.vy += n.y * JUMP_V;
      b.jumpCooldown = 0.45;
    }

    // 氮氣：沿車身朝向推進，有限燃料 + 冷卻
    this.nitroCooldown = Math.max(0, this.nitroCooldown - dt);
    let firing = false;
    if (inp.nitro && this.nitro > 0 && this.nitroCooldown <= 0) {
      firing = true;
      this.nitro = Math.max(0, this.nitro - NITRO_DRAIN * dt);
      fx += Math.cos(b.a) * NITRO_FORCE;
      fy += Math.sin(b.a) * NITRO_FORCE;
      if (this.nitro <= 0) this.nitroCooldown = NITRO_COOLDOWN;
    } else if (!inp.nitro || this.nitro <= 0) {
      this.nitro = Math.min(NITRO_MAX, this.nitro + NITRO_REGEN * dt);
    }
    this.firing = firing;

    // 空氣阻力
    fx += -b.vx * 0.06;
    fy += -b.vy * 0.02;

    // 線速度積分
    b.vx += fx * dt;
    b.vy += fy * dt;

    // 角速度積分 + 穩定（移植自參考站：硬上限 + 著地自動回正 + 空中阻尼）
    b.w += (torque / INERTIA) * dt;
    const k = dt * 60; // 換算成「每 1/60 秒」的等效係數
    if (b.grounded) {
      const n2 = T.normalAt(b.x);
      const slope = Math.atan2(-n2.x, n2.y);
      let err = Math.atan2(Math.sin(slope - b.a), Math.cos(slope - b.a));
      b.w += (err * AUTO_LEVEL - b.w * GROUND_ADAMP) * k;
    } else {
      b.w *= Math.pow(AIR_ADAMP, k);
      if (!inp.leanL && !inp.leanR && b.vy < 0) {
        const ahead = b.x + Math.max(40, b.vx * 0.35);
        const n2 = T.normalAt(ahead);
        const slope = Math.atan2(-n2.x, n2.y);
        let err = Math.atan2(Math.sin(slope - b.a), Math.cos(slope - b.a));
        b.w += err * AIR_ASSIST * k;
      }
    }
    b.w = Math.max(-W_MAX, Math.min(W_MAX, b.w));

    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.a += b.w * dt;

    // 特技：累積騰空時間與旋轉量；落地時結算
    if (!b.grounded) {
      this.airTime += dt;
      this.airRot += b.w * dt;
    } else if (!this.wasGrounded) {
      this.onLanding();
    }
    this.wasGrounded = b.grounded;

    b.wheelSpin += (b.vx / WHEEL_R) * dt;
    this.maxX = Math.max(this.maxX, b.x);

    // 防止穿出地形左界
    if (b.x < 20) { b.x = 20; b.vx = Math.max(0, b.vx); }

    // 車身中心陷入地面太深 → 直接視為墜車（極端情況保險）
    const headX = b.x + HEAD_LOCAL.x * cos - HEAD_LOCAL.y * sin;
    const headY = b.y + HEAD_LOCAL.x * sin + HEAD_LOCAL.y * cos;
    if (headY < T.heightAt(headX) - 6 || b.y < T.heightAt(b.x) - WHEEL_R) {
      this.end('crashed');
      return;
    }

    if (b.x >= T.finishX) {
      this.end('finished');
      return;
    }

    // 落地揚塵
    if (b.grounded && (Math.abs(b.vx) > 120 || inp.gas) && Math.random() < 0.5) {
      const gx = b.x - 20 * cos;
      this.particles.push({
        x: gx, y: T.heightAt(gx) + 4,
        vx: -b.vx * 0.15 + (Math.random() - 0.5) * 40,
        vy: 60 + Math.random() * 80,
        life: 0.5 + Math.random() * 0.3, t: 0,
      });
    }
  }

  // 落地結算特技
  onLanding() {
    const b = this.bike, T = this.terrain;
    const air = this.airTime, rot = this.airRot;
    this.airTime = 0; this.airRot = 0;
    if (air < 0.25) return; // 太短不算騰空

    const n = T.normalAt(b.x);
    const slope = Math.atan2(-n.x, n.y);
    const err = Math.abs(Math.atan2(Math.sin(slope - b.a), Math.cos(slope - b.a)));
    if (err > 1.2) return; // 落地歪太多 → 交給墜車判定，不給分

    // 接近一圈（差 20° 內）就算完成，補償傾斜加速所損耗的轉角
    const flips = Math.floor((Math.abs(rot) + 0.35) / TAU);
    if (flips > 0) {
      const pts = flips * 500 * this.combo;
      this.score += pts;
      this.flips += flips;
      const kind = rot > 0 ? '後空翻' : '前空翻';
      const pre = flips === 1 ? '' : flips === 2 ? 'Double ' : flips === 3 ? 'Triple ' : `${flips}x `;
      this.popup(`${pre}${kind}! +${pts}`, '#FFD700', 1.4);
      this.combo = Math.min(5, this.combo + 1);
      if (this.combo > 1) this.popup(`連段 x${this.combo}`, '#FF8A3D', 0.9);
    } else if (air > 1.4) {
      const pts = Math.round(120 * this.combo);
      this.score += pts;
      this.popup(`大跳躍! +${pts}`, '#00BFFF', 1.2);
      this.combo = Math.min(5, this.combo + 1);
    }
  }

  popup(text, color, dur = 1.2) {
    this.popups.push({ x: this.bike.x, y: this.bike.y + 50, text, color, t: 0, dur });
  }

  end(reason) {
    if (this.state !== 'riding') return;
    if (reason === 'crashed') {
      this.score = Math.max(0, this.score - 500); // 撞車罰分、連段歸零
      this.combo = 1;
    }
    this.state = reason;
    const stats = this.currentStats();
    this.cb.onEnd(reason, stats);
  }

  currentStats() {
    const T = this.terrain, m = this.meta;
    const price = T.priceAt(Math.min(this.maxX, T.finishX));
    const value = m.capital * (price / m.startPrice);
    const ret = (price / m.startPrice - 1) * 100;
    const f = T.dayAt(this.bike.x);
    const day = T.days[Math.round(f)];
    const progress = Math.max(0, Math.min(
      (this.maxX - T.startX) / (T.startX + (T.days.length - 1) * DX - T.startX), 1));
    return {
      price, value, ret, date: day.date, progress, elapsed: this.elapsed,
      score: this.score, combo: this.combo, flips: this.flips,
      nitro: this.nitro, firing: this.firing,
    };
  }

  updateHud() {
    this.cb.onHud(this.currentStats());
  }

  updateCamera(dt) {
    const b = this.bike;
    const speed = Math.hypot(b.vx, b.vy);
    const targetZoom = Math.max(0.62, Math.min(1, 1 - (speed - 300) / 2200));
    this.cam.zoom += (targetZoom - this.cam.zoom) * Math.min(1, dt * 2);
    const tx = b.x + Math.min(160, this.W * 0.16);
    const ty = b.y + 40;
    this.cam.x += (tx - this.cam.x) * Math.min(1, dt * 5);
    this.cam.y += (ty - this.cam.y) * Math.min(1, dt * 3.2);
  }

  // ── 繪製 ──
  sx(wx) { return (wx - this.cam.x) * this.cam.zoom + this.W * 0.40; }
  sy(wy) { return this.Hpx * 0.58 - (wy - this.cam.y) * this.cam.zoom; }

  render() {
    const ctx = this.ctx, W = this.W, H = this.Hpx, T = this.terrain, z = this.cam.zoom;

    // 背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0e1526');
    bg.addColorStop(1, '#0a0e18');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const xL = this.cam.x - this.W * 0.40 / z - 50;
    const xR = this.cam.x + this.W * 0.60 / z + 50;

    this.drawGridAndCandles(xL, xR);
    this.drawTerrain(xL, xR);
    this.drawFinish();
    this.drawParticles();
    this.drawBike();
    this.drawPopups();
  }

  drawPopups() {
    const ctx = this.ctx;
    const dt = 1 / 60;
    this.popups = this.popups.filter(p => (p.t += dt) < p.dur);
    ctx.save();
    ctx.textAlign = 'center';
    for (const p of this.popups) {
      const k = p.t / p.dur;
      const x = this.sx(p.x);
      const y = this.sy(p.y) - k * 46;          // 緩緩上飄
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.font = `800 ${Math.round(20 * this.cam.zoom)}px system-ui`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.strokeText(p.text, x, y);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, y);
    }
    ctx.restore();
  }

  drawGridAndCandles(xL, xR) {
    const ctx = this.ctx, T = this.terrain;
    const n = T.days.length;
    const i0 = Math.max(0, Math.floor((xL - T.startX) / DX) - 1);
    const i1 = Math.min(n - 1, Math.ceil((xR - T.startX) / DX) + 1);

    // 價格以「當日地形高度」為基準換算世界 y，K 棒才會貼著地形
    const priceY = (p, i) =>
      T.dayY(i) + (Math.log(p) - Math.log(T.days[i].close)) * T.logScale;

    ctx.save();
    ctx.lineWidth = 1;

    // 月份分隔線與標籤
    let lastMonth = '';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'left';
    for (let i = i0; i <= i1; i++) {
      const month = T.days[i].date.slice(0, 7);
      if (month !== lastMonth && i > 0) {
        lastMonth = month;
        const x = this.sx(T.startX + i * DX);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, this.Hpx);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillText(month, x + 4, this.Hpx - 12);
      } else if (i === i0) {
        lastMonth = month;
      }
    }

    // 背景 K 棒（淡）
    const wHalf = Math.max(2, DX * 0.28 * this.cam.zoom);
    for (let i = i0; i <= i1; i++) {
      const d = T.days[i];
      if (!(d.open > 0 && d.high > 0 && d.low > 0)) continue;
      const x = this.sx(T.startX + i * DX);
      const up = d.close >= d.open;
      ctx.strokeStyle = up ? 'rgba(255,77,79,0.18)' : 'rgba(45,214,116,0.18)';
      ctx.fillStyle = up ? 'rgba(255,77,79,0.12)' : 'rgba(45,214,116,0.12)';
      // 影線
      ctx.beginPath();
      ctx.moveTo(x, this.sy(priceY(d.high, i)));
      ctx.lineTo(x, this.sy(priceY(d.low, i)));
      ctx.stroke();
      // 實體
      const yo = this.sy(priceY(d.open, i));
      const yc = this.sy(priceY(d.close, i));
      const top = Math.min(yo, yc);
      const h = Math.max(Math.abs(yo - yc), 1);
      ctx.fillRect(x - wHalf, top, wHalf * 2, h);
    }
    ctx.restore();
  }

  drawTerrain(xL, xR) {
    const ctx = this.ctx, T = this.terrain;
    const step = 6 / this.cam.zoom;

    // 地面填色
    ctx.beginPath();
    ctx.moveTo(this.sx(xL), this.Hpx + 40);
    for (let x = xL; x <= xR; x += step) {
      ctx.lineTo(this.sx(x), this.sy(T.heightAt(x)));
    }
    ctx.lineTo(this.sx(xR), this.Hpx + 40);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, this.Hpx);
    g.addColorStop(0, 'rgba(52,66,100,0.97)');
    g.addColorStop(1, 'rgba(22,29,46,0.98)');
    ctx.fillStyle = g;
    ctx.fill();

    // 表面線：依漲跌著色（台股紅漲綠跌）
    ctx.lineWidth = Math.max(2.5, 3.5 * this.cam.zoom);
    ctx.lineCap = 'round';
    const n = T.days.length;
    let prev = null;
    for (let x = xL; x <= xR; x += step) {
      const pt = { x: this.sx(x), y: this.sy(T.heightAt(x)) };
      if (prev) {
        const fi = (x - T.startX) / DX;
        let color = '#5a6b8f'; // 平地（資料範圍外）
        if (fi >= 0 && fi <= n - 1) {
          const i = Math.max(1, Math.min(Math.round(fi), n - 1));
          color = T.days[i].close >= T.days[i - 1].close ? '#ff4d4f' : '#2dd674';
        }
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(prev.x, prev.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      }
      prev = pt;
    }
  }

  drawFinish() {
    const ctx = this.ctx, T = this.terrain;
    const x = this.sx(T.finishX);
    if (x < -60 || x > this.W + 60) return;
    const gy = this.sy(T.heightAt(T.finishX));
    const h = 90 * this.cam.zoom;
    ctx.save();
    ctx.strokeStyle = '#cfd8ea';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x, gy - h); ctx.stroke();
    // 格紋旗
    const fw = 34 * this.cam.zoom, fh = 22 * this.cam.zoom, c = 5;
    for (let r = 0; r < 3; r++) {
      for (let cidx = 0; cidx < c; cidx++) {
        ctx.fillStyle = (r + cidx) % 2 ? '#e8edf6' : '#10151f';
        ctx.fillRect(x + cidx * fw / c, gy - h + r * fh / 3, fw / c, fh / 3);
      }
    }
    ctx.restore();
  }

  drawParticles() {
    const ctx = this.ctx;
    const dt = 1 / 60;
    this.particles = this.particles.filter(p => (p.t += dt) < p.life);
    for (const p of this.particles) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy -= 100 * dt;
      const k = 1 - p.t / p.life;
      ctx.fillStyle = `rgba(160,150,130,${0.35 * k})`;
      ctx.beginPath();
      ctx.arc(this.sx(p.x), this.sy(p.y), (3 + 5 * (1 - k)) * this.cam.zoom, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawBike() {
    const ctx = this.ctx, b = this.bike, z = this.cam.zoom;
    ctx.save();
    ctx.translate(this.sx(b.x), this.sy(b.y));
    ctx.scale(z, z);
    ctx.rotate(-b.a); // 世界逆時針 → 螢幕順時針

    const wheelY = WHEEL_DROP;

    // 氮氣火焰（車尾後方）
    if (this.firing) {
      const fl = (26 + Math.random() * 18);
      ctx.save();
      ctx.translate(-WHEEL_BASE / 2 - 4, wheelY - 4);
      const grad = ctx.createLinearGradient(0, 0, -fl, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.4, 'rgba(255,176,46,0.9)');
      grad.addColorStop(1, 'rgba(255,77,79,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(-fl, 0);
      ctx.lineTo(0, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 輪子
    for (const wx of [-WHEEL_BASE / 2, WHEEL_BASE / 2]) {
      ctx.beginPath();
      ctx.arc(wx, wheelY, WHEEL_R, 0, Math.PI * 2);
      ctx.fillStyle = '#1b2233';
      ctx.fill();
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#3a4763';
      ctx.stroke();
      // 輻條（顯示轉動）
      ctx.save();
      ctx.translate(wx, wheelY);
      ctx.rotate(-b.wheelSpin);
      ctx.strokeStyle = '#566687';
      ctx.lineWidth = 1.5;
      for (let k = 0; k < 3; k++) {
        ctx.rotate(Math.PI / 3);
        ctx.beginPath();
        ctx.moveTo(-WHEEL_R + 3, 0); ctx.lineTo(WHEEL_R - 3, 0);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 車架
    ctx.strokeStyle = '#ffb02e';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-WHEEL_BASE / 2, wheelY);
    ctx.lineTo(-8, -4);
    ctx.lineTo(10, -4);
    ctx.lineTo(WHEEL_BASE / 2, wheelY);
    ctx.moveTo(10, -4);
    ctx.lineTo(17, -14); // 龍頭
    ctx.stroke();

    // 騎士
    ctx.strokeStyle = '#e8edf6';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(-6, -4);          // 臀
    ctx.lineTo(-2, -20);         // 背
    ctx.moveTo(-2, -20);
    ctx.lineTo(14, -12);         // 手 → 龍頭
    ctx.moveTo(-6, -4);
    ctx.lineTo(2, 2);            // 腿
    ctx.lineTo(-2, 8);
    ctx.stroke();
    // 安全帽
    ctx.beginPath();
    ctx.arc(0, -26, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#ff4d4f';
    ctx.fill();
    ctx.fillStyle = '#cfe3ff';
    ctx.fillRect(1, -29, 6, 5); // 面罩

    ctx.restore();
  }
}
