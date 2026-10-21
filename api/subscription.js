const p = require('../lib/push.cjs');
module.exports = async function handler(req, res) {
  if (!['POST', 'DELETE'].includes(req.method)) { res.setHeader('Allow', 'POST, DELETE'); return p.reply(res, 405, { error: 'Metode tidak tersedia.' }); }
  try {
    const cfg = p.configuration();
    p.assertOrigin(req, cfg);
    const subscription = p.subscriptionFrom(req);
    const id = p.hash(subscription.endpoint);
    if (req.method === 'DELETE') {
      try { await p.ownedRecord(subscription, cfg); } catch (error) { if (error.status === 409) return p.reply(res, 200, { ok: true }); throw error; }
      await p.redis(['HDEL', p.SUBSCRIPTIONS, id], cfg);
      return p.reply(res, 200, { ok: true });
    }
    const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    await p.rateLimit('register:' + p.hash(ip), 30, 3600, cfg);
    const record = JSON.stringify({ subscription, updatedAt: new Date().toISOString() });
    // Bound storage atomically. Existing subscriptions can always refresh.
    const script = "if redis.call('HEXISTS',KEYS[1],ARGV[1])==0 and redis.call('HLEN',KEYS[1])>=100 then return 0 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); return 1";
    const stored = await p.redis(['EVAL', script, '1', p.SUBSCRIPTIONS, id, record], cfg);
    if (!Number(stored)) throw new p.HttpError(503, 'Pendaftaran pengingat sedang penuh. Hubungi pengelola web.');
    return p.reply(res, 200, { ok: true });
  } catch (error) { return p.failure(res, error); }
};
