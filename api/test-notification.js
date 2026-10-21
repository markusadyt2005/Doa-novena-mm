const p = require('../lib/push.cjs');
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return p.reply(res, 405, { error: 'Metode tidak tersedia.' }); }
  try {
    const cfg = p.configuration();
    p.assertOrigin(req, cfg);
    const subscription = p.subscriptionFrom(req);
    await p.ownedRecord(subscription, cfg);
    await p.rateLimit('test:' + p.hash(subscription.endpoint), 1, 60, cfg);
    try { await p.send(subscription, cfg, { test: true }); }
    catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        await p.redis(['HDEL', p.SUBSCRIPTIONS, p.hash(subscription.endpoint)], cfg);
        throw new p.HttpError(409, 'Pendaftaran perangkat sudah kedaluwarsa. Matikan lalu aktifkan pengingat lagi.');
      }
      throw error;
    }
    return p.reply(res, 200, { ok: true });
  } catch (error) { return p.failure(res, error); }
};
