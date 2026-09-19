import { evaluateValue } from './valueEngine.js';
import { offeredOddsForMarket } from '../../../shared/marketKeys.js';

// Probabilities belong to the forecast. Evidence gates and price decisions must
// never rewrite them, or reject an unrelated market because the first pick fails.
export function decideMarkets(recommendations, core, odds = null) {
  const qualityReady = core?.coreReady && core.reliability >= 55;
  return recommendations.map(rec => {
    const p = core?.poisson?.marketProbabilities?.[rec.marketKey];
    const valid = Number.isFinite(p) && p > 0 && p < 1;
    const price = offeredOddsForMarket(odds || {}, rec.marketKey);
    const value = evaluateValue({ calibratedProbability: valid ? p : null, offeredOdds: price });
    const reason = !valid ? 'PROBABILITY_UNAVAILABLE' : !qualityReady ? 'CORE_EVIDENCE_INCOMPLETE'
      : p < .55 ? 'BELOW_SELECTION_THRESHOLD' : null;
    return { ...rec, probability01: valid ? p : null, modelProbability: valid ? p * 100 : null,
      confidence: valid ? +(p * 100).toFixed(1) : null,
      decisionState: reason ? 'NO_BET' : value.decision,
      value: { ...value, offeredOdds: price, ...(reason ? { decision: 'NO_BET', reason } : {}) },
      evidenceGate: { passed: !reason, reason }, probabilitySource: 'SHARED_SCORE_DISTRIBUTION' };
  }).sort((a,b) => {
    const group = r => r.decisionState === 'BET' ? 0 : r.decisionState === 'NEEDS_PRICE' ? 1 : 2;
    return group(a) - group(b)
      || (group(a) === 0 ? b.value.expectedValue - a.value.expectedValue : 0)
      || (b.probability01 ?? -1) - (a.probability01 ?? -1);
  });
}

export function summarizeMarketDecisions(recommendations = []) {
  const available = recommendations.filter(r => Number.isFinite(r.probability01));
  const highest = [...available].sort((a,b) => b.probability01-a.probability01)[0];
  const best = available.filter(r=>r.decisionState === 'BET')
    .sort((a,b)=>b.value.expectedValue-a.value.expectedValue)[0];
  const brief = r => r ? { marketKey:r.marketKey, selection:r.selection, probability01:r.probability01,
    offeredOdds:r.value?.offeredOdds ?? null, expectedValue:r.value?.expectedValue ?? null } : null;
  return { mostLikely:brief(highest), bestPriced:brief(best),
    rankingBasis:best ? 'EXPECTED_VALUE_AMONG_ELIGIBLE_PRICED_MARKETS' : 'MODEL_PROBABILITY_WITHOUT_CONFIRMED_VALUE' };
}
