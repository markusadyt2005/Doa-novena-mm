const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '../public/reminders.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function load({ ios = false, installed = true, permission = 'default', configReady = true, registerFails = false } = {}) {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, { textContent: '', hidden: false, disabled: false, events: {}, addEventListener(name, fn) { this.events[name] = fn; }, click() { return this.events.click?.(); } }); return elements.get(id); };
  const calls = []; let permissionCalls = 0, browserSub = null;
  const registeredSub = { options: {}, toJSON: () => ({ endpoint: 'https://web.push.apple.com/test', keys: { p256dh: 'public', auth: 'auth' } }), unsubscribe: async () => { browserSub = null; return true; } };
  const registration = { pushManager: { getSubscription: async () => browserSub, subscribe: async () => { browserSub = registeredSub; return registeredSub; } } };
  const notification = { permission, requestPermission() { permissionCalls++; this.permission = 'granted'; return Promise.resolve('granted'); } };
  const context = {
    document: { getElementById: el, querySelector: () => el('nav-prayers') },
    navigator: { userAgent: ios ? 'iPhone' : 'test-browser', platform: '', maxTouchPoints: 0, standalone: installed, serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } },
    window: { isSecureContext: true, matchMedia: () => ({ matches: installed }), PushManager: {}, Notification: notification },
    Notification: notification, location: { search: '' }, AbortController, URLSearchParams, Uint8Array,
    atob: str => Buffer.from(str, 'base64').toString('binary'), setTimeout, clearTimeout,
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      if (url === '/api/push-config') return Response.json({ configured: configReady, publicKey: 'BAAA', message: 'Pengingat belum diaktifkan oleh pengelola web.' });
      if (registerFails && opts.method === 'POST' && url === '/api/subscription') return Response.json({ error: 'Penyimpanan sedang tidak tersedia.' }, { status: 503 });
      return Response.json({ ok: true });
    }
  };
  vm.runInNewContext(script, context);
  await settle(); await settle();
  return { el, calls, permissionCalls: () => permissionCalls, notification };
}
test('iPhone Safari gives Home Screen instructions without asking notification permission', async () => {
  const page = await load({ ios: true, installed: false });
  assert.match(page.el('reminder-help').textContent, /Tambahkan ke Layar Utama/);
  assert.equal(page.el('enable-reminder').hidden, true); assert.equal(page.permissionCalls(), 0); assert.equal(page.calls.length, 0);
});
test('permission is requested only on enable tap and active requires server registration', async () => {
  const page = await load();
  assert.equal(page.permissionCalls(), 0);
  const promise = page.el('enable-reminder').click();
  assert.equal(page.permissionCalls(), 1, 'The permission request occurs synchronously with the tap');
  await promise;
  assert.equal(page.el('reminder-status').textContent, 'Aktif di perangkat ini ♡');
  assert.equal(page.el('test-reminder').hidden, false);
  assert.equal(page.calls.filter(call => call.url === '/api/subscription').length, 1);
});
test('allowed notification permission does not falsely report active on storage failure', async () => {
  const page = await load({ registerFails: true });
  await page.el('enable-reminder').click();
  assert.equal(page.el('reminder-status').textContent, 'Pengingat belum tersimpan');
  assert.equal(page.el('test-reminder').hidden, true);
  assert.equal(page.el('disable-reminder').hidden, false, 'A native subscription can still be stopped when the backend is unavailable');
});
test('missing Vercel environment leaves reminders disabled without prompting permission', async () => {
  const page = await load({ configReady: false });
  assert.equal(page.el('enable-reminder').disabled, true);
  assert.match(page.el('reminder-status').textContent, /disiapkan/); assert.equal(page.permissionCalls(), 0);
});
test('denied permission explains iPhone settings and does not ask again automatically', async () => {
  const page = await load({ permission: 'denied' });
  await page.el('enable-reminder').click();
  assert.equal(page.permissionCalls(), 0); assert.match(page.el('reminder-message').textContent, /Pengaturan iPhone/);
});
test('disable stops only this native subscription and unregisters it at the server', async () => {
  const page = await load(); await page.el('enable-reminder').click(); await page.el('disable-reminder').click();
  assert.equal(page.el('reminder-status').textContent, 'Pengingat dimatikan'); assert.equal(page.el('test-reminder').hidden, true);
  assert.ok(page.calls.some(call => call.url === '/api/subscription' && call.opts.method === 'DELETE'));
});
