(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NovenaModel = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  function fail(message, code = 'INVALID', status = 400) { throw Object.assign(new Error(message), { code, status }); }
  function person(value) { if (value !== 0 && value !== 1) fail('Pilih salah satu profil.'); return value; }
  function text(value, maximum) { if (typeof value !== 'string' || value.length > maximum) fail('Nama atau intensi tidak valid.'); return value.trim(); }
  function integer(value, minimum, maximum = 1000000) { if (!Number.isInteger(value) || value < minimum || value > maximum) fail('Hitungan doa tidak valid.'); return value; }
  function profile(value) {
    if (!value || typeof value !== 'object') fail('Data lama tidak valid.');
    const name = text(value.name, 25); if (!name) fail('Nama tidak boleh kosong.');
    return { name, intention: text(value.intention || '', 1000), count: integer(value.count, 0, 9), round: integer(value.round, 1), completed: integer(value.completed, 0) };
  }
  function create(names = ['Markus', 'Mega']) {
    if (!Array.isArray(names) || names.length !== 2) fail('Dua nama diperlukan.');
    return { version: 1, revision: 0, people: names.map(name => profile({ name, count: 0, round: 1, completed: 0 })), history: [], imported: [false, false], undo: [null, null], applied: [] };
  }
  function validRoom(room) {
    try {
      if (room?.version !== 1 || !Array.isArray(room.people) || room.people.length !== 2 || !Array.isArray(room.history) || !Array.isArray(room.applied) || !Array.isArray(room.undo) || !Array.isArray(room.imported)) return false;
      integer(room.revision, 0); room.people.forEach(profile); return true;
    } catch { return false; }
  }
  function apply(current, op, now = new Date().toISOString()) {
    if (!validRoom(current)) fail('Data ruang tidak valid.');
    if (!op || typeof op.id !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(op.id)) fail('Identitas perubahan tidak valid.');
    if (current.applied.includes(op.id)) return clone(current);
    const room = clone(current);
    if (op.type === 'profile') {
      if (!Array.isArray(op.changes) || op.changes.length > 2) fail('Perubahan profil tidak valid.');
      for (const change of op.changes) {
        const p = room.people[person(change.person)];
        if (change.name !== undefined) { const name = text(change.name, 25); if (!name) fail('Nama tidak boleh kosong.'); p.name = name; }
        if (change.intention !== undefined) p.intention = text(change.intention, 1000);
      }
    } else {
      const who = person(op.person), p = room.people[who];
      if (op.type === 'attend') {
        room.undo[who] = { id: op.id, before: { count: p.count, round: p.round, completed: p.completed } };
        if (p.count === 9) { p.count = 0; p.round++; }
        p.count++; if (p.count === 9) p.completed++;
        const date = typeof op.date === 'string' && Number.isFinite(Date.parse(op.date)) ? new Date(op.date).toISOString() : now;
        room.history.push({ id: op.id, person: who, count: p.count, round: p.round, date });
        room.imported[who] = true;
      } else if (op.type === 'reset') {
        if (p.count > 0) { p.count = 0; p.round++; }
        room.undo[who] = null; room.imported[who] = true;
      } else if (op.type === 'undo') {
        if (room.undo[who]?.id !== op.target) fail('Absen ini sudah berubah dari perangkat lain. Hitungan terbaru tetap dipakai.', 'STALE_UNDO', 409);
        Object.assign(p, room.undo[who].before);
        room.history = room.history.filter(h => h.id !== op.target);
        room.undo[who] = null;
      } else if (op.type === 'import') {
        if (room.imported[who]) fail('Profil ini sudah mempunyai data di ruang bersama. Matikan pilihan bawa data lama untuk bergabung.', 'IMPORT_EXISTS', 409);
        room.people[who] = profile(op.profile);
        if (!Array.isArray(op.history) || op.history.length > 2000) fail('Riwayat lama terlalu besar atau tidak valid.');
        const ids = new Set(room.history.map(h => h.id));
        for (const item of op.history) {
          if (item.person !== who) fail('Hanya riwayat profil yang dipilih yang boleh dibawa.');
          if (typeof item.id !== 'string' || item.id.length > 200 || !Number.isFinite(Date.parse(item.date))) fail('Riwayat lama tidak valid.');
          if (!ids.has(item.id)) {
            room.history.push({ id: item.id, person: who, count: integer(item.count, 1, 9), round: integer(item.round, 1), date: new Date(item.date).toISOString() });
            ids.add(item.id);
          }
        }
        room.imported[who] = true;
      } else fail('Jenis perubahan tidak tersedia.');
    }
    room.applied.push(op.id); room.revision++;
    room.history.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    return room;
  }
  return { clone, create, apply, profile, validRoom };
});
