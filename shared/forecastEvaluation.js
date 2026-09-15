import { observedNumber } from './forecastMath.js';

export function evaluateForecasts(rows = []) {
  const sample = rows.flatMap(row => {
    const n = observedNumber(row.probability01);
    const pct = observedNumber(row.modelProbability ?? row.confidence);
    const p = n ?? (pct == null ? null : pct / 100);
    if (p == null || p < 0 || p > 1 || !['won','lost'].includes(row.result)) return [];
    return [{ p, y: row.result === 'won' ? 1 : 0 }];
  });
  if (!sample.length) return null;
  const mean = values => values.reduce((a,b) => a+b,0) / values.length;
  const wins = sample.reduce((sum,r) => sum + r.y,0), winRate = wins / sample.length;
  const avgP = mean(sample.map(r => r.p));
  const clip = p => Math.max(1e-12, Math.min(1-1e-12,p));
  const loss = (p,y) => -(y * Math.log(clip(p)) + (1-y) * Math.log(1-clip(p)));
  const brier = mean(sample.map(r => (r.p-r.y)**2));
  const logLoss = mean(sample.map(r => loss(r.p,r.y)));
  // This comparator is descriptive of this sample, not an out-of-sample model.
  const referenceBrier = mean(sample.map(r => (avgP-r.y)**2));
  const referenceLogLoss = mean(sample.map(r => loss(avgP,r.y)));
  const bands = [0,.5,.6,.7,.8,.9,1.000001].slice(0,-1).map((low,i) => {
    const high = [0,.5,.6,.7,.8,.9,1.000001][i+1];
    const subset = sample.filter(r => r.p >= low && r.p < high);
    return { label: `${Math.round(low*100)}–${Math.min(100,Math.round(high*100))}%`, count: subset.length,
      meanProbability: subset.length ? mean(subset.map(r=>r.p)) : null,
      hitRate: subset.length ? mean(subset.map(r=>r.y)) : null };
  }).filter(b=>b.count);
  return { sampleSize: sample.length, won: wins, lost: sample.length-wins, winRate: +(winRate*100).toFixed(1),
    avgStatedConfidence: +(avgP*100).toFixed(1), calibrationGap: +((winRate-avgP)*100).toFixed(1) || 0,
    brierScore: +brier.toFixed(4), logLoss: +logLoss.toFixed(4),
    referenceBrier: +referenceBrier.toFixed(4), referenceLogLoss: +referenceLogLoss.toFixed(4),
    referenceLabel: 'Constant mean probability on this sample', probabilityBands: bands,
    brierStatus: 'RECORDED', logLossStatus: 'RECORDED', calibrationStatus: sample.length < 100 ? 'COLLECTING RESULTS' : 'RECORDED',
    halt: false, caution: false };
}
