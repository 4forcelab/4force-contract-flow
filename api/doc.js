// api/doc.js — 客戶端：token → 取回 PDF（base64）+ 案件 meta
// CommonJS only. Blob 為 public，直接 fetch public URL。
const { list } = require('@vercel/blob');

async function findBlob(prefix, token) {
  // list 出 docs/ 下符合 token 的物件，拿其 public url
  const { blobs } = await list({
    prefix: `docs/${token}`,
    token: process.env.BLOB_RW_TOKEN
  });
  return blobs;
}

module.exports = async (req, res) => {
  try {
    const token = (req.query && req.query.token) ||
      (req.url.split('?')[1] || '').split('&')
        .map(p => p.split('='))
        .reduce((a, [k, v]) => (k === 'token' ? v : a), null);

    if (!token || !/^[a-f0-9]{32}$/.test(token)) {
      res.status(400).json({ error: 'BAD_TOKEN' });
      return;
    }
    if (!process.env.BLOB_RW_TOKEN) {
      res.status(500).json({ error: 'MISSING_BLOB_RW_TOKEN' });
      return;
    }

    const blobs = await findBlob('docs', token);
    const pdfBlob = blobs.find(b => b.pathname === `docs/${token}.pdf`);
    const metaBlob = blobs.find(b => b.pathname === `docs/${token}.json`);
    const signedBlob = blobs.find(b => b.pathname === `docs/${token}.signed`);

    if (!pdfBlob) {
      res.status(404).json({ error: 'DOC_NOT_FOUND' });
      return;
    }

    const pdfResp = await fetch(pdfBlob.url);
    const pdfArr = Buffer.from(await pdfResp.arrayBuffer());

    let meta = { caseName: '未命名案件' };
    if (metaBlob) {
      try {
        const m = await fetch(metaBlob.url);
        meta = await m.json();
      } catch (_) { /* meta 缺失不阻擋 */ }
    }

    // 一次性鎖定狀態
    let signed = false, signedAt = '';
    if (signedBlob) {
      signed = true;
      try { signedAt = (await (await fetch(signedBlob.url)).json()).signedAt || ''; } catch (_) {}
    }

    res.status(200).json({
      ok: true,
      caseName: meta.caseName || '未命名案件',
      pdfBase64: pdfArr.toString('base64'),
      signed,
      signedAt
    });
  } catch (e) {
    res.status(500).json({ error: 'DOC_FAIL', detail: String(e && e.message ? e.message : e) });
  }
};
