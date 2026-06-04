const LIVE_STATUSES = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT']);

const PHASE_POLICIES = {
  PRE_MATCH: {
    phase: 'PRE_MATCH',
    standardThreshold: 65,
    premiumThreshold: 80,
    baselineWeight: 0.8,
    liveWeight: 0.2,
  },
  EARLY_LIVE: {
    phase: 'EARLY_LIVE',
    standardThreshold: 68,
    premiumThreshold: 83,
    baselineWeight: 0.65,
    liveWeight: 0.35,
  },
  MID_LIVE: {
    phase: 'MID_LIVE',
    standardThreshold: 64,
    premiumThreshold: 78,
    baselineWeight: 0.45,
    liveWeight: 0.55,
  },
  LATE_LIVE: {
    phase: 'LATE_LIVE',
    standardThreshold: 60,
    premiumThreshold: 72,
    baselineWeight: 0.2,
    liveWeight: 0.8,
  },
};

const PHASE_INSTRUCTIONS = {
  PRE_MATCH: 'Lead with pre-match context: form, opponent quality, injuries, motivation, H2H and Poisson baseline. Mention live stats only if they exist as supporting color.',
  EARLY_LIVE: 'Pre-match baseline still leads, but explain whether early possession, shots and xG support or weaken that baseline.',
  MID_LIVE: 'Blend pre-match baseline with live match evidence evenly. State clearly whether the game is following or breaking the pre-match expectation.',
  LATE_LIVE: 'Live state dominates now: scoreline, xG, shots, cards, momentum and time remaining matter more than older pre-match context.',
};

export function isLiveStatus(status = 'NS') {
  return LIVE_STATUSES.has(status);
}

export function getPhaseConfidencePolicy(status = 'NS', matchMinutes = 0) {
  if (!isLiveStatus(status)) return PHASE_POLICIES.PRE_MATCH;
  if (matchMinutes < 25) return PHASE_POLICIES.EARLY_LIVE;
  if (matchMinutes < 70) return PHASE_POLICIES.MID_LIVE;
  return PHASE_POLICIES.LATE_LIVE;
}

export function getPhaseConfidencePolicyFromMatch(match = {}) {
  return getPhaseConfidencePolicy(match?.status || 'NS', match?.matchMinutes || 0);
}

export function getNarrativePhaseModel(status = 'NS', matchMinutes = 0) {
  const policy = getPhaseConfidencePolicy(status, matchMinutes);
  return {
    ...policy,
    instruction: PHASE_INSTRUCTIONS[policy.phase] || PHASE_INSTRUCTIONS.PRE_MATCH,
  };
}
