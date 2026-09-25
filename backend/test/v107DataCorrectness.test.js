import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildTeamEvidence, compactFixtureRows, formResultToModelInputs, isUsableStoredGoalInputs,
} from '../../shared/teamEvidence.js';
import {
  applyStatusOverlay, datesNeedingStatusRefresh, isPredictionLocked, statusEntryFromProviderFixture,
  statusEntryFromLiveMatch, updateStatusOverlay,
} from '../../shared/fixtureStatus.js';
import { coveragePlan, parseLeagueCoverage } from '../../shared/leagueCoverage.js';
import { buildPredictionCore } from '../src/services/predictionEngineV10.js';

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

// Compact row helper: team 1 plays; `gf`/`ga` from team 1's perspective.
const row = (id, date, gf, ga, { league = 39, season = 2026, home = true } = {}) => ({
  id, date, leagueId: league, season, leagueName: `L${league}`,
  homeTeamId: home ? 1 : 9, awayTeamId: home ? 9 : 1, home: home ? 'Us' : 'Them', away: home ? 'Them' : 'Us',
  homeGoals: home ? gf : ga, awayGoals: home ? ga : gf, status: { short: 'FT' },
});

// ── A: missing is missing ──────────────────────────────────────────────────
test('A: no completed matches gives null averages and null form, never 0 / "Unavailable"', () => {
  const r = buildTeamEvidence({ teamId: 1, leagueId: 39, season: 2026, before: '2026-09-20T15:00:00Z' });
  assert.equal(r.stats.avgGoalsFor, null);
  assert.equal(r.stats.avgGoalsAgainst, null);
  assert.equal(r.stats.form, null);
  assert.equal(r.evidence.quality, 'UNAVAILABLE');
  assert.equal(r.evidence.source, 'NONE');
});

test('A: legacy placeholder form results are rejected as model inputs', () => {
  const legacy = { teamId: 1, matches: [], stats: { avgGoalsFor: 0, avgGoalsAgainst: 0, form: 'Unavailable' } };
  const inputs = formResultToModelInputs(legacy);
  assert.equal(inputs.goalsAvgFor, null);
  assert.equal(inputs.form, null);
  assert.equal(inputs.sampleSize, 0);
  const bogusForm = formResultToModelInputs({ matches: [row(1, '2026-09-01T12:00:00Z', 1, 0)], stats: { form: 'Unavailable', avgGoalsFor: '1.00', avgGoalsAgainst: '0.00' } });
  assert.equal(bogusForm.form, null, '"Unavailable" must never become "U-n-a-v-a-i-l-a-b-l-e"');
  assert.equal(formResultToModelInputs({ offline: true }).sampleSize, null);
});

test('A: stored calibration inputs with a zero sample are not reused', () => {
  assert.equal(isUsableStoredGoalInputs({ homeSampleSize: 0, homeGoalsAvgFor: 0, homeGoalsAvgAgainst: 0 }, 'home'), false);
  assert.equal(isUsableStoredGoalInputs({ homeSampleSize: null, homeGoalsAvgFor: 1.2, homeGoalsAvgAgainst: 1 }, 'home'), false);
  assert.equal(isUsableStoredGoalInputs({ awaySampleSize: 6, awayGoalsAvgFor: 1.2, awayGoalsAvgAgainst: 0.8 }, 'away'), true);
});

test('A: the model reports missing rates instead of predicting from zeros', () => {
  const inputs = formResultToModelInputs({ matches: [], stats: { avgGoalsFor: 0, avgGoalsAgainst: 0, form: 'Unavailable' } });
  const core = buildPredictionCore({ season: 2026, homeGoalsAvgFor: inputs.goalsAvgFor, homeGoalsAvgAgainst: inputs.goalsAvgAgainst,
    awayGoalsAvgFor: 1.4, awayGoalsAvgAgainst: 1.1, homeSampleSize: inputs.sampleSize, awaySampleSize: 8 });
  assert.equal(core.coreReady, false);
  assert.equal(core.signalScore, null);
  assert.ok(core.dataQuality.missing.includes('home goals-for rate'));
});

