import { MARKET, finiteNumberOrNull, recommendationToMarketKey } from './marketKeys.js';

export const SETTLEABLE_MARKETS = new Set([
  MARKET.HOME_WIN, MARKET.DRAW, MARKET.AWAY_WIN,
  MARKET.OVER_05, MARKET.OVER_15, MARKET.OVER_25, MARKET.OVER_35, MARKET.OVER_45,
  MARKET.UNDER_15, MARKET.UNDER_25, MARKET.UNDER_35, MARKET.UNDER_45,
  MARKET.BTTS,
]);

export function isSettleableMarket(marketKey) {
  return SETTLEABLE_MARKETS.has(String(marketKey || ''));
}

function safeId(value) {
  return String(value ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);
}

export function buildPredictionLedgerId(matchId, preparedDateUK, predictedAt) {
  const stamp = String(predictedAt || new Date().toISOString()).replace(/\D/g, '').slice(0, 14);
  return safeId(`${matchId}_${preparedDateUK || 'unknown'}_${stamp}`);
}

function compactEvidence(evidence = null) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    overallScore: finiteNumberOrNull(evidence.overallScore),
    competitionFamily: evidence.competitionFamily || null,
    competitionProfile: evidence.competitionProfile || null,
    analysisQuality: evidence.analysisQuality ? {
      score: finiteNumberOrNull(evidence.analysisQuality.score),
      paramCoverage: finiteNumberOrNull(evidence.analysisQuality.paramCoverage),
      coreReady: evidence.analysisQuality.coreReady ?? null,
      modelBasis: evidence.analysisQuality.modelBasis || null,
    } : null,
    topFactors: Array.isArray(evidence.topFactors)
      ? evidence.topFactors.slice(0, 4).map((f) => ({
          key: f?.key || null,
          label: f?.label || null,
          score: finiteNumberOrNull(f?.score),
        }))
      : [],
    poisson: evidence.poisson ? {
      expectedGoals: finiteNumberOrNull(evidence.poisson.expectedGoals),
      over25: finiteNumberOrNull(evidence.poisson.over25),
      btts: finiteNumberOrNull(evidence.poisson.btts),
      likelyScore: evidence.poisson.likelyScore || null,
    } : null,
  };
}

export function buildPredictionMarkets(match = {}) {
  const recs = Array.isArray(match.analysis?.recommendations)
    ? match.analysis.recommendations
    : Array.isArray(match.recommendations)
      ? match.recommendations
      : [];

  const seen = new Set();
  const markets = [];
  for (const rec of recs) {
    const marketKey = rec?.marketKey || recommendationToMarketKey(rec, {
      home: match.home,
      away: match.away,
    });
    if (!isSettleableMarket(marketKey)) continue;

    const probability = finiteNumberOrNull(rec?.modelProbability ?? rec?.confidence);
    if (probability == null) continue;

    const selection = String(rec?.selection || rec?.label || marketKey);
    const dedupeKey = marketKey;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    markets.push({
      marketKey,
      selection,
      modelProbability: probability,
      confidence: finiteNumberOrNull(rec?.confidence) ?? probability,
      tier: finiteNumberOrNull(rec?.tier),
      decisionState: rec?.decisionState || null,
      evidence: compactEvidence(rec?.evidence),
      result: 'pending',
    });
  }

  // A decisive Agent47 win call is a genuine prediction even when the
  // recommendation list only contains a goals market.
  const winCall = match.analysis?.winCall || match.winCall || null;
  const winMarketKey = winCall?.outcome === 'HOME'
    ? MARKET.HOME_WIN
    : winCall?.outcome === 'AWAY'
      ? MARKET.AWAY_WIN
      : null;
  const winProbability = finiteNumberOrNull(winCall?.confidence);

  if (winMarketKey && winProbability != null && !seen.has(winMarketKey)) {
    seen.add(winMarketKey);
    markets.push({
      marketKey: winMarketKey,
      selection: String(
        winCall?.selection
        || (winMarketKey === MARKET.HOME_WIN
          ? String(match.home || 'Home') + ' Win'
          : String(match.away || 'Away') + ' Win')
      ),
      modelProbability: winProbability,
      confidence: winProbability,
      tier: null,
      decisionState: null,
      evidence: null,
      source: 'WIN_CALL',
      result: 'pending',
    });
  }

  return markets;
}

