import {
  DYNAMIC_STRENGTH_VERSION,
  predictDynamicStrength,
  strengthRowsFromLedger,
  trainDynamicStrength,
} from '../../../shared/dynamicStrengthModel.js';

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
  };

  async function rebuildFromLedger(docs = []) {
    try {
      const rows = strengthRowsFromLedger(docs);
      model = trainDynamicStrength(rows, options);
      status = {
        version: DYNAMIC_STRENGTH_VERSION,
        ready: model.leagueCount > 0,
        builtAt: model.builtAt,
        documents: docs.length,
        trainingRows: rows.length,
        leagueCount: model.leagueCount,
        error: null,
      };
      log.log?.('[V11 Shadow] trained ' + rows.length + ' settled fixtures across ' + model.leagueCount + ' leagues');
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
