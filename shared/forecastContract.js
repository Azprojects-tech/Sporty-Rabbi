import { observedNumber, LIVE_STATUSES } from './forecastMath.js';

const observation = value => {
  const n = observedNumber(value);
  return n != null && n >= 0 ? n : null;
};

// Distinguish available evidence from evidence actually used in the model.
// This is a data/lineage contract, not a second prediction or confidence score.
export function forecastContract(match, core) {
  const live = LIVE_STATUSES.has(String(match.status || '').toUpperCase());
  const hazard=core.poisson?.live?.liveHazard || null;
  const hazardSource=hazard?.source || 'NONE';
  return {
    schemaVersion:2, modelVersion:core.version, modelBasis:core.modelBasis,
    phase:live ? 'LIVE' : 'PRE_MATCH',
    probabilityCalibration:live ? 'LIVE_HAZARD_V1_LITERATURE_INFORMED_LOCAL_CALIBRATION_PENDING' : 'NOT_FITTED',
    state:{ fixtureId:match.id ?? match.fixtureId ?? null, status:match.status ?? 'NS',
      minute:observedNumber(match.matchMinutes), score:match.score ?? null },
    inputsUsed:{ historicalGoals:core.coreReady, historicalXg:Boolean(core.dataQuality?.optionalXgAvailable),
      liveScoreAndClock:live && Boolean(core.poisson?.live?.available),
      redCards:live && Boolean(core.poisson?.live?.available),
      liveXg:hazardSource==='XG',
      liveShots:hazardSource==='SHOTS_SOT'||hazardSource==='SHOTS',
      lineup:false, coachChange:false, lateGoalHistory:false },
    liveEvidence:live ? { xg:{home:observation(match.xg?.home),away:observation(match.xg?.away)},
      shotsOnTarget:{home:observation(match.shots?.home),away:observation(match.shots?.away)},
      totalShots:{home:observation(match.totalShots?.home),away:observation(match.totalShots?.away)},
      corners:{home:observation(match.corners?.home),away:observation(match.corners?.away)},
      observedAt:match.liveStatsObservedAt ?? null,
      source:hazardSource,
      role:hazardSource==='NONE'?'CONTEXT_ONLY':'LIVE_HAZARD_PROBABILITY_INPUT' } : null,
    contextRole:'CORNERS_REMAIN_CONTEXT_ONLY_FOR_GOAL_PROBABILITY',
    parameterStatus:live ? 'LITERATURE_INFORMED_CONSERVATIVE_V1_NOT_LOCALLY_FITTED' : 'CONFIGURED_BASELINE_NOT_EMPIRICALLY_FITTED',
  };
}
