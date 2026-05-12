/**
 * LINE Bot 自動提醒腳本
 * 每天早上 9 點執行，發送兩種通知：
 * 1. 超過 N 天未更新進度 → 提醒業務 + 主管日報
 * 2. 今天需要跟進的客戶 → 提醒業務 + 主管日報
 *
 * 資料來源：Google Apps Script API
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── 環境變數 ──────────────────────────────────────────────────────
const LINE_CHANNEL_TOKEN = process.env.LINE_CHANNEL_TOKEN;
const LINE_GROUP_ID      = process.env.LINE_GROUP_ID;
const APPS_SCRIPT_URL    = process.env.APPS_SCRIPT_URL;  // Google Apps Script 網址
const SALES_USERIDS      = process.env.SALES_USERIDS;    // JSON 字串，業務姓名對應 User ID
const STALE_DAYS         = parseInt(process.env.STALE_DAYS || '1');

// ── 從 Google Apps Script 讀取客戶資料 ───────────────────────────
async function fetchClients() {
  const res = await fetch(`${APPS_SCRIPT_URL}?action=getClients`);
  if (!res.ok) throw new Error(`讀取失敗: ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// ── 今天的日期字串（台灣時間）────────────────────────────────────
function todayTW() {
  const now = new Date();
  const tw = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return tw.toISOString().slice(0, 10);
}

// ── 判斷是否未更新 ────────────────────────────────────────────────
function isStale(c) {
  if (!c.updatedAt) return true;
  if (['已成交', '未成交'].includes(c.status)) return false;
  return (Date.now() - new Date(c.updatedAt).getTime()) / 86400000 >= STALE_DAYS;
}

// ── 判斷今天是否需要跟進 ─────────────────────────────────────────
function isFollowUpToday(c) {
  if (!c.nextFollowUp) return false;
  if (['已成交', '未成交'].includes(c.status)) return false;
  return c.nextFollowUp.slice(0, 10) === todayTW();
}

function daysSince(d) {
  if (!d) return '?';
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

// ── 依業務分組 ────────────────────────────────────────────────────
function groupBy(clients) {
  const grouped = {};
  clients.forEach(c => {
    if (!grouped[c.sales]) grouped[c.sales] = [];
    grouped[c.sales].push(c);
  });
  return grouped;
}

// ── 發送 LINE Push Message ────────────────────────────────────────
async function pushLine(to, messages) {
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`LINE 推播失敗 (to: ${to}): ${res.status}`, err);
    return false;
  }
  return true;
}

// ── 主程式 ────────────────────────────────────────────────────────
async function main() {
  const today = todayTW();
  console.log(`🚀 開始執行 LINE Bot 通知 (${today})`);

  // 讀取業務 User ID
  let userIds = {};
  try { userIds = JSON.parse(SALES_USERIDS || '{}'); } catch(e) { userIds = {}; }

  // 讀取客戶資料
  const clients = await fetchClients();
  console.log(`📊 共讀取 ${clients.length} 筆客戶資料`);

  // 分類
  const staleClients   = clients.filter(isStale);
  const followupClients = clients.filter(isFollowUpToday);

  console.log(`⚠  超過 ${STALE_DAYS} 天未更新：${staleClients.length} 筆`);
  console.log(`📅 今日需跟進：${followupClients.length} 筆`);

  // ── 1. 未更新通知 ────────────────────────────────────────────────
  if (staleClients.length > 0) {
    const grouped = groupBy(staleClients);

    // 個人通知
    for (const [sales, records] of Object.entries(grouped)) {
      const userId = userIds[sales];
      if (!userId) { console.warn(`⚠  ${sales} 沒有 User ID，略過`); continue; }
      const text = `📋 進度提醒\n\n${sales}，以下客戶超過 ${STALE_DAYS} 天未更新：\n\n` +
        records.map((c, i) => `${i+1}. ${c.name}\n   狀態：${c.status}｜${daysSince(c.updatedAt)}天未更新`).join('\n\n') +
        '\n\n請登入系統更新進度 🙏';
      const ok = await pushLine(userId, [{ type: 'text', text }]);
      console.log(ok ? `📱 已通知業務：${sales}（${records.length} 筆未更新）` : `❌ 通知失敗：${sales}`);
    }

    // 主管群組
    if (LINE_GROUP_ID) {
      let text = `📊 主管日報 ${today}\n未更新共 ${staleClients.length} 筆：\n`;
      for (const [sales, records] of Object.entries(grouped)) {
        text += `\n👤 ${sales}（${records.length} 筆）\n`;
        records.forEach(c => text += `  • ${c.name}｜${c.status}｜${daysSince(c.updatedAt)}天\n`);
      }
      const ok = await pushLine(LINE_GROUP_ID, [{ type: 'text', text }]);
      console.log(ok ? '📊 已發送主管日報（未更新）' : '❌ 主管群組推播失敗');
    }
  }

  // ── 2. 今日跟進通知 ──────────────────────────────────────────────
  if (followupClients.length > 0) {
    const grouped = groupBy(followupClients);

    // 個人通知
    for (const [sales, records] of Object.entries(grouped)) {
      const userId = userIds[sales];
      if (!userId) { console.warn(`⚠  ${sales} 沒有 User ID，略過跟進通知`); continue; }
      const text = `📅 今日跟進提醒\n\n${sales}，以下客戶今天需要聯絡：\n\n` +
        records.map((c, i) => `${i+1}. ${c.name}\n   狀態：${c.status}`).join('\n\n') +
        '\n\n加油！今天聯絡到 💪';
      const ok = await pushLine(userId, [{ type: 'text', text }]);
      console.log(ok ? `📅 已通知業務：${sales}（${records.length} 筆今日跟進）` : `❌ 跟進通知失敗：${sales}`);
    }

    // 主管群組
    if (LINE_GROUP_ID) {
      let text = `📅 今日跟進日報 ${today}\n共 ${followupClients.length} 筆需跟進：\n`;
      for (const [sales, records] of Object.entries(grouped)) {
        text += `\n👤 ${sales}（${records.length} 筆）\n`;
        records.forEach(c => text += `  • ${c.name}｜${c.status}\n`);
      }
      const ok = await pushLine(LINE_GROUP_ID, [{ type: 'text', text }]);
      console.log(ok ? '📅 已發送主管今日跟進日報' : '❌ 主管群組跟進推播失敗');
    }
  }

  if (staleClients.length === 0 && followupClients.length === 0) {
    console.log('✅ 今天沒有需要提醒的項目！');
  }

  console.log('✅ 完成！');
}

main().catch(err => {
  console.error('❌ 執行錯誤：', err.message);
  process.exit(1);
});
