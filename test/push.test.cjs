const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, randomBytes } = require('node:crypto');
const webpush = require('web-push');
const p = require('../lib/push.cjs');
const realSend = p.send;
const configHandler = require('../api/push-config');
const subscriptionHandler = require('../api/subscription');
const cronHandler = require('../api/pengingat-doa');
const testHandler = require('../api/test-notification');
const keys = webpush.generateVAPIDKeys();
const origin = 'https://novena.example.com';
function sub(suffix = 'one') {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { endpoint: 'https://web.push.apple.com/' + suffix, keys: { auth: randomBytes(16).toString('base64url'), p256dh: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url') } };
}
function setup(t) {
  const previous = { ...process.env };
  Object.assign(process.env, { APP_ORIGIN: origin, UPSTASH_REDIS_REST_URL: 'https://redis.example.com', UPSTASH_REDIS_REST_TOKEN: 'test-only', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, CRON_SECRET: 'test-secret-at-least-16-characters' });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const hashes = new Map(), values = new Map();
  const hash = key => { if (!hashes.has(key)) hashes.set(key, new Map()); return hashes.get(key); };
  const commands = [];
  t.mock.method(global, 'fetch', async (url, opts) => {
    assert.equal(url, process.env.UPSTASH_REDIS_REST_URL, 'No unexpected outbound request');
    const cmd = JSON.parse(opts.body); commands.push(cmd);
    const [op, key, ...args] = cmd;
    let result;
    if (op === 'HGET') result = hash(key).get(args[0]) ?? null;
    else if (op === 'HGETALL') result = [...hash(key)].flat();
    else if (op === 'HDEL') result = Number(hash(key).delete(args[0]));
    else if (op === 'SET') { if (values.has(key)) result = null; else { values.set(key, args[0]); result = 'OK'; } }
    else if (op === 'DEL') result = Number(values.delete(key));
    else if (op === 'EVAL' && key.includes('INCR')) { const counterKey = args[1]; const n = Number(values.get(counterKey) || 0) + 1; values.set(counterKey, n); result = n; }
    else if (op === 'EVAL' && key.includes('HEXISTS')) { const store = hash(args[1]); if (!store.has(args[2]) && store.size >= 100) result = 0; else { store.set(args[2], args[3]); result = 1; } }
    else throw new Error('Unknown Redis command: ' + op);
    return Response.json({ result });
  });
  const send = t.mock.method(p, 'send', async () => ({ statusCode: 201 }));
  return { hashes, values, commands, send, records: hash(p.SUBSCRIPTIONS), store(s) { hash(p.SUBSCRIPTIONS).set(p.hash(s.endpoint), JSON.stringify({ subscription: s })); } };
}
async function invoke(handler, { method = 'GET', subscription, headers = {} } = {}) {
  const req = { method, headers, body: subscription ? { subscription } : undefined };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await handler(req, res); return res;
}
const auth = () => ({ authorization: 'Bearer ' + process.env.CRON_SECRET });
test('public config contains no private keys or Redis credentials', async t => {
  setup(t); const response = await invoke(configHandler);
  assert.equal(response.code, 200); assert.deepEqual(Object.keys(response.data).sort(), ['configured', 'publicKey']); assert.equal(response.data.publicKey, keys.publicKey);
  delete process.env.VAPID_PRIVATE_KEY;
  assert.equal((await invoke(configHandler)).data.configured, false);
});
test('cron rejects anonymous requests before storage or push', async t => {
  const store = setup(t); const res = await invoke(cronHandler);
  assert.equal(res.code, 401); assert.equal(store.commands.length, 0); assert.equal(store.send.mock.callCount(), 0);
});
test('WIB date changes at exactly 17:00 UTC', () => {
  assert.equal(p.jakartaDate(new Date('2026-10-21T16:59:59Z')), '2026-10-21');
  assert.equal(p.jakartaDate(new Date('2026-10-21T17:00:00Z')), '2026-10-22');
});
test('two devices receive one reminder each, repeated cron is deduplicated', async t => {
  const store = setup(t); store.store(sub('one')); store.store(sub('two'));
  const first = await invoke(cronHandler, { headers: auth() });
  assert.equal(first.code, 200); assert.equal(first.data.sent, 2);
  const second = await invoke(cronHandler, { headers: auth() });
  assert.equal(second.data.sent, 0); assert.equal(second.data.skipped, 2); assert.equal(store.send.mock.callCount(), 2);
});
test('expired device is removed, other device still receives its reminder', async t => {
  const store = setup(t); const dead = sub('expired'); store.store(dead); store.store(sub('healthy'));
  store.send.mock.mockImplementation(async s => { if (s.endpoint === dead.endpoint) throw Object.assign(new Error('Gone'), { statusCode: 410 }); });
  const res = await invoke(cronHandler, { headers: auth() });
  assert.equal(res.code, 200); assert.equal(res.data.removed, 1); assert.equal(res.data.sent, 1); assert.equal(store.records.has(p.hash(dead.endpoint)), false);
});
test('temporary push error leaves device registered and allows a later retry', async t => {
  const store = setup(t); store.store(sub());
  store.send.mock.mockImplementationOnce(async () => { throw Object.assign(new Error('temporary'), { statusCode: 503 }); });
  const failed = await invoke(cronHandler, { headers: auth() });
  assert.equal(failed.code, 502); assert.equal(failed.data.failed, 1); assert.equal(store.records.size, 1);
  const retried = await invoke(cronHandler, { headers: auth() });
  assert.equal(retried.code, 200); assert.equal(retried.data.sent, 1);
});
test('cross-origin registration and arbitrary endpoint URLs are rejected', async t => {
  const store = setup(t); const s = sub();
  assert.equal((await invoke(subscriptionHandler, { method: 'POST', subscription: s, headers: { origin: 'https://other.example.com' } })).code, 403);
  for (const endpoint of ['http://web.push.apple.com/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.attacker.example/a', 'https://user:pass@web.push.apple.com/a']) {
    assert.equal((await invoke(subscriptionHandler, { method: 'POST', subscription: { ...s, endpoint }, headers: { origin } })).code, 400);
  }
  assert.equal(store.records.size, 0);
});
test('registration persists both devices and is idempotent for the same endpoint', async t => {
  const store = setup(t); const one = sub('one'), two = sub('two');
  for (const s of [one, two, one]) assert.equal((await invoke(subscriptionHandler, { method: 'POST', subscription: s, headers: { origin } })).code, 200);
  assert.equal(store.records.size, 2);
});
test('deleting one device requires matching subscription keys and preserves the partner', async t => {
  const store = setup(t); const one = sub('one'), two = sub('two'); store.store(one); store.store(two);
  const forged = { ...one, keys: sub('forged').keys };
  await invoke(subscriptionHandler, { method: 'DELETE', subscription: forged, headers: { origin } });
  assert.equal(store.records.size, 2);
  const res = await invoke(subscriptionHandler, { method: 'DELETE', subscription: one, headers: { origin } });
  assert.equal(res.code, 200); assert.equal(store.records.size, 1); assert.equal(store.records.has(p.hash(two.endpoint)), true);
});
test('test notification only targets registered device and is rate limited', async t => {
  const store = setup(t); const one = sub('one');
  assert.equal((await invoke(testHandler, { method: 'POST', subscription: one, headers: { origin } })).code, 409);
  store.store(one);
  assert.equal((await invoke(testHandler, { method: 'POST', subscription: one, headers: { origin } })).code, 200);
  assert.equal((await invoke(testHandler, { method: 'POST', subscription: one, headers: { origin } })).code, 429);
  assert.equal(store.send.mock.callCount(), 1);
  assert.equal(store.send.mock.calls[0].arguments[2].test, true);
});
test('provider payload is visible and contains no personal prayer or attendance data', async t => {
  setup(t);
  // Exercise the real sender through web-push's transport boundary, without a network request.
  const capture = t.mock.method(webpush, 'sendNotification', async () => ({ statusCode: 201 }));
  await realSend(sub(), p.configuration(), { date: '2026-10-22' });
  const [, payload, options] = capture.mock.calls[0].arguments;
  const parsed = JSON.parse(payload);
  assert.match(parsed.title, /berdoa/); assert.equal(parsed.tag, 'novena-2026-10-22');
  assert.equal(options.TTL, 3600); assert.equal(options.vapidDetails.subject, origin);
  assert.deepEqual(Object.keys(parsed).sort(), ['body', 'tag', 'title']);
});
test('mutating endpoints reject unsupported methods', async t => {
  const store = setup(t);
  for (const handler of [subscriptionHandler, testHandler]) assert.equal((await invoke(handler)).code, 405);
  assert.equal(store.commands.length, 0);
});
