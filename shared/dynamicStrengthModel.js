import { LIVE_STATUSES, remainingForecast, scoreDistribution } from './forecastMath.js';

export const DYNAMIC_STRENGTH_VERSION = 'V11.0-Dynamic-Team-Strength-Shadow';
export const DYNAMIC_STRENGTH_DEFAULTS = Object.freeze({
  learningRate: 0.015,
  globalLearningScale: 0.015,
  rho: -0.08,
  minLeagueMatches: 60,
  minTeamMatches: 3,
  minLambda: 0.08,
  maxLambda: 4.5,
});

const finite = v => { const n=Number(v); return Number.isFinite(n) ? n : null; };
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const teamKey = name => String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

function parseScore(value){
  const m=String(value||'').match(/^(\d+)\s*-\s*(\d+)$/);
  if(!m)return null;
  const home=Number(m[1]),away=Number(m[2]);
  return Number.isInteger(home)&&Number.isInteger(away)?{home,away}:null;
}

export function strengthRowsFromLedger(docs=[]){
  const byFixture=new Map();
  for(const d of docs||[]){
    const leagueId=finite(d?.leagueId),score=parseScore(d?.finalScore),kickoff=Date.parse(d?.kickoffUTC||'');
    const home=String(d?.home||'').trim(),away=String(d?.away||'').trim();
    if(!(leagueId>0)||!score||!Number.isFinite(kickoff)||!home||!away||home===away)continue;
    const id=String(d?.matchId??'');
    if(!id)continue;
    const row={fixtureId:id,leagueId,league:String(d?.league||''),leagueCountry:String(d?.leagueCountry||''),kickoffUTC:new Date(kickoff).toISOString(),kickoff,
      home,away,homeKey:teamKey(home),awayKey:teamKey(away),homeGoals:score.home,awayGoals:score.away};
    if(!row.homeKey||!row.awayKey||row.homeKey===row.awayKey)continue;
    const key=String(leagueId)+'|'+id,prior=byFixture.get(key);
    if(!prior||kickoff<prior.kickoff)byFixture.set(key,row);
  }
  return [...byFixture.values()].sort((a,b)=>a.kickoff-b.kickoff||String(a.fixtureId).localeCompare(String(b.fixtureId)));
}

const get=(obj,key)=>finite(obj?.[key])??0;

export function trainDynamicStrength(rows=[], options={}){
  const cfg={...DYNAMIC_STRENGTH_DEFAULTS,...options};
  const grouped=new Map();
  for(const row of rows||[]){const k=String(row.leagueId);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(row);}
  const leagues={};
  for(const [key,list0] of grouped){
    const list=[...list0].sort((a,b)=>a.kickoff-b.kickoff);
    if(list.length<cfg.minLeagueMatches)continue;
    const homeMean=list.reduce((s,r)=>s+r.homeGoals,0)/list.length;
    const awayMean=list.reduce((s,r)=>s+r.awayGoals,0)/list.length;
    if(!(homeMean>0&&awayMean>0))continue;
    const state={leagueId:Number(key),league:list[list.length-1]?.league||'',leagueCountry:list[list.length-1]?.leagueCountry||'',matches:0,
      mu:Math.log(awayMean),homeAdvantage:Math.log(homeMean/awayMean),attack:{},defence:{},teamMatches:{},trainedThrough:null};
    for(const r of list){
      const ah=get(state.attack,r.homeKey),aa=get(state.attack,r.awayKey),dh=get(state.defence,r.homeKey),da=get(state.defence,r.awayKey);
      const homeLambda=clamp(Math.exp(state.mu+state.homeAdvantage+ah-da),cfg.minLambda,cfg.maxLambda);
      const awayLambda=clamp(Math.exp(state.mu+aa-dh),cfg.minLambda,cfg.maxLambda);
      const eHome=r.homeGoals-homeLambda,eAway=r.awayGoals-awayLambda;
      state.attack[r.homeKey]=ah+cfg.learningRate*eHome;
      state.defence[r.awayKey]=da-cfg.learningRate*eHome;
      state.attack[r.awayKey]=aa+cfg.learningRate*eAway;
      state.defence[r.homeKey]=dh-cfg.learningRate*eAway;
      state.mu+=cfg.learningRate*cfg.globalLearningScale*(eHome+eAway);
      state.homeAdvantage+=cfg.learningRate*cfg.globalLearningScale*eHome;
      state.teamMatches[r.homeKey]=(state.teamMatches[r.homeKey]||0)+1;
      state.teamMatches[r.awayKey]=(state.teamMatches[r.awayKey]||0)+1;
      state.matches++;
      state.trainedThrough=r.kickoffUTC;
    }
    leagues[key]=state;
  }
  return {version:DYNAMIC_STRENGTH_VERSION,builtAt:new Date().toISOString(),trainingRows:(rows||[]).length,leagueCount:Object.keys(leagues).length,config:cfg,leagues};
}