export function buildPredictionLedgerDocument(match = {}, options = {}) {
  const predictedAt = options.predictedAt || match.analysis?.analysisTimestamp || new Date().toISOString();
  const preparedDateUK = options.preparedDateUK || null;
  const predictionId = options.predictionId
    || match.predictionId
    || buildPredictionLedgerId(match.id, preparedDateUK, predictedAt);
  const markets = buildPredictionMarkets(match);
  if (markets.length === 0) return null;

  return {
    schemaVersion: 3,
    predictionId,
    snapshotType: 'PRE_MATCH',
    matchId: match.id,
    home: String(match.home || ''),
    away: String(match.away || ''),
    league: String(match.league || 'Unknown'),
    leagueId: finiteNumberOrNull(match.leagueId) ?? 0,
    leagueCountry: match.leagueCountry || '',
    matchType: match.matchType || 'League',
    season: match.season ?? null,
    kickoffUTC: match.kickoffUTC || null,
    preparedDateUK,
    predictedAt,
    analysisVersion: match.analysis?.analysisVersion || null,
    dailySignal: match.analysis?.dailySignal || match.dailySignal || null,
    markets,
    settlementStatus: 'PENDING',
    finalScore: null,
    finalStatus: null,
    settledAt: null,
  };
}

export function normalizePredictionLedgerDocument(doc = {}) {
  const base = { ...doc };
  if (Array.isArray(base.markets)) return base;

  const legacyMatch = {
    home: base.home,
    away: base.away,
    recommendations: Array.isArray(base.recommendations) ? base.recommendations : [],
  };
  return {
    ...base,
    schemaVersion: base.schemaVersion || 1,
    predictionId: base.predictionId || null,
    markets: buildPredictionMarkets(legacyMatch),
    settlementStatus: base.settledAt ? 'SETTLED' : (base.settlementStatus || 'PENDING'),
    finalScore: base.finalScore || null,
  };
}

export function settleMarketPrediction(marketKey, homeGoals, awayGoals) {
  const h = Number(homeGoals);
  const a = Number(awayGoals);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  const total = h + a;

  switch (marketKey) {
    case MARKET.HOME_WIN: return h > a ? 'won' : 'lost';
    case MARKET.DRAW: return h === a ? 'won' : 'lost';
    case MARKET.AWAY_WIN: return a > h ? 'won' : 'lost';
    case MARKET.OVER_05: return total >= 1 ? 'won' : 'lost';
    case MARKET.OVER_15: return total >= 2 ? 'won' : 'lost';
    case MARKET.OVER_25: return total >= 3 ? 'won' : 'lost';
    case MARKET.OVER_35: return total >= 4 ? 'won' : 'lost';
    case MARKET.OVER_45: return total >= 5 ? 'won' : 'lost';
    case MARKET.UNDER_15: return total <= 1 ? 'won' : 'lost';
    case MARKET.UNDER_25: return total <= 2 ? 'won' : 'lost';
    case MARKET.UNDER_35: return total <= 3 ? 'won' : 'lost';
    case MARKET.UNDER_45: return total <= 4 ? 'won' : 'lost';
    case MARKET.BTTS: return h > 0 && a > 0 ? 'won' : 'lost';
    default: return null;
  }
}

export function settlePredictionDocument(doc = {}, homeGoals, awayGoals, settledAt = new Date().toISOString(), finalStatus = 'FT') {
  const normalized = normalizePredictionLedgerDocument(doc);
  let settledCount = 0;
  const markets = (normalized.markets || []).map((market) => {
    const result = settleMarketPrediction(market.marketKey, homeGoals, awayGoals);
    if (!result) return market;
    settledCount += 1;
    return { ...market, result };
  });

  if (settledCount === 0) return normalized;
  return {
    ...normalized,
    markets,
    settlementStatus: 'SETTLED',
    finalScore: `${Number(homeGoals)}-${Number(awayGoals)}`,
    finalStatus,
    settledAt,
  };
}

export function summarizePredictionDocuments(docs = []) {
  const normalized = docs.map(normalizePredictionLedgerDocument);
  const byMarket = {};
  let settledCalls = 0;
  let won = 0;
  let lost = 0;

  for (const doc of normalized) {
    for (const m of doc.markets || []) {
      if (m.result !== 'won' && m.result !== 'lost') continue;
      settledCalls += 1;
      if (m.result === 'won') won += 1;
      else lost += 1;
      if (!byMarket[m.marketKey]) {
        byMarket[m.marketKey] = { marketKey: m.marketKey, settled: 0, won: 0, lost: 0 };
      }
      byMarket[m.marketKey].settled += 1;
      byMarket[m.marketKey][m.result] += 1;
    }
  }

  const markets = Object.values(byMarket)
    .map((m) => ({
      ...m,
      hitRate: m.settled > 0 ? +((m.won / m.settled) * 100).toFixed(1) : null,
    }))
    .sort((a, b) => b.settled - a.settled);

  return {
    matchesRecorded: normalized.length,
    settledCalls,
    won,
    lost,
    hitRate: settledCalls > 0 ? +((won / settledCalls) * 100).toFixed(1) : null,
    markets,
  };
}
