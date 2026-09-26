/**
 * Simple game card and "Build my double" (V10.9).
 * Plain numbers only: the corrected chance for a handful of everyday markets,
 * and suggested 2–3 leg combinations that reach about 2.0 or 3.0 odds.
 */
import { finiteNumberOrNull, offeredOddsForMarket } from './marketKeys.js';
import { correctedChance } from './pickCalibration.js';

export const SIMPLE_MARKETS = Object.freeze([
  { key: 'over15', label: 'Over 1.5 goals', short: 'Over 1.5' },
  { key: 'over25', label: 'Over 2.5 goals', short: 'Over 2.5' },
  { key: 'home_win', label: 'Home win', short: 'Home' },
  { key: 'draw', label: 'Draw', short: 'Draw' },
  { key: 'away_win', label: 'Away win', short: 'Away' },
]);
// Kept in the compact daily feed so the card can show markets that were not "picks".
export const CARD_PROBABILITY_KEYS = Object.freeze(['over15', 'over25', 'under25', 'btts', 'home_win', 'draw', 'away_win']);

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/** Compact 0–1 probabilities from a full or compact analysis. */
export function compactMarketProbabilities(analysis) {
  const src = analysis?.marketProbabilities || analysis?.poisson?.marketProbabilities || null;
  if (!src) return null;
  const out = {};
  for (const k of CARD_PROBABILITY_KEYS) {
    const v = finiteNumberOrNull(src[k]);
    if (v != null && v > 0 && v < 1) out[k] = Math.round(v * 10000) / 10000;
  }
  return Object.keys(out).length ? out : null;
}

function statedPercentFor(match, key) {
  const probs = compactMarketProbabilities(match?.analysis);
  if (probs?.[key] != null) return probs[key] * 100;
  const rec = (match?.analysis?.recommendations || []).find((r) => r?.marketKey === key);
  const p = finiteNumberOrNull(rec?.modelProbability ?? rec?.confidence);
  return p != null && p > 0 && p < 100 ? p : null;
}

function bookmakerOddsFor(match, key) {
  const odds = match?.analysis?.oddsSnapshot?.status === 'AVAILABLE'
    ? match.analysis.oddsSnapshot.odds
    : (match?.analysis?.odds || match?.odds || null);
  return odds ? offeredOddsForMarket(odds, key) : null;
}

/**
 * One card per game: corrected chance for each simple market, or null
 * ("No prediction") when the engine has no figure. Never 0.
 */
export function buildSimpleCard(match, calibration) {
  if (!match?.analysis) return null;
  const context = { leagueId: match.leagueId, leagueCountry: match.leagueCountry, matchType: match.matchType };
  const markets = {};
  let any = false;
  for (const { key } of SIMPLE_MARKETS) {
    const stated = statedPercentFor(match, key);
    if (stated == null) { markets[key] = null; continue; }
    const corrected = calibration ? correctedChance(calibration, key, stated, context) : round1(stated);
    if (corrected == null) { markets[key] = null; continue; }
    any = true;
    markets[key] = { chance: corrected, stated: round1(stated), bookmakerOdds: bookmakerOddsFor(match, key) };
  }
  if (!any) return null;
  return { markets, corrected: Boolean(calibration) };
}

/** Leg price: bookmaker odds when stored, else 1 ÷ corrected chance, marked as an estimate. */
export function legOdds(chancePct, bookmakerOdds) {
  const b = finiteNumberOrNull(bookmakerOdds);
  if (b != null && b > 1) return { odds: round2(b), estimate: false };
  const p = finiteNumberOrNull(chancePct);
  if (p == null || p <= 0 || p >= 100) return null;
  return { odds: round2(100 / p), estimate: true };
}

