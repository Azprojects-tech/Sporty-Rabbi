export const TOP_LEAGUE_IDS = new Set([2,3,848,39,140,78,135,61,88,94]);

const n=v=>Number.isFinite(Number(v))?Number(v):null;
const pct=v=>n(v)==null?'Unavailable':`${n(v).toFixed(1)}%`;
const fairFloor=ps=>Math.max(0,ps.reduce((a,b)=>a+b,0)-ps.length+1);

function teams(card){
  return [card?.homeTeamId,card?.awayTeamId].filter(v=>v!==null&&v!==undefined).map(String);
}

function pricedCandidates(cards=[],now=Date.now()){
  return cards.filter(c=>c?.best?.decision==='BET'
    && n(c.best.odds)>1
    && c.bookmaker?.id
    && (!c.quoteExpiresAt || Date.parse(c.quoteExpiresAt)>now)
    && n(c.best.probability)>0 && n(c.best.probability)<100);
}

export function buildTopLeaguePicks(cards=[],{limit=6}={}){
  return cards.filter(c=>TOP_LEAGUE_IDS.has(Number(c.leagueId)))
    .map(c=>{
      const strongest=[...(c.markets||[])].filter(m=>n(m.probability)!=null).sort((a,b)=>b.probability-a.probability)[0]||null;
      const selected=c.best||strongest;
      return selected?{...c,selected}:null;
    }).filter(Boolean)
    .sort((a,b)=>{
      const aBet=a.selected?.decision==='BET'?1:0,bBet=b.selected?.decision==='BET'?1:0;
      return bBet-aBet || (b.selected?.probability||0)-(a.selected?.probability||0);
    }).slice(0,limit);
}

function chooseSingle(candidates,usedFixtures,usedTeams){
  const pool=candidates.filter(c=>!usedFixtures.has(String(c.id)) && teams(c).every(t=>!usedTeams.has(t)))
    .filter(c=>c.best.odds>=1.25&&c.best.odds<=1.8&&c.best.probability>=70)
    .sort((a,b)=>b.best.probability-a.best.probability
      || Math.abs(a.best.odds-1.5)-Math.abs(b.best.odds-1.5));
  const c=pool[0];
  if(!c)return null;
  return {available:true,targetOdds:1.5,odds:c.best.odds,probabilityFloor:c.best.probability/100,
    expectedValue:(c.best.probability/100)*c.best.odds-1,bookmaker:c.bookmaker,
    legs:[{fixtureId:c.id,homeTeamId:c.homeTeamId,awayTeamId:c.awayTeamId,match:`${c.home} v ${c.away}`,league:c.league,kickoffUTC:c.kickoffUTC,...c.best}]};
}

function chooseCombo(candidates,target,usedFixtures,usedTeams,{maxLegs=3}={}){
  const pool=candidates.filter(c=>!usedFixtures.has(String(c.id)) && teams(c).every(t=>!usedTeams.has(t))).slice(0,30);
  let best=null;
  const visit=(legs,start)=>{
    if(legs.length>=2){
      const ids=new Set(legs.map(c=>String(c.id)));
      const allTeams=legs.flatMap(teams);
      const books=new Set(legs.map(c=>String(c.bookmaker?.id||'')));
      const odds=legs.reduce((v,c)=>v*c.best.odds,1);
      const probs=legs.map(c=>c.best.probability/100);
      const floor=fairFloor(probs);
      const ev=floor*odds-1;
      const inBand=odds>=target*.90&&odds<=target*1.15;
      if(ids.size===legs.length&&new Set(allTeams).size===allTeams.length&&books.size===1&&inBand&&floor>=.512&&ev>=.05){
        const item={available:true,targetOdds:target,odds:+odds.toFixed(3),probabilityFloor:floor,expectedValue:ev,
          bookmaker:legs[0].bookmaker,legs:legs.map(c=>({fixtureId:c.id,homeTeamId:c.homeTeamId,awayTeamId:c.awayTeamId,
            match:`${c.home} v ${c.away}`,league:c.league,kickoffUTC:c.kickoffUTC,...c.best}))};
        if(!best || Math.abs(item.odds-target)<Math.abs(best.odds-target)
          || (Math.abs(item.odds-target)===Math.abs(best.odds-target)&&item.probabilityFloor>best.probabilityFloor)) best=item;
      }
    }
    if(legs.length===maxLegs)return;
    for(let i=start;i<pool.length;i++){
      const c=pool[i];
      const cTeams=teams(c),existing=legs.flatMap(teams);
      if(existing.some(t=>cTeams.includes(t)))continue;
      if(legs.length&&String(legs[0].bookmaker?.id)!==String(c.bookmaker?.id))continue;
      visit([...legs,c],i+1);
    }
  };
  visit([],0);
  return best;
}

function reserve(ticket,usedFixtures,usedTeams){
  for(const leg of ticket?.legs||[]){
    usedFixtures.add(String(leg.fixtureId));
    [leg.homeTeamId,leg.awayTeamId].filter(v=>v!==null&&v!==undefined).forEach(v=>usedTeams.add(String(v)));
  }
}

