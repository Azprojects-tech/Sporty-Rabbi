import { discoverOpportunities } from './opportunityDiscovery.js';
import { withPriceChecks } from './pickCalibration.js';
import { combinationProbabilityFloor } from '../backend/src/services/ticketSelectionService.js';
import { formatTicket } from './morningSelections.js';

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
  const wins=markets.filter(m=>m.marketKey==='home_win'||m.marketKey==='away_win').sort((a,b)=>b.probability-a.probability);
  if(wins.length)markets.push({...wins[0],marketKey:'team_win'});
  if(corners?.status==='AVAILABLE' && Number.isFinite(corners.lines?.corners_over85)) markets.push({marketKey:'corners_over85',selection:'Over 8.5 corners',probability:corners.lines.corners_over85,rawProbability:corners.lines.corners_over85,basis:'CORNERS_HISTORICAL_MODEL',decision:'RESEARCH_ONLY',odds:null,minimumOdds:null});
  return {id:match.id,home:match.home,away:match.away,country:match.country??match.countryName??null,homeTeamId:match.homeTeamId??null,awayTeamId:match.awayTeamId??null,
    league:match.league??'',leagueId:match.leagueId??null,season:match.season??core.inputSummary?.season??null,kickoffUTC:match.kickoffUTC,status:match.status,
    evidence:core.reliability,signalScore:core.dailySignal?.score??null,analysisVersion:match.analysis.analysisVersion,markets,
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
    combinations:[2,3].map(target=>targetCombination(cards,target,now)),
    opportunities:discoverOpportunities(matches.filter(m=>m.status==='NS' && Date.parse(m.kickoffUTC)>now && dayUK(Date.parse(m.kickoffUTC))===dayUK(now)).map(m=>deskCard(m,calibration,predictCorners(m))).filter(Boolean),{now})};
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
  const time=c=>new Date(c.kickoffUTC).toLocaleTimeString('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'});
  const lines=[`🐰 SPORTYRABBI MORNING BRIEF | ${desk.dateUK}`, '━━━━━━━━━━━━━━━━━━━━', '📋 MAIN SHORTLIST'];
  for(const c of desk.cards||[]){
    const find=k=>pct(c.markets.find(m=>m.marketKey===k)?.probability);
    lines.push(`\n⚽ ${c.home} vs ${c.away} · ${time(c)} UK\n🏆 ${c.league||'League unavailable'}\nHome ${find('home_win')} · Draw ${find('draw')} · Away ${find('away_win')}\nO1.5 ${find('over15')} · O2.5 ${find('over25')}\n➡️ ${c.best.selection} ${pct(c.best.probability)} · min odds ${Number.isFinite(c.best.minimumOdds)?c.best.minimumOdds.toFixed(2):'—'}${c.best.odds?` · ${c.bookmaker?.name||'Bookmaker'} ${c.best.odds.toFixed(2)}`:' · price unavailable'}`);
  }
  if(!(desk.cards||[]).length)lines.push('No qualifying main-shortlist games today.');

  lines.push('\n━━━━━━━━━━━━━━━━━━━━\n🏟️ TOP LEAGUES');
  if(desk.topLeagues?.length){
    for(const c of desk.topLeagues) lines.push(`• ${time(c)} · ${c.home} v ${c.away} (${c.league})\n  ${c.selected.selection} ${pct(c.selected.probability)}${c.selected.odds?` @ ${c.selected.odds.toFixed(2)}`:' · price unavailable'}`);
  } else lines.push('No analysed top-league fixture qualifies today.');

  lines.push('\n━━━━━━━━━━━━━━━━━━━━\n💼 FOUR-TIER DAILY PORTFOLIO');
  lines.push(formatTicket(desk.portfolio?.tier1,'TIER 1 — CORE','🛡️'));
  lines.push(formatTicket(desk.portfolio?.tier2,'TIER 2 — BALANCED','⚖️'));
  lines.push(formatTicket(desk.portfolio?.tier3,'TIER 3 — AGGRESSIVE','🎯'));
  lines.push(formatTicket(desk.portfolio?.tier4,'TIER 4 — MAJOR','🔥'));
  lines.push('No tier is forced. Fixtures/teams are not reused across tiers.');

  lines.push('\n━━━━━━━━━━━━━━━━━━━━\n⏱️ 1H GOAL WATCH · RESEARCH');
  if(desk.firstHalfWatch?.length){
    for(const x of desk.firstHalfWatch) lines.push(`• ${time(x)} · ${x.home} v ${x.away} (${x.league})\n  Any 1H goal proxy ${pct(x.probability)} · λ1H ${x.lambda}${x.likelyTeam?`\n  Early-team watch: ${x.likelyTeam.team} to score 1H ${pct(x.likelyTeam.probability)}`:''}${x.regulationOver15!=null?` · main O1.5 ${pct(x.regulationOver15)}`:''}`);
    lines.push('Research selector from season goal-minute rates; not yet a calibrated 1H betting market.');
  } else lines.push('No 1H research watch meets the current evidence gate.');

  lines.push('\n━━━━━━━━━━━━━━━━━━━━\n🚩 CORNERS');
  if(desk.cornersWatch?.length){
    for(const x of desk.cornersWatch) lines.push(`• ${time(x)} · ${x.home} v ${x.away} (${x.league})\n  Over ${x.line} corners ${pct(x.probability)}${x.expectedTotal!=null?` · estimated total ${x.expectedTotal.toFixed(1)}`:''}`);
  } else lines.push('No covered corner market meets the morning threshold.');

  if(desk.opportunities?.length){
    lines.push('\n━━━━━━━━━━━━━━━━━━━━\n🔎 OTHER OPPORTUNITIES');
    for(const o of desk.opportunities.slice(0,4)) lines.push(`• ${o.title}: ${o.legs.map(l=>l.match+' — '+l.selection).join(' + ')}\n  Joint estimate ${o.combinedProbability}% · fair odds ${o.fairOdds}${o.combinedReferenceOdds?` · reference ${o.combinedReferenceOdds}`:' · price unavailable'}`);
  }

  lines.push('\n━━━━━━━━━━━━━━━━━━━━\nℹ️ Engine probabilities are unchanged. This brief only groups and extracts the day’s signals.');
  return lines.join('\n');
}
