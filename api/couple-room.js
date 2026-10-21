const { randomBytes } = require('node:crypto');
const p = require('../lib/push.cjs');
const model = require('../public/state-model.js');
const PREFIX = 'novena:room:v1:';
const CAS = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
function readBody(req) {
  let body = req.body;
  try { if (typeof body === 'string' || Buffer.isBuffer(body)) body = JSON.parse(body.toString()); } catch { throw new p.HttpError(400, 'Data perubahan tidak valid.'); }
  if (!body || Buffer.byteLength(JSON.stringify(body)) > 500000) throw new p.HttpError(400, 'Data perubahan terlalu besar atau tidak valid.');
  return body;
}
function roomKey(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization || '');
  if (!match) throw new p.HttpError(401, 'Masukkan kode ruang dari pasanganmu.');
  return PREFIX + p.hash(match[1]);
}
async function readRoom(key, cfg) {
  const raw = await p.redis(['GET', key], cfg);
  if (!raw) throw new p.HttpError(404, 'Kode ruang tidak ditemukan. Periksa kode dari pasanganmu.');
  let room;
  try { room = JSON.parse(raw); } catch { /* Do not expose stored values. */ }
  if (!model.validRoom(room)) throw new p.HttpError(503, 'Ruang sementara tidak dapat dibuka. Coba lagi nanti.');
  return { raw, room };
}
module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return p.reply(res, 405, { error: 'Metode tidak tersedia.' }); }
  try {
    const cfg = p.databaseConfiguration();
    if (req.method === 'POST' || req.headers.origin) p.assertOrigin(req, cfg);
    if (req.method === 'GET') return p.reply(res, 200, { room: (await readRoom(roomKey(req), cfg)).room });
    const body = readBody(req);
    if (body.action === 'create') {
      const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
      await p.rateLimit('room-create:' + p.hash(ip), 5, 3600, cfg);
      let room = model.create(body.names);
      if (body.initialImport) {
        if (body.initialImport.type !== 'import') throw new p.HttpError(400, 'Data lama tidak valid.');
        room = model.apply(room, body.initialImport);
      }
      for (let i = 0; i < 3; i++) {
        const code = randomBytes(24).toString('base64url');
        if (await p.redis(['SET', PREFIX + p.hash(code), JSON.stringify(room), 'NX'], cfg)) return p.reply(res, 201, { code, room });
      }
      throw new p.HttpError(503, 'Ruang belum berhasil dibuat. Coba lagi.');
    }
    const key = roomKey(req);
    if (body.action !== 'apply') throw new p.HttpError(400, 'Perubahan tidak tersedia.');
    // Compare-and-set retries prevent two phones from overwriting one another.
    for (let attempt = 0; attempt < 6; attempt++) {
      const { raw, room } = await readRoom(key, cfg);
      const next = model.apply(room, body.operation);
      if (next.revision === room.revision) return p.reply(res, 200, { room });
      const stored = await p.redis(['EVAL', CAS, '1', key, raw, JSON.stringify(next)], cfg);
      if (Number(stored)) return p.reply(res, 200, { room: next });
    }
    return p.reply(res, 409, { code: 'RETRY', error: 'Ada perubahan bersamaan. Perubahanmu akan dicoba lagi.' });
  } catch (error) {
    return p.reply(res, error.status || 503, { code: error.code || 'UNAVAILABLE', error: error.status ? error.message : 'Ruang belum dapat dihubungi. Periksa koneksi dan coba lagi.' });
  }
};
