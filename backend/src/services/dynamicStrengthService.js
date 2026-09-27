import {
  DYNAMIC_STRENGTH_VERSION,
  dynamicTeamKey,
  predictDynamicStrength,
  strengthRowsFromLedger,
  trainDynamicStrength,
} from '../../../shared/dynamicStrengthModel.js';
import { evaluateShadowChallenger } from '../../../shared/challengerEvaluation.js';
import { walkForwardDynamicStrengthAudit } from '../../../shared/dynamicStrengthBacktest.js';
import { FORECAST_VERSION } from '../../../shared/forecastMath.js';
import { matchTeamName } from '../../../shared/cornersModel.js';

export function createDynamicStrengthService({ log = console, options = {} } = {}) {
  let model = trainDynamicStrength([], options);
  let bootstrapRows = [];
  let lastDocs = [];
  let status = {
    version: DYNAMIC_STRENGTH_VERSION,
    ready: false,
    builtAt: null,
    documents: 0,
    trainingRows: 0,
    leagueCount: 0,
    error: null,
    evaluation: null,
  };


  function prepareBootstrap(ledgerRows = []) {
    if (!bootstrapRows.length) return [];
    const ledgerByLeague = new Map();
    for (const row of ledgerRows) {
      const k=String(row.leagueId);
      if(!ledgerByLeague.has(k))ledgerByLeague.set(k,[]);
      ledgerByLeague.get(k).push(row);
    }
    const out=[];
    for(const [leagueId,rows] of Object.entries(Object.groupBy ? Object.groupBy(bootstrapRows,r=>String(r.leagueId)) : {})){
      // This branch is never used on older Node; the portable loop below handles all runtimes.
      void leagueId; void rows;
    }
    const grouped=new Map();
    for(const row of bootstrapRows){const k=String(row.leagueId);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(row);}
    for(const [leagueId,history] of grouped){
      const ledger=ledgerByLeague.get(leagueId)||[];
      const earliest=ledger.length?Math.min(...ledger.map(r=>r.kickoff)):Infinity;
      const firstDay=Number.isFinite(earliest)?new Date(earliest):null;
      const cutoff=firstDay?Date.UTC(firstDay.getUTCFullYear(),firstDay.getUTCMonth(),firstDay.getUTCDate()):Infinity;
      const fdNames=[...new Set(history.flatMap(r=>[r.home,r.away]).filter(Boolean))];
      const apiNames=[...new Set(ledger.flatMap(r=>[r.home,r.away]).filter(Boolean))];
      const fdToApi=new Map();
      for(const apiName of apiNames){
        const fd=matchTeamName(apiName,fdNames);
        if(fd)fdToApi.set(fd,apiName);
      }
      for(const r of history){
        if(Number(r.kickoff)>=cutoff)continue;
        const home=fdToApi.get(r.home)||r.home,away=fdToApi.get(r.away)||r.away;
        out.push({...r,home,away,homeKey:dynamicTeamKey(home),awayKey:dynamicTeamKey(away)});
      }
    }
    return out.sort((a,b)=>a.kickoff-b.kickoff);
  }

  async function rebuildFromLedger(docs = []) {
    try {
      lastDocs = docs;
      const ledgerRows = strengthRowsFromLedger(docs);
      const preparedBootstrap = prepareBootstrap(ledgerRows);
      const rows = [...preparedBootstrap, ...ledgerRows].sort((a,b)=>a.kickoff-b.kickoff);
      model = trainDynamicStrength(rows, options);
      const evaluation = evaluateShadowChallenger(docs, 'dynamicStrength', DYNAMIC_STRENGTH_VERSION);
      const historicalBacktest = walkForwardDynamicStrengthAudit(docs, { targetVersion: FORECAST_VERSION, bootstrapRows: preparedBootstrap });
      status = {
        version: DYNAMIC_STRENGTH_VERSION,
        ready: model.leagueCount > 0,
        builtAt: model.builtAt,
        documents: docs.length,
        trainingRows: rows.length,
        ledgerTrainingRows: ledgerRows.length,
        bootstrapTrainingRows: preparedBootstrap.length,
        leagueCount: model.leagueCount,
        error: null,
        evaluation,
        historicalBacktest,
      };
      log.log?.('[V11 Shadow] trained ' + rows.length + ' fixtures (' + preparedBootstrap.length + ' historical bootstrap + ' + ledgerRows.length + ' ledger) across ' + model.leagueCount + ' leagues; forward ' + evaluation.status + ' on ' + evaluation.fixtures + ' shadow fixtures');
      log.log?.('[V11 Backtest] ' + historicalBacktest.status + ' on ' + historicalBacktest.comparableFixtures + ' comparable ' + FORECAST_VERSION + ' fixtures; Δlogloss ' + (historicalBacktest.delta.logLoss ?? 'n/a') + ', ΔRPS ' + (historicalBacktest.delta.rps ?? 'n/a'));
      return status;
    } catch (err) {
      status = { ...status, error: err.message };
      log.warn?.('[V11 Shadow] training failed:', err.message);
      return status;
    }
  }

  async function setBootstrapRows(rows = []) {
    bootstrapRows = Array.isArray(rows) ? rows : [];
    log.log?.('[V11 Bootstrap] loaded ' + bootstrapRows.length + ' Football-Data historical rows');
    return lastDocs.length ? rebuildFromLedger(lastDocs) : getStatus();
  }

  function getStatus(){ return { ...status, bootstrapRowsAvailable: bootstrapRows.length }; }

  return {
    rebuildFromLedger,
    setBootstrapRows,
    predict: match => predictDynamicStrength(model, match),
    getStatus,
    getModel: () => model,
  };
}
