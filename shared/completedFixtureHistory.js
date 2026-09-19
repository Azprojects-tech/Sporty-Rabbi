import { finalScoreFromProviderFixture } from './forecastMath.js';

// Normalize once before deriving form or rates. Missing goals are never 0-0;
// cup extra-time goals must not leak into regulation-goal averages.
export function completedFixtureHistory(rows, { teamId, leagueId, season, before = Date.now() } = {}) {
  const cutoff = typeof before === 'number' ? before : Date.parse(before);
  if (!Number.isFinite(cutoff) || teamId == null) return [];
  const seen = new Set();
  return (Array.isArray(rows) ? rows : []).filter(r => {
    const id = r?.fixture?.id, date = Date.parse(r?.fixture?.date);
    if (!id || seen.has(String(id)) || !Number.isFinite(date) || date >= cutoff
      || ![r.teams?.home?.id,r.teams?.away?.id].some(x=>x != null && String(x) === String(teamId))
      || (leagueId != null && String(r.league?.id) !== String(leagueId))
      || (season != null && String(r.league?.season) !== String(season))
      || !finalScoreFromProviderFixture(r)) return false;
    seen.add(String(id)); return true;
  }).sort((a,b)=>Date.parse(b.fixture.date)-Date.parse(a.fixture.date)).slice(0,10)
    .map(r=>{const s=finalScoreFromProviderFixture(r); return {...r,goals:{home:s.home,away:s.away}};});
}
