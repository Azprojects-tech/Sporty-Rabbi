export const MARKET = Object.freeze({
  HOME_WIN: 'home_win',
  DRAW: 'draw',
  AWAY_WIN: 'away_win',
  OVER_15: 'over15',
  OVER_25: 'over25',
  OVER_35: 'over35',
  UNDER_25: 'under25',
  BTTS: 'btts',
  NEXT_GOAL_HOME: 'next_goal_home',
  NEXT_GOAL_AWAY: 'next_goal_away',
  NO_MORE_GOAL: 'no_more_goal',
});

export function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function offeredOddsForMarket(odds = {}, marketKey = '') {
  const oddsValue = (v) => {
    const n = finiteNumberOrNull(v);
    return n != null && n > 1 ? n : null;
  };

  switch (marketKey) {
    case MARKET.HOME_WIN: return oddsValue(odds.homeWin ?? odds.home);
    case MARKET.AWAY_WIN: return oddsValue(odds.awayWin ?? odds.away);
    case MARKET.DRAW: return oddsValue(odds.draw);
    case MARKET.OVER_15: return oddsValue(odds.over15);
    case MARKET.OVER_25: return oddsValue(odds.over25);
    case MARKET.OVER_35: return oddsValue(odds.over35);
    case MARKET.UNDER_25: return oddsValue(odds.under25);
    case MARKET.BTTS: return oddsValue(odds.btts);
    default: return null;
  }
}

export function recommendationToMarketKey(recommendation, context = {}) {
  const type = String(recommendation?.type || '').trim();
  const upperType = type.toUpperCase();
  const selection = String(recommendation?.selection || recommendation?.label || '').toLowerCase();
  const home = String(context.home || '').toLowerCase();
  const away = String(context.away || '').toLowerCase();

  if (!type && !selection) return null;
  if (upperType === 'NO_BET' || selection.includes('no bet')) return null;
  if (upperType === 'SNIPER_WATCH' || upperType === 'WATCH_LIVE') return null;

  if (Object.values(MARKET).includes(type)) return type;

  if (upperType === 'WINS_ONLY') {
    if (selection.includes('draw')) return MARKET.DRAW;
    if (home && selection.includes(home)) return MARKET.HOME_WIN;
    if (away && selection.includes(away)) return MARKET.AWAY_WIN;
    if (selection.includes('home')) return MARKET.HOME_WIN;
    if (selection.includes('away')) return MARKET.AWAY_WIN;
    return null;
  }

  if (upperType === 'GOALS_ONLY') {
    if (selection.includes('over 3.5')) return MARKET.OVER_35;
    if (selection.includes('over 2.5')) return MARKET.OVER_25;
    if (selection.includes('over 1.5')) return MARKET.OVER_15;
    if (selection.includes('under 2.5')) return MARKET.UNDER_25;
    if (selection.includes('both teams to score') || selection.includes('btts')) return MARKET.BTTS;
    return null;
  }

  if (upperType === 'NEXT_GOAL') {
    if (selection.includes('no more goal')) return MARKET.NO_MORE_GOAL;
    if (home && selection.includes(home)) return MARKET.NEXT_GOAL_HOME;
    if (away && selection.includes(away)) return MARKET.NEXT_GOAL_AWAY;
    if (selection.includes('home')) return MARKET.NEXT_GOAL_HOME;
    if (selection.includes('away')) return MARKET.NEXT_GOAL_AWAY;
    return null;
  }

  return null;
}

export function getTopExecutableRecommendation(match = {}) {
  const recs = Array.isArray(match.analysis?.recommendations) ? match.analysis.recommendations : [];
  for (const rec of recs) {
    const marketKey = recommendationToMarketKey(rec, { home: match.home, away: match.away });
    if (!marketKey) continue;
    const probability = finiteNumberOrNull(rec.confidence);
    if (probability == null) continue;
    return { recommendation: rec, marketKey, probability };
  }
  return null;
}
