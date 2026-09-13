import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

process.env.API_FOOTBALL_KEY = 'local-test-no-network';
process.env.API_FOOTBALL_OFFLINE_MODE = 'false';
process.env.ANALYTICS_MIN_REQUEST_GAP_MS = '100';
process.env.ANALYST_CONTEXT_DAILY_CALL_LIMIT = '160';
const calls = [];
axios.defaults.adapter = async (config) => {
  calls.push({ url: config.url, params: config.params });
  let response = [];
  if (config.url === '/leagues') response = [{ league: { id: 39, type: 'League' }, seasons: [
    { year: 2026, start: '2026-08-01', end: '2027-05-30' }, { year: 2025, end: '2026-05-30' }] }];
  if (config.url === '/fixtures/events') response = [{ type: 'Goal', detail: 'Normal Goal',
    time: { elapsed: 85 }, team: { id: 1 } }];
  if (config.url === '/teams/statistics') response = { fixtures: {
    played: { total: 38 }, wins: { total: 15 }, draws: { total: 10 } } };
  return { status: 200, statusText: 'OK', headers: { 'x-ratelimit-requests-remaining': '7000' },
    data: { response, errors: [] }, config };
};
const { getAnalystEvidence } = await import('../src/services/analyticsService.js');
const f = { id: 1, leagueId: 39, season: 2026, homeTeamId: 1, awayTeamId: 2,
  date: '2026-08-30T12:00:00Z', status: { short: 'FT' }, homeGoals: 1, awayGoals: 0 };
const match = { homeTeamId: 1, awayTeamId: 2, leagueId: 39, season: 2026,
  kickoffUTC: '2026-09-13T12:00:00Z', homeRecentFixtures: [f], awayRecentFixtures: [f] };

test('event requests are shared, exact season/orientation is retained and repeated clicks use cache', async () => {
  let reported = 0;
  const options = { shouldSkipApiCalls: () => false, updateQuotaFromHeaders: () => reported++ };
  const evidence = await getAnalystEvidence(match, options);
  assert.equal(evidence.home.lateGoals.scored, 1);
  assert.equal(evidence.away.lateGoals.conceded, 1);
  assert.equal(evidence.home.previousRecord.played, 38);
  assert.equal(calls.filter((c) => c.url === '/fixtures/events').length, 1);
  assert.equal(calls.find((c) => c.url === '/teams/statistics').params.season, 2025);
  const count = calls.length;
  await getAnalystEvidence(match, options);
  assert.equal(calls.length, count); assert.equal(reported, count);
});
test('explicit enrich:false and paused quota spend no new requests', async () => {
  const count = calls.length;
  await getAnalystEvidence({ ...match, enrich: false }, { shouldSkipApiCalls: () => false });
  await getAnalystEvidence(match, { shouldSkipApiCalls: () => true });
  assert.equal(calls.length, count);
});
test('unrelated, future, non-final and cross-season fixtures are never fetched', async () => {
  const evidence = await getAnalystEvidence({ ...match, homeRecentFixtures: [
    { ...f, id: 2, season: 2025 }, { ...f, id: 3, status: { short: '2H' } },
    { ...f, id: 4, date: '2026-10-01' }, { ...f, id: 5, homeTeamId: 3, awayTeamId: 4 }] },
    { shouldSkipApiCalls: () => false });
  assert.equal(evidence.home.lateGoals.sampled, 0);
  assert.equal(calls.filter((c) => c.url === '/fixtures/events').length, 1);
});
test('daily context ceiling is enforced even when quota otherwise allows requests', async () => {
  process.env.ANALYST_CONTEXT_DAILY_CALL_LIMIT = '2';
  const isolated = await import('../src/services/analyticsService.js?budget-test');
  const count = calls.length;
  await isolated.getAnalystEvidence(match, { shouldSkipApiCalls: () => false });
  assert.equal(calls.length - count, 2);
  await isolated.getAnalystEvidence(match, { shouldSkipApiCalls: () => false });
  assert.equal(calls.length - count, 2);
  process.env.ANALYST_CONTEXT_DAILY_CALL_LIMIT = '160';
});
