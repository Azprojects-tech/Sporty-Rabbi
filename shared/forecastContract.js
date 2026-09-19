import { observedNumber, LIVE_STATUSES } from './forecastMath.js';

const observation = value => {
  const n = observedNumber(value);
  return n != null && n >= 0 ? n : null;
};

// Distinguish available evidence from evidence actually used in the model.
// This is a data/lineage contract, not a second prediction or confidence score.
export function forecastContract(match, core) {
  const live = LIVE_STATUSES.has(String(match.status || '').toUpperCase());
  return {
    schemaVersion:1, modelVersion:core.version, modelBasis:core.modelBasis,
    phase:live ? 'LIVE' : 'PRE_MATCH', probabilityCalibration:'NOT_FITTED',
    state:{ fixtureId:match.id ?? match.fixtureId ?? null, status:match.status ?? 'NS',
      minute:observedNumber(match.matchMinutes), score:match.score ?? null },
    inputsUsed:{ historicalGoals:core.coreReady, historicalXg:Boolean(core.dataQuality?.optionalXgAvailable),
      liveScoreAndClock:live && Boolean(core.poisson?.live?.available),
      redCards:live && Boolean(core.poisson?.live?.available),
      liveXg:false, liveShots:false, lineup:false, coachChange:false, lateGoalHistory:false },
    liveEvidence:live ? { xg:{home:observation(match.xg?.home),away:observation(match.xg?.away)},
      shotsOnTarget:{home:observation(match.shots?.home),away:observation(match.shots?.away)},
      observedAt:match.liveStatsObservedAt ?? null,
      role:'CONTEXT_ONLY_PENDING_VALIDATED_LIVE_MODEL' } : null,
    contextRole:'EXPLANATION_ONLY_NO_PROBABILITY_BONUSES',
    parameterStatus:'CONFIGURED_BASELINE_NOT_EMPIRICALLY_FITTED',
  };
}
