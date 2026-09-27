// Explicitly selected fixtures only. Existing Daily Desk and goal alerts remain untouched.
export const watchId = id => 'fixture_'+String(id);
export const watchMessage = (item,stage) => {
 const name = item.home+' vs '+item.away;
 const heading = stage==='kickoff'?'🟢 WATCH THIS · KICKOFF':'⏱ WATCH THIS · MARKET CHECK';
 return [heading,'━━━━━━━━━━━━━━━━━━━━','⚽ '+name,'🏆 '+(item.country?item.country+' · ':'')+(item.league||'League unavailable'),'🎯 Wanted: '+item.market,stage==='kickoff'?'Your selected match is starting. Check SportyBet for your preferred market.':'15 minutes after scheduled kickoff. Check SportyBet again if the preferred market was missing.','Market availability and live odds have NOT been verified.'].join('\\n');
};
export function dueWatchStages(item,now){
 const kickoff=Date.parse(item.kickoffUTC);
 if(!Number.isFinite(kickoff)||now<kickoff||now>kickoff+90*60000)return [];
 return [!item.kickoffAlertAt&&now<=kickoff+30*60000?'kickoff':null,!item.marketReminderAt&&now>=kickoff+15*60000?'reminder':null].filter(Boolean);
}
export function createWatchService({getDb,send,now=Date.now,log=console}){
 async function tick(){
  const db=getDb();if(!db)return;
  const snapshot=await db.collection('watchedFixtures').where('active','==',true).limit(80).get();
  for(const doc of snapshot.docs){
   const item=doc.data();
   for(const stage of dueWatchStages(item,now())){
    const field=stage==='kickoff'?'kickoffAlertAt':'marketReminderAt';
    const claimed=await db.runTransaction(async tx=>{
     const fresh=await tx.get(doc.ref);if(!fresh.exists||!fresh.data().active||fresh.data()[field])return false;
     tx.update(doc.ref,{[field]:new Date(now()).toISOString()});return true;
    });
    if(!claimed)continue;
    try{const result=await send(watchMessage(item,stage));if(!result?.success)log.warn?.('[Watch] Alert not delivered:',result?.reason||result?.error||'unknown');}
    catch(e){log.warn?.('[Watch] Alert failed:',e.message);}
   }
  }
 }
 return {tick};
}
