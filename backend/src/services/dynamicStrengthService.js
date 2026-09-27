import {
  DYNAMIC_STRENGTH_VERSION,
  predictDynamicStrength,
  strengthRowsFromLedger,
  trainDynamicStrength,
} from '../../../shared/dynamicStrengthModel.js';
import { evaluateShadowChallenger } from '../../../shared/challengerEvaluation.js';
import { walkForwardDynamicStrengthAudit } from '../../../shared/dynamicStrengthBacktest.js';
import { FORECAST_VERSION } from '../../../shared/forecastMath.js';

export function createDynamicStrengthService({ log = console, options = {} } = {}) {
  let model = trainDynamicStrength([], options);
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

  async function rebuildFromLedger(docs = []) {
    try {
      const rows = strengthRowsFromLedger(docs);
      model = trainDynamicStrength(rows, options);
      const evaluation = evaluateShadowChallenger(docs, 'dynamicStrength');
      const historicalBacktest = walkForwardDynamicStrengthAudit(docs, { targetVersion: FORECAST_VERSION });
      status = {
        version: DYNAMIC_STRENGTH_VERSION,
        ready: model.leagueCount > 0,
        builtAt: model.builtAt,
        documents: docs.length,
        trainingRows: rows.length,
        leagueCount: model.leagueCount,
        error: null,
        evaluation,
        historicalBacktest,
      };
      log.log?.('[V11 Shadow] trained ' + rows.length + ' settled fixtures across ' + model.leagueCount + ' leagues; forward ' + evaluation.status + ' on ' + evaluation.fixtures + ' shadow fixtures');
      log.log?.('[V11 Backtest] ' + historicalBacktest.status + ' on ' + historicalBacktest.comparableFixtures + ' comparable ' + FORECAST_VERSION + ' fixtures; Δlogloss ' + (historicalBacktest.delta.logLoss ?? 'n/a') + ', ΔRPS ' + (historicalBacktest.delta.rps ?? 'n/a'));
      return status;
    } catch (err) {
      status = { ...status, error: err.message };
      log.warn?.('[V11 Shadow] training failed:', err.message);
      return status;
    }
  }

  return {
    rebuildFromLedger,
    predict: match => predictDynamicStrength(model, match),
    getStatus: () => ({ ...status }),
    getModel: () => model,
  };
}
