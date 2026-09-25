/**
 * Cache key for the background analyst note of one fixture state.
 * Deliberately has no wall-clock component: a key that changes every minute
 * makes the narrative cache useless and re-spends API-Football calls on every click.
 */
export function buildNarrativeKey(matchData = {}) {
  const fixtureIdentity = matchData.fixtureId
    || matchData.id
    || `${String(matchData.home || '').toLowerCase()}|${String(matchData.away || '').toLowerCase()}|${matchData.season ?? ''}`;
  const status = String(matchData.status || 'NS').toUpperCase();
  const score = String(matchData.score || '0-0');
  const minute = Number(matchData.matchMinutes || 0);
  const live = status === 'LIVE' || ['1H', '2H', 'HT', 'ET', 'BT', 'P'].includes(status);
  const minuteBucket = live ? Math.floor(minute / 10) : 0;
  return Buffer.from(`${fixtureIdentity}|evidence-v106c|${status}|${score}|${minuteBucket}|${matchData.oddsSnapshot?.providerUpdatedAt || ''}`).toString('base64url');
}
