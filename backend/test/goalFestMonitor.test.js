import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createGoalFestMonitor,
  goalFestPriority,
  selectGoalFestScanMatches,
  summarizeGoalFestStudies,
} from '../src/services/goalFestMonitorService.js';

const match = (id, minute, score) => ({
  id,
  home: 'Home',
  away: 'Away',
  league: 'Test',
  leagueId: 1,
  status: minute < 46 ? '1H' : '2H',
  matchMinutes: minute,
  score,
  homeTeamId: id * 10,
  awayTeamId: id * 10 + 1,
  kickoffUTC: '2026-10-06T18:00:00Z',
});

test('Goal Fest prioritises explosive scorelines before quiet matches', () => {
  const quiet = match(1, 55, '0-0');
  const one = match(2, 22, '1-0');
  const explosive = match(3, 35, '2-2');
  assert.ok(goalFestPriority(explosive) > goalFestPriority(one));
  assert.ok(goalFestPriority(one) > goalFestPriority(quiet));
  const selected = selectGoalFestScanMatches([quiet, one, explosive], 2, 0).matches;
  assert.equal(selected[0].id, 3);
  assert.ok(selected.some((m) => m.id === 2 || m.id === 1));
});

test('background monitor can alert without a portal or Daily Desk dependency', async () => {
  const alerts = [];
  const published = [];
  let statsCalls = 0;
  const monitor = createGoalFestMonitor({
    getDb: () => null,
    readLive: async () => [match(10, 30, '2-1'), match(11, 40, '0-0')],
    readStats: async () => {
      statsCalls++;
      return {
        shots: { home: 6, away: 5 },
        totalShots: { home: 10, away: 9 },
        xg: { home: 1.4, away: 1.2 },
        possession: { home: 52, away: 48 },
        corners: { home: 4, away: 3 },
        cards: { home: { red: 0 }, away: { red: 0 } },
      };
    },
    evaluate: (m) => ({
      active: m.id === 10,
      level: m.id === 10 ? 'HOT' : 'NONE',
      score: m.id === 10 ? 91 : 20,
      status: m.id === 10 ? 'ACTIVE' : 'BELOW_THRESHOLD',
      summary: 'verified pressure',
    }),
    saveAlert: async (a) => alerts.push(a),
    publish: async (rows) => published.push(...rows),
    canCall: () => true,
    scanLimit: 2,
    dailyDeepScanLimit: 10,
    now: () => Date.parse('2026-10-06T18:30:00Z'),
    log: {},
  });
  const result = await monitor.tick('test');
  assert.equal(result.deepScanned, 2);
  assert.equal(statsCalls, 2);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'GOAL_FEST');
  assert.equal(published.length, 2);
});

test('Goal Fest study summary exposes missed high scorers', () => {
  const summary = summarizeGoalFestStudies([
    { settlementStatus: 'SETTLED', highScoring: true, flagged: true },
    { settlementStatus: 'SETTLED', highScoring: true, flagged: false, missedHighScorer: true },
    { settlementStatus: 'SETTLED', highScoring: false, flagged: true },
    { settlementStatus: 'PENDING' },
  ]);
  assert.equal(summary.highScorers, 2);
  assert.equal(summary.detectedHighScorers, 1);
  assert.equal(summary.missedHighScorers, 1);
  assert.equal(summary.flaggedNonHighScorers, 1);
  assert.equal(summary.highScorerDetectionRate, 0.5);
});

test('server wires Goal Fest as an always-on background monitor', () => {
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /createGoalFestMonitor/);
  assert.match(server, /goalFestMonitor\.tick\('background'\)/);
  assert.doesNotMatch(server, /!DAILY_DESK_ENABLED\s*&&\s*goalFest\.active/);
  assert.doesNotMatch(server, /cheap, bounded Goal Fest scan while the portal is in use/);
});
