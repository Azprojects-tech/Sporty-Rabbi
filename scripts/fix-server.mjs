/**
 * Patches server.js for v10-data-integrity:
 * 1. Add `season` to sanitizeMatch output
 * 2. analyzeMatch() — null defaults for standings params; pass league.season to all service calls
 * 3. /api/analyze endpoint — pass season to getStandings, fix calibratedInputs, fix standings condition
 * 4. /api/analyze/live endpoint — null defaults
 * 5. Calibration matchData — null defaults for positions
 * 6. Calibration matchObj — null for pre-match possession/shots/xg
 * 7. calibratedInputs store — null defaults for standings fields
 */

import { readFileSync, writeFileSync } from 'fs';

let src = readFileSync('backend/src/server.js', 'utf8');

// ─── 1. sanitizeMatch: add season field ──────────────────────────────────────
src = src.replace(
  `    homeTeamId: match.homeTeamId || null,
    awayTeamId: match.awayTeamId || null,`,
  `    season: match.season ?? null,
    homeTeamId: match.homeTeamId || null,
    awayTeamId: match.awayTeamId || null,`
);
console.log('1. sanitizeMatch season field');

// ─── 2. analyzeMatch() — null defaults for standings params ──────────────────
src = src.replace(
  `      let homePosition = 10, awayPosition = 10, homePoints = 40, awayPoints = 40, totalTeams = 20;
      let gameWeek = 30;`,
  `      let homePosition = null, awayPosition = null, homePoints = null, awayPoints = null, totalTeams = null;
      let gameWeek = null;`
);
console.log('2a. analyzeMatch null defaults');

// Squad integrity defaults
src = src.replace(
  `      let homeSquadIntegrity = 85, awaySquadIntegrity = 85;`,
  `      let homeSquadIntegrity = null, awaySquadIntegrity = null;`
);
console.log('2b. analyzeMatch squad integrity null');

// Pass league.season to getStandings in analyzeMatch
src = src.replace(
  `          getStandings(league.id),\n          getTeamStatistics(homeTeamId, league.id),\n          getTeamStatistics(awayTeamId, league.id),\n          getTeamInjuries(homeTeamId, league.id),\n          getTeamInjuries(awayTeamId, league.id),`,
  `          getStandings({ leagueId: league.id, season: league.season ?? null, homeTeamId, awayTeamId }),\n          getTeamStatistics(homeTeamId, league.id, league.season ?? null),\n          getTeamStatistics(awayTeamId, league.id, league.season ?? null),\n          getTeamInjuries(homeTeamId, league.id, league.season ?? null),\n          getTeamInjuries(awayTeamId, league.id, league.season ?? null),`
);
console.log('2c. analyzeMatch pass season to service calls');

// Fix condition for standings availability in analyzeMatch
src = src.replace(
  `        if (standingsRes.status === 'fulfilled' && !standingsRes.value?.offline && standingsRes.value?.teams) {
          const tms = standingsRes.value.teams;
          totalTeams = standingsRes.value.totalTeams || 20;
          if (tms[homeTeamId]) { homePosition = tms[homeTeamId].position; homePoints = tms[homeTeamId].points; }
          if (tms[awayTeamId]) { awayPosition = tms[awayTeamId].position; awayPoints = tms[awayTeamId].points; }
          const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
          if (played > 0) gameWeek = played;
        }`,
  `        if (standingsRes.status === 'fulfilled' && standingsRes.value?.status === 'AVAILABLE' && standingsRes.value?.teams) {
          const tms = standingsRes.value.teams;
          totalTeams = standingsRes.value.totalTeams || null;
          if (tms[homeTeamId]) { homePosition = tms[homeTeamId].position ?? null; homePoints = tms[homeTeamId].points ?? null; }
          if (tms[awayTeamId]) { awayPosition = tms[awayTeamId].position ?? null; awayPoints = tms[awayTeamId].points ?? null; }
          const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
          if (played > 0) gameWeek = played;
        }`
);
console.log('2d. analyzeMatch standings condition fix');

// Add season to analyzed object in analyzeMatch (after leagueCountry line)
src = src.replace(
  `      leagueCountry: league.country || '',\n      homePosition,\n      awayPosition,\n      homePoints,\n      awayPoints,\n      totalTeams,`,
  `      leagueCountry: league.country || '',\n      season: league.season ?? null,\n      homePosition,\n      awayPosition,\n      homePoints,\n      awayPoints,\n      totalTeams,`
);
console.log('2e. analyzeMatch add season to analyzed object');

