import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPersistentCache } from '../src/services/persistentCache.js';
import { buildNarrativeKey } from '../src/services/narrativeKey.js';

// Minimal in-memory stand-in for the Firestore API surface the cache uses.
function fakeFirestore() {
  const docs = new Map();
  const cmp = { '>': (a, b) => a > b, '<=': (a, b) => a <= b };
  const query = (filters = [], order = null, lim = Infinity) => ({
    where: (f, op, v) => query([...filters, [f, op, v]], order, lim),
    orderBy: (f, dir = 'asc') => query(filters, [f, dir], lim),
    limit: (n) => query(filters, order, n),
    get: async () => {
      let rows = [...docs.entries()].filter(([, d]) => filters.every(([f, op, v]) => cmp[op](d[f], v)));
      if (order) rows.sort((a, b) => (order[1] === 'desc' ? -1 : 1) * (a[1][order[0]] - b[1][order[0]]));
      rows = rows.slice(0, lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows.map(([id, d]) => ({ id, data: () => d, ref: { id } })) };
    },
  });
  return {
    docs,
    collection: () => ({ doc: (id) => ({ id }), ...query() }),
    batch: () => {
      const ops = [];
      return {
        set: (ref, data) => ops.push(() => docs.set(ref.id, data)),
        delete: (ref) => ops.push(() => docs.delete(ref.id)),
        commit: async () => ops.forEach((op) => op()),
      };
    },
  };
}

test('persistent cache behaves like a Map without Firestore', () => {
  const cache = createPersistentCache({ ttlMs: 1000, persistPrefixes: ['form'] });
  cache.set('form:1:2:2026', { data: { ok: true }, timestamp: 5 });
  assert.deepEqual(cache.get('form:1:2:2026'), { data: { ok: true }, timestamp: 5 });
  assert.equal(cache.size, 1);
  cache.delete('form:1:2:2026');
  assert.equal(cache.get('form:1:2:2026'), undefined);
});

test('persisted entries survive a simulated restart; others do not', async () => {
  const db = fakeFirestore();
  let clock = 1_000_000;
  const now = () => clock;
  const first = createPersistentCache({ ttlMs: 60_000, getDb: () => db, persistPrefixes: ['form', 'standings'], now, flushIntervalMs: 10 });
  first.set('form:10:39:2026', { data: { avgGoalsFor: '1.40' }, timestamp: clock });
  first.set('standings:39:2026::', { data: { status: 'AVAILABLE' }, timestamp: clock - 30_000 }); // expires in 30 s
  first.set('squadPos:10', { data: { 1: 'striker' }, timestamp: clock }); // not persisted
  assert.equal(await first.flush(), 2);

  clock += 40_000; // standings entry has now expired
  const second = createPersistentCache({ ttlMs: 60_000, getDb: () => db, persistPrefixes: ['form', 'standings'], now });
  const loaded = await second.warm();
  assert.equal(loaded, 1);
  assert.deepEqual(second.get('form:10:39:2026').data, { avgGoalsFor: '1.40' });
  assert.equal(second.get('standings:39:2026::'), undefined);
  assert.equal(second.get('squadPos:10'), undefined);
  // warm() also prunes expired rows so the collection stays small
  assert.equal(db.docs.size, 1);
});

test('persistent cache never blocks process exit (flush timer is unref-ed)', () => {
  const db = fakeFirestore();
  const cache = createPersistentCache({ getDb: () => db, persistPrefixes: ['form'], flushIntervalMs: 60_000 });
  cache.set('form:1', { data: 1, timestamp: Date.now() });
  // If the timer were ref-ed this test file would hang for 60 s; node --test would report it.
  assert.equal(cache.status().pendingWrites, 1);
});

test('narrative cache key is stable across minutes for the same fixture state', async () => {
  const match = { fixtureId: 123, status: 'NS', score: '0-0', oddsSnapshot: { providerUpdatedAt: '2026-09-25T10:00:00Z' } };
  const a = buildNarrativeKey(match);
  await new Promise((r) => setTimeout(r, 5));
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 5 * 60_000; // five minutes later
    assert.equal(buildNarrativeKey(match), a);
  } finally { Date.now = realNow; }
  // …but it does change when the match state changes
  assert.notEqual(buildNarrativeKey({ ...match, status: '1H', matchMinutes: 12, score: '1-0' }), a);
});

test('npm test script works on Node 20 (no shell glob) and tests never import server.js', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test.includes('**'), false, 'Node 20 does not expand ** globs');
  const safety = readFileSync(new URL('./safety.test.js', import.meta.url), 'utf8');
  assert.equal(/from '\.\.\/src\/server\.js'/.test(safety), false, 'importing server.js starts the HTTP server and hangs the test run');
});
