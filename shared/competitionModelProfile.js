const MAJOR_TOURNAMENT_IDS = new Set([4]); // FIFA World Cup
const CONTINENTAL_CLUB_IDS = new Set([2, 3, 848, 849]); // UCL, UEL, UECL

function asText(v) {
  return String(v || '').toLowerCase();
}

function includesAny(text, terms = []) {
  return terms.some((t) => text.includes(t));
}

function detectStage(round = '', notes = '') {
  const joined = `${asText(round)} ${asText(notes)}`;
  if (!joined.trim()) return 'unknown';

  if (includesAny(joined, ['group', 'matchday', 'md ', 'md-'])) return 'group';
  if (includesAny(joined, ['round of 16', 'quarter', 'semi', 'final', 'knockout'])) return 'knockout';
  return 'unknown';
}

export function detectCompetitionContext(input = {}) {
  const leagueId = Number(input.leagueId || 0);
  const league = asText(input.league);
  const country = asText(input.country);
  const matchType = asText(input.matchType);
  const round = asText(input.round);
  const notes = asText(input.notes);
  const isKnockout = Boolean(input.isKnockout);

  const stage = detectStage(round, notes);

  if (includesAny(league, ['friendly']) || matchType === 'friendly') {
    return {
      family: 'FRIENDLY',
      stage,
      key: 'friendly',
      rationale: 'Friendly fixture detected from league/matchType.',
    };
  }

  const isMajorTournament = MAJOR_TOURNAMENT_IDS.has(leagueId)
    || includesAny(league, ['world cup', 'euro', 'copa america', 'afcon']);
  if (isMajorTournament) {
    const isKo = isKnockout || stage === 'knockout';
    return {
      family: isKo ? 'MAJOR_TOURNAMENT_KO' : 'MAJOR_TOURNAMENT_GROUP',
      stage,
      key: isKo ? 'major_tournament_knockout' : 'major_tournament_group',
      rationale: 'Major international tournament context detected.',
    };
  }

  const isContinentalClub = CONTINENTAL_CLUB_IDS.has(leagueId)
    || includesAny(league, ['champions league', 'europa league', 'conference league', 'copa libertadores']);
  if (isContinentalClub) {
    const isKo = isKnockout || stage === 'knockout';
    return {
      family: isKo ? 'CONTINENTAL_CLUB_KO' : 'CONTINENTAL_CLUB_GROUP',
      stage,
      key: isKo ? 'continental_club_knockout' : 'continental_club_group',
      rationale: 'Continental club competition detected.',
    };
  }

  const isQualifier = matchType === 'qualifier'
    || includesAny(round, ['qualifier', 'qualification'])
    || includesAny(league, ['qualif']);
  if (isQualifier) {
    return {
      family: 'QUALIFIER',
      stage,
      key: 'qualifier',
      rationale: 'Qualifier competition detected from round/matchType.',
    };
  }

  const isCup = matchType === 'cup'
    || includesAny(league, ['cup'])
    || isKnockout
    || stage === 'knockout';
  if (isCup) {
    return {
      family: 'DOMESTIC_CUP',
      stage,
      key: 'domestic_cup',
      rationale: 'Domestic cup/knockout context detected.',
    };
  }

  return {
    family: 'DOMESTIC_LEAGUE',
    stage,
    key: 'domestic_league',
    rationale: country ? `Defaulting to domestic league context (${country}).` : 'Defaulting to domestic league context.',
  };
}

const PROFILES = {
  domestic_league: {
    name: 'Domestic League Baseline',
    scalarMultiplier: 1.0,
    overallAdjustment: 0,
    weightBias: {
      p4_form: 1.05,
      p3_h2h: 0.95,
    },
  },
  domestic_cup: {
    name: 'Domestic Cup / Knockout',
    scalarMultiplier: 0.97,
    overallAdjustment: -1,
    weightBias: {
      p3_h2h: 0.75,
      p4_form: 0.9,
      p7_poisson: 1.08,
      p12_market: 1.12,
      p13_squad: 1.12,
      p15_crisis: 1.08,
    },
  },
  continental_club_group: {
    name: 'Continental Club Group',
    scalarMultiplier: 0.99,
    overallAdjustment: 0,
    weightBias: {
      p4_form: 0.92,
      p7_poisson: 1.08,
      p12_market: 1.1,
      p13_squad: 1.15,
      p14_lifecycle: 0.85,
    },
  },
  continental_club_knockout: {
    name: 'Continental Club Knockout',
    scalarMultiplier: 0.95,
    overallAdjustment: -2,
    weightBias: {
      p3_h2h: 0.8,
      p4_form: 0.88,
      p7_poisson: 1.1,
      p12_market: 1.15,
      p13_squad: 1.2,
      p15_crisis: 1.1,
    },
  },
  qualifier: {
    name: 'Qualifier Context',
    scalarMultiplier: 0.96,
    overallAdjustment: -1,
    weightBias: {
      p3_h2h: 0.85,
      p4_form: 0.9,
      p12_market: 1.08,
      p13_squad: 1.18,
      p14_lifecycle: 0.8,
    },
  },
  major_tournament_group: {
    name: 'Major Tournament Group',
    scalarMultiplier: 0.94,
    overallAdjustment: -2,
    weightBias: {
      p3_h2h: 0.75,
      p4_form: 0.82,
      p7_poisson: 1.08,
      p12_market: 1.15,
      p13_squad: 1.2,
      p14_lifecycle: 0.72,
      p15_crisis: 1.08,
    },
  },
  major_tournament_knockout: {
    name: 'Major Tournament Knockout',
    scalarMultiplier: 0.9,
    overallAdjustment: -3,
    weightBias: {
      p3_h2h: 0.7,
      p4_form: 0.78,
      p7_poisson: 1.12,
      p12_market: 1.18,
      p13_squad: 1.25,
      p14_lifecycle: 0.65,
      p15_crisis: 1.15,
    },
  },
  friendly: {
    name: 'Friendly Match',
    scalarMultiplier: 0.88,
    overallAdjustment: -4,
    weightBias: {
      p3_h2h: 0.6,
      p4_form: 0.7,
      p7_poisson: 0.95,
      p12_market: 1.15,
      p13_squad: 1.25,
      p14_lifecycle: 0.5,
      p15_crisis: 0.85,
    },
  },
};

export function getCompetitionModelProfile(context = {}) {
  return PROFILES[context.key] || PROFILES.domestic_league;
}

export function applyWeightProfile(baseWeights = {}, weightBias = {}) {
  const out = {};
  for (const [k, v] of Object.entries(baseWeights)) {
    const bias = Number(weightBias[k] ?? 1);
    out[k] = v * (Number.isFinite(bias) ? Math.max(0.1, bias) : 1);
  }
  return out;
}
