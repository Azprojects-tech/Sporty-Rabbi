import { completedFixtureHistory } from '../../../shared/completedFixtureHistory.js';
import { createPrematchOddsService } from './prematchOddsService.js';
/**
 * Team & H2H Analytics Service
 * Fetches historical data for informed betting decisions
 *
 * ⚠️  OFFLINE MODE: When API_FOOTBALL_KEY is not set (or subscription is expired),
 * all functions return structured fallback objects so the rest of the server keeps
 * running.  Re-connect by setting a valid API_FOOTBALL_KEY in backend/.env.
 */

import axios from 'axios';
import { summarizeLateGoals } from './groundedAnalystService.js';
import { buildTeamEvidence, compactFixtureRows, MIN_COMPETITION_SAMPLE } from '../../../shared/teamEvidence.js';
import { parseLeagueCoverage } from '../../../shared/leagueCoverage.js';

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


// V10.2 request orchestration.
// - identical simultaneous requests share one Promise
// - unique API-Football requests are launched with a small global gap
// - one 429 opens a short local circuit instead of allowing a burst of repeated failures
const analyticsInFlight = new Map();
const ANALYTICS_MIN_REQUEST_GAP_MS = Math.max(
  100,
  Number(process.env.ANALYTICS_MIN_REQUEST_GAP_MS || 300),
);
const ANALYTICS_429_COOLDOWN_MS = Math.max(
  15000,
  Number(process.env.ANALYTICS_429_COOLDOWN_MS || 60000),
);
let analyticsNextLaunchAt = 0;
let analyticsRateLimitedUntil = 0;

