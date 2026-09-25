/**
 * Fixture status helpers shared by the server feed and tests.
 *
 * The daily schedule is prepared once in the morning, so without an overlay a
 * 15:00 match would still say "NS" at 18:00. The server keeps a small
 * id → {status, minute, score} overlay fed by the live poll and by a periodic
 * /fixtures?date= refresh, and applies it to every feed it serves.
 */
export const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);
export const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
export const VOID_STATUSES = new Set(['PST', 'CANC', 'ABD', 'AWD', 'WO']);
export const PREMATCH_STATUSES = new Set(['NS', 'TBD']);

const code = (s) => String(s ?? '').toUpperCase();
export const isLiveStatus = (s) => LIVE_STATUSES.has(code(s));
export const isFinishedStatus = (s) => FINISHED_STATUSES.has(code(s));
export const isVoidStatus = (s) => VOID_STATUSES.has(code(s));
export const isPrematchStatus = (s) => s == null || s === '' || PREMATCH_STATUSES.has(code(s));

/** True once kickoff time has passed (whatever the stored status says). */
export function hasKickedOff(match, now = Date.now()) {
  const ko = Date.parse(match?.kickoffUTC ?? match?.date ?? '');
  return Number.isFinite(ko) && ko <= now;
}

/** Predictions are locked from kickoff onwards, or once the provider reports any non-prematch status. */
export function isPredictionLocked(match, now = Date.now()) {
  return hasKickedOff(match, now) || (match?.status != null && !isPrematchStatus(match.status));
}

/** Provider /fixtures row → overlay entry. */
export function statusEntryFromProviderFixture(row, now = Date.now()) {
  const id = row?.fixture?.id;
  const status = row?.fixture?.status?.short;
  if (!id || !status) return null;
  const home = row?.goals?.home;
  const away = row?.goals?.away;
  return {
    id: String(id),
    status: code(status),
    matchMinutes: Number.isFinite(row?.fixture?.status?.elapsed) ? row.fixture.status.elapsed : 0,
    score: Number.isFinite(home) && Number.isFinite(away) ? `${home}-${away}` : null,
    updatedAt: now,
  };
}

/** Parsed live-feed match ({id,status,matchMinutes,score}) → overlay entry. */
export function statusEntryFromLiveMatch(m, now = Date.now()) {
  if (!m?.id || !m?.status) return null;
  return {
    id: String(m.id),
    status: code(m.status),
    matchMinutes: Number.isFinite(Number(m.matchMinutes)) ? Number(m.matchMinutes) : 0,
    score: typeof m.score === 'string' ? m.score : null,
    updatedAt: now,
  };
}

/** Add entries to the overlay map; newer entries win, finished never reverts to live/NS. */
export function updateStatusOverlay(overlay, entries = [], { maxEntries = 3000 } = {}) {
  for (const e of entries) {
    if (!e) continue;
    const prev = overlay.get(e.id);
    if (prev && isFinishedStatus(prev.status) && !isFinishedStatus(e.status) && !isVoidStatus(e.status)) continue;
    if (prev && prev.updatedAt > e.updatedAt) continue;
    overlay.set(e.id, e);
  }
  while (overlay.size > maxEntries) overlay.delete(overlay.keys().next().value);
  return overlay;
}

/** Apply the overlay to feed matches (returns new objects only when something changed). */
export function applyStatusOverlay(matches = [], overlay, now = Date.now()) {
  if (!Array.isArray(matches)) return [];
  return matches.map((m) => {
    if (!m) return m;
    const entry = overlay?.get?.(String(m.id));
    const withStatus = entry && (entry.status !== m.status || entry.score !== m.score || entry.matchMinutes !== m.matchMinutes)
      ? {
          ...m,
          status: entry.status,
          matchMinutes: entry.matchMinutes,
          ...(entry.score ? { score: entry.score } : {}),
          isLive: isLiveStatus(entry.status),
          statusUpdatedAt: new Date(entry.updatedAt).toISOString(),
        }
      : m;
    const locked = isPredictionLocked(withStatus, now);
    if (locked === Boolean(withStatus.predictionLocked)) return withStatus;
    return { ...withStatus, predictionLocked: locked };
  });
}

/** UTC calendar dates (YYYY-MM-DD) of feed fixtures that have kicked off but are not known to be finished. */
export function datesNeedingStatusRefresh(matches = [], overlay, now = Date.now(), lookbackMs = 4 * 3600000) {
  const dates = new Set();
  for (const m of matches || []) {
    const ko = Date.parse(m?.kickoffUTC ?? '');
    if (!Number.isFinite(ko) || ko > now || ko < now - lookbackMs) continue;
    const known = overlay?.get?.(String(m.id));
    if (known && (isFinishedStatus(known.status) || isVoidStatus(known.status))) continue;
    dates.add(new Date(ko).toISOString().slice(0, 10));
  }
  return [...dates].sort();
}
