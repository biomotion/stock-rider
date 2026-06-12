import { fetchDaily, fetchStockName } from './data.js';
import { buildTerrain } from './terrain.js';
import { Game } from './game.js';
import { autopilotStep, releaseInputs } from './autopilot.js';

const CAPITAL = 100000; // 起始資金 NT$
const IDLE_MS = 10000;  // 閒置多久進入自動演示

const $ = id => document.getElementById(id);
const canvas = $('game');

let game = null;
let current = null; // {stockId, stockName, months, days}
let months = 12;
let demoMode = false;
let demoTimer = null;   // 演示中的各種延遲
let autopilot = null;   // 演示控制器 interval
let idleTimer = null;
const dataCache = new Map(); // `${id}:${months}` -> {days, stockName}

// ── 選單 ──
$('quick-picks').addEventListener('click', e => {
  const code = e.target.dataset?.code;
  if (code) $('ticker').value = code;
});

$('ranges').addEventListener('click', e => {
  const m = e.target.dataset?.months;
  if (!m) return;
  months = Number(m);
  for (const b of $('ranges').children) b.classList.toggle('active', b === e.target);
});

$('start-btn').addEventListener('click', startFromMenu);
$('ticker').addEventListener('keydown', e => { if (e.key === 'Enter') startFromMenu(); });

$('retry-btn').addEventListener('click', () => { hide('result'); launch(current); });
$('menu-btn').addEventListener('click', () => {
  hide('result'); hide('hud'); hide('touch');
  destroyGame();
  show('menu');
  armIdle();
});

async function loadStock(stockId, m) {
  const key = `${stockId}:${m}`;
  if (dataCache.has(key)) return dataCache.get(key);
  const [days, stockName] = await Promise.all([
    fetchDaily(stockId, m),
    fetchStockName(stockId),
  ]);
  if (days.length < 10) {
    throw new Error('資料不足，請確認代碼是否正確（例如 2330），或改選較長區間');
  }
  const entry = { days, stockName };
  dataCache.set(key, entry);
  return entry;
}

async function startFromMenu() {
  const stockId = $('ticker').value.trim();
  if (!stockId) return showError('請輸入股票代碼');
  stopDemo(false);
  disarmIdle();
  hide('menu');
  show('loading');
  $('loading-text').textContent = `下載 ${stockId} 行情資料中…`;

  try {
    const { days, stockName } = await loadStock(stockId, months);
    current = { stockId, stockName, months, days };
    hide('loading');
    launch(current);
  } catch (err) {
    hide('loading');
    show('menu');
    showError(`載入失敗：${err.message}`);
    armIdle();
  }
}

function showError(msg) {
  const el = $('menu-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ── 開始遊戲 ──
function launch(cfg) {
  destroyGame();
  if (!demoMode) disarmIdle();
  const terrain = buildTerrain(cfg.days);
  const meta = {
    stockId: cfg.stockId,
    stockName: cfg.stockName,
    startPrice: cfg.days[0].close,
    capital: CAPITAL,
  };

  $('hud-stock').textContent = `${cfg.stockId} ${cfg.stockName || ''}`.trim();
  show('hud');
  if (demoMode) hide('touch'); else show('touch');

  game = new Game(canvas, terrain, meta, {
    onHud: updateHud,
    onEnd: showResult,
  });
  window.__game = game; // debug 用
}

function destroyGame() {
  if (game) { game.destroy(); game = null; }
}

const ntd = v => 'NT$' + Math.round(v).toLocaleString('zh-Hant-TW');

function updateHud(s) {
  $('hud-date').textContent = s.date;
  $('hud-price').textContent = s.price.toFixed(s.price >= 500 ? 0 : 2);
  $('hud-value').textContent = ntd(s.value);
  const r = $('hud-return');
  r.textContent = (s.ret >= 0 ? '+' : '') + s.ret.toFixed(1) + '%';
  r.className = 'hud-return ' + (s.ret >= 0 ? 'up' : 'down');
  $('hud-progress-bar').style.width = (s.progress * 100).toFixed(1) + '%';
}

// ── 自動演示（attract mode）──
const DEMO_POOL = [
  { code: '2330', months: 12 }, { code: '2317', months: 12 },
  { code: '2454', months: 6 }, { code: '2603', months: 12 },
  { code: '0050', months: 36 }, { code: '2330', months: 3 },
];
let demoIdx = Math.floor(Math.random() * DEMO_POOL.length);

function armIdle() {
  disarmIdle();
  idleTimer = setTimeout(startDemo, IDLE_MS);
}
function disarmIdle() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

async function startDemo() {
  disarmIdle();
  const pick = DEMO_POOL[demoIdx % DEMO_POOL.length];
  demoIdx++;
  try {
    const { days, stockName } = await loadStock(pick.code, pick.months);
    if (demoMode || game) return; // 載入期間使用者開始玩了就放棄
    demoMode = true;
    current = { stockId: pick.code, stockName, months: pick.months, days };
    hide('menu'); hide('result');
    show('demo-badge');
    launch(current);
    autopilot = setInterval(() => { if (game) autopilotStep(game); }, 40);
  } catch (_) {
    // 演示載入失敗就安靜地留在選單，稍後再試
    if (!demoMode && !game) armIdle();
  }
}

// 結束演示。toMenu=true 時回到選單並重新計時
function stopDemo(toMenu = true) {
  if (!demoMode) return;
  demoMode = false;
  clearInterval(autopilot); autopilot = null;
  clearTimeout(demoTimer); demoTimer = null;
  hide('demo-badge');
  if (game) releaseInputs(game);
  if (toMenu) {
    destroyGame();
    hide('hud'); hide('touch'); hide('result');
    show('menu');
    armIdle();
  }
}

// 任何互動：演示中→離開演示；閒置計時中→重新計時
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => {
    if (demoMode) { stopDemo(); return; }
    if (idleTimer) armIdle();
  }, true);
}
window.addEventListener('pointermove', () => { if (idleTimer) armIdle(); }, true);

