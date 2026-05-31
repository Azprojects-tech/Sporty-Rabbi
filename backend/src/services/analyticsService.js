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
const API_AVAILABLE = Boolean(API_KEY);

if (!API_AVAILABLE) {
  console.warn('⚠️  analyticsService: API_FOOTBALL_KEY not set — running in offline mode. Historical form/H2H endpoints will return placeholder data.');
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

/**
 * Get team's last 10 matches and calculate form stats
 */
export async function getTeamForm(teamId, league = null) {
  if (!API_AVAILABLE) return offlineFallback('teamForm', teamId, league);
  try {
    const key = cacheKey('form', teamId, league);
    const cached = getCache(key);
    if (cached) return cached;

    const params = { team: teamId, last: 10 };
    if (league) params.league = league;

    const response = await axiosInstance.get('/fixtures', { params });
    const matches = response.data.response || [];

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
          form: 'N/A',
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
      },
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
 * Get league standings — extracts each team’s position, points, and games played.
 * Cached for 6 hours (standings change at most once per matchday).
 */
export async function getStandings(leagueId, season = null) {
  if (!API_AVAILABLE) return offlineFallback('standings', leagueId);
  try {
    // Football seasons run Aug–May; before August use the previous calendar year.
    const year = season || (new Date().getMonth() < 7
      ? new Date().getFullYear() - 1
      : new Date().getFullYear());
    const key = cacheKey('standings', leagueId, year);
    const cached = getCache(key);
    if (cached) return cached;

    const response = await axiosInstance.get('/standings', {
      params: { league: leagueId, season: year },
    });
    const standings = response.data.response?.[0]?.league?.standings?.[0] || [];
    if (standings.length === 0) return offlineFallback('standings', leagueId);

    const teamMap = {};
    standings.forEach((entry) => {
      teamMap[entry.team.id] = {
        position:   entry.rank   || 0,
        points:     entry.points || 0,
        played:     entry.all?.played || 0,
      };
    });

    const result = { leagueId, season: year, totalTeams: standings.length, teams: teamMap };
    // Override cache TTL to 6 hours for standings
    statsCache.set(key, { data: result, timestamp: Date.now() - (CACHE_TTL - 6 * 3600000) });
    return result;
  } catch (error) {
    console.error('❌ Error fetching standings:', error.message);
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
