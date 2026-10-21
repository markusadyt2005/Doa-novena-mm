const { createHash, timingSafeEqual } = require('node:crypto');
const webpush = require('web-push');
const SUBSCRIPTIONS = 'novena:subscriptions:v1';
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function databaseConfiguration() {
  // Vercel's Upstash integration supplies KV_REST_API_* automatically.
  // Select a complete pair so values from different databases are never mixed.
  const [redisUrl, redisToken] = [
    [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
    [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN]
  ].find(([url, token]) => url && token) || [];
  const cfg = {
    origin: process.env.APP_ORIGIN,
    redisUrl,
    redisToken
  };
  if (Object.values(cfg).some(value => !value || value !== value.trim())) throw new HttpError(503, 'Penyimpanan bersama belum diaktifkan oleh pengelola web.');
  try {
    const origin = new URL(cfg.origin);
    if (origin.protocol !== 'https:' || origin.origin !== cfg.origin || origin.username || origin.password || new URL(cfg.redisUrl).protocol !== 'https:') throw new Error();
  } catch { throw new HttpError(503, 'Pengaturan penyimpanan belum lengkap. Hubungi pengelola web.'); }
  return cfg;
}
function configuration() {
  const cfg = {
    ...databaseConfiguration(),
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    cronSecret: process.env.CRON_SECRET
  };
  if (Object.values(cfg).some(value => !value || value !== value.trim())) throw new HttpError(503, 'Pengingat belum diaktifkan oleh pengelola web.');
  try {
    const origin = new URL(cfg.origin);
    if (origin.protocol !== 'https:' || origin.origin !== cfg.origin || origin.username || origin.password) throw new Error();
    if (new URL(cfg.redisUrl).protocol !== 'https:' || cfg.cronSecret.length < 16) throw new Error();
    webpush.setVapidDetails(cfg.origin, cfg.publicKey, cfg.privateKey);
  } catch { throw new HttpError(503, 'Pengaturan pengingat belum lengkap. Hubungi pengelola web.'); }
  return cfg;
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function same(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}
function assertOrigin(req, cfg) {
  if (req.headers.origin !== cfg.origin) throw new HttpError(403, 'Buka pengingat dari alamat utama web novena.');
}
function subscriptionFrom(req) {
  let body = req.body;
  try { if (typeof body === 'string' || Buffer.isBuffer(body)) body = JSON.parse(body.toString()); } catch { throw new HttpError(400, 'Data perangkat tidak valid.'); }
  if (!body || Buffer.byteLength(JSON.stringify(body)) > 6000) throw new HttpError(400, 'Data perangkat tidak valid.');
  const s = body.subscription;
  try {
    if (!s || typeof s.endpoint !== 'string' || s.endpoint.length > 2000) throw new Error();
    const url = new URL(s.endpoint);
    const allowed = url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.apple.com') || url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com';
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowed) throw new Error();
    const { p256dh, auth } = s.keys || {};
    if (typeof p256dh !== 'string' || typeof auth !== 'string' || !/^[\w-]+={0,2}$/.test(p256dh) || !/^[\w-]+={0,2}$/.test(auth)) throw new Error();
    const key = Buffer.from(p256dh, 'base64url');
    if (key.length !== 65 || key[0] !== 4 || Buffer.from(auth, 'base64url').length !== 16) throw new Error();
    return { endpoint: s.endpoint, keys: { p256dh, auth } };
  } catch { throw new HttpError(400, 'Pendaftaran notifikasi tidak valid. Aktifkan kembali dari perangkatmu.'); }
}
async function redis(command, cfg = configuration()) {
  const response = await fetch(cfg.redisUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.redisToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new HttpError(503, 'Penyimpanan pengingat sedang tidak tersedia. Coba lagi nanti.');
  const result = await response.json();
  if (result.error) throw new HttpError(503, 'Penyimpanan pengingat sedang tidak tersedia. Coba lagi nanti.');
  return result.result;
}
async function rateLimit(key, maximum, seconds, cfg) {
  const script = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n";
  const count = await redis(['EVAL', script, '1', 'novena:limit:' + key, String(seconds)], cfg);
  if (Number(count) > maximum) throw new HttpError(429, 'Tunggu sebentar sebelum mencoba lagi.');
}
async function ownedRecord(subscription, cfg) {
  const value = await redis(['HGET', SUBSCRIPTIONS, hash(subscription.endpoint)], cfg);
  let record;
  try { record = typeof value === 'string' ? JSON.parse(value) : value; } catch { /* Invalid stored entry is not owned. */ }
  if (!record || !same(record.subscription?.keys?.auth, subscription.keys.auth) || !same(record.subscription?.keys?.p256dh, subscription.keys.p256dh)) throw new HttpError(409, 'Perangkat belum terdaftar. Aktifkan pengingat terlebih dahulu.');
  return record;
}
function jakartaDate(now = new Date()) { return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10); }
async function send(subscription, cfg, { test = false, date = jakartaDate() } = {}) {
  return webpush.sendNotification(subscription, JSON.stringify({
    title: test ? 'Pengingatmu sudah terhubung 🤍' : 'Waktunya berdoa bersama 🤍',
    body: test ? 'Ini notifikasi percobaan Ruang Novena. Sampai bertemu di waktu doa.' : 'Hari yang baru, harapan yang baru. Mari berdoa Novena Tiga Salam Maria.',
    tag: test ? 'novena-percobaan' : 'novena-' + date
  }), { TTL: 3600, urgency: 'high', timeout: 10000, vapidDetails: { subject: cfg.origin, publicKey: cfg.publicKey, privateKey: cfg.privateKey } });
}
function reply(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}
function failure(res, error) {
  // Never log subscription endpoints, tokens, request bodies, or provider responses.
  return reply(res, error.status || 503, { error: error.status ? error.message : 'Pengingat sedang tidak tersedia. Coba lagi nanti.' });
}
module.exports = { SUBSCRIPTIONS, HttpError, configuration, databaseConfiguration, hash, same, assertOrigin, subscriptionFrom, redis, rateLimit, ownedRecord, jakartaDate, send, reply, failure };
