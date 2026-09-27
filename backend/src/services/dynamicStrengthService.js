import {
  DYNAMIC_STRENGTH_VERSION,
  predictDynamicStrength,
  strengthRowsFromLedger,
  trainDynamicStrength,
} from '../../../shared/dynamicStrengthModel.js';
import { evaluateShadowChallenger } from '../../../shared/challengerEvaluation.js';
import { walkForwardDynamicStrengthAudit } from '../../../shared/dynamicStrengthBacktest.js';
import { FORECAST_VERSION } from '../../../shared/forecastMath.js';
import {
  FOOTBALL_DATA_STRENGTH_SEASON_OFFSETS,
  FOOTBALL_DATA_STRENGTH_SOURCE,
  footballDataRowsForStrength,
  footballDataUrl,
  mapMatchToHistoricalNames,
  parseFdGoalsCsv,
  teamsByLeagueFromRows,
} from '../../../shared/historicalGoalsData.js';
import { FD_LEAGUES } from '../../../shared/cornersModel.js';

export function createDynamicStrengthService({
  log = console,
  options = {},
  fetchText = null,
  now = () => Date.now(),
} = {}) {
  let model = trainDynamicStrength([], options);
  let externalRows = [];
  let externalTeamsByLeague = {};
  let externalLoadedAt = null;
  let externalFailures = [];
  let externalInFlight = null;
  let status = {
    version: DYNAMIC_STRENGTH_VERSION,
    ready: false,
    builtAt: null,
    documents: 0,
    trainingRows: 0,
    ledgerTrainingRows: 0,
    externalTrainingRows: 0,
    leagueCount: 0,
    error: null,
    evaluation: null,
    externalHistory: {
      source: FOOTBALL_DATA_STRENGTH_SOURCE,
      loadedAt: null,
      rows: 0,
      leagues: 0,
      seasonsPerLeague: FOOTBALL_DATA_STRENGTH_SEASON_OFFSETS.length,
      failures: 0,
    },
  };

  async function refreshExternalHistory({ force = false } = {}) {
    if (!fetchText) return { ok:false, reason:'NO_EXTERNAL_FETCHER' };
    if (externalInFlight) return externalInFlight;
    if (!force && externalLoadedAt && now() - Date.parse(externalLoadedAt) < 24 * 3600000) {
      return { ok:true, skipped:true, rows:externalRows.length, loadedAt:externalLoadedAt };
    }
    externalInFlight = (async () => {
      const rows = [];
      const failures = [];
      const at = new Date(now());
      for (const code of Object.keys(FD_LEAGUES)) {
        for (const offset of FOOTBALL_DATA_STRENGTH_SEASON_OFFSETS) {
          const url = footballDataUrl(code, at, offset);
          try {
            const text = await fetchText(url);
            rows.push(...footballDataRowsForStrength(code, parseFdGoalsCsv(text)));
          } catch (err) {
            failures.push({ code, offset, reason: err?.message || String(err) });
          }
        }
      }
      // Keep the previous good cache if the source is temporarily down.
      if (rows.length) {
        externalRows = rows;
        externalTeamsByLeague = teamsByLeagueFromRows(rows);
        externalLoadedAt = new Date(now()).toISOString();
        externalFailures = failures;
      }
      log.log?.(`[V11 Data] ${externalRows.length} external goal results across ${Object.keys(externalTeamsByLeague).length} leagues from ${FOOTBALL_DATA_STRENGTH_SOURCE}; ${failures.length} file failures`);
      return { ok:rows.length>0, rows:externalRows.length, leagues:Object.keys(externalTeamsByLeague).length, failures:failures.length, loadedAt:externalLoadedAt };
    })().finally(() => { externalInFlight = null; });
    return externalInFlight;
  }

  async function rebuildFromLedger(docs = []) {
    try {
      const ledgerRows = strengthRowsFromLedger(docs);
      await refreshExternalHistory();

      // For a league with a full independent history, train from that source.
      // Do not double-count the same recent match again from Sporty's ledger.
      // Leagues not covered externally continue to train from the ledger exactly
      // as before. The V11.1 model configuration itself is unchanged.
      const minLeagueMatches = Number(options.minLeagueMatches) || 80;
      const externalCountByLeague = {};
      for (const r of externalRows) externalCountByLeague[r.leagueId] = (externalCountByLeague[r.leagueId] || 0) + 1;
      const externallyCovered = new Set(Object.entries(externalCountByLeague)
        .filter(([,count]) => count >= minLeagueMatches)
        .map(([leagueId]) => Number(leagueId)));
      const ledgerForUncovered = ledgerRows.filter(r => !externallyCovered.has(Number(r.leagueId)));
      const trainingRows = [...externalRows, ...ledgerForUncovered]
        .sort((a,b)=>a.kickoff-b.kickoff||String(a.fixtureId).localeCompare(String(b.fixtureId)));

      model = trainDynamicStrength(trainingRows, options);
      const evaluation = evaluateShadowChallenger(docs, 'dynamicStrength');
      const historicalBacktest = walkForwardDynamicStrengthAudit(docs, { targetVersion: FORECAST_VERSION });
      status = {
        version: DYNAMIC_STRENGTH_VERSION,
        ready: model.leagueCount > 0,
        builtAt: model.builtAt,
        documents: docs.length,
        trainingRows: trainingRows.length,
        ledgerTrainingRows: ledgerForUncovered.length,
        externalTrainingRows: externalRows.length,
        leagueCount: model.leagueCount,
        error: null,
        evaluation,
        historicalBacktest,
        externalHistory: {
          source: FOOTBALL_DATA_STRENGTH_SOURCE,
          loadedAt: externalLoadedAt,
          rows: externalRows.length,
          leagues: Object.keys(externalTeamsByLeague).length,
          seasonsPerLeague: FOOTBALL_DATA_STRENGTH_SEASON_OFFSETS.length,
          failures: externalFailures.length,
        },
      };
      log.log?.('[V11 Shadow] trained ' + trainingRows.length + ' fixtures (' + externalRows.length + ' external + ' + ledgerForUncovered.length + ' ledger) across ' + model.leagueCount + ' leagues; forward ' + evaluation.status + ' on ' + evaluation.fixtures + ' shadow fixtures');
      log.log?.('[V11 Backtest] ' + historicalBacktest.status + ' on ' + historicalBacktest.comparableFixtures + ' comparable ' + FORECAST_VERSION + ' fixtures; Δlogloss ' + (historicalBacktest.delta.logLoss ?? 'n/a') + ', ΔRPS ' + (historicalBacktest.delta.rps ?? 'n/a'));
      return status;
    } catch (err) {
      status = { ...status, error: err.message };
      log.warn?.('[V11 Shadow] training failed:', err.message);
      return status;
    }
  }

  function predict(match = {}) {
    // API-Football and football-data.co.uk sometimes spell the same club
    // differently. Translate only the identity before prediction; the engine,
    // thresholds and fitted parameters are otherwise untouched.
    const mapped = mapMatchToHistoricalNames(match, externalTeamsByLeague);
    return predictDynamicStrength(model, mapped);
  }

  return {
    rebuildFromLedger,
    refreshExternalHistory,
    predict,
    getStatus: () => ({ ...status }),
    getModel: () => model,
  };
}
