(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./state-model.js'));
  else root.NovenaSync = factory(root.NovenaModel);
})(typeof window === 'object' ? window : globalThis, function (model) {
  'use strict';
  const STORE = 'novena-shared-room-v1', BACKUP = 'novena-before-sync-v1';
  async function transport(method, code, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/couple-room', { method, cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(code ? { Authorization: 'Bearer ' + code } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      let data;
      try { data = await response.json(); } catch { throw new Error('Sinkronisasi belum tersedia. Buka ulang web setelah diperbarui.'); }
      if (!response.ok) throw Object.assign(new Error(data.error || 'Ruang belum dapat dihubungi.'), { status: response.status, code: data.code });
      if (!model.validRoom(data.room)) throw new Error('Balasan ruang belum valid. Coba lagi.');
      return data;
    } finally { clearTimeout(timer); }
  }
  class Sync {
    constructor(options = {}) {
      this.storage = options.storage;
      if (!this.storage) { try { this.storage = localStorage; } catch { /* Local prayer remains available. */ } }
      this.request = options.request || transport;
      this.onState = options.onState || (() => {});
      this.onStatus = options.onStatus || (() => {});
      this.onError = options.onError || (() => {});
      this.code = null; this.base = null; this.person = 0; this.running = null; this.lastOrder = 0; this.rejected = new Map();
      try {
        const saved = JSON.parse(this.storage.getItem(STORE));
        if (/^[A-Za-z0-9_-]{32}$/.test(saved?.code) && model.validRoom(saved.base)) { this.code = saved.code; this.base = saved.base; this.person = saved.person === 1 ? 1 : 0; }
      } catch { /* Never replace local data with an invalid cache. */ }
    }
    get connected() { return !!this.code; }
    prefix() { return STORE + ':pending:' + this.code + ':'; }
    pending() {
      if (!this.code) return [];
      const pending = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (!key?.startsWith(this.prefix())) continue;
        try {
          const item = JSON.parse(this.storage.getItem(key));
          if (item?.operation?.id && !this.base.applied.includes(item.operation.id)) pending.push({ ...item, key });
        } catch { /* Do not interpret malformed cache entries as attendance. */ }
      }
      return pending.sort((a, b) => a.order - b.order || a.operation.id.localeCompare(b.operation.id));
    }
    persist() {
      // Keep the newest acknowledged state when multiple tabs share this browser.
      try {
        const other = JSON.parse(this.storage.getItem(STORE));
        if (other?.code === this.code && model.validRoom(other.base) && other.base.revision > this.base.revision) this.base = other.base;
      } catch { /* Write the valid state below. */ }
      this.storage.setItem(STORE, JSON.stringify({ code: this.code, person: this.person, base: this.base }));
    }
    emit(mode = 'connected', detail = '') {
      if (!this.connected) { this.onStatus({ connected: false, pending: 0, mode: 'local' }); return; }
      let view = model.clone(this.base);
      const pending = this.pending();
      for (const item of pending) {
        try { view = model.apply(view, item.operation); } catch { /* Server resolves conflicting queued changes on reconnect. */ }
      }
      this.onState({ people: view.people, history: view.history });
      this.onStatus({ connected: true, pending: pending.length, mode, detail });
    }
    operation(type, extra = {}) { return { ...extra, type, id: crypto.randomUUID() }; }
    importOperation(local, person) { return this.operation('import', { person, profile: local.people[person], history: local.history.filter(h => h.person === person) }); }
    bind(code, person, room, local) {
      if (!this.storage) throw new Error('Izinkan penyimpanan browser agar ruang dapat diingat di HP ini.');
      if (!this.storage.getItem(BACKUP)) this.storage.setItem(BACKUP, JSON.stringify({ date: new Date().toISOString(), state: local }));
      this.code = code; this.person = person; this.base = room; this.persist(); this.emit();
    }
    async create(local, person, importOld) {
      const data = await this.request('POST', null, { action: 'create', names: local.people.map(p => p.name), ...(importOld ? { initialImport: this.importOperation(local, person) } : {}) });
      this.bind(data.code, person, data.room, local); return data.code;
    }
    async join(code, local, person, importOld) {
      code = code.trim();
      if (!/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('Salin kode ruang lengkap dari HP pasangan.');
      let data = await this.request('GET', code);
      if (importOld) data = await this.request('POST', code, { action: 'apply', operation: this.importOperation(local, person) });
      this.bind(code, person, data.room, local);
    }
    async dispatch(operation) {
      if (!this.connected) throw new Error('Hubungkan ruang terlebih dahulu.');
      let view = this.base;
      for (const item of this.pending()) { try { view = model.apply(view, item.operation); } catch { /* Process other valid operations. */ } }
      model.apply(view, operation); // Do not queue an invalid change.
      this.lastOrder = Math.max(Date.now(), this.lastOrder + 1);
      this.storage.setItem(this.prefix() + operation.id, JSON.stringify({ order: this.lastOrder, operation }));
      this.emit('pending');
      await this.flush();
      if (this.rejected.has(operation.id)) { const message = this.rejected.get(operation.id); this.rejected.delete(operation.id); throw new Error(message); }
      return { queued: this.pending().some(item => item.operation.id === operation.id) };
    }
    async flush() {
      if (!this.connected) return;
      if (this.running) return this.running;
      const code = this.code;
      this.running = (async () => {
        try {
          this.emit('syncing');
          let data = await this.request('GET', code);
          if (this.code !== code) return;
          if (data.room.revision >= this.base.revision) this.base = data.room;
          this.persist();
          for (let count = 0; count < 100; count++) {
            const item = this.pending()[0]; if (!item) break;
            try {
              data = await this.request('POST', code, { action: 'apply', operation: item.operation });
              if (data.room.revision >= this.base.revision) this.base = data.room;
              this.persist(); this.storage.removeItem(item.key);
            } catch (error) {
              if ([400, 409].includes(error.status) && error.code !== 'RETRY') {
                this.storage.removeItem(item.key); this.rejected.set(item.operation.id, error.message); this.onError(error.message);
              } else throw error;
            }
          }
          // An operation acknowledged before a lost response must not be replayed or left behind.
          const prefix = this.prefix(), stale = [];
          for (let i = 0; i < this.storage.length; i++) {
            const key = this.storage.key(i); if (!key?.startsWith(prefix)) continue;
            try { if (this.base.applied.includes(JSON.parse(this.storage.getItem(key)).operation.id)) stale.push(key); } catch { /* Leave invalid entries untouched. */ }
          }
          stale.forEach(key => this.storage.removeItem(key));
          this.emit(this.pending().length ? 'pending' : 'connected');
        } catch (error) { this.emit('offline', error.message || 'Periksa koneksi internet.'); }
      })();
      try { await this.running; } finally { this.running = null; }
    }
    disconnect() {
      if (this.pending().length) throw new Error('Masih ada absen menunggu sinkronisasi. Hubungkan internet sebelum keluar dari ruang.');
      this.storage.removeItem(STORE); this.code = null; this.base = null; this.emit();
    }
    start() {
      this.emit(); this.flush();
      if (this.interval) return;
      this.refresh = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') this.flush(); };
      this.interval = setInterval(this.refresh, 15000);
      if (typeof window !== 'undefined') {
        window.addEventListener('online', this.refresh); window.addEventListener('focus', this.refresh);
        window.addEventListener('storage', this.refresh); document.addEventListener('visibilitychange', this.refresh);
      }
    }
  }
  Sync.STORE = STORE; Sync.BACKUP = BACKUP;
  return Sync;
});
