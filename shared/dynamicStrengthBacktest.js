import { DYNAMIC_STRENGTH_DEFAULTS } from './dynamicStrengthModel.js';
import { scoreDistribution } from './forecastMath.js';

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const finite=v=>{const n=Number(v);return Number.isFinite(n)?n:null;};
const key=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const score=v=>{const m=String(v||'').match(/^(\d+)\s*-\s*(\d+)$/);return m?{home:Number(m[1]),away:Number(m[2])}:null;};
const get=(o,k)=>finite(o?.[k])??0;
const validP=p=>Number.isFinite(Number(p))&&Number(p)>0&&Number(p)<1;
const clip=p=>Math.max(1e-9,Math.min(1-1e-9,Number(p)));

function firstPrematchDocs(docs=[]){
  const byFixture=new Map();
  for(const d of docs){
    const s=score(d?.finalScore),ko=Date.parse(d?.kickoffUTC||''),at=Date.parse(d?.predictedAt||'');
    const leagueId=finite(d?.leagueId),home=String(d?.home||'').trim(),away=String(d?.away||'').trim();
    if(!s||!(leagueId>0)||!Number.isFinite(ko)||!Number.isFinite(at)||at>=ko||!home||!away)continue;
    const id=String(d?.matchId??'');if(!id)continue;
    const row={id,leagueId,league:String(d?.league||''),leagueCountry:String(d?.leagueCountry||''),home,away,homeKey:key(home),awayKey:key(away),
      kickoff:ko,kickoffUTC:new Date(ko).toISOString(),predictedAt:new Date(at).toISOString(),score:s,analysisVersion:d?.analysisVersion||null,
      champion:d?.modelState?.marketProbabilities||null};
    const fixtureKey=String(leagueId)+'|'+id,prior=byFixture.get(fixtureKey);
    if(!prior||at<Date.parse(prior.predictedAt))byFixture.set(fixtureKey,row);
  }
  return [...byFixture.values()].sort((a,b)=>a.kickoff-b.kickoff||a.predictedAt.localeCompare(b.predictedAt));
}

function initState(seed,cfg){
  const homeMean=seed.reduce((s,r)=>s+r.score.home,0)/seed.length;
  const awayMean=seed.reduce((s,r)=>s+r.score.away,0)/seed.length;
  if(!(homeMean>0&&awayMean>0))return null;
  return{mu:Math.log(awayMean),homeAdvantage:Math.log(homeMean/awayMean),attack:{},defence:{},teamMatches:{},matches:0,cfg};
}

function predict(state,row){
  const cfg=state.cfg,h=row.homeKey,a=row.awayKey;
  const homeLambda=clamp(Math.exp(state.mu+state.homeAdvantage+get(state.attack,h)-get(state.defence,a)),cfg.minLambda,cfg.maxLambda);
  const awayLambda=clamp(Math.exp(state.mu+get(state.attack,a)-get(state.defence,h)),cfg.minLambda,cfg.maxLambda);
  const d=scoreDistribution(homeLambda,awayLambda,{rho:cfg.rho});
  return d?{homeLambda,awayLambda,marketProbabilities:d.marketProbabilities}:null;
}

