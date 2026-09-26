import { createHash } from 'node:crypto';
import { buildDailyDesk, dayUK, formatDailyDesk } from '../../../shared/dailyDesk.js';
import { liveSnapshot, liveChange, formatLiveDesk } from '../../../shared/liveDesk.js';
import { settleMarketPrediction } from '../../../shared/predictionLedger.js';
import { finalScoreFromProviderFixture } from '../../../shared/forecastMath.js';

export function createDeskStore(getDb) {
  const clean=x=>JSON.parse(JSON.stringify(x));
  return {
    async load(day) { const db=getDb(); if(!db)return null;const d=await db.collection('dailyDesk').doc(day).get();return d.exists?d.data():null; },
    async lock(day,now) {
      const db=getDb();if(!db)return false;
      return db.runTransaction(async tx=>{
        const ref=db.collection('dailyDesk').doc(day),s=await tx.get(ref),d=s.exists?s.data():{};
        if(d.leaseUntil>now)return false;
        tx.set(ref,{leaseUntil:now+240000},{merge:true});return true;
      });
    },
    async save(day,state) { await getDb().collection('dailyDesk').doc(day).set(clean(state),{merge:true}); },
    async createEvent(key,event) {
      try {await getDb().collection('deskEvents').doc(key).create(clean(event));return true;}
      catch(e){if(e.code===6||e.code==='already-exists')return false;throw e;}
    },
    async updateEvent(key,patch) {await getDb().collection('deskEvents').doc(key).update(clean(patch));},
    async pending() {const s=await getDb().collection('deskEvents').where('result','==','pending').limit(60).get();return s.docs.map(d=>({key:d.id,...d.data()}));},
  };
}
const hash=s=>createHash('sha256').update(s).digest('hex');
export function createDailyDeskService({store,getMatches,getCalibration,predictCorners=()=>null,
  loadPrices=async()=>{},readLive,readStats,refreshForecast,readFinal,send,canCall=()=>true,
  now=Date.now,limit=6,requestLimit=400,messageLimit=12,log=console}={}) {
  let state=null,inFlight=null;
  async function record(key,event,text) {
    if(state.messages>=messageLimit)return false;
    // Persist the forecast before delivery. An ambiguous send is not resent automatically.
    if(!await store.createEvent(key,{...event,message:text,delivery:'reserved',createdAt:new Date(now()).toISOString(),result:event.result||'pending'}))return false;
    state.messages++;
    await store.save(state.dateUK,state);
    let result;
    try {result=await send(text);}catch{result={success:false,error:'Notification request failed'};}
    await store.updateEvent(key,{delivery:result.success?'sent':'failed',deliveryAt:new Date(now()).toISOString(),
      deliveryError:result.success?null:(result.reason||'DELIVERY_FAILED')});
    if(event.fixtureId){
      state.recentUpdates=[{key,fixtureId:event.fixtureId,type:event.type,message:text,at:new Date(now()).toISOString(),delivery:result.success?'sent':'failed'},...(state.recentUpdates||[])].slice(0,18);
    }
    return result.success;
  }
  async function call(fn,...args){
    if(state.requests>=requestLimit||!canCall())return null;
    state.requests++;await store.save(state.dateUK,state);return fn(...args);
  }
  async function settle(){
    const pending=await store.pending();let checked=0;const finals=new Map();
    for(const event of pending){
      if(now()-Date.parse(event.kickoffUTC)<3*3600000)continue;
      if(now()-Date.parse(event.kickoffUTC)>7*86400000){await store.updateEvent(event.key,{result:'unsettled',settledAt:new Date(now()).toISOString()});continue;}
      if(!event.fixtureId || !Number.isFinite(Date.parse(event.kickoffUTC)))continue;
      const id=String(event.fixtureId);
      if(!finals.has(id)){
        if(checked>=2)continue;
        const last=state.settlementChecks?.[id]||0;if(now()-last<30*60000)continue;
        checked++;(state.settlementChecks||={})[id]=now();
        finals.set(id,await call(readFinal,event.fixtureId));
      }
      const fixture=finals.get(id);if(!fixture)continue;
      const final=finalScoreFromProviderFixture(fixture);
      const status=fixture.fixture?.status?.short;
      if(['CANC','ABD','AWD','WO'].includes(status)){
        await store.updateEvent(event.key,{result:'void',finalStatus:status,settledAt:new Date(now()).toISOString()});continue;
      }
      if(!final)continue;
      const outcomes={};for(const k of Object.keys(event.probabilities||{})){
        const result=settleMarketPrediction(k,final.home,final.away);if(result)outcomes[k]=result;
      }
      await store.updateEvent(event.key,{result:'settled',outcomes,finalScore:`${final.home}-${final.away}`,settledAt:new Date(now()).toISOString()});
    }
  }
  async function tick(){
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      const day=dayUK(now());
      if(!await store.lock(day,now()))return {skipped:true};
      state=await store.load(day)||{};
      Object.assign(state,{dateUK:day,messages:state.messages||0,requests:state.requests||0,history:state.history||{},lastAlerts:state.lastAlerts||{},settlementChecks:state.settlementChecks||{}});
      try{
        if(!state.carryLoaded){
          const yesterday=await store.load(dayUK(now()-86400000));
          state.carry=(yesterday?.desk?.cards||[]).filter(c=>Date.parse(c.kickoffUTC)+3*3600000>now());
          for(const card of state.carry){
            const id=String(card.id);
            state.history[id]=yesterday.history?.[id]||[];
            if(yesterday.lastAlerts?.[id])state.lastAlerts[id]=yesterday.lastAlerts[id];
          }
          state.recentUpdates=state.recentUpdates||yesterday?.recentUpdates||[];
          state.carryLoaded=true;
        }
        const prepared=getMatches();
        if(!state.desk && prepared.ready){
          const candidates=prepared.matches.filter(m=>m.status==='NS' && Date.parse(m.kickoffUTC)>now())
            .sort((a,b)=>(b.analysis?.dailySignal?.score||0)-(a.analysis?.dailySignal?.score||0)).slice(0,limit*2);
          if(canCall())await loadPrices(candidates);
          const desk=buildDailyDesk(candidates,getCalibration(),{now:now(),limit,predictCorners});
          if(desk.cards.length){
            // Keep stored historical inputs for live recomputation, independent of the browser.
            state.desk=desk;await store.save(day,state);
          }
        }
        if(state.desk && !state.dailyAttempted){
          for(const card of state.desk.cards){
            await store.createEvent(hash(`${day}|prematch|${card.id}`),{type:'DAILY_PICK',fixtureId:card.id,kickoffUTC:card.kickoffUTC,
              createdAt:new Date(now()).toISOString(),result:'pending',card,
              probabilities:Object.fromEntries(card.markets.map(m=>[m.marketKey,m.probability/100]))});
          }
          await record(hash(`${day}|digest`),{type:'DAILY_DIGEST',result:'not_applicable'},formatDailyDesk(state.desk));
          state.dailyAttempted=true;
        }
        const tracked=[...new Map([...(state.desk?.cards||[]),...(state.carry||[])].map(c=>[String(c.id),c])).values()].filter(c=>now()>=Date.parse(c.kickoffUTC)&&now()<Date.parse(c.kickoffUTC)+3*3600000);
        if(tracked.length && canCall()){
          const live=await call(readLive);
          for(const card of tracked){
            const match=(live||[]).find(m=>String(m.id)===String(card.id));if(!match)continue;
            const stats=await call(readStats,match); // null stays unavailable, never zero
            const enriched={...match,...(stats?{xg:stats.xg,shots:stats.shots,cards:stats.cards}:{}),liveStatsObservedAt:stats?new Date(now()).toISOString():null};
            const refreshed=refreshForecast(enriched,{id:card.id,analysis:{predictionCore:{inputSummary:card.history}}});
            const snapshot=liveSnapshot({...enriched,...refreshed},stats,now());if(!snapshot)continue;
            const history=state.history[String(card.id)]||[];
            const event=liveChange(snapshot,history);
            const last=state.lastAlerts[String(card.id)]||{at:0,count:0};
            if(event && now()-last.at>=10*60000 && last.count<3 && snapshot.minute>=12){
              const key=hash(`${day}|${card.id}|${event.type}|${snapshot.homeGoals}-${snapshot.awayGoals}|${Math.floor(snapshot.minute/10)}`);
              await record(key,{type:event.type,fixtureId:card.id,kickoffUTC:card.kickoffUTC,snapshot,
                probabilities:snapshot.probabilities},formatLiveDesk(card,snapshot,event));
              state.lastAlerts[String(card.id)]={at:now(),count:last.count+1};
            }
            state.history[String(card.id)]=[...history,snapshot].slice(-4);
          }
        }
        await settle();
        state.lastCompletedAt=new Date(now()).toISOString();
        return {ok:true};
      }catch(e){log.warn?.('[DailyDesk] Tick incomplete:',e.message);return {ok:false};}
      finally{await store.save(day,{...state,leaseUntil:0});}
    })().finally(()=>{inFlight=null;});return inFlight;
  }
  async function view(){
    const day=dayUK(now());if(!state || state.dateUK!==day)state=await store.load(day);
    return {desk:state?.desk?{...state.desk,cards:state.desk.cards.map(({history,...c})=>c)}:null,
      recentUpdates:state?.recentUpdates||[],lastCompletedAt:state?.lastCompletedAt||null,requests:state?.requests||0,requestLimit,messages:state?.messages||0,messageLimit};
  }
  return {tick,view};
}
