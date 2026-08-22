import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../../frontend/src/App.jsx', import.meta.url), 'utf8');

test('daily portal payload is compact rather than broadcasting full Agent47 analysis for every fixture', () => {
  assert.match(server, /compactAnalyzedMatch/);
  assert.match(server, /const preparedSchedule = mergeDailySchedule\(dailySchedule, compactAnalyzed\)/);
  assert.match(app, /m\.dailySignal \|\| m\.analysis\?\.dailySignal/);
});

test('calibration persistence uses Firestore schedule chunks', () => {
  assert.match(server, /collection\('scheduleChunks'\)/);
  assert.match(server, /chunkArray\(persistedSchedule, 50\)/);
  assert.match(server, /schemaVersion: 2/);
  assert.equal(server.includes('matches: analyzed,\n        highConfidence,'), false);
});

test('prediction history writes are split below Firestore 500-write batch limit', () => {
  assert.match(server, /chunkArray\(analyzed, 400\)/);
  assert.match(server, /predictions stored in Firestore in <=400-write batches/);
  assert.match(server, /permanent ledger/);
  assert.equal(server.includes('deleteAfter: deleteAfter.toISOString()'), false);
});

test('morning WhatsApp alerts are reserved for top Daily-80+ signals', () => {
  assert.match(server, /DAILY_PREP_WHATSAPP_ALERT_LIMIT/);
  assert.match(server, /const dailyAlertMatches = highConfidence/);
  assert.match(server, /for \(const m of dailyAlertMatches\)/);
});

test('calibration results endpoint returns compact matches instead of spreading full in-memory store', () => {
  const start = server.indexOf("app.get('/api/calibrate/results'");
  const end = server.indexOf('/**\n * Fuzzy-search', start);
  const block = server.slice(start, end);
  assert.match(block, /compactMatches/);
  assert.equal(block.includes('...calibrationStore'), false);
});

test('startup can restore chunked daily state', () => {
  assert.match(server, /scheduleChunkCount/);
  assert.match(server, /chunkSnap\.docs\.flatMap/);
  assert.match(server, /Restored today's chunked daily preparation/);
});


test('live intelligence fails closed instead of inventing missing metrics', () => {
  const live = fs.readFileSync(new URL('../src/services/liveAnalyticsService.js', import.meta.url), 'utf8');
  assert.match(live, /Missing verified live evidence/);
  assert.equal(live.includes('match.possession?.home || 50'), false);
  assert.equal(live.includes('match.xg?.home || 0'), false);
  assert.equal(live.includes('match.shots?.home || 0'), false);
  assert.equal(live.includes(': 0.08'), false);
  assert.match(server, /requiredLiveMetrics\.every/);
});


test('search UI fails closed instead of fabricating match statistics', () => {
  assert.match(app, /Array\.isArray\(payload\.matches\)/);
  assert.match(app, /No authoritative fixture found/);
  assert.match(app, /setSelectedMatch\(first\)/);
  assert.equal(app.includes('confidence: analysis.overallScore || 50'), false);
  assert.equal(app.includes('possession: { home: 50, away: 50 }'), false);
  assert.equal(app.includes('shots: { home: 0, away: 0 }'), false);
  assert.equal(app.includes('xg: { home: 0, away: 0 }'), false);
});
