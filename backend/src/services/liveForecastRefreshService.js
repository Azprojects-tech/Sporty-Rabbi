import { analyzeV9 } from './agent47Service.js';
import { LIVE_STATUSES, observedNumber } from '../../../shared/forecastMath.js';

// Recompute from stored historical inputs and the newly observed clock/score.
// Never reuse a 0-0 probability just because the score is still 0-0.
export function refreshLiveForecast(current, previous) {
  const inputs = previous?.analysis?.predictionCore?.inputSummary;
  if (!inputs || !LIVE_STATUSES.has(String(current?.status || '').toUpperCase())) return null;
  if (String(current.id) !== String(previous.id)
    || (inputs.season != null && current.season != null && String(inputs.season) !== String(current.season))) return null;
  const cards = side => {
    const currentCards = current[`${side}Cards`] ?? current.cards?.[side];
    const previousCards = previous[`${side}Cards`] ?? previous.cards?.[side];
    return { red:observedNumber(currentCards?.red) ?? observedNumber(previousCards?.red),
      yellow:observedNumber(currentCards?.yellow) ?? observedNumber(previousCards?.yellow) };
  };
  const analysis = analyzeV9({ ...inputs, ...current, odds:null, oddsSnapshot:null,
    homeCards:cards('home'), awayCards:cards('away') });
  return { analysis, confidence:analysis.decisionMetrics?.modelProbability?.value ?? 0,
    decisionProbability:analysis.decisionMetrics?.modelProbability?.value ?? null,
    opportunities:analysis.recommendations.filter(r=>r.marketKey && r.decisionState !== 'NO_BET').slice(0,2).map(r=>r.selection),
    _staleAnalysis:false, _historicalInputsReused:true };
}
