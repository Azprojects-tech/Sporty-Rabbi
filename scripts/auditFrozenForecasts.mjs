import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { evaluateForecasts } from '../shared/forecastEvaluation.js';
import { observedNumber } from '../shared/forecastMath.js';

export function auditFrozenForecasts(documents = []) {
  const selected=[], all=[], seen=new Set();
  const excluded={pending:0,missingTiming:0,notPrematch:0,duplicateFixture:0,invalidScore:0};
  const versions={};
  const validP=v=>typeof v === 'number' && Number.isFinite(v) && v>=0 && v<=1;
  for(const d of [...documents].sort((a,b)=>Date.parse(a.predictedAt)-Date.parse(b.predictedAt))) {
    if(d.settlementStatus!=='SETTLED'){excluded.pending++;continue;}
    const predicted=Date.parse(d.predictedAt),kickoff=Date.parse(d.kickoffUTC);
    if(!Number.isFinite(predicted)||!Number.isFinite(kickoff)){excluded.missingTiming++;continue;}
    if(predicted>=kickoff || d.snapshotType!=='PRE_MATCH'){excluded.notPrematch++;continue;}
    const score=String(d.finalScore??'').match(/^(\d+)\s*[-:]\s*(\d+)$/);
    if(!score || !['FT','AET','PEN'].includes(d.finalStatus)){excluded.invalidScore++;continue;}
    const id=String(d.matchId);
    if(!d.matchId || seen.has(id)){excluded.duplicateFixture++;continue;}
    seen.add(id);
    const h=Number(score[1]),a=Number(score[2]),goals=h+a;
    const result=key=>{
      if(key==='home_win')return h>a;if(key==='away_win')return a>h;if(key==='draw')return h===a;
      if(key==='btts')return h>0&&a>0;
      const m=key.match(/^(over|under)([0-4])5$/);
      return m ? (m[1]==='over'?goals>Number(m[2])+.5:goals<Number(m[2])+.5) : null;
    };
    const version=d.analysisVersion||'UNKNOWN';
    versions[version]=(versions[version]||0)+1;
    const base={fixtureId:id,leagueId:d.leagueId,version,predictedAt:d.predictedAt};
    for(const [key,p] of Object.entries(d.modelState?.marketProbabilities||{})) {
      const won=result(key);
      if(validP(p)&&won!=null)all.push({...base,marketKey:key,probability01:p,result:won?'won':'lost'});
    }
    const marketSeen=new Set();
    for(const m of d.markets||[]) {
      const p=observedNumber(m.probability01) ?? (observedNumber(m.modelProbability)==null?null:Number(m.modelProbability)/100);
      const won=result(m.marketKey||'');
      if(!validP(p)||won==null||marketSeen.has(m.marketKey))continue;
      marketSeen.add(m.marketKey);selected.push({...base,marketKey:m.marketKey,probability01:p,result:won?'won':'lost'});
    }
  }
  const grouped=(rows,key)=>Object.fromEntries([...new Set(rows.map(r=>r[key]))].sort().map(k=>[k,evaluateForecasts(rows.filter(r=>r[key]===k))]));
  return {recordsRead:documents.length,settledFixtures:seen.size,excluded,versions,
    selectedMarketCalls:evaluateForecasts(selected),selectedByMarket:grouped(selected,'marketKey'),selectedByVersion:grouped(selected,'version'),
    allFrozenMarkets:grouped(all,'marketKey'),
    interpretation:'Descriptive audit of frozen prematch forecasts, not a held-out training result. Multiple markets share fixtures. No ROI is calculated without actual taken odds/stakes.'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
 const file=process.argv[2];if(!file)throw new Error('Usage: node scripts/auditFrozenForecasts.mjs ledger-export.json');
 const raw=JSON.parse(fs.readFileSync(file,'utf8'));
 const rows=Array.isArray(raw)?raw:raw.predictions;
 if(!Array.isArray(rows))throw new Error('Expected a predictions array or { predictions: [...] }');
 console.log(JSON.stringify(auditFrozenForecasts(rows),null,2));
}