function stableParamsKey(params = {}) {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${JSON.stringify(params[k])}`)
    .join('&');
}

async function waitForAnalyticsLaunchSlot() {
  const now = Date.now();
  const launchAt = Math.max(now, analyticsNextLaunchAt);
  analyticsNextLaunchAt = launchAt + ANALYTICS_MIN_REQUEST_GAP_MS;
  const delay = launchAt - now;
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function singleFlightGet(url, config = {}, canLaunch = () => true) {
  const key = `${url}?${stableParamsKey(config.params || {})}`;
  if (analyticsInFlight.has(key)) {
    return analyticsInFlight.get(key);
  }

  const request = (async () => {
    if (Date.now() < analyticsRateLimitedUntil) {
      const waitMs = analyticsRateLimitedUntil - Date.now();
      const err = new Error(`API_FOOTBALL_RATE_LIMIT_COOLDOWN:${waitMs}`);
      err.code = 'API_FOOTBALL_RATE_LIMIT_COOLDOWN';
      throw err;
    }

    await waitForAnalyticsLaunchSlot();
    if (!canLaunch()) throw new Error('API_QUOTA_GUARD_PAUSED');

    // A previous queued request may have opened the 429 circuit while this
    // request was waiting for its launch slot. Re-check immediately before I/O.
    if (Date.now() < analyticsRateLimitedUntil) {
      const waitMs = analyticsRateLimitedUntil - Date.now();
      const err = new Error(`API_FOOTBALL_RATE_LIMIT_COOLDOWN:${waitMs}`);
      err.code = 'API_FOOTBALL_RATE_LIMIT_COOLDOWN';
      throw err;
    }

    try {
      return await axiosInstance.request({
        method: 'get',
        url,
        ...config,
      });
    } catch (err) {
      if (err?.response?.status === 429) {
        analyticsRateLimitedUntil = Date.now() + ANALYTICS_429_COOLDOWN_MS;
        console.warn(
          `[Analytics API] 429 received — pausing analytics requests for ${Math.round(ANALYTICS_429_COOLDOWN_MS / 1000)}s`
        );
      }
      throw err;
    }
  })().finally(() => {
    analyticsInFlight.delete(key);
  });

  analyticsInFlight.set(key, request);
  return request;
}

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
    const response = await singleFlightGet('/players/squads', { params: { team: teamId } });
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

const TEAM_FIXTURES_TTL_MS = 6 * 3600000;
const FORM_FALLBACK_ENABLED = String(process.env.ENABLE_FORM_FALLBACK ?? 'true').toLowerCase() !== 'false';

// Cached compact rows of completed fixtures (key prefix 'teamFixtures' — the old
// 'form' entries had a different shape and are simply no longer read).
async function getTeamFixtureRows(key, params) {
  const cached = getCache(key);
  if (Array.isArray(cached)) return cached;
  const response = await singleFlightGet('/fixtures', { params });
  if (response.data?.errors && Object.keys(response.data.errors).length) throw new Error('Fixture history unavailable');
  const rows = compactFixtureRows(response.data?.response);
  // 6-hour TTL (same timestamp-shift convention as standings/team statistics).
  statsCache.set(key, { data: rows, timestamp: Date.now() - (CACHE_TTL - TEAM_FIXTURES_TTL_MS) });
  return rows;
}

/**
 * Team form and goal rates for the model.
 *
 * - Primary: last 10 completed games in the fixture's competition and season.
 * - Only games that finished before `before` (the fixture kickoff) count.
 * - If fewer than 5 primary games exist and `allowFallback` is true, ONE extra
 *   call fetches the team's last 20 games in any competition; those (and last
 *   season's games) are added at half weight and the result is labelled ESTIMATED.
 * - No games → averages and form are null (never 0 / 'Unavailable').
 */
export async function getTeamForm(teamId, league = null, season = null, { before = null, allowFallback = true } = {}) {
  if (!API_AVAILABLE) return offlineFallback('teamForm', teamId, league);
  try {
    const params = { team: teamId, last: 10 };
    if (league) params.league = league;
    // Filter to the exact fixture season — prevents cross-season form contamination.
    if (season != null) params.season = season;
    const primaryRows = await getTeamFixtureRows(cacheKey('teamFixtures', teamId, league ?? '', season ?? ''), params);

    const cutoff = before ?? Date.now();
    let fallbackRows = [];
    let fallbackStatus = 'not_needed';
    const primaryBeforeKickoff = buildTeamEvidence({ teamId, leagueId: league || null, season, before: cutoff, primaryRows });
    if (primaryBeforeKickoff.evidence.competitionSeason < MIN_COMPETITION_SAMPLE) {
      // allowFallback may be a budget callback (daily prep) or a boolean.
      const fallbackAllowed = typeof allowFallback === 'function' ? allowFallback() : Boolean(allowFallback);
      if (FORM_FALLBACK_ENABLED && fallbackAllowed) {
        try {
          fallbackRows = await getTeamFixtureRows(cacheKey('teamFixtures', teamId, 'all'), { team: teamId, last: 20 });
          fallbackStatus = 'used';
        } catch (err) {
          fallbackStatus = 'unavailable';
          console.warn(`[TeamForm] fallback history unavailable for team ${teamId}: ${err.message}`);
        }
      } else {
        fallbackStatus = 'skipped';
      }
    }

    const built = fallbackRows.length
      ? buildTeamEvidence({ teamId, leagueId: league || null, season, before: cutoff, primaryRows, fallbackRows })
      : primaryBeforeKickoff;
    const first = built.matches[0];
    return {
      teamId,
      teamName: first ? (String(first.homeTeamId) === String(teamId) ? first.home : first.away) : null,
      matches: built.matches,
      stats: built.stats,
      evidence: { ...built.evidence, fallbackStatus },
      season: season ?? null,
    };
  } catch (error) {
    console.error('❌ Error fetching team form:', error.message);
    return {
      teamId,
      matches: [],
      stats: { error: 'Could not fetch data' },
    };
  }
}

const LEAGUE_COVERAGE_TTL_MS = 24 * 3600000;

/**
 * Provider coverage flags for a league/season (standings, injuries, odds,
 * fixture statistics). One /leagues?current=true call per day covers every
 * league; a season that is not the current one falls back to one cached
 * /leagues?id= call. Returns null when unknown (callers then allow the call).
 */
export async function getLeagueCoverage(leagueId, season = null, { canLaunch = () => true } = {}) {
  if (!API_AVAILABLE || !leagueId) return null;
  try {
    const currentKey = cacheKey('coverage', 'current');
    let current = getCache(currentKey);
    if (!current && canLaunch()) {
      const response = await singleFlightGet('/leagues', { params: { current: 'true' } }, canLaunch);
      current = parseLeagueCoverage(response.data?.response);
      if (Object.keys(current).length) {
        statsCache.set(currentKey, { data: current, timestamp: Date.now() - (CACHE_TTL - LEAGUE_COVERAGE_TTL_MS) });
      }
    }
    const hit = current?.[String(leagueId)];
    if (hit && (season == null || String(hit.season) === String(season))) return hit;

    const leagueKey = cacheKey('leagueCoverage', leagueId, season ?? '');
    const cached = getCache(leagueKey);
    if (cached) return cached.coverage;
    if (!canLaunch()) return null;
    const response = await singleFlightGet('/leagues', { params: { id: leagueId } }, canLaunch);
    const coverage = parseLeagueCoverage(response.data?.response, { preferSeason: season })[String(leagueId)] || null;
    statsCache.set(leagueKey, { data: { coverage }, timestamp: Date.now() - (CACHE_TTL - LEAGUE_COVERAGE_TTL_MS) });
    return coverage;
  } catch (err) {
    console.warn(`[Coverage] league ${leagueId} coverage unavailable: ${err.message}`);
    return null;
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

    const response = await singleFlightGet('/fixtures/headtohead', {
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
    const response = await singleFlightGet('/standings', { params: { league: leagueId, season } });

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

    const response = await singleFlightGet('/teams/statistics', {
      params: { team: teamId, league: leagueId, season: year },
    });
    const s = response.data.response;
    if (!s) return offlineFallback('teamStats', teamId, leagueId);

    // /teams/statistics carries goals, results and minute buckets — it has NO
    // shots or possession fields, so none are derived here (they were always null).
    const played        = s.fixtures?.played?.total    ?? null;
    const goalsFor      = s.goals?.for?.total?.total    ?? null;

    // Late-goal % — only compute when the minute-bucket structure AND goal count are present.
    const goalsByMinute = s.goals?.for?.minute ?? null;
    const lateGoalPct = (goalsByMinute != null && goalsFor != null && goalsFor > 0)
      ? (goalsByMinute['76-90']?.total != null ? +(Number(goalsByMinute['76-90'].total) / goalsFor).toFixed(3) : null)
      : null;

    const result = {
      teamId, leagueId,
      stats: { played, lateGoalPct,
        seasonRecord: { played, wins: s.fixtures?.wins?.total ?? null, draws: s.fixtures?.draws?.total ?? null,
          losses: s.fixtures?.loses?.total ?? null } },
    };
    // 6-hour cache
    statsCache.set(key, { data: result, timestamp: Date.now() - (CACHE_TTL - 6 * 3600000) });
    return result;
  } catch (err) {
    console.error('❌ Error fetching team statistics:', err.message);
    return offlineFallback('teamStats', teamId, leagueId);
  }
}

// Deliberate-click narrative enrichment only. No background poller or fabricated news.
// At most 27 uncached calls per click (10 event histories/team + season + prior
// records + coaches/transfers), shared cache and a separate daily ceiling.
const analystEvidenceCache = new Map();
let analystEvidenceDay = '';
let analystEvidenceCalls = 0;
const configuredAnalystLimit = Number(process.env.ANALYST_CONTEXT_DAILY_CALL_LIMIT ?? 160);
const ANALYST_CONTEXT_DAILY_CALL_LIMIT = Number.isFinite(configuredAnalystLimit)
  ? Math.min(500, Math.max(0, Math.floor(configuredAnalystLimit))) : 160;

export async function getAnalystEvidence(match, { shouldSkipApiCalls = () => true, updateQuotaFromHeaders = () => {} } = {}) {
  if (!API_AVAILABLE || match.enrich === false || !match.homeTeamId || !match.awayTeamId || shouldSkipApiCalls()) return { status: 'unavailable' };
  const keyDate = new Date().toISOString().slice(0, 10);
  if (analystEvidenceDay !== keyDate) { analystEvidenceDay = keyDate; analystEvidenceCalls = 0; }
  const request = async (url, params) => {
    const key = `${url}?${stableParamsKey(params)}`;
    const cached = analystEvidenceCache.get(key);
    if (cached && Date.now() - cached.at < ((url === '/fixtures/lineups' || String(params.fixture) === String(match.id)) ? 60000 : 12 * 3600000)) return cached.data;
    if (shouldSkipApiCalls() || analystEvidenceCalls >= ANALYST_CONTEXT_DAILY_CALL_LIMIT) return null;
    analystEvidenceCalls++;
    try {
      const res = await singleFlightGet(url, { params }, () => !shouldSkipApiCalls());
      updateQuotaFromHeaders(res.headers);
      if (res.data?.errors && Object.keys(res.data.errors).length) return null;
      const data = res.data?.response ?? null;
      if (data != null) {
        if (analystEvidenceCache.size >= 1500) analystEvidenceCache.delete(analystEvidenceCache.keys().next().value);
        analystEvidenceCache.set(key, { at: Date.now(), data });
      }
      return data;
    } catch (err) { if (err.response?.headers) updateQuotaFromHeaders(err.response.headers); return null; }
  };
  const leagueId = match.leagueId, season = Number(match.season);
  if (!leagueId || match.season == null || !Number.isInteger(season)) return { status: 'unavailable' };
  const leagues = await request('/leagues', { id: leagueId });
  const league = Array.isArray(leagues) ? leagues.find((l) => String(l.league?.id) === String(leagueId)) : null;
  const seasonDates = league?.seasons?.find((s) => s.year === season) || null;
  const out = { status: 'partial', season: seasonDates,
    competitionType: league?.league?.type ?? null,
    previousSeason: league?.seasons?.find((s) => s.year === season - 1) || null, home: {}, away: {} };
  out.checkedAt = new Date().toISOString();
  if (match.id) {
    out.lineups = await request('/fixtures/lineups', { fixture: match.id });
    if (['LIVE','1H','2H','HT','ET','FT','AET','PEN'].includes(match.status))
      out.currentEvents = await request('/fixtures/events', { fixture: match.id });
    out.injuries = await request('/injuries', { fixture: match.id });
  }
  for (const side of ['home', 'away']) {
    out[side].coaches = await request('/coachs', { team: match[`${side}TeamId`] });
  }
  // Never classify cup records as league form or compare mixed competitions.
  if (league?.league?.type !== 'League') return out;
  const cutoff = Date.parse(match.kickoffUTC) || Date.now();
  const eventResults = new Map();
  const fixtureLists = {};
  for (const side of ['home', 'away']) {
    const id = match[`${side}TeamId`];
    if (!id) continue;
    const fixtures = (match[`${side}RecentFixtures`] || []).filter((f) => f.id
      && f.status?.short === 'FT' && String(f.leagueId) === String(leagueId) && f.season === season
      && [f.homeTeamId, f.awayTeamId].some((tid) => String(tid) === String(id))
      && Date.parse(f.date) < cutoff).sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 10);
    fixtureLists[side] = fixtures;
    out[side].recentFixtures = fixtures;
    if (fixtures[0]) out[side].previousLineups = await request('/fixtures/lineups', { fixture: fixtures[0].id });
  }
  // Interleave teams, so a quota boundary does not favour the home side.
  for (let i = 0; i < 10; i++) for (const side of ['home', 'away']) {
    const fixture = fixtureLists[side]?.[i];
    if (!fixture || eventResults.has(String(fixture.id))) continue;
    const events = await request('/fixtures/events', { fixture: fixture.id });
    if (Array.isArray(events)) eventResults.set(String(fixture.id), { events });
  }
  for (const side of ['home', 'away']) {
    const id = match[`${side}TeamId`];
    if (!id) continue;
    out[side].lateGoals = summarizeLateGoals(id, fixtureLists[side] || [], eventResults);
    const previous = await request('/teams/statistics', { team: id, league: leagueId, season: season - 1 });
    out[side].previousRecord = previous?.fixtures ? { played: previous.fixtures.played?.total ?? null,
      wins: previous.fixtures.wins?.total ?? null, draws: previous.fixtures.draws?.total ?? null } : null;
    out[side].transfers = await request('/transfers', { team: id });
  }
  return out;
}

/**
 * Get active injury/suspension count and derive squad integrity score.
 * Cached 2 hours — squad availability can change before match day.
 */
export async function getTeamInjuries(teamId, leagueId, season = null, fixtureId = null) {
  if (!API_AVAILABLE) return offlineFallback('injuries', teamId, leagueId);
  if (!teamId || !leagueId) return offlineFallback('injuries', teamId, leagueId);
  if (!fixtureId) return { status: 'MISSING', reason: 'FIXTURE_ID_NOT_AVAILABLE', squadIntegrity: null };
  try {
    const year = season;
    const key = cacheKey('injuries', teamId, leagueId, fixtureId);
    const cached = getCache(key);
    if (cached) return cached;

    const response = await singleFlightGet('/injuries', {
      params: { fixture: fixtureId, team: teamId },
    });
    if (response.data?.errors && Object.keys(response.data.errors).length) throw new Error('Injury evidence unavailable');
    const injuries = (response.data.response || []).filter(i => String(i.fixture?.id) === String(fixtureId) && String(i.team?.id) === String(teamId));
    const active = injuries.filter(i => {
      const type = (i.player?.type || '').toLowerCase();
      return type === 'injury' || type === 'suspension' || type === 'missing fixture';
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

    // An absence list does not measure player ability or full-squad strength.
    const result = { teamId, leagueId, injuryCount, squadIntegrity: null, keyAbsences, status: 'PARTIAL' };
    // 2-hour cache
    statsCache.set(key, { data: result, timestamp: Date.now() - (CACHE_TTL - 2 * 3600000) });
    return result;
  } catch (err) {
    console.error('❌ Error fetching team injuries:', err.message);
    return offlineFallback('injuries', teamId, leagueId);
  }
}


// Uses the existing subscription, request pacing and 429 circuit.
const prematchOdds = createPrematchOddsService({ request: singleFlightGet,
  available: API_AVAILABLE && String(process.env.ENABLE_PREMATCH_ODDS || 'true') !== 'false',
  dailyLimit: Math.max(0, Number(process.env.ODDS_DAILY_CALL_BUDGET || 120)),
  bookmakerId: process.env.ODDS_BOOKMAKER_ID || null,
});
export const getPrematchOdds = (fixtureId, options) => prematchOdds.get(fixtureId, options);
export const getPrematchOddsStatus = () => prematchOdds.status();

// Reuses request pacing and the 429 circuit for old user bets as well as today's games.
export async function getSettlementFixture(id, { shouldSkipApiCalls, updateQuotaFromHeaders }) {
  if (!API_AVAILABLE || shouldSkipApiCalls()) return null;
  const response = await singleFlightGet('/fixtures', { params: { id }, timeout: 4000 }, () => !shouldSkipApiCalls());
  updateQuotaFromHeaders(response.headers);
  if (response.data?.errors && Object.keys(response.data.errors).length) throw new Error('Fixture result unavailable');
  return response.data?.response?.find(f => String(f.fixture?.id) === String(id)) || null;
}
