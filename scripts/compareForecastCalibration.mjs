import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { scoreDistribution } from '../shared/forecastMath.js';

// Offline research only: estimate a shared rate adjustment, never independently
// bend overlapping market probabilities. Nothing here changes the running model.
const keys=['home_win','draw','away_win'];
const loss=(p,y)=>-(y*Math.log(Math.max(p,1e-12))+(1-y)*Math.log(Math.max(1-p,1e-12)));
export function scoreCandidate(rows, candidate) {
  let log1x2=0,brier1x2=0,logGoals=0,logBtts=0;
  for(const r of rows){
    const p=scoreDistribution(r.homeRate*candidate.scale*Math.sqrt(candidate.balance),
      r.awayRate*candidate.scale/Math.sqrt(candidate.balance),{rho:-.08})?.marketProbabilities;
    if(!p)return null;
    const winner=r.homeGoals>r.awayGoals?'home_win':r.homeGoals<r.awayGoals?'away_win':'draw';
    log1x2-=Math.log(Math.max(p[winner],1e-12));
    brier1x2+=keys.reduce((s,k)=>s+(p[k]-(k===winner?1:0))**2,0);
    logGoals+=loss(p.over25,r.homeGoals+r.awayGoals>2.5?1:0);
    logBtts+=loss(p.btts,r.homeGoals>0&&r.awayGoals>0?1:0);
  }
  const n=rows.length;
  return n?{fixtures:n,logLoss1x2:log1x2/n,brier1x2:brier1x2/n,logLossOver25:logGoals/n,
    logLossBtts:logBtts/n,objective:(log1x2+logGoals+logBtts)/(3*n)}:null;
}
export function compareForecastCalibration(documents){
  const seen=new Set();
  const rows=[...documents].sort((a,b)=>Date.parse(a.predictedAt)-Date.parse(b.predictedAt)).flatMap(d=>{
    const s=String(d.finalScore??'').match(/^(\d+)-(\d+)$/),state=d.modelState;
    const kickoff=Date.parse(d.kickoffUTC),predicted=Date.parse(d.predictedAt);
    if(d.analysisVersion!=='V10.6A-Coherent-Core'||d.settlementStatus!=='SETTLED'||d.snapshotType!=='PRE_MATCH'
      || !['FT','AET','PEN'].includes(d.finalStatus)||!s||!d.matchId||seen.has(String(d.matchId))
      ||!Number.isFinite(kickoff)||!Number.isFinite(predicted)||predicted>=kickoff
      ||![state?.homeLambda,state?.awayLambda].every(x=>typeof x==='number'&&x>0&&x<=4.5))return [];
    seen.add(String(d.matchId));
    return [{id:d.matchId,day:new Date(kickoff).toISOString().slice(0,10),kickoff,
      homeRate:state.homeLambda,awayRate:state.awayLambda,homeGoals:Number(s[1]),awayGoals:Number(s[2])}];
  }).sort((a,b)=>a.kickoff-b.kickoff);
  const days=[...new Set(rows.map(r=>r.day))];
  if(days.length<3)return {status:'INSUFFICIENT_CHRONOLOGICAL_DAYS',fixtures:rows.length};
  const split=Math.max(1,Math.floor(days.length*.6));
  const validationDay=days[Math.min(split,days.length-2)],testDay=days.at(-1);
  const train=rows.filter(r=>r.day<validationDay),validation=rows.filter(r=>r.day>=validationDay&&r.day<testDay),test=rows.filter(r=>r.day>=testDay);
  const baseline={scale:1,balance:1};
  const candidates=[];
  for(const scale of [.7,.85,1,1.15,1.3]) for(const balance of [.85,1,1.15]){
    const candidate={scale,balance},metrics=scoreCandidate(train,candidate);
    if(metrics)candidates.push({candidate,metrics});
  }
  candidates.sort((a,b)=>a.metrics.objective-b.metrics.objective);
  const challenger=candidates[0]?.candidate;
  if(!challenger||!train.length||!validation.length||!test.length)return {status:'INSUFFICIENT_SPLIT_DATA'};
  const compare=set=>({baseline:scoreCandidate(set,baseline),challenger:scoreCandidate(set,challenger)});
  return {status:'OFFLINE_EXPERIMENT_ONLY',version:'V10.6A-Coherent-Core',fixtures:rows.length,
    split:{trainingDays:days.filter(d=>d<validationDay),validationDays:days.filter(d=>d>=validationDay&&d<testDay),testDays:[testDay]},
    candidateCount:candidates.length,selectedOn:'TRAINING_DATA_ONLY',challenger,
    train:compare(train),validation:compare(validation),test:compare(test),
    deploymentDecision:'NOT_APPROVED_SHORT_WINDOW_NO_LIVE_EVENT_VALIDATION',
    objective:'Equal mean of 1X2, Over 2.5 and BTTS log losses; lower is better. Related markets are not independent samples.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const file=process.argv[2];if(!file)throw new Error('Usage: node scripts/compareForecastCalibration.mjs ledger-export.json');
 const raw=JSON.parse(fs.readFileSync(file,'utf8'));const rows=Array.isArray(raw)?raw:raw.predictions;
 if(!Array.isArray(rows))throw new Error('Expected predictions array');
 console.log(JSON.stringify(compareForecastCalibration(rows),null,2));
}
