import { observedNumber } from '../../../shared/forecastMath.js';

// API-Football v3 prematch bet IDs. Live IDs and periods are a different namespace.
function marketKey(bet, value) {
  if (Number(bet.id) === 1 && bet.name === 'Match Winner') return { Home: 'home_win', Draw: 'draw', Away: 'away_win' }[value] || null;
  if (Number(bet.id) === 8 && bet.name === 'Both Teams Score' && value === 'Yes') return 'btts';
  if (Number(bet.id) === 5 && bet.name === 'Goals Over/Under') {
    const m = String(value).match(/^(Over|Under) ([0-4]\.5)$/);
    return m ? `${m[1].toLowerCase()}${m[2].replace('.', '')}` : null;
  }
  return null;
}

const aliases = { home_win: 'homeWin', away_win: 'awayWin' };
export function normalizePrematchOdds(payload, fixtureId, { now = Date.now(), maxAgeMs = 4 * 3600000, bookmakerId = null } = {}) {
  const empty = reason => ({ status: 'UNAVAILABLE', source: 'API_FOOTBALL', fixtureId: Number(fixtureId), reason, odds: {}, offers: [] });
  if (payload?.errors && Object.keys(payload.errors).length) return empty('PROVIDER_ERROR');
  if (!Array.isArray(payload?.response)) return empty('INVALID_RESPONSE');
  const offers = [];
  for (const row of payload.response) {
    if (String(row.fixture?.id) !== String(fixtureId)) continue;
    const updated = Date.parse(row.update);
    if (!Number.isFinite(updated) || updated > now + 60000 || now - updated > maxAgeMs) continue;
    for (const bookmaker of row.bookmakers || []) {
      if (bookmakerId != null && String(bookmaker.id) !== String(bookmakerId)) continue;
      if (!bookmaker.id || !bookmaker.name) continue;
      const odds = {};
      for (const bet of bookmaker.bets || []) for (const value of bet.values || []) {
        const key = marketKey(bet, value.value), price = observedNumber(value.odd);
        if (key && price > 1 && price < 10000 && !value.suspended && !bet.suspended) odds[aliases[key] || key] = price;
      }
      if (!Object.keys(odds).length) continue;
      offers.push({ status: 'AVAILABLE', source: 'API_FOOTBALL', fixtureId: Number(fixtureId), period: 'REGULATION',
        kind: 'PRE_MATCH', bookmaker: { id: bookmaker.id, name: bookmaker.name }, providerUpdatedAt: new Date(updated).toISOString(),
        fetchedAt: new Date(now).toISOString(), expiresAt: new Date(updated + maxAgeMs).toISOString(), odds });
    }
  }
  offers.sort((a,b) => Object.keys(b.odds).length - Object.keys(a.odds).length || Number(a.bookmaker.id) - Number(b.bookmaker.id));
  return offers.length ? { ...offers[0], offers } : empty('NO_CURRENT_SUPPORTED_ODDS');
}

export function isCurrentPrematchQuote(quote, fixtureId, now = Date.now()) {
  return quote?.status === 'AVAILABLE' && quote.source === 'API_FOOTBALL' && quote.kind === 'PRE_MATCH'
    && quote.period === 'REGULATION' && String(quote.fixtureId) === String(fixtureId)
    && Boolean(quote.bookmaker?.id) && Date.parse(quote.providerUpdatedAt) <= now + 60000
    && Date.parse(quote.expiresAt) > now;
}

export function createPrematchOddsService({ request, available = true, now = Date.now, dailyLimit = 120,
  cacheMs = 15 * 60000, maxAgeMs = 4 * 3600000, bookmakerId = null } = {}) {
  dailyLimit = Number.isFinite(dailyLimit) && dailyLimit >= 0 ? Math.floor(dailyLimit) : 120;
  const cache = new Map(), inFlight = new Map();
  let day = '', used = 0;
  const reset = () => { const stamp = new Date(now()).toISOString().slice(0,10); if (stamp !== day) { day = stamp; used = 0; } };
  const unavailable = reason => ({ status: 'UNAVAILABLE', source: 'API_FOOTBALL', reason, odds: {}, offers: [] });
  async function get(fixtureId, { canLaunch = () => true, onResponse = () => {} } = {}) {
    reset();
    if (!Number.isSafeInteger(Number(fixtureId)) || Number(fixtureId) <= 0) return unavailable('FIXTURE_ID_UNAVAILABLE');
    const key = String(fixtureId), cached = cache.get(key);
    if (cached && now() < cached.until && (cached.value.status !== 'AVAILABLE' || isCurrentPrematchQuote(cached.value,key,now()))) return cached.value;
    if (inFlight.has(key)) return inFlight.get(key);
    if (!available) return unavailable('API_NOT_CONFIGURED');
    if (!canLaunch()) return unavailable('QUOTA_PAUSED');
    if (used >= dailyLimit) return unavailable('ODDS_DAILY_BUDGET_REACHED');
    used++;
    const task = (async () => {
      let value;
      try {
        const response = await request('/odds', { params: { fixture: Number(fixtureId), page: 1 }, timeout: 4000 }, canLaunch);
        onResponse(response.headers);
        value = normalizePrematchOdds(response.data, fixtureId, { now: now(), maxAgeMs, bookmakerId });
      } catch (error) {
        if (error.response?.headers) onResponse(error.response.headers);
        value = unavailable('ODDS_REQUEST_UNAVAILABLE');
      }
      cache.set(key, { value, until: now() + (value.reason === 'ODDS_REQUEST_UNAVAILABLE' ? 60000 : cacheMs) });
      if (cache.size > 1500) cache.delete(cache.keys().next().value);
      return value;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key,task);
    return task;
  }
  return { get, status: () => { reset(); return { enabled: available, used, dailyLimit, cachedFixtures: cache.size, provider: 'API_FOOTBALL' }; } };
}
