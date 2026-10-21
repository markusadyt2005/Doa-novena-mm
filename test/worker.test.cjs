const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const webpush = require('web-push');
test('push worker always displays a notification, including malformed payloads', async () => {
  const handlers = {}, shown = [];
  const self = { addEventListener(name, fn) { handlers[name] = fn; }, location: { origin: 'https://novena.example.com' }, registration: { showNotification: async (title, options) => shown.push({ title, options }) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), { self, URL });
  for (const data of [null, { json() { throw new Error('invalid'); } }, { json: () => ({ title: 'Doa bersama', body: 'Waktunya berdoa', tag: 'today' }) }]) {
    let promise; handlers.push({ data, waitUntil(value) { promise = value; } }); await promise;
  }
  assert.equal(shown.length, 3);
  assert.equal(shown[0].options.data.url, '/ruang-novena.html?doa=1');
  assert.equal(shown[2].title, 'Doa bersama');
});
test('notification tap only opens the same-origin prayer page, ignoring external payload URLs', async () => {
  const handlers = {}; let opened, closed = false;
  const self = { addEventListener(name, fn) { handlers[name] = fn; }, location: { origin: 'https://novena.example.com' }, clients: { matchAll: async () => [], openWindow: async url => { opened = url; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), { self, URL });
  let promise;
  handlers.notificationclick({ notification: { data: { url: 'https://other.example.com' }, close() { closed = true; } }, waitUntil(value) { promise = value; } });
  await promise; assert.equal(closed, true); assert.equal(opened, 'https://novena.example.com/ruang-novena.html?doa=1');
});
test('browser-only setup generates a VAPID pair accepted by web-push without network or storage', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/setup-keys.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes = {};
  vm.runInNewContext(script, {
    document: { getElementById(id) { return nodes[id] ||= {}; }, querySelectorAll: () => [] },
    crypto: webcrypto, Uint8Array,
    atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64')
  });
  await nodes.generate.onclick();
  assert.equal(nodes.result.hidden, false);
  assert.doesNotThrow(() => webpush.setVapidDetails('https://novena.example.com', nodes['public-key'].value, nodes['private-key'].value));
  assert.match(nodes['cron-secret'].value, /^[a-f0-9]{64}$/);
  assert.match(html, /connect-src 'none'/);
});