export function predictDynamicStrength(model,match={}){
  const cfg=model?.config||DYNAMIC_STRENGTH_DEFAULTS,leagueId=finite(match.leagueId);
  const state=leagueId!=null?model?.leagues?.[String(leagueId)]:null;
  if(!state)return {status:'UNAVAILABLE',version:DYNAMIC_STRENGTH_VERSION,reason:'LEAGUE_HISTORY_UNAVAILABLE'};
  const h=teamKey(match.home),a=teamKey(match.away),hN=state.teamMatches?.[h]||0,aN=state.teamMatches?.[a]||0;
  if(!h||!a||h===a)return {status:'UNAVAILABLE',version:DYNAMIC_STRENGTH_VERSION,reason:'TEAM_IDENTITY_UNAVAILABLE'};
  if(hN<cfg.minTeamMatches||aN<cfg.minTeamMatches)return {status:'UNAVAILABLE',version:DYNAMIC_STRENGTH_VERSION,reason:'TEAM_HISTORY_TOO_THIN',homeMatches:hN,awayMatches:aN};
  const homeLambda=clamp(Math.exp(state.mu+state.homeAdvantage+get(state.attack,h)-get(state.defence,a)),cfg.minLambda,cfg.maxLambda);
  const awayLambda=clamp(Math.exp(state.mu+get(state.attack,a)-get(state.defence,h)),cfg.minLambda,cfg.maxLambda);
  const live=LIVE_STATUSES.has(String(match.status||'').toUpperCase());
  const forecast=live?remainingForecast(match,homeLambda,awayLambda):scoreDistribution(homeLambda,awayLambda,{rho:cfg.rho});
  if(!forecast||forecast.available===false)return {status:'UNAVAILABLE',version:DYNAMIC_STRENGTH_VERSION,reason:forecast?.reason||'FORECAST_UNAVAILABLE',homeMatches:hN,awayMatches:aN};
  return {status:'AVAILABLE',version:DYNAMIC_STRENGTH_VERSION,phase:live?'LIVE':'PRE_MATCH',parameterStatus:'EMPIRICALLY_FITTED_FROM_SETTLED_LEDGER',
    trainedThrough:state.trainedThrough,leagueMatches:state.matches,homeMatches:hN,awayMatches:aN,homeLambda:+homeLambda.toFixed(5),awayLambda:+awayLambda.toFixed(5),
    expectedTotalGoals:Number.isFinite(forecast.expectedTotalGoals)?+forecast.expectedTotalGoals.toFixed(3):+(homeLambda+awayLambda).toFixed(3),
    marketProbabilities:forecast.marketProbabilities||{},likelyScore:forecast.likelyScore||null,
    live:live?{minute:forecast.minute,minutesRemaining:forecast.minutesRemaining,remainingLambda:forecast.remainingLambda,nextGoal:forecast.nextGoal}:null};
}
