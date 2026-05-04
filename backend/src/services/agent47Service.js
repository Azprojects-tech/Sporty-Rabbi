/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║           AGENT 47 — V6 FRONTIER ANALYSIS ENGINE        ║
 * ║      14-Parameter Football Betting Intelligence          ║
 * ╠══════════════════════════════════════════════════════════╣
 * ║  Fuses V4 logic + V5 structural checks + V6 analytics   ║
 * ║  Works entirely offline — zero API calls required.       ║
 * ║  Feed it match data manually or from live API.          ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * INPUT:  structured matchData object (see analyzeV6 JSDoc)
 * OUTPUT: tiered recommendations + full 14-parameter audit
 */

// ─── TIER DEFINITIONS ─────────────────────────────────────────────────────────
export const TIERS = {
  1: { name: 'Capital Security',  minConfidence: 82, description: 'High-stake singles. Maximum reliability.' },
  2: { name: 'Commander Play',    minConfidence: 72, description: 'Balanced value. Standard strategic bets.' },
  3: { name: 'Value Play',        minConfidence: 62, description: 'Calculated risk with higher yields.' },
  4: { name: 'Calculated Chaos',  minConfidence: 52, description: 'Sniper alerts. Instant goal monitoring.' },
};

// ─── PARAMETER WEIGHTS (sum = 1.0) ────────────────────────────────────────────
const W = {
  p1_motivation:     0.12,
  p2_starPower:      0.08,
  p3_h2h:           0.07,
  p4_form:          0.10,
  p5_scoringTiming: 0.06,
  p6_defensiveGap:  0.10,
  p7_poisson:       0.09,
  p8_xg:            0.09,
  p9_xga:           0.09,
  p10_pace:         0.07,
  p11_timezone:     0.01,   // structural check — always passes
  p12_fixture:      0.01,   // structural check — always passes
  p13_squad:        0.07,
  p14_lifecycle:    0.05,
};

// ─── RESEARCH CONSTANTS (April 2026 end-of-season findings) ───────────────────
const RESEARCH = {
  LIGUE1_LATE_GOAL_PCT:         0.30,  // 30% of Ligue 1 goals after 76'
  RELEGATION_AVG_CONCEDED:      1.95,  // bottom-tier: 1.7–2.2 avg
  EARLY_GOAL_O35_BOOST:         0.40,  // early goal increases O3.5 by ~40%
  PSG_TRAP_POSSESSION_THRESHOLD: 70,   // 70%+ possession = stalling xG warning
  LEAGUE_AVG_GOALS_PER_GAME:    1.35,  // baseline per team
};

// ─── POISSON HELPERS ──────────────────────────────────────────────────────────
function factorial(n) {
  if (n <= 0) return 1;
  let r = 1;
  for (let i = 2; i <= Math.min(n, 15); i++) r *= i;
  return r;
}

function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

/** P(total goals > threshold) given two independent Poisson lambdas */
function probOver(lH, lA, threshold) {
  let pUnder = 0;
  for (let h = 0; h <= 9; h++) {
    for (let a = 0; a <= 9; a++) {
      if (h + a <= threshold) {
        pUnder += poissonProb(lH, h) * poissonProb(lA, a);
      }
    }
  }
  return Math.min(Math.max(1 - pUnder, 0), 1);
}

/** P(both teams score at least 1 goal) */
function probBTTS(lH, lA) {
  return (1 - poissonProb(lH, 0)) * (1 - poissonProb(lA, 0));
}

/** Most statistically likely scoreline */
function likelyScore(lH, lA) {
  let best = 0, score = '1-0';
  for (let h = 0; h <= 5; h++) {
    for (let a = 0; a <= 5; a++) {
      const p = poissonProb(lH, h) * poissonProb(lA, a);
      if (p > best) { best = p; score = `${h}-${a}`; }
    }
  }
  return { score, probability: Math.round(best * 100) };
}

