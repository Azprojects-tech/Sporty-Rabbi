/**
 * Corners model (V10.10).
 *
 * Source: football-data.co.uk results files (free, no API-Football quota),
 * columns HC / AC = home / away corners. For each league:
 *   - every team gets four averages: corners won and conceded, at home and away,
 *     weighted toward recent games (half-life HALF_LIFE_DAYS) and shrunk toward
 *     the league average by PRIOR_GAMES pseudo-games;
 *   - expected home corners = home team's home "for" × away team's away "against" ÷ league home average
 *     (and the mirror for the away side); expected total = the sum;
 *   - the chance of over 8.5 / 9.5 / 10.5 comes from a negative-binomial
 *     distribution whose spread is measured from the league's own results
 *     (Poisson when the league shows no extra spread).
 */

export const CORNER_LINES = Object.freeze([8.5, 9.5, 10.5]);
export const HALF_LIFE_DAYS = 120;
export const PRIOR_GAMES = 6;
export const MIN_TEAM_GAMES = 3;
export const WINDOW_DAYS = 400;

// football-data.co.uk file codes by API-Football league id (country + name as a fallback).
export const FD_LEAGUES = Object.freeze({
  E0: { id: 39, country: 'England', name: 'Premier League' },
  E1: { id: 40, country: 'England', name: 'Championship' },
  E2: { id: 41, country: 'England', name: 'League One' },
  E3: { id: 42, country: 'England', name: 'League Two' },
  EC: { id: 43, country: 'England', name: 'National League' },
  SC0: { id: 179, country: 'Scotland', name: 'Premiership' },
  SC1: { id: 180, country: 'Scotland', name: 'Championship' },
  SC2: { id: 183, country: 'Scotland', name: 'League One' },
  SC3: { id: 184, country: 'Scotland', name: 'League Two' },
  D1: { id: 78, country: 'Germany', name: 'Bundesliga' },
  D2: { id: 79, country: 'Germany', name: '2. Bundesliga' },
  I1: { id: 135, country: 'Italy', name: 'Serie A' },
  I2: { id: 136, country: 'Italy', name: 'Serie B' },
  SP1: { id: 140, country: 'Spain', name: 'La Liga' },
  SP2: { id: 141, country: 'Spain', name: 'Segunda División' },
  F1: { id: 61, country: 'France', name: 'Ligue 1' },
  F2: { id: 62, country: 'France', name: 'Ligue 2' },
  N1: { id: 88, country: 'Netherlands', name: 'Eredivisie' },
  B1: { id: 144, country: 'Belgium', name: 'Jupiler Pro League' },
  P1: { id: 94, country: 'Portugal', name: 'Primeira Liga' },
  T1: { id: 203, country: 'Turkey', name: 'Süper Lig' },
  G1: { id: 197, country: 'Greece', name: 'Super League 1' },
});

const fold = (s) => String(s || '').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

export function fdCodeForMatch(match = {}) {
  const id = Number(match.leagueId);
  const country = fold(match.leagueCountry);
  // A known country must agree too (some feeds reuse a league id for a same-named league elsewhere).
  for (const [code, l] of Object.entries(FD_LEAGUES)) if (l.id === id && (!country || fold(l.country) === country)) return code;
  const name = fold(match.league);
  for (const [code, l] of Object.entries(FD_LEAGUES)) if (fold(l.country) === country && fold(l.name) === name) return code;
  return null;
}

/** football-data season code for a date: Aug 2026 – Jul 2027 → "2627". */
export function fdSeasonCode(date = new Date(), offset = 0) {
  const d = new Date(date);
  const start = (d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1) + offset;
  const yy = (n) => String(n % 100).padStart(2, '0');
  return `${yy(start)}${yy(start + 1)}`;
}

function parseDate(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return Date.UTC(year, Number(m[2]) - 1, Number(m[1]));
}

/** Rows with a date, both team names and both corner counts. */
export function parseFdCsv(text = '') {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map((h) => h.trim());
  const col = (name) => head.indexOf(name);
  const [iDate, iHome, iAway, iHC, iAC, iHG, iAG] = ['Date', 'HomeTeam', 'AwayTeam', 'HC', 'AC', 'FTHG', 'FTAG'].map(col);
  if ([iDate, iHome, iAway, iHC, iAC].some((i) => i < 0)) return [];
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const date = parseDate(c[iDate]);
    const hc = Number(c[iHC]);
    const ac = Number(c[iAC]);
    if (date == null || !c[iHome] || !c[iAway] || c[iHC] === '' || c[iAC] === '' || !Number.isInteger(hc) || !Number.isInteger(ac)) continue;
    rows.push({ date, home: c[iHome].trim(), away: c[iAway].trim(), hc, ac,
      hg: iHG >= 0 ? Number(c[iHG]) : null, ag: iAG >= 0 ? Number(c[iAG]) : null });
  }
  return rows;
}