function showResult(reason, s) {
  if (demoMode) {
    // 演示模式不顯示結算：摔車重騎、完賽換下一檔
    clearTimeout(demoTimer);
    demoTimer = setTimeout(async () => {
      if (!demoMode) return;
      let next = current;
      if (reason === 'finished') {
        const pick = DEMO_POOL[demoIdx % DEMO_POOL.length];
        demoIdx++;
        try {
          const { days, stockName } = await loadStock(pick.code, pick.months);
          next = { stockId: pick.code, stockName, months: pick.months, days };
        } catch (_) { /* 載入失敗就重騎同一檔 */ }
        if (!demoMode) return; // 載入期間使用者離開了演示
      }
      current = next;
      launch(current);
    }, 1500);
    return;
  }
  const finished = reason === 'finished';
  $('result-title').textContent = finished ? '🏁 完賽！' : '💥 墜車！';
  $('result-detail').textContent = finished
    ? `你騎完了 ${current.stockId} ${current.stockName || ''} 全程！`
    : `摔在 ${s.date}，走勢比你想的更兇…`;

  const retClass = s.ret >= 0 ? 'up' : 'down';
  $('result-stats').innerHTML = `
    <div class="k">投資組合</div><div class="v">${ntd(s.value)}</div>
    <div class="k">報酬率</div><div class="v ${retClass}">${(s.ret >= 0 ? '+' : '') + s.ret.toFixed(1)}%</div>
    <div class="k">完成度</div><div class="v">${(s.progress * 100).toFixed(0)}%</div>
    <div class="k">騎乘時間</div><div class="v">${s.elapsed.toFixed(1)} 秒</div>
  `;
  show('result');
  armIdle(); // 停在結算畫面太久也會進入演示
}

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// ── 鍵盤輸入 ──
const KEYMAP = {
  ArrowUp: 'gas', KeyW: 'gas',
  ArrowDown: 'brake', KeyS: 'brake',
  ArrowLeft: 'leanL', KeyA: 'leanL',
  ArrowRight: 'leanR', KeyD: 'leanR',
  Space: 'jump',
};

window.addEventListener('keydown', e => {
  if (e.code === 'KeyR' && game && game.state !== 'riding') {
    hide('result');
    launch(current);
    return;
  }
  const k = KEYMAP[e.code];
  if (k && game) {
    game.input[k] = true;
    e.preventDefault();
  }
});

window.addEventListener('keyup', e => {
  const k = KEYMAP[e.code];
  if (k && game) game.input[k] = false;
});

// ── 觸控按鍵 ──
const TOUCHMAP = {
  't-gas': 'gas', 't-brake': 'brake',
  't-lean-l': 'leanL', 't-lean-r': 'leanR', 't-jump': 'jump',
};
for (const [id, key] of Object.entries(TOUCHMAP)) {
  const el = $(id);
  const on = e => { e.preventDefault(); if (game) game.input[key] = true; };
  const off = e => { e.preventDefault(); if (game) game.input[key] = false; };
  el.addEventListener('touchstart', on, { passive: false });
  el.addEventListener('touchend', off, { passive: false });
  el.addEventListener('touchcancel', off, { passive: false });
}

// 開頁停在選單一段時間就開始演示
armIdle();