export function buildPortfolioTiers(cards=[],{now=Date.now()}={}){
  const candidates=pricedCandidates(cards,now);
  const usedFixtures=new Set(),usedTeams=new Set();
  const tier1=chooseSingle(candidates,usedFixtures,usedTeams);reserve(tier1,usedFixtures,usedTeams);
  const tier2=chooseCombo(candidates,2,usedFixtures,usedTeams);reserve(tier2,usedFixtures,usedTeams);
  const tier3=chooseCombo(candidates,3,usedFixtures,usedTeams);reserve(tier3,usedFixtures,usedTeams);
  const tier4=chooseCombo(candidates,5,usedFixtures,usedTeams);reserve(tier4,usedFixtures,usedTeams);
  const missing=(tier,target,label)=>tier||{available:false,targetOdds:target,label,reason:'No non-overlapping price-qualified ticket meets the probability and value rules.'};
  return {
    tier1:missing(tier1,1.5,'CORE'),
    tier2:missing(tier2,2,'BALANCED'),
    tier3:missing(tier3,3,'AGGRESSIVE'),
    tier4:missing(tier4,5,'MAJOR'),
  };
}

export function buildFirstHalfGoalWatch(match={},homeStats={},awayStats={}){
  const hs=homeStats?.stats||homeStats,as=awayStats?.stats||awayStats;
  const hPlayed=n(hs?.played),aPlayed=n(as?.played);
  if(hPlayed==null||aPlayed==null||hPlayed<5||aPlayed<5)return null;
  const hFor=n(hs?.firstHalfGoalsForPerGame),hAgainst=n(hs?.firstHalfGoalsAgainstPerGame);
  const aFor=n(as?.firstHalfGoalsForPerGame),aAgainst=n(as?.firstHalfGoalsAgainstPerGame);
  if([hFor,hAgainst,aFor,aAgainst].some(v=>v==null))return null;
  const homeLambda=(hFor+aAgainst)/2;
  const awayLambda=(aFor+hAgainst)/2;
  const lambda=Math.max(.05,Math.min(2.8,homeLambda+awayLambda));
  const probability=1-Math.exp(-lambda);
  const homeScoreProbability=1-Math.exp(-homeLambda);
  const awayScoreProbability=1-Math.exp(-awayLambda);
  const likelyTeam=homeScoreProbability>=awayScoreProbability
    ? {team:match.home,side:'HOME',probability:+(homeScoreProbability*100).toFixed(1)}
    : {team:match.away,side:'AWAY',probability:+(awayScoreProbability*100).toFixed(1)};
  const over15=n(match.analysis?.predictionCore?.poisson?.marketProbabilities?.over15
    ?? match.analysis?.poisson?.marketProbabilities?.over15);
  if(probability<.68 || (over15!=null&&over15<.68))return null;
  return {
    fixtureId:match.id,home:match.home,away:match.away,league:match.league,kickoffUTC:match.kickoffUTC,
    probability:+(probability*100).toFixed(1),lambda:+lambda.toFixed(2),sample:Math.min(hPlayed,aPlayed),
    homeFirstHalfFor:hFor,homeFirstHalfAgainst:hAgainst,awayFirstHalfFor:aFor,awayFirstHalfAgainst:aAgainst,
    homeScoreProbability:+(homeScoreProbability*100).toFixed(1),awayScoreProbability:+(awayScoreProbability*100).toFixed(1),
    likelyTeam:likelyTeam.probability>=50?likelyTeam:null,
    regulationOver15:over15==null?null:+(over15*100).toFixed(1),
    basis:'RESEARCH_1H_SEASON_MINUTE_BUCKETS',
  };
}

export function buildCornersWatch(cards=[],{limit=5,minimum=60}={}){
  const lineDefs=[
    ['corners_over105',10.5],['corners_over95',9.5],['corners_over85',8.5],
  ];
  return cards.map(c=>{
    if(!c?.corners?.lines)return null;
    const chosen=lineDefs.map(([key,line])=>({key,line,p:n(c.corners.lines[key])}))
      .find(x=>x.p!=null&&x.p>=minimum);
    return chosen?{fixtureId:c.id,home:c.home,away:c.away,league:c.league,kickoffUTC:c.kickoffUTC,
      line:chosen.line,probability:chosen.p,expectedTotal:n(c.corners.expectedTotal),source:c.corners.source}:null;
  }).filter(Boolean).sort((a,b)=>b.probability-a.probability||b.line-a.line).slice(0,limit);
}

export function formatTicket(ticket,label,icon){
  if(!ticket?.available)return `${icon} ${label} ~${ticket?.targetOdds||'?'}\nNo qualifying ticket today.`;
  const legs=ticket.legs.map((l,i)=>`${i+1}. ${l.match} — ${l.selection} @ ${Number(l.odds).toFixed(2)} (${pct(l.probability)})`).join('\n');
  return `${icon} ${label} ~${ticket.targetOdds}\n${legs}\nTotal odds ${Number(ticket.odds).toFixed(2)} · probability floor ${pct(ticket.probabilityFloor*100)}`;
}
