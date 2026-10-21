const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const model = require('../public/state-model.js');
const Sync = require('../public/couple-sync.js');
const p = require('../lib/push.cjs');
const handler = require('../api/couple-room.js');
const op = (type, person = 0, extra = {}) => ({ id: randomUUID(), type, person, ...extra });
function local(person, count) {
  const state = model.create(); state.people[person].count = count;
  state.people[person].intention = 'Intensi pribadi ' + person;
  state.history = Array.from({ length: count }, (_, i) => ({ id: 'local-' + person + '-' + i, person, count: i + 1, round: 1, date: new Date(1700000000000 + i * 1000).toISOString() }));
  return { people: state.people, history: state.history };
}
class Storage {
  constructor() { this.values = new Map(); }
  get length() { return this.values.size; }
  key(i) { return [...this.values.keys()][i] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
function backend(t) {
  const store = new Map();
  t.mock.method(p, 'databaseConfiguration', () => ({ origin: 'https://novena.example.com', redisUrl: 'https://redis.example.com', redisToken: 'test-only' }));
  t.mock.method(p, 'rateLimit', async () => {});
  t.mock.method(p, 'redis', async command => {
    const [name, key, ...args] = command;
    // Force the same interleaving an HTTP storage boundary permits.
    await new Promise(resolve => setImmediate(resolve));
    if (name === 'GET') return store.get(key) || null;
    if (name === 'SET') { if (args.includes('NX') && store.has(key)) return null; store.set(key, args[0]); return 'OK'; }
    if (name === 'EVAL') { const actualKey = args[1], before = args[2], after = args[3]; if (store.get(actualKey) !== before) return 0; store.set(actualKey, after); return 1; }
    throw new Error('Unexpected command ' + name);
  });
  async function request(method, code, body, origin = 'https://novena.example.com') {
    const req = { method, headers: { ...(origin ? { origin } : {}), ...(code ? { authorization: 'Bearer ' + code } : {}) }, body };
    const res = { setHeader() {}, status(status) { this.statusCode = status; return this; }, json(data) { this.body = data; return this; } };
    await handler(req, res);
    if (res.statusCode >= 400) throw Object.assign(new Error(res.body.error), { status: res.statusCode, code: res.body.code });
    return res.body;
  }
  return { request, store };
}
test('model increments each person separately and advances round after nine', () => {
  let room = model.create();
  for (let i = 0; i < 9; i++) room = model.apply(room, op('attend'));
  assert.equal(room.people[0].count, 9); assert.equal(room.people[0].completed, 1); assert.equal(room.people[1].count, 0);
  room = model.apply(room, op('attend'));
  assert.equal(room.people[0].count, 1); assert.equal(room.people[0].round, 2);
});
test('same attendance operation cannot be counted twice after a retry', () => {
  const operation = op('attend'); const once = model.apply(model.create(), operation); const twice = model.apply(once, operation);
  assert.equal(twice.people[0].count, 1); assert.equal(twice.revision, once.revision);
});
test('reset affects one person, and undo cannot overwrite newer attendance', () => {
  const first = op('attend'); let room = model.apply(model.create(), first);
  room = model.apply(room, op('attend', 1));
  room = model.apply(room, op('attend'));
  assert.throws(() => model.apply(room, op('undo', 0, { target: first.id })), { code: 'STALE_UNDO' });
  room = model.apply(room, op('reset'));
  assert.equal(room.people[0].count, 0); assert.equal(room.people[1].count, 1); assert.equal(room.history.length, 3);
});
test('import preserves local profile counts/history and never overwrites the partner', () => {
  const a = local(0, 3), b = local(1, 5);
  let room = model.apply(model.create(), op('import', 0, { profile: a.people[0], history: a.history }));
  room = model.apply(room, op('import', 1, { profile: b.people[1], history: b.history }));
  assert.deepEqual(room.people.map(p => p.count), [3, 5]); assert.equal(room.history.length, 8);
  assert.throws(() => model.apply(room, op('import', 1, { profile: b.people[1], history: b.history })), { code: 'IMPORT_EXISTS' });
});
test('invalid names/counts and cross-profile history are rejected', () => {
  const old = local(1, 1);
  assert.throws(() => model.apply(model.create(), op('import', 0, { profile: old.people[1], history: old.history })));
  assert.throws(() => model.apply(model.create(), op('profile', 0, { changes: [{ person: 0, name: '' }] })));
  assert.throws(() => model.apply(model.create(), op('attend', 2)));
});
test('profile edits apply only changed fields and preserve unrelated partner changes', () => {
  let room = model.create();
  room = model.apply(room, op('profile', 0, { changes: [{ person: 1, intention: 'Intensi baru dari HP pasangan' }] }));
  room = model.apply(room, op('profile', 0, { changes: [{ person: 0, name: 'Markus baru' }] }));
  assert.equal(room.people[1].intention, 'Intensi baru dari HP pasangan'); assert.equal(room.people[0].name, 'Markus baru');
});
test('room access requires an unguessable code and no list endpoint is available', async t => {
  const api = backend(t); const created = await api.request('POST', null, { action: 'create', names: ['Markus', 'Mega'] });
  assert.match(created.code, /^[A-Za-z0-9_-]{32}$/);
  await assert.rejects(api.request('GET', null), { status: 401 });
  await assert.rejects(api.request('GET', 'a'.repeat(32)), { status: 404 });
  assert.ok((await api.request('GET', created.code, undefined, null)).room);
  assert.ok([...api.store.keys()].every(key => !key.includes(created.code)), 'Redis stores only the hash of the room code');
});
test('cross-origin writes fail without creating a room', async t => {
  const api = backend(t);
  await assert.rejects(api.request('POST', null, { action: 'create', names: ['Markus', 'Mega'] }, 'https://other.example.com'), { status: 403 });
  assert.equal(api.store.size, 0);
});
test('two phones writing concurrently preserve both attendance records', async t => {
  const api = backend(t); const { code } = await api.request('POST', null, { action: 'create', names: ['Markus', 'Mega'] });
  await Promise.all([api.request('POST', code, { action: 'apply', operation: op('attend', 0) }), api.request('POST', code, { action: 'apply', operation: op('attend', 1) })]);
  const { room } = await api.request('GET', code);
  assert.deepEqual(room.people.map(p => p.count), [1, 1]); assert.equal(room.history.length, 2);
});
test('two clients can import their own old data and see each others subsequent attendance', async t => {
  const api = backend(t); const oldA = local(0, 2), oldB = local(1, 4);
  const a = new Sync({ storage: new Storage(), request: api.request }), b = new Sync({ storage: new Storage(), request: api.request });
  await a.create(oldA, 0, true); await b.join(a.code, oldB, 1, true);
  await a.flush(); assert.deepEqual(a.base.people.map(p => p.count), [2, 4]);
  await Promise.all([a.dispatch(op('attend', 0)), b.dispatch(op('attend', 1))]);
  await Promise.all([a.flush(), b.flush()]);
  assert.deepEqual(a.base.people.map(p => p.count), [3, 5]); assert.deepEqual(a.base.people, b.base.people);
  assert.ok(a.storage.getItem(Sync.BACKUP)); assert.ok(b.storage.getItem(Sync.BACKUP));
});
test('offline attendance survives reload and syncs exactly once after reconnecting', async t => {
  const api = backend(t); const storage = new Storage(); let offline = false, view;
  const request = (...args) => { if (offline) throw new Error('offline'); return api.request(...args); };
  const a = new Sync({ storage, request, onState: state => { view = state; } });
  await a.create(local(0, 0), 0, false); offline = true;
  await a.dispatch(op('attend', 0)); assert.equal(view.people[0].count, 1); assert.equal(a.pending().length, 1);
  const restored = new Sync({ storage, request, onState: state => { view = state; } }); restored.emit();
  assert.equal(view.people[0].count, 1); offline = false; await restored.flush();
  assert.equal(restored.pending().length, 0); assert.equal(restored.base.people[0].count, 1);
  await restored.flush(); assert.equal(restored.base.people[0].count, 1);
});
test('rejected legacy import does not connect the second client or replace either profile', async t => {
  const api = backend(t), storage = new Storage();
  const a = new Sync({ storage: new Storage(), request: api.request }), b = new Sync({ storage, request: api.request });
  await a.create(local(0, 2), 0, true);
  await assert.rejects(b.join(a.code, local(0, 7), 0, true), { code: 'IMPORT_EXISTS' });
  assert.equal(b.connected, false); assert.equal(storage.getItem(Sync.STORE), null);
  assert.equal((await api.request('GET', a.code)).room.people[0].count, 2);
});
test('lost write response is reconciled without duplicating an attendance', async t => {
  const api = backend(t); const storage = new Storage(); let lose = true;
  const a = new Sync({ storage, request: async (method, code, body) => {
    const result = await api.request(method, code, body);
    if (lose && body?.operation?.type === 'attend') { lose = false; throw new Error('connection lost after commit'); }
    return result;
  } });
  await a.create(local(0, 0), 0, false); await a.dispatch(op('attend'));
  assert.equal(a.pending().length, 1); await a.flush();
  assert.equal(a.pending().length, 0); assert.equal(a.base.people[0].count, 1);
});
test('undo preserves partner attendance written in the meantime', async t => {
  const api = backend(t); const a = new Sync({ storage: new Storage(), request: api.request }), b = new Sync({ storage: new Storage(), request: api.request });
  await a.create(local(0, 0), 0, false); await b.join(a.code, local(1, 0), 1, false);
  const first = op('attend'); await a.dispatch(first); await b.dispatch(op('attend', 1)); await a.dispatch(op('undo', 0, { target: first.id }));
  assert.deepEqual(a.base.people.map(p => p.count), [0, 1]);
});
test('stale undo conflict is reported and never rolls back a newer same-person attendance', async t => {
  const api = backend(t); const a = new Sync({ storage: new Storage(), request: api.request }), b = new Sync({ storage: new Storage(), request: api.request });
  await a.create(local(0, 0), 0, false); await b.join(a.code, local(0, 0), 0, false);
  const first = op('attend'); await a.dispatch(first); await b.dispatch(op('attend'));
  await assert.rejects(a.dispatch(op('undo', 0, { target: first.id })), /sudah berubah/);
  assert.equal(a.base.people[0].count, 2); assert.equal(a.pending().length, 0);
});
test('disconnect is blocked while there is unsent data and never deletes the cloud room', async t => {
  const api = backend(t); let offline = false;
  const a = new Sync({ storage: new Storage(), request: (...args) => { if (offline) throw new Error('offline'); return api.request(...args); } });
  await a.create(local(0, 0), 0, false); const code = a.code; offline = true; await a.dispatch(op('attend'));
  assert.throws(() => a.disconnect(), /menunggu/); offline = false; await a.flush(); a.disconnect();
  assert.equal(a.connected, false); assert.equal((await api.request('GET', code)).room.people[0].count, 1);
});
test('same-browser tabs use separate pending records instead of overwriting their queues', async t => {
  const api = backend(t); const storage = new Storage(); let offline = false;
  const request = (...args) => { if (offline) throw new Error('offline'); return api.request(...args); };
  const a = new Sync({ storage, request }); await a.create(local(0, 0), 0, false);
  const b = new Sync({ storage, request }); offline = true;
  await Promise.all([a.dispatch(op('attend', 0)), b.dispatch(op('attend', 1))]);
  assert.equal(a.pending().length, 2); offline = false; await Promise.all([a.flush(), b.flush()]);
  const { room } = await api.request('GET', a.code);
  assert.deepEqual(room.people.map(p => p.count), [1, 1]);
});
