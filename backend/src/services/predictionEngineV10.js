/**
 * SportyRabbi V10.1 prediction core.
 *
 * First-principles rules:
 * - Never invent observed football data.
 * - A verified current-season goals-rate baseline is enough to model a fixture.
 * - Genuine xG/xGA improves the baseline when available; it is not mandatory.
 * - Explicit priors (league mean + home advantage) are labelled as priors and
 *   never count as observed evidence.
 * - Probability, reliability and Daily Signal are separate concepts.
 */

const DC_RHO = -0.08;
const HOME_PRIOR = 1.07;
const AWAY_PRIOR = 0.97;
const SHRINK_MATCHES = 5;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function factorial(n) {
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

function poisson(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * (lambda ** k)) / factorial(k);
}

function dcTau(h, a, lH, lA) {
  if (h === 0 && a === 0) return 1 - lH * lA * DC_RHO;
  if (h === 1 && a === 0) return 1 + lA * DC_RHO;
  if (h === 0 && a === 1) return 1 + lH * DC_RHO;
  if (h === 1 && a === 1) return 1 - DC_RHO;
  return 1;
}

function parseForm(raw) {
  if (!raw) return { sample: 0, pointsRate: null, wins: 0, draws: 0, losses: 0 };
  const parts = Array.isArray(raw)
    ? raw.map(String)
    : String(raw).toUpperCase().split(/[-,\s]+/).filter(Boolean);
  const valid = parts.filter((r) => ['W', 'D', 'L'].includes(r));
  if (!valid.length) return { sample: 0, pointsRate: null, wins: 0, draws: 0, losses: 0 };
  const wins = valid.filter((r) => r === 'W').length;
  const draws = valid.filter((r) => r === 'D').length;
  const losses = valid.filter((r) => r === 'L').length;
  return {
    sample: valid.length,
    pointsRate: (wins * 3 + draws) / (valid.length * 3),
    wins,
    draws,
    losses,
  };
}

function shrinkRate(rate, sampleSize, leagueMean) {
  const r = finite(rate);
  const n = finite(sampleSize);
  if (r == null) return null;
  if (n == null || n <= 0) return r;
  const weight = n / (n + SHRINK_MATCHES);
  return weight * r + (1 - weight) * leagueMean;
}

function emptyPoisson(reason) {
  return {
    homeLambda: null,
    awayLambda: null,
    expectedTotalGoals: null,
    probabilities: {
      over05: null,
      over15: null,
      over25: null,
      over35: null,
      under25: null,
      btts: null,
      homeWin: null,
      draw: null,
      awayWin: null,
    },
    likelyScore: null,
    insufficientData: true,
    modelBasis: null,
    assessment: reason,
  };
}

function matrixFromLambdas(homeLambda, awayLambda, modelBasis) {
  const lH = clamp(homeLambda, 0.08, 4.5);
  const lA = clamp(awayLambda, 0.08, 4.5);

  let mass = 0;
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let btts = 0;
  let under15 = 0;
  let under25 = 0;
  let under35 = 0;
  let bestP = -1;
  let bestScore = '0-0';

  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const raw = poisson(lH, h) * poisson(lA, a) * dcTau(h, a, lH, lA);
      const p = Math.max(raw, 0);
      mass += p;
      if (h > a) homeWin += p;
      else if (h < a) awayWin += p;
      else draw += p;

      if (h > 0 && a > 0) btts += p;
      const total = h + a;
      if (total <= 1) under15 += p;
      if (total <= 2) under25 += p;
      if (total <= 3) under35 += p;
      if (p > bestP) {
        bestP = p;
        bestScore = `${h}-${a}`;
      }
    }
  }

  if (mass <= 0) return emptyPoisson('Probability matrix could not be normalised.');

  const pct = (v) => Math.round((v / mass) * 100);
  const over15 = 100 - pct(under15);
  const u25 = pct(under25);
  const o25 = 100 - u25;
  const over35 = 100 - pct(under35);

  return {
    homeLambda: +lH.toFixed(2),
    awayLambda: +lA.toFixed(2),
    expectedTotalGoals: +(lH + lA).toFixed(2),
    probabilities: {
      over05: Math.round((1 - Math.exp(-(lH + lA))) * 100),
      over15,
      over25: o25,
      over35,
      under25: u25,
      btts: pct(btts),
      homeWin: pct(homeWin),
      draw: pct(draw),
      awayWin: pct(awayWin),
    },
    likelyScore: {
      score: bestScore,
      probability: Math.round((bestP / mass) * 100),
    },
    insufficientData: false,
    modelBasis,
    assessment:
      `V10.1 ${modelBasis}: projected ${(lH + lA).toFixed(2)} goals. ` +
      `1X2 H ${pct(homeWin)}% | D ${pct(draw)}% | A ${pct(awayWin)}%.`,
  };
}