// ─── 3. /api/analyze endpoint — pass season, fix standings condition ──────────
// Update getStandings call in /api/analyze
src = src.replace(
  `        getH2H(homeTeamId, awayTeamId),
        getStandings(leagueId),
      ]);
      if (hRes.status === 'fulfilled' && !hRes.value?.offline && hRes.value?.stats) {`,
  `        getH2H(homeTeamId, awayTeamId),
        getStandings({ leagueId, season: body.season ?? body.fixtureContext?.season ?? null, homeTeamId, awayTeamId }),
      ]);
      if (hRes.status === 'fulfilled' && !hRes.value?.offline && hRes.value?.stats) {`
);
console.log('3a. /api/analyze getStandings with season');

// Fix standings condition in /api/analyze
src = src.replace(
  `      if (standingsRes.status === 'fulfilled' && !standingsRes.value?.offline && standingsRes.value?.teams) {
        const tms = standingsRes.value.teams;
        enriched.totalTeams = standingsRes.value.totalTeams || 20;
        if (tms[homeTeamId]) { enriched.homePosition = tms[homeTeamId].position; enriched.homePoints = tms[homeTeamId].points; }
        if (tms[awayTeamId]) { enriched.awayPosition = tms[awayTeamId].position; enriched.awayPoints = tms[awayTeamId].points; }
        const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
        if (played > 0) enriched.gameWeek = played;
        standingsStatus = { status: 'available', source: 'api-football-standings' };
      }`,
  `      if (standingsRes.status === 'fulfilled' && standingsRes.value?.status === 'AVAILABLE' && standingsRes.value?.teams) {
        const tms = standingsRes.value.teams;
        enriched.totalTeams = standingsRes.value.totalTeams || null;
        if (tms[homeTeamId]) { enriched.homePosition = tms[homeTeamId].position ?? null; enriched.homePoints = tms[homeTeamId].points ?? null; }
        if (tms[awayTeamId]) { enriched.awayPosition = tms[awayTeamId].position ?? null; enriched.awayPoints = tms[awayTeamId].points ?? null; }
        const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
        if (played > 0) enriched.gameWeek = played;
        standingsStatus = { status: 'available', source: 'api-football-standings' };
      }`
);
console.log('3b. /api/analyze standings condition fix');

// Remove calibratedInputs restoring standings fields
src = src.replace(
  `      if (!enriched.homePosition)              enriched.homePosition        = ci.homePosition;
      if (!enriched.awayPosition)              enriched.awayPosition        = ci.awayPosition;
      if (!enriched.homePoints)                enriched.homePoints          = ci.homePoints;
      if (!enriched.awayPoints)                enriched.awayPoints          = ci.awayPoints;
      if (!enriched.totalTeams)                enriched.totalTeams          = ci.totalTeams;
      if (!enriched.gameWeek)                  enriched.gameWeek            = ci.gameWeek;`,
  `      // standings (position/points/totalTeams/gameWeek) must never be restored from
      // a calibration cache — those values may belong to a different season.`
);
console.log('3c. Remove calibratedInputs standings restore');

// ─── 4. /api/analyze/live endpoint — null defaults ───────────────────────────
src = src.replace(
  `    let homePosition = 10, awayPosition = 10, homePoints = 40, awayPoints = 40, totalTeams = 20, gameWeek = 30;`,
  `    let homePosition = null, awayPosition = null, homePoints = null, awayPoints = null, totalTeams = null, gameWeek = null;`
);
console.log('4a. /api/analyze/live null defaults');

// Fix condition check in /api/analyze/live
src = src.replace(
  `    let homePosition = null, awayPosition = null, homePoints = null, awayPoints = null, totalTeams = null, gameWeek = null;
    if (standingsRes.status === 'fulfilled' && !standingsRes.value?.offline && standingsRes.value?.teams) {
      const tms = standingsRes.value.teams;
      totalTeams = standingsRes.value.totalTeams || 20;
      if (tms[homeTeamId]) { homePosition = tms[homeTeamId].position; homePoints = tms[homeTeamId].points; }
      if (tms[awayTeamId]) { awayPosition = tms[awayTeamId].position; awayPoints = tms[awayTeamId].points; }
      const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
      if (played > 0) gameWeek = played;
    }`,
  `    let homePosition = null, awayPosition = null, homePoints = null, awayPoints = null, totalTeams = null, gameWeek = null;
    if (standingsRes.status === 'fulfilled' && standingsRes.value?.status === 'AVAILABLE' && standingsRes.value?.teams) {
      const tms = standingsRes.value.teams;
      totalTeams = standingsRes.value.totalTeams || null;
      if (tms[homeTeamId]) { homePosition = tms[homeTeamId].position ?? null; homePoints = tms[homeTeamId].points ?? null; }
      if (tms[awayTeamId]) { awayPosition = tms[awayTeamId].position ?? null; awayPoints = tms[awayTeamId].points ?? null; }
      const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
      if (played > 0) gameWeek = played;
    }`
);
console.log('4b. /api/analyze/live standings condition fix');

