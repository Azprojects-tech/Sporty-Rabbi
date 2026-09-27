import { LIVE_STATUSES, remainingForecast, scoreDistribution } from './forecastMath.js';

export const DYNAMIC_STRENGTH_VERSION = 'V11.1-Opponent-Adjusted-Strength-Shadow';
export const DYNAMIC_STRENGTH_DEFAULTS = Object.freeze({
  halfLifeDays: 365,
  windowDays: 730,
  priorGames: 4,
  iterations: 24,
  rho: -0.08,
  minLeagueMatches: 80,
  minTeamMatches: 3,
  minLambda: 0.08,
  maxLambda: 4.5,
});

const DAY = 86400000;
const finite = v => { const n=Number(v); return Number.isFinite(n) ? n : null; };
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
export const dynamicTeamKey = name => String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

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
      home,away,homeKey:dynamicTeamKey(home),awayKey:dynamicTeamKey(away),homeGoals:score.home,awayGoals:score.away};
    if(!row.homeKey||!row.awayKey||row.homeKey===row.awayKey)continue;
    const key=String(leagueId)+'|'+id,prior=byFixture.get(key);
    if(!prior||kickoff<prior.kickoff)byFixture.set(key,row);
  }
  return [...byFixture.values()].sort((a,b)=>a.kickoff-b.kickoff||String(a.fixtureId).localeCompare(String(b.fixtureId)));
}

function geometricMean(values=[]){
  const usable=values.filter(v=>Number.isFinite(v)&&v>0);
  return usable.length?Math.exp(usable.reduce((s,v)=>s+Math.log(v),0)/usable.length):1;
}

/**
 * Fit one league from prior results only.
 *
 * This is an opponent-adjusted multiplicative goals model:
 *   home lambda = league home rate × home attack × away defence
 *   away lambda = league away rate × away attack × home defence
 *
 * Team factors are solved iteratively, regularised toward 1.0 with priorGames
 * pseudo-games and exponentially time-weighted. The formulation is deliberately
 * compact enough to retrain daily and replay without hidden state.
 */
export function fitLeagueStrength(rows=[], options={}, cutoff=null){
  const cfg={...DYNAMIC_STRENGTH_DEFAULTS,...options};
  const raw=[...(rows||[])].filter(r=>Number.isFinite(Number(r?.kickoff))&&Number.isInteger(r?.homeGoals)&&Number.isInteger(r?.awayGoals)
    &&r?.homeKey&&r?.awayKey&&r.homeKey!==r.awayKey).sort((a,b)=>a.kickoff-b.kickoff);
  if(!raw.length)return null;
  const end=cutoff!=null&&Number.isFinite(Number(cutoff))?Number(cutoff):raw[raw.length-1].kickoff;
  const list=raw.filter(r=>r.kickoff<=(end+1)&&end-r.kickoff<=cfg.windowDays*DAY);
  if(list.length<cfg.minLeagueMatches)return null;
  const teams=[...new Set(list.flatMap(r=>[r.homeKey,r.awayKey]))];
  const weight=r=>0.5**((end-r.kickoff)/(cfg.halfLifeDays*DAY));
  let sw=0,homeGoals=0,awayGoals=0;
  for(const r of list){const w=weight(r);sw+=w;homeGoals+=w*r.homeGoals;awayGoals+=w*r.awayGoals;}
  if(!(sw>0))return null;
  const leagueHome=homeGoals/sw,leagueAway=awayGoals/sw;
  if(!(leagueHome>0&&leagueAway>0))return null;
  const attack=Object.fromEntries(teams.map(t=>[t,1]));
  const defence=Object.fromEntries(teams.map(t=>[t,1]));
  for(let iter=0;iter<cfg.iterations;iter++){
    const aNum={},aDen={},dNum={},dDen={};
    for(const t of teams){aNum[t]=cfg.priorGames;aDen[t]=cfg.priorGames;dNum[t]=cfg.priorGames;dDen[t]=cfg.priorGames;}
    for(const r of list){
      const w=weight(r);
      aNum[r.homeKey]+=w*r.homeGoals;
      aDen[r.homeKey]+=w*leagueHome*defence[r.awayKey];
      aNum[r.awayKey]+=w*r.awayGoals;
      aDen[r.awayKey]+=w*leagueAway*defence[r.homeKey];
      dNum[r.homeKey]+=w*r.awayGoals;
      dDen[r.homeKey]+=w*leagueAway*attack[r.awayKey];
      dNum[r.awayKey]+=w*r.homeGoals;
      dDen[r.awayKey]+=w*leagueHome*attack[r.homeKey];
    }
    for(const t of teams){
      attack[t]=clamp(aNum[t]/Math.max(aDen[t],1e-9),0.35,2.7);
      defence[t]=clamp(dNum[t]/Math.max(dDen[t],1e-9),0.35,2.7);
    }
    const gA=geometricMean(Object.values(attack)),gD=geometricMean(Object.values(defence));
    for(const t of teams){attack[t]/=gA;defence[t]/=gD;}
  }
  const teamMatches={};
  for(const r of list){teamMatches[r.homeKey]=(teamMatches[r.homeKey]||0)+1;teamMatches[r.awayKey]=(teamMatches[r.awayKey]||0)+1;}
  return {
    leagueId:list[list.length-1]?.leagueId??null,
    league:list[list.length-1]?.league||'',
    leagueCountry:list[list.length-1]?.leagueCountry||'',
    matches:list.length,leagueHome,leagueAway,attack,defence,teamMatches,
    trainedThrough:list[list.length-1]?.kickoffUTC||new Date(end).toISOString(),
    cutoff:end,
  };
}

