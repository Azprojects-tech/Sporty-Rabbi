import {
  FD_LEAGUES, fdSeasonCode, parseFdCsv, buildLeagueCornersModel, predictCorners, fdCodeForMatch,
  settleCornersLines,
} from '../../../shared/cornersModel.js';

/**
 * Corners: downloads football-data.co.uk results once a day (about 44 small
 * files, no API-Football quota), builds one model per league, records a
 * pre-match corners prediction per covered fixture and settles it when the
 * result (with corner counts) appears in the files.
 */
export const CORNERS_COLLECTION = 'cornersPredictions';
export const CORNERS_MODEL_VERSION = 'V10.10-Corners-1';
const BASE = 'https://www.football-data.co.uk/mmz4281';

export function createCornersService({ fetchText, getDb = () => null, now = () => Date.now(), log = console } = {}) {
  let models = {};
  let rowsByCode = {};
  let refreshedAt = null;
  const previousSeason = new Map(); // code -> rows, downloaded once per process
  const recorded = new Set();
  const memo = new Map();
  let inFlight = null;

  async function download(code, season) {
    try { return parseFdCsv(await fetchText(`${BASE}/${season}/${code}.csv`)); }
    catch (err) { log.warn?.(`[Corners] ${code} ${season} unavailable: ${err.message}`); return []; }
  }

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const today = new Date(now());
      const current = fdSeasonCode(today);
      const previous = fdSeasonCode(today, -1);
      const nextModels = {};
      const nextRows = {};
      for (const code of Object.keys(FD_LEAGUES)) {
        const cur = await download(code, current);
        if (!previousSeason.has(code)) previousSeason.set(code, await download(code, previous));
        const rows = [...previousSeason.get(code), ...cur];
        nextRows[code] = rows;
        const model = buildLeagueCornersModel(rows, { now: now() });
        if (model) nextModels[code] = model;
      }
      if (Object.keys(nextModels).length) { models = nextModels; rowsByCode = nextRows; refreshedAt = new Date(now()).toISOString(); memo.clear(); }
      log.log?.(`[Corners] Models ready for ${Object.keys(models).length} leagues`);
      return status();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  function predict(match) {
    if (!match || !fdCodeForMatch(match)) return { status: 'NO_PREDICTION', reason: 'LEAGUE_NOT_COVERED' };
    if (!refreshedAt) return { status: 'NO_PREDICTION', reason: 'LOADING' };
    const key = `${match.id}|${match.home}|${match.away}`;
    if (!memo.has(key)) memo.set(key, predictCorners(models, match));
    if (memo.size > 5000) memo.clear();
    return memo.get(key);
  }

  async function recordPredictions(matches = []) {
    const db = getDb();
    if (!db || !refreshedAt) return 0;
    let saved = 0;
    for (const m of matches) {
      if (!m?.id || recorded.has(String(m.id))) continue;
      if (m.status && m.status !== 'NS' && m.status !== 'TBD') continue;
      const ko = Date.parse(m.kickoffUTC || '');
      if (!Number.isFinite(ko) || ko <= now()) continue;
      const p = predict(m);
      if (p.status !== 'AVAILABLE') continue;
      const doc = {
        fixtureId: m.id, predictionId: m.predictionId || null, home: m.home || '', away: m.away || '',
        league: m.league || '', leagueId: m.leagueId ?? 0, leagueCountry: m.leagueCountry || '', kickoffUTC: m.kickoffUTC,
        predictedAt: new Date(now()).toISOString(), analysisVersion: CORNERS_MODEL_VERSION, source: `football-data.co.uk:${p.source}`,
        fdHome: p.fdHome, fdAway: p.fdAway, expectedTotal: p.expectedTotal, lines: p.lines, mainLine: p.line,
        result: 'pending', totalCorners: null, results: null, settledAt: null,
      };
      try {
        await db.collection(CORNERS_COLLECTION).doc(`corners_${m.id}`).create(doc);
        saved++;
      } catch (err) {
        if (err.code !== 6 && err.code !== 'already-exists') { log.warn?.('[Corners] Save failed:', err.message); continue; }
      }
      recorded.add(String(m.id));
    }
    if (recorded.size > 20000) recorded.clear();
    return saved;
  }

  /** Find the finished game in the results files (dates there are local match dates). */
  function findResult(doc) {
    const code = String(doc.source || '').split(':')[1];
    const ko = Date.parse(doc.kickoffUTC || '');
    return (rowsByCode[code] || []).find((r) => r.home === doc.fdHome && r.away === doc.fdAway
      && Number.isFinite(ko) && Math.abs(r.date - ko) <= 36 * 3600000) || null;
  }

  async function settlePending() {
    const db = getDb();
    if (!db || !refreshedAt) return { settled: 0, checked: 0 };
    const snap = await db.collection(CORNERS_COLLECTION).where('result', '==', 'pending').limit(1000).get();
    let settled = 0;
    for (const d of snap.docs) {
      const doc = d.data();
      const ko = Date.parse(doc.kickoffUTC || '');
      if (!Number.isFinite(ko) || ko > now() - 3 * 3600000) continue;
      const row = findResult(doc);
      const stamp = new Date(now()).toISOString();
      if (row) {
        const total = row.hc + row.ac;
        await d.ref.update({ result: 'settled', totalCorners: total, results: settleCornersLines(doc.lines, total), settledAt: stamp });
        settled++;
      } else if (now() - ko > 21 * 86400000) {
        await d.ref.update({ result: 'unsettled', settledAt: stamp }); // result never published
      }
    }
    return { settled, checked: snap.size };
  }

  function status() {
    return {
      refreshedAt,
      leagues: Object.entries(models).map(([code, m]) => ({
        code, league: FD_LEAGUES[code].name, country: FD_LEAGUES[code].country, gamesUsed: m.games,
        latestResult: new Date(m.lastResultAt).toISOString().slice(0, 10),
        averageCorners: Math.round((m.leagueHome + m.leagueAway) * 10) / 10,
      })),
    };
  }

  return { refresh, predict, recordPredictions, settlePending, status, getModels: () => models };
}

/** Settled corners predictions shaped like ledger documents, for the calibration layer. */
export function cornersDocsForCalibration(docs = []) {
  return docs.filter((d) => d?.result === 'settled' && d.lines && d.results).map((d) => ({
    matchId: `corners_${d.fixtureId}`,
    predictedAt: d.predictedAt, kickoffUTC: d.kickoffUTC, analysisVersion: d.analysisVersion || CORNERS_MODEL_VERSION,
    leagueId: d.leagueId ?? 0, leagueCountry: d.leagueCountry || '',
    markets: Object.entries(d.lines).map(([marketKey, p]) => ({ marketKey, modelProbability: p, result: d.results[marketKey] || null })),
  }));
}
