/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║           AGENT 47 — V9 CALIBRATED ANALYSIS ENGINE        ║
 * ║      15-Parameter Football Betting Intelligence          ║
 * ╠════════════════════════════════════════════════════════════╣
 * ║  Pure math engine — zero API calls. Feed it match data   ║
 * ║  from live API or calibration. Designed for V9 inputs.   ║
 * ╚════════════════════════════════════════════════════════════╝
 *
 * INPUT:  structured matchData object (see analyzeV9 JSDoc)
 * OUTPUT: tiered recommendations + full 15-parameter audit
 */

import {
  detectCompetitionContext,
  getCompetitionModelProfile,
  applyWeightProfile,
} from '../../../shared/competitionModelProfile.js';

// ─── TIER DEFINITIONS ─────────────────────────────────────────────────────────
export const TIERS = {
  1: { name: 'Capital Security',  minConfidence: 85, description: 'High-stake singles. Maximum reliability. 3–5% purse.' },
  2: { name: 'Balanced Play',     minConfidence: 72, description: 'Balanced value. Standard strategic bets. 2–3% purse.' },
  3: { name: 'Aggressive Play',   minConfidence: 65, description: 'Calculated risk with higher yields. 1–2% purse.' },
  4: { name: 'Calculated Chaos',  minConfidence: 55, description: 'Sniper alerts. Instant goal monitoring. ≤1% purse.' },
};

// ─── PARAMETER WEIGHTS (sum = 1.00) — V9 Calibrated ────────────────────────
// Evidence-based: H2H cut (literature: 2-4% contribution only, squad turnover
// kills old data), Form raised (strongest non-market signal ~15-18%),
// Poisson raised (removing 0.80 cap restores full signal), P11/P12 repurposed
// from dead placeholders to real Home Advantage + Market signals.
const W = {
  p1_motivation:      0.13,  // unchanged: real tactical pressure signal
  p2_starPower:       0.07,  // unchanged: squad quality differential
  p3_h2h:            0.03,  // unchanged: decays fast; 3+ yr data unreliable
  p4_form:           0.15,  // ▲ +0.01: strongest reliable non-market signal
  p5_scoringTiming:  0.05,  // unchanged: minor but real late-goal signal
  p6_defensiveGap:   0.07,  // unchanged: gap between the two defences
  p7_poisson:        0.11,  // Dixon-Coles corrected Poisson (DC removes under-prediction of 0-0/1-0)
  p8_xg:             0.06,  // REFACTORED: directional xG differential (not raw combined sum)
  p9_xga:            0.05,  // REFACTORED: defensive solidity vs league avg (not raw combined sum)
  p10_pace:          0.04,  // unchanged: conversion + shots signal
  p11_homeAdvantage: 0.03,  // unchanged: real home advantage signal
  p12_market:        0.04,  // ▲ +0.01: now Poisson model vs market divergence (genuine edge signal)
  p13_squad:         0.05,  // REFACTORED: competitive context / league tier (replaces duplicate squad integrity)
  p14_lifecycle:     0.02,  // unchanged: season phase pressure
  p15_crisis:        0.10,  // ▼ -0.02: reduce overweighting of unmeasured crisis signals
}; // Sum: 0.13+0.07+0.03+0.15+0.05+0.07+0.11+0.06+0.05+0.04+0.03+0.04+0.05+0.02+0.10 = 1.00 ✓

// ─── LEAGUE RELIABILITY SCALARS (V9 CORRECTED) ─────────────────────────────
// High-variance leagues REDUCE confidence (penalty, not inflation).
// EPL = 1.00 baseline. Less predictable = < 1.00.
// Unknown leagues default to 0.93 (unknown = some uncertainty penalty).
const LEAGUE_SCALARS = {
  39:  1.00,  // Premier League (baseline — most data, most efficient)
  140: 0.97,  // La Liga
  78:  0.97,  // Bundesliga
  61:  0.90,  // Ligue 1 (PSG dominance, chaotic mid-table)
  135: 0.93,  // Serie A (tactical, mid-table chaos)
  88:  0.92,  // Eredivisie
  179: 0.92,  // Scottish Premiership
  40:  0.93,  // Championship (England)
  94:  0.92,  // Primeira Liga (Portugal)
  144: 0.85,  // Belgian Pro League
  119: 0.88,  // J1 League (Japan)
  98:  0.88,  // J1 League (alt ID)
  292: 0.87,  // K League 1 (South Korea)
  169: 0.78,  // Chinese Super League
  203: 0.75,  // Saudi Pro League
  333: 0.82,  // Ukrainian Premier League
  71:  0.70,  // Brasileirão Serie A (extreme variance)
  313: 0.82,  // Indonesian Liga 1
  262: 0.87,  // Liga MX
  253: 0.85,  // MLS
};

// Per-league average goals per team per game (empirical 2023-25 seasons)
const LEAGUE_GOALS_AVG = {
  39:  1.35,  // Premier League
  140: 1.25,  // La Liga
  78:  1.55,  // Bundesliga
  61:  1.35,  // Ligue 1
  135: 1.25,  // Serie A
  88:  1.60,  // Eredivisie
  179: 1.45,  // Scottish Premiership
  40:  1.30,  // Championship (England)
  94:  1.25,  // Primeira Liga
  119: 1.35,  // J1 League
  98:  1.35,  // J1 League (alt)
  203: 1.45,  // Saudi Pro League
  71:  1.45,  // Brasileirão Serie A
  253: 1.45,  // MLS
  2:   1.35,  // Champions League
  3:   1.30,  // Europa League
  848: 1.25,  // Conference League
  849: 1.25,  // Conference League (alt)
  4:   1.20,  // World Cup
};
export function getLeagueGoalsAvg(leagueId) {
  return LEAGUE_GOALS_AVG[+leagueId] ?? 1.35;
}

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

// Dixon-Coles ρ correction for low-scoring cells (Dixon & Coles, 1997)
// Corrects Poisson's systematic under-prediction of 0-0, 1-0, 0-1, 1-1 outcomes.
// ρ = -0.1 is empirically fitted to European football leagues.
const DC_RHO = -0.1;
function dcTau(h, a, lH, lA) {
  if (h === 0 && a === 0) return 1 - lH * lA * DC_RHO;
  if (h === 1 && a === 0) return 1 + lA * DC_RHO;
  if (h === 0 && a === 1) return 1 + lH * DC_RHO;
  if (h === 1 && a === 1) return 1 - DC_RHO;
  return 1.0;
}

/** P(total goals > threshold) with Dixon-Coles low-score correction */
function probOver(lH, lA, threshold) {
  let pUnder = 0;
  for (let h = 0; h <= 9; h++) {
    for (let a = 0; a <= 9; a++) {
      if (h + a <= threshold) {
        pUnder += poissonProb(lH, h) * poissonProb(lA, a) * dcTau(h, a, lH, lA);
      }
    }
  }
  return Math.min(Math.max(1 - pUnder, 0), 1);
}

