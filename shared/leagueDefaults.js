const LEAGUE_XG_MAP = {
  39: [1.55, 1.35],
  40: [1.45, 1.35],
  78: [1.7, 1.5],
  79: [1.55, 1.4],
  135: [1.15, 1.05],
  61: [1.15, 1.05],
  140: [1.3, 1.2],
  88: [1.65, 1.45],
  71: [1.45, 1.3],
  94: [1.3, 1.2],
  144: [1.4, 1.3],
  235: [1.25, 1.15],
  307: [1.2, 1.1],
  2: [1.35, 1.25],
  3: [1.3, 1.25],
  179: [1.4, 1.3],
  848: [1.25, 1.15],
  203: [1.2, 1.1],
  253: [1.3, 1.2],
  98: [1.25, 1.15],
  292: [1.2, 1.1],
  169: [1.3, 1.2],
  313: [1.25, 1.15],
  128: [1.4, 1.3],
};

const HIGH_SHOT_LEAGUES = new Set([2, 3, 848, 39, 78, 88]);
const MID_SHOT_LEAGUES = new Set([140, 135, 61, 94]);

export function getLeagueStatDefaults(leagueId = 0) {
  const [homeXgAvg, awayXgAvg] = LEAGUE_XG_MAP[leagueId] || [1.3, 1.15];

  const homeShotsPerGame = HIGH_SHOT_LEAGUES.has(leagueId)
    ? 15
    : MID_SHOT_LEAGUES.has(leagueId)
      ? 13
      : 11;

  const awayShotsPerGame = HIGH_SHOT_LEAGUES.has(leagueId)
    ? 13
    : MID_SHOT_LEAGUES.has(leagueId)
      ? 11
      : 9;

  return {
    homeXgAvg,
    awayXgAvg,
    homeShotsPerGame,
    awayShotsPerGame,
  };
}
