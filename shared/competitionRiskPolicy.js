const POLICY_BY_FAMILY = {
  DOMESTIC_LEAGUE: {
    confidenceFloor: 65,
    thresholdAdjustment: 0,
    stakeMultiplier: 1.0,
    maxSingleStakePct: 0.04,
  },
  DOMESTIC_CUP: {
    confidenceFloor: 68,
    thresholdAdjustment: 2,
    stakeMultiplier: 0.85,
    maxSingleStakePct: 0.03,
  },
  CONTINENTAL_CLUB_GROUP: {
    confidenceFloor: 67,
    thresholdAdjustment: 1,
    stakeMultiplier: 0.9,
    maxSingleStakePct: 0.035,
  },
  CONTINENTAL_CLUB_KO: {
    confidenceFloor: 70,
    thresholdAdjustment: 3,
    stakeMultiplier: 0.8,
    maxSingleStakePct: 0.03,
  },
  QUALIFIER: {
    confidenceFloor: 69,
    thresholdAdjustment: 2,
    stakeMultiplier: 0.82,
    maxSingleStakePct: 0.03,
  },
  MAJOR_TOURNAMENT_GROUP: {
    confidenceFloor: 70,
    thresholdAdjustment: 3,
    stakeMultiplier: 0.78,
    maxSingleStakePct: 0.028,
  },
  MAJOR_TOURNAMENT_KO: {
    confidenceFloor: 72,
    thresholdAdjustment: 4,
    stakeMultiplier: 0.72,
    maxSingleStakePct: 0.025,
  },
  FRIENDLY: {
    confidenceFloor: 74,
    thresholdAdjustment: 5,
    stakeMultiplier: 0.6,
    maxSingleStakePct: 0.02,
  },
};

const DEFAULT_POLICY = {
  confidenceFloor: 68,
  thresholdAdjustment: 2,
  stakeMultiplier: 0.85,
  maxSingleStakePct: 0.03,
};

export function getCompetitionRiskPolicy(family = 'DOMESTIC_LEAGUE') {
  return POLICY_BY_FAMILY[family] || DEFAULT_POLICY;
}
