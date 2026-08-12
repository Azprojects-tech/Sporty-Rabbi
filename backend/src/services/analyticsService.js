/**
 * Team & H2H Analytics Service
 * Fetches historical data for informed betting decisions
 *
 * ⚠️  OFFLINE MODE: When API_FOOTBALL_KEY is not set (or subscription is expired),
 * all functions return structured fallback objects so the rest of the server keeps
 * running.  Re-connect by setting a valid API_FOOTBALL_KEY in backend/.env.
 */

import axios from 'axios';

const API_BASE = 'https://v3.football.api-sports.io';
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_OFFLINE_MODE = String(process.env.API_FOOTBALL_OFFLINE_MODE || '').toLowerCase() === 'true';
const API_AVAILABLE = Boolean(API_KEY) && !API_OFFLINE_MODE;

if (!API_AVAILABLE) {
  console.warn(
    API_OFFLINE_MODE
      ? '⚠️  analyticsService: API_FOOTBALL_OFFLINE_MODE=true — forcing offline mode. Historical form/H2H endpoints will return placeholder data.'
      : '⚠️  analyticsService: API_FOOTBALL_KEY not set — running in offline mode. Historical form/H2H endpoints will return placeholder data.'
  );
}

const axiosInstance = axios.create({
  baseURL: API_BASE,
  headers: { 'x-apisports-key': API_KEY },
  timeout: 8000,
});

// Offline fallback response shape
function offlineFallback(type, ...ids) {
  return {
    offline: true,
    message: 'API subscription inactive. Re-connect API_FOOTBALL_KEY to enable live historical data.',
    type, ids,
  };
}

// Cache to avoid excessive API calls
const statsCache = new Map();
const CACHE_TTL = 3600000; // 1 hour

function cacheKey(type, ...args) {
  return `${type}:${args.join(':')}`;
}

