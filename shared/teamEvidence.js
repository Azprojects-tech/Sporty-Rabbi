import { finalScoreFromProviderFixture } from './forecastMath.js';

/**
 * Team goal-rate evidence for the prediction model.
 *
 * Rules (V10.7 data-correctness pass):
 * - "No data" is null, never 0 and never the word "Unavailable".
 * - Only matches that finished BEFORE the fixture's kickoff count, so a match
 *   can never be analysed using its own result.
 * - Primary evidence = the same competition and season.
 * - When a team has fewer than MIN_COMPETITION_SAMPLE such games (cups,
 *   qualifiers, early season), recent games from other competitions and last
 *   season are added at reduced weight and the result is labelled ESTIMATED.
 * - The weighted (effective) sample size is what the model uses for shrinkage
 *   and reliability, so topped-up evidence can never look as strong as a full
 *   same-competition sample.
 */
export const MIN_COMPETITION_SAMPLE = 5;
export const FALLBACK_WEIGHT = 0.5;
export const MAX_EVIDENCE_MATCHES = 10;
// Club friendlies are not evidence of competitive scoring rates.
const EXCLUDED_LEAGUE_IDS = new Set([667]);

const toMs = (value) => {
  if (value == null) return Date.now();
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : Date.now();
};

/** Provider fixture rows → compact, completed, regulation-score rows (safe to cache). */
export function compactFixtureRows(rows = []) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.fixture?.id;
    const date = r?.fixture?.date;
    const score = finalScoreFromProviderFixture(r);
    if (!id || !date || !score || seen.has(String(id)) || !Number.isFinite(Date.parse(date))) continue;
    seen.add(String(id));
    out.push({
      id,
      date,
      leagueId: r.league?.id ?? null,
      leagueName: r.league?.name ?? null,
      season: r.league?.season ?? null,
      homeTeamId: r.teams?.home?.id ?? null,
      awayTeamId: r.teams?.away?.id ?? null,
      home: r.teams?.home?.name ?? null,
      away: r.teams?.away?.name ?? null,
      homeGoals: score.home,
      awayGoals: score.away,
      status: { short: score.status },
    });
  }
  return out;
}

const involves = (row, teamId) => [row.homeTeamId, row.awayTeamId].some((id) => id != null && String(id) === String(teamId));