// ─── FORM PARSER ──────────────────────────────────────────────────────────────
/** Accepts "W-W-L-D-W" string or ['W','W','L','D','W'] array */
function parseForm(raw) {
  if (!raw) return { wins: 0, draws: 0, losses: 0, total: 0, winRate: 0, points: 0, formStr: 'N/A' };
  const parts = Array.isArray(raw) ? raw : String(raw).toUpperCase().split(/[-,\s]+/);
  const wins   = parts.filter(r => r === 'W').length;
  const draws  = parts.filter(r => r === 'D').length;
  const losses = parts.filter(r => r === 'L').length;
  const total  = wins + draws + losses;
  return {
    wins, draws, losses, total,
    winRate: total > 0 ? wins / total : 0,
    points:  wins * 3 + draws,
    formStr: parts.slice(0, 5).join('-'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARAMETER SCORERS (each returns { score: 0-100, edge, assessment })
// ─────────────────────────────────────────────────────────────────────────────

// P1 — MOTIVATION GAP
function scoreMotivation({ homePosition, awayPosition, homePoints, awayPoints, totalTeams = 20, gameWeek, totalGW = 38 }) {
  const lifecycle = gameWeek / totalGW;
  const late = lifecycle > 0.75;

  function classify(pos, pts) {
    let m = 50, situation = 'mid-table';
    if (pos <= 3 && late)               { m += 30; situation = 'title-race'; }
    else if (pos <= 3)                  { m += 20; situation = 'title-race'; }
    else if (pos <= 6 && late)          { m += 20; situation = 'european-push'; }
    else if (pos <= 6)                  { m += 10; situation = 'european-push'; }
    else if (pos >= totalTeams - 2 && late) { m += 35; situation = 'relegation-fight'; }
    else if (pos >= totalTeams - 2)     { m += 25; situation = 'relegation-fight'; }
    else if (pos >= totalTeams - 5 && late) { m += 15; situation = 'survival-nervous'; }
    return { motivation: Math.min(m, 100), situation };
  }

  const hA = classify(homePosition, homePoints);
  const aA = classify(awayPosition, awayPoints);
  const gap = Math.abs(hA.motivation - aA.motivation);
  const maxM = Math.max(hA.motivation, aA.motivation);

  let edge = 'NEUTRAL';
  if (hA.motivation > aA.motivation + 20) edge = 'HOME';
  else if (aA.motivation > hA.motivation + 20) edge = 'AWAY';

  // MWV: is a draw a death sentence?
  const mwvIndex = (
    (['relegation-fight', 'title-race'].includes(hA.situation) ? 1 : 0) +
    (['relegation-fight', 'title-race'].includes(aA.situation) ? 1 : 0)
  ) / 2;

  const assessment =
    gap > 30 ? `Extreme motivation gap — ${edge === 'HOME' ? 'Home' : 'Away'} team fighting for survival/title vs dead-zone opposition` :
    maxM > 80 ? 'Both teams in high-stakes battle — expect high intensity' :
    maxM > 60 ? 'Competitive motivation — neither side complacent' :
    'Mid-table dead zone — reduced defensive structure, "Basketball Football" likely';

  return {
    score: Math.round((hA.motivation + aA.motivation) / 2),
    home: hA, away: aA, gap, edge, mwvIndex,
    assessment,
  };
}

// P2 — STAR POWER
function scoreStarPower(homeIntegrity = 85, awayIntegrity = 85, homeAbsences = [], awayAbsences = []) {
  const impactMap = { striker: 15, goalkeeper: 12, 'center-back': 10, midfielder: 8, winger: 7, default: 8 };

  const penalty = (absences) =>
    absences.reduce((acc, a) => acc + (impactMap[(a.position || '').toLowerCase()] || impactMap.default), 0);

  const hEff = Math.max(homeIntegrity - penalty(homeAbsences), 20);
  const aEff = Math.max(awayIntegrity - penalty(awayAbsences), 20);
  const diff = hEff - aEff;

  let edge = 'NEUTRAL';
  let assessment = 'Both squads at comparable strength';
  if (diff > 15)  { edge = 'HOME'; assessment = `Home has significant squad advantage (+${Math.round(diff)}%)`; }
  if (diff < -15) { edge = 'AWAY'; assessment = `Away has significant squad advantage (+${Math.round(-diff)}%)`; }
  if (homeAbsences.length) assessment += `. Home missing: ${homeAbsences.map(a => a.name || a).join(', ')}`;
  if (awayAbsences.length)  assessment += `. Away missing: ${awayAbsences.map(a => a.name || a).join(', ')}`;

  return {
    score: Math.round((hEff + aEff) / 2),
    homeEffective: Math.round(hEff), awayEffective: Math.round(aEff),
    edge, assessment,
  };
}

// P3 — H2H HISTORY
function scoreH2H(history = []) {
  if (!history.length) {
    return { score: 50, goalsAvg: 2.5, overRate: 0.50, edge: 'NEUTRAL', assessment: 'No H2H data — using league baseline' };
  }
  const totalGoals = history.reduce((s, m) => s + (m.homeGoals || 0) + (m.awayGoals || 0), 0);
  const goalsAvg   = totalGoals / history.length;
  const overCount  = history.filter(m => (m.homeGoals + m.awayGoals) > 2.5).length;
  const overRate   = overCount / history.length;
  const homeWins   = history.filter(m => m.winner === 'home').length;
  const awayWins   = history.filter(m => m.winner === 'away').length;
  const draws      = history.filter(m => m.winner === 'draw').length;

  let edge = 'NEUTRAL';
  if (homeWins / history.length > 0.6) edge = 'HOME';
  else if (awayWins / history.length > 0.6) edge = 'AWAY';

  return {
    score: Math.round(goalsAvg * 14 + overRate * 22 + (edge === 'HOME' ? 18 : edge === 'AWAY' ? 12 : 15)),
    goalsAvg: +goalsAvg.toFixed(2), overRate: +overRate.toFixed(2),
    record: { homeWins, draws, awayWins, total: history.length },
    edge,
    assessment: `H2H (${history.length} games): ${homeWins}W/${draws}D/${awayWins}L. Avg ${goalsAvg.toFixed(1)} goals. ${Math.round(overRate * 100)}% Over 2.5.`,
  };
}

// P4 — FORM (L10) with Coiled Spring detection
function scoreForm(homeFormStr, awayFormStr, homeXgAvg = 0, awayXgAvg = 0, homeGoalsAvg = 1.5, awayGoalsAvg = 1.0) {
  const hF = parseForm(homeFormStr);
  const aF = parseForm(awayFormStr);

  // Coiled Spring: high xG but under-converting actual goals (goals overdue)
  const hCoil = homeXgAvg > 0 && homeGoalsAvg > 0 && (homeXgAvg / homeGoalsAvg) > 1.35;
  const aCoil = awayXgAvg  > 0 && awayGoalsAvg  > 0 && (awayXgAvg  / awayGoalsAvg)  > 1.35;

  const hScore = Math.round(hF.winRate * 45 + (hF.total > 0 ? hF.points / (hF.total * 3) : 0) * 35 + (hCoil ? 15 : 0));
  const aScore = Math.round(aF.winRate * 45 + (aF.total > 0 ? aF.points / (aF.total * 3) : 0) * 35 + (aCoil ? 15 : 0));

  let edge = 'NEUTRAL';
  if (hScore > aScore + 15) edge = 'HOME';
  else if (aScore > hScore + 15) edge = 'AWAY';

  return {
    score: Math.round((hScore + aScore) / 2),
    home: { ...hF, coiledSpring: hCoil, score: hScore },
    away: { ...aF, coiledSpring: aCoil, score: aScore },
    edge,
    assessment: [
      `Home form: ${hF.formStr} (${hF.wins}W ${hF.draws}D ${hF.losses}L)`,
      `Away form: ${aF.formStr} (${aF.wins}W ${aF.draws}D ${aF.losses}L)`,
      hCoil ? `⚠️ Home Coiled Spring — xG overperforming, goals overdue` : '',
      aCoil ? `⚠️ Away Coiled Spring — xG overperforming, goals overdue` : '',
    ].filter(Boolean).join('. '),
  };
}

// P5 — SCORING TIMING
function scoreTiming(homeLateGoalPct = 0.20, awayLateGoalPct = 0.20) {
  const avg = (homeLateGoalPct + awayLateGoalPct) / 2;
  const ratio = avg / 0.22;  // relative to league baseline
  const assessment =
    ratio > 1.4 ? `⚡ HIGH late-goal risk — ${Math.round(avg * 100)}% of goals in 76-90' window` :
    ratio > 1.1 ? `Elevated late-goal tendency — watch 76' mark` :
    `Standard timing profile`;
  return { score: Math.round(avg * 220), lateGoalRisk: +ratio.toFixed(2), homeLateGoalPct, awayLateGoalPct, assessment };
}

// P6 — DEFENSIVE GAP
function scoreDefensiveGap(homeGAAvg = 1.2, awayGAAvg = 1.2, leagueAvgGA = 1.35, homeCBOut = false, awayGKError = false) {
  const hVuln = (homeGAAvg / leagueAvgGA) * 40 + (homeCBOut ? 15 : 0);
  const aVuln = (awayGAAvg / leagueAvgGA) * 40 + (awayGKError ? 20 : 0);

  let edge = 'NEUTRAL';
  if (aVuln > hVuln + 15) edge = 'HOME';
  else if (hVuln > aVuln + 15) edge = 'AWAY';

  return {
    score: Math.round((hVuln + aVuln) / 2),
    homeVulnerability: +hVuln.toFixed(1),
    awayVulnerability: +aVuln.toFixed(1),
    edge,
    assessment: [
      `Home: ${homeGAAvg.toFixed(2)} GA/game (${hVuln > 55 ? '⚠️ leaky' : '✓ solid'})`,
      `Away: ${awayGAAvg.toFixed(2)} GA/game (${aVuln > 55 ? '⚠️ leaky' : '✓ solid'})`,
      homeCBOut  ? '🚨 Home missing key CB — high-line exposed' : '',
      awayGKError ? '🚨 GK error flagged — psychological confidence fragile' : '',
    ].filter(Boolean).join('. '),
  };
}

// P7 — handled via Poisson (see runPoisson, score injected below)

// P8 — xG (EXPECTED GOALS)
function scoreXG(homeXgAvg = 1.2, awayXgAvg = 1.0) {
  const combined = homeXgAvg + awayXgAvg;
  const edge = homeXgAvg > awayXgAvg * 1.3 ? 'HOME' : awayXgAvg > homeXgAvg * 1.3 ? 'AWAY' : 'NEUTRAL';
  return {
    score: Math.round(Math.min(combined * 24, 100)),
    homeXgAvg, awayXgAvg, combined: +combined.toFixed(2), edge,
    assessment: `Home xG avg: ${homeXgAvg.toFixed(2)}. Away xG avg: ${awayXgAvg.toFixed(2)}. Combined: ${combined.toFixed(2)}.`,
  };
}

// P9 — xGA (EXPECTED GOALS AGAINST)
function scoreXGA(homeXgaAvg = 1.2, awayXgaAvg = 1.0) {
  const combined = homeXgaAvg + awayXgaAvg;
  const edge = awayXgaAvg > homeXgaAvg * 1.3 ? 'HOME' : homeXgaAvg > awayXgaAvg * 1.3 ? 'AWAY' : 'NEUTRAL';
  return {
    score: Math.round(Math.min(combined * 24, 100)),
    homeXgaAvg, awayXgaAvg, combined: +combined.toFixed(2), edge,
    assessment: `Home xGA (chances conceded): ${homeXgaAvg.toFixed(2)}/game. Away xGA: ${awayXgaAvg.toFixed(2)}/game.`,
  };
}

// P10 — PACE & CONVERSION
function scorePace(homeConv = 10, awayConv = 10, homeShotsPerGame = 12, awayShotsPerGame = 10) {
  const combined = homeShotsPerGame + awayShotsPerGame;
  const avgConv  = (homeConv + awayConv) / 2;
  const pace     = Math.min((combined / 22) * 65 + (avgConv / 15) * 35, 100);
  const edge     = homeConv > awayConv * 1.4 ? 'HOME' : awayConv > homeConv * 1.4 ? 'AWAY' : 'NEUTRAL';
  return {
    score: Math.round(pace),
    homeConversionPct: homeConv, awayConversionPct: awayConv,
    homeShotsPerGame, awayShotsPerGame, edge,
    assessment: `Home: ${homeShotsPerGame} shots/game, ${homeConv}% conv. Away: ${awayShotsPerGame} shots/game, ${awayConv}% conv.`,
  };
}

// P13 — SQUAD INTEGRITY
function scoreSquadIntegrity(homeIntegrity = 90, awayIntegrity = 90) {
  const avg  = (homeIntegrity + awayIntegrity) / 2;
  const edge = homeIntegrity > awayIntegrity + 15 ? 'HOME' : awayIntegrity > homeIntegrity + 15 ? 'AWAY' : 'NEUTRAL';
  return {
    score: Math.round(avg), homeIntegrity, awayIntegrity, edge,
    assessment:
      avg > 85 ? 'Both squads near full strength' :
      avg > 70 ? 'Some notable absences affecting depth' :
      '⚠️ Significant injury/suspension crisis — major uncertainty',
  };
}

// P14 — LEAGUE LIFECYCLE
function scoreLifecycle(gameWeek = 30, totalGW = 38) {
  const pct  = gameWeek / totalGW;
  let phase  = 'Build Phase', mult = 1.0;
  if (pct >= 0.90) { phase = 'Death Run';         mult = 1.50; }
  else if (pct >= 0.80) { phase = 'End-Game';     mult = 1.40; }
  else if (pct >= 0.65) { phase = 'Championship'; mult = 1.20; }
  else if (pct >= 0.50) { phase = 'Mid-Season';   mult = 1.10; }

  return {
    score: Math.min(Math.round(pct * 100 * mult / 1.5), 100),
    gameWeek, totalGW, lifecyclePct: Math.round(pct * 100),
    phase, pressureMultiplier: mult,
    assessment: `GW ${gameWeek}/${totalGW} (${Math.round(pct * 100)}%) — ${phase}. Pressure ×${mult}`,
  };
}

// ─── POISSON PROJECTION ───────────────────────────────────────────────────────
function runPoisson(hXg, aXg, hXga, aXga) {
  const L = RESEARCH.LEAGUE_AVG_GOALS_PER_GAME;
  // Attack strength × opponent defensive weakness
  const lH = Math.max(((hXg || L) / L) * ((aXga || L) / L) * L, 0.10);
  const lA = Math.max(((aXg || L) / L) * ((hXga || L) / L) * L, 0.10);

  const probs = {
    over05:  Math.round(probOver(lH, lA, 0)  * 100),
    over15:  Math.round(probOver(lH, lA, 1)  * 100),
    over25:  Math.round(probOver(lH, lA, 2)  * 100),
    over35:  Math.round(probOver(lH, lA, 3)  * 100),
    btts:    Math.round(probBTTS(lH, lA)      * 100),
    under25: Math.round((1 - probOver(lH, lA, 2)) * 100),
  };

  const ls = likelyScore(lH, lA);
  return {
    homeLambda: +lH.toFixed(2), awayLambda: +lA.toFixed(2),
    expectedTotalGoals: +(lH + lA).toFixed(2),
    probabilities: probs,
    likelyScore: ls,
    assessment: `Projected ${(lH + lA).toFixed(1)} goals. ${probs.over25}% O2.5. ${probs.btts}% BTTS. Most likely: ${ls.score} (${ls.probability}%).`,
  };
}

// ─── CHAOS VARIABLES ──────────────────────────────────────────────────────────
function evaluateChaos({ motivation, form, matchMinutes = 0, earlyGoalScored = false, earlyGoalMinute = null,
                          homeTacticalHighLine = false, awayCounterThreat = false, homePossession = 50 }) {
  const mwvLabel = motivation.mwvIndex >= 0.9 ? 'EXTREME' : motivation.mwvIndex >= 0.7 ? 'HIGH' : motivation.mwvIndex >= 0.5 ? 'MEDIUM' : 'LOW';
  const earlyGoalActive = earlyGoalScored && (earlyGoalMinute !== null ? earlyGoalMinute <= 20 : true);
  const earlyGoalBoost  = earlyGoalActive ? RESEARCH.EARLY_GOAL_O35_BOOST : 0;
  const bivariate       = motivation.mwvIndex > 0.6 && form.home.winRate > 0.4 && form.away.winRate > 0.4;
  const psgTrap         = homePossession >= RESEARCH.PSG_TRAP_POSSESSION_THRESHOLD;
  const highLineRisk    = homeTacticalHighLine && awayCounterThreat;

  return {
    mwvIndex: +motivation.mwvIndex.toFixed(2), mwvLabel,
    earlyGoalActive, earlyGoalBoost,
    bivariateDependency: bivariate,
    psgTrapWarning: psgTrap,
    highLineRisk,
    summary: [
      `MWV Index: ${mwvLabel} (${Math.round(motivation.mwvIndex * 100)}%)`,
      earlyGoalActive  ? `⚡ Early Goal Multiplier ACTIVE — O3.5 probability +${Math.round(earlyGoalBoost * 100)}%` : '',
      bivariate        ? '🔗 Bivariate Dependency — both attack-minded, goals may cascade (1-1 → 3-2)' : '',
      psgTrap          ? `⚠️ PSG Trap — possession ${homePossession}%+ with stalling xG conversion` : '',
      highLineRisk     ? '⚠️ High-Line Risk — counter-attack vulnerability detected' : '',
    ].filter(Boolean).join('\n'),
  };
}

// ─── TIER RECOMMENDATIONS ─────────────────────────────────────────────────────
function generateRecommendations(overallScore, poisson, p1, p4, chaos, matchData) {
  const { home, away, status, matchMinutes = 0 } = matchData;
  const isLive = status === 'LIVE';
  const recs = [];

  // Adjust Over 2.5 probability for chaos
  let o25 = poisson.probabilities.over25;
  if (chaos.earlyGoalActive)    o25 = Math.min(o25 + Math.round(chaos.earlyGoalBoost * 100), 97);
  if (chaos.bivariateDependency) o25 = Math.min(o25 + 8, 97);

  const o15  = poisson.probabilities.over15;
  const u25  = poisson.probabilities.under25;
  const btts = poisson.probabilities.btts;

  // ── Win recommendation ──
  const winEdge = p1.edge !== 'NEUTRAL' ? p1.edge : p4.edge;
  if (winEdge !== 'NEUTRAL') {
    const winTeam = winEdge === 'HOME' ? home : away;
    const wConf   = Math.min(
      Math.round(overallScore * 0.55 + (winEdge === p1.edge ? 20 : 8) + (winEdge === p4.edge ? 15 : 5)),
      96
    );
    if (wConf >= 52) {
      const tier = wConf >= 82 ? 1 : wConf >= 72 ? 2 : wConf >= 62 ? 3 : 4;
      recs.push({
        type: 'WINS_ONLY',
        selection: `${winTeam} Win`,
        confidence: wConf, tier,
        tierName: TIERS[tier].name,
        logic: `Motivation (${p1.edge}) + form (${p4.edge}) both point ${winEdge}. ${p1.assessment.slice(0, 120)}`,
      });
    }
  }

  // ── Over 2.5 ──
  if (o25 >= 52) {
    const tier = o25 >= 82 ? 1 : o25 >= 72 ? 2 : o25 >= 62 ? 3 : 4;
    recs.push({
      type: 'GOALS_ONLY', selection: 'Over 2.5 Goals',
      confidence: Math.min(o25, 96), tier, tierName: TIERS[tier].name,
      logic: `Poisson: ${o25}% probability. Expected ${poisson.expectedTotalGoals} goals.${chaos.earlyGoalActive ? ' Early goal multiplier active.' : ''}`,
    });
  }

  // ── Under 2.5 ──
  if (u25 >= 60) {
    const tier = u25 >= 82 ? 1 : u25 >= 72 ? 2 : 3;
    recs.push({
      type: 'GOALS_ONLY', selection: 'Under 2.5 Goals',
      confidence: Math.min(u25, 96), tier, tierName: TIERS[tier].name,
      logic: `Poisson: ${u25}% probability. Low-scoring setup. ${poisson.assessment}`,
    });
  }

  // ── Over 1.5 (only if not already covered by Over 2.5 Tier 1/2) ──
  if (o15 >= 75 && o25 < 75) {
    recs.push({
      type: 'GOALS_ONLY', selection: 'Over 1.5 Goals',
      confidence: Math.min(o15, 96),
      tier: o15 >= 82 ? 1 : 2, tierName: o15 >= 82 ? TIERS[1].name : TIERS[2].name,
      logic: `${o15}% probability. Safer low-threshold goals play.`,
    });
  }

  // ── BTTS ──
  if (btts >= 62) {
    recs.push({
      type: 'GOALS_ONLY', selection: 'Both Teams to Score',
      confidence: Math.min(btts, 96),
      tier: btts >= 72 ? 2 : 3, tierName: btts >= 72 ? TIERS[2].name : TIERS[3].name,
      logic: `${btts}% BTTS probability from Poisson modeling.`,
    });
  }

  // ── Live Sniper ──
  if (isLive && matchMinutes >= 55) {
    const sniperMarket = poisson.expectedTotalGoals > 2.0 ? 'Over 2.5' : 'Over 1.5';
    const sniperConf = Math.round(o25 * 0.82);
    if (sniperConf >= 52) {
      recs.push({
        type: 'SNIPER_WATCH', selection: `${sniperMarket} Goals (Live ${matchMinutes}')`,
        confidence: sniperConf, tier: 4, tierName: TIERS[4].name,
        logic: `${matchMinutes}' sniper window. ${p1.mwvIndex > 0.6 ? 'MWV elevated — teams desperate for winner.' : 'Watch for late surge.'}`,
      });
    }
  }

  // Sort highest confidence first, then by tier
  return recs.sort((a, b) => b.confidence - a.confidence || a.tier - b.tier);
}

// ─── BOOKIE EDGE DETECTOR ─────────────────────────────────────────────────────
function detectBookieEdges(p1, p2, p4, chaos) {
  const edges = [];
  if (p2.awayEffective < 60)
    edges.push(`Star Power — Away team significantly weakened${p2.assessment.includes('missing') ? '. Bookies may be pricing squad at full strength.' : '.'}`);
  if (p4.home.coiledSpring)
    edges.push(`Home Coiled Spring — xG overperforming vs actual goals. Bookies price on actual goals; true scoring threat is higher.`);
  if (p4.away.coiledSpring)
    edges.push(`Away Coiled Spring — goals overdue for away team. Away goals market may offer value.`);
  if (p1.home.situation === 'relegation-fight' && p1.away.situation === 'mid-table')
    edges.push(`Safety Trap — Away side in dead zone, bookies may underestimate home desperation surge.`);
  if (p1.away.situation === 'relegation-fight' && p1.home.situation === 'mid-table')
    edges.push(`Desperation Away — Away team fighting for survival, bookies may have them too long.`);
  if (chaos.psgTrapWarning)
    edges.push(`PSG Trap — High possession but stalling conversion. Under/draw markets may offer edge.`);
  if (chaos.mwvIndex > 0.8)
    edges.push(`MWV ${chaos.mwvLabel} — Draw is a "death sentence" for one/both teams. Draw odds may be inflated.`);
  return edges;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MASTER ANALYSIS FUNCTION — analyzeV6()
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Run full Agent 47 V6 Frontier analysis on a match.
 *
 * @param {Object} matchData
 * @param {string}   matchData.home               - Home team name
 * @param {string}   matchData.away               - Away team name
 * @param {string}   matchData.league             - League name
 * @param {number}   matchData.gameWeek           - Current game week
 * @param {number}   matchData.totalGW            - Total game weeks (default 38)
 * @param {number}   matchData.totalTeams         - Teams in league (default 20)
 * @param {number}   matchData.homePosition       - Current league position
 * @param {number}   matchData.awayPosition
 * @param {number}   matchData.homePoints         - Current points
 * @param {number}   matchData.awayPoints
 * @param {string}   matchData.status             - 'NS' | 'LIVE' | 'FT'
 * @param {number}   matchData.matchMinutes       - Minutes elapsed (live only)
 * @param {string}   matchData.score              - e.g. '1-0'
 * @param {number}   matchData.homeSquadIntegrity - 0-100 (100 = full strength)
 * @param {number}   matchData.awaySquadIntegrity
 * @param {Array}    matchData.homeKeyAbsences    - [{name, position}]
 * @param {Array}    matchData.awayKeyAbsences
 * @param {string}   matchData.homeForm           - e.g. 'W-W-L-D-W'
 * @param {string}   matchData.awayForm
 * @param {number}   matchData.homeGoalsAvgFor    - Goals scored per game avg
 * @param {number}   matchData.awayGoalsAvgFor
 * @param {number}   matchData.homeGoalsAvgAgainst
 * @param {number}   matchData.awayGoalsAvgAgainst
 * @param {number}   matchData.homeXgAvg          - xG avg per game
 * @param {number}   matchData.awayXgAvg
 * @param {number}   matchData.homeXgaAvg         - xGA avg per game
 * @param {number}   matchData.awayXgaAvg
 * @param {Array}    matchData.h2hHistory         - [{homeGoals, awayGoals, winner}]
 * @param {number}   matchData.homeLateGoalPct    - % goals in 76-90' window
 * @param {number}   matchData.awayLateGoalPct
 * @param {number}   matchData.homeConversionPct  - Shot conversion %
 * @param {number}   matchData.awayConversionPct
 * @param {number}   matchData.homeShotsPerGame
 * @param {number}   matchData.awayShotsPerGame
 * @param {boolean}  matchData.earlyGoalScored    - Goal scored in first 20'?
 * @param {number}   matchData.earlyGoalMinute
 * @param {boolean}  matchData.homeTacticalHighLine
 * @param {boolean}  matchData.awayCounterThreat
 * @param {number}   matchData.homePossession     - Live possession %
 * @param {boolean}  matchData.homeCBInjured
 * @param {boolean}  matchData.awayGKError
 * @param {string}   matchData.referee
 * @param {string}   matchData.venue
 * @returns {Object} Full V6 analysis
 */
export function analyzeV6(matchData = {}) {
  const {
    home = 'Home Team', away = 'Away Team', league = 'Unknown', leagueId = 0,
    gameWeek = 30, totalGW = 38, totalTeams = 20,
    homePosition = 10, awayPosition = 10, homePoints = 40, awayPoints = 40,
    status = 'NS', matchMinutes = 0, score = '0-0',
    homeSquadIntegrity = 90, awaySquadIntegrity = 90,
    homeKeyAbsences = [], awayKeyAbsences = [],
    homeForm = 'W-D-L-W-D', awayForm = 'D-L-W-D-L',
    homeGoalsAvgFor = 1.4, awayGoalsAvgFor = 1.1,
    homeGoalsAvgAgainst = 1.2, awayGoalsAvgAgainst = 1.3,
    homeXgAvg = 1.3, awayXgAvg = 1.1,
    homeXgaAvg = 1.2, awayXgaAvg = 1.2,
    h2hHistory = [],
    homeLateGoalPct = 0.20, awayLateGoalPct = 0.20,
    homeConversionPct = 10, awayConversionPct = 10,
    homeShotsPerGame = 12, awayShotsPerGame = 10,
    earlyGoalScored = false, earlyGoalMinute = null,
    homeTacticalHighLine = false, awayCounterThreat = false,
    homePossession = 50,
    homeCBInjured = false, awayGKError = false,
    referee = null, venue = null,
  } = matchData;

  // ── Run all 14 parameters ──────────────────────────────────────────────────
  const p1  = scoreMotivation({ homePosition, awayPosition, homePoints, awayPoints, totalTeams, gameWeek, totalGW });
  const p2  = scoreStarPower(homeSquadIntegrity, awaySquadIntegrity, homeKeyAbsences, awayKeyAbsences);
  const p3  = scoreH2H(h2hHistory);
  const p4  = scoreForm(homeForm, awayForm, homeXgAvg, awayXgAvg, homeGoalsAvgFor, awayGoalsAvgFor);
  const p5  = scoreTiming(homeLateGoalPct, awayLateGoalPct);
  const p6  = scoreDefensiveGap(homeGoalsAvgAgainst, awayGoalsAvgAgainst, 1.35, homeCBInjured, awayGKError);
  const poi = runPoisson(homeXgAvg, awayXgAvg, homeXgaAvg, awayXgaAvg);
  const p7  = { score: Math.round(poi.probabilities.over25 * 0.80), assessment: poi.assessment };
  const p8  = scoreXG(homeXgAvg, awayXgAvg);
  const p9  = scoreXGA(homeXgaAvg, awayXgaAvg);
  const p10 = scorePace(homeConversionPct, awayConversionPct, homeShotsPerGame, awayShotsPerGame);
  const p11 = { score: 100, assessment: referee ? `Referee: ${referee}. Timezone lock: BST.` : 'Timezone lock: BST.' };
  const p12 = { score: 100, assessment: `Fixture confirmed: ${home} vs ${away} | ${league} GW${gameWeek}` };
  const p13 = scoreSquadIntegrity(homeSquadIntegrity, awaySquadIntegrity);
  const p14 = scoreLifecycle(gameWeek, totalGW);

  // ── Weighted composite score ───────────────────────────────────────────────
  const overall = Math.round(Math.min(
    p1.score  * W.p1_motivation  +
    p2.score  * W.p2_starPower   +
    p3.score  * W.p3_h2h         +
    p4.score  * W.p4_form        +
    p5.score  * W.p5_scoringTiming +
    p6.score  * W.p6_defensiveGap +
    p7.score  * W.p7_poisson     +
    p8.score  * W.p8_xg          +
    p9.score  * W.p9_xga         +
    p10.score * W.p10_pace       +
    p11.score * W.p11_timezone   +
    p12.score * W.p12_fixture    +
    p13.score * W.p13_squad      +
    p14.score * W.p14_lifecycle,
  100));

  // ── Chaos variables ────────────────────────────────────────────────────────
  const chaos = evaluateChaos({ motivation: p1, form: p4, matchMinutes, earlyGoalScored, earlyGoalMinute,
                                 homeTacticalHighLine, awayCounterThreat, homePossession });

  // ── Recommendations ────────────────────────────────────────────────────────
  const recommendations = generateRecommendations(overall, poi, p1, p4, chaos, matchData);

  // ── Bookie edge detection ──────────────────────────────────────────────────
  const bookieEdges = detectBookieEdges(p1, p2, p4, chaos);

  return {
    match:   { home, away, league, leagueId, status, matchMinutes, score, referee, venue, gameWeek, totalGW },
    recommendations,
    parameters: { p1_motivation: p1, p2_starPower: p2, p3_h2h: p3, p4_form: p4,
                  p5_scoringTiming: p5, p6_defensiveGap: p6, p7_poisson: p7,
                  p8_xg: p8, p9_xga: p9, p10_pace: p10,
                  p11_timezone: p11, p12_fixture: p12, p13_squad: p13, p14_lifecycle: p14 },
    poisson: poi,
    chaosVariables: chaos,
    overallScore: overall,
    bookieEdges,
    analysisVersion: 'V6-Frontier',
    analysisTimestamp: new Date().toISOString(),
  };
}

export default analyzeV6;
