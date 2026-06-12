// FinMind 台股行情資料 API
const API = 'https://api.finmindtrade.com/api/v4/data';

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export async function fetchStockName(stockId) {
  try {
    const url = `${API}?dataset=TaiwanStockInfo&data_id=${encodeURIComponent(stockId)}`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.data && json.data.length > 0) return json.data[0].stock_name;
  } catch (_) { /* 名稱抓不到不影響遊戲 */ }
  return '';
}

// 回傳 [{date, open, high, low, close}]，依日期排序
export async function fetchDaily(stockId, months) {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);

  const url = `${API}?dataset=TaiwanStockPrice` +
    `&data_id=${encodeURIComponent(stockId)}` +
    `&start_date=${fmtDate(start)}&end_date=${fmtDate(end)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`API 回應 ${res.status}`);
  const json = await res.json();
  if (json.status !== 200) throw new Error(json.msg || 'API 錯誤');

  const rows = (json.data || [])
    .filter(r => r.close > 0)
    .map(r => ({
      date: r.date,
      open: r.open,
      high: r.max,
      low: r.min,
      close: r.close,
    }));

  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}