// ── B: fallback evidence with honest labels ────────────────────────────────
test('B: five or more competition games → MEASURED, no fallback used', () => {
  const primary = [1, 2, 3, 4, 5, 6].map((i) => row(i, `2026-09-0${i}T12:00:00Z`, 2, 1));
  const r = buildTeamEvidence({ teamId: 1, leagueId: 39, season: 2026, before: '2026-09-20T00:00:00Z', primaryRows: primary,
    fallbackRows: [row(99, '2026-09-10T12:00:00Z', 5, 0, { league: 2 })] });
  assert.equal(r.evidence.quality, 'MEASURED');
  assert.equal(r.evidence.source, 'COMPETITION_SEASON');
  assert.equal(r.stats.effectiveSampleSize, 6);
  assert.equal(r.stats.avgGoalsFor, '2.00');
  assert.ok(!r.matches.some((m) => m.id === 99));
});

test('B: few competition games are topped up from other competitions and last season at half weight', () => {
  const primary = [row(1, '2026-09-01T12:00:00Z', 3, 0), row(2, '2026-09-08T12:00:00Z', 3, 0)];
  const fallback = [
    row(1, '2026-09-01T12:00:00Z', 3, 0), // duplicate of a primary row — counted once
    row(10, '2026-08-20T12:00:00Z', 1, 1, { league: 2 }),
    row(11, '2026-05-10T12:00:00Z', 1, 1, { season: 2025 }),
    row(12, '2026-08-10T12:00:00Z', 1, 1, { league: 667 }), // club friendly: ignored
  ];
  const r = buildTeamEvidence({ teamId: 1, leagueId: 39, season: 2026, before: '2026-09-20T00:00:00Z', primaryRows: primary, fallbackRows: fallback });
  assert.equal(r.evidence.source, 'MIXED');
  assert.equal(r.evidence.quality, 'ESTIMATED');
  assert.equal(r.evidence.competitionSeason, 2);
  assert.equal(r.evidence.otherCompetitions, 1);
  assert.equal(r.evidence.previousSeasonSameCompetition, 1);
  assert.equal(r.stats.sampleSize, 4);
  assert.equal(r.stats.effectiveSampleSize, 3); // 2×1 + 2×0.5
  // weighted: (3+3 + 0.5+0.5) / 3 = 2.33
  assert.equal(r.stats.avgGoalsFor, '2.33');
  assert.match(r.evidence.note, /2 games in this competition this season \+ 1 from last season \+ 1 from other competitions/);
  assert.ok(!r.matches.some((m) => m.id === 12));
});

test('B: a thin sample with no other games is LIMITED, not dressed up', () => {
  const r = buildTeamEvidence({ teamId: 1, leagueId: 39, season: 2026, before: '2026-09-20T00:00:00Z', primaryRows: [row(1, '2026-09-01T12:00:00Z', 1, 0)] });
  assert.equal(r.evidence.quality, 'LIMITED');
  assert.match(r.evidence.note, /Only 1 game/);
});

// ── C: never analyse a match using its own result ─────────────────────────
test('C: games at or after kickoff (including the fixture itself) are excluded', () => {
  const kickoff = '2026-09-20T15:00:00Z';
  const primary = [row(1, '2026-09-10T12:00:00Z', 0, 0), row(500, kickoff, 7, 0), row(501, '2026-09-21T12:00:00Z', 6, 0)];
  const r = buildTeamEvidence({ teamId: 1, leagueId: 39, season: 2026, before: kickoff, primaryRows: primary });
  assert.deepEqual(r.matches.map((m) => m.id), [1]);
  assert.equal(r.stats.avgGoalsFor, '0.00');
});

test('C: compact rows keep only regulation-time final scores', () => {
  const provider = [
    { fixture: { id: 1, date: '2026-09-01T12:00:00Z', status: { short: 'FT' } }, league: { id: 39, season: 2026 },
      teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } }, goals: { home: 2, away: 1 }, score: { fulltime: { home: 2, away: 1 } } },
    { fixture: { id: 2, date: '2026-09-02T12:00:00Z', status: { short: '2H' } }, league: { id: 39, season: 2026 },
      teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } }, goals: { home: 1, away: 0 }, score: {} },
  ];
  const rows = compactFixtureRows(provider);
  assert.deepEqual(rows.map((r) => r.id), [1]);
  assert.equal(rows[0].homeGoals, 2);
});

