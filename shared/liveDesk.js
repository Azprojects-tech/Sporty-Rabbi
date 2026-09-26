const number = v => v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const total = pair => number(pair?.home)!=null && number(pair?.away)!=null ? Number(pair.home)+Number(pair.away) : null;
export function liveSnapshot(match, stats, now=Date.now()) {
  const score=String(match.score||'').match(/^(\d+)\s*-\s*(\d+)$/);
  if(!score || !['1H','2H','HT','LIVE'].includes(match.status) || !Number.isFinite(Number(match.matchMinutes)))return null;
  return {fixtureId:match.id,at:new Date(now).toISOString(),minute:Number(match.matchMinutes),status:match.status,
    homeGoals:Number(score[1]),awayGoals:Number(score[2]),shots:total(stats?.totalShots),shotsOnTarget:total(stats?.shots),
    xg:total(stats?.xg),corners:total(stats?.corners),redCards:total({home:stats?.cards?.home?.red,away:stats?.cards?.away?.red}),
    probabilities:openLiveMarkets(match.analysis?.predictionCore?.poisson?.marketProbabilities??{},Number(score[1]),Number(score[2])),
    nextGoal:match.analysis?.predictionCore?.poisson?.live?.nextGoal?.any??null};
}
export function liveChange(current, history=[]) {
  if(!current || current.status==='HT')return null;
  const previous=history.at(-1);
  if(!previous || previous.fixtureId!==current.fixtureId)return null;
  const wallMinutes=(Date.parse(current.at)-Date.parse(previous.at))/60000;
  const minuteDelta=current.minute-previous.minute;
  if(wallMinutes<=0 || wallMinutes>12 || minuteDelta<=0 || minuteDelta>12)return null;
  if(current.homeGoals+current.awayGoals>previous.homeGoals+previous.awayGoals)return {type:'SCORE_CHANGE',reason:'Score changed'};
  if(current.redCards!=null && previous.redCards!=null && current.redCards>previous.redCards)return {type:'RED_CARD',reason:'Red card changes the match state'};
  const baseline=[...history].reverse().find(s=>s.fixtureId===current.fixtureId && current.minute-s.minute>=5 && current.minute-s.minute<=12
    && Date.parse(current.at)-Date.parse(s.at)<=12*60000 && s.status!=='HT');
  if(!baseline)return null;
  const diff=k=>current[k]!=null && baseline[k]!=null && current[k]>=baseline[k]?+(current[k]-baseline[k]).toFixed(2):null;
  const delta={minutes:current.minute-baseline.minute,shots:diff('shots'),xg:diff('xg'),corners:diff('corners')};
  if(delta.xg>=.45 && delta.shots>=4)return {type:'ATTACKING_ACTIVITY',reason:'Attacking activity has increased',delta};
  if(delta.corners>=3 && delta.shots>=3)return {type:'CORNER_ACTIVITY',reason:'Corners and shots have increased',delta};
  return null;
}
export function formatLiveDesk(card,snapshot,event){
  const pct = p=>Number.isFinite(p)?`${(p*100).toFixed(1)}%`:'Unavailable';
  const lines=[`SportyRabbi · ${card.home} v ${card.away}`,`${snapshot.minute}' · ${snapshot.homeGoals}-${snapshot.awayGoals} · ${Math.max(0,90-snapshot.minute)} regulation minutes remaining`,event.reason];
  if(event.delta)lines.push(`Last ${event.delta.minutes} minutes: ${event.delta.shots??'unavailable'} shots · ${event.delta.xg??'unavailable'} xG · ${event.delta.corners??'unavailable'} corners`);
  lines.push(`Over 1.5 ${pct(snapshot.probabilities.over15)} · Over 2.5 ${pct(snapshot.probabilities.over25)}`,
    `Home ${pct(snapshot.probabilities.home_win)} · Draw ${pct(snapshot.probabilities.draw)} · Away ${pct(snapshot.probabilities.away_win)}`,
    `Another goal ${pct(snapshot.nextGoal)}`,
    `Live corners probability: unavailable${snapshot.corners!=null?` · Corners so far: ${snapshot.corners}`:''}`);
  lines.push('Live price unavailable · Match update');
  return lines.join('\n');
}

export function openLiveMarkets(probabilities, homeGoals, awayGoals) {
  return Object.fromEntries(Object.entries(probabilities).filter(([key,p])=>{
    if(!Number.isFinite(p) || p<=0 || p>=1)return false;
    const total=key.match(/^(?:over|under)([0-4])5$/);
    if(total && homeGoals+awayGoals>Number(total[1])+.5)return false;
    if(key==='btts' && homeGoals>0 && awayGoals>0)return false;
    return true;
  }));
}
