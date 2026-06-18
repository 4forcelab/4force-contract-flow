// api/upload.js — 內部：接收 base64 PDF JSON → 存 public Blob → 回 token
// CommonJS only.
const { put } = require('@vercel/blob');
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (!process.env.BLOB_RW_TOKEN) {
    res.status(500).json({ error: 'MISSING_BLOB_RW_TOKEN' });
    return;
  }

  try {
    // body 可能已被 parse，也可能是 raw string
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};

    const { pdfBase64, caseName, placements } = body;
    if (!pdfBase64) {
      res.status(400).json({ error: 'MISSING_PDF' });
      return;
    }

    // 正規化座標夾在 [0,1]，NaN 才回退預設（relX=0 等合法值不可被 || 蓋掉）
    const clamp01 = (v, dflt) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return dflt;
      return Math.min(1, Math.max(0, n));
    };
    // 簽名落點：admin 預先指定。陣列 schema（單點＝放一個、多點＝放多個）。
    // 上限 20 防濫用；label 截 20 字；page 0-indexed。
    let cleanPlacements = [];
    if (Array.isArray(placements)) {
      cleanPlacements = placements.slice(0, 20).map((p) => ({
        page: Math.max(0, parseInt(p && p.page, 10) || 0),
        relX: clamp01(p && p.relX, 0.5),
        relY: clamp01(p && p.relY, 0.85),
        label: (p && p.label ? String(p.label) : '').slice(0, 20)
      }));
    }

    // 去掉 data URI 前綴
    const clean = String(pdfBase64).replace(/^data:application\/pdf;base64,/, '');
    const buf = Buffer.from(clean, 'base64');
    if (!buf.length) {
      res.status(400).json({ error: 'EMPTY_PDF' });
      return;
    }

    const token = crypto.randomBytes(16).toString('hex');
    const meta = {
      caseName: (caseName || '未命名案件').toString().slice(0, 120),
      createdAt: new Date().toISOString(),
      placements: cleanPlacements
    };

    // 存 PDF 與 meta（同 token 命名）
    await put(`docs/${token}.pdf`, buf, {
      access: 'public',
      token: process.env.BLOB_RW_TOKEN,
      addRandomSuffix: false,
      contentType: 'application/pdf'
    });
    await put(`docs/${token}.json`, JSON.stringify(meta), {
      access: 'public',
      token: process.env.BLOB_RW_TOKEN,
      addRandomSuffix: false,
      contentType: 'application/json'
    });

    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    res.status(200).json({
      ok: true,
      token,
      link: `${proto}://${host}/s/${token}`,
      caseName: meta.caseName
    });
  } catch (e) {
    res.status(500).json({ error: 'UPLOAD_FAIL', detail: String(e && e.message ? e.message : e) });
  }
};

