const p = require('../lib/push.cjs');
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return p.reply(res, 405, { error: 'Metode tidak tersedia.' }); }
  // Check the secret before touching storage or contacting any push provider.
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !p.same(req.headers.authorization, 'Bearer ' + secret)) return p.reply(res, 401, { error: 'Tidak diizinkan.' });
  try {
    const cfg = p.configuration();
    const date = p.jakartaDate();
    const values = await p.redis(['HGETALL', p.SUBSCRIPTIONS], cfg) || [];
    let sent = 0, skipped = 0, removed = 0, failed = 0;
    // Small batches stay within the function's duration limit; intended for a couple.
    const entries = [];
    for (let i = 0; i < values.length; i += 2) entries.push([values[i], values[i + 1]]);
    for (let offset = 0; offset < entries.length; offset += 10) {
      await Promise.all(entries.slice(offset, offset + 10).map(async ([id, raw]) => {
        let record;
        try { record = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* Remove corrupt records. */ }
        if (!record?.subscription) { await p.redis(['HDEL', p.SUBSCRIPTIONS, id], cfg); removed++; return; }
        const key = 'novena:sent:' + date + ':' + id;
        const locked = await p.redis(['SET', key, '1', 'NX', 'EX', '172800'], cfg);
        if (!locked) { skipped++; return; }
        try { await p.send(record.subscription, cfg, { date }); sent++; }
        catch (error) {
          await p.redis(['DEL', key], cfg);
          if ([404, 410].includes(error.statusCode)) { await p.redis(['HDEL', p.SUBSCRIPTIONS, id], cfg); removed++; }
          else { failed++; }
        }
      }));
    }
    return p.reply(res, failed ? 502 : 200, { ok: !failed, date, sent, skipped, removed, failed });
  } catch (error) { return p.failure(res, error); }
};
