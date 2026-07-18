import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeV9 } from '../src/services/agent47Service.js';
import {
  MARKET,
  finiteNumberOrNull,
  offeredOddsForMarket,
  recommendationToMarketKey,
  getTopExecutableRecommendation,
} from '../../shared/marketKeys.js';

test('empty input fails closed with NO_BET and no 1X2 availability', () => {
  const result = analyzeV9({});
  assert.ok(Array.isArray(result.recommendations));
  assert.equal(result.recommendations[0]?.type, 'NO_BET');
  assert.equal(result.decisionMetrics?.outcomeProbabilities?.available, false);
});

test('finiteNumberOrNull rejects null-like values', () => {
  assert.equal(finiteNumberOrNull(null), null);
  assert.equal(finiteNumberOrNull(undefined), null);
  assert.equal(finiteNumberOrNull(''), null);
  assert.equal(finiteNumberOrNull('abc'), null);
  assert.equal(finiteNumberOrNull('42'), 42);
});

test('recommendation market parser rejects NO_BET and unknown selections', () => {
  assert.equal(recommendationToMarketKey({ type: 'NO_BET', selection: 'No Bet' }), null);
  assert.equal(recommendationToMarketKey({ type: 'WINS_ONLY', selection: 'Mystery Selection' }), null);
  assert.equal(recommendationToMarketKey({ type: 'GOALS_ONLY', selection: 'Over 2.5 Goals' }), MARKET.OVER_25);
});

test('getTopExecutableRecommendation skips NO_BET and finds executable market', () => {
  const match = {
    home: 'Alpha FC',
    away: 'Beta FC',
    analysis: {
      recommendations: [
        { type: 'NO_BET', selection: 'No Bet', confidence: 51 },
        { type: 'GOALS_ONLY', selection: 'Over 2.5 Goals', confidence: 68 },
      ],
    },
  };

  const top = getTopExecutableRecommendation(match);
  assert.ok(top);
  assert.equal(top.marketKey, MARKET.OVER_25);
  assert.equal(top.probability, 68);
});

test('unknown market key and invalid odds return no projection path', () => {
  assert.equal(offeredOddsForMarket({ over25: 1.9 }, 'mystery_market'), null);
  assert.equal(offeredOddsForMarket({ over25: 0.95 }, MARKET.OVER_25), null);
  assert.equal(offeredOddsForMarket({ over25: 1.9 }, MARKET.OVER_25), 1.9);
});
