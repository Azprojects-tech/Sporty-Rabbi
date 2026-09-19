import { observedNumber } from '../../../shared/forecastMath.js';

const n = observedNumber;
const row = (label, value) => ({ label, value: value ?? 'Unavailable' });
const card = (id, title, summary, rows, method, source, modelUse = 'Supporting context') =>
  ({ id, title, summary, rows, method, source, modelUse });
const stamp = v => Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const fmt = v => n(v) == null ? null : Number(v).toFixed(2);

export function verifiedRecentResults(fixtures, teamId, leagueId, season, cutoff) {
  const seen = new Set();
  return (fixtures || []).filter(f => {
    if (!f.id || seen.has(String(f.id)) || f.status?.short !== 'FT' || String(f.leagueId) !== String(leagueId)
      || String(f.season) !== String(season) || stamp(f.date) == null || stamp(f.date) >= cutoff
      || ![f.homeTeamId, f.awayTeamId].some(id => String(id) === String(teamId))
      || ![f.homeGoals, f.awayGoals].every(v => n(v) != null && Number.isInteger(Number(v)) && Number(v) >= 0)) return false;
    seen.add(String(f.id)); return true;
  }).sort((a,b) => stamp(b.date) - stamp(a.date)).slice(0,10).map(f => {
    const home = String(f.homeTeamId) === String(teamId);
    const gf = Number(home ? f.homeGoals : f.awayGoals), ga = Number(home ? f.awayGoals : f.homeGoals);
    return { ...f, gf, ga, points: gf > ga ? 3 : gf === ga ? 1 : 0 };
  });
}

export function coachRecord(coaches, teamId, fixtures, asOf) {
  const careers = (Array.isArray(coaches) ? coaches : []).flatMap(c => (c.career || []).map(t => ({ ...t, name: c.name })));
  const current = careers.filter(c => String(c.team?.id) === String(teamId) && stamp(c.start) != null
    && stamp(c.start) <= asOf && (!c.end || (stamp(c.end) != null && stamp(c.end) >= asOf)))
    .sort((a,b) => stamp(b.start) - stamp(a.start))[0];
  if (!current) return null;
  const after = fixtures.filter(f => stamp(f.date) >= stamp(current.start));
  const before = fixtures.filter(f => stamp(f.date) < stamp(current.start));
  const mean = list => list.length ? list.reduce((s,f) => s + f.points,0) / list.length : null;
  return { name: current.name, start: current.start, afterCount: after.length, beforeCount: before.length,
    afterPPG: mean(after), beforePPG: mean(before) };
}

export function lineupRecord(lineups, teamId) {
  const list = Array.isArray(lineups) ? lineups : [];
  const team = list.find(l => String(l.team?.id) === String(teamId));
  const players = team?.startXI?.map(p => p.player).filter(p => p?.id && p?.name) || [];
  if (players.length !== 11 || new Set(players.map(p => String(p.id))).size !== 11) return null;
  return { formation: team.formation || null, players };
}

