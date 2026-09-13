import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describeMatchClock } from '../../shared/matchClock.js';
import { goalFestView } from '../../shared/goalFestView.js';
import { buildGroundedAnalystNote, summarizeLateGoals } from '../src/services/groundedAnalystService.js';
import { calculateGoalFestSignal } from '../src/services/liveAnalyticsService.js';

const fixture = (id, h, a) => ({ id, homeTeamId: 1, awayTeamId: 2,
  date: '2026-08-30T12:00:00Z', homeGoals: h, awayGoals: a });
const goal = (team, minute, detail = 'Normal Goal', extra = null) => ({ type: 'Goal',
  detail, team: { id: team }, time: { elapsed: minute, extra } });

test('clock distinguishes normal time, stoppage time, half-time and extra time', () => {
  assert.match(describeMatchClock({ status: '2H', matchMinutes: 78 }), /12 minutes/);
  assert.match(describeMatchClock({ status: 'LIVE', matchMinutes: 93 }), /remaining length is unknown/);
  assert.match(describeMatchClock({ status: 'ET', matchMinutes: 112 }), /8 minutes of extra/);
  assert.match(describeMatchClock({ status: 'HT', matchMinutes: 45 }), /Half-time/);
  assert.match(describeMatchClock({ status: 'FT', matchMinutes: 90 }), /finished/);
  assert.match(describeMatchClock({ status: 'LIVE', matchMinutes: null }), /unavailable/);
  assert.match(describeMatchClock({ status: 'CANC' }), /cancelled/);
});
test('late goals count games, orient both teams and include second-half stoppage time', () => {
  const fixtures = [fixture(1, 2, 1), fixture(2, 0, 0)];
  const events = new Map([['1', { events: [goal(1, 80), goal(1, 90, 'Normal Goal', 4), goal(2, 85)] }],
    ['2', { events: [] }]]);
  const home = summarizeLateGoals(1, fixtures, events);
  const away = summarizeLateGoals(2, fixtures, events);
  assert.equal(home.sampled, 2); assert.equal(home.scored, 1); assert.equal(home.conceded, 1);
  assert.equal(away.scored, 1); assert.equal(away.conceded, 1);
  assert.ok(home.examples.some((e) => e.minute === '90+4'));
});
test('missing events are not counted as no late goals; partial coverage is explicit', () => {
  const fixtures = [fixture(1, 1, 0), fixture(2, 0, 0), fixture(3, 1, 0)];
  const events = new Map([['1', { events: [] }], ['2', { events: [] }]]);
  const late = summarizeLateGoals(1, fixtures, events);
  assert.equal(late.sampled, 1); assert.equal(late.requested, 3);
  const note = buildGroundedAnalystNote({}, { home: 'A', away: 'B' }, { home: { lateGoals: late } });
  assert.match(note.text, /partial \(1\/3\)/);
});
test('missed penalties, disallowed goals and first-half stoppage time are not late goals', () => {
  const late = summarizeLateGoals(1, [fixture(1, 1, 0)], new Map([['1', { events:
    [goal(1, 45, 'Normal Goal', 8), goal(1, 90, 'Missed Penalty'), goal(1, 85, 'Disallowed Goal')] }]]));
  assert.equal(late.sampled, 1); assert.equal(late.scored, 0);
});
test('a genuine playing-time penalty is counted as a goal', () => {
  const late = summarizeLateGoals(1, [fixture(1, 1, 0)], new Map([['1', { events: [goal(1, 88, 'Penalty')] }]]));
  assert.equal(late.scored, 1);
});
test('unknown goal clock or unresolved score reconciliation excludes a fixture', () => {
  const late = summarizeLateGoals(1, [fixture(1, 1, 0)], new Map([['1', { events: [goal(1, null)] }]]));
  assert.equal(late.sampled, 0);
});
test('season stage uses verified dates, not the month or invented calendar', () => {
  const match = { home: 'A', away: 'B', season: 2026, kickoffUTC: '2026-09-13T12:00:00Z' };
  const note = buildGroundedAnalystNote({}, match, { season: { start: '2026-08-15', end: '2027-05-30' } });
  assert.match(note.text, /Beginning of the recorded 2026 season/);
  assert.match(buildGroundedAnalystNote({}, match).text, /season dates unavailable/);
});
test('season comparison uses normalised points/game and calls out small samples', () => {
  const note = buildGroundedAnalystNote({}, { home: 'A', away: 'B', homeSeasonRecord: { played: 4, wins: 3, draws: 1 } },
    { competitionType: 'League', home: { previousRecord: { played: 38, wins: 19, draws: 8 } } });
  assert.match(note.text, /2.50 points\/game/); assert.match(note.text, /Better than/);
  assert.match(note.text, /not matched rounds/); assert.match(note.text, /small sample/);
});
test('cup fixtures do not receive league points comparisons', () => {
  const note = buildGroundedAnalystNote({}, { homeSeasonRecord: { played: 4, wins: 3, draws: 1 } }, { competitionType: 'Cup' });
  assert.doesNotMatch(note.text, /2.50 points/);
});
test('coach tenure and offseason arrivals are dated, deduplicated and never claimed as improvements', () => {
  const note = buildGroundedAnalystNote({}, { home: 'A', away: 'B', homeTeamId: 1,
    kickoffUTC: '2026-09-13T12:00:00Z' }, { season: { start: '2026-08-01', end: '2027-05-30' },
    previousSeason: { end: '2026-05-30' }, home: {
      coaches: [{ name: 'Old', career: [{ team: { id: 1 }, start: '2024-01-01', end: '2026-08-05' }] },
        { name: 'New', career: [{ team: { id: 1 }, start: '2026-08-06', end: null }] }],
      transfers: [{ player: { id: 10, name: 'Player' }, transfers: [
        { date: '2026-07-10', teams: { in: { id: 1 } } }, { date: '2026-07-10', teams: { in: { id: 1 } } },
        { date: '2026-10-01', teams: { in: { id: 1 } } }] }] } });
  assert.match(note.text, /change this season from Old/);
  assert.match(note.text, /1 recorded arrivals since 2026-05-30: Player/);
  assert.match(note.text, /do not prove lineup availability/);
});
test('absent coach/transfer responses stay unverified, not no changes', () => {
  const note = buildGroundedAnalystNote({}, { home: 'A', homeTeamId: 1 });
  assert.match(note.text, /coach change unverified/); assert.match(note.text, /arrivals unavailable/);
});
test('Goal Fest displays missing verified evidence without loosening xG gating', () => {
  const signal = calculateGoalFestSignal({ status: '2H', matchMinutes: 70, score: '2-2',
    shots: { home: 8, away: 7 }, xg: { home: null, away: null } });
  assert.equal(signal.active, false); assert.match(signal.summary, /xG missing/);
  const view = goalFestView({ status: '2H', score: '2-2' }, [signal]);
  assert.equal(view.status, 'INSUFFICIENT_DATA');
});
test('old, changed-score and paused Goal Fest evidence is never displayed as active', () => {
  const now = Date.now();
  const signal = { active: true, observedScore: '1-1', evaluatedAt: new Date(now).toISOString() };
  assert.equal(goalFestView({ status: '2H', score: '2-1' }, [signal], now).active, false);
  assert.equal(goalFestView({ status: '2H', score: '1-1' }, [signal], now + 450001).active, false);
  assert.equal(goalFestView({ status: 'HT', score: '1-1' }, [signal], now).active, false);
  assert.equal(goalFestView({ status: 'FT', score: '1-1' }, [signal], now), null);
});
test('mobile header wraps navigation and match detail becomes a full-width overlay', () => {
  const css = fs.readFileSync(new URL('../../frontend/src/index.css', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../../frontend/src/App.jsx', import.meta.url), 'utf8');
  const panel = fs.readFileSync(new URL('../../frontend/src/components/DetailPanel.jsx', import.meta.url), 'utf8');
  assert.match(css, /max-width: 767px/); assert.match(css, /flex-wrap: wrap/);
  assert.match(app, /className="sporty-navigation"/); assert.match(app, /Bet Tools/);
  assert.match(css, /width: 100% !important/); assert.match(panel, /className="sporty-detail-panel"/);
});
test('click notes are evidence-based, immediate, separately enriched and do not alter model weights', () => {
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /analysis\.goalFest = calculateGoalFestSignal\(enriched\)/);
  assert.match(server, /analysis\.narrative = buildGroundedAnalystNote\(analysis, enriched\)/);
  assert.match(server, /getAnalystEvidence\(matchData, \{ shouldSkipApiCalls, updateQuotaFromHeaders \}\)/);
  const note = buildGroundedAnalystNote({}, {});
  assert.equal(note.provider, 'verified-evidence'); assert.equal(note.confidence, undefined);
});
