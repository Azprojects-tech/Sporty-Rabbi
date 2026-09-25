import { createHash } from 'node:crypto';

/**
 * Map-compatible cache that survives server restarts by mirroring selected
 * entries into Firestore.
 *
 * - Reads stay synchronous and in-memory (callers keep using get/set/delete
 *   exactly like a Map of { data, timestamp } entries).
 * - Writes for persisted key prefixes are queued and flushed in small batches.
 * - On startup, warm() loads unexpired entries back into memory in one query.
 * - Without Firestore (tests, local dev) it behaves as a plain in-memory Map.
 *
 * Entries expire at `timestamp + ttlMs`, which keeps the existing convention in
 * analyticsService where a shorter/longer TTL is expressed by shifting timestamp.
 */
export function createPersistentCache({
  ttlMs = 3600000,
  getDb = () => null,
  collection = 'apiCache',
  persistPrefixes = [],
  flushIntervalMs = 15000,
  maxWarmEntries = 4000,
  maxDocBytes = 900000,
  now = Date.now,
  logger = console,
} = {}) {
  const memory = new Map();
  const pending = new Map();
  const prefixes = new Set(persistPrefixes);
  let flushTimer = null;
  let flushing = null;
  const stats = { warmed: 0, written: 0, writeErrors: 0, skippedLarge: 0 };

  const prefixOf = (key) => String(key).split(':')[0];
  const shouldPersist = (key) => prefixes.has(prefixOf(key));
  const docIdFor = (key) => createHash('sha1').update(String(key)).digest('hex');
  const expiresAtOf = (entry) => Number(entry?.timestamp || 0) + ttlMs;

  function scheduleFlush() {
    if (flushTimer || !getDb()) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(() => {});
    }, flushIntervalMs);
    // Never keep the process (or a test run) alive just to flush a cache.
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  function set(key, entry) {
    memory.set(key, entry);
    if (shouldPersist(key) && getDb()) {
      pending.set(key, entry);
      scheduleFlush();
    }
    return api;
  }

  function get(key) {
    return memory.get(key);
  }

  function del(key) {
    pending.delete(key);
    return memory.delete(key);
  }

  async function flush() {
    if (flushing) return flushing;
    const db = getDb();
    if (!db || pending.size === 0) return 0;
    const items = [...pending.entries()];
    pending.clear();
    flushing = (async () => {
      let written = 0;
      for (let i = 0; i < items.length; i += 400) {
        const batch = db.batch();
        let inBatch = 0;
        for (const [key, entry] of items.slice(i, i + 400)) {
          const expiresAt = expiresAtOf(entry);
          if (expiresAt <= now()) continue;
          let payload;
          try { payload = JSON.stringify(entry.data); } catch { continue; }
          if (payload == null || payload.length > maxDocBytes) { stats.skippedLarge++; continue; }
          batch.set(db.collection(collection).doc(docIdFor(key)), {
            key: String(key), prefix: prefixOf(key), payload,
            timestamp: Number(entry.timestamp) || now(), expiresAt,
          });
          inBatch++;
        }
        if (!inBatch) continue;
        try {
          await batch.commit();
          written += inBatch;
        } catch (err) {
          stats.writeErrors++;
          logger.warn?.(`[PersistentCache] flush failed (${inBatch} entries kept in memory only): ${err.message}`);
        }
      }
      stats.written += written;
      return written;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function warm() {
    const db = getDb();
    if (!db) return 0;
    try {
      const snap = await db.collection(collection)
        .where('expiresAt', '>', now())
        .orderBy('expiresAt', 'desc')
        .limit(maxWarmEntries)
        .get();
      let loaded = 0;
      for (const doc of snap.docs) {
        const row = doc.data() || {};
        if (!row.key || !shouldPersist(row.key) || memory.has(row.key)) continue;
        try {
          memory.set(row.key, { data: JSON.parse(row.payload), timestamp: Number(row.timestamp) || now() });
          loaded++;
        } catch { /* ignore corrupt rows */ }
      }
      stats.warmed += loaded;
      await pruneExpired(db);
      return loaded;
    } catch (err) {
      logger.warn?.(`[PersistentCache] warm-up skipped: ${err.message}`);
      return 0;
    }
  }

  // Keep the collection small without any console-side TTL configuration.
  async function pruneExpired(db = getDb(), limit = 400) {
    if (!db) return 0;
    try {
      const snap = await db.collection(collection).where('expiresAt', '<=', now()).limit(limit).get();
      if (snap.empty) return 0;
      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
      return snap.size;
    } catch (err) {
      logger.warn?.(`[PersistentCache] prune skipped: ${err.message}`);
      return 0;
    }
  }

  const api = {
    get, set, delete: del,
    has: (key) => memory.has(key),
    keys: () => memory.keys(),
    get size() { return memory.size; },
    flush, warm, pruneExpired,
    status: () => ({ entries: memory.size, pendingWrites: pending.size, persistedPrefixes: [...prefixes], enabled: Boolean(getDb()), ...stats }),
  };
  return api;
}
