// Probabilities are fractions here. Presentation code alone rounds percentages.
export const FORECAST_VERSION = 'V10.6C-Unified-Decisions';
export const LIVE_STATUSES = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT']);

export function observedNumber(value) {
  if (value == null || (typeof value === 'string' && !value.trim()) || !['string','number'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function nextGoalFromRates(home, away) {
  if (![home, away].every(n => Number.isFinite(n) && n >= 0)) return null;
  const total = home + away;
  const none = Math.exp(-total);
  const any = -Math.expm1(-total);
  return { home: total ? home / total * any : 0, away: total ? away / total * any : 0, none, any };
}

function poissonMasses(rate) {
  const values = [Math.exp(-rate)];
  let sum = values[0];
  for (let n = 1; n <= 80 && (n < 12 || sum < 1 - 1e-13); n++) {
    values.push(values[n - 1] * rate / n);
    sum += values[n];
  }
  return values;
}

export function scoreDistribution(homeRate, awayRate, { homeGoals = 0, awayGoals = 0, rho = 0 } = {}) {
  if (!Number.isFinite(rho)) return null;
  if (![homeRate, awayRate].every(n => Number.isFinite(n) && n >= 0 && n <= 20)) return null;
  if (![homeGoals, awayGoals].every(n => Number.isInteger(n) && n >= 0)) return null;
  const hMass = poissonMasses(homeRate), aMass = poissonMasses(awayRate);
  const p = { home_win: 0, draw: 0, away_win: 0, btts: 0 };
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
    p[`over${String(line).replace('.', '')}`] = 0;
    p[`under${String(line).replace('.', '')}`] = 0;
  }
  let mass = 0, best = { score: `${homeGoals}-${awayGoals}`, probability01: -1 };
  for (let h = 0; h < hMass.length; h++) for (let a = 0; a < aMass.length; a++) {
    let tau = 1;
    if (h === 0 && a === 0) tau = 1 - homeRate * awayRate * rho;
    else if (h === 1 && a === 0) tau = 1 + awayRate * rho;
    else if (h === 0 && a === 1) tau = 1 + homeRate * rho;
    else if (h === 1 && a === 1) tau = 1 - rho;
    if (tau < 0) return null;
    const weight = hMass[h] * aMass[a] * tau;
    const finalH = h + homeGoals, finalA = a + awayGoals;
    mass += weight;
    p[finalH > finalA ? 'home_win' : finalH < finalA ? 'away_win' : 'draw'] += weight;
    if (finalH > 0 && finalA > 0) p.btts += weight;
    for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
      p[`${finalH + finalA > line ? 'over' : 'under'}${String(line).replace('.', '')}`] += weight;
    }
    if (weight > best.probability01) best = { score: `${finalH}-${finalA}`, probability01: weight };
  }
  if (!(mass > 0)) return null;
  for (const key of Object.keys(p)) p[key] /= mass;
  best.probability01 /= mass;
  return { marketProbabilities: p, likelyScore: best, expectedTotalGoals: homeGoals + awayGoals + homeRate + awayRate };
}

export function displayProbabilities(p = {}) {
  const pct = key => Number.isFinite(p[key]) ? Math.round(p[key] * 100) : null;
  return { over05: pct('over05'), over15: pct('over15'), over25: pct('over25'), over35: pct('over35'),
    over45: pct('over45'), under15: pct('under15'), under25: pct('under25'), under35: pct('under35'),
    under45: pct('under45'), btts: pct('btts'), homeWin: pct('home_win'), draw: pct('draw'), awayWin: pct('away_win') };
}

export function regulationState(match = {}) {
  const status = String(match.status || 'NS').toUpperCase();
  const minute = status === 'HT' ? 45 : observedNumber(match.matchMinutes);
  const score = String(match.score ?? '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (['ET', 'BT', 'P', 'AET', 'PEN', 'FT'].includes(status)) return { available: false, reason: 'REGULATION_FINISHED', period: 'REGULATION' };
  if (!['LIVE', '1H', '2H', 'HT'].includes(status)) return { available: false, reason: 'NOT_IN_REGULATION_PLAY', period: 'REGULATION' };
  if (minute == null || minute < 0 || !score) return { available: false, reason: 'MATCH_CLOCK_OR_SCORE_UNAVAILABLE', period: 'REGULATION' };
  // Do not invent two remaining minutes or settle a still-live stoppage-time game.
  if (minute >= 90) return { available: false, reason: 'STOPPAGE_TIME_REMAINING_UNAVAILABLE', period: 'REGULATION' };
  return { available: true, minute, minutesRemaining: 90 - minute, homeGoals: Number(score[1]), awayGoals: Number(score[2]), period: 'REGULATION' };
}

export function remainingForecast(match, homeRate, awayRate) {
  const clock = regulationState(match);
  if (!clock.available) return clock;
  if (![homeRate, awayRate].every(n => Number.isFinite(n) && n >= 0)) return { ...clock, available: false, reason: 'TEAM_RATES_UNAVAILABLE' };
  const diff = clock.homeGoals - clock.awayGoals;
  const urgency = clock.minute / 90;
  const motive = gap => gap < 0 ? Math.min(1 + (gap < -1 ? .18 : .12) + .25 * urgency, 1.5)
    : gap > 0 ? Math.max(1 - (gap > 1 ? .15 : .05) - .20 * urgency, .62) : 1;
  const homeRed = Number(match.homeCards?.red ?? match.cards?.home?.red ?? 0) > 0;
  const awayRed = Number(match.awayCards?.red ?? match.cards?.away?.red ?? 0) > 0;
  // Preserve existing rate adjustments in one place; no percentage bonuses.
  const home = homeRate * clock.minutesRemaining / 90 * motive(diff) * (homeRed ? .62 : 1) * (awayRed ? 1.18 : 1);
  const away = awayRate * clock.minutesRemaining / 90 * motive(-diff) * (awayRed ? .62 : 1) * (homeRed ? 1.18 : 1);
  const distribution = scoreDistribution(home, away, clock);
  if (!distribution) return { ...clock, available: false, reason: 'RATE_OUT_OF_RANGE' };
  const nextGoal = nextGoalFromRates(home, away);
  return { ...clock, remainingLambda: { home, away }, ...distribution, nextGoal,
    marketProbabilities: { ...distribution.marketProbabilities, next_goal_home: nextGoal.home, next_goal_away: nextGoal.away, no_more_goal: nextGoal.none } };
}

export function finalScoreFromProviderFixture(raw = {}) {
  const status = String(raw?.fixture?.status?.short || '').toUpperCase();
  if (!['FT', 'AET', 'PEN'].includes(status)) return null;
  const pair = values => {
    const home = observedNumber(values?.home), away = observedNumber(values?.away);
    return [home, away].every(n => Number.isInteger(n) && n >= 0) ? { home, away, status } : null;
  };
  return pair(raw.score?.fulltime) || (status === 'FT' ? pair(raw.goals) : null);
}