// Pass season in /api/analyze/live getStandings call
src = src.replace(
  `      getStandings(leagueId),\n      getTeamStatistics(homeTeamId, leagueId),\n      getTeamStatistics(awayTeamId, leagueId),\n      getTeamInjuries(homeTeamId, leagueId),\n      getTeamInjuries(awayTeamId, leagueId),\n    ]);`,
  `      getStandings({ leagueId, season: match.season ?? null, homeTeamId, awayTeamId }),\n      getTeamStatistics(homeTeamId, leagueId, match.season ?? null),\n      getTeamStatistics(awayTeamId, leagueId, match.season ?? null),\n      getTeamInjuries(homeTeamId, leagueId, match.season ?? null),\n      getTeamInjuries(awayTeamId, leagueId, match.season ?? null),\n    ]);`
);
console.log('4c. /api/analyze/live pass season to service calls');

// ─── 5. Calibration matchData — null defaults for positions ──────────────────
src = src.replace(
  `        homePosition:      f.home?.leaguePosition  || f.context?.homePosition  || matchMeta.homePosition  || 10,
        awayPosition:      f.away?.leaguePosition  || f.context?.awayPosition  || matchMeta.awayPosition  || 10,
        homePoints:        f.context?.homePoints   || matchMeta.homePoints   || 40,
        awayPoints:        f.context?.awayPoints   || matchMeta.awayPoints   || 40,`,
  `        homePosition:      f.home?.leaguePosition  ?? f.context?.homePosition  ?? matchMeta.homePosition  ?? null,
        awayPosition:      f.away?.leaguePosition  ?? f.context?.awayPosition  ?? matchMeta.awayPosition  ?? null,
        homePoints:        f.context?.homePoints   ?? matchMeta.homePoints   ?? null,
        awayPoints:        f.context?.awayPoints   ?? matchMeta.awayPoints   ?? null,`
);
console.log('5a. Calibration matchData null position defaults');

src = src.replace(
  `        gameWeek:          f.context?.gameWeek     || matchMeta.gameWeek     || 30,`,
  `        gameWeek:          f.context?.gameWeek     ?? matchMeta.gameWeek     ?? null,`
);
console.log('5b. Calibration matchData null gameWeek default');

// Fix homePossession default in calibration matchData
src = src.replace(
  `        homePossession:    hRealStats?.avgPossession ?? 50,`,
  `        homePossession:    hRealStats?.avgPossession ?? null,`
);
console.log('5c. Calibration homePossession null default');

// ─── 6. Calibration matchObj — null for pre-match possession/shots/xg ────────
src = src.replace(
  `        possession: { home: 50, away: 50 },
        shots: { home: 0, away: 0 },
        xg: { home: f.home?.xgAvg || 1.2, away: f.away?.xgAvg || 1.0 },`,
  `        possession: { home: null, away: null },
        shots: { home: null, away: null },
        xg: { home: f.home?.xgAvg ?? null, away: f.away?.xgAvg ?? null },`
);
console.log('6. Calibration matchObj null pre-match stats');

// ─── 7. calibratedInputs store — null defaults for standings fields ───────────
src = src.replace(
  `        homePosition:        matchData.homePosition        ?? 10,
        awayPosition:        matchData.awayPosition        ?? 10,
        homePoints:          matchData.homePoints          ?? 40,
        awayPoints:          matchData.awayPoints          ?? 40,
        totalTeams:          matchData.totalTeams          ?? 20,
        gameWeek:            matchData.gameWeek            ?? 30,
        homeSquadIntegrity:  matchData.homeSquadIntegrity  ?? 85,
        awaySquadIntegrity:  matchData.awaySquadIntegrity  ?? 85,`,
  `        homePosition:        matchData.homePosition        ?? null,
        awayPosition:        matchData.awayPosition        ?? null,
        homePoints:          matchData.homePoints          ?? null,
        awayPoints:          matchData.awayPoints          ?? null,
        totalTeams:          matchData.totalTeams          ?? null,
        gameWeek:            matchData.gameWeek            ?? null,
        homeSquadIntegrity:  matchData.homeSquadIntegrity  ?? null,
        awaySquadIntegrity:  matchData.awaySquadIntegrity  ?? null,`
);
console.log('7. calibratedInputs null defaults');

writeFileSync('backend/src/server.js', src, 'utf8');
console.log('\nserver.js written successfully');

// Verify key changes
const verify = readFileSync('backend/src/server.js', 'utf8');
console.log('\nVerification:');
console.log('  null position default:', verify.includes('let homePosition = null, awayPosition = null'));
console.log('  season in sanitizeMatch:', verify.includes('season: match.season ?? null'));
console.log('  getStandings with season:', verify.includes("getStandings({ leagueId: league.id, season: league.season ?? null"));
console.log('  calibratedInputs standings removed:', verify.includes('standings (position/points/totalTeams/gameWeek) must never be restored'));
console.log('  pre-match null possession:', verify.includes('possession: { home: null, away: null }'));