export function trainDynamicStrength(rows=[], options={}){
  const cfg={...DYNAMIC_STRENGTH_DEFAULTS,...options};
  const grouped=new Map();
  for(const row of rows||[]){const k=String(row.leagueId);if(!grouped.has(k))grouped.set(k,[]);grouped.get(k).push(row);}
  const leagues={};
  for(const [leagueId,list] of grouped){
    const fitted=fitLeagueStrength(list,cfg);
    if(fitted)leagues[leagueId]=fitted;
  }
  return {version:DYNAMIC_STRENGTH_VERSION,builtAt:new Date().toISOString(),trainingRows:(rows||[]).length,leagueCount:Object.keys(leagues).length,config:cfg,leagues};
}

export function predictFromLeagueStrength(state,match={},options={}){
  if(!state)return null;
  const cfg={...DYNAMIC_STRENGTH_DEFAULTS,...options};
  const h=dynamicTeamKey(match.home),a=dynamicTeamKey(match.away);
  const hN=state.teamMatches?.[h]||0,aN=state.teamMatches?.[a]||0;
  if(!h||!a||h===a||hN<cfg.minTeamMatches||aN<cfg.minTeamMatches)return null;
  const homeLambda=clamp(state.leagueHome*(state.attack?.[h]??1)*(state.defence?.[a]??1),cfg.minLambda,cfg.maxLambda);
  const awayLambda=clamp(state.leagueAway*(state.attack?.[a]??1)*(state.defence?.[h]??1),cfg.minLambda,cfg.maxLambda);
  return {homeLambda,awayLambda,homeMatches:hN,awayMatches:aN};
}

export function predictDynamicStrength(model,match={}){
  const cfg=model?.config||DYNAMIC_STRENGTH_DEFAULTS,leagueId=finite(match.leagueId);
  const state=leagueId!=null?model?.leagues?.[String(leagueId)]:null;
  if(!state)return {status:'UNAVAILABLE',version:DYNAMIC_STRENGTH_VERSION,reason:'LEAGUE_HISTORY_UNAVAILABLE'};
  const raw=predictFromLeagueStrength(state,match,cfg);
  if(!raw){
    const h=dynamicTeamKey(match.home),a=dynamicTeamKey(match.away);
    return {status:'UNAVAILABLE',version:DYNAMIC_STRENGTH_VERSION,reason:'TEAM_HISTORY_TOO_THIN',
      homeMatches:state.teamMatches?.[h]||0,awayMatches:state.teamMatches?.[a]||0};
  }
  const live=LIVE_STATUSES.has(String(match.status||'').toUpperCase());
  const forecast=live?remainingForecast(match,raw.homeLambda,raw.awayLambda):scoreDistribution(raw.homeLambda,raw.awayLambda,{rho:cfg.rho});
  if(!forecast||forecast.available===false)return {status:'UNAVAILABLE',version:DYNAMIC_STRENGTH_VERSION,reason:forecast?.reason||'FORECAST_UNAVAILABLE',
    homeMatches:raw.homeMatches,awayMatches:raw.awayMatches};
  return {status:'AVAILABLE',version:DYNAMIC_STRENGTH_VERSION,phase:live?'LIVE':'PRE_MATCH',parameterStatus:'EMPIRICALLY_FITTED_OPPONENT_ADJUSTED',
    trainedThrough:state.trainedThrough,leagueMatches:state.matches,homeMatches:raw.homeMatches,awayMatches:raw.awayMatches,
    homeLambda:+raw.homeLambda.toFixed(5),awayLambda:+raw.awayLambda.toFixed(5),
    expectedTotalGoals:Number.isFinite(forecast.expectedTotalGoals)?+forecast.expectedTotalGoals.toFixed(3):+(raw.homeLambda+raw.awayLambda).toFixed(3),
    marketProbabilities:forecast.marketProbabilities||{},likelyScore:forecast.likelyScore||null,
    live:live?{minute:forecast.minute,minutesRemaining:forecast.minutesRemaining,remainingLambda:forecast.remainingLambda,nextGoal:forecast.nextGoal}:null};
}
