import {
  DYNAMIC_STRENGTH_DEFAULTS,
  fitLeagueStrength,
  predictFromLeagueStrength,
} from './dynamicStrengthModel.js';
import { scoreDistribution } from './forecastMath.js';

const finite=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const key=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const score=v=>{const m=String(v||'').match(/^(\d+)\s*-\s*(\d+)$/);return m?{home:Number(m[1]),away:Number(m[2])}:null;};
const validP=p=>Number.isFinite(Number(p))&&Number(p)>0&&Number(p)<1;
const clip=p=>Math.max(1e-9,Math.min(1-1e-9,Number(p)));

function firstPrematchDocs(docs=[]){
  const byFixture=new Map();
  for(const d of docs){
    const s=score(d?.finalScore),ko=Date.parse(d?.kickoffUTC||''),at=Date.parse(d?.predictedAt||'');
    const leagueId=finite(d?.leagueId),home=String(d?.home||'').trim(),away=String(d?.away||'').trim();
    if(!s||!(leagueId>0)||!Number.isFinite(ko)||!Number.isFinite(at)||at>=ko||!home||!away)continue;
    const id=String(d?.matchId??'');if(!id)continue;
    const row={fixtureId:id,leagueId,league:String(d?.league||''),leagueCountry:String(d?.leagueCountry||''),home,away,homeKey:key(home),awayKey:key(away),
      kickoff:ko,kickoffUTC:new Date(ko).toISOString(),predictedAt:new Date(at).toISOString(),homeGoals:s.home,awayGoals:s.away,score:s,
      analysisVersion:d?.analysisVersion||null,champion:d?.modelState?.marketProbabilities||null};
    const fixtureKey=String(leagueId)+'|'+id,prior=byFixture.get(fixtureKey);
    if(!prior||at<Date.parse(prior.predictedAt))byFixture.set(fixtureKey,row);
  }
  return [...byFixture.values()].sort((a,b)=>a.kickoff-b.kickoff||a.predictedAt.localeCompare(b.predictedAt));
}

function accumulator(){return{fixtures:0,logLoss:0,rps:0,binary:{over15:{n:0,brier:0},over25:{n:0,brier:0},under25:{n:0,brier:0},btts:{n:0,brier:0}}};}
function addMetric(acc,p,s){
  const h=Number(p?.home_win),d=Number(p?.draw),a=Number(p?.away_win);
  const outcome=s.home>s.away?'home_win':s.home<s.away?'away_win':'draw';
  if(validP(h)&&validP(d)&&validP(a)){
    acc.fixtures++;acc.logLoss-=Math.log(clip(p[outcome]));
    const yH=outcome==='home_win'?1:0,yHD=outcome==='away_win'?0:1;
    acc.rps+=((h-yH)**2+((h+d)-yHD)**2)/2;
  }
  const total=s.home+s.away,ys={over15:total>=2,over25:total>=3,under25:total<=2,btts:s.home>0&&s.away>0};
  for(const k of Object.keys(ys)){
    const x=Number(p?.[k]);if(!validP(x))continue;
    acc.binary[k].n++;acc.binary[k].brier+=(x-(ys[k]?1:0))**2;
  }
}
function finish(acc){
  const binary={};for(const [k,v] of Object.entries(acc.binary))binary[k]={n:v.n,brier:v.n?+(v.brier/v.n).toFixed(5):null};
  return{fixtures:acc.fixtures,logLoss:acc.fixtures?+(acc.logLoss/acc.fixtures).toFixed(5):null,rps:acc.fixtures?+(acc.rps/acc.fixtures).toFixed(5):null,binary};
}
function delta(champion,challenger){
  const binary={};for(const k of Object.keys(champion.binary||{})){const a=champion.binary[k]?.brier,b=challenger.binary[k]?.brier;binary[k]=a!=null&&b!=null?+(b-a).toFixed(5):null;}
  return{logLoss:champion.logLoss!=null&&challenger.logLoss!=null?+(challenger.logLoss-champion.logLoss).toFixed(5):null,
    rps:champion.rps!=null&&challenger.rps!=null?+(challenger.rps-champion.rps).toFixed(5):null,binary,lowerIsBetter:true};
}

/**
 * Leak-free historical replay of the V11.1 batch strength model.
 * For every comparable target fixture, the challenger is fitted only on league
 * results whose kickoff precedes that fixture. The target result is added only
 * after scoring. This is intentionally slower than production training but makes
 * the research audit faithful and look-ahead free.
 */
export function walkForwardDynamicStrengthAudit(docs=[],{
  targetVersion=null,
  seedLeagueMatches=80,
  minTeamMatches=3,
  modelOptions={},
}={}){
  const cfg={...DYNAMIC_STRENGTH_DEFAULTS,...modelOptions,minTeamMatches};
  const rows=firstPrematchDocs(docs),byLeague=new Map();
  for(const row of rows){const k=String(row.leagueId);if(!byLeague.has(k))byLeague.set(k,[]);byLeague.get(k).push(row);}
  const champion=accumulator(),challenger=accumulator(),leagueResults={};let eligible=0;
  for(const [leagueId,list] of byLeague){
    if(list.length<=seedLeagueMatches)continue;
    const c=accumulator(),h=accumulator();
    for(let i=seedLeagueMatches;i<list.length;i++){
      const row=list[i];
      if(targetVersion&&row.analysisVersion!==targetVersion)continue;
      const history=list.slice(0,i);
      const fitted=fitLeagueStrength(history,cfg,row.kickoff-1);
      const raw=predictFromLeagueStrength(fitted,row,cfg);
      if(!raw||!row.champion)continue;
      const q=scoreDistribution(raw.homeLambda,raw.awayLambda,{rho:cfg.rho});
      if(!q?.marketProbabilities)continue;
      addMetric(champion,row.champion,row.score);addMetric(challenger,q.marketProbabilities,row.score);
      addMetric(c,row.champion,row.score);addMetric(h,q.marketProbabilities,row.score);eligible++;
    }
    if(c.fixtures)leagueResults[leagueId]={league:list[0]?.league||'',champion:finish(c),challenger:finish(h),delta:delta(finish(c),finish(h))};
  }
  const C=finish(champion),H=finish(challenger),D=delta(C,H);
  const binaryDeltas=Object.values(D.binary).filter(Number.isFinite);
  const enough=eligible>=500;
  const better=enough&&Number.isFinite(D.logLoss)&&Number.isFinite(D.rps)&&D.logLoss<0&&D.rps<=0
    &&binaryDeltas.filter(x=>x<=0).length>=3&&binaryDeltas.filter(x=>x>.002).length===0;
  return{
    status:!enough?'INSUFFICIENT_COMPARABLE_HISTORY':better?'HISTORICAL_EVIDENCE_PASS':'NO_IMPROVEMENT_PROVEN',
    targetVersion:targetVersion||'ALL',seedLeagueMatches,minTeamMatches,settledFixtures:rows.length,comparableFixtures:eligible,
    champion:C,challenger:H,delta:D,leagues:leagueResults,
    automaticPromotion:false,
    note:'Historical replay is leak-free research evidence only. Forward shadow evidence remains the promotion gate.',
  };
}
