/**
 * Corrected chance (calibration) and price check (V10.8).
 *
 * The engine's stated probabilities run too high in some markets. This module
 * learns, from SportyRabbi's own settled picks, how often picks at each stated
 * level actually won, and maps a stated chance to a "corrected chance".
 *
 * Method, per market:
 *   1. Group settled picks into 5-point bands of stated chance.
 *   2. Shrink each band's observed win rate toward its stated chance, so a band
 *      with few picks moves only a little (BAND_PRIOR_PICKS pseudo-picks).
 *   3. Make the result non-decreasing (isotonic / pool-adjacent-violators), so a
 *      higher stated chance never maps to a lower corrected chance.
 *   4. Interpolate linearly between bands.
 * Markets with too little history borrow their family's map (all 1X2, all
 * Overs, all Unders); failing that the stated chance is used unchanged.
 * A league adjustment (heavily shrunk) and an internationals adjustment are
 * then added where the data supports them.
 *
 * Nothing here hides a pick. It only adds numbers and an optional warning.
 */
import { MARKET, finiteNumberOrNull, offeredOddsForMarket } from './marketKeys.js';

export const CALIBRATION_SCHEMA = 1;
export const BAND_WIDTH = 5;
export const BAND_PRIOR_PICKS = 30;
export const MIN_MARKET_PICKS = 150;
export const LEAGUE_PRIOR_PICKS = 150;
export const MIN_LEAGUE_PICKS = 60;
export const MAX_LEAGUE_ADJUSTMENT = 12;
export const OVERRATED_GAP = 8;       // percentage points
export const OVERRATED_MIN_PICKS = 200;
export const MIN_ODDS_MARGIN = 1.05;  // "worth taking" needs a 5% cushion over the corrected chance
export const OVERRATED_WARNING = 'Historically overrated: check odds';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;

export function marketFamily(marketKey) {
  const k = String(marketKey || '');
  if (k === MARKET.HOME_WIN || k === MARKET.AWAY_WIN || k === MARKET.DRAW) return 'result';
  if (k.startsWith('over')) return 'overs';
  if (k.startsWith('under')) return 'unders';
  if (k === MARKET.BTTS) return 'btts';
  return null;
}

export function isInternationalContext({ leagueCountry, country, matchType } = {}) {
  const c = String(leagueCountry ?? country ?? '').trim().toLowerCase();
  return c === 'world' || String(matchType || '').toLowerCase() === 'international';
}

/** A stored probability may be 0–1 (probability01) or 0–100 (modelProbability). */
function statedPercent(market = {}) {
  const pct = finiteNumberOrNull(market.modelProbability ?? market.confidence);
  if (pct != null && pct > 0 && pct < 100) return pct;
  const p01 = finiteNumberOrNull(market.probability01);
  if (p01 != null && p01 > 0 && p01 < 1) return p01 * 100;
  return null;
}

/**
 * Settled picks from prediction ledger documents, cleaned the same way as the
 * logic audit: V10 engine only, recommendation picks (win-call rows are a
 * separate legacy signal), made before kickoff, first prediction per
 * match+market kept.
 */
export function extractSettledPicks(docs = [], { versionPrefix = 'V10', includeWinCalls = false } = {}) {
  const sorted = [...(Array.isArray(docs) ? docs : [])]
    .filter((d) => d && Array.isArray(d.markets))
    .sort((a, b) => String(a.predictedAt || '').localeCompare(String(b.predictedAt || '')));
  const seen = new Set();
  const picks = [];
  for (const doc of sorted) {
    if (versionPrefix && !String(doc.analysisVersion || '').startsWith(versionPrefix)) continue;
    const predicted = Date.parse(doc.predictedAt || '');
    const kickoff = Date.parse(doc.kickoffUTC || '');
    const afterKickoff = Number.isFinite(predicted) && Number.isFinite(kickoff) && predicted >= kickoff;
    for (const m of doc.markets) {
      if (!marketFamily(m?.marketKey)) continue;
      if (!includeWinCalls && m.source === 'WIN_CALL') continue;
      const key = `${doc.matchId}|${m.marketKey}`;
      const first = !seen.has(key);
      seen.add(key);
      if (!first || afterKickoff) continue;
      if (m.result !== 'won' && m.result !== 'lost') continue;
      const p = statedPercent(m);
      if (p == null) continue;
      picks.push({
        marketKey: m.marketKey,
        p,
        won: m.result === 'won' ? 1 : 0,
        leagueId: finiteNumberOrNull(doc.leagueId) ?? 0,
        international: isInternationalContext(doc),
      });
    }
  }
  return picks;
}

