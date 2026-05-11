/**
 * LINE Bot 自動提醒腳本（使用 LINE Messaging API）
 * - 個人推播：發給每位業務自己的 LINE（需要各業務的 User ID）
 * - 群組推播：發給主管群組（需要群組的 Group ID）
 *
 * 部署在 GitHub Actions，每天早上 9 點自動執行
 * 安裝：npm install node-fetch
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ── 環境變數（填在 GitHub Secrets）────────────────────────────────
const LINE_CHANNEL_TOKEN = process.env.LINE_CHANNEL_TOKEN; // LINE Bot Channel Access Token
const LINE_GROUP_ID      = process.env.LINE_GROUP_ID;      // 主管群組的 Group ID
const GIST_ID            = process.env.GIST_ID;
const GIST_TOKEN         = process.env.GIST_TOKEN;
const STALE_DAYS         = parseInt(process.env.STALE_DAYS || '1');

// ── 從 GitHub Gist 讀取資料 ───────────────────────────────────────
async function fetchGist() {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
    }
  });
  if (!res.ok) throw new Error(`Gist 讀取失敗: ${res.status}`);
  const data = await res.json();
  const clients = JSON.parse(data.files['clients.json']?.content || '[]');
  const userIds  = JSON.parse(data.files['sales_userids.json']?.content || '{}');
  return { clients, userIds };
}

// ── 判斷是否未更新 ────────────────────────────────────────────────
function isStale(c) {
  if (!c.updatedAt) return true;
  if (['已成交', '未成交'].includes(c.status)) return false;
  return (Date.now() - new Date(c.updatedAt).getTime()) / 86400000 >= STALE_DAYS;
}

function daysSince(d) {
  if (!d) return '?';
  return Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
}

// ── 發送 LINE Push Message（個人或群組）──────────────────────────
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

// ── 組合業務個人訊息 ──────────────────────────────────────────────
function buildSalesMessage(salesName, records) {
  const lines = records.map((c, i) =>
    `${i + 1}. ${c.name}\n   狀態：${c.status}｜已 ${daysSince(c.updatedAt)} 天未更新`
  ).join('\n\n');

  return [{
    type: 'text',
    text: `📋 進度提醒\n\n${salesName}，以下客戶超過 ${STALE_DAYS} 天未更新，請盡快處理：\n\n${lines}\n\n請登入系統更新進度 🙏`,
  }];
}

// ── 組合主管群組彙整訊息 ──────────────────────────────────────────
function buildManagerMessage(grouped, total) {
  const today = new Date().toLocaleDateString('zh-TW');
  let text = `📊 主管日報 ${today}\n共 ${total} 筆客戶超過 ${STALE_DAYS} 天未更新：\n`;

  for (const [sales, records] of Object.entries(grouped)) {
    text += `\n👤 ${sales}（${records.length} 筆）\n`;
    records.forEach(c => {
      text += `  • ${c.name}｜${c.status}｜${daysSince(c.updatedAt)} 天未更新\n`;
    });
  }

  return [{ type: 'text', text }];
}

// ── 主程式 ────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 開始執行 LINE Bot 通知（超過 ${STALE_DAYS} 天未更新）`);

  const { clients, userIds } = await fetchGist();
  const stale = clients.filter(isStale);

  console.log(`📊 共 ${clients.length} 筆，其中 ${stale.length} 筆需要提醒`);

  if (stale.length === 0) {
    console.log('✅ 所有進度都是最新的，不需要發通知');
    return;
  }

  // 依業務分組
  const grouped = {};
  stale.forEach(c => {
    if (!grouped[c.sales]) grouped[c.sales] = [];
    grouped[c.sales].push(c);
  });

  // 個人推播給各業務
  for (const [sales, records] of Object.entries(grouped)) {
    const userId = userIds[sales];
    if (!userId) {
      console.warn(`⚠  ${sales} 沒有 User ID，略過個人通知`);
      continue;
    }
    const ok = await pushLine(userId, buildSalesMessage(sales, records));
    console.log(ok ? `📱 已通知業務：${sales}（${records.length} 筆）` : `❌ 通知失敗：${sales}`);
  }

  // 推播到主管群組
  if (LINE_GROUP_ID) {
    const ok = await pushLine(LINE_GROUP_ID, buildManagerMessage(grouped, stale.length));
    console.log(ok ? '📊 已發送主管群組日報' : '❌ 主管群組推播失敗');
  } else {
    console.warn('⚠  未設定 LINE_GROUP_ID，略過群組通知');
  }

  console.log('✅ 完成！');
}

main().catch(err => {
  console.error('❌ 執行錯誤：', err.message);
  process.exit(1);
});
