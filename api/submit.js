// api/submit.js — 客戶簽署 → 壓印簽名+log → Gmail SMTP 寄附件
// CommonJS only.
const { list, put } = require('@vercel/blob');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb } = require('pdf-lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    return;
  }

  const need = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'NOTIFY_EMAIL', 'BLOB_RW_TOKEN'];
  const missing = need.filter(k => !process.env[k]);
  if (missing.length) {
    res.status(500).json({ error: 'MISSING_ENV: ' + missing.join(',') });
    return;
  }

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    if (!body || typeof body !== 'object') body = {};

    const { token, signerName, signatureBase64, page, x, y } = body;
    if (!token || !/^[a-f0-9]{32}$/.test(token)) {
      res.status(400).json({ error: 'BAD_TOKEN' });
      return;
    }
    if (!signerName || !signatureBase64) {
      res.status(400).json({ error: 'MISSING_FIELDS' });
      return;
    }

    // 取原始 PDF
    const { blobs } = await list({ prefix: `docs/${token}`, token: process.env.BLOB_RW_TOKEN });
    const pdfBlob = blobs.find(b => b.pathname === `docs/${token}.pdf`);
    const metaBlob = blobs.find(b => b.pathname === `docs/${token}.json`);
    const signedBlob = blobs.find(b => b.pathname === `docs/${token}.signed`);
    if (!pdfBlob) {
      res.status(404).json({ error: 'DOC_NOT_FOUND' });
      return;
    }
    // 一次性鎖定：已簽署則拒絕重簽
    if (signedBlob) {
      let signedAt = '';
      try { signedAt = (await (await fetch(signedBlob.url)).json()).signedAt || ''; } catch (_) {}
      res.status(409).json({ error: 'ALREADY_SIGNED', signedAt });
      return;
    }

    let caseName = '未命名案件';
    if (metaBlob) {
      try { caseName = (await (await fetch(metaBlob.url)).json()).caseName || caseName; } catch (_) {}
    }

    const srcArr = Buffer.from(await (await fetch(pdfBlob.url)).arrayBuffer());
    const pdfDoc = await PDFDocument.load(srcArr);

    // 壓印簽名圖（PNG data URI）
    const sigClean = String(signatureBase64).replace(/^data:image\/png;base64,/, '');
    const sigImg = await pdfDoc.embedPng(Buffer.from(sigClean, 'base64'));
    const pages = pdfDoc.getPages();
    const pIdx = Math.max(0, Math.min(pages.length - 1, parseInt(page, 10) || 0));
    const target = pages[pIdx];
    const { width: pw, height: ph } = target.getSize();

    // 前端傳的 x,y 為 0~1 比例（左上原點）→ 轉 PDF 左下原點
    const sigW = 160, sigH = 60;
    const px = (typeof x === 'number' ? x : 0.5) * pw - sigW / 2;
    const py = ph - (typeof y === 'number' ? y : 0.85) * ph - sigH / 2;
    target.drawImage(sigImg, { x: px, y: py, width: sigW, height: sigH });

    // log 資訊壓在最後一頁底部
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    const ua = (req.headers['user-agent'] || 'unknown').slice(0, 120);
    const stamp = new Date().toISOString();
    // pdf-lib 內建字型只支援 WinAnsi（無法寫中文）。
    // PDF 上的 log 僅壓「ASCII 安全」欄位（時間/IP/UA/token）；
    // 中文內容（簽署人姓名、案件名）改放 email 內文（UTF-8，零編碼問題）。
    // 簽署證據鏈仍完整：簽名圖已壓在文件上，PDF log + email 互為佐證。
    const last = pages[pages.length - 1];
    const asciiName = String(signerName).replace(/[^\x00-\x7F]/g, '').trim();
    const logLines = [
      `Signer: ${asciiName || '(see email)'}`,
      `Time: ${stamp}`,
      `IP: ${ip}`,
      `UA: ${ua}`,
      `Token: ${token}`
    ];
    logLines.forEach((line, i) => {
      last.drawText(line, { x: 24, y: 20 + (logLines.length - 1 - i) * 11, size: 7, color: rgb(0.45, 0.45, 0.45) });
    });

    const signedBytes = await pdfDoc.save();
    const fnameSafe = caseName.replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40);

    // Gmail SMTP 寄附件
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    await transporter.sendMail({
      from: `4force lab 簽署系統 <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL,
      subject: `【已簽署】${caseName} — ${signerName}`,
      text: `案件：${caseName}\n簽署人：${signerName}\n時間：${stamp}\nIP：${ip}\nUA：${ua}\nToken：${token}`,
      attachments: [{
        filename: `${fnameSafe}_signed.pdf`,
        content: Buffer.from(signedBytes),
        contentType: 'application/pdf'
      }]
    });

    // 寄信成功後才寫鎖定標記（寄信失敗則不鎖，可重試）
    try {
      await put(`docs/${token}.signed`, JSON.stringify({ signedAt: stamp, signer: signerName, ip }), {
        access: 'public',
        token: process.env.BLOB_RW_TOKEN,
        addRandomSuffix: false,
        contentType: 'application/json'
      });
    } catch (_) { /* 標記寫入失敗不影響本次簽署成立，最多允許極端情況重簽 */ }

    res.status(200).json({ ok: true, caseName, signerName, stamp });
  } catch (e) {
    res.status(500).json({ error: 'SUBMIT_FAIL', detail: String(e && e.message ? e.message : e) });
  }
};
