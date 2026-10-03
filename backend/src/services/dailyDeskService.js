import { discoverOpportunities } from '../../../shared/opportunityDiscovery.js';
import { createHash } from 'node:crypto';
import { buildDailyDesk, deskCard, dayUK, formatDailyDesk } from '../../../shared/dailyDesk.js';
import { liveSnapshot, liveChange, formatLiveDesk } from '../../../shared/liveDesk.js';
import { settleMarketPrediction } from '../../../shared/predictionLedger.js';
import { finalScoreFromProviderFixture } from '../../../shared/forecastMath.js';
import { buildLiveStudySnapshot, settleLiveStudySnapshot, summarizeSettledLiveStudy } from '../../../shared/liveStudy.js';
import { buildTopLeaguePicks, buildPortfolioTiers, buildFirstHalfGoalWatch, buildCornersWatch } from '../../../shared/morningSelections.js';

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
    async cornerOutcome(id,key){const db=getDb();if(!db)return null;const d=await db.collection('cornersPredictions').doc('corners_'+id).get();const x=d.exists?d.data():null;return x?.result==='settled'?(x.results?.[key]||null):x?.result==='unsettled'?'unsettled':null;},
    async pendingPlayed() {const db=getDb();if(!db)return [];const s=await db.collection('playedOpportunities').where('result','==','pending').limit(40).get();return s.docs.map(d=>({key:d.id,...d.data()}));},
    async updatePlayed(key,patch) {await getDb().collection('playedOpportunities').doc(key).update(clean(patch));},
    async pending() {const s=await getDb().collection('deskEvents').where('result','==','pending').limit(60).get();return s.docs.map(d=>({key:d.id,...d.data()}));},
    async saveLiveStudySnapshot(row) {
      const db=getDb();if(!db||!row?.fixtureId||!Number.isFinite(Number(row.bucket)))return false;
      const root=db.collection('liveHazardStudies').doc(String(row.fixtureId));
      const snap=root.collection('snapshots').doc(String(row.bucket).padStart(2,'0'));
      await root.set(clean({
        fixtureId:String(row.fixtureId),home:row.home||'',away:row.away||'',league:row.league||'',leagueId:row.leagueId??null,
        kickoffUTC:row.kickoffUTC||null,hazardVersion:row.hazardVersion||null,settlementStatus:'PENDING',
        lastSnapshotAt:row.observedAt,lastMinute:row.minute,
      }),{merge:true});
      await snap.set(clean(row),{merge:true});
      return true;
    },
    async settleLiveStudyFixture(fixtureId,finalScore,settledAt) {
      const db=getDb();if(!db||!fixtureId)return null;
      const root=db.collection('liveHazardStudies').doc(String(fixtureId));
      const existing=await root.get();
      if(!existing.exists || existing.data()?.settlementStatus==='SETTLED')return existing.exists?existing.data():null;
      const snaps=await root.collection('snapshots').get();
      const settled=[];
      const batch=db.batch();
      for(const doc of snaps.docs){
        const row=settleLiveStudySnapshot(doc.data(),finalScore);
        if(!row)continue;
        settled.push(row);batch.set(doc.ref,clean(row),{merge:true});
      }
      const metrics=summarizeSettledLiveStudy(settled);
      batch.set(root,clean({settlementStatus:'SETTLED',finalScore,settledAt,metrics,snapshotCount:settled.length}),{merge:true});
      await batch.commit();
      return {metrics,snapshotCount:settled.length};
    },
    async pendingLiveStudies(limit=40) {
      const db=getDb();if(!db)return [];
      const s=await db.collection('liveHazardStudies').where('settlementStatus','==','PENDING').limit(limit).get();
      return s.docs.map(d=>({id:d.id,...d.data()}));
    },
    async voidLiveStudyFixture(fixtureId,status='VOID') {
      const db=getDb();if(!db||!fixtureId)return;
      await db.collection('liveHazardStudies').doc(String(fixtureId)).set({settlementStatus:'VOID',finalStatus:status,settledAt:new Date().toISOString()},{merge:true});
    },
    async listSettledLiveStudies(limit=500) {
      const db=getDb();if(!db)return [];
      const s=await db.collection('liveHazardStudies').where('settlementStatus','==','SETTLED').limit(limit).get();
      return s.docs.map(d=>({id:d.id,...d.data()}));
    },
  };
}
const hash=s=>createHash('sha256').update(s).digest('hex');
export function createDailyDeskService({store,getMatches,getCalibration,predictCorners=()=>null,
  loadPrices=async()=>{},readFirstHalfProfile=async()=>null,readLive,readStats,refreshForecast,readFinal,send,canCall=()=>true,
  now=Date.now,limit=6,studyLimit=10,firstHalfLimit=6,requestLimit=400,messageLimit=12,log=console}={}) {
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
      if(event.type==='OPPORTUNITY_SUGGESTION'||event.type==='PORTFOLIO_TIER'){
        const legs=event.opportunity?.legs||event.ticket?.legs||[];
        const outcomes={...(event.outcomes||{})};
        for(const leg of legs){
          const id=String(leg.fixtureId);
          if(outcomes[id] || now()-Date.parse(leg.kickoffUTC)<3*3600000)continue;
          if(now()-Date.parse(leg.kickoffUTC)>7*86400000){outcomes[id]='unsettled';continue;}
          if(leg.marketKey?.startsWith('corners_')){const result=await store.cornerOutcome?.(id,leg.marketKey);if(result)outcomes[id]=result;continue;}
          if(!finals.has(id)){
            if(checked>=2)continue;
            const last=state.settlementChecks?.[id]||0;if(now()-last<30*60000)continue;
            checked++;(state.settlementChecks||={})[id]=now();
            finals.set(id,await call(readFinal,leg.fixtureId));
          }
          const fixture=finals.get(id);if(!fixture)continue;
          if(['CANC','ABD','AWD','WO'].includes(fixture.fixture?.status?.short)){outcomes[id]='void';continue;}
          const score=finalScoreFromProviderFixture(fixture);if(!score)continue;
          outcomes[id]=settleMarketPrediction(leg.marketKey,score.home,score.away)||'unsettled';
        }
        const results=legs.map(l=>outcomes[String(l.fixtureId)]);
        const complete=results.every(Boolean);
        const result=complete?(results.includes('lost')?'lost':results.includes('unsettled')?'unsettled':results.every(v=>v==='void')?'void':'won'):'pending';
        await store.updateEvent(event.key,{outcomes,result,...(complete?{settledAt:new Date(now()).toISOString()}: {})});
        continue;
      }
      if(event.type==='FIRST_HALF_WATCH'){
        if(now()-Date.parse(event.kickoffUTC)<3*3600000)continue;
        if(now()-Date.parse(event.kickoffUTC)>7*86400000){await store.updateEvent(event.key,{result:'unsettled',settledAt:new Date(now()).toISOString()});continue;}
        if(!event.fixtureId)continue;
        const id=String(event.fixtureId);
        if(!finals.has(id)){
          if(checked>=2)continue;
          const last=state.settlementChecks?.[id]||0;if(now()-last<30*60000)continue;
          checked++;(state.settlementChecks||={})[id]=now();finals.set(id,await call(readFinal,event.fixtureId));
        }
        const fixture=finals.get(id);if(!fixture)continue;
        const status=fixture.fixture?.status?.short;
        if(['CANC','ABD','AWD','WO'].includes(status)){await store.updateEvent(event.key,{result:'void',finalStatus:status,settledAt:new Date(now()).toISOString()});continue;}
        const hh=Number(fixture.score?.halftime?.home),ha=Number(fixture.score?.halftime?.away);
        if(!Number.isFinite(hh)||!Number.isFinite(ha))continue;
        await store.updateEvent(event.key,{result:hh+ha>=1?'won':'lost',halfTimeScore:`${hh}-${ha}`,settledAt:new Date(now()).toISOString()});
        continue;
      }
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
  async function settlePlayed(){
    if(!store.pendingPlayed || !store.updatePlayed)return;
    const pending=await store.pendingPlayed();let checked=0;const finals=new Map();
    for(const bet of pending){
      const legs=bet.legs||[],next=[];
      for(const leg of legs){
        if(leg.result && leg.result!=='pending'){next.push(leg);continue;}
        if(now()-Date.parse(leg.kickoffUTC)<3*3600000){next.push(leg);continue;}
        const id=String(leg.matchId);
        if(leg.marketKey?.startsWith('corners_')){const result=await store.cornerOutcome?.(id,leg.marketKey);next.push(result?{...leg,result}:leg);continue;}
        if(!finals.has(id)){
          if(checked>=2){next.push(leg);continue;}
          const last=state.settlementChecks?.[id]||0;if(now()-last<30*60000){next.push(leg);continue;}
          checked++;(state.settlementChecks||={})[id]=now();finals.set(id,await call(readFinal,leg.matchId));
        }
        const fixture=finals.get(id);
        if(!fixture){next.push(leg);continue;}
        if(['CANC','ABD','AWD','WO'].includes(fixture.fixture?.status?.short)){next.push({...leg,result:'void'});continue;}
        const score=finalScoreFromProviderFixture(fixture);
        next.push(score?{...leg,result:settleMarketPrediction(leg.marketKey,score.home,score.away)||'pending',finalScore:`${score.home}-${score.away}`}:leg);
      }
      const results=next.map(l=>l.result||'pending');
      const complete=results.length===legs.length&&results.every(v=>v!=='pending');
      const result=complete?(results.includes('lost')?'lost':results.every(v=>v==='void')?'void':results.includes('unsettled')?'review':'won'):'pending';
      const profit=result==='won'?Number(bet.stake)*(Number(bet.odds)-1):result==='lost'?-Number(bet.stake):result==='void'?0:null;
      await store.updatePlayed(bet.key,{legs:next,result,profit,...(complete?{settledAt:new Date(now()).toISOString()}: {})});
    }
  }
  async function settleLiveStudies(){
    if(!store.pendingLiveStudies || !store.settleLiveStudyFixture)return;
    const pending=await store.pendingLiveStudies();let checked=0;
    for(const study of pending){
      const kickoff=Date.parse(study.kickoffUTC||'');
      if(!Number.isFinite(kickoff))continue;
      if(now()-kickoff<3*3600000)continue;
      if(now()-kickoff>7*86400000){await store.voidLiveStudyFixture?.(study.fixtureId,'STALE_UNSETTLED');continue;}
      const id=String(study.fixtureId||study.id);
      if(checked>=2)break;
      const last=state.studySettlementChecks?.[id]||0;if(now()-last<30*60000)continue;
      checked++;(state.studySettlementChecks||={})[id]=now();
      const fixture=await call(readFinal,id);if(!fixture)continue;
      const status=fixture.fixture?.status?.short;
      if(['CANC','ABD','AWD','WO'].includes(status)){await store.voidLiveStudyFixture?.(id,status);continue;}
      const final=finalScoreFromProviderFixture(fixture);if(!final)continue;
      await store.settleLiveStudyFixture(id,{home:final.home,away:final.away},new Date(now()).toISOString());
    }
  }

  async function tick(){
    if(inFlight)return inFlight;
    inFlight=(async()=>{
      const day=dayUK(now());
      if(!await store.lock(day,now()))return {skipped:true};
      state=await store.load(day)||{};
      Object.assign(state,{dateUK:day,messages:state.messages||0,requests:state.requests||0,history:state.history||{},lastAlerts:state.lastAlerts||{},settlementChecks:state.settlementChecks||{},studySettlementChecks:state.studySettlementChecks||{}});
      try{
        if(!state.carryLoaded){
          const yesterday=await store.load(dayUK(now()-86400000));
          state.carry=[...new Map([...(yesterday?.desk?.cards||[]),...(yesterday?.studyCards||[])].map(c=>[String(c.id),c])).values()]
            .filter(c=>Date.parse(c.kickoffUTC)+3*3600000>now());
          for(const card of state.carry){
            const id=String(card.id);
            state.history[id]=yesterday.history?.[id]||[];
            if(yesterday.lastAlerts?.[id])state.lastAlerts[id]=yesterday.lastAlerts[id];
          }
          state.recentUpdates=state.recentUpdates||yesterday?.recentUpdates||[];
          state.carryLoaded=true;
        }
        const prepared=getMatches();
        if(prepared.ready && !Array.isArray(state.studyCards)){
          state.studyCards=prepared.matches
            .filter(m=>m.status==='NS' && Date.parse(m.kickoffUTC)>now() && dayUK(Date.parse(m.kickoffUTC))===day)
            .sort((a,b)=>(b.analysis?.dailySignal?.score||0)-(a.analysis?.dailySignal?.score||0))
            .slice(0,Math.max(limit,studyLimit))
            .map(m=>({id:m.id,home:m.home,away:m.away,league:m.league||'',leagueId:m.leagueId||null,country:m.leagueCountry||'',
              kickoffUTC:m.kickoffUTC,history:m.analysis?.predictionCore?.inputSummary||null}));
          await store.save(day,{studyCards:state.studyCards});
        }
        if(!state.desk && prepared.ready){
          const candidates=prepared.matches.filter(m=>m.status==='NS' && Date.parse(m.kickoffUTC)>now())
            .sort((a,b)=>(b.analysis?.dailySignal?.score||0)-(a.analysis?.dailySignal?.score||0)).slice(0,limit*2);
          if(canCall())await loadPrices(candidates);
          const desk=buildDailyDesk(candidates,getCalibration(),{now:now(),limit,predictCorners});
          // Wider extraction layer: same engine outputs, no changes to V10.6C.
          const todays=prepared.matches.filter(m=>m.status==='NS' && Date.parse(m.kickoffUTC)>now() && dayUK(Date.parse(m.kickoffUTC))===day);
          const discoveryCards=todays.map(m=>deskCard(m,getCalibration(),predictCorners(m))).filter(Boolean);
          desk.opportunities=discoverOpportunities(discoveryCards,{now:now()});
          desk.topLeagues=buildTopLeaguePicks(discoveryCards);
          desk.portfolio=buildPortfolioTiers(discoveryCards,{now:now()});
          desk.cornersWatch=buildCornersWatch(discoveryCards);
          const goalCandidates=todays.filter(m=>m.homeTeamId&&m.awayTeamId&&m.season!=null)
            .filter(m=>Number(m.analysis?.predictionCore?.poisson?.marketProbabilities?.over15)>=.68)
            .sort((a,b)=>(b.analysis?.predictionCore?.poisson?.marketProbabilities?.over15||0)-(a.analysis?.predictionCore?.poisson?.marketProbabilities?.over15||0))
            .slice(0,firstHalfLimit);
          const firstHalf=[];
          for(const m of goalCandidates){
            const profile=await call(readFirstHalfProfile,m);if(!profile)continue;
            const watch=buildFirstHalfGoalWatch(m,profile.home,profile.away);if(watch)firstHalf.push(watch);
          }
          desk.firstHalfWatch=firstHalf.sort((a,b)=>b.probability-a.probability).slice(0,4);
          if(desk.cards.length || desk.opportunities.length || desk.topLeagues.length){
            // Keep stored historical inputs for live recomputation, independent of the browser.
            state.desk=desk;await store.save(day,state);
          }
        }
        // Existing saved desks from before the feature shipped must gain discoveries without
        // another preparation run or another paid API request.
        if(state.desk && prepared.ready && (!Array.isArray(state.desk.opportunities)||!Array.isArray(state.desk.topLeagues)||!state.desk.portfolio||!Array.isArray(state.desk.cornersWatch)||!Array.isArray(state.desk.firstHalfWatch))){
          const todays=prepared.matches.filter(m=>m.status==='NS' && Date.parse(m.kickoffUTC)>now() && dayUK(Date.parse(m.kickoffUTC))===day);
          const discoveryCards=todays.map(m=>deskCard(m,getCalibration(),predictCorners(m))).filter(Boolean);
          state.desk.opportunities=discoverOpportunities(discoveryCards,{now:now()});
          state.desk.topLeagues=buildTopLeaguePicks(discoveryCards);
          state.desk.portfolio=buildPortfolioTiers(discoveryCards,{now:now()});
          state.desk.cornersWatch=buildCornersWatch(discoveryCards);
          if(!Array.isArray(state.desk.firstHalfWatch)){
            const goalCandidates=todays.filter(m=>m.homeTeamId&&m.awayTeamId&&m.season!=null)
              .filter(m=>Number(m.analysis?.predictionCore?.poisson?.marketProbabilities?.over15)>=.68)
              .sort((a,b)=>(b.analysis?.predictionCore?.poisson?.marketProbabilities?.over15||0)-(a.analysis?.predictionCore?.poisson?.marketProbabilities?.over15||0))
              .slice(0,firstHalfLimit);
            const firstHalf=[];
            for(const m of goalCandidates){const profile=await call(readFirstHalfProfile,m);if(!profile)continue;const watch=buildFirstHalfGoalWatch(m,profile.home,profile.away);if(watch)firstHalf.push(watch);}
            state.desk.firstHalfWatch=firstHalf.sort((a,b)=>b.probability-a.probability).slice(0,4);
          }
          await store.save(day,state);
        }
        if(state.desk && !state.dailyAttempted){
          for(const card of state.desk.cards){
            await store.createEvent(hash(`${day}|prematch|${card.id}`),{type:'DAILY_PICK',fixtureId:card.id,kickoffUTC:card.kickoffUTC,
              createdAt:new Date(now()).toISOString(),result:'pending',card,
              probabilities:Object.fromEntries(card.markets.map(m=>[m.marketKey,m.probability/100]))});
          }
          for(const opportunity of state.desk.opportunities||[]){
            await store.createEvent(hash(`${day}|opportunity|${opportunity.id}`),{type:'OPPORTUNITY_SUGGESTION',result:'pending',kickoffUTC:opportunity.legs[0]?.kickoffUTC,createdAt:new Date(now()).toISOString(),opportunity});
          }
          for(const [tier,ticket] of Object.entries(state.desk.portfolio||{})){
            if(!ticket?.available)continue;
            await store.createEvent(hash(`${day}|portfolio|${tier}`),{type:'PORTFOLIO_TIER',tier,result:'pending',kickoffUTC:ticket.legs[0]?.kickoffUTC,createdAt:new Date(now()).toISOString(),ticket});
          }
          for(const watch of state.desk.firstHalfWatch||[]){
            await store.createEvent(hash(`${day}|1h|${watch.fixtureId}`),{type:'FIRST_HALF_WATCH',fixtureId:watch.fixtureId,kickoffUTC:watch.kickoffUTC,
              probability:watch.probability,basis:watch.basis,result:'pending',createdAt:new Date(now()).toISOString()});
          }
          await record(hash(`${day}|digest`),{type:'DAILY_DIGEST',result:'not_applicable'},formatDailyDesk(state.desk));
          state.dailyAttempted=true;
        }
        const tracked=[...new Map([...(state.desk?.cards||[]),...(state.studyCards||[]),...(state.carry||[])].map(c=>[String(c.id),c])).values()]
          .filter(c=>now()>=Date.parse(c.kickoffUTC)&&now()<Date.parse(c.kickoffUTC)+3*3600000);
        if(tracked.length && canCall()){
          const live=await call(readLive);
          for(const card of tracked){
            const match=(live||[]).find(m=>String(m.id)===String(card.id));if(!match)continue;
            const stats=await call(readStats,match); // null stays unavailable, never zero
            const enriched={...match,...(stats?{
              xg:stats.xg,shots:stats.shots,totalShots:stats.totalShots,corners:stats.corners,
              possession:stats.possession,cards:stats.cards
            }:{}),liveStatsObservedAt:stats?new Date(now()).toISOString():null};
            const refreshed=refreshForecast(enriched,{id:card.id,analysis:{predictionCore:{inputSummary:card.history}}});
            const studySnapshot=buildLiveStudySnapshot({...enriched,...refreshed},stats,card,now());
            if(studySnapshot)await store.saveLiveStudySnapshot?.(studySnapshot);
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
        await settlePlayed();
        await settleLiveStudies();
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
