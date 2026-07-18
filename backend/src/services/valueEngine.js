import { DECISION } from '../../../shared/decisionStates.js';

function toProbability01(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n > 1) return n / 100;
  return n;
}

function clampProbability(p) {
  if (!Number.isFinite(p)) return null;
  if (p <= 0 || p >= 1) return null;
  return p;
}

export function evaluateValue({
  calibratedProbability,
  probabilityLow,
  offeredOdds,
  minEv = 0.05,
} = {}) {
  const pCalRaw = toProbability01(calibratedProbability);
  const pLowRaw = toProbability01(probabilityLow);

  const pCal = clampProbability(pCalRaw);
  const pExec = clampProbability(pLowRaw ?? pCalRaw);

  if (pCal == null || pExec == null) {
    return {
      decision: DECISION.NO_BET,
      reason: 'INVALID_PROBABILITY',
      fairOdds: null,
      minimumAcceptableOdds: null,
      expectedValue: null,
    };
  }

  const fairOdds = 1 / pCal;
  const minimumAcceptableOdds = (1 + minEv) / pExec;
  const odds = Number(offeredOdds);

  if (!Number.isFinite(odds) || odds <= 1) {
    return {
      decision: DECISION.NEEDS_PRICE,
      reason: 'PRICE_MISSING',
      fairOdds: +fairOdds.toFixed(2),
      minimumAcceptableOdds: +minimumAcceptableOdds.toFixed(2),
      expectedValue: null,
    };
  }

  const expectedValue = pExec * odds - 1;
  return {
    decision: expectedValue >= minEv ? DECISION.BET : DECISION.NO_BET,
    reason: expectedValue >= minEv ? 'EV_PASS' : 'EV_BELOW_THRESHOLD',
    fairOdds: +fairOdds.toFixed(2),
    minimumAcceptableOdds: +minimumAcceptableOdds.toFixed(2),
    expectedValue: +expectedValue.toFixed(4),
  };
}
