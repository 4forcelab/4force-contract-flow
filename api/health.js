// api/health.js — 診斷端點（部署後必打）
// CommonJS only. 回傳 ok / env 狀態 / Blob 寫入測試結果。
const { put, del } = require('@vercel/blob');

module.exports = async (req, res) => {
  const out = {
    ok: false,
    ts: new Date().toISOString(),
    env: {
      GMAIL_USER: !!process.env.GMAIL_USER,
      GMAIL_APP_PASSWORD: !!process.env.GMAIL_APP_PASSWORD,
      NOTIFY_EMAIL: !!process.env.NOTIFY_EMAIL,
      BLOB_RW_TOKEN: !!process.env.BLOB_RW_TOKEN
    },
    blobTest: 'SKIP'
  };

  // 缺任何環境變數直接回報
  const missing = Object.entries(out.env).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    out.error = 'MISSING_ENV: ' + missing.join(',');
    res.status(200).json(out);
    return;
  }

  // Blob 寫入/刪除往返測試
  try {
    const probe = `health/_probe_${Date.now()}.txt`;
    const blob = await put(probe, 'ping', {
      access: 'public',
      token: process.env.BLOB_RW_TOKEN,
      addRandomSuffix: false,
      contentType: 'text/plain'
    });
    await del(blob.url, { token: process.env.BLOB_RW_TOKEN });
    out.blobTest = 'OK';
    out.ok = true;
  } catch (e) {
    out.blobTest = 'FAIL';
    out.error = String(e && e.message ? e.message : e);
  }

  res.status(200).json(out);
};

