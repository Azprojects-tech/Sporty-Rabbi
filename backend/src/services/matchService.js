import axios from 'axios';
import { getAll, getOne, query } from '../config/database.js';

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';

// Get live matches from API-Football
export async function fetchLiveMatches() {
  try {
    const response = await axios.get(`${API_BASE}/fixtures`, {
      params: {
        status: 'LIVE',
      },
      headers: {
        'x-apisports-key': API_KEY,
      },
    });

    return response.data.response || [];
  } catch (error) {
    console.error('Error fetching live matches:', error.message);
    return [];
  }
}

// Get matches by league and date
export async function fetchMatchesByLeague(leagueId, date) {
  try {
    const response = await axios.get(`${API_BASE}/fixtures`, {
      params: {
        league: leagueId,
        season: new Date().getFullYear(),
        date,
      },
      headers: {
        'x-apisports-key': API_KEY,
      },
    });

    return response.data.response || [];
  } catch (error) {
    console.error('Error fetching matches by league:', error.message);
    return [];
  }
}

// Get odds for a match
export async function fetchOdds(matchId) {
  try {
    const response = await axios.get(`${API_BASE}/odds`, {
      params: {
        fixture: matchId,
        bookmaker: 'Bwin', // or your preferred bookmaker
      },
      headers: {
        'x-apisports-key': API_KEY,
      },
    });

    return response.data.response?.[0] || null;
  } catch (error) {
    console.error('Error fetching odds:', error.message);
    return null;
  }
}

// Sync match data to database
export async function syncMatchToDatabase(apiMatch) {
  const fixture = apiMatch.fixture || {};
  const goals = apiMatch.goals || {};
  const statistics = apiMatch.statistics || [];
  const teams = apiMatch.teams || {};

  const homeStats = statistics[0]?.statistics || [];
  const awayStats = statistics[1]?.statistics || [];

  const getStatValue = (stats, key) => {
    const stat = stats.find((s) => s.type === key);
    return stat ? (typeof stat.value === 'number' ? stat.value : parseInt(stat.value)) : 0;
  };

  try {
    // First, ensure teams exist in database
    const homeTeamId = teams.home?.id;
    const awayTeamId = teams.away?.id;

    if (homeTeamId) {
      await query(
        `INSERT INTO teams (api_id, name, logo_url, country)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (api_id) DO UPDATE SET name=$2, logo_url=$3
         WHERE teams.api_id = $1;`,
        [homeTeamId, teams.home?.name, teams.home?.logo, null]
      );
    }

    if (awayTeamId) {
      await query(
        `INSERT INTO teams (api_id, name, logo_url, country)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (api_id) DO UPDATE SET name=$2, logo_url=$3
         WHERE teams.api_id = $1;`,
        [awayTeamId, teams.away?.name, teams.away?.logo, null]
      );
    }

    const result = await query(
      `INSERT INTO matches 
      (api_id, home_team_id, away_team_id, home_team_name, away_team_name, status, kickoff_time, home_goals, away_goals,
       home_possession, away_possession, home_shots, away_shots, home_shots_on_target, 
       away_shots_on_target, home_xg, away_xg)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (api_id) DO UPDATE SET
      home_team_id=$2, away_team_id=$3,
      status=$6, home_goals=$8, away_goals=$9, home_possession=$10, away_possession=$11,
      home_shots=$12, away_shots=$13, home_shots_on_target=$14, away_shots_on_target=$15,
      home_xg=$16, away_xg=$17, updated_at=NOW()
     RETURNING id;`,
      [
        fixture.id,
        homeTeamId,
        awayTeamId,
        teams.home?.name,
        teams.away?.name,
        fixture.status,
        new Date(fixture.date),
        goals.home || 0,
        goals.away || 0,
        getStatValue(homeStats, 'Ball Possession') || 0,
        getStatValue(awayStats, 'Ball Possession') || 0,
        getStatValue(homeStats, 'Total Shots') || 0,
        getStatValue(awayStats, 'Total Shots') || 0,
        getStatValue(homeStats, 'Shots on Goal') || 0,
        getStatValue(awayStats, 'Shots on Goal') || 0,
        getStatValue(homeStats, 'expected_goals') || 0,
        getStatValue(awayStats, 'expected_goals') || 0,
      ],
    );

    return result.rows[0]?.id;
  } catch (error) {
    console.error('Error syncing match to database:', error.message);
    return null;
  }
}

// Get stored matches
export async function getStoredMatches(filters = {}) {
  let query_str = 'SELECT * FROM matches WHERE 1=1';
  const params = [];
  let paramCount = 1;

  if (filters.status) {
    query_str += ` AND status = $${paramCount++}`;
    params.push(filters.status);
  }

  if (filters.leagueId) {
    query_str += ` AND league_id = $${paramCount++}`;
    params.push(filters.leagueId);
  }

  query_str += ' ORDER BY kickoff_time DESC LIMIT 50';

  return await getAll(query_str, params);
}

// Get match details with full data
export async function getMatchDetails(matchId) {
  const match = await getOne('SELECT * FROM matches WHERE id = $1', [matchId]);

  if (!match) return null;

  const odds = await getOne('SELECT * FROM odds WHERE match_id = $1 ORDER BY updated_at DESC LIMIT 1', [matchId]);

  const recentBets = await getAll('SELECT * FROM bets WHERE match_id = $1 ORDER BY placed_at DESC LIMIT 10', [matchId]);

  const alerts = await getAll('SELECT * FROM alerts WHERE match_id = $1 ORDER BY sent_at DESC LIMIT 5', [matchId]);

  return {
    ...match,
    odds,
    recent_bets: recentBets,
    alerts,
  };
}
