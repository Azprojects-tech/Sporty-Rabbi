import { finalScoreFromProviderFixture } from '../../../shared/forecastMath.js';
import { settleMarketPrediction } from '../../../shared/predictionLedger.js';

// Independent of prediction history and kickoff date. One shared, bounded run.
export function createPlayedBetSettler({ loadPending, fetchFixture, save, onSettled = () => {},
  canLaunch = () => true, now = Date.now, maxFixtures = 20, retryMs = 2 * 3600000 }) {
  let flight;
  const attempts = new Map();
  async function run() {
    let checked = 0, settled = 0, failed = 0;
    const pending = await loadPending();
    const grouped = new Map();
    for (const bet of pending) {
      if (bet.source !== 'USER_PLAYED' || bet.result !== 'pending' || !/^\d+$/.test(String(bet.matchId))) continue;
      const kickoff = Date.parse(bet.kickoffUTC);
      if (Number.isFinite(kickoff) && kickoff > now() - 2 * 3600000) continue;
      const key = String(bet.matchId);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(bet);
    }
    for (const [id, records] of grouped) {
      if (checked >= maxFixtures || !canLaunch()) break;
      if (attempts.has(id) && now() - attempts.get(id) < retryMs) continue;
      checked++;
      attempts.set(id, now());
      try {
        const raw = await fetchFixture(id);
        const final = String(raw?.fixture?.id) === id ? finalScoreFromProviderFixture(raw) : null;
        if (!final) continue;
        for (const bet of records) {
          const result = settleMarketPrediction(bet.marketKey, final.home, final.away);
          if (!result) continue;
          const stamp = new Date(now()).toISOString();
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