// ── Team names: API-Football → football-data ────────────────────────────────
const STOP = new Set(['fc', 'afc', 'cf', 'sc', 'ac', 'as', 'ss', 'club', 'cd', 'ud', 'sd', 'rc', 'rcd', 'sv', 'vfl', 'vfb', 'tsg', 'fk', 'sk', 'bk', 'if', 'calcio', 'de', 'la', 'the', 'and', '1', 'town', 'city', 'united', 'utd', 'county']);
const ALIASES = {
  'manchester united': 'man united', 'manchester city': 'man city', 'nottingham forest': "nott'm forest",
  'sheffield wednesday': 'sheffield weds', 'wolverhampton wanderers': 'wolves', 'queens park rangers': 'qpr',
  'paris saint germain': 'paris sg', 'bayern munchen': 'bayern munich', 'borussia monchengladbach': "m'gladbach",
  'borussia dortmund': 'dortmund', 'eintracht frankfurt': 'ein frankfurt', 'bayer leverkusen': 'leverkusen',
  'athletic club': 'ath bilbao', 'atletico madrid': 'ath madrid', 'real sociedad': 'sociedad', 'celta vigo': 'celta',
  'rayo vallecano': 'vallecano', 'real betis': 'betis', 'espanyol': 'espanol', 'deportivo alaves': 'alaves',
  'inter': 'inter', 'ac milan': 'milan', 'as roma': 'roma', 'hellas verona': 'verona',
  'sporting cp': 'sp lisbon', 'sporting lisbon': 'sp lisbon', 'fc porto': 'porto', 'sc braga': 'sp braga',
  'psv eindhoven': 'psv eindhoven', 'az alkmaar': 'az alkmaar', 'go ahead eagles': 'go ahead eagles',
  'olympiakos piraeus': 'olympiakos', 'paok': 'paok', 'galatasaray': 'galatasaray',
  'milton keynes dons': 'milton keynes dons', 'mk dons': 'milton keynes dons',
  'dundee utd': 'dundee united', 'dundee united': 'dundee united', 'heart of midlothian': 'hearts',
  'inverness ct': 'inverness c', "queen's park": 'queens park', 'fsv mainz 05': 'mainz', 'stade brestois 29': 'brest',
  'oh leuven': 'oud-heverlee leuven', 'vitoria sc': 'guimaraes', 'vitoria guimaraes': 'guimaraes', 'basaksehir': 'buyuksehyr',
  'istanbul basaksehir': 'buyuksehyr', 'levadiakos': 'levadeiakos', 'sporting gijon': 'sp gijon', 'queen of the south': 'queen of sth',
};
// Reserve sides: API-Football "X II" is football-data "X B".
function reserveVariant(folded) {
  const m = folded.match(/^(.*) ii$/);
  return m ? `${m[1]} b` : null;
}
// Abbreviations football-data uses inside names.
const TOKEN_SYNONYMS = { rovers: 'rvs', saint: 'st', sporting: 'sp', fortuna: 'for' };
const tokens = (s) => fold(s).replace(/[^a-z0-9' ]/g, ' ').split(/\s+/)
  .map((t) => TOKEN_SYNONYMS[t] || t).filter((t) => t.length > 1 && !STOP.has(t));

function similarity(a, b) {
  const ta = new Set(tokens(a)); const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t) || [...tb].some((u) => (u.length >= 4 && t.startsWith(u)) || (t.length >= 4 && u.startsWith(t)))) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/** Best football-data team name for an API-Football name, or null when unsure. */
export function matchTeamName(name, candidates = []) {
  const f = fold(name).replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = candidates.find((c) => fold(c) === f);
  if (exact) return exact;
  const alias = ALIASES[f];
  if (alias) { const hit = candidates.find((c) => fold(c) === alias); if (hit) return hit; }
  const reserve = reserveVariant(f);
  if (reserve) {
    const base = reserve.slice(0, -2);
    const hit = candidates.find((c) => fold(c) === reserve)
      || candidates.find((c) => fold(c) === `${ALIASES[base] || base} b`)
      || candidates.find((c) => / b$/.test(fold(c)) && similarity(base, fold(c).slice(0, -2)) >= 0.66);
    return hit || null; // never match a reserve side to the first team
  }
  let best = null; let score = 0; let second = 0;
  for (const c of candidates) {
    const s = similarity(f, c);
    if (s > score) { second = score; score = s; best = c; } else if (s > second) second = s;
  }
  return score >= 0.66 && score > second ? best : null;
}

// ── Model ────────────────────────────────────────────────────────────────────
export function buildLeagueCornersModel(rows = [], { now = Date.now() } = {}) {
  const recent = rows.filter((r) => r.date <= now && now - r.date <= WINDOW_DAYS * 86400000);
  if (recent.length < 30) return null;
  const w = (r) => 0.5 ** ((now - r.date) / (HALF_LIFE_DAYS * 86400000));
  let sw = 0, sh = 0, sa = 0;
  for (const r of recent) { const k = w(r); sw += k; sh += k * r.hc; sa += k * r.ac; }
  const leagueHome = sh / sw;
  const leagueAway = sa / sw;
  const teams = {};
  const t = (name) => (teams[name] ||= { hw: 0, hFor: 0, hAg: 0, aw: 0, aFor: 0, aAg: 0, games: 0 });
  for (const r of recent) {
    const k = w(r);
    const h = t(r.home); h.hw += k; h.hFor += k * r.hc; h.hAg += k * r.ac; h.games++;
    const a = t(r.away); a.aw += k; a.aFor += k * r.ac; a.aAg += k * r.hc; a.games++;
  }
  const ratings = {};
  for (const [name, x] of Object.entries(teams)) {
    ratings[name] = {
      games: x.games,
      homeFor: (x.hFor + PRIOR_GAMES * leagueHome) / (x.hw + PRIOR_GAMES),
      homeAgainst: (x.hAg + PRIOR_GAMES * leagueAway) / (x.hw + PRIOR_GAMES),
      awayFor: (x.aFor + PRIOR_GAMES * leagueAway) / (x.aw + PRIOR_GAMES),
      awayAgainst: (x.aAg + PRIOR_GAMES * leagueHome) / (x.aw + PRIOR_GAMES),
    };
  }
  const model = { leagueHome, leagueAway, ratings, size: null, games: recent.length, lastResultAt: Math.max(...recent.map((r) => r.date)) };
  // Spread: extra variance of match totals beyond the model's expected totals.
  let n = 0, sumMu = 0, sumSq = 0;
  for (const r of recent) {
    const mu = expectedCorners(model, r.home, r.away)?.total;
    if (mu == null) continue;
    n++; sumMu += mu; sumSq += (r.hc + r.ac - mu) ** 2;
  }
  const meanMu = sumMu / n;
  const excess = sumSq / n - meanMu;
  model.size = excess > 0 ? Math.min(200, Math.max(5, (meanMu * meanMu) / excess)) : null;
  return model;
}

export function expectedCorners(model, home, away) {
  const h = model?.ratings?.[home];
  const a = model?.ratings?.[away];
  if (!h || !a) return null;
  const homeExp = (h.homeFor * a.awayAgainst) / model.leagueHome;
  const awayExp = (a.awayFor * h.homeAgainst) / model.leagueAway;
  return { home: homeExp, away: awayExp, total: homeExp + awayExp };
}

/** P(total > line) for a negative binomial (size r) or Poisson (size null). */
export function overProbability(mean, line, size = null) {
  if (!(mean > 0)) return null;
  const kMax = Math.floor(line);
  let p = size ? (size / (size + mean)) ** size : Math.exp(-mean);
  let cdf = p;
  for (let k = 0; k < kMax; k++) {
    p = size ? p * ((k + size) / (k + 1)) * (mean / (size + mean)) : (p * mean) / (k + 1);
    cdf += p;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

export const cornersMarketKey = (line) => `corners_over${String(line).replace('.', '')}`;

/**
 * Corners prediction for one fixture, or { status: 'NO_PREDICTION', reason }.
 * The main line is the one closest to an even (50%) chance, like a bookmaker's.
 */
export function predictCorners(models = {}, match = {}) {
  const code = fdCodeForMatch(match);
  if (!code) return { status: 'NO_PREDICTION', reason: 'LEAGUE_NOT_COVERED' };
  const model = models[code];
  if (!model) return { status: 'NO_PREDICTION', reason: 'LEAGUE_DATA_UNAVAILABLE', source: code };
  const names = Object.keys(model.ratings);
  const home = matchTeamName(match.home, names);
  const away = matchTeamName(match.away, names);
  if (!home || !away || home === away) return { status: 'NO_PREDICTION', reason: 'TEAM_NOT_FOUND', source: code };
  if (model.ratings[home].games < MIN_TEAM_GAMES || model.ratings[away].games < MIN_TEAM_GAMES) {
    return { status: 'NO_PREDICTION', reason: 'NOT_ENOUGH_GAMES', source: code };
  }
  const exp = expectedCorners(model, home, away);
  const lines = {};
  for (const line of CORNER_LINES) lines[cornersMarketKey(line)] = Math.round(overProbability(exp.total, line, model.size) * 1000) / 10;
  const main = CORNER_LINES.reduce((best, l) => (Math.abs(lines[cornersMarketKey(l)] - 50) < Math.abs(lines[cornersMarketKey(best)] - 50) ? l : best), CORNER_LINES[0]);
  return {
    status: 'AVAILABLE', source: code, fdHome: home, fdAway: away,
    expectedTotal: Math.round(exp.total * 10) / 10, expectedHome: Math.round(exp.home * 10) / 10, expectedAway: Math.round(exp.away * 10) / 10,
    lines, line: main, marketKey: cornersMarketKey(main), stated: lines[cornersMarketKey(main)],
  };
}

/** Settle one stored corners prediction from a results row. */
export function settleCornersLines(lines = {}, totalCorners) {
  const out = {};
  for (const line of CORNER_LINES) {
    const key = cornersMarketKey(line);
    if (lines[key] != null) out[key] = totalCorners > line ? 'won' : 'lost';
  }
  return out;
}