function summarise(picks) {
  const n = picks.length;
  if (!n) return { picks: 0, statedAvg: null, actualRate: null, gap: null };
  const stated = picks.reduce((s, x) => s + x.p, 0) / n;
  const actual = (picks.reduce((s, x) => s + x.won, 0) / n) * 100;
  return { picks: n, statedAvg: round1(stated), actualRate: round1(actual), gap: round1(actual - stated) };
}

/** Pool-adjacent-violators: weighted non-decreasing fit. */
export function isotonic(values, weights) {
  const blocks = [];
  for (let i = 0; i < values.length; i++) {
    blocks.push({ v: values[i], w: weights[i], count: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
      const b = blocks.pop();
      const a = blocks.pop();
      const w = a.w + b.w;
      blocks.push({ v: (a.v * a.w + b.v * b.w) / w, w, count: a.count + b.count });
    }
  }
  const out = [];
  for (const b of blocks) for (let i = 0; i < b.count; i++) out.push(b.v);
  return out;
}

/**
 * Fit one stated→actual curve. Returns knots [{ x: statedPct, y: correctedPct, n: picks }, ...]
 * (objects, not nested arrays, because Firestore cannot store arrays of arrays).
 */
export function fitCurve(picks, { bandWidth = BAND_WIDTH, priorPicks = BAND_PRIOR_PICKS } = {}) {
  const bands = new Map();
  for (const x of picks) {
    const b = Math.min(Math.floor(x.p / bandWidth), Math.floor(99.999 / bandWidth));
    if (!bands.has(b)) bands.set(b, { n: 0, sumP: 0, won: 0 });
    const band = bands.get(b);
    band.n++; band.sumP += x.p; band.won += x.won;
  }
  const ordered = [...bands.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  if (!ordered.length) return [];
  const xs = ordered.map((b) => b.sumP / b.n);
  const shrunk = ordered.map((b, i) => ((b.won * 100) + priorPicks * xs[i]) / (b.n + priorPicks));
  const fitted = isotonic(shrunk, ordered.map((b) => b.n + priorPicks));
  return xs.map((x, i) => ({ x: round1(x), y: round1(fitted[i]), n: ordered[i].n }));
}

/** Apply a curve. Above the fitted range the top band's shift is kept; below it, its ratio. */
export function applyCurve(knots, statedPct) {
  const p = finiteNumberOrNull(statedPct);
  if (p == null) return null;
  if (!Array.isArray(knots) || !knots.length) return p;
  const first = knots[0];
  const last = knots[knots.length - 1];
  // Below the lowest band there is little history: scale proportionally so a
  // small stated chance stays small (an additive shift could push it to ~0).
  if (p <= first.x) return clamp(first.x > 0 ? p * (first.y / first.x) : p, 0.5, 99.5);
  if (p >= last.x) return clamp(p + (last.y - last.x), 0.5, 99.5);
  for (let i = 1; i < knots.length; i++) {
    const a = knots[i - 1];
    const b = knots[i];
    if (p <= b.x) {
      const t = b.x === a.x ? 0 : (p - a.x) / (b.x - a.x);
      return clamp(a.y + t * (b.y - a.y), 0.5, 99.5);
    }
  }
  return p;
}

/** Build the whole correction map from settled picks. Pure and deterministic. */
export function buildCalibrationMap(picks = [], { now = new Date().toISOString() } = {}) {
  const byMarket = new Map();
  const byFamily = new Map();
  for (const x of picks) {
    if (!byMarket.has(x.marketKey)) byMarket.set(x.marketKey, []);
    byMarket.get(x.marketKey).push(x);
    const fam = marketFamily(x.marketKey);
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(x);
  }
  const families = {};
  for (const [fam, list] of byFamily) {
    families[fam] = { ...summarise(list), knots: list.length >= MIN_MARKET_PICKS ? fitCurve(list) : [] };
  }
  const markets = {};
  for (const [key, list] of byMarket) {
    const own = list.length >= MIN_MARKET_PICKS;
    const summary = summarise(list);
    markets[key] = {
      ...summary,
      basis: own ? 'market' : (families[marketFamily(key)]?.knots?.length ? 'family' : 'none'),
      knots: own ? fitCurve(list) : [],
      overrated: summary.picks >= OVERRATED_MIN_PICKS && summary.gap != null && summary.gap <= -OVERRATED_GAP,
    };
  }

  // League and internationals adjustments: average (actual − market-corrected)
  // over the league's picks, shrunk toward zero.
  const residual = (x) => (x.won * 100) - correctedFromMarkets({ markets, families }, x.marketKey, x.p);
  const leagueAgg = new Map();
  const intl = { n: 0, sum: 0, stated: 0, won: 0 };
  for (const x of picks) {
    const r = residual(x);
    const id = String(x.leagueId || 0);
    if (!leagueAgg.has(id)) leagueAgg.set(id, { n: 0, sum: 0, stated: 0, won: 0 });
    const a = leagueAgg.get(id);
    a.n++; a.sum += r; a.stated += x.p; a.won += x.won;
    if (x.international) { intl.n++; intl.sum += r; intl.stated += x.p; intl.won += x.won; }
  }
  const shrinkAdj = (a) => round1(clamp(a.sum / (a.n + LEAGUE_PRIOR_PICKS), -MAX_LEAGUE_ADJUSTMENT, MAX_LEAGUE_ADJUSTMENT));
  const leagues = {};
  for (const [id, a] of leagueAgg) {
    if (id === '0' || a.n < MIN_LEAGUE_PICKS) continue;
    const adjustment = shrinkAdj(a);
    if (Math.abs(adjustment) < 1) continue; // keep the stored map small
    leagues[id] = { picks: a.n, statedAvg: round1(a.stated / a.n), actualRate: round1((a.won / a.n) * 100), adjustment };
  }
  const internationals = intl.n >= MIN_LEAGUE_PICKS
    ? { picks: intl.n, statedAvg: round1(intl.stated / intl.n), actualRate: round1((intl.won / intl.n) * 100), adjustment: shrinkAdj(intl) }
    : { picks: intl.n, adjustment: 0 };

  return {
    schemaVersion: CALIBRATION_SCHEMA,
    builtAt: now,
    totalPicks: picks.length,
    overall: summarise(picks),
    markets,
    families,
    leagues,
    internationals,
  };
}

function correctedFromMarkets(map, marketKey, statedPct) {
  const m = map?.markets?.[marketKey];
  if (m?.knots?.length) return applyCurve(m.knots, statedPct);
  const fam = map?.families?.[marketFamily(marketKey)];
  if (fam?.knots?.length) return applyCurve(fam.knots, statedPct);
  return finiteNumberOrNull(statedPct);
}

/**
 * Corrected chance for one pick, in percent (one decimal), or null when the
 * stated chance is unknown. `context` may carry leagueId / leagueCountry / matchType.
 */
export function correctedChance(map, marketKey, statedPct, context = {}) {
  const p = finiteNumberOrNull(statedPct);
  if (p == null || p <= 0 || p >= 100) return null;
  let value = correctedFromMarkets(map, marketKey, p);
  const league = map?.leagues?.[String(finiteNumberOrNull(context.leagueId) ?? 0)];
  if (league) value += league.adjustment;
  else if (isInternationalContext(context) && map?.internationals?.adjustment) value += map.internationals.adjustment;
  return round1(clamp(value, 1, 99));
}

/** 1.05 ÷ corrected chance, to 2 decimal places. */
export function minimumOddsWorthTaking(correctedPct, margin = MIN_ODDS_MARGIN) {
  const p = finiteNumberOrNull(correctedPct);
  if (p == null || p <= 0 || p >= 100) return null;
  return Math.round((margin / (p / 100)) * 100) / 100;
}

// Every outcome of a market, so the bookmaker margin can be spread out.
const OUTCOME_GROUPS = {
  [MARKET.HOME_WIN]: ['homeWin', 'draw', 'awayWin'],
  [MARKET.DRAW]: ['homeWin', 'draw', 'awayWin'],
  [MARKET.AWAY_WIN]: ['homeWin', 'draw', 'awayWin'],
  [MARKET.BTTS]: ['btts', 'bttsNo'],
};
const SELECTION_FIELD = { [MARKET.HOME_WIN]: 'homeWin', [MARKET.DRAW]: 'draw', [MARKET.AWAY_WIN]: 'awayWin', [MARKET.BTTS]: 'btts' };
for (const line of ['05', '15', '25', '35', '45']) {
  OUTCOME_GROUPS[`over${line}`] = [`over${line}`, `under${line}`];
  OUTCOME_GROUPS[`under${line}`] = [`over${line}`, `under${line}`];
  SELECTION_FIELD[`over${line}`] = `over${line}`;
  SELECTION_FIELD[`under${line}`] = `under${line}`;
}

/**
 * Remove the bookmaker margin by normalising implied probabilities across all
 * outcomes of the market. Returns null fields (with a reason) when any outcome
 * price is missing — a one-sided price cannot be de-margined.
 */
export function fairMarketChance(odds = {}, marketKey) {
  const group = OUTCOME_GROUPS[marketKey];
  const field = SELECTION_FIELD[marketKey];
  if (!group || !field) return { fairChance: null, margin: null, reason: 'MARKET_NOT_SUPPORTED' };
  const prices = group.map((f) => {
    const n = finiteNumberOrNull(odds?.[f] ?? (f === 'homeWin' ? odds?.home : f === 'awayWin' ? odds?.away : undefined));
    return n != null && n > 1 ? n : null;
  });
  if (prices.some((p) => p == null)) return { fairChance: null, margin: null, reason: 'INCOMPLETE_MARKET' };
  const implied = prices.map((p) => 1 / p);
  const total = implied.reduce((s, v) => s + v, 0);
  const selected = implied[group.indexOf(field)];
  return {
    fairChance: round1((selected / total) * 100),
    margin: round1((total - 1) * 100),
    reason: null,
  };
}

/**
 * Everything the pick card needs: stated and corrected chance, fair market
 * chance (if a full current market price exists), minimum SportyBet odds and
 * the overrated warning. Never removes or mutes the pick.
 */
export function buildPriceCheck(rec = {}, { calibration = null, oddsSnapshot = null, context = {} } = {}) {
  const marketKey = rec?.marketKey;
  if (!marketFamily(marketKey)) return null;
  const stated = finiteNumberOrNull(rec.modelProbability ?? (rec.probability01 != null ? rec.probability01 * 100 : null));
  if (stated == null || stated <= 0 || stated >= 100) return null;
  const hasHistory = Boolean(calibration?.markets?.[marketKey]?.knots?.length
    || calibration?.families?.[marketFamily(marketKey)]?.knots?.length);
  const corrected = calibration ? correctedChance(calibration, marketKey, stated, context) : null;
  const chanceForOdds = corrected ?? round1(stated);
  const marketStats = calibration?.markets?.[marketKey] || null;

  let fair = { fairChance: null, margin: null, reason: 'NO_MARKET_PRICE' };
  let bookmakerOdds = null;
  let bookmaker = null;
  if (oddsSnapshot?.status === 'AVAILABLE' && oddsSnapshot.odds) {
    fair = fairMarketChance(oddsSnapshot.odds, marketKey);
    bookmakerOdds = offeredOddsForMarket(oddsSnapshot.odds, marketKey);
    bookmaker = oddsSnapshot.bookmaker?.name || null;
  }

  const overrated = corrected != null && (
    stated - corrected >= OVERRATED_GAP || marketStats?.overrated === true
  );
  return {
    statedChance: round1(stated),
    correctedChance: corrected,
    correctionBasis: corrected == null ? 'unavailable' : hasHistory ? (marketStats?.basis === 'market' ? 'market' : 'family') : 'not_enough_history',
    historyPicks: marketStats?.picks ?? 0,
    marketHistory: marketStats ? { statedAvg: marketStats.statedAvg, actualRate: marketStats.actualRate } : null,
    fairMarketChance: fair.fairChance,
    bookmakerMargin: fair.margin,
    marketPriceReason: fair.reason,
    bookmakerOdds,
    bookmaker,
    noMarketPrice: fair.fairChance == null,
    minimumOdds: minimumOddsWorthTaking(chanceForOdds),
    overrated,
    warning: overrated ? OVERRATED_WARNING : null,
    calibrationBuiltAt: calibration?.builtAt || null,
  };
}

/** Returns a copy of an analysis object with `priceCheck` on each recommendation. */
export function withPriceChecks(analysis, calibration, context = {}) {
  if (!analysis || !Array.isArray(analysis.recommendations)) return analysis;
  const oddsSnapshot = analysis.oddsSnapshot || context.oddsSnapshot || null;
  return {
    ...analysis,
    recommendations: analysis.recommendations.map((r) => {
      const priceCheck = buildPriceCheck(r, { calibration, oddsSnapshot, context });
      return priceCheck ? { ...r, priceCheck } : r;
    }),
  };
}
