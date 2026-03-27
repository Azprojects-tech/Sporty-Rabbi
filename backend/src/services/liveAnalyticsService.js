/**
 * Live Match Analytics Service
 * Real-time next goal prediction & momentum meter (zero AI cost)
 */

/**
 * Calculate next goal probability for both teams
 * Based on: xG, shots on target, conversion rate, time elapsed
 */
export function calculateNextGoalProbability(match) {
  try {
    if (!match || match.status !== 'LIVE') {
      return { error: 'Match not live' };
    }

    const homeShots = match.shots?.home || 0;
    const awayShots = match.shots?.away || 0;
    const homeXG = match.xg?.home || 0;
    const awayXG = match.xg?.away || 0;

    // Goal conversion rate (empirical: ~5-15% from xG)
    const conversionRate = 0.10;

    // Calculate expected goals remaining (xG still available)
    const homeExpectedGoals = homeXG * conversionRate * 100; // Convert to percentage
    const awayExpectedGoals = awayXG * conversionRate * 100;

    // Factor in shots on target (more direct indicator)
    const homeShotConversion = homeShots > 0 ? (homeShots * 0.25) : 0; // 25% of shots on target
    const awayShotConversion = awayShots > 0 ? (awayShots * 0.25) : 0;

    // Combine both metrics
    const homeNextGoalProb = Math.min(
      ((homeExpectedGoals + homeShotConversion) / 2).toFixed(1),
      95
    );
    const awayNextGoalProb = Math.min(
      ((awayExpectedGoals + awayShotConversion) / 2).toFixed(1),
      95
    );

    // Goal pace calculation (goals per minute in match so far)
    const matchMinutes = match.matchMinutes || 1;
    const totalGoals = (match.score?.split('-')[0] || 0) + (match.score?.split('-')[1] || 0);
    const goalsPerMinute = totalGoals / matchMinutes;
    const projectedFinalGoals = goalsPerMinute * 90;

    return {
      nextGoal: {
        home: {
          probability: parseFloat(homeNextGoalProb),
          reasoning: `${homeShots} shots on target, xG ${homeXG.toFixed(1)}`,
        },
        away: {
          probability: parseFloat(awayNextGoalProb),
          reasoning: `${awayShots} shots on target, xG ${awayXG.toFixed(1)}`,
        },
      },
      goalPace: {
        currentGoalRate: goalsPerMinute.toFixed(2),
        projectedFinalGoals: projectedFinalGoals.toFixed(1),
        over25Likely: projectedFinalGoals > 2.5,
        over15Likely: projectedFinalGoals > 1.5,
      },
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error calculating next goal:', error.message);
    return { error: 'Could not calculate probability' };
  }
}

/**
 * Calculate momentum meter (0-100%)
 * Shows which team is currently dominant
 */
export function calculateMomentum(match) {
  try {
    if (!match || match.status !== 'LIVE') {
      return { error: 'Match not live' };
    }

    const homeShots = match.shots?.home || 0;
    const awayShots = match.shots?.away || 0;
    const homePossession = match.possession?.home || 50;
    const awayPossession = match.possession?.away || 50;
    const homeXG = match.xg?.home || 0;
    const awayXG = match.xg?.away || 0;

    // Weighted momentum calculation
    const possessionWeight = 0.3;
    const shotsWeight = 0.4;
    const xgWeight = 0.3;

    // Normalize to 0-1 scale
    const totalShots = homeShots + awayShots || 1;
    const totalXG = homeXG + awayXG || 1;

    const homeMomentum =
      (homePossession / 100) * possessionWeight +
      (homeShots / totalShots) * shotsWeight +
      (homeXG / totalXG) * xgWeight;

    const awayMomentum =
      (awayPossession / 100) * possessionWeight +
      (awayShots / totalShots) * shotsWeight +
      (awayXG / totalXG) * xgWeight;

    // Convert to percentage
    const homePercent = Math.round(homeMomentum * 100);
    const awayPercent = Math.round(awayMomentum * 100);

    // Determine trend
    let trend = 'balanced';
    if (homePercent > 65) trend = 'home-surging';
    else if (awayPercent > 65) trend = 'away-surging';
    else if (homePercent > 55) trend = 'home-dominant';
    else if (awayPercent > 55) trend = 'away-dominant';

    // Calculate danger window (high momentum + high shots = goal likely soon)
    const homeDanger =
      homePercent > 60 && homeShots > 3 ? 'HIGH' : homePercent > 50 ? 'MEDIUM' : 'LOW';
    const awayDanger =
      awayPercent > 60 && awayShots > 3 ? 'HIGH' : awayPercent > 50 ? 'MEDIUM' : 'LOW';

    return {
      home: {
        momentum: homePercent,
        possession: homePossession,
        shots: homeShots,
        xg: homeXG.toFixed(2),
        dangerLevel: homeDanger,
      },
      away: {
        momentum: awayPercent,
        possession: awayPossession,
        shots: awayShots,
        xg: awayXG.toFixed(2),
        dangerLevel: awayDanger,
      },
      trend,
      insight: getTrendInsight(trend, homePercent, awayPercent),
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('Error calculating momentum:', error.message);
    return { error: 'Could not calculate momentum' };
  }
}

function getTrendInsight(trend, homePercent, awayPercent) {
  const insights = {
    'home-surging': `🔥 Home team is dominating (${homePercent}% momentum) - high goal probability!`,
    'away-surging': `🔥 Away team is dominating (${awayPercent}% momentum) - high goal probability!`,
    'home-dominant': `💪 Home team has advantage (${homePercent}% momentum)`,
    'away-dominant': `💪 Away team has advantage (${awayPercent}% momentum)`,
    balanced: `⚖️ Evenly matched. Watch for momentum shifts.`,
  };
  return insights[trend] || 'Match in progress';
}

/**
 * Calculate value of a bet given odds and probability
 * Returns true if odds offer value (positive expected value)
 */
export function calculateBetValue(probability, odds) {
  // Odds format: decimal (e.g., 2.5 means £1 wins £1.50)
  // If probability = 34% and odds = 2.5:
  //   Expected value = (0.34 * 2.5) - 1 = 0.85 - 1 = -0.15 (no value)
  //   Expected value = (0.34 * 3.0) - 1 = 1.02 - 1 = 0.02 (2% value!)

  const decimalOdds = parseFloat(odds);
  const prob = parseFloat(probability) / 100;

  if (!decimalOdds || decimalOdds < 1 || !prob || prob < 0 || prob > 1) {
    return { error: 'Invalid probability or odds' };
  }

  const expectedValue = prob * decimalOdds - 1;
  const impliedProbability = (1 / decimalOdds * 100).toFixed(1);
  const hasValue = expectedValue > 0;
  const valuePercent = (expectedValue * 100).toFixed(1);

  return {
    hasValue,
    expectedValue: expectedValue.toFixed(3),
    expectedValuePercent: valuePercent,
    impliedProbability: parseFloat(impliedProbability),
    calculatedProbability: parseFloat((prob * 100).toFixed(1)),
    recommendation: hasValue
      ? `✅ VALUE FOUND! Expected return: ${valuePercent}% for every unit bet`
      : `❌ No value. Odds favor the house (implied ${impliedProbability}% vs calculated ${(prob * 100).toFixed(1)}%)`,
  };
}

/**
 * Generate actionable betting alert based on match state
 */
export function generateBettingAlert(match, nextGoalProb, momentum) {
  const alerts = [];

  // Next goal alerts
  if (nextGoalProb.nextGoal) {
    const homeProb = nextGoalProb.nextGoal.home.probability;
    const awayProb = nextGoalProb.nextGoal.away.probability;

    if (homeProb > 40) {
      alerts.push({
        type: 'NEXT_GOAL',
        team: match.home,
        probability: homeProb,
        message: `${match.home} has ${homeProb}% chance of next goal`,
        urgency: homeProb > 60 ? 'HIGH' : 'MEDIUM',
      });
    }
    if (awayProb > 40) {
      alerts.push({
        type: 'NEXT_GOAL',
        team: match.away,
        probability: awayProb,
        message: `${match.away} has ${awayProb}% chance of next goal`,
        urgency: awayProb > 60 ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  // Momentum alerts
  if (momentum.home && momentum.away) {
    if (momentum.home.momentum > 70 && momentum.home.dangerLevel === 'HIGH') {
      alerts.push({
        type: 'MOMENTUM',
        team: match.home,
        message: `🔥 ${match.home} SURGING with ${momentum.home.momentum}% momentum + ${momentum.home.shots} shots!`,
        urgency: 'HIGH',
      });
    }
    if (momentum.away.momentum > 70 && momentum.away.dangerLevel === 'HIGH') {
      alerts.push({
        type: 'MOMENTUM',
        team: match.away,
        message: `🔥 ${match.away} SURGING with ${momentum.away.momentum}% momentum + ${momentum.away.shots} shots!`,
        urgency: 'HIGH',
      });
    }
  }

  // Goal pace alerts
  if (nextGoalProb.goalPace) {
    if (nextGoalProb.goalPace.over25Likely) {
      alerts.push({
        type: 'GOAL_PACE',
        message: `⚡ Goals trending HIGH - projected ${nextGoalProb.goalPace.projectedFinalGoals} total`,
        urgency: 'MEDIUM',
      });
    }
  }

  return alerts;
}