const parameterSpecs = {
  p1_motivation: ['Table position', ['homePosition','awayPosition','totalTeams','gameWeek','totalGW'], 'For each team: 100 × (league size − rank) / (league size −1). Average both. Match importance requires separate qualification rules.'],
  p2_starPower: ['Squad strength', ['homeSquadIntegrity','awaySquadIntegrity'], 'Requires measured player-strength inputs. Published XI and recorded absences are shown separately.'],
  p3_h2h: ['Head-to-head', [], 'Round(mean total goals × 14 + Over 2.5 frequency × 22 + directional offset 18 home / 12 away / 15 neutral), bounded 0–100.'],
  p4_form: ['Recent form', ['homeForm','awayForm','homeSampleSize','awaySampleSize'], 'Newest five games receive 1.6 weight; older games 1.0. Blend weighted points rate (60%) with win/points indicator (40%). A +12 context adjustment requires xG/goals >1.35 and an observed non-negative xG trend.'],
  p5_scoringTiming: ['Season goal timing', ['homeLateGoalPct','awayLateGoalPct'], 'Mean share of goals in provider 76–90 bucket ×220, rounded and bounded 0–100. 80+ event history is shown separately below.'],
  p6_defensiveGap: ['Defensive vulnerability', ['homeGoalsAvgAgainst','awayGoalsAvgAgainst','homeCBInjured','awayGKError'], 'Each conceded-goal rate / configured league prior ×40; flagged home CB absence +15, away GK error +20. Average both and bound 0–100.'],
  p7_poisson: ['Score model', [], 'Home and away scoring rates generate a normalized score matrix. Sum the relevant score cells for each market.'],
  p8_xg: ['xG edge', ['homeXgAvg','awayXgAvg'], '50 + (home xG − away xG) ×15, rounded and bounded 20–80.'],
  p9_xga: ['Defensive solidity', ['homeXgaAvg','awayXgaAvg'], '50 + mean(configured league prior − each team xGA) ×22, rounded and bounded 15–85.'],
  p10_pace: ['Shots and conversion', ['homeShotsPerGame','awayShotsPerGame','homeConversionPct','awayConversionPct'], 'Combined shots /22 ×65 + mean conversion percent /15 ×35, rounded and bounded 0–100.'],
  p11_homeAdvantage: ['Home advantage', ['homePossession','homeShotsPerGame','awayShotsPerGame','venue','status'], 'Start at 55. Live possession contributes round((home possession −50) ×0.6). Home share of combined shots above 58% adds 8; below 40% subtracts 10. Bound 20–90. Core venue priors are separate.'],
  p12_market: ['Market comparison', [], 'Over 2.5 model probability minus 1/decimal odds. Indicator = 50 + difference ×80, bounded 20–80. Without that market, full 1X2 overround is used.'],
  p13_squad: ['Competition profile', ['leagueId','matchType'], 'Configured competition-class indicator: major leagues 76, UEFA 72, secondary leagues 62, other cups 45, other leagues 44.'],
  p14_lifecycle: ['Season progress', ['gameWeek','totalGW'], 'Played rounds / total rounds ×100 × phase multiplier /1.5; rounded, bounded 0–100. Phase multipliers: <50% 1, 50% 1.1, 65% 1.2, 80% 1.4, 90% 1.5.'],
  p15_crisis: ['Recent scoring and losing runs', ['homeGoalDrought','awayGoalDrought','homeRecentLosses','awayRecentLosses'], 'Start each side at 70. Scoreless streak 2/3–4/5+ subtracts 8/20/35. Losing streak 3 subtracts 10 home /8 away; 4+ subtracts 20 home /18 away. Average bounded side scores.'],
};
const label = key => key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());

