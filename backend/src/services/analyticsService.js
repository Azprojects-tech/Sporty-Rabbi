import { getOne, query, getAll } from '../config/database.js';

/**
 * Calculate pre-match analysis confidence score
 * Factors: team form, head-to-head, odds movement, xG, injury news
 */
export async function analyzePreMatch(matchId) {
  const match = await getOne('SELECT * FROM matches WHERE id = $1', [matchId]);
  const odds = await getOne('SELECT * FROM odds WHERE match_id = $1 ORDER BY updated_at DESC LIMIT 1', [matchId]);

  if (!match || !odds) return null;

  // Simplified scoring (you'd expand this with team form history, H2H, etc.)
  const factors = {
    home_possession_factor: Math.min(match.home_possession / 50, 1.5), // >50% is advantage
    shots_on_target_factor: Math.min(match.home_shots_on_target / match.away_shots_on_target || 1, 1.5),
    xg_factor: match.home_xg > match.away_xg ? 1.2 : 0.8,
    odds_factor: odds.home_win > 2.0 ? 1.1 : 0.9, // Value at higher odds
  };

  const confidence = (
    (factors.home_possession_factor + factors.shots_on_target_factor + factors.xg_factor + factors.odds_factor) / 4
  ) * 100;

  return {
    match_id: matchId,
    type: 'pre_match',
    confidence_score: Math.min(confidence, 95),
    analysis: {
      home_advantage: match.home_possession > 50,
      home_shots_quality: match.home_shots_on_target / (match.home_shots || 1),
      home_xg: match.home_xg,
      away_xg: match.away_xg,
      odds_value: odds.home_win,
    },
    recommendation: confidence > 65 ? 'strong_signal' : 'weak_signal',
  };
}

/**
 * Detect in-play betting opportunities
 * Triggers: momentum shift, own goal, red card, goal drought, etc.
 */
export async function detectInPlayOpportunities(matchId) {
  const match = await getOne('SELECT * FROM matches WHERE id = $1', [matchId]);

  if (!match || match.status !== 'LIVE') return [];

  const opportunities = [];

  // Opportunity 1: Possession dominance with low shots
  if (match.home_possession > 65 && match.home_shots_on_target < 2) {
    opportunities.push({
      type: 'low_conversion',
      title: 'Home team pressing but inefficient',
      description: `Home team has ${match.home_possession}% possession but only ${match.home_shots_on_target} shots on target. Odds may offer value on away team defense.`,
      confidence: 72,
      recommended_bet: 'Back away team to score',
      trigger_value: match.home_possession - match.home_shots_on_target,
    });
  }

  // Opportunity 2: Goal drought after 60 minutes
  if (
    match.status === 'LIVE' &&
    new Date(match.kickoff_time).getTime() + 60 * 60 * 1000 < Date.now() &&
    (match.home_goals + match.away_goals) < 1
  ) {
    opportunities.push({
      type: 'goal_drought',
      title: 'No goals after 60 minutes',
      description: `Match is 60+ minutes old with no goals. Under 2.5 goals value may be declining. Consider Over bets as game opens up.`,
      confidence: 68,
      recommended_bet: 'Back Over 1.5 goals',
      trigger_value: Math.floor((Date.now() - new Date(match.kickoff_time).getTime()) / 60000),
    });
  }

  // Opportunity 3: Unbalanced possession with goal lead
  if (match.home_goals > match.away_goals && match.home_possession > 70) {
    opportunities.push({
      type: 'dominant_lead',
      title: 'Home team leading and dominating',
      description: `Home team leads ${match.home_goals}-${match.away_goals} with ${match.home_possession}% possession. Likely to score again.`,
      confidence: 75,
      recommended_bet: `Back home team to score next (or both teams score at ${match.away_goals === 0 ? 'low odds' : 'value'})`,
      trigger_value: match.home_possession / match.home_goals,
    });
  }

  return opportunities;
}

/**
 * Score individual bet selections
 * Input: bet type, teams, stats
 * Output: confidence 0-100
 */
export function scoreBetSelection(betType, homeTeam, awayTeam, stats) {
  let score = 50; // neutral baseline

  switch (betType.toLowerCase()) {
    case 'home_win':
      if (stats.home_possession > 55) score += 8;
      if (stats.home_shots_on_target > stats.away_shots_on_target) score += 10;
      if (stats.home_xg > stats.away_xg) score += 12;
      break;

    case 'away_win':
      if (stats.away_possession > 55) score += 8;
      if (stats.away_shots_on_target > stats.home_shots_on_target) score += 10;
      if (stats.away_xg > stats.home_xg) score += 12;
      break;

    case 'draw':
      if (Math.abs(stats.home_xg - stats.away_xg) < 0.5) score += 15;
      if (Math.abs(stats.home_shots_on_target - stats.away_shots_on_target) < 2) score += 10;
      break;

    case 'over_1_5':
      if (stats.home_xg + stats.away_xg > 1.5) score += 15;
      if (stats.home_shots_on_target + stats.away_shots_on_target > 4) score += 10;
      break;

    case 'under_2_5':
      if (stats.home_xg + stats.away_xg < 2.5) score += 15;
      break;

    case 'both_teams_score':
      if (stats.home_xg > 0.5 && stats.away_xg > 0.5) score += 12;
      if (stats.home_shots_on_target > 1 && stats.away_shots_on_target > 1) score += 10;
      break;
  }

  return Math.min(Math.max(score, 0), 95);
}

/**
 * Calculate match momentum (goal trends, possession trends)
 */
export async function calculateMomentum(matchId) {
  // In production, you'd track stats changes over time
  // For now, return basic trend
  const match = await getOne('SELECT * FROM matches WHERE id = $1', [matchId]);

  return {
    home_momentum: match.home_xg > match.away_xg ? 'up' : 'down',
    away_momentum: match.away_xg > match.home_xg ? 'up' : 'down',
    match_flow_intensity: (match.home_shots + match.away_shots) / 2,
  };
}