function buildTeamEdge({
  leagueMean,
  homeFor,
  homeAgainst,
  awayFor,
  awayAgainst,
  homeForm,
  awayForm,
  reliability,
}) {
  const hAttack = clamp((homeFor / leagueMean) * 50, 15, 90);
  const aAttack = clamp((awayFor / leagueMean) * 50, 15, 90);
  const hDef = clamp((leagueMean / Math.max(homeAgainst, 0.15)) * 50, 15, 90);
  const aDef = clamp((leagueMean / Math.max(awayAgainst, 0.15)) * 50, 15, 90);
  const hForm = homeForm.pointsRate == null ? 50 : homeForm.pointsRate * 100;
  const aForm = awayForm.pointsRate == null ? 50 : awayForm.pointsRate * 100;

  // +3 is an explicit structural home prior, not an observed data point.
  const homeScore = clamp(hAttack * 0.40 + hDef * 0.35 + hForm * 0.25 + 3, 0, 100);
  const awayScore = clamp(aAttack * 0.40 + aDef * 0.35 + aForm * 0.25, 0, 100);
  const gap = homeScore - awayScore;
  const absGap = Math.abs(gap);

  const level = absGap >= 14
    ? 'STRONG'
    : absGap >= 8
      ? 'MODERATE'
      : absGap >= 4
        ? 'SLIGHT'
        : 'NONE';

  const winner = level === 'NONE' ? 'NONE' : gap > 0 ? 'HOME' : 'AWAY';

  return {
    status: reliability >= 60 ? 'AVAILABLE' : 'PARTIAL',
    winner,
    level,
    homeScore: Math.round(homeScore),
    awayScore: Math.round(awayScore),
    reliability,
    factors: {
      attack: { home: Math.round(hAttack), away: Math.round(aAttack) },
      defence: { home: Math.round(hDef), away: Math.round(aDef) },
      recentForm: { home: Math.round(hForm), away: Math.round(aForm) },
      homeAdvantagePrior: 3,
    },
  };
}

function primaryPrediction(probabilities, home, away) {
  const candidates = [
    { marketKey: 'over15', selection: 'Over 1.5 Goals', probability: probabilities.over15 },
    { marketKey: 'over25', selection: 'Over 2.5 Goals', probability: probabilities.over25 },
    { marketKey: 'under25', selection: 'Under 2.5 Goals', probability: probabilities.under25 },
    { marketKey: 'btts', selection: 'Both Teams to Score', probability: probabilities.btts },
    { marketKey: 'home_win', selection: `${home} Win`, probability: probabilities.homeWin },
    { marketKey: 'away_win', selection: `${away} Win`, probability: probabilities.awayWin },
  ].filter((x) => Number.isFinite(x.probability));

  return candidates.sort((a, b) => b.probability - a.probability)[0] || null;
}

