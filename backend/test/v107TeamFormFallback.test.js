import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.API_FOOTBALL_KEY = 'local-test-no-network';
process.env.API_FOOTBALL_OFFLINE_MODE = 'false';
process.env.ANALYTICS_MIN_REQUEST_GAP_MS = '1';

const fx = (id, date, league, season, hg, ag, home = 1, away = 2) => ({
  fixture: { id, date, status: { short: 'FT' } }, league: { id: league, name: `L${league}`, season },
  teams: { home: { id: home, name: `T${home}` }, away: { id: away, name: `T${away}` } },
  goals: { home: hg, away: ag }, score: { fulltime: { home: hg, away: ag } },
});
const calls = [];
const leagueRows = {
  // team 1: only 2 games in league 39/2026 → needs fallback
  '1:39': [fx(1, '2026-09-01T12:00:00Z', 39, 2026, 2, 0), fx(2, '2026-09-08T12:00:00Z', 39, 2026, 1, 1)],
  // team 3: 6 games → no fallback
  '3:39': [1, 2, 3, 4, 5, 6].map((i) => fx(30 + i, `2026-08-0${i}T12:00:00Z`, 39, 2026, 1, 0, 3, 4)),
};
axios.defaults.adapter = async (config) => {
  calls.push({ url: config.url, params: { ...config.params } });
  let response = [];
  const p = config.params || {};
  if (config.url === '/fixtures' && p.league) response = leagueRows[`${p.team}:${p.league}`] || [];
  if (config.url === '/fixtures' && !p.league && p.team === 1) {
    response = [fx(1, '2026-09-01T12:00:00Z', 39, 2026, 2, 0), fx(20, '2026-08-25T12:00:00Z', 2, 2026, 0, 0),
      fx(21, '2026-05-01T12:00:00Z', 39, 2025, 4, 0), fx(22, '2026-09-25T12:00:00Z', 2, 2026, 9, 9)];
  }
  if (config.url === '/leagues' && p.current) {
    response = [{ league: { id: 39 }, seasons: [{ year: 2026, current: true, coverage: { fixtures: { events: true, statistics_fixtures: true }, standings: true, injuries: false, odds: true } }] }];
  }
  if (config.url === '/leagues' && p.id) {
    response = [{ league: { id: p.id }, seasons: [{ year: 2025, coverage: { fixtures: {}, standings: false, injuries: false, odds: false } }] }];
  }
  return { status: 200, statusText: 'OK', headers: {}, data: { response, errors: [] }, config };
};
const { getTeamForm, getLeagueCoverage } = await import('../src/services/analyticsService.js');

test('B: a thin competition sample makes one extra any-competition call and is labelled ESTIMATED', async () => {
  const before = calls.length;
  const r = await getTeamForm(1, 39, 2026, { before: '2026-09-20T15:00:00Z' });
  const made = calls.slice(before);
  assert.equal(made.length, 2);
  assert.deepEqual(made[1].params, { team: 1, last: 20 });
  assert.equal(r.evidence.quality, 'ESTIMATED');
  assert.equal(r.evidence.fallbackStatus, 'used');
  // game 22 is after kickoff and is excluded
  assert.deepEqual(r.matches.map((m) => m.id), [2, 1, 20, 21]);
  assert.equal(r.stats.effectiveSampleSize, 3);
  // cached: a repeat click costs nothing
  const again = calls.length;
  await getTeamForm(1, 39, 2026, { before: '2026-09-20T15:00:00Z' });
  assert.equal(calls.length, again);
});

test('B: a full competition sample never spends the fallback call', async () => {
  const before = calls.length;
  const r = await getTeamForm(3, 39, 2026, { before: '2026-09-20T15:00:00Z' });
  assert.equal(calls.length - before, 1);
  assert.equal(r.evidence.quality, 'MEASURED');
  assert.equal(r.evidence.fallbackStatus, 'not_needed');
});

test('B: the daily-prep budget callback can refuse the fallback call', async () => {
  const before = calls.length;
  const r = await getTeamForm(5, 39, 2026, { before: '2026-09-20T15:00:00Z', allowFallback: () => false });
  assert.equal(calls.length - before, 1);
  assert.equal(r.evidence.quality, 'UNAVAILABLE');
  assert.equal(r.evidence.fallbackStatus, 'skipped');
  assert.equal(r.stats.avgGoalsFor, null);
});

test('E: league coverage is one shared call per day for current seasons', async () => {
  const before = calls.length;
  const c1 = await getLeagueCoverage(39, 2026);
  const c2 = await getLeagueCoverage(39, 2026);
  assert.equal(calls.length - before, 1);
  assert.equal(c1.injuries, false);
  assert.equal(c2.standings, true);
  // an older season falls back to a single cached per-league lookup
  const old = await getLeagueCoverage(39, 2025);
  await getLeagueCoverage(39, 2025);
  assert.equal(calls.length - before, 2);
  assert.equal(old.odds, false);
  assert.equal(await getLeagueCoverage(39, 2026, { canLaunch: () => false }) !== null, true);
});