export function comboTotals(legs = []) {
  let chance = 1;
  let odds = 1;
  for (const l of legs) {
    chance *= l.chance / 100;
    const o = finiteNumberOrNull(l.userOdds) > 1 ? Number(l.userOdds) : l.odds;
    odds *= o;
  }
  return { chance: round1(chance * 100), odds: round2(odds), estimate: legs.some((l) => !(finiteNumberOrNull(l.userOdds) > 1) && l.estimate) };
}

function combinations(pool, size, start = 0, prefix = [], out = []) {
  if (prefix.length === size) { out.push(prefix); return out; }
  for (let i = start; i < pool.length; i++) {
    if (prefix.some((p) => String(p.matchId) === String(pool[i].matchId))) continue;
    combinations(pool, size, i + 1, [...prefix, pool[i]], out);
  }
  return out;
}

/**
 * Suggest combinations of 2 or 3 strong picks from different games whose
 * combined odds land near a target (default about 2.0 and about 3.0).
 * Higher combined chance wins; a pick is used in at most one suggestion.
 */
export function suggestCombos(matches = [], {
  targets = [2, 3], perTarget = [3, 2], tolerance = 0.08, minChance = 55, perBand = 15,
  minLegOdds = 1.2, maxLegOdds = 2.2,
  now = Date.now(),
} = {}) {
  const pool = [];
  for (const m of matches) {
    if (m?.status && m.status !== 'NS' && m.status !== 'TBD') continue;
    const ko = Date.parse(m?.kickoffUTC || '');
    if (Number.isFinite(ko) && ko <= now) continue;
    const card = m?.simpleCard;
    if (!card?.markets) continue;
    for (const { key, label } of SIMPLE_MARKETS) {
      const mk = card.markets[key];
      if (!mk || !(mk.chance >= minChance)) continue;
      const price = legOdds(mk.chance, mk.bookmakerOdds);
      // Very short prices can't reach 2.0 or 3.0 in 2–3 legs, so they are left out.
      if (!price || price.odds < minLegOdds || price.odds > maxLegOdds) continue;
      pool.push({
        key: `${m.id}|${key}`, matchId: m.id, home: m.home, away: m.away, league: m.league,
        leagueId: m.leagueId, leagueCountry: m.leagueCountry, kickoffUTC: m.kickoffUTC, predictionId: m.predictionId || null,
        marketKey: key, selection: selectionLabel(key, m), chance: mk.chance, stated: mk.stated ?? null, odds: price.odds, estimate: price.estimate,
      });
    }
  }
  pool.sort((a, b) => b.chance - a.chance);
  // Keep the strongest picks in each price band, so both short and longer legs are available.
  const bands = [1.35, 1.55, 1.8, Infinity];
  const top = bands.flatMap((hi, i) => pool
    .filter((l) => l.odds < hi && l.odds >= (i === 0 ? 0 : bands[i - 1]))
    .slice(0, perBand));
  const used = new Set();
  const suggestions = [];
  targets.forEach((target, ti) => {
    const want = perTarget[ti] ?? 2;
    const candidates = [];
    for (const size of [2, 3]) {
      for (const legs of combinations(top, size)) {
        const t = comboTotals(legs);
        if (Math.abs(t.odds - target) / target > tolerance) continue;
        candidates.push({ legs, ...t, target });
      }
    }
    candidates.sort((a, b) => b.chance - a.chance || Math.abs(a.odds - target) - Math.abs(b.odds - target));
    let taken = 0;
    for (const c of candidates) {
      if (taken >= want) break;
      if (c.legs.some((l) => used.has(l.key))) continue;
      c.legs.forEach((l) => used.add(l.key));
      suggestions.push(c);
      taken++;
    }
  });
  return suggestions;
}

export function selectionLabel(key, m = {}) {
  if (key === 'home_win') return `${m.home || 'Home'} to win`;
  if (key === 'away_win') return `${m.away || 'Away'} to win`;
  if (key === 'draw') return 'Draw';
  if (key === 'over15') return 'Over 1.5 goals';
  if (key === 'over25') return 'Over 2.5 goals';
  return key;
}
