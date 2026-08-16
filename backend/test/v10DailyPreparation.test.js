import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../frontend/src/App.jsx', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../../frontend/src/components/DetailPanel.jsx', import.meta.url), 'utf8');
const feed = fs.readFileSync(new URL('../../frontend/src/components/MatchFeed.jsx', import.meta.url), 'utf8');
const envExample = fs.readFileSync(new URL('../.env.example', import.meta.url), 'utf8');

test('continuous football API poller is removed', () => {
  assert.equal(server.includes('Scheduled 6-hour recalibration'), false);
  assert.equal(server.includes('cron.schedule(`*/${POLL_TICK_SECONDS}'), false);
  assert.match(server, /Continuous API-Football polling disabled/);
});

test('daily preparation runs once at 05:00 UK', () => {
  assert.match(server, /cron\.schedule\('0 5 \* \* \*'/);
  assert.match(server, /DAILY_PREP_TIMEZONE = 'Europe\/London'/);
  assert.match(server, /timezone: DAILY_PREP_TIMEZONE/);
});

test('restart reuses same-day preparation and only catches up when missing after 05:00', () => {
  assert.match(server, /preparedDateUK === getUkDateStamp\(\)/);
  assert.match(server, /startup-catchup-after-05:00/);
  assert.match(server, /zero preparation calls/);
});

test('portal open performs a single-flight live refresh without background enrichment', () => {
  assert.match(server, /refreshLiveOnPortalOpen/);
  assert.match(server, /pollLiveMatches\(\{ forceApi: true, enrich: false \}\)/);
  assert.match(server, /PORTAL_OPEN_REFRESH_COOLDOWN_MS/);
});

test('morning analysis is bounded by fixture and team-call budgets', () => {
  assert.match(server, /DAILY_PREP_MAX_ANALYZED_FIXTURES/);
  assert.match(server, /DAILY_PREP_TEAM_CALL_BUDGET/);
  assert.match(server, /selectDailyPrepCandidates/);
  assert.match(server, /getEffectiveDailyPrepTeamBudget/);
});

test('full schedule stays lightweight while analyzed candidates are merged on top', () => {
  assert.match(server, /dailySchedule = apiFixtures[\s\S]*?map\(parseLightFixture\)/);
  assert.match(server, /preparedSchedule = mergeDailySchedule\\(dailySchedule, compactAnalyzed\\)/);
  assert.match(server, /dailySchedule,\n        preparedDateUK/);
});

test('authoritative fixture ID and kickoff are retained', () => {
  assert.match(server, /fixtureId: f\.fixture\?\.id/);
  assert.match(server, /id: matchMeta\.fixtureId/);
  assert.match(server, /kickoffUTC: f\.fixture\?\.date/);
});

test('frontend has no automatic 30-second football refresh', () => {
  assert.equal(app.includes('Refresh live matches every 30s'), false);
  assert.equal(panel.includes('setInterval(loadAnalysis, 30000)'), false);
});

test('match rows show date and time in Europe London timezone', () => {
  assert.match(feed, /toLocaleDateString/);
  assert.match(feed, /toLocaleTimeString/);
  assert.match(feed, /timeZone: 'Europe\/London'/);
});

test('Prediction Desk clicks automatically enrich selected fixtures', () => {
  assert.match(server, /const clickEnrichmentEnabled = body\.enrich !== false/);
  assert.match(server, /getTeamStatistics\(homeTeamId/);
  assert.match(server, /getTeamInjuries\(homeTeamId/);
  assert.match(server, /getH2H\(homeTeamId, awayTeamId\)/);
  assert.match(server, /if \(clickEnrichmentEnabled && isLive && fixtureId\)/);
});


test('whole-day Pro-plan scan capacity covers the previously observed 1215-fixture day', () => {
  assert.match(server, /DAILY_PREP_MAX_ANALYZED_FIXTURES,[\s\S]*?1250/);
  assert.match(server, /DAILY_PREP_TEAM_CALL_BUDGET,[\s\S]*?2500/);
});

test('periodic live intelligence runs every two hours and feeds the alert pipeline', () => {
  assert.match(server, /LIVE_INTELLIGENCE_INTERVAL_HOURS/);
  assert.match(server, /runLiveIntelligenceScan/);
  assert.match(server, /pollLiveMatches\(\{ forceApi: true, enrich: true \}\)/);
  assert.match(server, /await saveAlert\(/);
});

test('manual recalibration is explicitly declared and disabled by default', () => {
  assert.match(server, /const ALLOW_MANUAL_DAILY_PREP = String\(/);
  assert.match(server, /if \(!ALLOW_MANUAL_DAILY_PREP\)/);
  assert.match(envExample, /ALLOW_MANUAL_DAILY_PREP=false/);
});

test('zero deep-analysis budget preserves the authoritative API schedule', () => {
  assert.match(server, /if \(dailySchedule\.length === 0\) \{[\s\S]*?TheSportsDB may supply fixture discovery only/);
  assert.match(server, /Authoritative schedule retained; deep analysis skipped by quota budget/);
});


test('Daily 80+ UI requires Agent47 eligibility and score >= 80', () => {
  assert.match(app, /dailySignal = m\.dailySignal \|\| m\.analysis\?\.dailySignal/);
  assert.match(app, /dailySignal\?\.eligible !== true/);
  assert.match(app, /signalScore < 80/);
  assert.equal(app.includes("filter === 'high' && (m.confidence || 0) < 80"), false);
});
