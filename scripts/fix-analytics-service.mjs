import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('backend/src/services/analyticsService.js', 'utf8');

// ─── Fix 1: Remove standings call inside getTeamForm ─────────────────────────
// Already done via replace_string_in_file (succeeded). Skip if already fixed.
if (src.includes('const standings = league ? await getStandings(league)')) {
  src = src.replace(
    'const standings = league ? await getStandings(league).catch(() => null) : null;',
    '// Season context not available in a form-only fetch — do not guess from current date.\n    const standings = null;'
  );
}

// ─── Fix 2: Replace getStandings function ────────────────────────────────────
const standingsDocAndFunc = /\/\*\*\s*\n \* Get league standings[\s\S]*?^export async function getStandings[\s\S]*?^\}/m;

const newStandings = `/**
 * Get league standings with full multi-group/table resolution.
 *
 * @param {object} opts
 * @param {number}  opts.leagueId
 * @param {number}  opts.season      - Required; must come from fixture context, never inferred.
 * @param {number}  [opts.homeTeamId] - Used to select the relevant standings group.
 * @param {number}  [opts.awayTeamId]
 */
export async function getStandings({ leagueId, season, homeTeamId = null, awayTeamId = null } = {}) {
  if (!API_AVAILABLE) return offlineFallback('standings', leagueId);

  // Season is required — never guess from wall clock.
  if (season == null) {
    return { status: 'MISSING', reason: 'FIXTURE_SEASON_NOT_AVAILABLE', leagueId, season: null, teams: {}, totalTeams: 0 };
  }

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
}`;

if (standingsDocAndFunc.test(src)) {
  src = src.replace(standingsDocAndFunc, newStandings);
  console.log('getStandings replaced');
} else {
  console.error('ERROR: could not find getStandings function block');
  process.exit(1);
}

// ─── Fix 3: getTeamStatistics — add season param ─────────────────────────────
src = src.replace(
  /export async function getTeamStatistics\(teamId, leagueId\) \{\n  if \(!API_AVAILABLE\)[^\n]*\n  if \(!teamId \|\| !leagueId\)[^\n]*\n  try \{\n    const year = new Date\(\).getMonth\(\)[^\n]*\n    const key = cacheKey\('teamStats', teamId, leagueId, year\);/,
  `export async function getTeamStatistics(teamId, leagueId, season = null) {
  if (!API_AVAILABLE) return offlineFallback('teamStats', teamId, leagueId);
  if (!teamId || !leagueId) return offlineFallback('teamStats', teamId, leagueId);
  if (season == null) {
    return { status: 'MISSING', reason: 'FIXTURE_SEASON_NOT_AVAILABLE', teamId, leagueId };
  }
  try {
    const year = season;
    const key = cacheKey('teamStats', teamId, leagueId, year);`
);
console.log('getTeamStatistics updated');

// ─── Fix 4: getTeamInjuries — add season param ───────────────────────────────
src = src.replace(
  /export async function getTeamInjuries\(teamId, leagueId\) \{\n  if \(!API_AVAILABLE\)[^\n]*\n  if \(!teamId \|\| !leagueId\)[^\n]*\n  try \{\n    const year = new Date\(\).getMonth\(\)[^\n]*\n    const key = cacheKey\('injuries', teamId, leagueId, year\);/,
  `export async function getTeamInjuries(teamId, leagueId, season = null) {
  if (!API_AVAILABLE) return offlineFallback('injuries', teamId, leagueId);
  if (!teamId || !leagueId) return offlineFallback('injuries', teamId, leagueId);
  if (season == null) {
    return { status: 'MISSING', reason: 'FIXTURE_SEASON_NOT_AVAILABLE', teamId, leagueId };
  }
  try {
    const year = season;
    const key = cacheKey('injuries', teamId, leagueId, year);`
);
console.log('getTeamInjuries updated');

writeFileSync('backend/src/services/analyticsService.js', src, 'utf8');
console.log('analyticsService.js written successfully');
