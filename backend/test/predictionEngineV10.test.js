import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPredictionCore } from '../src/services/predictionEngineV10.js';

const base = {
  home: 'Home FC',
  away: 'Away FC',
  leagueId: 999,
  season: 2026,
  homeGoalsAvgFor: 1.9,
  homeGoalsAvgAgainst: 0.9,
  awayGoalsAvgFor: 1.1,
  awayGoalsAvgAgainst: 1.7,
  homeForm: 'W-W-D-W-W',
  awayForm: 'L-D-W-L-D',
  homeSampleSize: 8,
  awaySampleSize: 8,
};

test('goals-rate model works with xG completely absent', () => {
  const result = buildPredictionCore(base, 1.35);
  assert.equal(result.coreReady, true);
  assert.equal(result.modelBasis, 'GOALS_RATE');
  assert.equal(result.poisson.insufficientData, false);
  assert.ok(Number.isFinite(result.poisson.probabilities.homeWin));
  assert.ok(Number.isFinite(result.poisson.probabilities.over15));
});

test('missing xG is optional and does not reduce core coverage', () => {
  const result = buildPredictionCore({ ...base, homeXgAvg: null, awayXgAvg: null }, 1.35);
  assert.equal(result.dataQuality.coreCoverage, 1);
  assert.equal(result.dataQuality.optionalXgAvailable, false);
  assert.ok(result.reliability >= 70);
});

test('xG becomes an enhancer only when all four xG/xGA fields are present', () => {
  const result = buildPredictionCore({
    ...base,
    homeXgAvg: 2.1,
    homeXgaAvg: 0.8,
    awayXgAvg: 1.0,
    awayXgaAvg: 1.8,
  }, 1.35);
  assert.equal(result.coreReady, true);
  assert.equal(result.modelBasis, 'GOALS_RATE_XG_ENHANCED');
  assert.equal(result.dataQuality.optionalXgAvailable, true);
});

test('missing a core goals rate blocks the prediction instead of inventing it', () => {
  const result = buildPredictionCore({ ...base, awayGoalsAvgAgainst: null }, 1.35);
  assert.equal(result.coreReady, false);
  assert.equal(result.primaryPrediction, null);
  assert.equal(result.poisson.homeLambda, null);
  assert.equal(result.dailySignal.eligible, false);
});

test('wrong/missing season blocks a prediction', () => {
  const result = buildPredictionCore({ ...base, season: null }, 1.35);
  assert.equal(result.coreReady, false);
  assert.match(result.dailySignal.reason, /fixture season/i);
});

test('Daily Signal is separate from raw market probability', () => {
  const result = buildPredictionCore({
    ...base,
    homeGoalsAvgFor: 2.6,
    homeGoalsAvgAgainst: 0.6,
    awayGoalsAvgFor: 0.7,
    awayGoalsAvgAgainst: 2.2,
    homeForm: 'W-W-W-W-W',
    awayForm: 'L-L-L-D-L',
    homeSampleSize: 10,
    awaySampleSize: 10,
  }, 1.35);

  assert.equal(result.coreReady, true);
  assert.ok(Number.isFinite(result.signalScore));
  assert.ok(Number.isFinite(result.primaryPrediction.probability));
  assert.notEqual(result.signalScore, result.primaryPrediction.probability);
  assert.equal(result.dailySignal.eligible, true);
  assert.ok(result.signalScore >= 80);
  assert.ok(result.teamEdge.status === 'AVAILABLE' || result.teamEdge.status === 'PARTIAL');
});
test('one-match exact-season sample can produce a prediction but cannot qualify for Daily 80+', () => {
  const result = buildPredictionCore({
    ...base,
    homeSampleSize: 1,
    awaySampleSize: 1,
    homeForm: 'W',
    awayForm: 'L',
  }, 1.35);
  assert.equal(result.coreReady, true);
  assert.ok(Number.isFinite(result.primaryPrediction?.probability));
  assert.ok(result.reliability < 70);
  assert.equal(result.dailySignal.eligible, false);
});

test('zero completed matches remains insufficient evidence', () => {
  const result = buildPredictionCore({
    ...base,
    homeSampleSize: 0,
    awaySampleSize: 0,
    homeForm: null,
    awayForm: null,
  }, 1.35);
  assert.equal(result.coreReady, false);
  assert.equal(result.primaryPrediction, null);
});
