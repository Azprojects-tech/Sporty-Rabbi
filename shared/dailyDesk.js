import { withPriceChecks } from './pickCalibration.js';
import { combinationProbabilityFloor } from '../backend/src/services/ticketSelectionService.js';

export const dayUK = ms => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
export const DESK_MARKETS = ['home_win','draw','away_win','over15','over25','under25','btts'];
const labels={home_win:'Home win',draw:'Draw',away_win:'Away win',over15:'Over 1.5 goals',over25:'Over 2.5 goals',under25:'Under 2.5 goals',btts:'Both teams score'};
export function deskCard(match, calibration, corners = null) {
  const core=match.analysis?.predictionCore;
  if(!core?.coreReady) return null;
  const raw=core.poisson?.marketProbabilities || {};
  const recommendations=DESK_MARKETS.filter(k=>Number.isFinite(raw[k]) && raw[k]>0 && raw[k]<1).map(k=>({
    marketKey:k, selection:k==='home_win'?`${match.home} win`:k==='away_win'?`${match.away} win`:labels[k],
    modelProbability:raw[k]*100, probability01:raw[k], evidenceGate:{passed:core.reliability>=55},
  }));
  const a=withPriceChecks({...match.analysis,recommendations,oddsSnapshot:match.oddsSnapshot},calibration,match);
  const markets=a.recommendations.map(r=>({marketKey:r.marketKey,selection:r.selection,
    probability:r.modelProbability,rawProbability:r.rawModelProbability,basis:r.probabilitySource,
    decision:r.decisionState,odds:r.value.offeredOdds,minimumOdds:r.priceCheck.minimumOdds,
    expectedValue:r.value.expectedValue,calibrationBuiltAt:r.priceCheck.calibrationBuiltAt}));
  return {id:match.id,home:match.home,away:match.away,homeTeamId:match.homeTeamId??null,awayTeamId:match.awayTeamId??null,
    league:match.league??'',leagueId:match.leagueId??null,kickoffUTC:match.kickoffUTC,status:match.status,
    evidence:core.reliability,analysisVersion:match.analysis.analysisVersion,markets,
    best:markets.find(m=>m.decision==='BET') || markets.find(m=>m.decision==='NEEDS_PRICE') || null,
    bookmaker:match.oddsSnapshot?.bookmaker??null,quoteAt:match.oddsSnapshot?.providerUpdatedAt??null,
    quoteExpiresAt:match.oddsSnapshot?.expiresAt??null,
    history:core.inputSummary??null,
    contextSummary:core.inputSummary ? `${match.home}: ${core.inputSummary.homeSampleSize ?? 'unavailable'} recent games, ${core.inputSummary.homeGoalsAvgFor ?? 'unavailable'} scored / ${core.inputSummary.homeGoalsAvgAgainst ?? 'unavailable'} conceded per game. ${match.away}: ${core.inputSummary.awaySampleSize ?? 'unavailable'} games, ${core.inputSummary.awayGoalsAvgFor ?? 'unavailable'} scored / ${core.inputSummary.awayGoalsAvgAgainst ?? 'unavailable'} conceded. Season ${core.inputSummary.season ?? 'unavailable'}.` : 'Team history unavailable',
    corners:corners?.status==='AVAILABLE'?{expectedTotal:corners.expectedTotal,lines:corners.lines,source:corners.source}:null};
}
export function buildDailyDesk(matches, calibration, { now=Date.now(), limit=6, predictCorners=()=>null }={}) {
  const seen=new Set();
  const cards=matches.filter(m=>m.status==='NS' && Date.parse(m.kickoffUTC)>now && dayUK(Date.parse(m.kickoffUTC))===dayUK(now))
    .map(m=>deskCard(m,calibration,predictCorners(m))).filter(c=>c && c.best && !seen.has(String(c.id)) && seen.add(String(c.id)))
    .sort((a,b)=>(a.best.decision==='BET'?0:1)-(b.best.decision==='BET'?0:1)
      || b.best.probability-a.best.probability || Date.parse(a.kickoffUTC)-Date.parse(b.kickoffUTC)).slice(0,limit);
  return {dateUK:dayUK(now),generatedAt:new Date(now).toISOString(),cards,
    combinations:[2,3].map(target=>targetCombination(cards,target,now))};
}
export function targetCombination(cards,target,now=Date.now()) {
  const eligible=cards.filter(c=>c.status==='NS' && Date.parse(c.kickoffUTC)>now && Date.parse(c.quoteExpiresAt)>now
    && c.best?.decision==='BET' && c.best.odds>1 && c.bookmaker?.id);
  let best=null;
  const visit=(legs,start)=>{
    if(legs.length>=2){
      const book=new Set(legs.map(l=>String(l.bookmaker.id))), ids=new Set(legs.map(l=>String(l.id)));
      const teams=legs.flatMap(l=>[l.homeTeamId,l.awayTeamId]);
      const uniqueTeams=teams.every(Boolean) && new Set(teams.map(String)).size===teams.length;
      const odds=legs.reduce((v,l)=>v*l.best.odds,1);
      const probability=combinationProbabilityFloor(legs.map(l=>l.best.probability/100));
      if(book.size===1 && ids.size===legs.length && uniqueTeams && odds>=target && odds<=target*1.15
        && probability>=.512 && probability*odds-1>=.05) {
        const item={target,available:true,odds:+odds.toFixed(3),probabilityFloor:+(probability*100).toFixed(1),
          bookmaker:legs[0].bookmaker,legs:legs.map(l=>({id:l.id,match:`${l.home} v ${l.away}`,...l.best}))};
        if(!best || item.odds<best.odds) best=item;
      }
    }
    if(legs.length===3)return;
    for(let i=start;i<eligible.length;i++)visit([...legs,eligible[i]],i+1);
  };visit([],0);
  return best||{target,available:false,reason:'No combination meets the probability and price requirements'};
}
const pct = value => Number.isFinite(value)?`${value.toFixed(1)}%`:'Unavailable';
export function formatDailyDesk(desk) {
  const lines=[`SportyRabbi · ${desk.dateUK}`, 'Daily shortlist'];
  for(const c of desk.cards){
    const time=new Date(c.kickoffUTC).toLocaleTimeString('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'});
    const find=k=>pct(c.markets.find(m=>m.marketKey===k)?.probability);
    lines.push(`\n${c.home} v ${c.away} · ${time} UK`, `Home ${find('home_win')} · Draw ${find('draw')} · Away ${find('away_win')}`,
      `Over 1.5 ${find('over15')} · Over 2.5 ${find('over25')}`,
      `${c.best.selection}: ${pct(c.best.probability)} · Minimum odds ${c.best.minimumOdds.toFixed(2)}`,
      c.best.odds?`${c.bookmaker?.name||'Reference bookmaker'} odds ${c.best.odds.toFixed(2)} · ${c.best.decision==='BET'?'Qualifies':'Watch'}`:'Price unavailable · Watch');
    lines.push(c.contextSummary);
    lines.push(c.corners?Object.entries(c.corners.lines).map(([k,v])=>`Corners over ${k.replace('corners_over','').replace(/(\d)$/,'.$1')}: ${pct(v)}`).join(' · '):'Corners unavailable');
  }
  if(!desk.cards.length)lines.push('No qualifying games in the prepared schedule.');
  for(const combo of desk.combinations)lines.push(combo.available?`\nTarget ${combo.target}.0: ${combo.legs.map(l=>`${l.match}: ${l.selection}`).join(' + ')}\nTotal odds ${combo.odds} · Combined probability floor ${combo.probabilityFloor}%`:`\nTarget ${combo.target}.0: no qualifying combination.`);
  lines.push('\nReference prices are timestamped in the portal. Live updates follow this shortlist.');
  return lines.join('\n');
}
