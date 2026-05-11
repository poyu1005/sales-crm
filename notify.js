/**
 * LINE Notify 自動提醒腳本
 * 部署在 GitHub Actions，每天早上 9 點執行
 * 從共享 JSON 資料（或 GitHub Gist）讀取客戶資料，發送 LINE 通知
 *
 * 安裝：npm install node-fetch
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── 從環境變數讀取設定 ────────────────────────────────────────────
const LINE_MANAGER_TOKEN = process.env.LINE_MANAGER_TOKEN;
const GIST_ID = process.env.GIST_ID;               // GitHub Gist ID（存客戶資料）
const GIST_TOKEN = process.env.GIST_TOKEN;          // GitHub Personal Access Token
const STALE_DAYS = parseInt(process.env.STALE_DAYS || '1');

// ── 從 GitHub Gist 讀取客戶資料 ───────────────────────────────────
async function fetchClientsFromGist() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
    }
  });
  if (!res.ok) throw new Error(`Gist 讀取失敗: ${res.status}`);
  const data = await res.json();
  const content = data.files['clients.json']?.content;
  return content ? JSON.parse(content) : [];
}

// ── 讀取業務 LINE Token 對照表 ────────────────────────────────────
async function fetchSalesTokens() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
    }
  });
  const data = await res.json();
  const content = data.files['sales_tokens.json']?.content;
  return content ? JSON.parse(content) : {};
}

// ── 判斷是否超過 N 天未更新 ──────────────────────────────────────
function isStale(client) {
  if (!client.updatedAt) return true;
  if (['已成交', '未成交'].includes(client.status)) return false;
  const days = (Date.now() - new Date(client.updatedAt).getTime()) / 86400000;
  return days >= STALE_DAYS;
}

function daysSince(dateStr) {
  if (!dateStr) return '?';
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// ── 發送 LINE Notify ──────────────────────────────────────────────
async function sendLine(token, message) {
  const res = await fetch('https://notify-api.line.me/api/notify', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ message }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`LINE 發送失敗: ${res.status}`, err);
    return false;
  }
  return true;
}

// ── 主程式 ────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 開始執行通知檢查 (超過 ${STALE_DAYS} 天未更新)`);

  const [clients, salesTokens] = await Promise.all([
    fetchClientsFromGist(),
    fetchSalesTokens(),
  ]);

  const staleClients = clients.filter(isStale);
  console.log(`📊 共 ${clients.length} 筆，其中 ${staleClients.length} 筆超過 ${STALE_DAYS} 天未更新`);

  if (staleClients.length === 0) {
    console.log('✅ 所有客戶進度都是最新的！');
    return;
  }

  // 依業務分組
  const grouped = {};
  staleClients.forEach(c => {
    if (!grouped[c.sales]) grouped[c.sales] = [];
    grouped[c.sales].push(c);
  });

  // 發個人通知給業務
  for (const [sales, records] of Object.entries(grouped)) {
    const token = salesTokens[sales];
    if (!token) {
      console.warn(`⚠ ${sales} 沒有 LINE Token，略過`);
      continue;
    }
    const msg = `\n📋 【進度提醒】\n${sales}，以下客戶超過 ${STALE_DAYS} 天未更新，請盡快處理：\n\n` +
      records.map((c, i) => `${i + 1}. ${c.name}\n   狀態：${c.status}\n   已 ${daysSince(c.updatedAt)} 天未更新`).join('\n\n') +
      '\n\n請登入系統更新進度 🙏';
    await sendLine(token, msg);
    console.log(`📱 已通知業務：${sales}（${records.length} 筆）`);
  }

  // 發彙整日報給主管
  if (LINE_MANAGER_TOKEN) {
    const today = new Date().toLocaleDateString('zh-TW');
    let msg = `\n📊 【主管日報】${today}\n共 ${staleClients.length} 筆客戶超過 ${STALE_DAYS} 天未更新：\n\n`;
    for (const [sales, records] of Object.entries(grouped)) {
      msg += `👤 ${sales}（${records.length} 筆）\n`;
      records.forEach(c => msg += `  • ${c.name}｜${c.status}｜${daysSince(c.updatedAt)}天未更新\n`);
      msg += '\n';
    }
    await sendLine(LINE_MANAGER_TOKEN, msg);
    console.log('📊 已發送主管日報');
  }

  console.log('✅ 完成！');
}

main().catch(err => {
  console.error('❌ 執行失敗：', err.message);
  process.exit(1);
});
