/**
 * API-Football league coverage flags → compact map.
 * /leagues rows look like { league:{id,name,type}, seasons:[{ year, current,
 * coverage:{ fixtures:{events,lineups,statistics_fixtures,statistics_players},
 * standings, players, injuries, predictions, odds } }] }.
 */
export function coverageFromSeason(season) {
  const c = season?.coverage;
  if (!c) return null;
  return {
    season: season.year ?? null,
    events: c.fixtures?.events === true,
    fixtureStats: c.fixtures?.statistics_fixtures === true,
    standings: c.standings === true,
    injuries: c.injuries === true,
    odds: c.odds === true,
  };
}

/** @returns {Record<string, {season, events, fixtureStats, standings, injuries, odds}>} */
export function parseLeagueCoverage(rows = [], { preferSeason = null } = {}) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.league?.id;
    const seasons = Array.isArray(row?.seasons) ? row.seasons : [];
    if (!id || !seasons.length) continue;
    const season = (preferSeason != null && seasons.find((s) => String(s.year) === String(preferSeason)))
      || seasons.find((s) => s.current === true)
      || seasons[seasons.length - 1];
    const coverage = coverageFromSeason(season);
    if (coverage) out[String(id)] = coverage;
  }
  return out;
}

/**
 * Decide which optional API-Football calls are worth making for a league.
 * Unknown coverage → allow (never block on missing metadata).
 */
export function coveragePlan(coverage) {
  if (!coverage) return { known: false, standings: true, injuries: true, odds: true, fixtureStats: true, skipped: [] };
  const plan = { known: true, standings: coverage.standings, injuries: coverage.injuries, odds: coverage.odds, fixtureStats: coverage.fixtureStats };
  plan.skipped = ['standings', 'injuries', 'odds', 'fixtureStats'].filter((k) => plan[k] === false);
  return plan;
}
