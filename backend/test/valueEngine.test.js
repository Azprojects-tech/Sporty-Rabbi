import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateValue } from '../src/services/valueEngine.js';
import { DECISION } from '../../shared/decisionStates.js';

test('returns NEEDS_PRICE when offered odds are missing', () => {
  const result = evaluateValue({ calibratedProbability: 62 });
  assert.equal(result.decision, DECISION.NEEDS_PRICE);
  assert.equal(result.reason, 'PRICE_MISSING');
  assert.equal(result.expectedValue, null);
  assert.ok(result.fairOdds > 1);
  assert.ok(result.minimumAcceptableOdds > 1);
});

test('returns BET when conservative EV passes threshold', () => {
  const result = evaluateValue({
    calibratedProbability: 0.62,
    probabilityLow: 0.58,
    offeredOdds: 2.0,
    minEv: 0.05,
  });
  assert.equal(result.decision, DECISION.BET);
  assert.equal(result.reason, 'EV_PASS');
  assert.ok(result.expectedValue >= 0.05);
});

test('returns NO_BET when EV is below threshold', () => {
  const result = evaluateValue({
    calibratedProbability: 62,
    probabilityLow: 58,
    offeredOdds: 1.7,
    minEv: 0.05,
  });
  assert.equal(result.decision, DECISION.NO_BET);
  assert.equal(result.reason, 'EV_BELOW_THRESHOLD');
});

test('returns NO_BET for invalid probabilities', () => {
  const result = evaluateValue({ calibratedProbability: null, offeredOdds: 2.2 });
  assert.equal(result.decision, DECISION.NO_BET);
  assert.equal(result.reason, 'INVALID_PROBABILITY');
});