test('C: status overlay turns stale NS into live/finished and locks predictions from kickoff', () => {
  const now = Date.parse('2026-09-20T17:00:00Z');
  const overlay = new Map();
  updateStatusOverlay(overlay, [
    statusEntryFromProviderFixture({ fixture: { id: 7, status: { short: 'FT', elapsed: 90 } }, goals: { home: 2, away: 2 } }, now),
    statusEntryFromLiveMatch({ id: 8, status: '2H', matchMinutes: 67, score: '1-0' }, now),
  ]);
  const feed = [
    { id: 7, status: 'NS', score: '0-0', kickoffUTC: '2026-09-20T14:00:00Z' },
    { id: 8, status: 'NS', score: '0-0', kickoffUTC: '2026-09-20T15:45:00Z' },
    { id: 9, status: 'NS', score: '0-0', kickoffUTC: '2026-09-20T19:00:00Z' },
  ];
  const [ft, live, later] = applyStatusOverlay(feed, overlay, now);
  assert.equal(ft.status, 'FT'); assert.equal(ft.score, '2-2'); assert.equal(ft.predictionLocked, true);
  assert.equal(live.status, '2H'); assert.equal(live.matchMinutes, 67); assert.equal(live.isLive, true);
  assert.equal(later.status, 'NS'); assert.equal(later.predictionLocked, undefined);
  // A later stale live entry never reverts a finished match.
  updateStatusOverlay(overlay, [statusEntryFromLiveMatch({ id: 7, status: '2H', matchMinutes: 88, score: '2-2' }, now + 1000)]);
  assert.equal(overlay.get('7').status, 'FT');
  assert.equal(isPredictionLocked({ kickoffUTC: '2026-09-20T16:59:00Z', status: 'NS' }, now), true);
  assert.equal(isPredictionLocked({ kickoffUTC: '2026-09-20T17:30:00Z', status: 'NS' }, now), false);
});

test('C: status refresh only targets dates with kicked-off, unfinished fixtures', () => {
  const now = Date.parse('2026-09-20T17:00:00Z');
  const overlay = new Map([['7', { id: '7', status: 'FT', updatedAt: now }]]);
  const feed = [
    { id: 7, kickoffUTC: '2026-09-20T14:00:00Z' },
    { id: 8, kickoffUTC: '2026-09-20T15:45:00Z' },
    { id: 9, kickoffUTC: '2026-09-20T19:00:00Z' },
  ];
  assert.deepEqual(datesNeedingStatusRefresh(feed, overlay, now), ['2026-09-20']);
  assert.deepEqual(datesNeedingStatusRefresh(feed.filter((m) => m.id !== 8), overlay, now), []);
});

test('C: server locks finished matches, filters kicked-off prep candidates and never shows 0 for no prediction', () => {
  assert.match(server, /async function resolveKickoffLock/);
  assert.match(server, /const lockResult = await resolveKickoffLock\(body, fixtureId, kickoffCutoff\)/);
  assert.match(server, /Showing the prediction that was locked before kickoff/);
  assert.match(server, /noPrediction: true/);
  assert.match(server, /\.filter\(\(f\) => Date\.parse\(f\.kickoffUTC\) > now\)/);
  assert.match(server, /confidence: analysis\?\.dailySignal\?\.score \?\? null/);
  assert.equal(server.includes('confidence: analysis?.dailySignal?.score ?? 0'), false);
  assert.match(server, /confidence: numOrNull\(match\.confidence\)/);
  assert.match(server, /withFixtureStatuses\(mergeDailySchedule/);
  assert.match(server, /getTeamForm\(homeTeamId, leagueId, season, \{ before: kickoffCutoff \}\)/);
  assert.equal(server.includes("hs.form.split('').join('-')"), false);
  assert.equal(server.includes("as.form.split('').join('-')"), false);
});

// ── E: coverage before calling ─────────────────────────────────────────────
test('E: league coverage flags are parsed and drive which calls are skipped', () => {
  const rows = [
    { league: { id: 39 }, seasons: [{ year: 2026, current: true, coverage: { fixtures: { events: true, statistics_fixtures: true }, standings: true, injuries: true, odds: true } }] },
    { league: { id: 999 }, seasons: [{ year: 2026, current: true, coverage: { fixtures: { events: false, statistics_fixtures: false }, standings: false, injuries: false, odds: false } }] },
  ];
  const map = parseLeagueCoverage(rows);
  assert.equal(map['39'].standings, true);
  assert.deepEqual(coveragePlan(map['999']).skipped, ['standings', 'injuries', 'odds', 'fixtureStats']);
  assert.equal(coveragePlan(null).known, false);
  assert.equal(coveragePlan(null).odds, true, 'unknown coverage never blocks a call');
  assert.match(server, /coverage\.standings \? getStandings/);
  assert.match(server, /coverage\.injuries \? getTeamInjuries/);
  assert.match(server, /LEAGUE_ODDS_NOT_COVERED/);
});
