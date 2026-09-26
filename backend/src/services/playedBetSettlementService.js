import { finalScoreFromProviderFixture } from '../../../shared/forecastMath.js';
import { settleMarketPrediction } from '../../../shared/predictionLedger.js';
import { VOID_FIXTURE_STATUSES, isDoubleSlip, settleDoubleSlip } from '../../../shared/betLogging.js';

const isNumericId = (v) => /^\d+$/.test(String(v));
const kickoffPassed = (kickoffUTC, nowMs) => {
  const kickoff = Date.parse(kickoffUTC);
  return !(Number.isFinite(kickoff) && kickoff > nowMs - 2 * 3600000);
};

/**
 * Apply one fixture's result to the matching leg(s) of a double.
 * Returns the Firestore update, or null when nothing changed.
 */
export function settleDoubleLegsFromFixture(bet, matchId, final, fixtureStatus, stamp) {
  if (!isDoubleSlip(bet)) return null;
  let changed = false;
  const status = String(fixtureStatus || '').toUpperCase();
  const legs = bet.legs.map((leg) => {
    if (String(leg.matchId) !== String(matchId) || (leg.result && leg.result !== 'pending')) return leg;
    if (final) {
      const result = settleMarketPrediction(leg.marketKey, final.home, final.away);
      if (!result) return leg;
      changed = true;
      return { ...leg, result, finalScore: `${final.home}-${final.away}`, settledAt: stamp };
    }
    if (VOID_FIXTURE_STATUSES.has(status)) {
      changed = true;
      return { ...leg, result: 'void', finalStatus: status, settledAt: stamp };
    }
    return leg;
  });
  if (!changed) return null;
  const slip = settleDoubleSlip(legs, bet.odds);
  const update = { legs, result: slip.result, updatedAt: stamp };
  if (slip.result !== 'pending') {
    update.settledAt = stamp;
    update.effectiveOdds = slip.effectiveOdds ?? null;
    update.needsReview = slip.needsReview === true;
    if (slip.note) update.reviewNote = slip.note;
  }
  return update;
}

// Independent of prediction history and kickoff date. One shared, bounded run.
export function createPlayedBetSettler({ loadPending, fetchFixture, save, onSettled = () => {},
  canLaunch = () => true, now = Date.now, maxFixtures = 20, retryMs = 2 * 3600000 }) {
  let flight;
  const attempts = new Map();
  async function run() {
    let checked = 0, settled = 0, failed = 0;
    const pending = await loadPending();
    const grouped = new Map();
    const add = (id, entry) => {
      const key = String(id);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(entry);
    };
    for (const bet of pending) {
      if (bet.source !== 'USER_PLAYED' || bet.result !== 'pending') continue;
      if (isDoubleSlip(bet)) {
        for (const leg of bet.legs) {
          if ((leg.result && leg.result !== 'pending') || !isNumericId(leg.matchId)) continue;
          if (!kickoffPassed(leg.kickoffUTC, now())) continue;
          add(leg.matchId, { bet, double: true });
        }
        continue;
      }
      if (!isNumericId(bet.matchId)) continue;
      if (!kickoffPassed(bet.kickoffUTC, now())) continue;
      add(bet.matchId, { bet, double: false });
    }
    for (const [id, records] of grouped) {
      if (checked >= maxFixtures || !canLaunch()) break;
      if (attempts.has(id) && now() - attempts.get(id) < retryMs) continue;
      checked++;
      attempts.set(id, now());
      try {
        const raw = await fetchFixture(id);
        const sameFixture = String(raw?.fixture?.id) === id;
        const final = sameFixture ? finalScoreFromProviderFixture(raw) : null;
        const status = sameFixture ? raw?.fixture?.status?.short : null;
        for (const { bet, double } of records) {
          const stamp = new Date(now()).toISOString();
          if (double) {
            const update = settleDoubleLegsFromFixture(bet, id, final, status, stamp);
            if (!update) continue;
            await save(bet, update);
            Object.assign(bet, update); // the other leg may be checked later in this run
            onSettled({ ...bet });
            if (update.result !== 'pending') settled++;
            continue;
          }
          if (!final) continue;
          const result = settleMarketPrediction(bet.marketKey, final.home, final.away);
          if (!result) continue;
          const update = { result, finalScore: `${final.home}-${final.away}`, finalStatus: final.status,
            settledAt: stamp, updatedAt: stamp, settlementSource: 'API_FOOTBALL_FIXTURE' };
          await save(bet, update); // Durable write first; a failed save remains retryable.
          onSettled({ ...bet, ...update });
          settled++;
        }
      } catch { attempts.delete(id); failed++; }
    }
    if (attempts.size > 5000) attempts.clear();
    return { checked, settled, failed };
  }
  return () => {
    if (!flight) flight = run().finally(() => { flight = null; });
    return flight;
  };
}
