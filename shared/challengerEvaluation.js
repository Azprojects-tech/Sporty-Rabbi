const clampP = p => Math.max(1e-9, Math.min(1 - 1e-9, Number(p)));
const score = value => {
  const m=String(value||'').match(/^(\d+)\s*-\s*(\d+)$/);
  return m?{home:Number(m[1]),away:Number(m[2])}:null;
};
const validP = p => Number.isFinite(Number(p)) && Number(p) > 0 && Number(p) < 1;

function outcome(key,s){
  const total=s.home+s.away;
  if(key==='home_win')return s.home>s.away;
  if(key==='draw')return s.home===s.away;
  if(key==='away_win')return s.away>s.home;
  if(key==='over15')return total>=2;
  if(key==='over25')return total>=3;
  if(key==='under25')return total<=2;
  if(key==='btts')return s.home>0&&s.away>0;
  return null;
}

function metrics(rows, accessor){
  let n1=0,ll=0,rps=0;
  const bins={over15:[],over25:[],under25:[],btts:[]};
  for(const row of rows){
    const p=accessor(row),s=row.score;
    if(!p)continue;
    const h=Number(p.home_win),d=Number(p.draw),a=Number(p.away_win);
    if(validP(h)&&validP(d)&&validP(a)){
      const key=s.home>s.away?'home_win':s.home<s.away?'away_win':'draw';
      ll-=Math.log(clampP(p[key]));
      const yH=key==='home_win'?1:0,yHD=key==='away_win'?0:1;
      rps+=((h-yH)**2+((h+d)-yHD)**2)/2;n1++;
    }
    for(const key of Object.keys(bins)){
      const prob=Number(p[key]); const y=outcome(key,s);
      if(validP(prob)&&y!=null)bins[key].push({p:prob,y:y?1:0});
    }
  }
  const binary={};
  for(const [key,list] of Object.entries(bins)){
    if(!list.length){binary[key]=null;continue;}
    const brier=list.reduce((sum,x)=>sum+(x.p-x.y)**2,0)/list.length;
    const avgP=list.reduce((sum,x)=>sum+x.p,0)/list.length;
    const hit=list.reduce((sum,x)=>sum+x.y,0)/list.length;
    binary[key]={n:list.length,brier:+brier.toFixed(5),avgProbability:+(avgP*100).toFixed(1),actualRate:+(hit*100).toFixed(1),calibrationGap:+((hit-avgP)*100).toFixed(1)};
  }
  return {fixtures1x2:n1,logLoss:n1?+(ll/n1).toFixed(5):null,rps:n1?+(rps/n1).toFixed(5):null,binary};
}

export function evaluateShadowChallenger(docs=[], challengerKey='dynamicStrength', challengerVersion=null){
  const first=new Map();
  for(const d of docs||[]){
    if(d?.snapshotType&&d.snapshotType!=='PRE_MATCH')continue;
    const s=score(d?.finalScore),kickoff=Date.parse(d?.kickoffUTC||''),predicted=Date.parse(d?.predictedAt||'');
    if(!s||!Number.isFinite(kickoff)||!Number.isFinite(predicted)||predicted>=kickoff)continue;
    const champ=d?.modelState?.marketProbabilities,chall=d?.challengerStates?.[challengerKey];
    if(!champ||chall?.status!=='AVAILABLE'||!chall?.marketProbabilities)continue;
    if(challengerVersion && chall?.version !== challengerVersion) continue;
    const key=String(d.matchId||''); if(!key)continue;
    const row={id:key,predictedAt:d.predictedAt,score:s,champion:champ,challenger:chall.marketProbabilities};
    const prior=first.get(key); if(!prior||predicted<Date.parse(prior.predictedAt))first.set(key,row);
  }
  const rows=[...first.values()].sort((a,b)=>String(a.predictedAt).localeCompare(String(b.predictedAt)));
  const champion=metrics(rows,r=>r.champion),challenger=metrics(rows,r=>r.challenger);
  const dates=[...new Set(rows.map(r=>String(r.predictedAt).slice(0,10)))];
  const binaryKeys=['over15','over25','under25','btts'];
  let nonWorse=0,regressions=0;
  for(const key of binaryKeys){
    const c=champion.binary[key],h=challenger.binary[key];
    if(!c||!h)continue;
    if(h.brier<=c.brier)nonWorse++;
    if(h.brier>c.brier+0.002)regressions++;
  }
  const enough=rows.length>=500&&dates.length>=14;
  const probabilityPass=enough&&challenger.logLoss!=null&&champion.logLoss!=null
    && challenger.logLoss<=champion.logLoss*0.995
    && challenger.rps<=champion.rps
    && nonWorse>=3&&regressions===0;
  return {
    status: !enough?'COLLECTING_SHADOW_RESULTS':probabilityPass?'EVIDENCE_PASS':'NO_IMPROVEMENT_PROVEN',
    challengerKey,challengerVersion:challengerVersion||null,fixtures:rows.length,days:dates.length,minimumFixtures:500,minimumDays:14,
    champion,challenger,
    delta:{
      logLoss:champion.logLoss!=null&&challenger.logLoss!=null?+(challenger.logLoss-champion.logLoss).toFixed(5):null,
      rps:champion.rps!=null&&challenger.rps!=null?+(challenger.rps-champion.rps).toFixed(5):null,
      lowerIsBetter:true,
    },
    gate:{nonWorseBinaryMarkets:nonWorse,binaryRegressions:regressions,automaticPromotion:false,
      note:'Shadow evidence can qualify a challenger for review; it never changes production recommendations automatically.'},
  };
}
