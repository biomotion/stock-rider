import { fetchDaily, fetchStockName } from './data.js';
import { buildTerrain } from './terrain.js';
import { Game } from './game.js';

const CAPITAL = 100000; // 起始資金 NT$

const $ = id => document.getElementById(id);
const canvas = $('game');

let game = null;
let current = null; // {stockId, stockName, months, days}
let months = 12;

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
});

async function startFromMenu() {
  const stockId = $('ticker').value.trim();
  if (!stockId) return showError('請輸入股票代碼');
  hide('menu');
  show('loading');
  $('loading-text').textContent = `下載 ${stockId} 行情資料中…`;

  try {
    const [days, stockName] = await Promise.all([
      fetchDaily(stockId, months),
      fetchStockName(stockId),
    ]);
    if (days.length < 10) {
      throw new Error('資料不足，請確認代碼是否正確（例如 2330），或改選較長區間');
    }
    current = { stockId, stockName, months, days };
    hide('loading');
    launch(current);
  } catch (err) {
    hide('loading');
    show('menu');
    showError(`載入失敗：${err.message}`);
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
  const terrain = buildTerrain(cfg.days);
  const meta = {
    stockId: cfg.stockId,
    stockName: cfg.stockName,
    startPrice: cfg.days[0].close,
    capital: CAPITAL,
  };

  $('hud-stock').textContent = `${cfg.stockId} ${cfg.stockName || ''}`.trim();
  show('hud');
  show('touch');

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

function showResult(reason, s) {
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
