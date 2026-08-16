import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const analytics = fs.readFileSync(new URL('../src/services/analyticsService.js', import.meta.url), 'utf8');
const gemini = fs.readFileSync(new URL('../src/services/geminiService.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../../frontend/src/services/api.js', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../../frontend/src/components/DetailPanel.jsx', import.meta.url), 'utf8');

test('analytics requests use single-flight pacing instead of direct axios GET bursts', () => {
  assert.match(analytics, /async function singleFlightGet/);
  assert.match(analytics, /ANALYTICS_MIN_REQUEST_GAP_MS/);
  assert.match(analytics, /analyticsInFlight/);
  assert.equal(analytics.includes('axiosInstance.get('), false);
});

test('a 429 opens an analytics cooldown', () => {
  assert.match(analytics, /ANALYTICS_429_COOLDOWN_MS/);
  assert.match(analytics, /analyticsRateLimitedUntil/);
});

test('live polling broadcasts lightweight fixtures before bounded deep enrichment', () => {
  assert.match(server, /pickLiveBackgroundEnrichment/);
  assert.match(server, /LIVE_BACKGROUND_ENRICH_LIMIT/);
  assert.match(server, /const lightweightLive =/);
  assert.match(server, /broadcast\(\{ type: 'LIVE_MATCHES', payload: liveMatches \}\)/);
});

test('fixture id is preserved in lightweight parser', () => {
  assert.match(server, /id:\s+fixture\.id \|\|/);
});

test('/api/analyze does not await analyst prose', () => {
  assert.equal(server.includes('const narrative = await generateMatchNarrative(analysis, enriched);'), false);
  assert.match(server, /startNarrativeGeneration\(narrativeKey, analysis, enriched\)/);
  assert.match(server, /app\.get\('\/api\/analyze\/narrative\/:key'/);
});

test('Gemini has a cooldown circuit for quota or demand spikes', () => {
  assert.match(gemini, /GEMINI_COOLDOWN_MS/);
  assert.match(gemini, /isGeminiCoolingDown/);
  assert.match(gemini, /maybeOpenGeminiCircuit/);
});

test('frontend keeps cached analysis visible during refresh failures', () => {
  assert.match(panel, /if \(!existingAnalysis\)/);
  assert.match(panel, /apiService\.analyzeMatch\(matchData\)/);
});

test('analyst narrative is polled separately from football analysis', () => {
  assert.match(api, /getNarrative:/);
  assert.match(panel, /pollNarrative/);
  assert.match(panel, /Generating in background/);
});

test('queued analytics requests re-check the 429 circuit after pacing wait', () => {
  const waitIdx = analytics.indexOf('await waitForAnalyticsLaunchSlot();');
  const requestIdx = analytics.indexOf('return await axiosInstance.request({', waitIdx);
  const secondCircuitIdx = analytics.indexOf('if (Date.now() < analyticsRateLimitedUntil)', waitIdx + 1);
  assert.ok(waitIdx >= 0);
  assert.ok(secondCircuitIdx > waitIdx && secondCircuitIdx < requestIdx);
});

test('direct fixture statistics obey the API quota guard', () => {
  const liveBlockStart = server.indexOf('if (ALLOW_ON_DEMAND_API_ENRICHMENT && isLive && fixtureId) {');
  const fetchIdx = server.indexOf('const directStats = await fetchFixtureStatistics(fixtureId);', liveBlockStart);
  const allowedElseIdx = server.lastIndexOf('} else {', fetchIdx);
  const skipIdx = server.indexOf('else if (shouldSkipApiCalls())', liveBlockStart);
  assert.ok(liveBlockStart >= 0 && skipIdx > liveBlockStart);
  assert.ok(allowedElseIdx > skipIdx && fetchIdx > allowedElseIdx);
});

test('unused aggregate H2H is not fetched on automatic analysis hot paths', () => {
  const backgroundStart = server.indexOf('async function analyzeMatch(match)');
  const backgroundEnd = server.indexOf('// ─── LIVE POLLER', backgroundStart);
  const clickStart = server.indexOf("app.post('/api/analyze'");
  const clickEnd = server.indexOf("app.get('/api/analyze/live/", clickStart);
  assert.equal(server.slice(backgroundStart, backgroundEnd).includes('getH2H('), false);
  assert.equal(server.slice(clickStart, clickEnd).includes('getH2H('), false);
  assert.match(server, /app\.get\('\/api\/h2h\/:homeTeamId\/:awayTeamId'/);
});

test('changing selected match resets DetailPanel before background refresh', () => {
  assert.match(panel, /const initialAnalysis = preloadedAnalysis \|\| null/);
  assert.match(panel, /setAnalysis\(initialAnalysis\)/);
  assert.match(panel, /loadAnalysis\(initialAnalysis\)/);
});
