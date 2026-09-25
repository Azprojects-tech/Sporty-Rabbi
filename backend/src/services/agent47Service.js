import { decideMarkets, summarizeMarketDecisions } from './marketDecisionService.js';
import { forecastContract } from '../../../shared/forecastContract.js';
import { FORECAST_VERSION, LIVE_STATUSES } from '../../../shared/forecastMath.js';
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
import {
  finiteNumberOrNull,
  recommendationToMarketKey,
} from '../../../shared/marketKeys.js';
import { DECISION } from '../../../shared/decisionStates.js';
import { buildPredictionCore } from './predictionEngineV10.js';

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

// ─── FORM PARSER ──────────────────────────────────────────────────────────────
/** Accepts "W-W-L-D-W" string or ['W','W','L','D','W'] array */
function parseForm(raw) {
  if (!raw) return { wins: 0, draws: 0, losses: 0, total: 0, winRate: 0, points: 0, formStr: 'Unavailable' };
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
function scoreMotivation({ homePosition, awayPosition, totalTeams }) {
  if (![homePosition, awayPosition, totalTeams].every(v => typeof v === 'number' && Number.isInteger(v) && v > 0)
    || totalTeams < 2 || homePosition > totalTeams || awayPosition > totalTeams)
    return { score: null, available: false, evidenceStatus: 'MISSING', home: {}, away: {}, mwvIndex: 0, assessment: 'Verified table position and league size unavailable.' };
  const h = 100 * (totalTeams - homePosition) / (totalTeams - 1);
  const a = 100 * (totalTeams - awayPosition) / (totalTeams - 1);
  return { score: Math.round((h+a)/2), home: { rank: homePosition }, away: { rank: awayPosition },
    gap: Math.abs(h-a), mwvIndex: 0, edge: h > a+20 ? 'HOME' : a > h+20 ? 'AWAY' : 'NEUTRAL',
    assessment: `Table position: home ${homePosition}/${totalTeams}, away ${awayPosition}/${totalTeams}.` };
}

// P2 — STAR POWER
function scoreStarPower(homeIntegrity = null, awayIntegrity = null, homeAbsences = [], awayAbsences = []) {
  if (homeIntegrity == null || awayIntegrity == null) {
    return { score: null, available: false, evidenceStatus: 'MISSING', homeEffective: null, awayEffective: null, edge: 'NEUTRAL', assessment: 'Required inputs unavailable — squad integrity missing.' };
  }
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
  history = history.filter(m => [m.homeGoals, m.awayGoals].every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0));
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
  if (!homeFormStr || !awayFormStr) {
    return { score: null, home: { formStr: null, winRate: 0 }, away: { formStr: null, winRate: 0 }, edge: 'NEUTRAL', assessment: 'No form data available.' };
  }
  const hF = parseForm(homeFormStr);
  const aF = parseForm(awayFormStr);

    // V9 Tighter Coiled Spring: only fires if xG is NOT also collapsing.
  // If xG trend is negative (declining), the spring has no tension — no boost.
  const hCoil = homeXgAvg > 0 && homeGoalsAvg > 0 && (homeXgAvg / homeGoalsAvg) > 1.35
    && (homeXgTrend != null && homeXgTrend >= 0);
  const aCoil = awayXgAvg  > 0 && awayGoalsAvg  > 0 && (awayXgAvg  / awayGoalsAvg)  > 1.35
    && (awayXgTrend != null && awayXgTrend >= 0);

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
function scoreTiming(homeLateGoalPct = null, awayLateGoalPct = null) {
  if (homeLateGoalPct == null || awayLateGoalPct == null) {
    return { score: null, available: false, evidenceStatus: 'MISSING', lateGoalRisk: null, assessment: 'Scoring-timing evidence unavailable.' };
  }
  const avg = (homeLateGoalPct + awayLateGoalPct) / 2;
  const ratio = avg / 0.22;  // relative to league baseline
  const assessment =
    ratio > 1.4 ? `⚡ HIGH late-goal risk — ${Math.round(avg * 100)}% of goals in 76-90' window` :
    ratio > 1.1 ? `Elevated late-goal tendency — watch 76' mark` :
    `Standard timing profile`;
  return { score: Math.min(100, Math.max(0, Math.round(avg * 220))), lateGoalRisk: +ratio.toFixed(2), homeLateGoalPct, awayLateGoalPct, assessment };
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

// P7 — handled via Poisson (shared prediction core, score injected below)

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
function scorePace(homeConv = null, awayConv = null, homeShotsPerGame = null, awayShotsPerGame = null) {
  if ([homeShotsPerGame, awayShotsPerGame, homeConv, awayConv].some(v => v == null)) {
    return { score: null, available: false, evidenceStatus: 'MISSING', edge: 'NEUTRAL', assessment: 'Required inputs unavailable — shots data missing.' };
  }
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
function scoreLifecycle(gameWeek = null, totalGW = null) {
  if (gameWeek == null || totalGW == null || totalGW <= 0) {
    return { score: null, available: false, evidenceStatus: 'MISSING', edge: 'NEUTRAL', assessment: 'Required inputs unavailable — gameWeek/totalGW missing.' };
  }
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
  homeGoalDrought = null, awayGoalDrought = null,
  homeRecentLosses = null, awayRecentLosses = null,
  homeCoach = {}, awayCoach = {},
}) {
  if ([homeGoalDrought, awayGoalDrought, homeRecentLosses, awayRecentLosses].some(v => v == null))
    return { score: null, flags: [], assessment: 'Recent scoreless and losing streaks unavailable.' };
  let homeScore = 70; // historical indicator baseline
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

  // Coach chronology and observed results are shown in the evidence desk.
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

// ─── CHAOS VARIABLES ──────────────────────────────────────────────────────────
function evaluateChaos() {
  return { mwvIndex: null, mwvLabel: 'UNAVAILABLE', earlyGoalActive: null, earlyGoalBoost: 0,
    bivariateDependency: null, psgTrapWarning: null, highLineRisk: null,
    summary: 'Open the evidence cards for verified match events and context.' };
}

// ─── TIER RECOMMENDATIONS ─────────────────────────────────────────────────────
function generateRecommendations(overallScore, poisson, p1, p4, chaos, matchData) {
  const p = poisson.marketProbabilities || {};
  const live = LIVE_STATUSES.has(String(matchData.status || '').toUpperCase());
  if (live && !poisson.live?.available) return [];
  const recs = [];
  const add = (marketKey, type, selection, threshold) => {
    const probability01 = p[marketKey];
    if (!Number.isFinite(probability01) || probability01 < threshold || probability01 >= 1 - 1e-12) return;
    const confidence = +(probability01 * 100).toFixed(1);
    const tier = tierFromConfidence(confidence);
    recs.push({ marketKey, type, selection, probability01, modelProbability: probability01 * 100,
      confidence, tier, tierName: TIERS[tier].name, marketPeriod: 'REGULATION',
      logic: `${selection}: ${confidence}% probability.${live ? ` ${poisson.live.minutesRemaining}' regulation remaining; score ${matchData.score}.` : ` ${poisson.expectedTotalGoals} expected goals.`}` });
  };
  add('home_win', 'WINS_ONLY', `${matchData.home} Win`, .58);
  add('away_win', 'WINS_ONLY', `${matchData.away} Win`, .58);
  if (live) {
    for (const line of ['05','15','25','35','45']) add(`over${line}`, 'GOALS_ONLY', `Over ${line[0]}.${line[1]} Goals`, .35);
    add('under25', 'GOALS_ONLY', 'Under 2.5 Goals', .60);
    add('btts', 'GOALS_ONLY', 'Both Teams to Score', .45);
    add('next_goal_home', 'NEXT_GOAL', `${matchData.home} Next Goal`, .30);
    add('next_goal_away', 'NEXT_GOAL', `${matchData.away} Next Goal`, .30);
  } else {
    add('over25', 'GOALS_ONLY', 'Over 2.5 Goals', .52);
    add('under25', 'GOALS_ONLY', 'Under 2.5 Goals', .60);
    if ((p.over25 ?? 0) < .75) add('over15', 'GOALS_ONLY', 'Over 1.5 Goals', .75);
    add('btts', 'GOALS_ONLY', 'Both Teams to Score', .62);
  }
  return recs.sort((a,b) => b.probability01 - a.probability01);
}

function tierFromConfidence(conf = 50) {
  return conf >= 85 ? 1 : conf >= 72 ? 2 : conf >= 62 ? 3 : 4;
}




function fallbackRecommendation() {
  return { type:'NO_BET', selection:'No qualifying selection', confidence:null,
    tier:4, tierName:TIERS[4].name, logic:'No market meets the evidence and probability criteria.' };
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

function computeWinCall({ home, away, poisson, recommendations = [] }) {
  const p = poisson?.marketProbabilities || {};
  const outcome = (p.home_win ?? 0) >= (p.away_win ?? 0) ? 'HOME' : 'AWAY';
  const probability01 = outcome === 'HOME' ? p.home_win : p.away_win;
  if (!Number.isFinite(probability01) || probability01 < .58) return {
    outcome: 'UNDECIDED', selection: 'Wins (Undecided)', team: null, confidence: null,
    probability01: null, modelProbability: null, rationale: 'No win selection meets the probability threshold.',
  };
  const team = outcome === 'HOME' ? home : away;
  const rec = recommendations.find(r => r.marketKey === (outcome === 'HOME' ? 'home_win' : 'away_win'));
  return { outcome, selection: `${team} Win`, team, probability01, modelProbability: probability01 * 100,
    confidence: +(probability01 * 100).toFixed(1), decisionState: rec?.decisionState || (recommendations.some(r => r.type === 'NO_BET') ? 'NO_BET' : 'NEEDS_PRICE'),
    rationale: `Win probability from the shared regulation score distribution.` };
}

// ─── BOOKIE EDGE DETECTOR ─────────────────────────────────────────────────────

function buildDecisionMetrics({ overallScore, winCall, poisson, recommendations = [], analysisQuality = null }) {
  const probs = poisson?.probabilities || {};
  const homeWin = finiteNumberOrNull(probs.homeWin);
  const draw = finiteNumberOrNull(probs.draw);
  const awayWin = finiteNumberOrNull(probs.awayWin);
  const oneXtwoSum = homeWin != null && draw != null && awayWin != null
    ? homeWin + draw + awayWin
    : null;
  const has1x2 = oneXtwoSum != null && oneXtwoSum >= 99 && oneXtwoSum <= 101;

  let selectedOutcomeProbability = null;
  if (has1x2) {
    if (winCall?.outcome === 'HOME') selectedOutcomeProbability = homeWin;
    else if (winCall?.outcome === 'AWAY') selectedOutcomeProbability = awayWin;
    else selectedOutcomeProbability = Math.max(homeWin, draw, awayWin);
  }

  const topRec = Array.isArray(recommendations) ? recommendations[0] : null;
  const topMarket = topRec?.marketKey || recommendationToMarketKey(topRec);
  const topProbability = topMarket ? finiteNumberOrNull(topRec?.modelProbability) : null;
  const qualityScore = finiteNumberOrNull(analysisQuality?.score);
  const paramCoverage = finiteNumberOrNull(analysisQuality?.paramCoverage);
  const hasPoissonSignal = Boolean(analysisQuality?.hasPoisson);
  const hasContradiction = Boolean(analysisQuality?.contradiction);

  const dataCompletenessScore = paramCoverage != null
    ? Math.max(0, Math.min(100, Math.round(paramCoverage * 100)))
    : null;
  const dataCompletenessLabel = dataCompletenessScore == null
    ? 'Unknown'
    : dataCompletenessScore >= 80
      ? 'High'
      : dataCompletenessScore >= 60
        ? 'Medium'
        : 'Low';

  // Compatibility field now mirrors evidence quality; never mix it with probability.
  const recommendationConfidence = qualityScore;

  const recommendationConfidenceLabel = recommendationConfidence == null
    ? 'Unknown'
    : recommendationConfidence >= 75
      ? 'Strong'
      : recommendationConfidence >= 60
        ? 'Moderate'
        : 'Weak';

  let decisionStatus = 'INSUFFICIENT_DATA';
  let decisionReason = 'No executable recommendation.';
  const mappedDecisionState = String(topRec?.decisionState || '').toUpperCase();

  if (dataCompletenessScore != null && dataCompletenessScore < 50) {
    decisionStatus = 'INSUFFICIENT_DATA';
    decisionReason = `Data completeness is low (${dataCompletenessScore}%).`;
  } else if (mappedDecisionState === DECISION.BET) {
    decisionStatus = 'PLAY';
    decisionReason = 'Value checks passed for the selected market.';
  } else if (mappedDecisionState === DECISION.NEEDS_PRICE) {
    decisionStatus = 'WATCH';
    decisionReason = 'Model setup is promising, but bookmaker price is missing.';
  } else if (mappedDecisionState === DECISION.WATCH_LIVE) {
    decisionStatus = 'WATCH';
    decisionReason = 'Wait for stronger live confirmation before execution.';
  } else if (mappedDecisionState === DECISION.NO_BET) {
    decisionStatus = 'NO_PLAY';
    decisionReason = 'No positive execution edge under current constraints.';
  }

  return {
    modelProbability: {
      value: topProbability,
      market: topMarket,
      selection: topRec?.selection || null,
      available: topProbability != null,
      meaning: 'Estimated win probability for the currently selected market recommendation.',
    },
    dataCompleteness: {
      score: dataCompletenessScore,
      label: dataCompletenessLabel,
      paramCoverage,
      hasPoisson: hasPoissonSignal,
      contradiction: hasContradiction,
      meaning: 'How much required evidence is available and coherent for this match analysis.',
    },
    recommendationConfidence: {
      score: recommendationConfidence,
      label: recommendationConfidenceLabel,
      components: {
        recommendationProbability: topProbability,
        qualityScore,
      },
      meaning: 'Evidence quality score. Market probability is shown separately.',
    },
    decisionStatus: {
      status: decisionStatus,
      mappedFrom: mappedDecisionState || null,
      reason: decisionReason,
      meaning: 'Operational decision state for this recommendation: PLAY, WATCH, NO_PLAY, or INSUFFICIENT_DATA.',
    },
    signalStrength: {
      score: overallScore,
      qualityScore: analysisQuality?.score ?? null,
      topRecommendationConfidence: recommendations?.[0]?.confidence ?? null,
      meaning: 'How strong and coherent the model signal is based on data quality and parameter agreement.',
    },
    outcomeProbabilities: {
      homeWin,
      draw,
      awayWin,
      selectedOutcomeProbability,
      available: has1x2,
      meaning: 'Estimated match outcome chances (1X2) from the Poisson layer. This is not model confidence.',
    },
  };
}


// ─── P11 — HOME ADVANTAGE SIGNAL (replaces dead timezone placeholder) ─────────────
function scoreHomeAdvantage(homePossession = null, homeShotsPerGame = null, awayShotsPerGame = null, venue = null, status = 'NS') {
  // Structural home advantage is already represented as an explicit prior in V10.1.
  // This legacy parameter only scores OBSERVED evidence; it must not turn a prior into data.
  const hasShots = homeShotsPerGame != null && awayShotsPerGame != null;
  const hasLivePossession = status !== 'NS' && homePossession != null;

  if (!hasShots && !hasLivePossession) {
    return {
      score: null,
      available: false,
      evidenceStatus: 'PRIOR_ONLY',
      prior: 55,
      assessment: venue
        ? `Home venue prior applies in V10.1 core (${venue}); no additional observed home-advantage evidence.`
        : 'Home advantage is an explicit V10.1 prior; no observed home-advantage evidence available.',
    };
  }

  let score = 55;
  if (hasLivePossession) {
    score += Math.round((homePossession - 50) * 0.6);
  }
  if (hasShots && homeShotsPerGame + awayShotsPerGame > 0) {
    const shotRatio = homeShotsPerGame / (homeShotsPerGame + awayShotsPerGame);
    if (shotRatio > 0.58) score += 8;
    else if (shotRatio < 0.40) score -= 10;
  }
  return {
    score: Math.min(Math.max(Math.round(score), 20), 90),
    available: true,
    evidenceStatus: 'OBSERVED',
    assessment: `Observed home-advantage evidence. Possession: ${homePossession ?? 'Unavailable'}. Shots: ${homeShotsPerGame ?? '?'}v${awayShotsPerGame ?? '?'}.`,
  };
}

// ─── P12 — MARKET DIVERGENCE (replaces raw overround scoring) ──────────────
// Compares V9 Poisson-derived Over 2.5 probability vs bookmaker's implied probability.
// Positive divergence = model sees more goals than market prices = Over 2.5 value.
// Negative divergence = market prices more goals = Under 2.5 value.
function scoreMarketSignal(odds = null, poissonProbs = null) {
  if (!odds || (!odds.over25 && !odds.home && !odds.homeWin)) {
    return { score: null, available: false, evidenceStatus: 'MISSING', assessment: 'No market odds — market divergence not scored.' };
  }
  // Primary: Over 2.5 model vs market divergence
  if (odds.over25 && poissonProbs) {
    const rawImplied = 1 / parseFloat(odds.over25);
    const modelProb  = poissonProbs.over25 == null ? null : poissonProbs.over25 / 100;
    if (modelProb == null) return { score: null, assessment: 'Model probability unavailable.' };
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
  // 1X2 overround is only valid when all three actual prices are supplied.
  const homeOdds = parseFloat(odds.home ?? odds.homeWin);
  const drawOdds = parseFloat(odds.draw);
  const awayOdds = parseFloat(odds.away ?? odds.awayWin);
  if (![homeOdds, drawOdds, awayOdds].every((v) => Number.isFinite(v) && v > 1)) {
    return { score: null, available: false, evidenceStatus: 'MISSING', assessment: 'Incomplete market prices — market divergence not scored.' };
  }
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
    gameWeek = null, totalGW = null, totalTeams = null,
    homePosition = null, awayPosition = null, homePoints = null, awayPoints = null,
    status = 'NS', matchMinutes = 0, score = '0-0',
    homeSquadIntegrity = null, awaySquadIntegrity = null,
    homeKeyAbsences = [], awayKeyAbsences = [],
    homeForm = null, awayForm = null,
    homeGoalsAvgFor = null, awayGoalsAvgFor = null,
    homeGoalsAvgAgainst = null, awayGoalsAvgAgainst = null,
    homeXgAvg = null, awayXgAvg = null,
    homeXgaAvg = null, awayXgaAvg = null,
    h2hHistory = [],
    homeLateGoalPct = null, awayLateGoalPct = null,
    homeConversionPct = null, awayConversionPct = null,
    homeShotsPerGame = null, awayShotsPerGame = null,
    earlyGoalScored = false, earlyGoalMinute = null,
    homeTacticalHighLine = false, awayCounterThreat = false,
    homePossession = null,
    homeCBInjured = false, awayGKError = false,
    referee = null, venue = null,
    // P15 Crisis/Drought Mode inputs
    homeGoalDrought = null, awayGoalDrought = null,
    homeRecentLosses = null, awayRecentLosses = null,
    homeRecentOpposition = null, awayRecentOpposition = null,
    homeCoach = {}, awayCoach = {},
    // xG trend (positive = improving, negative = declining, null = unknown)
    homeXgTrend = null, awayXgTrend = null,
    // league scalar override (auto-resolved from leagueId if not provided)
    leagueScalar = null,
    competitionContext = null,
    dataSourceStatus = null,
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
  const predictionCore = buildPredictionCore(matchData, getLeagueGoalsAvg(leagueId));
  const poi = predictionCore.poisson;

  // The prediction core owns the live score distribution and period clock.

  const p7  = { score: poi.probabilities.over25, assessment: poi.assessment }; // full signal, no suppression
  const p8  = scoreXGDifferential(homeXgAvg, awayXgAvg);
  const p9  = scoreDefensiveSolidity(homeXgaAvg, awayXgaAvg, getLeagueGoalsAvg(leagueId));
  const p10 = scorePace(homeConversionPct, awayConversionPct, homeShotsPerGame, awayShotsPerGame);
  const p11 = scoreHomeAdvantage(homePossession, homeShotsPerGame, awayShotsPerGame, venue, status);
  const p12 = scoreMarketSignal(matchData.odds || null, poi.probabilities);
  const p13 = scoreCompetitiveContext(leagueId, matchType);
  const p14 = scoreLifecycle(gameWeek, totalGW);
  const p15 = scoreCrisisMode({ homeGoalDrought, awayGoalDrought, homeRecentLosses, awayRecentLosses, homeCoach, awayCoach });

  // These are bounded context indicators; the probability engine remains separate.
  for (const parameter of [p1,p2,p3,p4,p5,p6,p7,p8,p9,p10,p11,p12,p13,p14,p15]) {
    if (parameter.score != null) {
      parameter.rawScore = parameter.score;
      parameter.score = Number.isFinite(parameter.score) ? Math.max(0, Math.min(100, parameter.score)) : null;
    }
  }
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
  const legacyOverallScore = Math.round(Math.max(0, Math.min(rawScore * scalar + (competitionModelProfile.overallAdjustment ?? 0), 100)));
  const overall = predictionCore.signalScore ?? legacyOverallScore;

  const legacyQuality = computeAnalysisQuality({
    p1,
    p4,
    p8,
    p12,
    poisson: poi,
    status,
    matchMinutes,
    scalar,
    paramCoverage: predictionCore.dataQuality?.coreCoverage ?? 0,
  });
  const analysisQuality = {
    ...legacyQuality,
    score: predictionCore.reliability,
    paramCoverage: predictionCore.dataQuality?.coreCoverage ?? 0,
    coreReady: predictionCore.coreReady,
    modelBasis: predictionCore.modelBasis,
    optionalXgAvailable: predictionCore.dataQuality?.optionalXgAvailable ?? false,
    homeSampleSize: predictionCore.dataQuality?.homeSampleSize ?? null,
    awaySampleSize: predictionCore.dataQuality?.awaySampleSize ?? null,
  };

  // ── Chaos variables ────────────────────────────────────────────────────────
  const chaos = evaluateChaos({ motivation: p1, form: p4, matchMinutes, earlyGoalScored, earlyGoalMinute,
                                 homeTacticalHighLine, awayCounterThreat, homePossession });

  // ── Recommendations ────────────────────────────────────────────────────────
  let recommendations = generateRecommendations(overall, poi, p1, p4, chaos, matchData);
  if ((!Array.isArray(recommendations) || recommendations.length === 0) && !LIVE_STATUSES.has(String(status).toUpperCase())) {
    recommendations = [fallbackRecommendation({ home, away, overallScore: overall, poisson: poi, p1, p4, p8, analysisQuality })];
  }
  // Keep model probability as probability. Reliability and Signal are separate fields.
  recommendations = recommendations.map((r) => {
    const key = r.marketKey || recommendationToMarketKey(r, { home, away });
    const probability01 = key ? poi.marketProbabilities?.[key] : null;
    return { ...r, marketKey: key, probability01: probability01 ?? null,
      modelProbability: probability01 == null ? null : probability01 * 100,
      confidence: probability01 == null ? r.confidence : +(probability01 * 100).toFixed(1) };
  });
  // All markets use one probability source and independent evidence/price gates.
  recommendations = decideMarkets(recommendations, predictionCore,
    String(status).toUpperCase() === 'NS' ? matchData.odds || null : null);
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
  const winCallLiveAware = computeWinCall({ home, away, p1, p4, poisson: poi, overallScore: overall, recommendations, status });
  const decisionMetrics = buildDecisionMetrics({
    overallScore: overall,
    winCall: winCallLiveAware,
    poisson: poi,
    recommendations,
    analysisQuality,
  });

  // ── Bookie edge detection ──────────────────────────────────────────────────
  const bookieEdges = recommendations.filter(r => r.value?.decision === 'BET').map(r => `${r.selection}: model ${(r.probability01 * 100).toFixed(1)}%, expected value ${((r.value.expectedValue || 0) * 100).toFixed(1)}%.`);

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
      homePosition,
      awayPosition,
      homePoints,
      awayPoints,
      totalTeams,
      competitionContext: resolvedCompetitionContext,
    },
    recommendations,
    marketSummary: summarizeMarketDecisions(recommendations),
    forecastContract: forecastContract(matchData, predictionCore),
    parameters: { p1_motivation: p1, p2_starPower: p2, p3_h2h: p3, p4_form: p4,
                  p5_scoringTiming: p5, p6_defensiveGap: p6, p7_poisson: p7,
                  p8_xg: p8, p9_xga: p9, p10_pace: p10,
                  p11_homeAdvantage: p11, p12_market: p12, p13_squad: p13, p14_lifecycle: p14,
                  p15_crisis: p15 },
    poisson: poi,
    chaosVariables: chaos,
    overallScore: overall,
    legacyOverallScore,
    predictionCore,
    dailySignal: predictionCore.dailySignal,
    teamEdge: predictionCore.teamEdge,
    winCall: winCallLiveAware,
    decisionMetrics,
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
    dataSourceStatus: dataSourceStatus || {
      standings: { status: 'unknown', source: 'unknown' },
      liveStats: { status: 'unknown', source: 'unknown' },
      directFixtureStats: { status: 'unknown', source: 'unknown' },
    },
    analysisVersion: FORECAST_VERSION,
    odds: matchData.odds ?? null,
    oddsSnapshot: matchData.oddsSnapshot ?? null,
    analysisTimestamp: new Date().toISOString(),
  };
}

export default analyzeV9;