function update(state,row){
  const q=predict(state,row);if(!q)return;
  const cfg=state.cfg,h=row.homeKey,a=row.awayKey,eh=row.score.home-q.homeLambda,ea=row.score.away-q.awayLambda;
  const ah=get(state.attack,h),aa=get(state.attack,a),dh=get(state.defence,h),da=get(state.defence,a);
  state.attack[h]=ah+cfg.learningRate*eh;state.defence[a]=da-cfg.learningRate*eh;
  state.attack[a]=aa+cfg.learningRate*ea;state.defence[h]=dh-cfg.learningRate*ea;
  state.mu+=cfg.learningRate*cfg.globalLearningScale*(eh+ea);
  state.homeAdvantage+=cfg.learningRate*cfg.globalLearningScale*eh;
  state.teamMatches[h]=(state.teamMatches[h]||0)+1;state.teamMatches[a]=(state.teamMatches[a]||0)+1;state.matches++;
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
 * Leak-free historical replay. The first seedLeagueMatches in each league are
 * training-only. Every later challenger forecast is made BEFORE that fixture's
 * result updates team strength. Champion probabilities are the frozen values
 * stored at the real prediction time.
 */
export function walkForwardDynamicStrengthAudit(docs=[],{
  targetVersion=null,
  seedLeagueMatches=60,
  minTeamMatches=3,
  modelOptions={},
  bootstrapRows=[],
}={}){
  const cfg={...DYNAMIC_STRENGTH_DEFAULTS,...modelOptions};
  const rows=firstPrematchDocs(docs),byLeague=new Map(),bootstrapByLeague=new Map();
  for(const row of rows){const k=String(row.leagueId);if(!byLeague.has(k))byLeague.set(k,[]);byLeague.get(k).push(row);}
  for(const raw of bootstrapRows||[]){
    const leagueId=finite(raw?.leagueId),kickoff=finite(raw?.kickoff)??Date.parse(raw?.kickoffUTC||'');
    const home=String(raw?.home||'').trim(),away=String(raw?.away||'').trim();
    const homeGoals=finite(raw?.homeGoals),awayGoals=finite(raw?.awayGoals);
    if(!(leagueId>0)||!Number.isFinite(kickoff)||!home||!away||homeGoals==null||awayGoals==null)continue;
    const row={leagueId,league:String(raw?.league||''),home,away,homeKey:key(home),awayKey:key(away),kickoff,
      kickoffUTC:new Date(kickoff).toISOString(),score:{home:homeGoals,away:awayGoals},champion:null,analysisVersion:null};
    const k=String(leagueId);if(!bootstrapByLeague.has(k))bootstrapByLeague.set(k,[]);bootstrapByLeague.get(k).push(row);
  }
  for(const list of bootstrapByLeague.values())list.sort((a,b)=>a.kickoff-b.kickoff);

  const champion=accumulator(),challenger=accumulator(),leagueResults={};let eligible=0,bootstrapUsed=0;
  for(const [leagueId,list] of byLeague){
    if(!list.length)continue;
    const firstKickoff=list[0].kickoff,firstDay=new Date(firstKickoff);
    const cutoff=Date.UTC(firstDay.getUTCFullYear(),firstDay.getUTCMonth(),firstDay.getUTCDate());
    const bootstrap=(bootstrapByLeague.get(leagueId)||[]).filter(r=>r.kickoff<cutoff);
    let state=null,startIndex=0;

    if(bootstrap.length>=seedLeagueMatches){
      const seed=bootstrap.slice(0,seedLeagueMatches);
      state=initState(seed,cfg);if(!state)continue;
      for(const r of bootstrap)update(state,r);
      bootstrapUsed+=bootstrap.length;
    }else{
      const needed=Math.max(0,seedLeagueMatches-bootstrap.length);
      if(list.length<=needed)continue;
      const seed=[...bootstrap,...list.slice(0,needed)];
      state=initState(seed,cfg);if(!state)continue;
      for(const r of seed)update(state,r);
      bootstrapUsed+=bootstrap.length;
      startIndex=needed;
    }

    const c=accumulator(),h=accumulator();
    for(const row of list.slice(startIndex)){
      const beforeHome=state.teamMatches[row.homeKey]||0,beforeAway=state.teamMatches[row.awayKey]||0;
      const q=predict(state,row);
      const versionOk=!targetVersion||row.analysisVersion===targetVersion;
      const comparable=versionOk&&q&&row.champion&&beforeHome>=minTeamMatches&&beforeAway>=minTeamMatches;
      if(comparable){
        addMetric(champion,row.champion,row.score);addMetric(challenger,q.marketProbabilities,row.score);
        addMetric(c,row.champion,row.score);addMetric(h,q.marketProbabilities,row.score);eligible++;
      }
      update(state,row);
    }
    if(c.fixtures){
      const C=finish(c),H=finish(h);
      leagueResults[leagueId]={league:list[0]?.league||'',fixtures:c.fixtures,champion:C,challenger:H,delta:delta(C,H)};
    }
  }
  const C=finish(champion),H=finish(challenger),D=delta(C,H);
  const binaryDeltas=Object.values(D.binary).filter(Number.isFinite);
  const enough=eligible>=500;
  const better=enough&&Number.isFinite(D.logLoss)&&Number.isFinite(D.rps)&&D.logLoss<0&&D.rps<=0
    &&binaryDeltas.filter(x=>x<=0).length>=3&&binaryDeltas.filter(x=>x>.002).length===0;
  return{
    status:!enough?'INSUFFICIENT_COMPARABLE_HISTORY':better?'HISTORICAL_EVIDENCE_PASS':'NO_IMPROVEMENT_PROVEN',
    targetVersion:targetVersion||'ALL',seedLeagueMatches,minTeamMatches,settledFixtures:rows.length,comparableFixtures:eligible,
    bootstrapRowsUsed:bootstrapUsed,champion:C,challenger:H,delta:D,leagues:leagueResults,
    automaticPromotion:false,
    note:'Historical replay qualifies research only. Forward shadow evidence is still required before any production promotion.',
  };
}
