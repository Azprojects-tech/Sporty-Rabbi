import { getTopExecutableRecommendation, offeredOddsForMarket } from '../../../shared/marketKeys.js';
import { isCurrentPrematchQuote } from './prematchOddsService.js';
import { evaluateValue } from './valueEngine.js';

export const MIN_COMBINED_PROBABILITY = .512;

// A dependence-robust bound from model marginals; this is not a confidence interval.
// No claim of independent fixtures is needed to enforce the requested floor.
export function combinationProbabilityFloor(probabilities) {
  if (!Array.isArray(probabilities) || probabilities.length < 2 || probabilities.length > 3
    || probabilities.some(p => !Number.isFinite(p) || p <= 0 || p >= 1)) return null;
  return Math.max(0, Number((probabilities.reduce((a,b)=>a+b,0) - probabilities.length + 1).toPrecision(15)));
}

export function eligibleTicketCandidates(matches = [], now = Date.now()) {
  return matches.flatMap(match => {
    const quote = match.oddsSnapshot;
    if (match.status !== 'NS' || !Number.isFinite(Date.parse(match.kickoffUTC)) || Date.parse(match.kickoffUTC) <= now
      || !isCurrentPrematchQuote(quote,match.id,now)) return [];
    const selected = getTopExecutableRecommendation(match);
    if (!selected) return [];
    const probability01 = selected.probability / 100;
    const odds = offeredOddsForMarket(quote.odds, selected.marketKey);
    if (evaluateValue({ calibratedProbability: probability01, offeredOdds: odds }).decision !== 'BET') return [];
    return [{ fixtureId: match.id, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
      match: `${match.home} vs ${match.away}`, league: match.league, leagueId: match.leagueId, kickoffUTC: match.kickoffUTC,
      selection: selected.recommendation.selection, selectionType: selected.marketKey,
      probability01, confidence: +(probability01*100).toFixed(1), odds,
      bookmaker: quote.bookmaker, providerUpdatedAt: quote.providerUpdatedAt, oddsSnapshot: quote,
      _match: match }];
  }).sort((a,b)=>b.probability01-a.probability01);
}

export function chooseCombination(candidates, size, used = new Set()) {
  let best = null;
  const pool = candidates.filter(c => !used.has(String(c.fixtureId))).slice(0,30);
  const visit = (legs, start) => {
    if (legs.length === size) {
      if (new Set(legs.map(l=>String(l.fixtureId))).size !== size) return;
      if (new Set(legs.map(l=>String(l.bookmaker.id))).size !== 1) return;
      const teams = legs.flatMap(l => [l.homeTeamId,l.awayTeamId]).filter(Boolean).map(String);
      if (new Set(teams).size !== teams.length) return;
      const jointProbabilityLowerBound = combinationProbabilityFloor(legs.map(l=>l.probability01));
      if (jointProbabilityLowerBound == null || jointProbabilityLowerBound < MIN_COMBINED_PROBABILITY) return;
      const combinedOdds = legs.reduce((o,l)=>o*l.odds,1);
      const expectedValueLowerBound = jointProbabilityLowerBound*combinedOdds-1;
      if (expectedValueLowerBound < .05) return;
      const ticket = { legs, jointProbabilityLowerBound, combinedProbability: jointProbabilityLowerBound*100,
        jointMethod: 'FRECHET_LOWER_BOUND', probabilityLabel: 'Combined probability floor',
        combinedOdds, expectedValueLowerBound, bookmaker: legs[0].bookmaker,
        quoteType: 'STANDARD_ACCUMULATOR_PRICE_PRODUCT' };
      if (!best || ticket.jointProbabilityLowerBound > best.jointProbabilityLowerBound
        || (ticket.jointProbabilityLowerBound === best.jointProbabilityLowerBound && combinedOdds > best.combinedOdds)) best=ticket;
      return;
    }
    for (let i=start;i<pool.length;i++) visit([...legs,pool[i]],i+1);
  };
  visit([],0);
  return best;
}
