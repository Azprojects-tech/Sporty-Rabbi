const number = value => {
  if (value == null || value === '' || !['number','string'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clampP = p => Math.min(1-1e-12,Math.max(1e-12,p));

export function poissonTail(lambda,k){
  const l=number(lambda);
  if(l==null || l<0 || !Number.isInteger(k) || k<1)return null;
  let term=Math.exp(-l),cdf=term;
  for(let i=1;i<k;i++){term*=l/i;cdf+=term;}
  return Math.max(0,Math.min(1,1-cdf));
}

export function furtherGoalProbabilities(lambdaPair={}){
  const h=number(lambdaPair.home),a=number(lambdaPair.away);
  if(h==null||a==null||h<0||a<0)return null;
  const total=h+a;
  return {gte1:poissonTail(total,1),gte2:poissonTail(total,2),gte3:poissonTail(total,3)};
}

export function buildLiveStudySnapshot(match={},stats=null,card={},now=Date.now()){
  const core=match.analysis?.predictionCore?.poisson || match.analysis?.poisson;
  const live=core?.live;
  if(!live?.available)return null;
  const minute=number(match.matchMinutes ?? live.minute);
  if(minute==null || minute<1 || minute>=90)return null;
  const score=String(match.score||'').match(/^(\d+)\s*-\s*(\d+)$/);
  if(!score)return null;
  const bucket=Math.max(5,Math.min(85,Math.floor(minute/5)*5));
  const baseline=live.baselineRemainingLambda || live.remainingLambda;
  const adjusted=live.remainingLambda;
  const baselineFurther=furtherGoalProbabilities(baseline);
  const adjustedFurther=furtherGoalProbabilities(adjusted);
  if(!baselineFurther||!adjustedFurther)return null;
  const pair=v=>({home:number(v?.home),away:number(v?.away)});
  return {
    fixtureId:String(match.id ?? card.id),
    bucket,
    observedAt:new Date(now).toISOString(),
    kickoffUTC:card.kickoffUTC||match.kickoffUTC||null,
    home:card.home||match.home||'',
    away:card.away||match.away||'',
    league:card.league||match.league||'',
    leagueId:number(match.leagueId ?? card.leagueId),
    minute,
    status:match.status||null,
    score:{home:Number(score[1]),away:Number(score[2])},
    goalsAtSnapshot:Number(score[1])+Number(score[2]),
    hazardVersion:live.liveHazard?.version||'BASELINE_ONLY',
    hazardSource:live.liveHazard?.source||'NONE',
    baselineRemainingLambda:baseline,
    adjustedRemainingLambda:adjusted,
    baselineFurther,
    adjustedFurther,
    evidence:{
      xg:pair(stats?.xg ?? match.xg),
      shotsOnTarget:pair(stats?.shots ?? match.shots),
      totalShots:pair(stats?.totalShots ?? match.totalShots),
      corners:pair(stats?.corners ?? match.corners),
      redCards:{
        home:number(stats?.cards?.home?.red ?? match.cards?.home?.red ?? match.homeCards?.red),
        away:number(stats?.cards?.away?.red ?? match.cards?.away?.red ?? match.awayCards?.red),
      },
    },
    settlementStatus:'PENDING',
  };
}

export function settleLiveStudySnapshot(snapshot={},finalScore={}){
  const finalHome=number(finalScore.home),finalAway=number(finalScore.away);
  if(finalHome==null||finalAway==null)return null;
  const finalTotal=finalHome+finalAway;
  const startTotal=number(snapshot.goalsAtSnapshot);
  if(startTotal==null || finalTotal<startTotal)return null;
  const goalsAfter=finalTotal-startTotal;
  const outcome={gte1:goalsAfter>=1?1:0,gte2:goalsAfter>=2?1:0,gte3:goalsAfter>=3?1:0};
  const scoreSet=(probs={})=>{
    const rows={};let brierSum=0,logLossSum=0,count=0;
    for(const key of ['gte1','gte2','gte3']){
      const p=number(probs[key]);if(p==null)continue;
      const y=outcome[key],brier=(p-y)**2,logLoss=-(y*Math.log(clampP(p))+(1-y)*Math.log(clampP(1-p)));
      rows[key]={p,y,brier,logLoss};brierSum+=brier;logLossSum+=logLoss;count++;
    }
    return {rows,count,brierSum,logLossSum,brierMean:count?brierSum/count:null,logLossMean:count?logLossSum/count:null};
  };
  const baseline=scoreSet(snapshot.baselineFurther);
  const hazard=scoreSet(snapshot.adjustedFurther);
  return {...snapshot,settlementStatus:'SETTLED',finalScore:{home:finalHome,away:finalAway},goalsAfter,outcome,
    evaluation:{baseline,hazard,brierImprovement:baseline.brierMean!=null&&hazard.brierMean!=null?baseline.brierMean-hazard.brierMean:null,
      logLossImprovement:baseline.logLossMean!=null&&hazard.logLossMean!=null?baseline.logLossMean-hazard.logLossMean:null}};
}

function emptyAgg(){return {snapshots:0,events:0,baselineBrierSum:0,hazardBrierSum:0,baselineLogLossSum:0,hazardLogLossSum:0};}
function addAgg(agg,row){
  const b=row?.evaluation?.baseline,h=row?.evaluation?.hazard;
  if(!b||!h)return agg;
  agg.snapshots++;agg.events+=Math.min(b.count||0,h.count||0);
  agg.baselineBrierSum+=b.brierSum||0;agg.hazardBrierSum+=h.brierSum||0;
  agg.baselineLogLossSum+=b.logLossSum||0;agg.hazardLogLossSum+=h.logLossSum||0;
  return agg;
}
function finishAgg(a){
  const n=a.events||0;
  return {...a,
    baselineBrier:n?a.baselineBrierSum/n:null,hazardBrier:n?a.hazardBrierSum/n:null,
    brierImprovement:n?(a.baselineBrierSum-a.hazardBrierSum)/n:null,
    baselineLogLoss:n?a.baselineLogLossSum/n:null,hazardLogLoss:n?a.hazardLogLossSum/n:null,
    logLossImprovement:n?(a.baselineLogLossSum-a.hazardLogLossSum)/n:null};
}

export function summarizeSettledLiveStudy(rows=[]){
  const overall=emptyAgg(),bySource={};
  for(const row of rows){
    if(row?.settlementStatus!=='SETTLED')continue;
    addAgg(overall,row);
    const source=row.hazardSource||'NONE';
    bySource[source]??=emptyAgg();addAgg(bySource[source],row);
  }
  return {overall:finishAgg(overall),bySource:Object.fromEntries(Object.entries(bySource).map(([k,v])=>[k,finishAgg(v)]))};
}

export function aggregateStudyDocuments(docs=[]){
  const overall=emptyAgg(),bySource={};let fixtures=0;
  for(const d of docs){
    const m=d?.metrics;if(!m)continue;fixtures++;
    overall.snapshots+=m.overall?.snapshots||0;overall.events+=m.overall?.events||0;
    overall.baselineBrierSum+=m.overall?.baselineBrierSum||0;overall.hazardBrierSum+=m.overall?.hazardBrierSum||0;
    overall.baselineLogLossSum+=m.overall?.baselineLogLossSum||0;overall.hazardLogLossSum+=m.overall?.hazardLogLossSum||0;
    for(const [source,s] of Object.entries(m.bySource||{})){
      bySource[source]??=emptyAgg();const a=bySource[source];
      a.snapshots+=s.snapshots||0;a.events+=s.events||0;a.baselineBrierSum+=s.baselineBrierSum||0;a.hazardBrierSum+=s.hazardBrierSum||0;
      a.baselineLogLossSum+=s.baselineLogLossSum||0;a.hazardLogLossSum+=s.hazardLogLossSum||0;
    }
  }
  return {fixtures,overall:finishAgg(overall),bySource:Object.fromEntries(Object.entries(bySource).map(([k,v])=>[k,finishAgg(v)]))};
}


export function summarizePlayedLiveBets(bets=[]){
  let placed=0,settled=0,turnover=0,profit=0,edgeSum=0,edgeCount=0;
  const byMarket={};
  for(const bet of bets){
    if(bet?.source!=='USER_PLAYED' || bet?.slipType==='double' || bet?.paper===true)continue;
    const created=Date.parse(bet.createdAt||''),kickoff=Date.parse(bet.kickoffUTC||'');
    if(!Number.isFinite(created)||!Number.isFinite(kickoff)||created<kickoff)continue;
    placed++;
    const market=String(bet.marketKey||'unknown');
    byMarket[market]??={placed:0,settled:0,turnover:0,profit:0};byMarket[market].placed++;
    const pRaw=number(bet.modelProbability),odds=number(bet.odds);
    const p=pRaw!=null?(pRaw>1?pRaw/100:pRaw):null;
    if(p!=null&&odds!=null&&odds>1){edgeSum+=p-(1/odds);edgeCount++;}
    if(!['won','lost','void'].includes(bet.result))continue;
    settled++;
    const stake=number(bet.stake)||0;
    const betProfit=bet.result==='won'?stake*((odds||1)-1):bet.result==='lost'?-stake:0;
    turnover+=stake;profit+=betProfit;
    byMarket[market].settled++;byMarket[market].turnover+=stake;byMarket[market].profit+=betProfit;
  }
  const finish=x=>({...x,roi:x.turnover?x.profit/x.turnover:null});
  return {placed,settled,turnover,profit,roi:turnover?profit/turnover:null,
    meanModelEdge:edgeCount?edgeSum/edgeCount:null,
    byMarket:Object.fromEntries(Object.entries(byMarket).map(([k,v])=>[k,finish(v)]))};
}
