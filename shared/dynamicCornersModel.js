import { CORNER_LINES, cornersMarketKey, overProbability } from './cornersModel.js';

export const DYNAMIC_CORNERS_VERSION='V11.0-Dynamic-Corners-Shadow';
export const DYNAMIC_CORNERS_DEFAULTS=Object.freeze({
  learningRate:0.002,
  globalLearningScale:0.005,
  blendDynamic:0.75,
  minLeagueMatches:60,
  minTeamMatches:3,
  minLambda:0.3,
  maxLambda:12,
  dispersionWindow:400,
});

const fold=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const get=(o,k)=>Number.isFinite(Number(o?.[k]))?Number(o[k]):0;

export function buildDynamicCornersModel(rows=[],options={}){
  const cfg={...DYNAMIC_CORNERS_DEFAULTS,...options};
  const list=[...(rows||[])].filter(r=>Number.isInteger(r?.hc)&&Number.isInteger(r?.ac)&&r?.home&&r?.away)
    .sort((a,b)=>Number(a.date)-Number(b.date));
  if(list.length<cfg.minLeagueMatches)return null;
  const leagueHome=list.reduce((s,r)=>s+r.hc,0)/list.length;
  const leagueAway=list.reduce((s,r)=>s+r.ac,0)/list.length;
  if(!(leagueHome>0&&leagueAway>0))return null;
  const state={version:DYNAMIC_CORNERS_VERSION,config:cfg,matches:0,leagueHome,leagueAway,
    mu:Math.log(leagueAway),homeAdvantage:Math.log(leagueHome/leagueAway),attack:{},defence:{},teamMatches:{},residuals:[],trainedThrough:null};
  for(const r of list){
    const h=fold(r.home),a=fold(r.away);if(!h||!a||h===a)continue;
    const dynHome=clamp(Math.exp(state.mu+state.homeAdvantage+get(state.attack,h)-get(state.defence,a)),cfg.minLambda,cfg.maxLambda);
    const dynAway=clamp(Math.exp(state.mu+get(state.attack,a)-get(state.defence,h)),cfg.minLambda,cfg.maxLambda);
    const eH=r.hc-dynHome,eA=r.ac-dynAway;
    state.attack[h]=get(state.attack,h)+cfg.learningRate*eH;
    state.defence[a]=get(state.defence,a)-cfg.learningRate*eH;
    state.attack[a]=get(state.attack,a)+cfg.learningRate*eA;
    state.defence[h]=get(state.defence,h)-cfg.learningRate*eA;
    state.mu+=cfg.learningRate*cfg.globalLearningScale*(eH+eA);
    state.homeAdvantage+=cfg.learningRate*cfg.globalLearningScale*eH;
    state.teamMatches[h]=(state.teamMatches[h]||0)+1;state.teamMatches[a]=(state.teamMatches[a]||0)+1;
    const bh=cfg.blendDynamic*dynHome+(1-cfg.blendDynamic)*leagueHome;
    const ba=cfg.blendDynamic*dynAway+(1-cfg.blendDynamic)*leagueAway;
    state.residuals.push({mu:bh+ba,y:r.hc+r.ac});
    if(state.residuals.length>cfg.dispersionWindow)state.residuals.shift();
    state.matches++;state.trainedThrough=r.date;
  }
  if(state.residuals.length>=50){
    const mean=state.residuals.reduce((s,x)=>s+x.mu,0)/state.residuals.length;
    const mse=state.residuals.reduce((s,x)=>s+(x.y-x.mu)**2,0)/state.residuals.length;
    const excess=mse-mean;
    state.size=excess>0?Math.min(200,Math.max(5,mean*mean/excess)):null;
  }else state.size=null;
  return state;
}

export function predictDynamicCorners(model,match={}){
  if(!model)return{status:'UNAVAILABLE',version:DYNAMIC_CORNERS_VERSION,reason:'LEAGUE_HISTORY_UNAVAILABLE'};
  const cfg=model.config||DYNAMIC_CORNERS_DEFAULTS,h=fold(match.home),a=fold(match.away),hN=model.teamMatches?.[h]||0,aN=model.teamMatches?.[a]||0;
  if(hN<cfg.minTeamMatches||aN<cfg.minTeamMatches)return{status:'UNAVAILABLE',version:DYNAMIC_CORNERS_VERSION,reason:'TEAM_HISTORY_TOO_THIN',homeMatches:hN,awayMatches:aN};
  const dynHome=clamp(Math.exp(model.mu+model.homeAdvantage+get(model.attack,h)-get(model.defence,a)),cfg.minLambda,cfg.maxLambda);
  const dynAway=clamp(Math.exp(model.mu+get(model.attack,a)-get(model.defence,h)),cfg.minLambda,cfg.maxLambda);
  const home=cfg.blendDynamic*dynHome+(1-cfg.blendDynamic)*model.leagueHome;
  const away=cfg.blendDynamic*dynAway+(1-cfg.blendDynamic)*model.leagueAway;
  const total=home+away,lines={};
  for(const line of CORNER_LINES)lines[cornersMarketKey(line)]=Math.round(overProbability(total,line,model.size)*1000)/10;
  return{status:'AVAILABLE',version:DYNAMIC_CORNERS_VERSION,expectedTotal:+total.toFixed(1),expectedHome:+home.toFixed(1),expectedAway:+away.toFixed(1),
    lines,leagueMatches:model.matches,homeMatches:hN,awayMatches:aN,trainedThrough:model.trainedThrough};
}
