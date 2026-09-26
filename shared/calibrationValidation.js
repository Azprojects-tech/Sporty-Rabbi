import { buildCalibrationMap, coherentCorrection } from './pickCalibration.js';

// A fixed chronological train/validation/test split. No later outcome is used
// to fit the map that is evaluated or promoted. Maps stay frozen after testing.
export function validateCalibration(picks, { version, now = new Date().toISOString() } = {}) {
  const rows = picks.filter(p => p.version === version && Number.isFinite(p.rawProbabilities?.[p.marketKey]) && Number.isFinite(Date.parse(p.settledAt))
    && Date.parse(p.settledAt) > Date.parse(p.kickoffUTC) && Date.parse(p.settledAt) <= Date.parse(now));
  const dates = [...new Set(rows.map(p=>p.predictedAt.slice(0,10)))].sort();
  const empty = { ...buildCalibrationMap([], { now }), validation: { version, approvedMarkets: [],
    status: 'INSUFFICIENT_HISTORY', days: dates.length, results: {} } };
  if (dates.length < 6) return empty;
  const validationStart = dates[Math.floor(dates.length * .6)] + 'T00:00:00.000Z';
  const testStart = dates[Math.floor(dates.length * .8)] + 'T00:00:00.000Z';
  const train = rows.filter(p=>p.predictedAt < validationStart && p.settledAt < validationStart);
  const trainIds = new Set(train.map(p=>p.fixtureId));
  const validation = rows.filter(p=>p.predictedAt >= validationStart && p.predictedAt < testStart
    && p.settledAt < testStart && !trainIds.has(p.fixtureId));
  const validationIds = new Set(validation.map(p=>p.fixtureId));
  const test = rows.filter(p=>p.predictedAt >= testStart && !trainIds.has(p.fixtureId) && !validationIds.has(p.fixtureId));
  const map = buildCalibrationMap(train, { now });
  const score = group => {
    const loss = corrected => {
      let brier=0, logLoss=0;
      for(const p of group) {
        const probability = Math.max(.001,Math.min(.999,corrected ? coherentCorrection(map,p.rawProbabilities,
          {leagueId:p.leagueId,matchType:p.international?'international':''})[p.marketKey] : p.rawProbabilities[p.marketKey]));
        brier += (probability-p.won)**2;
        logLoss -= p.won*Math.log(probability)+(1-p.won)*Math.log(1-probability);
      }
      return { brier:group.length?brier/group.length:null, logLoss:group.length?logLoss/group.length:null };
    };
    return { fixtures:new Set(group.map(p=>p.fixtureId)).size, raw:loss(false), corrected:loss(true) };
  };
  const results={}; const approvedMarkets=[];
  for(const key of Object.keys(map.markets)) {
    const v=score(validation.filter(p=>p.marketKey===key)), t=score(test.filter(p=>p.marketKey===key));
    const sufficient=map.markets[key].picks>=150 && v.fixtures>=50 && t.fixtures>=50;
    const better=s => s.corrected.brier < s.raw.brier && s.corrected.logLoss <= s.raw.logLoss;
    const approved=sufficient && better(v) && better(t);
    results[key]={training:map.markets[key].picks,validation:v,test:t,approved};
    if(approved) approvedMarkets.push(key);
  }
  const evaluable=Object.values(results).filter(r=>r.validation.fixtures>=30 && r.test.fixtures>=30);
  const promote=approvedMarkets.length>=2 && evaluable.every(r=>r.validation.corrected.brier<=r.validation.raw.brier && r.validation.corrected.logLoss<=r.validation.raw.logLoss && r.test.corrected.brier<=r.test.raw.brier && r.test.corrected.logLoss<=r.test.raw.logLoss);
  return {...map,validation:{ version,status:promote?'APPROVED':'NO_IMPROVEMENT_PROVEN',
    approvedMarkets,validationStart,testStart,days:dates.length,results }};
}
