import { offeredOddsForMarket } from './marketKeys.js';

// This is the displayed reference quote, never an assertion of the user's execution price.
export function captureDisplayedOdds(quote, fixtureId, marketKey, now = Date.now()) {
  const unavailable = { status: 'UNAVAILABLE', recordedAt: new Date(now).toISOString() };
  if (quote?.status !== 'AVAILABLE' || quote.source !== 'API_FOOTBALL'
    || String(quote.fixtureId) !== String(fixtureId) || quote.kind !== 'PRE_MATCH'
    || quote.period !== 'REGULATION' || !quote.bookmaker?.id || !quote.bookmaker?.name) return unavailable;
  const price = offeredOddsForMarket(quote.odds || {}, marketKey);
  const updated = Date.parse(quote.providerUpdatedAt), expires = Date.parse(quote.expiresAt);
  if (!(price > 1 && price < 10000) || !Number.isFinite(updated) || updated > now + 60000
    || !Number.isFinite(expires) || expires < updated) return unavailable;
  return { status: expires > now ? 'AVAILABLE' : 'EXPIRED', price, marketKey,
    fixtureId: String(fixtureId), source: quote.source, kind: quote.kind, period: quote.period,
    bookmaker: { id: String(quote.bookmaker.id), name: String(quote.bookmaker.name).slice(0, 100) },
    providerUpdatedAt: new Date(updated).toISOString(), expiresAt: new Date(expires).toISOString(),
    recordedAt: new Date(now).toISOString() };
}