function getCache(key) {
  const cached = statsCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCache(key, data) {
  statsCache.set(key, { data, timestamp: Date.now() });
}

function summarizeRecentOpposition(teamId, matches = [], standings = null) {
  const teamMap = standings?.teams || null;
  const ownPosition = teamMap?.[teamId]?.position || null;
  if (matches.length === 0) return null;

  const recent = matches.slice(0, 5).map((match) => {
    const isHome = match.teams.home.id === teamId;
    const opponent = isHome ? match.teams.away : match.teams.home;
    const teamGoals = isHome ? (match.goals.home || 0) : (match.goals.away || 0);
    const oppGoals = isHome ? (match.goals.away || 0) : (match.goals.home || 0);
    const result = teamGoals > oppGoals ? 'W' : teamGoals < oppGoals ? 'L' : 'D';
    const opponentPosition = teamMap?.[opponent.id]?.position || null;
    let tier = null;
    if (opponentPosition != null && ownPosition != null) {
      if (opponentPosition <= ownPosition - 3) tier = 'stronger';
      else if (opponentPosition >= ownPosition + 3) tier = 'weaker';
      else tier = 'peer';
    }
    return {
      opponentId: opponent.id,
      opponent: opponent.name,
      opponentPosition,
      tier,
      result,
      score: `${teamGoals}-${oppGoals}`,
      date: match.fixture.date,
    };
  });

  const counts = recent.reduce((acc, item) => {
    if (item.tier) acc[item.tier] += 1;
    return acc;
  }, { stronger: 0, peer: 0, weaker: 0 });

  const results = recent.reduce((acc, item) => {
    acc[item.result] = (acc[item.result] || 0) + 1;
    return acc;
  }, { W: 0, D: 0, L: 0 });

  const positioned = recent.filter((item) => item.opponentPosition != null);
  const avgOpponentPosition = positioned.length
    ? +(positioned.reduce((sum, item) => sum + item.opponentPosition, 0) / positioned.length).toFixed(1)
    : null;

  const hasStrengthBands = ownPosition != null && positioned.length > 0;
  const strengthPart = hasStrengthBands
    ? `Opposition quality: ${counts.stronger} stronger, ${counts.peer} peer, ${counts.weaker} weaker${avgOpponentPosition != null ? ` (avg opp position ${avgOpponentPosition})` : ''}.`
    : 'Opposition quality bands unavailable (standings not resolved).';
  const summary = `Last 5 results: ${results.W}W ${results.D}D ${results.L}L. ${strengthPart}`;

  return {
    ownPosition,
    avgOpponentPosition,
    counts,
    results,
    recent,
    summary,
  };
}

// API-Football squad position strings → scoreStarPower impactMap keys
const SQUAD_POS_MAP = {
  'Goalkeeper': 'goalkeeper',
  'Defender':   'center-back',
  'Midfielder': 'midfielder',
  'Attacker':   'striker',
};

// Internal: fetch squad → { playerId: positionKey } map. Cached for the process lifetime
// (squads change at most on transfer deadlines — far less frequent than any CACHE_TTL).
async function getSquadPositionMap(teamId) {
  const key = cacheKey('squadPos', teamId);
  const cached = statsCache.get(key);
  if (cached) return cached.data;   // no TTL check — squad is stable
  try {
    const response = await axiosInstance.get('/players/squads', { params: { team: teamId } });
    const players = response.data.response?.[0]?.players || [];
    const map = {};
    for (const p of players) {
      if (p.id) map[p.id] = SQUAD_POS_MAP[p.position] || null;
    }
    statsCache.set(key, { data: map, timestamp: Date.now() });
    return map;
  } catch {
    return {};
  }
}

/**
 * Get team's last 10 matches within a specific season and calculate form stats.
 * When season is supplied, results are filtered to that season only.
 */
export async function getTeamForm(teamId, league = null, season = null) {
  if (!API_AVAILABLE) return offlineFallback('teamForm', teamId, league);
  try {
    const key = cacheKey('form', teamId, league, season ?? '');
    const cached = getCache(key);
    if (cached) {
      // Reject a cached entry if it was for a different season.
      if (season != null && cached.season !== season) statsCache.delete(key);
      else return cached;
    }
    const params = { team: teamId, last: 10 };
    if (league) params.league = league;
    // Filter to the exact fixture season — prevents cross-season form contamination.
    if (season != null) params.season = season;

    const response = await axiosInstance.get('/fixtures', { params });
    const matches = response.data.response || [];
    // Season is not available in a form-only fetch; do not guess from current date.
    const standings = null;

    if (matches.length === 0) {
      return {
        teamId,
        matches: [],
        stats: {
          wins: 0,
          draws: 0,
          losses: 0,
          goalsFor: 0,
          goalsAgainst: 0,
          avgGoalsFor: 0,
          avgGoalsAgainst: 0,
          form: 'Unavailable',
          goalDrought: 0,
          recentLosses: 0,
        },
      };
    }

    // Calculate stats
    let wins = 0, draws = 0, losses = 0;
    let goalsFor = 0, goalsAgainst = 0;
    const formStr = [];

    matches.forEach((match) => {
      const isHome = match.teams.home.id === teamId;
      const homeGoals = match.goals.home || 0;
      const awayGoals = match.goals.away || 0;

      const forGoals = isHome ? homeGoals : awayGoals;
      const againstGoals = isHome ? awayGoals : homeGoals;

      goalsFor += forGoals;
      goalsAgainst += againstGoals;

      if (forGoals > againstGoals) {
        wins++;
        formStr.push('W');
      } else if (forGoals === againstGoals) {
        draws++;
        formStr.push('D');
      } else {
        losses++;
        formStr.push('L');
      }
    });

    // Consecutive recent losses — i=0 is the most recent fixture
    // (API-Football returns fixtures newest-first for last: N queries)
    let recentLosses = 0;
    for (let i = 0; i < formStr.length; i++) {
      if (formStr[i] === 'L') recentLosses++; else break;
    }

    // Consecutive recent goalless games
    let goalDrought = 0;
    for (let i = 0; i < matches.length; i++) {
      const isHomeTeam = matches[i].teams.home.id === teamId;
      const teamGoals  = isHomeTeam ? (matches[i].goals.home || 0) : (matches[i].goals.away || 0);
      if (teamGoals === 0) goalDrought++; else break;
    }

    const result = {
      teamId,
      teamName: matches[0].teams.home.id === teamId 
        ? matches[0].teams.home.name 
        : matches[0].teams.away.name,
      matches: matches.map((m) => ({
        date: m.fixture.date,
        home: m.teams.home.name,
        away: m.teams.away.name,
        homeGoals: m.goals.home,
        awayGoals: m.goals.away,
        status: m.fixture.status,
      })),
      stats: {
        wins,
        draws,
        losses,
        goalsFor,
        goalsAgainst,
        avgGoalsFor: (goalsFor / matches.length).toFixed(2),
        avgGoalsAgainst: (goalsAgainst / matches.length).toFixed(2),
        form: formStr.join(''), // Last 10 matches (full L10 for V9 engine)
        winRate: ((wins / matches.length) * 100).toFixed(1),
        goalDrought,
        recentLosses,
        recentOpposition: summarizeRecentOpposition(teamId, matches, standings),
      },
      season: season ?? null,
    };

    setCache(key, result);
    return result;
  } catch (error) {
    console.error('❌ Error fetching team form:', error.message);
    return {
      teamId,
      matches: [],
      stats: { error: 'Could not fetch data' },
    };
  }
}

/**
 * Get head-to-head record between two teams
 */
export async function getH2H(teamA, teamB) {
  if (!API_AVAILABLE) return offlineFallback('h2h', teamA, teamB);
  try {
    const key = cacheKey('h2h', Math.min(teamA, teamB), Math.max(teamA, teamB));
    const cached = getCache(key);
    if (cached) return cached;

    const response = await axiosInstance.get('/fixtures/headtohead', {
      params: { h2h: `${teamA}-${teamB}`, last: 10 },
    });

    const matches = response.data.response || [];

    if (matches.length === 0) {
      return {
        teamA,
        teamB,
        matches: [],
        stats: {
          teamAWins: 0,
          teamBWins: 0,
          draws: 0,
          totalGoals: 0,
          avgGoalsPerMatch: 0,
        },
      };
    }

    let teamAWins = 0, teamBWins = 0, draws = 0, totalGoals = 0;

    matches.forEach((match) => {
      const homeGoals = match.goals.home || 0;
      const awayGoals = match.goals.away || 0;
      totalGoals += homeGoals + awayGoals;

      const isTeamAHome = match.teams.home.id === teamA;
      const teamAGoals = isTeamAHome ? homeGoals : awayGoals;
      const teamBGoals = isTeamAHome ? awayGoals : homeGoals;

      if (teamAGoals > teamBGoals) teamAWins++;
      else if (teamAGoals < teamBGoals) teamBWins++;
      else draws++;
    });

    const result = {
      teamA,
      teamB,
      teamAName: matches[0].teams.home.id === teamA ? matches[0].teams.home.name : matches[0].teams.away.name,
      teamBName: matches[0].teams.home.id === teamA ? matches[0].teams.away.name : matches[0].teams.home.name,
      matches: matches.map((m) => ({
        date: m.fixture.date,
        home: m.teams.home.name,
        away: m.teams.away.name,
        homeGoals: m.goals.home,
        awayGoals: m.goals.away,
      })),
      stats: {
        teamAWins,
        teamBWins,
        draws,
        totalGoals,
        avgGoalsPerMatch: (totalGoals / matches.length).toFixed(2),
      },
    };

    setCache(key, result);
    return result;
  } catch (error) {
    console.error('❌ Error fetching H2H:', error.message);
    return {
      teamA,
      teamB,
      matches: [],
      stats: { error: 'Could not fetch data' },
    };
  }
}

/**
 * Get league standings with full multi-group/table resolution.
 *
 * @param {object} opts
 * @param {number}  opts.leagueId
 * @param {number}  opts.season      - Required; must come from fixture context, never inferred.
 * @param {number}  [opts.homeTeamId] - Used to select the relevant standings group.
 * @param {number}  [opts.awayTeamId]
 */
export async function getStandings({ leagueId, season, homeTeamId = null, awayTeamId = null } = {}) {
  // Season must be checked before API availability — a missing season is always invalid.
  if (season == null) {
    return { status: 'MISSING', reason: 'FIXTURE_SEASON_NOT_AVAILABLE', leagueId, season: null, teams: {}, totalTeams: 0 };
  }
  if (!API_AVAILABLE) return offlineFallback('standings', leagueId);

  const key = cacheKey('standings', leagueId, season, homeTeamId ?? '', awayTeamId ?? '');
  const cached = getCache(key);
  if (cached) {
    // Reject stale cache entries for a different season or league.
    if (cached.season !== season || cached.leagueId !== leagueId) {
      statsCache.delete(key);
    } else {
      return cached;
    }
  }

  try {
    const response = await axiosInstance.get('/standings', { params: { league: leagueId, season } });

    // API-Football may return multiple groups/tables — never assume groups[0] is relevant.
    const allGroups = response.data.response?.[0]?.league?.standings || [];
    if (!allGroups.length) {
      return { status: 'MISSING', reason: 'RELEVANT_STANDINGS_TABLE_NOT_RESOLVED', leagueId, season, teams: {}, totalTeams: 0 };
    }

    // Find the group that contains both fixture teams.
    let selectedGroup = null;
    let selectedGroupName = null;
    if (homeTeamId != null && awayTeamId != null) {
      for (const group of allGroups) {
        const ids = new Set(group.map(e => e.team.id));
        if (ids.has(homeTeamId) && ids.has(awayTeamId)) { selectedGroup = group; selectedGroupName = group[0]?.group || null; break; }
      }
      // If no group holds both teams, try for either team.
      if (!selectedGroup) {
        for (const group of allGroups) {
          const ids = new Set(group.map(e => e.team.id));
          if (ids.has(homeTeamId) || ids.has(awayTeamId)) { selectedGroup = group; selectedGroupName = group[0]?.group || null; break; }
        }
      }
    }
    // Without team IDs use the first group; note the ambiguity.
    if (!selectedGroup) {
      if (homeTeamId == null && awayTeamId == null) {
        selectedGroup = allGroups[0]; selectedGroupName = allGroups[0][0]?.group || null;
      } else {
        return { status: 'MISSING', reason: 'RELEVANT_STANDINGS_TABLE_NOT_RESOLVED', leagueId, season, teams: {}, totalTeams: 0 };
      }
    }

    const teamMap = {};
    selectedGroup.forEach((entry) => {
      teamMap[entry.team.id] = {
        position:       entry.rank               ?? null,
        points:         entry.points             ?? null,
        played:         entry.all?.played        ?? null,
        wins:           entry.all?.win           ?? null,
        draws:          entry.all?.draw          ?? null,
        losses:         entry.all?.lose          ?? null,
        goalsFor:       entry.all?.goals?.for    ?? null,
        goalsAgainst:   entry.all?.goals?.against ?? null,
        goalDifference: entry.goalsDiff          ?? null,
        form:           entry.form               ?? null,
      };
    });

    const bothResolved = (homeTeamId != null && awayTeamId != null)
      ? (teamMap[homeTeamId] != null && teamMap[awayTeamId] != null)
      : true;

    const result = {
      status:     bothResolved ? 'AVAILABLE' : 'MISSING',
      reason:     bothResolved ? null : 'RELEVANT_STANDINGS_TABLE_NOT_RESOLVED',
      source:     'API_FOOTBALL',
      leagueId,
      season,
      tableName:  selectedGroupName,
      groupName:  selectedGroupName,
      teams:      teamMap,
      totalTeams: selectedGroup.length,
      retrievedAt: new Date().toISOString(),
    };
    // 6-hour TTL
    statsCache.set(key, { data: result, timestamp: Date.now() - (CACHE_TTL - 6 * 3600000) });
    return result;
  } catch (error) {
    console.error('Error fetching standings:', error.message);
    return offlineFallback('standings', leagueId);
  }
}

/**
 * Get combined fixture preview with both teams' stats
 */
export async function getFixturePreview(fixtureId, homeTeamId, awayTeamId, leagueId) {
  if (!API_AVAILABLE) return offlineFallback('fixturePreview', fixtureId, homeTeamId, awayTeamId);
  try {
    const [homeForm, awayForm, h2h] = await Promise.all([
      getTeamForm(homeTeamId, leagueId),
      getTeamForm(awayTeamId, leagueId),
      getH2H(homeTeamId, awayTeamId),
    ]);

    return {
      fixtureId,
      homeTeam: homeForm,
      awayTeam: awayForm,
      h2h,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error fetching fixture preview:', error.message);
    return null;
  }
}

/**
 * Get season team statistics: shots per game, conversion rate, possession average.
 * Cached 6 hours — season aggregates change slowly.
 */
export async function getTeamStatistics(teamId, leagueId, season = null) {
  if (!API_AVAILABLE) return offlineFallback('teamStats', teamId, leagueId);
  if (!teamId || !leagueId) return offlineFallback('teamStats', teamId, leagueId);
  if (season == null) {
    return { status: 'MISSING', reason: 'FIXTURE_SEASON_NOT_AVAILABLE', teamId, leagueId };
  }
  try {
    const year = season;
    const key = cacheKey('teamStats', teamId, leagueId, year);
    const cached = getCache(key);
    if (cached) return cached;

    const response = await axiosInstance.get('/teams/statistics', {
      params: { team: teamId, league: leagueId, season: year },
    });
    const s = response.data.response;
    if (!s) return offlineFallback('teamStats', teamId, leagueId);

    const played        = s.fixtures?.played?.total    ?? null;
    const goalsFor      = s.goals?.for?.total?.total    ?? null;
    const shotsTotal    = s.shots?.total?.total          ?? null;
    const shotsOn       = s.shots?.on?.total             ?? null;
    const possessionRaw = s.ball_possession ?? null;

    const avgShotsTotal = (played != null && played > 0 && shotsTotal != null)
      ? +(shotsTotal / played).toFixed(1) : null;
    const avgShotsOn    = (played != null && played > 0 && shotsOn != null)
      ? +(shotsOn / played).toFixed(1) : null;
    const conversionPct = (shotsOn != null && shotsOn > 0 && goalsFor != null)
      ? +((goalsFor / shotsOn) * 100).toFixed(1) : null;
    const avgPossession = possessionRaw ? parseFloat(possessionRaw) : null;

    // Late-goal % — only compute when the minute-bucket structure AND goal count are present.
    const goalsByMinute = s.goals?.for?.minute ?? null;
    const lateGoalPct = (goalsByMinute != null && goalsFor != null && goalsFor > 0)
      ? +((( goalsByMinute['76-90']?.total ?? 0) + (goalsByMinute['91-105']?.total ?? 0)) / goalsFor).toFixed(3)
      : null;

    const result = {
      teamId, leagueId,
      stats: { avgShotsTotal, avgShotsOn, conversionPct, avgPossession, played, lateGoalPct },
    };
    // 6-hour cache
    statsCache.set(key, { data: result, timestamp: Date.now() - (CACHE_TTL - 6 * 3600000) });
    return result;
  } catch (err) {
    console.error('❌ Error fetching team statistics:', err.message);
    return offlineFallback('teamStats', teamId, leagueId);
  }
}

/**
 * Get active injury/suspension count and derive squad integrity score.
 * Cached 2 hours — squad availability can change before match day.
 */
export async function getTeamInjuries(teamId, leagueId, season = null) {
  if (!API_AVAILABLE) return offlineFallback('injuries', teamId, leagueId);
  if (!teamId || !leagueId) return offlineFallback('injuries', teamId, leagueId);
  if (season == null) {
    return { status: 'MISSING', reason: 'FIXTURE_SEASON_NOT_AVAILABLE', teamId, leagueId };
  }
  try {
    const year = season;
    const key = cacheKey('injuries', teamId, leagueId, year);
    const cached = getCache(key);
    if (cached) return cached;

    const response = await axiosInstance.get('/injuries', {
      params: { team: teamId, league: leagueId, season: year },
    });
    const injuries = response.data.response || [];
    const active = injuries.filter(i => {
      const type = (i.player?.type || '').toLowerCase();
      return type === 'injury' || type === 'suspension';
    });
    const injuryCount = active.length;

    // Fetch squad roster to resolve each absent player's position.
    // scoreStarPower() applies impact penalties per-position; a squad integrity
    // of 100 (full-strength) lets those penalties drive the final effective score.
    const positionMap = await getSquadPositionMap(teamId);
    const keyAbsences = active.map(i => ({
      name:     i.player?.name || 'Unknown',
      position: positionMap[i.player?.id] || null,
    }));

    // squadIntegrity starts at 100 after a verified API call; scoreStarPower()
    // applies position-weighted penalties from keyAbsences to reduce it.
    // 100 = "no recorded absences per this API response", not "observably full strength".
    const result = { teamId, leagueId, injuryCount, squadIntegrity: 100, keyAbsences };
    // 2-hour cache
    statsCache.set(key, { data: result, timestamp: Date.now() - (CACHE_TTL - 2 * 3600000) });
    return result;
  } catch (err) {
    console.error('❌ Error fetching team injuries:', err.message);
    return offlineFallback('injuries', teamId, leagueId);
  }
}