function summarizeRecentOpposition(teamId, matches = []) {
  if (!matches.length) return null;
  const recent = matches.slice(0, 5).map((m) => {
    const isHome = String(m.homeTeamId) === String(teamId);
    const own = isHome ? m.homeGoals : m.awayGoals;
    const opp = isHome ? m.awayGoals : m.homeGoals;
    return {
      opponentId: isHome ? m.awayTeamId : m.homeTeamId,
      opponent: isHome ? m.away : m.home,
      opponentPosition: null,
      tier: null,
      result: own > opp ? 'W' : own < opp ? 'L' : 'D',
      score: `${own}-${opp}`,
      date: m.date,
      competition: m.leagueName ?? null,
    };
  });
  const results = recent.reduce((acc, g) => { acc[g.result] += 1; return acc; }, { W: 0, D: 0, L: 0 });
  return {
    ownPosition: null,
    avgOpponentPosition: null,
    counts: { stronger: 0, peer: 0, weaker: 0 },
    results,
    recent,
    summary: `Last 5 results: ${results.W}W ${results.D}D ${results.L}L. Opposition quality bands unavailable (standings not resolved).`,
  };
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

/**
 * Build the evidence summary for one team.
 * @returns {{ matches: object[], stats: object, evidence: object }}
 */
export function buildTeamEvidence({
  teamId,
  leagueId = null,
  season = null,
  before = null,
  primaryRows = [],
  fallbackRows = [],
  minPrimary = MIN_COMPETITION_SAMPLE,
  maxMatches = MAX_EVIDENCE_MATCHES,
  fallbackWeight = FALLBACK_WEIGHT,
} = {}) {
  const cutoff = toMs(before);
  const byDateDesc = (a, b) => Date.parse(b.date) - Date.parse(a.date);
  const usable = (r) => r && involves(r, teamId) && Date.parse(r.date) < cutoff;

  const primary = [];
  const seen = new Set();
  for (const r of [...(primaryRows || [])].sort(byDateDesc)) {
    if (!usable(r) || seen.has(String(r.id))) continue;
    if (leagueId != null && String(r.leagueId) !== String(leagueId)) continue;
    if (season != null && String(r.season) !== String(season)) continue;
    seen.add(String(r.id));
    primary.push({ ...r, weight: 1, sameCompetition: true });
    if (primary.length >= maxMatches) break;
  }

  const topUp = [];
  if (primary.length < minPrimary) {
    for (const r of [...(fallbackRows || [])].sort(byDateDesc)) {
      if (primary.length + topUp.length >= maxMatches) break;
      if (!usable(r) || seen.has(String(r.id)) || EXCLUDED_LEAGUE_IDS.has(Number(r.leagueId))) continue;
      const sameLeague = leagueId != null && String(r.leagueId) === String(leagueId);
      // A same-competition, same-season row missed by the primary query is full evidence.
      const fullWeight = sameLeague && season != null && String(r.season) === String(season);
      seen.add(String(r.id));
      topUp.push({ ...r, weight: fullWeight ? 1 : fallbackWeight, sameCompetition: fullWeight });
    }
  }

  const matches = [...primary, ...topUp].sort(byDateDesc);
  const competitionSeason = matches.filter((m) => m.sameCompetition).length;
  const previousSeasonSameCompetition = topUp.filter((m) => !m.sameCompetition && leagueId != null && String(m.leagueId) === String(leagueId)).length;
  const otherCompetitions = topUp.filter((m) => !m.sameCompetition).length - previousSeasonSameCompetition;

  if (!matches.length) {
    return {
      matches: [],
      stats: {
        wins: 0, draws: 0, losses: 0,
        goalsFor: null, goalsAgainst: null,
        avgGoalsFor: null, avgGoalsAgainst: null,
        form: null, winRate: null,
        goalDrought: null, recentLosses: null,
        recentOpposition: null,
        sampleSize: 0, effectiveSampleSize: 0,
      },
      evidence: {
        source: 'NONE', quality: 'UNAVAILABLE',
        competitionSeason: 0, otherCompetitions: 0, previousSeasonSameCompetition: 0,
        sampleSize: 0, effectiveSampleSize: 0, fallbackWeight,
        note: 'No completed matches found before kickoff.',
      },
    };
  }

  let wins = 0, draws = 0, losses = 0, goalsFor = 0, goalsAgainst = 0, wFor = 0, wAgainst = 0, wSum = 0;
  const form = [];
  for (const m of matches) {
    const isHome = String(m.homeTeamId) === String(teamId);
    const gf = isHome ? m.homeGoals : m.awayGoals;
    const ga = isHome ? m.awayGoals : m.homeGoals;
    goalsFor += gf; goalsAgainst += ga;
    wFor += gf * m.weight; wAgainst += ga * m.weight; wSum += m.weight;
    if (gf > ga) { wins++; form.push('W'); } else if (gf === ga) { draws++; form.push('D'); } else { losses++; form.push('L'); }
  }
  let recentLosses = 0;
  for (const r of form) { if (r === 'L') recentLosses++; else break; }
  let goalDrought = 0;
  for (const m of matches) {
    const gf = String(m.homeTeamId) === String(teamId) ? m.homeGoals : m.awayGoals;
    if (gf === 0) goalDrought++; else break;
  }

  const effectiveSampleSize = +wSum.toFixed(1);
  const mixed = topUp.some((m) => !m.sameCompetition);
  const quality = mixed ? 'ESTIMATED' : competitionSeason >= minPrimary ? 'MEASURED' : 'LIMITED';
  const parts = [plural(competitionSeason, 'game') + ' in this competition this season'];
  if (previousSeasonSameCompetition) parts.push(`${previousSeasonSameCompetition} from last season`);
  if (otherCompetitions) parts.push(`${otherCompetitions} from other competitions`);
  const note = mixed
    ? `${parts.join(' + ')} (extra games counted at ${Math.round(fallbackWeight * 100)}% weight).`
    : competitionSeason >= minPrimary
      ? `${plural(competitionSeason, 'game')} in this competition this season.`
      : `Only ${plural(competitionSeason, 'game')} in this competition this season and no other recent games found.`;

  return {
    matches,
    stats: {
      wins, draws, losses,
      goalsFor, goalsAgainst,
      avgGoalsFor: (wFor / wSum).toFixed(2),
      avgGoalsAgainst: (wAgainst / wSum).toFixed(2),
      form: form.join(''),
      winRate: ((wins / matches.length) * 100).toFixed(1),
      goalDrought, recentLosses,
      recentOpposition: summarizeRecentOpposition(teamId, matches),
      sampleSize: matches.length,
      effectiveSampleSize,
    },
    evidence: {
      source: mixed ? 'MIXED' : 'COMPETITION_SEASON',
      quality,
      competitionSeason, otherCompetitions, previousSeasonSameCompetition,
      sampleSize: matches.length, effectiveSampleSize, fallbackWeight,
      note,
    },
  };
}

const VALID_FORM = /^[WDL]+$/;

/**
 * Convert a getTeamForm() result into model inputs, rejecting placeholders.
 * Legacy results used form 'Unavailable' with 0.00 averages for "no data";
 * those are treated as missing here.
 */
export function formResultToModelInputs(result) {
  const empty = { form: null, sampleSize: null, goalsAvgFor: null, goalsAvgAgainst: null, goalDrought: null, recentLosses: null, recentOpposition: null, evidence: null, recentFixtures: [] };
  if (!result || result.offline || !result.stats || result.stats.error) return empty;
  const s = result.stats;
  const matches = Array.isArray(result.matches) ? result.matches : [];
  if (!matches.length) return { ...empty, sampleSize: 0, evidence: result.evidence || null };
  const num = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : null; };
  const effective = num(s.effectiveSampleSize);
  return {
    form: typeof s.form === 'string' && VALID_FORM.test(s.form) ? s.form.split('').join('-') : null,
    sampleSize: effective ?? matches.length,
    goalsAvgFor: num(s.avgGoalsFor),
    goalsAvgAgainst: num(s.avgGoalsAgainst),
    goalDrought: Number.isInteger(s.goalDrought) ? s.goalDrought : null,
    recentLosses: Number.isInteger(s.recentLosses) ? s.recentLosses : null,
    recentOpposition: s.recentOpposition || null,
    evidence: result.evidence || null,
    recentFixtures: matches,
  };
}

/** True when stored calibration inputs are real numbers rather than legacy placeholders. */
export function isUsableStoredGoalInputs(ci = {}, side = 'home') {
  const sample = Number(ci[`${side}SampleSize`]);
  const gf = ci[`${side}GoalsAvgFor`], ga = ci[`${side}GoalsAvgAgainst`];
  return Number.isFinite(sample) && sample > 0
    && gf != null && ga != null && Number.isFinite(Number(gf)) && Number.isFinite(Number(ga));
}
