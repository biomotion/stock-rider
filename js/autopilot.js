// 自動駕駛：演示模式用的 AI 騎士
// 平衡：PD 控制把車身角度貼向前方坡度；速度：看前方地形起伏決定目標速度
export function autopilotStep(game) {
  const g = game, T = g.terrain, b = g.bike;
  if (g.state !== 'riding') return;

  const n = T.normalAt(b.x + 30);
  const slope = Math.atan2(-n.x, n.y);
  let err = slope - b.a;
  err = Math.atan2(Math.sin(err), Math.cos(err)); // 最短角差
  const u = err * 3 - b.w * 0.8;
  g.input.leanL = u > 0.4;
  g.input.leanR = u < -0.4;

  // 前方 120px 內最陡的坡，越陡目標速度越低
  let rough = 0;
  for (let d = 24; d <= 120; d += 24) {
    const s = (T.heightAt(b.x + d + 8) - T.heightAt(b.x + d - 8)) / 16;
    rough = Math.max(rough, Math.abs(s));
  }
  const target = rough > 0.8 ? 320 : 520;
  g.input.gas = b.vx < target;
  g.input.brake = b.vx > target + 130;
}

export function releaseInputs(game) {
  const i = game.input;
  i.gas = i.brake = i.leanL = i.leanR = i.jump = false;
}
