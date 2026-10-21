'use strict';
// No page cache: keep the existing prayer text and attendance updates fresh.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let payload = {};
  try { const data = event.data ? event.data.json() : {}; if (data && typeof data === 'object') payload = data; } catch { /* Still show a visible reminder. */ }
  event.waitUntil(self.registration.showNotification(payload.title || 'Waktunya berdoa bersama 🤍', {
    body: payload.body || 'Mari luangkan waktu untuk Novena Tiga Salam Maria.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'novena-harian',
    data: { url: '/ruang-novena.html?doa=1' }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL('/ruang-novena.html?doa=1', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      try { await existing.navigate(target); return await existing.focus(); } catch { /* Open a fresh window below. */ }
    }
    return self.clients.openWindow(target);
  })());
});
