import { buildCalibrationMap, extractSettledPicks } from '../../../shared/pickCalibration.js';
import { CORNERS_COLLECTION, cornersDocsForCalibration } from './cornersService.js';

/**
 * Keeps the "corrected chance" map fresh.
 * - On boot: loads the last saved map (one Firestore read).
 * - Daily (and on demand): rebuilds from the settled prediction ledger,
 *   paging through a rolling window, and saves the result.
 * The in-memory map is only replaced after a successful rebuild, so a failed
 * read never leaves the app without corrections.
 */
export const CALIBRATION_DOC = { collection: 'modelCalibration', id: 'current' };

function compactDoc(d = {}) {
  return {
    matchId: d.matchId,
    predictedAt: d.predictedAt || null,
    kickoffUTC: d.kickoffUTC || null,
    analysisVersion: d.analysisVersion || null,
    leagueId: d.leagueId ?? 0,
    leagueCountry: d.leagueCountry || '',
    matchType: d.matchType || '',
    markets: (Array.isArray(d.markets) ? d.markets : []).map((m) => ({
      marketKey: m?.marketKey,
      source: m?.source || null,
      result: m?.result || null,
      modelProbability: m?.modelProbability ?? null,
      probability01: m?.probability01 ?? null,
      confidence: m?.confidence ?? null,
    })),
  };
}

export function createPickCalibrationService({
  getDb,
  now = () => Date.now(),
  windowDays = 120,
  pageSize = 500,
  maxAgeMs = 24 * 3600000,
  log = console,
} = {}) {
  let map = null;
  let inFlight = null;

  async function loadStored() {
    const db = getDb?.();
    if (!db) return null;
    try {
      const snap = await db.collection(CALIBRATION_DOC.collection).doc(CALIBRATION_DOC.id).get();
      if (snap.exists && snap.data()?.markets) map = snap.data();
    } catch (err) { log.warn?.('[Calibration] Stored map unavailable:', err.message); }
    return map;
  }

  async function readLedger(db) {
    const cutoff = new Date(now() - windowDays * 86400000).toISOString();
    const docs = [];
    let last = null;
    for (;;) {
      let query = db.collection('predictions').where('predictedAt', '>=', cutoff).orderBy('predictedAt').limit(pageSize);
      if (last) query = query.startAfter(last);
      const snap = await query.get();
      for (const d of snap.docs) docs.push(compactDoc(d.data()));
      if (snap.docs.length < pageSize) break;
      last = snap.docs[snap.docs.length - 1];
    }
    // Settled corners predictions live in their own (small) collection.
    try {
      const corners = await db.collection(CORNERS_COLLECTION).where('result', '==', 'settled').get();
      docs.push(...cornersDocsForCalibration(corners.docs.map((d) => d.data())));
    } catch (err) { log.warn?.('[Calibration] Corners history unavailable:', err.message); }
    return docs;
  }

  async function rebuild(trigger = 'manual') {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const db = getDb?.();
      if (!db) return { ok: false, reason: 'STORAGE_UNAVAILABLE' };
      const docs = await readLedger(db);
      const picks = extractSettledPicks(docs);
      const next = buildCalibrationMap(picks, { now: new Date(now()).toISOString() });
      next.trigger = trigger;
      next.windowDays = windowDays;
      next.documentsRead = docs.length;
      map = next;
      try { await db.collection(CALIBRATION_DOC.collection).doc(CALIBRATION_DOC.id).set(next); }
      catch (err) { log.warn?.('[Calibration] Save failed (map still used in memory):', err.message); }
      log.log?.(`[Calibration] ${trigger}: ${picks.length} settled picks from ${docs.length} ledger documents`);
      return { ok: true, picks: picks.length, documents: docs.length, builtAt: next.builtAt };
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  /** Rebuild only when there is no map or it is older than maxAgeMs. */
  async function refreshIfStale(trigger = 'stale-check') {
    if (!map) await loadStored();
    const age = map?.builtAt ? now() - Date.parse(map.builtAt) : Infinity;
    if (!(age < maxAgeMs)) return rebuild(trigger);
    return { ok: true, skipped: true, builtAt: map.builtAt };
  }

  return {
    getMap: () => map,
    setMap: (m) => { map = m; },
    loadStored,
    rebuild,
    refreshIfStale,
  };
}
