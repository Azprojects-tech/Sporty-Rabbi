// Research-led opportunity discovery. Suggestions are not betting instructions.
// Uses the existing Daily Desk probabilities; never fabricates missing markets or prices.
export const DISCOVERY_MARKETS = Object.freeze([
  { key:'over25', title:'Goal festival', minimum:.68, minimumLegs:3 },
  { key:'home_win', title:'Home-win cluster', minimum:.72, minimumLegs:3 },
  { key:'away_win', title:'Away-win cluster', minimum:.72, minimumLegs:3 },
  { key:'over15', title:'Goal consistency', minimum:.78, minimumLegs:3 },
]);
const round=(v,n=1)=>Number(v.toFixed(n));
export function discoverOpportunities(cards, {now=Date.now(), maxLegs=6, maxSuggestions=12, markets=DISCOVERY_MARKETS}={}) {
  const suggestions=[];
  for(const spec of markets){
    const eligible=(cards||[]).filter(c=>c?.status==='NS' && Number.isFinite(Date.parse(c.kickoffUTC)) && Date.parse(c.kickoffUTC)>now)
      .map(c=>({card:c, market:c.markets?.find(m=>m.marketKey===spec.key)}))
      .filter(({market})=>Number.isFinite(market?.probability) && market.probability/100>=spec.minimum && market.probability<=100)
      .sort((a,b)=>b.market.probability-a.market.probability || Date.parse(a.card.kickoffUTC)-Date.parse(b.card.kickoffUTC));
    // A cross-league search; no minimum combined-probability veto.
    const chosen=[], usedTeams=new Set();
    for(const candidate of eligible){
      const c=candidate.card;
      if(chosen.length>=maxLegs)break;
      const teams=[c.homeTeamId,c.awayTeamId].filter(v=>v!==null&&v!==undefined).map(String);
      if(chosen.some(v=>String(v.card.id)===String(c.id)) || teams.some(t=>usedTeams.has(t)))continue;
      chosen.push(candidate);teams.forEach(t=>usedTeams.add(t));
    }
    if(chosen.length<spec.minimumLegs)continue;
    // Show smaller and larger alternatives rather than only one forced accumulator.
    for(let count=spec.minimumLegs;count<=chosen.length;count++){
      const legs=chosen.slice(0,count).map(({card:c,market:m})=>({
        fixtureId:c.id,match:`${c.home} v ${c.away}`,league:c.league,kickoffUTC:c.kickoffUTC,
        marketKey:spec.key,selection:m.selection,probability:round(m.probability),
        odds:Number.isFinite(m.odds)&&m.odds>1?m.odds:null,
        priceStatus:Number.isFinite(m.odds)&&m.odds>1&&Date.parse(c.quoteExpiresAt)>now?'REFERENCE_PRICE':'UNAVAILABLE',
      }));
      const joint=legs.reduce((v,l)=>v*l.probability/100,1);
      const priced=legs.every(l=>l.priceStatus==='REFERENCE_PRICE');
      const sameBook=chosen.slice(0,count).every(({card})=>card.bookmaker?.id && String(card.bookmaker.id)===String(chosen[0].card.bookmaker?.id));
      const combinedOdds=priced&&sameBook?legs.reduce((v,l)=>v*l.odds,1):null;
      suggestions.push({
        id:`${spec.key}-${legs.map(l=>l.fixtureId).join('-')}`,title:spec.title,
        marketKey:spec.key,legs,combinedProbability:round(joint*100,2),
        fairOdds:round(1/joint,2),combinedReferenceOdds:combinedOdds?round(combinedOdds,2):null,
        priceStatus:combinedOdds?'REFERENCE_ONLY':'PRICE_UNAVAILABLE',
        estimatedEdge:combinedOdds?round(joint*combinedOdds-1,3):null,
        note:'Exploratory combination. Probabilities assume independent fixtures; review team news, correlations and live bookmaker prices.',
      });
    }
  }
  return suggestions.sort((a,b)=>b.legs.length-a.legs.length || b.combinedProbability-a.combinedProbability).slice(0,maxSuggestions);
}