export function buildEvidenceDesk(analysis = {}, match = {}, evidence = {}, now = Date.now()) {
  const core = analysis.predictionCore || {}, prior = core.priors || {}, panels = [];
  const parameters = {};
  for (const [key, [title, inputs, method]] of Object.entries(parameterSpecs)) {
    const p = analysis.parameters?.[key] || {};
    const rows = inputs.map(k => row(label(k), match[k]));
    rows.push(row('Indicator score (0–100)', p.score), row('Raw indicator before bounding', p.rawScore));
    if (['p6_defensiveGap','p9_xga'].includes(key)) rows.push(row('Configured league goals prior', prior.leagueGoalsPerTeam));
    if (key === 'p3_h2h') rows.push(row('Verified meetings', p.record?.total), row('Mean goals',p.goalsAvg), row('Over 2.5 frequency',p.overRate));
    if (key === 'p7_poisson') rows.push(row('Home scoring rate',analysis.poisson?.homeLambda),row('Away scoring rate',analysis.poisson?.awayLambda),row('Model basis',core.modelBasis),row('Home prior',prior.homeMultiplier),row('Away prior',prior.awayMultiplier),row('Prior sample weight',prior.shrinkMatches));
    if (key === 'p12_market') rows.push(row('Model probability',p.modelProb),row('Raw implied probability',p.mktImplied),row('Difference',p.divergence),row('Bookmaker',analysis.oddsSnapshot?.bookmaker?.name),row('Quote timestamp',analysis.oddsSnapshot?.providerUpdatedAt));
    parameters[key] = card(key,title,p.score == null ? 'Unavailable' : `${p.score}/100`,rows,method,
      key === 'p13_squad' ? 'Configured competition profile' : 'Fixture analysis inputs; checked '+(analysis.analysisTimestamp || 'Unavailable'),
      key === 'p7_poisson' ? 'Generates market probabilities' : key === 'p12_market' ? 'Price comparison; price also controls ticket eligibility' : 'Context indicator; its score is not a probability multiplier');
  }
  const cutoff = Math.min(stamp(match.kickoffUTC) ?? now, now);
  for (const side of ['home','away']) {
    const id = match[`${side}TeamId`], name = match[side] || side, info = evidence[side] || {};
    const fixtures = verifiedRecentResults(info.recentFixtures || match[`${side}RecentFixtures`],id,match.leagueId,match.season,cutoff);
    const mean = key => fixtures.length ? fixtures.reduce((s,f) => s+f[key],0)/fixtures.length : null;
    panels.push(card(`${side}-strength`,`${name}: team strength`,fixtures.length ? `${fixtures.length} verified league games` : 'Unavailable',[
      row('Points per game',fmt(mean('points'))),row('Scored per game',fmt(mean('gf'))),row('Conceded per game',fmt(mean('ga'))),
      row('Home scoring rate in model',analysis.poisson?.homeLambda),row('Away scoring rate in model',analysis.poisson?.awayLambda),
      ...fixtures.map(f => row(`${f.date?.slice(0,10)} · fixture ${f.id}`,`${f.gf} scored, ${f.ga} conceded; ${f.points} points`))],
    'Use completed games in this league and season before selection; maximum ten, newest first. Core scoring rates blend goals/xG and opponent defence with explicit priors. Opponent-adjusted form rating: unavailable.', 'API-Football fixtures / prediction core'));
    const lineup = lineupRecord(evidence.lineups,id), previous = lineupRecord(info.previousLineups,id);
    const retained = lineup && previous ? lineup.players.filter(p => previous.players.some(q => String(q.id) === String(p.id))).length : null;
    const absences = (Array.isArray(evidence.injuries) ? evidence.injuries : []).filter(i => String(i.team?.id) === String(id) && String(i.fixture?.id) === String(match.id));
    panels.push(card(`${side}-lineup`,`${name}: lineup`,lineup ? 'Published XI' : 'Unavailable',[
      row('Formation',lineup?.formation),row('Retained from last verified league XI',retained == null ? null : `${retained}/11`),
      row('Starting players',lineup?.players.map(p => p.name).join(', ')),
      row('Recorded absences / doubts',absences.length ? absences.map(i => `${i.player?.name}: ${i.player?.type} (${i.player?.reason || 'reason unavailable'})`).join('; ') : 'Unavailable')],
    'Match the exact fixture and team; a published XI requires eleven unique named players. Continuity counts matching player IDs against the last verified league fixture.', 'API-Football fixtures/lineups and fixture-specific injuries'));
    const coach = coachRecord(info.coaches,id,fixtures,cutoff);
    panels.push(card(`${side}-coach`,`${name}: coach`,coach?.name || 'Unavailable',[
      row('Recorded tenure began',coach?.start),row('Sample games before / during tenure',coach ? `${coach.beforeCount} / ${coach.afterCount}` : null),
      row('Points/game before tenure',fmt(coach?.beforePPG)),row('Points/game during tenure',fmt(coach?.afterPPG))],
    'Use the coach tenure covering selection time. Split the available recent league sample at its start date and compare points/game.', 'API-Football coach career dates and completed fixtures'));
    const late = info.lateGoals;
    panels.push(card(`${side}-late`,`${name}: late goals`,late?.sampled ? `${late.sampled} verified games` : 'Unavailable',[
      row('Games with complete goal-event coverage',late ? `${late.sampled}/${late.requested}` : null),
      row('Games scoring at 80+ minutes',late?.sampled ? late.scored : null),row('Games conceding at 80+ minutes',late?.sampled ? late.conceded : null),
      ...(late?.examples || []).map(e => row(`${e.date?.slice(0,10)} · fixture ${e.fixtureId}`,`${e.action} at ${e.minute} minutes`))],
    'Include 80–90 minutes and stoppage time. Count games, not goals. Reconcile all goal events to the final score before including a game.', 'API-Football fixture goal events'));
  }
  const events = evidence.currentEvents;
  const goals = (Array.isArray(events) ? events : []).filter(e => e.type === 'Goal' && !/missed|disallowed|cancelled/i.test(e.detail || '')
    && n(e.time?.elapsed) != null && n(e.time.elapsed) >= 0 && n(e.time.elapsed) <= 90
    && [match.homeTeamId,match.awayTeamId].some(id => id != null && String(id) === String(e.team?.id)));
  const score = String(match.score || '').match(/^(\d+)\s*[-:]\s*(\d+)$/);
  const complete = Array.isArray(events) && score && goals.filter(e=>String(e.team?.id)===String(match.homeTeamId)).length === Number(score[1])
    && goals.filter(e=>String(e.team?.id)===String(match.awayTeamId)).length === Number(score[2]);
  const early = goals.filter(e => Number(e.time.elapsed) <= 20 && !(Number(e.time.elapsed) === 20 && Number(e.time.extra) > 0));
  const chaos = [card('early-goal','Early goal',complete ? early.length ? 'Observed' : 'None recorded through current clock' : 'Unavailable',[
    row('Score at check',match.score),row('Minute at check',match.matchMinutes),row('Reconciled goal coverage',complete ? 'Complete through this score' : null),
    ...(complete ? early : []).map(e=>row(`${e.team?.name || 'Team'} · ${e.time.elapsed} minutes`,e.player?.name || 'Scorer unavailable'))],
  'A verified goal by minute 20. Reconcile goal events by team to the current score. The live core uses the score and remaining time.', 'API-Football fixtures/events', 'Observed match context; no separate probability boost')];
  for (const [id,title,method] of [['motivation','Match importance','Requires verified qualification or elimination scenarios.'],['bivariate','Goal dependence','The score model uses a configured low-score correction. A separately fitted match-specific dependence estimate is unavailable.'],['high-line','High line','Requires verified tactical positioning data.'],['possession-trap','Possession and chance quality','Possession alone does not establish tactical vulnerability.']])
    chaos.push(card(id,title,'Unavailable',[],method,'Required evidence unavailable'));
  const edges = (analysis.recommendations || []).filter(r=>r.marketKey).map(r => card(r.marketKey,r.selection,r.value?.decision || 'Unavailable',[
    row('Model probability (%)',n(r.probability01)==null ? null : +(r.probability01*100).toFixed(2)),
    row('Offered odds',r.value?.offeredOdds ?? analysis.odds?.[{home_win:'homeWin',away_win:'awayWin'}[r.marketKey] || r.marketKey]),
    row('Fair odds',r.value?.fairOdds),row('Minimum acceptable odds',r.value?.minimumAcceptableOdds),
    row('Expected value (%)',n(r.value?.expectedValue)==null ? null : +(r.value.expectedValue*100).toFixed(2)),
    row('Bookmaker',analysis.oddsSnapshot?.bookmaker?.name),row('Price updated',analysis.oddsSnapshot?.providerUpdatedAt)],
  'Fair odds = 1/probability. Expected value = execution probability × decimal odds −1. Price gate requires at least 5% expected value; ticket selection also checks fixture, freshness and kickoff.', 'Prediction core and API-Football odds', 'Controls priced selection eligibility'));
  return { parameters, panels, chaos, edges, checkedAt: evidence.checkedAt || analysis.analysisTimestamp || new Date(now).toISOString() };
}
