const POLICY_BY_FAMILY = {
  DOMESTIC_LEAGUE: {
    confidenceFloor: 62,
    thresholdAdjustment: 0,
    stakeMultiplier: 1.15,
    maxSingleStakePct: 0.08,
  },
  DOMESTIC_CUP: {
    confidenceFloor: 64,
    thresholdAdjustment: 1,
    stakeMultiplier: 1.0,
    maxSingleStakePct: 0.06,
  },
  CONTINENTAL_CLUB_GROUP: {
    confidenceFloor: 63,
    thresholdAdjustment: 1,
    stakeMultiplier: 1.05,
    maxSingleStakePct: 0.065,
  },
  CONTINENTAL_CLUB_KO: {
    confidenceFloor: 66,
    thresholdAdjustment: 2,
    stakeMultiplier: 0.95,
    maxSingleStakePct: 0.05,
  },
  QUALIFIER: {
    confidenceFloor: 65,
    thresholdAdjustment: 1,
    stakeMultiplier: 0.98,
    maxSingleStakePct: 0.055,
  },
  MAJOR_TOURNAMENT_GROUP: {
    confidenceFloor: 66,
    thresholdAdjustment: 2,
    stakeMultiplier: 0.92,
    maxSingleStakePct: 0.048,
  },
  MAJOR_TOURNAMENT_KO: {
    confidenceFloor: 68,
    thresholdAdjustment: 2,
    stakeMultiplier: 0.88,
    maxSingleStakePct: 0.045,
  },
  FRIENDLY: {
    confidenceFloor: 70,
    thresholdAdjustment: 3,
    stakeMultiplier: 0.8,
    maxSingleStakePct: 0.035,
  },
};

const DEFAULT_POLICY = {
  confidenceFloor: 64,
  thresholdAdjustment: 1,
  stakeMultiplier: 1.0,
  maxSingleStakePct: 0.06,
};

export function getCompetitionRiskPolicy(family = 'DOMESTIC_LEAGUE') {
  return POLICY_BY_FAMILY[family] || DEFAULT_POLICY;
}
