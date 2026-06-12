// 把日 K 收盤價轉成可騎乘的地形（世界座標 y 向上）
export const DX = 48;        // 每個交易日的水平距離
export const SAMPLE = 4;     // 地形取樣間距
const PAD_DAYS = 8;          // 起點前的平地（以日為單位）
const END_DAYS = 6;          // 終點後的平地

export function buildTerrain(days) {
  const n = days.length;

  // 用對數價格正規化，長區間的漲跌幅才不會失真。
  // 台股漲跌幅限制 ±10%，超過的缺口是除權息／分割造成的，夾限避免出現垂直牆。
  const MAX_DAY_LOG = Math.log(1.10);
  const logs = [Math.log(days[0].close)];
  for (let i = 1; i < days.length; i++) {
    const d = Math.log(days[i].close) - Math.log(days[i - 1].close);
    logs.push(logs[i - 1] + Math.max(-MAX_DAY_LOG, Math.min(MAX_DAY_LOG, d)));
  }
  const min = Math.min(...logs), max = Math.max(...logs);
  const span = Math.max(max - min, 1e-6);
  const norm = logs.map(v => (v - min) / span); // 0..1

  // 依波動度決定總高度：讓第 90 百分位的單日落差 ≈ 0.85*DX（約 40 度坡）
  const dys = [];
  for (let i = 1; i < n; i++) dys.push(Math.abs(norm[i] - norm[i - 1]));
  dys.sort((a, b) => a - b);
  const p90 = dys.length ? dys[Math.floor(dys.length * 0.9)] : 0;
  let H = p90 > 1e-9 ? (0.5 * DX) / p90 : 600;
  H = Math.max(300, Math.min(H, 1500));

  // 各交易日的控制點（含前後平地）
  const pts = [];
  const baseY = 200; // 地形最低點離世界 y=0 的距離
  for (let i = 0; i < PAD_DAYS; i++) pts.push(baseY + norm[0] * H);
  for (let i = 0; i < n; i++) pts.push(baseY + norm[i] * H);
  for (let i = 0; i < END_DAYS; i++) pts.push(baseY + norm[n - 1] * H);

  // Catmull-Rom 平滑取樣
  const totalX = (pts.length - 1) * DX;
  const count = Math.floor(totalX / SAMPLE) + 1;
  const heights = new Float32Array(count);
  for (let s = 0; s < count; s++) {
    const x = s * SAMPLE;
    const f = Math.min(x / DX, pts.length - 1.0001);
    const i = Math.floor(f);
    const t = f - i;
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[Math.min(i + 1, pts.length - 1)];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    heights[s] = catmullRom(p0, p1, p2, p3, t);
  }

  const startX = PAD_DAYS * DX;            // 第 0 個交易日的 x
  const finishX = (PAD_DAYS + n - 1 + END_DAYS * 0.7) * DX;

  return {
    days, heights, H,
    startX, finishX,
    totalX,
    spawnX: startX - PAD_DAYS * DX * 0.6,
    logScale: H / span, // 世界高度 / 對數價格，K 棒繪製用
    dayY(i) { return pts[PAD_DAYS + i]; },

    heightAt(x) {
      const f = Math.max(0, Math.min(x / SAMPLE, count - 1.0001));
      const i = Math.floor(f);
      const t = f - i;
      return heights[i] * (1 - t) + heights[i + 1] * t;
    },

    // 地形法線（指向上方）
    normalAt(x) {
      const e = 3;
      const slope = (this.heightAt(x + e) - this.heightAt(x - e)) / (2 * e);
      const len = Math.hypot(1, slope);
      return { x: -slope / len, y: 1 / len };
    },

    // x 對應到第幾個交易日（可為小數，方便插值），超出範圍時夾住
    dayAt(x) {
      return Math.max(0, Math.min((x - startX) / DX, n - 1));
    },

    // 即時插值價格（HUD 用）
    priceAt(x) {
      const f = this.dayAt(x);
      const i = Math.floor(f);
      const t = f - i;
      const a = days[i].close;
      const b = days[Math.min(i + 1, n - 1)].close;
      return a * (1 - t) + b * t;
    },
  };
}

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}
