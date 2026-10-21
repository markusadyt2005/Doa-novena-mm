const p = require('../lib/push.cjs');
module.exports = function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return p.reply(res, 405, { error: 'Metode tidak tersedia.' }); }
  try {
    const cfg = p.configuration();
    return p.reply(res, 200, { configured: true, publicKey: cfg.publicKey });
  } catch {
    return p.reply(res, 200, { configured: false, message: 'Pengingat belum diaktifkan oleh pengelola web.' });
  }
};
