(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const enable = $('enable-reminder'), disable = $('disable-reminder'), test = $('test-reminder');
  const status = $('reminder-status'), help = $('reminder-help'), message = $('reminder-message');
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let registration, config, subscription, busy = false;
  const say = text => { message.textContent = text; };
  function render(active = false) {
    enable.hidden = active;
    disable.hidden = !subscription;
    test.hidden = !active;
    enable.disabled = busy || !registration || !config?.configured;
    disable.disabled = test.disabled = busy;
    enable.textContent = busy ? 'Sebentar…' : 'Aktifkan pengingat';
    if (active) status.textContent = 'Aktif di perangkat ini ♡';
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try { response = await fetch(path, { ...options, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, signal: controller.signal }); }
    finally { clearTimeout(timer); }
    let data;
    try { data = await response.json(); } catch { throw new Error('Layanan pengingat belum tersedia. Coba lagi setelah web diperbarui.'); }
    if (!response.ok) throw new Error(data.error || 'Pengingat belum bisa dihubungkan. Coba lagi nanti.');
    return data;
  }
  const body = value => JSON.stringify({ subscription: value.toJSON ? value.toJSON() : value });
  function publicKeyBytes(key) {
    const decoded = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(decoded, char => char.charCodeAt(0));
  }
  async function init() {
    render();
    if (ios && !installed) {
      status.textContent = 'Pasang di Layar Utama iPhone';
      help.textContent = 'Buka web ini di Safari → Bagikan → Tambahkan ke Layar Utama. Buka dari ikonnya, lalu aktifkan pengingat. Ulangi di iPhone pasangan.';
      enable.hidden = true;
      return;
    }
    if (!window.isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      status.textContent = 'Notifikasi belum didukung';
      help.textContent = 'Gunakan iOS 16.4 atau lebih baru, lalu buka web dari ikon Layar Utama. Bacaan dan absen tetap bisa digunakan di sini.';
      enable.hidden = true;
      return;
    }
    if (Notification.permission === 'denied') {
      status.textContent = 'Izin notifikasi belum aktif';
      help.textContent = 'Izinkan notifikasi Ruang Novena di Pengaturan iPhone → Notifikasi, lalu buka kembali aplikasi ini.';
    }
    try {
      const result = await Promise.all([
        request('/api/push-config'),
        navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(() => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Pengingat belum siap. Tutup dan buka kembali web ini.')), 12000);
          navigator.serviceWorker.ready.then(value => { clearTimeout(timer); resolve(value); }, reject);
        }))
      ]);
      [config, registration] = result;
      subscription = await registration.pushManager.getSubscription();
      if (!config.configured) {
        status.textContent = 'Pengingat sedang disiapkan';
        say(config.message);
        render();
        return;
      }
      if (subscription && Notification.permission === 'granted') {
        const expected = publicKeyBytes(config.publicKey);
        const actual = subscription.options?.applicationServerKey;
        if (actual && (new Uint8Array(actual).length !== expected.length || new Uint8Array(actual).some((v, i) => v !== expected[i]))) {
          status.textContent = 'Sambungkan ulang pengingat';
          say('Pengaturan pengingat diperbarui. Tekan Aktifkan pengingat untuk menyambungkan ulang.');
          render(false);
          return;
        }
        await request('/api/subscription', { method: 'POST', body: body(subscription) });
        status.textContent = 'Aktif di perangkat ini ♡';
        render(true);
      } else {
        if (Notification.permission !== 'denied') status.textContent = 'Belum diaktifkan';
        render(false);
      }
    } catch (error) {
      status.textContent = 'Belum terhubung';
      say(error.message || 'Periksa koneksi lalu buka kembali web ini.');
      render(false);
    }
  }
  enable.addEventListener('click', async () => {
    if (busy || !registration || !config?.configured) return;
    if (Notification.permission === 'denied') { say('Izinkan notifikasi melalui Pengaturan iPhone → Notifikasi → Ruang Novena.'); return; }
    busy = true;
    render(false);
    // Request immediately from the user's tap: iOS requires a direct user gesture.
    try {
      const permissionRequest = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
      const permission = await permissionRequest;
      if (permission !== 'granted') { status.textContent = 'Izin notifikasi belum diberikan'; say('Pengingat belum aktif. Kamu bisa mencoba lagi saat siap.'); return; }
      subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const actual = subscription.options?.applicationServerKey;
        const expected = publicKeyBytes(config.publicKey);
        if (actual && (new Uint8Array(actual).length !== expected.length || new Uint8Array(actual).some((v, i) => v !== expected[i]))) {
          await subscription.unsubscribe(); subscription = null;
        }
      }
      if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(config.publicKey) });
      await request('/api/subscription', { method: 'POST', body: body(subscription) });
      status.textContent = 'Aktif di perangkat ini ♡';
      say('Pengingat terjadwal setiap hari pukul 00.00 WIB. Coba tombol Tes notifikasi untuk memeriksa iPhone ini.');
      render(true);
    } catch (error) {
      // Permission alone is insufficient: do not show active before the server saves the device.
      status.textContent = 'Pengingat belum tersimpan';
      say(error.message || 'Pendaftaran belum berhasil. Periksa koneksi dan coba lagi.');
    } finally { busy = false; render(status.textContent === 'Aktif di perangkat ini ♡'); }
  });
  disable.addEventListener('click', async () => {
    if (busy) return;
    busy = true; render(true);
    try {
      const current = await registration.pushManager.getSubscription();
      if (current) {
        const serialized = current.toJSON();
        const stopped = await current.unsubscribe();
        if (!stopped) throw new Error('Pengingat belum bisa dimatikan. Coba lagi.');
        // Even offline, unsubscribing at the provider stops delivery to this device.
        try { await request('/api/subscription', { method: 'DELETE', body: body(serialized) }); } catch { /* The cron removes expired provider subscriptions. */ }
      }
      subscription = null; status.textContent = 'Pengingat dimatikan';
      say('iPhone ini tidak lagi menerima pengingat. Perangkat pasangan tetap mengikuti pengaturannya sendiri.');
    } catch (error) { say(error.message); }
    finally { busy = false; render(subscription !== null && status.textContent !== 'Pengingat dimatikan'); }
  });
  test.addEventListener('click', async () => {
    if (busy) return;
    busy = true; render(true);
    try {
      const current = await registration.pushManager.getSubscription();
      if (!current) throw new Error('Aktifkan kembali pengingat terlebih dahulu.');
      await request('/api/test-notification', { method: 'POST', body: body(current) });
      say('Notifikasi percobaan sudah dikirim. Periksa Pusat Notifikasi; bunyi dan tampilannya mengikuti pengaturan iPhone.');
    } catch (error) { say(error.message); }
    finally { busy = false; render(true); }
  });
  if (new URLSearchParams(location.search).get('doa') === '1') document.querySelector('[data-page="prayers"]').click();
  init();
})();