export function buildPredictionCore(matchData = {}, leagueAverage = 1.35) {
  const L = clamp(finite(leagueAverage) ?? 1.35, 0.7, 2.5);
  const season = matchData.season ?? matchData.fixtureContext?.season ?? null;

  const homeGF = finite(matchData.homeGoalsAvgFor);
  const homeGA = finite(matchData.homeGoalsAvgAgainst);
  const awayGF = finite(matchData.awayGoalsAvgFor);
  const awayGA = finite(matchData.awayGoalsAvgAgainst);

  const homeForm = parseForm(matchData.homeForm);
  const awayForm = parseForm(matchData.awayForm);
  const homeSample = finite(matchData.homeSampleSize) ?? homeForm.sample;
  const awaySample = finite(matchData.awaySampleSize) ?? awayForm.sample;

  const coreValues = [homeGF, homeGA, awayGF, awayGA];
  const corePresent = coreValues.filter((v) => v != null).length;
  const coreCoverage = corePresent / coreValues.length;
  const minimumSample = Math.min(homeSample ?? 0, awaySample ?? 0);
  const sampleAvailable = minimumSample >= 1;
  const sampleAdequate = minimumSample >= 3;
  const exactSeason = season != null;

  // Reliability is intentionally sample-sensitive.
  // One match can produce a visible prediction, but cannot masquerade as high reliability.
  let reliability = 15;
  reliability += Math.round(coreCoverage * 35);
  reliability += exactSeason ? 10 : 0;
  reliability += Math.min(minimumSample, 10) * 3;
  reliability += sampleAdequate && homeForm.sample >= 3 && awayForm.sample >= 3 ? 5 : 0;
  reliability = clamp(reliability, 0, 95);

  const coreReady = coreCoverage === 1 && sampleAvailable && exactSeason;
  if (!coreReady) {
    const missing = [];
    if (homeGF == null) missing.push('home goals-for rate');
    if (homeGA == null) missing.push('home goals-against rate');
    if (awayGF == null) missing.push('away goals-for rate');
    if (awayGA == null) missing.push('away goals-against rate');
    if (!sampleAvailable) missing.push('at least one completed current-season match for both teams');
    if (!exactSeason) missing.push('fixture season');

    return {
      version: 'V10.1',
      coreReady: false,
      modelBasis: null,
      reliability,
      signalScore: null,
      primaryPrediction: null,
      dailySignal: {
        score: null,
        eligible: false,
        threshold: 80,
        reason: `Core evidence incomplete: ${missing.join(', ')}`,
      },
      dataQuality: {
        coreCoverage,
        corePresent,
        coreRequired: 4,
        optionalXgAvailable: false,
        exactSeason,
        sampleAvailable,
        sampleAdequate,
        homeSampleSize: homeSample,
        awaySampleSize: awaySample,
        missing,
      },
      poisson: emptyPoisson(`Core evidence incomplete: ${missing.join(', ')}`),
      teamEdge: {
        status: 'INSUFFICIENT_DATA',
        winner: 'NONE',
        level: 'NONE',
        homeScore: null,
        awayScore: null,
        reliability,
        factors: {},
      },
      priors: {
        leagueGoalsPerTeam: L,
        homeMultiplier: HOME_PRIOR,
        awayMultiplier: AWAY_PRIOR,
      },
    };
  }

  const hGF = shrinkRate(homeGF, homeSample, L);
  const hGA = shrinkRate(homeGA, homeSample, L);
  const aGF = shrinkRate(awayGF, awaySample, L);
  const aGA = shrinkRate(awayGA, awaySample, L);

  let homeLambda = L * (hGF / L) * (aGA / L) * HOME_PRIOR;
  let awayLambda = L * (aGF / L) * (hGA / L) * AWAY_PRIOR;
  let modelBasis = 'GOALS_RATE';

  const hXg = finite(matchData.homeXgAvg);
  const hXga = finite(matchData.homeXgaAvg);
  const aXg = finite(matchData.awayXgAvg);
  const aXga = finite(matchData.awayXgaAvg);
  const xgAvailable = [hXg, hXga, aXg, aXga].every((v) => v != null);

  if (xgAvailable) {
    const xgHomeLambda = L * (hXg / L) * (aXga / L) * HOME_PRIOR;
    const xgAwayLambda = L * (aXg / L) * (hXga / L) * AWAY_PRIOR;
    // xG is an enhancer, not the admission ticket to the model.
    homeLambda = homeLambda * 0.72 + xgHomeLambda * 0.28;
    awayLambda = awayLambda * 0.72 + xgAwayLambda * 0.28;
    modelBasis = 'GOALS_RATE_XG_ENHANCED';
    reliability = clamp(reliability + 4, 0, 97);
  }

  const poissonModel = matrixFromLambdas(homeLambda, awayLambda, modelBasis);
  const primary = primaryPrediction(
    poissonModel.probabilities,
    matchData.home || 'Home',
    matchData.away || 'Away'
  );

  const modelDirection = poissonModel.homeLambda - poissonModel.awayLambda;
  const formDirection =
    homeForm.pointsRate != null && awayForm.pointsRate != null
      ? homeForm.pointsRate - awayForm.pointsRate
      : 0;

  let agreement = 0.5;
  if (Math.abs(modelDirection) >= 0.15 && Math.abs(formDirection) >= 0.08) {
    agreement = Math.sign(modelDirection) === Math.sign(formDirection) ? 1 : 0;
  }

  const agreementBonus = agreement === 1 ? 5 : agreement === 0 ? -4 : 0;
  const primaryProbability = primary?.probability ?? 0;
  const signalScore = clamp(
    Math.round(primaryProbability * 0.72 + reliability * 0.23 + agreementBonus),
    0,
    95
  );

  const teamEdge = buildTeamEdge({
    leagueMean: L,
    homeFor: hGF,
    homeAgainst: hGA,
    awayFor: aGF,
    awayAgainst: aGA,
    homeForm,
    awayForm,
    reliability,
  });

  return {
    version: 'V10.1',
    coreReady: true,
    modelBasis,
    reliability,
    signalScore,
    primaryPrediction: primary,
    dailySignal: {
      score: signalScore,
      eligible: signalScore >= 80 && reliability >= 70,
      threshold: 80,
      probability: primary?.probability ?? null,
      selection: primary?.selection ?? null,
      marketKey: primary?.marketKey ?? null,
      reliability,
      agreement: agreement === 1 ? 'STRONG' : agreement === 0 ? 'CONFLICT' : 'NEUTRAL',
      reason:
        signalScore >= 80 && reliability >= 70
          ? 'Strong model probability with sufficient verified evidence.'
          : 'Below the Daily 80+ selector threshold.',
    },
    dataQuality: {
      coreCoverage: 1,
      corePresent: 4,
      coreRequired: 4,
      optionalXgAvailable: xgAvailable,
      exactSeason,
      sampleAvailable,
      sampleAdequate,
      homeSampleSize: homeSample,
      awaySampleSize: awaySample,
      missing: [],
    },
    poisson: poissonModel,
    teamEdge,
    priors: {
      leagueGoalsPerTeam: L,
      homeMultiplier: HOME_PRIOR,
      awayMultiplier: AWAY_PRIOR,
      shrinkMatches: SHRINK_MATCHES,
      note: 'Explicit model priors; not counted as observed football evidence.',
    },
    inputSummary: {
      homeGoalsAvgFor: homeGF,
      homeGoalsAvgAgainst: homeGA,
      awayGoalsAvgFor: awayGF,
      awayGoalsAvgAgainst: awayGA,
      homeSampleSize: homeSample,
      awaySampleSize: awaySample,
      season,
    },
  };
}

export default buildPredictionCore;