/** P(both teams score at least 1 goal) with Dixon-Coles correction */
function probBTTS(lH, lA) {
  let p = 0;
  for (let h = 1; h <= 9; h++) {
    for (let a = 1; a <= 9; a++) {
      p += poissonProb(lH, h) * poissonProb(lA, a) * dcTau(h, a, lH, lA);
    }
  }
  return Math.min(Math.max(p, 0), 1);
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

/**
 * P(leader maintains their goal advantage at full time).
 * Uses independent bivariate Poisson: P(trailer_goals_added - leader_goals_added < diff)
 * where each side follows Pois(remaining_lambda).
 *
 * This is the only scientifically valid way to compute live-match win confidence: it
 * accounts for actual team quality (λ), remaining time, and game-state motivation.
 * A strong trailing team (e.g. Bayern at HT, high λ) correctly shows lower confidence
 * for the leading team — which no hardcoded table can capture.
 *
 * @param {number} lLeader_rem  - Expected goals remaining for the leading team
 * @param {number} lTrailer_rem - Expected goals remaining for the trailing team
 * @param {number} diff         - Current goal gap (integer >= 1)
 */
function pLeadMaintained(lLeader_rem, lTrailer_rem, diff) {
  let p = 0;
  for (let hAdd = 0; hAdd <= 10; hAdd++) {
    for (let aAdd = 0; aAdd <= 10; aAdd++) {
      // lead is maintained when trailer fails to close the full gap: aAdd - hAdd < diff
      if (aAdd - hAdd < diff) {
        p += poissonProb(lLeader_rem, hAdd) * poissonProb(lTrailer_rem, aAdd);
      }
    }
  }
  return Math.min(Math.max(p, 0), 1);
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
    return { score: null, edge: 'NEUTRAL', assessment: 'No H2H history available.' };
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

// P4 — FORM (L10) with recency overweight + tighter Coiled Spring (V8)
// V8: last 5 results weighted 60% heavier than previous 5 (RECENT_WEIGHT = 1.6×)
function weightedFormScore(raw) {
  if (!raw) return 50;
  const parts = Array.isArray(raw) ? raw : String(raw).toUpperCase().split(/[-,\s]+/);
  const RECENT_W = 1.6; // newest 5 games are 60% heavier
  let weighted = 0, maxWeight = 0;
  parts.forEach((r, i) => {
    const w = i < 5 ? RECENT_W : 1.0; // i=0 is newest
    weighted  += (r === 'W' ? 3 : r === 'D' ? 1 : 0) * w;
    maxWeight += 3 * w;
  });
  return maxWeight > 0 ? (weighted / maxWeight) * 100 : 50;
}

function scoreForm(homeFormStr, awayFormStr, homeXgAvg = 0, awayXgAvg = 0, homeGoalsAvg = null, awayGoalsAvg = null, homeXgTrend = null, awayXgTrend = null) {
  if (!homeFormStr && !awayFormStr) {
    return { score: null, home: { formStr: null, winRate: 0 }, away: { formStr: null, winRate: 0 }, edge: 'NEUTRAL', assessment: 'No form data available.' };
  }
  const hF = parseForm(homeFormStr);
  const aF = parseForm(awayFormStr);

    // V9 Tighter Coiled Spring: only fires if xG is NOT also collapsing.
  // If xG trend is negative (declining), the spring has no tension — no boost.
  const hCoil = homeXgAvg > 0 && homeGoalsAvg > 0 && (homeXgAvg / homeGoalsAvg) > 1.35
    && (homeXgTrend === null || homeXgTrend >= 0);
  const aCoil = awayXgAvg  > 0 && awayGoalsAvg  > 0 && (awayXgAvg  / awayGoalsAvg)  > 1.35
    && (awayXgTrend === null || awayXgTrend >= 0);

  // V8: blend recency-weighted score (60%) with flat win-rate base (40%)
  const hRecent = weightedFormScore(homeFormStr);
  const aRecent = weightedFormScore(awayFormStr);
  const hBase = hF.winRate * 45 + (hF.total > 0 ? hF.points / (hF.total * 3) : 0) * 35;
  const aBase = aF.winRate * 45 + (aF.total > 0 ? aF.points / (aF.total * 3) : 0) * 35;
  const hScore = Math.round(hRecent * 0.6 + hBase * 0.4 + (hCoil ? 12 : 0));
  const aScore = Math.round(aRecent * 0.6 + aBase * 0.4 + (aCoil ? 12 : 0));

  let edge = 'NEUTRAL';
  if (hScore > aScore + 15) edge = 'HOME';
  else if (aScore > hScore + 15) edge = 'AWAY';

  return {
    score: Math.round((hScore + aScore) / 2),
    home: { ...hF, coiledSpring: hCoil, score: hScore },
    away: { ...aF, coiledSpring: aCoil, score: aScore },
    edge,
    assessment: [
      `Home form: ${hF.formStr} (${hF.wins}W ${hF.draws}D ${hF.losses}L, recency-weighted)`,
      `Away form: ${aF.formStr} (${aF.wins}W ${aF.draws}D ${aF.losses}L, recency-weighted)`,
      hCoil ? `⚠️ Home Coiled Spring — xG overperforming goals (trend stable)` : '',
      aCoil ? `⚠️ Away Coiled Spring — xG overperforming goals (trend stable)` : '',
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
function scoreDefensiveGap(homeGAAvg, awayGAAvg, leagueAvgGA = 1.35, homeCBOut = false, awayGKError = false) {
  if (homeGAAvg == null || awayGAAvg == null) {
    return { score: null, edge: 'NEUTRAL', assessment: 'No goals-against data available.' };
  }
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

// P8 — xG QUALITY DIFFERENTIAL (directional attacking edge)
// Scores WHO has the xG advantage, not HOW MUCH xG both teams produce.
// Avoids double-counting with P7 which already incorporates absolute xG magnitudes in Poisson lambdas.
function scoreXGDifferential(homeXgAvg, awayXgAvg) {
  if (homeXgAvg == null || awayXgAvg == null) {
    return { score: null, edge: 'NEUTRAL', assessment: 'No xG data available.' };
  }
  const diff  = homeXgAvg - awayXgAvg;
  const ratio = awayXgAvg > 0 ? homeXgAvg / awayXgAvg : 1.0;
  const edge  = ratio > 1.25 ? 'HOME' : ratio < 0.80 ? 'AWAY' : 'NEUTRAL';
  const score = Math.min(Math.max(Math.round(50 + diff * 15), 20), 80);
  return {
    score,
    homeXgAvg: +homeXgAvg.toFixed(2),
    awayXgAvg: +awayXgAvg.toFixed(2),
    differential: +diff.toFixed(2),
    ratio: +ratio.toFixed(2),
    edge,
    assessment: `xG edge: ${diff > 0 ? '+' : ''}${diff.toFixed(2)}/game. ${edge === 'HOME' ? 'Home generating meaningfully higher xG.' : edge === 'AWAY' ? 'Away generating meaningfully higher xG.' : 'Balanced chance creation — no clear xG edge.'}`,
  };
}

// P9 — DEFENSIVE SOLIDITY
// Measures how each team's defence compares to the league average xGA baseline.
// High score = both defences conceding below average = tighter game likely.
// Distinct from P6 (gap between the two teams' defences) and P7 (absolute xGA in Poisson lambdas).
function scoreDefensiveSolidity(homeXgaAvg, awayXgaAvg, leagueAvgGA = 1.35) {
  if (homeXgaAvg == null || awayXgaAvg == null) {
    return { score: null, edge: 'NEUTRAL', assessment: 'No defensive xGA data available.' };
  }
  const L      = leagueAvgGA;
  const hBonus = L - homeXgaAvg;  // positive = conceding LESS than league average
  const aBonus = L - awayXgaAvg;
  const avgBonus = (hBonus + aBonus) / 2;
  const score  = Math.min(Math.max(Math.round(50 + avgBonus * 22), 15), 85);
  const hLabel = hBonus > 0.2 ? 'solid' : hBonus < -0.2 ? 'leaky' : 'average';
  const aLabel = aBonus > 0.2 ? 'solid' : aBonus < -0.2 ? 'leaky' : 'average';
  let profile;
  if (score >= 65)      profile = 'Both defences sound — Under market and tight scorelines favoured.';
  else if (score <= 35) profile = 'Both defences exposed — Over and BTTS markets supported.';
  else                  profile = 'Average defensive profiles — neutral goals market signal.';
  return {
    score,
    homeXgaAvg: +homeXgaAvg.toFixed(2),
    awayXgaAvg: +awayXgaAvg.toFixed(2),
    edge: hBonus > aBonus + 0.25 ? 'HOME' : aBonus > hBonus + 0.25 ? 'AWAY' : 'NEUTRAL',
    assessment: `Home defence ${hLabel} (${homeXgaAvg.toFixed(2)} xGA/game). Away defence ${aLabel} (${awayXgaAvg.toFixed(2)} xGA/game). ${profile}`,
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

// P13 — COMPETITIVE CONTEXT (replaces duplicate squad integrity — P2 Star Power already covers squad quality)
// Scores the match's predictability premium by league tier and competition type.
// Top-5 European leagues = stronger favourite bias, better historical data.
// Lower-tier and cup formats = higher variance = appropriately reduces model confidence.
function scoreCompetitiveContext(leagueId = 0, matchType = 'League') {
  const TIER1 = new Set([39, 140, 78, 135, 61]);      // Top 5 European leagues
  const TIER2 = new Set([88, 94, 64, 40, 179, 203]);  // Strong secondary leagues
  const UEFA  = new Set([2, 3, 849, 848]);             // UCL/UEL/UECL
  const isCup = matchType === 'Cup' || matchType === 'Knockout';
  let score, context;
  if (TIER1.has(leagueId)) {
    score = 76; context = 'Top-5 European league — high data quality, outcomes more predictable.';
  } else if (UEFA.has(leagueId)) {
    score = 72; context = 'UEFA competition — elite clubs, rich historical dataset.';
  } else if (TIER2.has(leagueId)) {
    score = 62; context = 'Quality mid-tier league — reasonable depth of data.';
  } else if (isCup) {
    score = 45; context = 'Cup or knockout format — elevated variance and giant-killing risk.';
  } else {
    score = 44; context = 'Lower-tier or unknown league — limited historical data, higher prediction variance.';
  }
  return { score, leagueId, matchType, edge: 'NEUTRAL', assessment: context };
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

// P15 — CRISIS / DROUGHT MODE (★ V9 — 12% weight) ─────────────────────────
// Penalises: goal drought (3+ games), losing runs (4+ straight), interim chaos.
// Rewards:   settled new permanent manager (6+ weeks, improving results).
//
// Coach stability rule:
//   isInterim + gamesInRole ≤ 3   → −15 to −25 hit (chaos)
//   !isInterim + tenureWeeks ≥ 6 + improving → +10 to +18 boost (new coach bounce)
function scoreCrisisMode({
  homeGoalDrought = 0, awayGoalDrought = 0,
  homeRecentLosses = 0, awayRecentLosses = 0,
  homeCoach = {}, awayCoach = {},
}) {
  let homeScore = 70; // baseline — no crisis signals
  let awayScore = 70;
  const flags = [];

  // ── Goal drought ──────────────────────────────────────────────────────────
  if (homeGoalDrought >= 5) {
    homeScore -= 35;
    flags.push(`🚨 Home goal drought: ${homeGoalDrought} games scoreless — full Crisis Mode`);
  } else if (homeGoalDrought >= 3) {
    homeScore -= 20;
    flags.push(`⚠️ Home goal drought: ${homeGoalDrought} games without scoring`);
  } else if (homeGoalDrought === 2) {
    homeScore -= 8;
  }

  if (awayGoalDrought >= 5) {
    awayScore -= 35;
    flags.push(`🚨 Away goal drought: ${awayGoalDrought} games scoreless — full Crisis Mode`);
  } else if (awayGoalDrought >= 3) {
    awayScore -= 20;
    flags.push(`⚠️ Away goal drought: ${awayGoalDrought} games without scoring`);
  } else if (awayGoalDrought === 2) {
    awayScore -= 8;
  }

  // ── Consecutive losses ────────────────────────────────────────────────────
  if (homeRecentLosses >= 4) {
    homeScore -= 20;
    flags.push(`📉 Home in freefall: ${homeRecentLosses} straight losses`);
  } else if (homeRecentLosses === 3) {
    homeScore -= 10;
    flags.push(`⚠️ Home losing run: ${homeRecentLosses} games`);
  }

  if (awayRecentLosses >= 4) {
    awayScore -= 18;
    flags.push(`📉 Away in freefall: ${awayRecentLosses} straight losses`);
  } else if (awayRecentLosses === 3) {
    awayScore -= 8;
    flags.push(`⚠️ Away losing run: ${awayRecentLosses} games`);
  }

  // ── Coach stability ───────────────────────────────────────────────────────
  for (const [coach, label, isHome] of [[homeCoach, 'Home', true], [awayCoach, 'Away', false]]) {
    const { isInterim = false, gamesInRole = 20, tenureWeeks = 20, improving = false } = coach;
    if (isInterim && gamesInRole <= 3) {
      const hit = gamesInRole <= 1 ? 25 : gamesInRole <= 2 ? 20 : 15;
      if (isHome) homeScore -= hit; else awayScore -= hit;
      flags.push(`🔴 ${label} interim chaos: only ${gamesInRole} game(s) in charge`);
    } else if (!isInterim && tenureWeeks >= 6 && improving) {
      const boost = tenureWeeks >= 10 ? 18 : tenureWeeks >= 8 ? 14 : 10;
      if (isHome) homeScore += boost; else awayScore += boost;
      flags.push(`✅ ${label} new coach bounce: ${tenureWeeks} weeks in, results improving`);
    }
  }

  const hClamped = Math.min(Math.max(homeScore, 0), 100);
  const aClamped = Math.min(Math.max(awayScore, 0), 100);
  const score    = Math.round((hClamped + aClamped) / 2);
  const crisisLevel =
    score < 30 ? 'MELTDOWN' :
    score < 50 ? 'CRITICAL' :
    score < 65 ? 'STRESSED' : 'STABLE';

  return {
    score, homeScore: hClamped, awayScore: aClamped, crisisLevel, flags,
    assessment: flags.length
      ? `[${crisisLevel}] ${flags.join('. ')}`
      : `[STABLE] No crisis signals — both teams in normal operational state`,
  };
}

// ─── POISSON PROJECTION ───────────────────────────────────────────────────────
function runPoisson(hXg, aXg, hXga, aXga, leagueId = 0) {
  if (hXg == null || aXg == null || hXga == null || aXga == null) {
    return {
      homeLambda: null, awayLambda: null,
      expectedTotalGoals: null,
      probabilities: { over05: null, over15: null, over25: null, over35: null, btts: null, under25: null, draw: null },
      likelyScore: null,
      insufficientData: true,
      assessment: 'Insufficient team statistics for Poisson projection.',
    };
  }
  const L = getLeagueGoalsAvg(leagueId);
  // Attack strength × opponent defensive weakness
  const lH = Math.max((hXg / L) * (aXga / L) * L, 0.10);
  const lA = Math.max((aXg / L) * (hXga / L) * L, 0.10);

  // Draw probability: Dixon-Coles corrected P(i-i) for i = 0..7
  let pDraw = 0;
  for (let g = 0; g <= 7; g++) {
    pDraw += dcTau(g, g, lH, lA) * poissonProb(lH, g) * poissonProb(lA, g);
  }

  const probs = {
    over05:  Math.round(probOver(lH, lA, 0)  * 100),
    over15:  Math.round(probOver(lH, lA, 1)  * 100),
    over25:  Math.round(probOver(lH, lA, 2)  * 100),
    over35:  Math.round(probOver(lH, lA, 3)  * 100),
    btts:    Math.round(probBTTS(lH, lA)      * 100),
    under25: Math.round((1 - probOver(lH, lA, 2)) * 100),
    draw:    Math.round(pDraw * 100),
  };

  const ls = likelyScore(lH, lA);
  return {
    homeLambda: +lH.toFixed(2), awayLambda: +lA.toFixed(2),
    expectedTotalGoals: +(lH + lA).toFixed(2),
    probabilities: probs,
    likelyScore: ls,
    assessment: `Projected ${(lH + lA).toFixed(1)} goals. ${probs.over25}% O2.5. ${probs.btts}% BTTS. Draw: ${probs.draw}%. Most likely: ${ls.score} (${ls.probability}%).`,
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
  const { home, away, status, matchMinutes = 0, score = '0-0' } = matchData;
  const recs = [];
  // All in-play statuses — API-Football also returns 1H, 2H, HT, ET, BT, P
  const isLive = ['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT'].includes(status);
  // Normalise elapsed time — HT is always at least 45' (API sometimes returns 0 or null)
  const effectiveMins = (status === 'HT' && matchMinutes < 45) ? 45 : matchMinutes;

  // ── LIVE PATH — full market surface (all unsettled lines shown simultaneously) ─
  // Design principle: never collapse to a single market. Surface every open line with
  // its true Poisson probability so the bettor can decide where to extract value.
  // Bookies price "next goal" LOW immediately after a goal; the edge often lives in
  // the totals (Over 2.5, 3.5) or the winner market — show them ALL.
  if (isLive) {
    // Without team-quality Poisson lambdas we cannot generate calibrated recommendations.
    if (poisson.homeLambda == null || poisson.awayLambda == null) return [];

    const [hG, aG]  = score.split('-').map(n => parseInt(n, 10) || 0);
    const totalGoals = hG + aG;
    const scoreDiff  = hG - aG;
    const absDiff    = Math.abs(scoreDiff);
    const minsLeft   = Math.max(90 - effectiveMins, 2);
    const remainFrac = minsLeft / 90;

    const homeRed    = matchData.homeCards?.red    || 0;
    const awayRed    = matchData.awayCards?.red    || 0;
    const homeYellow = matchData.homeCards?.yellow || 0;
    const awayYellow = matchData.awayCards?.yellow || 0;
    const homeCardMult = homeRed > 0 ? 0.62 : 1.0;
    const awayCardMult = awayRed  > 0 ? 0.62 : 1.0;

    // Dixon & Robinson (1998): motivation urgency grows linearly with time into the match.
    const timeUrgency = Math.min(effectiveMins / 90, 1.0);
    const hMotiveMult = scoreDiff < 0
      ? Math.min(1.0 + (scoreDiff < -1 ? 0.18 : 0.12) + 0.25 * timeUrgency, 1.50)
      : scoreDiff > 0
      ? Math.max(1.0 - (scoreDiff > 1 ? 0.15 : 0.05) - 0.20 * timeUrgency, 0.62)
      : 1.0;
    const aMotiveMult = scoreDiff > 0
      ? Math.min(1.0 + (scoreDiff > 1 ? 0.18 : 0.12) + 0.25 * timeUrgency, 1.50)
      : scoreDiff < 0
      ? Math.max(1.0 - (scoreDiff < -1 ? 0.15 : 0.05) - 0.20 * timeUrgency, 0.62)
      : 1.0;

    // Remaining expected goals per team
    const lH_rem = Math.max(poisson.homeLambda * remainFrac * hMotiveMult * homeCardMult, 0.01);
    const lA_rem = Math.max(poisson.awayLambda * remainFrac * aMotiveMult * awayCardMult, 0.01);
    const expRem = lH_rem + lA_rem;

    // Poisson probabilities for remaining goals
    const p0r        = Math.exp(-expRem);
    const p1r        = expRem * p0r;
    const p2r        = (expRem ** 2 / 2) * p0r;
    const probAny1   = Math.round((1 - p0r) * 100);               // P(>=1 more goal)
    const prob2more  = Math.round((1 - p0r - p1r) * 100);         // P(>=2 more goals)
    const prob3more  = Math.round((1 - p0r - p1r - p2r) * 100);   // P(>=3 more goals)

    // ── WIN MARKET ────────────────────────────────────────────────────────────
    if (scoreDiff !== 0) {
      const leader       = scoreDiff > 0 ? home : away;
      const leaderIsHome = scoreDiff > 0;
      const cardNote     = homeRed > 0 ? ` ⚠️ ${home} 10 men.` : awayRed > 0 ? ` ⚠️ ${away} 10 men.` : '';

      // Late-game dominance: use conservative leader/trailer motivation split
      const locked =
        (effectiveMins >= 75 && absDiff >= 2) ||
        (effectiveMins >= 85 && absDiff >= 1) ||
        (effectiveMins >= 60 && absDiff >= 3) ||
        (status === 'HT'     && absDiff >= 2) ||
        (effectiveMins >= 45 && absDiff >= 3);

      const leaderMotiveMult  = locked
        ? Math.max(1.0 - (absDiff >= 2 ? 0.15 : 0.05) - 0.20 * timeUrgency, 0.62)
        : (leaderIsHome ? hMotiveMult : aMotiveMult);
      const trailerMotiveMult = locked
        ? Math.min(1.0 + (absDiff >= 2 ? 0.18 : 0.12) + 0.25 * timeUrgency, 1.50)
        : (leaderIsHome ? aMotiveMult : hMotiveMult);
      const lLeader_final  = leaderIsHome
        ? Math.max(poisson.homeLambda * remainFrac * leaderMotiveMult  * homeCardMult, 0.01)
        : Math.max(poisson.awayLambda * remainFrac * leaderMotiveMult  * awayCardMult, 0.01);
      const lTrailer_final = leaderIsHome
        ? Math.max(poisson.awayLambda * remainFrac * trailerMotiveMult * awayCardMult, 0.01)
        : Math.max(poisson.homeLambda * remainFrac * trailerMotiveMult * homeCardMult, 0.01);

      const winConf = Math.round(pLeadMaintained(lLeader_final, lTrailer_final, absDiff) * 100);
      if (winConf >= 52) {
        const tier = winConf >= 85 ? 1 : winConf >= 72 ? 2 : winConf >= 62 ? 3 : 4;
        recs.push({
          type: 'WINS_ONLY', selection: `${leader} Win`,
          confidence: winConf, tier, tierName: TIERS[tier].name,
          logic: `${effectiveMins}' played, ${hG}-${aG}. ${minsLeft}' remaining. P(lead maintained): ${winConf}%.${cardNote}`,
        });
      }

      // Desperation sniper — trailing team likely to push for equalizer (last 25 minutes)
      const loser = scoreDiff > 0 ? away : home;
      if (absDiff === 1 && minsLeft <= 25) {
        const loserHasRed = (loser === home && homeRed > 0) || (loser === away && awayRed > 0);
        const yellNote    = (homeYellow >= 4 || awayYellow >= 4)
          ? 'Heavy bookings — physical, desperate play.' : chaos.mwvIndex > 0.6
          ? 'MWV elevated.' : 'Late push expected.';
        const despConf = Math.round(Math.min(38 + (25 - minsLeft) * 2.0, 68) - (loserHasRed ? 15 : 0));
        if (despConf >= 42) {
          recs.push({
            type: 'SNIPER_WATCH', selection: `${loser} Next Goal`,
            confidence: despConf, tier: 4, tierName: TIERS[4].name,
            logic: `${loser} 1 goal behind with ${minsLeft}' left. ${yellNote}`,
          });
        }
      }
    }

    // ── GOALS TOTAL MARKETS — all unsettled lines ─────────────────────────────
    // Bookie note: "next goal" odds compress immediately after each goal scored;
    // value migrates to totals and directional markets — show every open line.

    // Over {totalGoals}.5 — needs 1 more goal
    if (probAny1 >= 45) {
      const tier     = probAny1 >= 82 ? 1 : probAny1 >= 72 ? 2 : probAny1 >= 62 ? 3 : 4;
      const cardNote = homeRed > 0 || awayRed > 0 ? ' Red card reduces scoring rate.' : '';
      recs.push({
        type: 'GOALS_ONLY', selection: `Over ${totalGoals}.5 Goals`,
        confidence: Math.min(probAny1, 96), tier, tierName: TIERS[tier].name,
        logic: `${expRem.toFixed(1)} expected remaining goals in ${minsLeft}'. P(another goal): ${probAny1}%.${cardNote}`,
      });
    }

    // Over {totalGoals+1}.5 — needs 2 more goals
    // No "totalGoals >= 2" gate — show whenever probability qualifies (e.g. 1-0 game showing Over 2.5)
    if (prob2more >= 35) {
      const tier2 = prob2more >= 72 ? 2 : prob2more >= 55 ? 3 : 4;
      recs.push({
        type: 'GOALS_ONLY', selection: `Over ${totalGoals + 1}.5 Goals`,
        confidence: Math.min(prob2more, 82), tier: tier2, tierName: TIERS[tier2].name,
        logic: `${prob2more}% P(2+ more goals in ${minsLeft}'). ${expRem.toFixed(1)} remaining.`,
      });
    }

    // Over {totalGoals+2}.5 — needs 3 more goals (high-scoring trajectory indicator)
    if (prob3more >= 20) {
      recs.push({
        type: 'GOALS_ONLY', selection: `Over ${totalGoals + 2}.5 Goals`,
        confidence: Math.min(prob3more, 72), tier: 4, tierName: TIERS[4].name,
        logic: `${prob3more}% P(3+ more goals in ${minsLeft}'). High-scoring trajectory.`,
      });
    }

    // ── BTTS — only if one team is still to open their account ───────────────
    if (hG === 0 || aG === 0) {
      const scorelessLambda = hG === 0 ? lH_rem : lA_rem;
      const scorelessTeam   = hG === 0 ? home : away;
      const probBttsNow     = Math.round((1 - Math.exp(-scorelessLambda)) * 100);
      if (probBttsNow >= 45) {
        recs.push({
          type: 'GOALS_ONLY', selection: 'Both Teams to Score',
          confidence: Math.min(probBttsNow, 88),
          tier: probBttsNow >= 72 ? 2 : 3,
          tierName: probBttsNow >= 72 ? TIERS[2].name : TIERS[3].name,
          logic: `${scorelessTeam} yet to score. ${probBttsNow}% P(they score in remaining ${minsLeft}').`,
        });
      }
    }

    // ── DIRECTIONAL NEXT GOAL — which team scores the next goal ──────────────
    // P(team X scores next) = (lambdaX / lambdaTotal) * P(any goal)
    // Shown alongside totals — bettor can compare value across bookmaker markets.
    if (expRem > 0 && probAny1 >= 40) {
      const probHomeNext = Math.round((lH_rem / expRem) * probAny1);
      const probAwayNext = Math.round((lA_rem / expRem) * probAny1);
      if (probHomeNext >= 30) {
        recs.push({
          type: 'NEXT_GOAL', selection: `${home} Next Goal`,
          confidence: Math.min(probHomeNext, 85),
          tier: probHomeNext >= 72 ? 2 : probHomeNext >= 55 ? 3 : 4,
          tierName: probHomeNext >= 72 ? TIERS[2].name : probHomeNext >= 55 ? TIERS[3].name : TIERS[4].name,
          logic: `${probHomeNext}% P(${home} scores next). Attack rate: ${lH_rem.toFixed(2)} vs ${lA_rem.toFixed(2)}.`,
        });
      }
      if (probAwayNext >= 30) {
        recs.push({
          type: 'NEXT_GOAL', selection: `${away} Next Goal`,
          confidence: Math.min(probAwayNext, 85),
          tier: probAwayNext >= 72 ? 2 : probAwayNext >= 55 ? 3 : 4,
          tierName: probAwayNext >= 72 ? TIERS[2].name : probAwayNext >= 55 ? TIERS[3].name : TIERS[4].name,
          logic: `${probAwayNext}% P(${away} scores next). Attack rate: ${lA_rem.toFixed(2)} vs ${lH_rem.toFixed(2)}.`,
        });
      }
    }

    return recs.sort((a, b) => b.confidence - a.confidence || a.tier - b.tier);
  }


  // ── PRE-MATCH PATH ────────────────────────────────────────────────────────────
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

  // Sort highest confidence first, then by tier
  return recs.sort((a, b) => b.confidence - a.confidence || a.tier - b.tier);
}

function tierFromConfidence(conf = 50) {
  return conf >= 85 ? 1 : conf >= 72 ? 2 : conf >= 62 ? 3 : 4;
}

function fallbackRecommendation({ home, away, overallScore, poisson, p1, p4, p8, analysisQuality = null }) {
  const probs = poisson?.probabilities || {};
  const contradiction = Boolean(analysisQuality?.contradiction);
  const drawProb = Number(probs.draw || 0);

  if (contradiction) {
    if (drawProb >= 30 && (probs.under25 || 0) >= 56) {
      const conf = Math.max(54, Math.min(84, Math.round(probs.under25)));
      const tier = tierFromConfidence(conf);
      return {
        type: 'GOALS_ONLY',
        selection: 'Under 2.5 Goals',
        confidence: conf,
        tier,
        tierName: TIERS[tier].name,
        logic: `Contradictory directional signals. Draw risk ${drawProb}% and U2.5 ${probs.under25}% favor a safer fallback.`,
      };
    }
    if ((probs.over15 || 0) >= 68) {
      const conf = Math.max(55, Math.min(86, Math.round(probs.over15)));
      const tier = tierFromConfidence(conf);
      return {
        type: 'GOALS_ONLY',
        selection: 'Over 1.5 Goals',
        confidence: conf,
        tier,
        tierName: TIERS[tier].name,
        logic: `Contradictory directional signals. Broad-goals fallback selected with O1.5 at ${probs.over15}%.",
      };
    }
  }

  const fallbackOptions = [
    { type: 'GOALS_ONLY', selection: 'Over 1.5 Goals', confidence: probs.over15 ?? null, logic: `Fallback by Poisson O1.5 (${probs.over15 ?? 'N/A'}%).` },
    { type: 'GOALS_ONLY', selection: 'Over 2.5 Goals', confidence: probs.over25 ?? null, logic: `Fallback by Poisson O2.5 (${probs.over25 ?? 'N/A'}%).` },
    { type: 'GOALS_ONLY', selection: 'Under 2.5 Goals', confidence: probs.under25 ?? null, logic: `Fallback by Poisson U2.5 (${probs.under25 ?? 'N/A'}%).` },
    { type: 'GOALS_ONLY', selection: 'Both Teams to Score', confidence: probs.btts ?? null, logic: `Fallback by Poisson BTTS (${probs.btts ?? 'N/A'}%).` },
  ].filter(x => x.confidence != null);

  const directionalEdge = p1?.edge !== 'NEUTRAL' ? p1.edge : (p4?.edge !== 'NEUTRAL' ? p4?.edge : p8?.edge);
  if (directionalEdge && directionalEdge !== 'NEUTRAL') {
    const team = directionalEdge === 'HOME' ? home : away;
    const conf = Math.max(55, Math.min(88, Math.round((overallScore || 50) * 0.9)));
    fallbackOptions.push({
      type: 'WINS_ONLY',
      selection: `${team} Win`,
      confidence: conf,
      logic: `Fallback directional lean from motivation/form (${directionalEdge}).`,
    });
  }

  if (fallbackOptions.length === 0) {
    const conf = Math.max(52, Math.min(75, Math.round(overallScore || 55)));
    return {
      type: 'GOALS_ONLY',
      selection: 'Over 1.5 Goals',
      confidence: conf,
      tier: tierFromConfidence(conf),
      tierName: TIERS[tierFromConfidence(conf)].name,
      logic: 'Fallback recommendation: limited signal, defaulting to the broadest goal line.',
    };
  }

  const best = fallbackOptions.sort((a, b) => b.confidence - a.confidence)[0];
  const tier = tierFromConfidence(best.confidence);
  return {
    ...best,
    tier,
    tierName: TIERS[tier].name,
  };
}

function recommendationEVSanity(recommendation, context = {}) {
  const { poisson, p1, p4, p8 } = context;
  const probs = poisson?.probabilities || {};
  const selection = String(recommendation.selection || '').toLowerCase();
  let penalty = 0;
  const reasons = [];

  const directionalVotes = [p1?.edge, p4?.edge, p8?.edge];
  const homeVotes = directionalVotes.filter(v => v === 'HOME').length;
  const awayVotes = directionalVotes.filter(v => v === 'AWAY').length;
  const directionalConflict = homeVotes > 0 && awayVotes > 0;

  if (recommendation.type === 'GOALS_ONLY') {
    if (selection.includes('over 3.5') && (probs.over35 ?? 0) < 34) {
      penalty += 8;
      reasons.push(`O3.5 model support only ${probs.over35 ?? 0}%`);
    }
    if (selection.includes('over 2.5') && (probs.over25 ?? 0) < 50) {
      penalty += 10;
      reasons.push(`O2.5 model support only ${probs.over25 ?? 0}%`);
    }
    if (selection.includes('under 2.5') && (probs.under25 ?? 0) < 54) {
      penalty += 10;
      reasons.push(`U2.5 model support only ${probs.under25 ?? 0}%`);
    }
    if (selection.includes('both teams to score') && (probs.btts ?? 0) < 55) {
      penalty += 8;
      reasons.push(`BTTS model support only ${probs.btts ?? 0}%`);
    }
  }

  if (recommendation.type === 'WINS_ONLY') {
    const drawProb = probs.draw ?? 0;
    if (drawProb >= 31) {
      penalty += 8;
      reasons.push(`Draw risk elevated at ${drawProb}%`);
    }
    if (directionalConflict) {
      penalty += 6;
      reasons.push('Motivation/form/xG directional conflict');
    }
    if (selection.includes('home') && awayVotes > homeVotes) {
      penalty += 8;
      reasons.push('Directional signals lean away');
    }
    if (selection.includes('away') && homeVotes > awayVotes) {
      penalty += 8;
      reasons.push('Directional signals lean home');
    }
  }

  return {
    penalty,
    evPass: penalty <= 6,
    reasons,
  };
}

function computeAnalysisQuality({ p1, p4, p8, p12, poisson, status, matchMinutes = 0, scalar = 1, paramCoverage = 1 }) {
  const homeVotes = [p1?.edge, p4?.edge, p8?.edge].filter(x => x === 'HOME').length;
  const awayVotes = [p1?.edge, p4?.edge, p8?.edge].filter(x => x === 'AWAY').length;
  const totalVotes = homeVotes + awayVotes;
  const contradiction = homeVotes > 0 && awayVotes > 0;

  let poissonEdge = 'NEUTRAL';
  if (poisson?.homeLambda != null && poisson?.awayLambda != null) {
    const diff = poisson.homeLambda - poisson.awayLambda;
    if (diff >= 0.18) poissonEdge = 'HOME';
    else if (diff <= -0.18) poissonEdge = 'AWAY';
  }

  const consensusWithPoisson = (
    poissonEdge === 'NEUTRAL' ||
    (poissonEdge === 'HOME' && homeVotes >= awayVotes) ||
    (poissonEdge === 'AWAY' && awayVotes >= homeVotes)
  );

  const directionalStrength = totalVotes > 0 ? Math.abs(homeVotes - awayVotes) / totalVotes : 0;
  const hasPoisson = poisson?.homeLambda != null && poisson?.awayLambda != null;
  const marketDivergence = Math.abs(Number(p12?.divergence || 0));

  let score = 62;
  score += Math.round(Math.max(0, Math.min(paramCoverage, 1)) * 16);
  score += Math.round(directionalStrength * 10);
  score += hasPoisson ? 5 : -8;
  score += consensusWithPoisson ? 4 : -6;
  score += contradiction ? -8 : 0;
  score += marketDivergence >= 0.12 ? -3 : 0; // Large model-vs-market disagreement increases uncertainty.
  score += Math.round((Math.max(0.75, Math.min(scalar, 1.1)) - 0.93) * 20);
  if (status !== 'NS' && matchMinutes < 12) score -= 4;
  score = Math.max(45, Math.min(score, 92));

  const confidenceMultiplier = Math.max(0.86, Math.min(1.08, 0.92 + (score - 60) / 100));

  return {
    score,
    confidenceMultiplier: +confidenceMultiplier.toFixed(3),
    contradiction,
    hasPoisson,
    directionalStrength: +directionalStrength.toFixed(2),
    paramCoverage: +Math.max(0, Math.min(paramCoverage, 1)).toFixed(2),
    poissonEdge,
    consensusWithPoisson,
  };
}

function recalibrateRecommendations(recommendations = [], analysisQuality) {
  if (!Array.isArray(recommendations) || recommendations.length === 0) return recommendations;
  return recommendations
    .map((r) => {
      let conf = Number(r.confidence || 50);
      conf *= analysisQuality?.confidenceMultiplier || 1;

      if (analysisQuality?.contradiction && r.type === 'WINS_ONLY') conf -= 6;
      if ((analysisQuality?.paramCoverage || 1) < 0.75) conf -= 4;
      if (!analysisQuality?.hasPoisson && (r.type === 'NEXT_GOAL' || r.type === 'SNIPER_WATCH')) conf -= 5;

      conf = Math.round(Math.max(52, Math.min(conf, 97)));
      const tier = tierFromConfidence(conf);
      return {
        ...r,
        confidence: conf,
        tier,
        tierName: TIERS[tier].name,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || a.tier - b.tier);
}

function applyRecommendationSanityChecks(recommendations = [], context = {}) {
  if (!Array.isArray(recommendations) || recommendations.length === 0) return recommendations;
  return recommendations
    .map((r) => {
      const ev = recommendationEVSanity(r, context);
      const adjustedConfidence = Math.max(50, Math.min(97, Math.round((r.confidence || 50) - ev.penalty)));
      const tier = tierFromConfidence(adjustedConfidence);
      return {
        ...r,
        confidence: adjustedConfidence,
        tier,
        tierName: TIERS[tier].name,
        evSanity: ev,
      };
    })
    .sort((a, b) => b.confidence - a.confidence || a.tier - b.tier);
}

function attachEvidenceToRecommendations(recommendations = [], analysisCtx = {}) {
  const {
    p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15,
    poisson,
    resolvedCompetitionContext,
    competitionModelProfile,
    overall,
    analysisQuality,
    status,
    matchMinutes,
    score,
  } = analysisCtx;

  const factors = [
    { key: 'p4_form', label: 'Form', score: p4?.score, note: p4?.assessment },
    { key: 'p1_motivation', label: 'Motivation', score: p1?.score, note: p1?.assessment },
    { key: 'p7_poisson', label: 'Poisson', score: p7?.score, note: p7?.assessment },
    { key: 'p15_crisis', label: 'Crisis', score: p15?.score, note: p15?.assessment },
    { key: 'p12_market', label: 'Market', score: p12?.score, note: p12?.assessment },
    { key: 'p13_context', label: 'Competition Context', score: p13?.score, note: p13?.assessment },
    { key: 'p2_starPower', label: 'Star Power', score: p2?.score, note: p2?.assessment },
    { key: 'p6_defensiveGap', label: 'Defensive Gap', score: p6?.score, note: p6?.assessment },
    { key: 'p8_xg', label: 'xG Edge', score: p8?.score, note: p8?.assessment },
    { key: 'p10_pace', label: 'Pace', score: p10?.score, note: p10?.assessment },
    { key: 'p11_homeAdv', label: 'Home Advantage', score: p11?.score, note: p11?.assessment },
    { key: 'p3_h2h', label: 'H2H', score: p3?.score, note: p3?.assessment },
    { key: 'p14_lifecycle', label: 'Lifecycle', score: p14?.score, note: p14?.assessment },
    { key: 'p5_timing', label: 'Timing', score: p5?.score, note: p5?.assessment },
    { key: 'p9_xga', label: 'Defensive Solidity', score: p9?.score, note: p9?.assessment },
  ].filter(x => x.score != null).sort((a, b) => b.score - a.score);

  const topFactors = factors.slice(0, 4).map(f => ({
    key: f.key,
    label: f.label,
    score: Math.round(f.score),
    note: String(f.note || '').slice(0, 120),
  }));

  return recommendations.map((r) => ({
    ...r,
    evidence: {
      overallScore: overall,
      competitionFamily: resolvedCompetitionContext?.family || 'UNKNOWN',
      competitionProfile: competitionModelProfile?.name || 'Default',
      liveState: { status, matchMinutes, score },
      analysisQuality,
      evSanity: r.evSanity || null,
      topFactors,
      poisson: {
        expectedGoals: poisson?.expectedTotalGoals ?? null,
        over25: poisson?.probabilities?.over25 ?? null,
        btts: poisson?.probabilities?.btts ?? null,
        likelyScore: poisson?.likelyScore?.score || null,
      },
    },
  }));
}

function computeWinCall({ home, away, p1, p4, poisson, overallScore, recommendations = [] }) {
  let homeVotes = 0;
  let awayVotes = 0;
  const reasons = [];

  if (p1?.edge === 'HOME') { homeVotes += 2; reasons.push('Motivation leans HOME'); }
  if (p1?.edge === 'AWAY') { awayVotes += 2; reasons.push('Motivation leans AWAY'); }
  if (p4?.edge === 'HOME') { homeVotes += 2; reasons.push('Form leans HOME'); }
  if (p4?.edge === 'AWAY') { awayVotes += 2; reasons.push('Form leans AWAY'); }

  const lambdaH = poisson?.homeLambda;
  const lambdaA = poisson?.awayLambda;
  const drawProb = poisson?.probabilities?.draw ?? null;
  if (lambdaH != null && lambdaA != null) {
    const d = lambdaH - lambdaA;
    if (d >= 0.18) { homeVotes += 1; reasons.push(`Poisson lambda edge HOME (${lambdaH} vs ${lambdaA})`); }
    else if (d <= -0.18) { awayVotes += 1; reasons.push(`Poisson lambda edge AWAY (${lambdaA} vs ${lambdaH})`); }
  }

  const topWin = recommendations.find(r => r.type === 'WINS_ONLY');
  if (topWin?.selection?.includes(home)) homeVotes += 2;
  if (topWin?.selection?.includes(away)) awayVotes += 2;

  const conflicting = homeVotes > 0 && awayVotes > 0;
  const voteGap = Math.abs(homeVotes - awayVotes);
  const lowConviction = (topWin?.confidence ?? overallScore ?? 50) < 62;
  const tightByModel =
    (drawProb != null && drawProb >= 30) ||
    (lambdaH != null && lambdaA != null && Math.abs(lambdaH - lambdaA) <= 0.15);

  if (conflicting || tightByModel || voteGap <= 1 || lowConviction) {
    return {
      outcome: 'UNDECIDED',
      selection: 'Wins (Undecided)',
      team: null,
      confidence: Math.max(45, Math.min(64, Math.round(topWin?.confidence ?? overallScore ?? 50))),
      rationale: reasons.length ? reasons.join('; ') : 'No clear directional edge across motivation, form and Poisson.',
    };
  }

  const team = homeVotes > awayVotes ? home : away;
  return {
    outcome: team === home ? 'HOME' : 'AWAY',
    selection: `${team} Win`,
    team,
    confidence: Math.min(96, Math.max(55, Math.round(topWin?.confidence ?? overallScore ?? 50))),
    rationale: reasons.length ? reasons.join('; ') : 'Directional edge confirmed.',
  };
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

// ─── P11 — HOME ADVANTAGE SIGNAL (replaces dead timezone placeholder) ─────────────
function scoreHomeAdvantage(homePossession = 50, homeShotsPerGame = 11, awayShotsPerGame = 11, venue = null, status = 'NS') {
  let score = 55; // Baseline: ~5% home win rate boost (literature consensus)
  if (status !== 'NS' && homePossession > 0) {
    // Live match: possession dominance is a real pressure signal
    const possDiff = homePossession - 50;
    score += Math.round(possDiff * 0.6);
  }
  if (homeShotsPerGame > 0 && awayShotsPerGame > 0) {
    const shotRatio = homeShotsPerGame / (homeShotsPerGame + awayShotsPerGame);
    if (shotRatio > 0.58) score += 8;
    else if (shotRatio < 0.40) score -= 10;
  }
  return {
    score: Math.min(Math.max(Math.round(score), 20), 90),
    assessment: status !== 'NS'
      ? `Live home advantage. Possession: ${homePossession}%. SoT ratio: ${homeShotsPerGame}v${awayShotsPerGame}.`
      : venue ? `Home venue: ${venue}. Standard home advantage applied.` : 'Standard home advantage applied.',
  };
}

// ─── P12 — MARKET DIVERGENCE (replaces raw overround scoring) ──────────────
// Compares V9 Poisson-derived Over 2.5 probability vs bookmaker's implied probability.
// Positive divergence = model sees more goals than market prices = Over 2.5 value.
// Negative divergence = market prices more goals = Under 2.5 value.
function scoreMarketSignal(odds = null, poissonProbs = null) {
  if (!odds || (!odds.over25 && !odds.home && !odds.homeWin)) {
    return { score: 50, assessment: 'No market odds — cannot compute divergence. Neutral signal applied.' };
  }
  // Primary: Over 2.5 model vs market divergence
  if (odds.over25 && poissonProbs) {
    const rawImplied = 1 / parseFloat(odds.over25);
    const modelProb  = (poissonProbs.over25 || 50) / 100;
    const divergence = modelProb - rawImplied;
    const score = Math.min(Math.max(Math.round(50 + divergence * 80), 20), 80);
    return {
      score, divergence: +divergence.toFixed(3),
      mktImplied: +rawImplied.toFixed(3), modelProb: +modelProb.toFixed(3),
      assessment: Math.abs(divergence) < 0.06
        ? `Model and market closely agree on Over 2.5 (${Math.round(modelProb*100)}% model, ${Math.round(rawImplied*100)}% market).`
        : divergence > 0
          ? `Model sees +${Math.round(divergence*100)}pp more goals than market — Over 2.5 may offer value.`
          : `Market prices ${Math.round(-divergence*100)}pp more goals than model — Under 2.5 may offer value.`,
    };
  }
  // Fallback: overround as market-quality signal when O2.5 odds absent
  const homeOdds = parseFloat(odds.home || odds.homeWin || 2.0);
  const drawOdds = parseFloat(odds.draw || 3.5);
  const awayOdds = parseFloat(odds.away || odds.awayWin || 3.5);
  const overround = (1 / homeOdds) + (1 / drawOdds) + (1 / awayOdds);
  const margin = Math.round((overround - 1) * 100);
  return {
    score: Math.max(Math.round(70 - margin * 2), 25), margin,
    assessment: `No O2.5 odds. Win market overround: ${margin}%. ${margin <= 8 ? 'Competitive pricing.' : 'High margin — market less efficient.'}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MASTER ANALYSIS FUNCTION — analyzeV9()
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Run full Agent 47 V9 analysis on a match.
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
 * @returns {Object} Full V9 analysis
 */
export function analyzeV9(matchData = {}) {
  // Deploy marker: keep backend service change detectable for Railway rebuild.
  const {
    home = 'Home Team', away = 'Away Team', league = 'Unknown', leagueId = 0, matchType = 'League',
    country = '', round = null, isKnockout = false, notes = null,
    gameWeek = 30, totalGW = 38, totalTeams = 20,
    homePosition = 10, awayPosition = 10, homePoints = 40, awayPoints = 40,
    status = 'NS', matchMinutes = 0, score = '0-0',
    homeSquadIntegrity = 90, awaySquadIntegrity = 90,
    homeKeyAbsences = [], awayKeyAbsences = [],
    homeForm = null, awayForm = null,
    homeGoalsAvgFor = null, awayGoalsAvgFor = null,
    homeGoalsAvgAgainst = null, awayGoalsAvgAgainst = null,
    homeXgAvg = null, awayXgAvg = null,
    homeXgaAvg = null, awayXgaAvg = null,
    h2hHistory = [],
    homeLateGoalPct = 0.20, awayLateGoalPct = 0.20,
    homeConversionPct = 10, awayConversionPct = 10,
    homeShotsPerGame = 12, awayShotsPerGame = 10,
    earlyGoalScored = false, earlyGoalMinute = null,
    homeTacticalHighLine = false, awayCounterThreat = false,
    homePossession = 50,
    homeCBInjured = false, awayGKError = false,
    referee = null, venue = null,
    // P15 Crisis/Drought Mode inputs
    homeGoalDrought = 0, awayGoalDrought = 0,
    homeRecentLosses = 0, awayRecentLosses = 0,
    homeRecentOpposition = null, awayRecentOpposition = null,
    homeCoach = {}, awayCoach = {},
    // xG trend (positive = improving, negative = declining, null = unknown)
    homeXgTrend = null, awayXgTrend = null,
    // league scalar override (auto-resolved from leagueId if not provided)
    leagueScalar = null,
    competitionContext = null,
  } = matchData;

  const resolvedCompetitionContext = competitionContext || detectCompetitionContext({
    leagueId,
    league,
    country,
    matchType,
    round,
    isKnockout,
    notes,
  });
  const competitionModelProfile = getCompetitionModelProfile(resolvedCompetitionContext);
  const activeWeights = applyWeightProfile(W, competitionModelProfile.weightBias);

  // ── Run all 15 parameters ───────────────────────────────────────────
  const p1  = scoreMotivation({ homePosition, awayPosition, homePoints, awayPoints, totalTeams, gameWeek, totalGW });
  const p2  = scoreStarPower(homeSquadIntegrity, awaySquadIntegrity, homeKeyAbsences, awayKeyAbsences);
  const p3  = scoreH2H(h2hHistory);
  const p4  = scoreForm(homeForm, awayForm, homeXgAvg, awayXgAvg, homeGoalsAvgFor, awayGoalsAvgFor, homeXgTrend, awayXgTrend);
  const p5  = scoreTiming(homeLateGoalPct, awayLateGoalPct);
  const p6  = scoreDefensiveGap(homeGoalsAvgAgainst, awayGoalsAvgAgainst, getLeagueGoalsAvg(leagueId), homeCBInjured, awayGKError);
  const poi = runPoisson(homeXgAvg, awayXgAvg, homeXgaAvg, awayXgaAvg, leagueId);

  // ── Live match: replace pre-match "Most likely: X-Y" with projected FINAL score ──
  // The Poisson lambdas are full-game averages. For a live match we scale them to
  // remaining time and add current score → real projected final score.
  const LIVE_STATUSES_V9 = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT']);
  if (LIVE_STATUSES_V9.has(status) && poi.homeLambda != null && poi.awayLambda != null) {
    const [hG, aG] = (score || '0-0').split('-').map(n => parseInt(n, 10) || 0);
    const effMins  = (status === 'HT' && matchMinutes < 45) ? 45 : matchMinutes;
    const minsLeft = Math.max(90 - effMins, 0);
    const remFrac  = minsLeft / 90;
    const lH_rem   = poi.homeLambda * remFrac;
    const lA_rem   = poi.awayLambda * remFrac;
    const addl     = likelyScore(lH_rem, lA_rem);
    const addH     = parseInt(addl.score.split('-')[0]) || 0;
    const addA     = parseInt(addl.score.split('-')[1]) || 0;
    const probMore = Math.round((1 - Math.exp(-(lH_rem + lA_rem))) * 100);
    poi.liveProjectedFinalScore = {
      score: `${hG + addH}-${aG + addA}`,
      remainingLambda: { home: +lH_rem.toFixed(2), away: +lA_rem.toFixed(2) },
      probAnotherGoal: probMore,
    };
    // Replace the stale pre-match assessment with live-context facts
    poi.assessment = `${effMins}' played · ${minsLeft}' remaining. Projected final: ${hG + addH}-${aG + addA}. P(another goal): ${probMore}%.`;
  }

  const p7  = { score: poi.probabilities.over25, assessment: poi.assessment }; // full signal, no suppression
  const p8  = scoreXGDifferential(homeXgAvg, awayXgAvg);
  const p9  = scoreDefensiveSolidity(homeXgaAvg, awayXgaAvg, getLeagueGoalsAvg(leagueId));
  const p10 = scorePace(homeConversionPct, awayConversionPct, homeShotsPerGame, awayShotsPerGame);
  const p11 = scoreHomeAdvantage(homePossession, homeShotsPerGame, awayShotsPerGame, venue, status);
  const p12 = scoreMarketSignal(matchData.odds || null, poi.probabilities);
  const p13 = scoreCompetitiveContext(leagueId, matchType);
  const p14 = scoreLifecycle(gameWeek, totalGW);
  const p15 = scoreCrisisMode({ homeGoalDrought, awayGoalDrought, homeRecentLosses, awayRecentLosses, homeCoach, awayCoach });

  if (homeRecentOpposition || awayRecentOpposition) {
    const formNotes = [];
    if (homeRecentOpposition?.summary) formNotes.push(`${home}: ${homeRecentOpposition.summary}`);
    if (awayRecentOpposition?.summary) formNotes.push(`${away}: ${awayRecentOpposition.summary}`);
    p4.assessment = [p4.assessment, ...formNotes].filter(Boolean).join(' ');
    p4.home = { ...p4.home, recentOpposition: homeRecentOpposition };
    p4.away = { ...p4.away, recentOpposition: awayRecentOpposition };
  }

  // ── Weighted composite score (V9: 15 parameters + league scalar) ──────────
  // Parameters with no data (null score) are excluded; remaining weights are
  // rescaled proportionally so the composite always sums to 100%.
  const baseScalar = leagueScalar ?? LEAGUE_SCALARS[leagueId] ?? 0.93;
  const scalar = Math.max(0.65, Math.min(1.1, baseScalar * (competitionModelProfile.scalarMultiplier ?? 1)));
  const paramScores = [
    [p1.score,  activeWeights.p1_motivation],
    [p2.score,  activeWeights.p2_starPower],
    [p3.score,  activeWeights.p3_h2h],
    [p4.score,  activeWeights.p4_form],
    [p5.score,  activeWeights.p5_scoringTiming],
    [p6.score,  activeWeights.p6_defensiveGap],
    [p7.score,  activeWeights.p7_poisson],
    [p8.score,  activeWeights.p8_xg],
    [p9.score,  activeWeights.p9_xga],
    [p10.score, activeWeights.p10_pace],
    [p11.score, activeWeights.p11_homeAdvantage],
    [p12.score, activeWeights.p12_market],
    [p13.score, activeWeights.p13_squad],
    [p14.score, activeWeights.p14_lifecycle],
    [p15.score, activeWeights.p15_crisis],
  ].filter(([s]) => s != null);
  const totalWeight = paramScores.reduce((acc, [, w]) => acc + w, 0);
  const rawScore = totalWeight > 0
    ? paramScores.reduce((acc, [s, w]) => acc + s * (w / totalWeight), 0)
    : 50;
  const overall = Math.round(Math.max(0, Math.min(rawScore * scalar + (competitionModelProfile.overallAdjustment ?? 0), 100)));
  const analysisQuality = computeAnalysisQuality({
    p1,
    p4,
    p8,
    p12,
    poisson: poi,
    status,
    matchMinutes,
    scalar,
    paramCoverage: paramScores.length / 15,
  });

  // ── Chaos variables ────────────────────────────────────────────────────────
  const chaos = evaluateChaos({ motivation: p1, form: p4, matchMinutes, earlyGoalScored, earlyGoalMinute,
                                 homeTacticalHighLine, awayCounterThreat, homePossession });

  // ── Recommendations ────────────────────────────────────────────────────────
  let recommendations = generateRecommendations(overall, poi, p1, p4, chaos, matchData);
  if (!Array.isArray(recommendations) || recommendations.length === 0) {
    recommendations = [fallbackRecommendation({ home, away, overallScore: overall, poisson: poi, p1, p4, p8, analysisQuality })];
  }
  recommendations = recalibrateRecommendations(recommendations, analysisQuality);
  recommendations = applyRecommendationSanityChecks(recommendations, { poisson: poi, p1, p4, p8 });
  recommendations = attachEvidenceToRecommendations(recommendations, {
    p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15,
    poisson: poi,
    resolvedCompetitionContext,
    competitionModelProfile,
    overall,
    analysisQuality,
    status,
    matchMinutes,
    score,
  });
  const winCall = computeWinCall({ home, away, p1, p4, poisson: poi, overallScore: overall, recommendations });

  // ── Bookie edge detection ──────────────────────────────────────────────────
  const bookieEdges = detectBookieEdges(p1, p2, p4, chaos);

  return {
    match:   {
      home,
      away,
      league,
      leagueId,
      status,
      matchMinutes,
      score,
      referee,
      venue,
      gameWeek,
      totalGW,
      competitionContext: resolvedCompetitionContext,
    },
    recommendations,
    parameters: { p1_motivation: p1, p2_starPower: p2, p3_h2h: p3, p4_form: p4,
                  p5_scoringTiming: p5, p6_defensiveGap: p6, p7_poisson: p7,
                  p8_xg: p8, p9_xga: p9, p10_pace: p10,
                  p11_homeAdvantage: p11, p12_market: p12, p13_squad: p13, p14_lifecycle: p14,
                  p15_crisis: p15 },
    poisson: poi,
    chaosVariables: chaos,
    overallScore: overall,
    winCall,
    dataContext: {
      homeRecentOpposition,
      awayRecentOpposition,
    },
    modelRouting: {
      profile: competitionModelProfile.name,
      context: resolvedCompetitionContext,
      overallAdjustment: competitionModelProfile.overallAdjustment ?? 0,
      scalarMultiplier: competitionModelProfile.scalarMultiplier ?? 1,
    },
    leagueScalarApplied: scalar,
    analysisQuality,
    bookieEdges,
    analysisVersion: 'V9-Calibrated',
    analysisTimestamp: new Date().toISOString(),
  };
}

export default analyzeV9;
