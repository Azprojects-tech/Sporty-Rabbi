// Explicitly selected fixtures only. Existing Daily Desk and automatic goal alerts remain untouched.
export const watchId = id => 'fixture_'+String(id);

const MARKET_KEYS = {
  'Over 1.5 goals':'over15',
  'Over 2.5 goals':'over25',
  'Over 3.5 goals':'over35',
  'Home win':'home_win',
  'Away win':'away_win',
  'Both teams score':'btts',
};

export const watchMarketKey = market => MARKET_KEYS[String(market||'')] || null;

function watchedProbability(item, live) {
  const key=item.marketKey||watchMarketKey(item.market);
  const p=key ? Number(live?.probabilities?.[key]) : NaN;
  return Number.isFinite(p) ? p : null;
}

function goalsNeeded(key,homeGoals,awayGoals) {
  const m=String(key||'').match(/^over([1-4])5$/);
  if(!m)return null;
  const threshold=Number(m[1])+0.5;
  return Math.max(0,Math.floor(threshold)+1-(Number(homeGoals)||0)-(Number(awayGoals)||0));
}

function pct(p){return Number.isFinite(Number(p))?((Number(p)<=1?Number(p)*100:Number(p)).toFixed(1)+'%'):'Unavailable';}

export const watchMessage = (item,stage,live=null) => {
 const name = item.home+' vs '+item.away;
 const labels={kickoff:'🟢 WATCH THIS · KICKOFF',minute5:'⏱ WATCH THIS · 5′ MARKET CHECK',minute10:'⏱ WATCH THIS · 10′ MARKET CHECK'};
 const lines=[labels[stage]||'⏱ WATCH THIS · MARKET CHECK','━━━━━━━━━━━━━━━━━━━━','⚽ '+name,'🏆 '+(item.country?item.country+' · ':'')+(item.league||'League unavailable'),'🎯 Wanted: '+item.market];
 if(Number.isFinite(Number(item.modelProbability)))lines.push('Pre-match model: '+pct(item.modelProbability));
 if(stage==='kickoff'){
   lines.push('The match is starting. No bet has been recorded.','Wait for the live market if SportyBet is still offering a higher line.');
 } else if(live){
   lines.push(`${live.minute}' · ${live.homeGoals}-${live.awayGoals}`);
   const p=watchedProbability(item,live);
   if(p!=null)lines.push('Current live estimate: '+pct(p));
   const need=goalsNeeded(item.marketKey||watchMarketKey(item.market),live.homeGoals,live.awayGoals);
   if(need!=null)lines.push(`${item.market} needs ${need} more goal${need===1?'':'s'} from here.`);
   lines.push('Check SportyBet now for this exact line and current price.');
 } else {
   lines.push(stage==='minute5'?'About five minutes have elapsed.':'About ten minutes have elapsed.','Check SportyBet now for this exact line and current price.');
 }
 lines.push('SportyRabbi has not verified SportyBet market availability or live odds.');
 return lines.join('\n');
};

export function dueWatchStages(item,now,live=null){
 const kickoff=Date.parse(item.kickoffUTC);
 if(!Number.isFinite(kickoff)||now<kickoff||now>kickoff+40*60000)return [];
 if(!item.kickoffAlertAt)return ['kickoff'];
 const liveMinute=Number(live?.minute);
 if(!Number.isFinite(liveMinute))return [];
 if(!item.minute5AlertAt && liveMinute>=5)return ['minute5'];
 if(!item.minute10AlertAt && liveMinute>=10)return ['minute10'];
 return [];
}

export function createWatchService({getDb,send,readLive=null,buildLiveState=null,now=Date.now,log=console}){
 async function tick(){
  const db=getDb();if(!db)return;
  const snapshot=await db.collection('watchedFixtures').where('active','==',true).limit(80).get();
  const docs=snapshot.docs||[];
  const clock=now();
  let liveById=new Map();
  const needsLive=docs.some(doc=>{
    const item=doc.data(), kickoff=Date.parse(item.kickoffUTC);
    return item.kickoffAlertAt && (!item.minute5AlertAt||!item.minute10AlertAt)
      && Number.isFinite(kickoff)&&clock>=kickoff+3*60000&&clock<=kickoff+40*60000;
  });
  if(needsLive && readLive){
    try{
      const live=(await readLive())||[];
      liveById=new Map(live.map(m=>[String(m.id??m.fixtureId),m]));
    }catch(e){log.warn?.('[Watch] Live read failed:',e.message);}
  }
  for(const doc of docs){
   const item=doc.data();
   let live=liveById.get(String(item.fixtureId))||null;
   if(live && buildLiveState){
     try{live=await buildLiveState(item,live)||live;}catch(e){log.warn?.('[Watch] Live model failed:',e.message);}
   }
   for(const stage of dueWatchStages(item,clock,live)){
    const field=stage==='kickoff'?'kickoffAlertAt':stage==='minute5'?'minute5AlertAt':'minute10AlertAt';
    const claimed=await db.runTransaction(async tx=>{
     const fresh=await tx.get(doc.ref);if(!fresh.exists||!fresh.data().active||fresh.data()[field])return false;
     tx.update(doc.ref,{[field]:new Date(clock).toISOString(),...(stage==='minute10'?{active:false,completedAt:new Date(clock).toISOString()}: {})});return true;
    });
    if(!claimed)continue;
    try{const result=await send(watchMessage(item,stage,live));if(!result?.success)log.warn?.('[Watch] Alert not delivered:',result?.reason||result?.error||'unknown');}
    catch(e){log.warn?.('[Watch] Alert failed:',e.message);}
   }
  }
 }
 return {tick};
}
