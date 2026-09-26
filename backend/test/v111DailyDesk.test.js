import test from 'node:test';
import assert from 'node:assert/strict';
import {extractSettledPicks,withPriceChecks,buildCalibrationMap,coherentCorrection,minimumOddsWorthTaking} from '../../shared/pickCalibration.js';
import {validateCalibration} from '../../shared/calibrationValidation.js';
import {targetCombination,buildDailyDesk} from '../../shared/dailyDesk.js';
import {liveChange,liveSnapshot} from '../../shared/liveDesk.js';
import {createDailyDeskService} from '../src/services/dailyDeskService.js';
import {eligibleTicketCandidates} from '../src/services/ticketSelectionService.js';
const version='V10.6C-Unified-Decisions';
const stamp=Date.parse('2026-09-26T10:00:00Z');
const iso=t=>new Date(t).toISOString();
function match(id=1){
 const raw={home_win:.70,draw:.18,away_win:.12,over15:.9,under15:.1,over25:.7,under25:.3,btts:.65};
 return {id,home:'Home '+id,away:'Away '+id,homeTeamId:id*2,awayTeamId:id*2+1,status:'NS',leagueId:39,
  kickoffUTC:iso(stamp+3600000),oddsSnapshot:{status:'AVAILABLE',source:'API_FOOTBALL',fixtureId:id,kind:'PRE_MATCH',period:'REGULATION',bookmaker:{id:1,name:'Book'},providerUpdatedAt:iso(stamp),expiresAt:iso(stamp+3600000),odds:{over15:1.5,homeWin:1.6}},
  analysis:{analysisVersion:version,predictionCore:{coreReady:true,reliability:85,poisson:{marketProbabilities:raw},inputSummary:{season:2026}},
   recommendations:[{marketKey:'over15',selection:'Over 1.5',probability01:.9,modelProbability:90,evidenceGate:{passed:true}}]}};
}
function approvedMap(){const m=buildCalibrationMap(Array.from({length:600},(_,i)=>({marketKey:'over15',p:90,won:i<360?1:0,leagueId:39})));m.validation={status:'APPROVED',version,approvedMarkets:['over15']};return m;}

test('training rejects missing timestamps, in-play records and missing fixture IDs',()=>{
 const base={matchId:1,analysisVersion:version,predictedAt:iso(stamp),kickoffUTC:iso(stamp+3600000),markets:[{marketKey:'over15',modelProbability:90,result:'won'}]};
 assert.equal(extractSettledPicks([base]).length,1);
 for(const patch of [{predictedAt:null},{kickoffUTC:'bad'},{matchId:null},{snapshotType:'LIVE'},{predictedAt:iso(stamp+3600000)}])assert.equal(extractSettledPicks([{...base,...patch}]).length,0);
});

test('coherent correction preserves result sum, nested totals and complements',()=>{
 const m=match(),raw=m.analysis.predictionCore.poisson.marketProbabilities;
 const p=coherentCorrection(approvedMap(),raw,{leagueId:39});
 assert.ok(Math.abs(p.home_win+p.draw+p.away_win-1)<1e-10);
 assert.ok(p.over15>=p.over25);assert.equal(p.over25+p.under25,1);assert.ok(p.btts<=p.over15);
});

test('one effective probability reaches the displayed pick, EV and ticket eligibility',()=>{
 const m=match();
 // Use future quotes relative to runtime because the production overlay checks real freshness.
 m.kickoffUTC=iso(Date.now()+3600000);m.oddsSnapshot.providerUpdatedAt=iso(Date.now());m.oddsSnapshot.expiresAt=iso(Date.now()+3600000);
 const baseline=withPriceChecks(m.analysis,null,m);
 assert.equal(eligibleTicketCandidates([{...m,analysis:baseline}]).length,1);
 const a=withPriceChecks(m.analysis,approvedMap(),m);
 assert.ok(a.recommendations[0].modelProbability<70);
 assert.equal(a.recommendations[0].decisionState,'NO_BET');
 assert.equal(eligibleTicketCandidates([{...m,analysis:a}]).length,0);
 assert.equal(a.recommendations[0].modelProbability,a.recommendations[0].priceCheck.usedChance);
 assert.equal(withPriceChecks(a,approvedMap(),m).recommendations[0].modelProbability,a.recommendations[0].modelProbability);
 assert.equal(m.analysis.recommendations[0].modelProbability,90);
});

test('unvalidated, different-version and live corrections cannot be promoted; expired prices cannot qualify',()=>{
 const m=match();m.kickoffUTC=iso(Date.now()+3600000);m.oddsSnapshot.providerUpdatedAt=iso(Date.now());m.oddsSnapshot.expiresAt=iso(Date.now()+3600000);
 const map=approvedMap();map.validation.status='NO_IMPROVEMENT_PROVEN';
 assert.equal(withPriceChecks(m.analysis,map,m).recommendations[0].modelProbability,90);
 map.validation.status='APPROVED';map.validation.version='other';
 assert.equal(withPriceChecks(m.analysis,map,m).recommendations[0].modelProbability,90);
 map.validation.version=version;
 const live=withPriceChecks(m.analysis,map,{...m,status:'1H'}).recommendations[0];
 assert.equal(live.modelProbability,90);assert.equal(live.decisionState,'NEEDS_PRICE');
 m.oddsSnapshot.expiresAt=iso(Date.now()-1000);
 assert.equal(withPriceChecks(m.analysis,map,m).recommendations[0].decisionState,'NEEDS_PRICE');
});

test('chronological validation never trains on later outcomes or late-settled matches',()=>{
 const rows=[];
 for(let day=1;day<=10;day++)for(let i=0;i<100;i++)rows.push({fixtureId:`${day}-${i}`,version,marketKey:'over15',p:90,won:i<60?1:0,leagueId:39,
  predictedAt:`2026-09-${String(day).padStart(2,'0')}T06:00:00.000Z`,kickoffUTC:`2026-09-${String(day).padStart(2,'0')}T12:00:00.000Z`,
  settledAt:`2026-09-${String(day).padStart(2,'0')}T15:00:00.000Z`,rawProbabilities:{over15:.9,under15:.1}});
 const a=validateCalibration(rows,{version,now:iso(stamp)});
 const b=validateCalibration(rows.map(p=>p.predictedAt>=a.validation.testStart?{...p,won:1-p.won}:p),{version,now:iso(stamp)});
 assert.deepEqual(a.markets,b.markets);assert.equal(a.totalPicks,600);
 const late=validateCalibration(rows.map(p=>p.fixtureId==='1-0'?{...p,settledAt:iso(stamp)}:p),{version,now:iso(stamp)});
 assert.equal(late.totalPicks,599);
 assert.equal(validateCalibration(rows.map(p=>({...p,version:'old'})),{version,now:iso(stamp)}).validation.status,'INSUFFICIENT_HISTORY');
});

test('minimum odds round upwards to preserve the required margin',()=>{
 for(let p=1;p<100;p+=.7)assert.ok(minimumOddsWorthTaking(p)*p/100>=1.05-1e-10);
});

test('target combinations enforce price, bookmaker, team uniqueness and 51.2% floor',()=>{
 const cards=[1,2,3].map(i=>({id:i,status:'NS',homeTeamId:i*2,awayTeamId:i*2+1,kickoffUTC:iso(stamp+3600000),quoteExpiresAt:iso(stamp+60000),bookmaker:{id:1},best:{decision:'BET',probability:85,odds:1.5}}));
 assert.equal(targetCombination(cards,2,stamp).available,true);
 assert.equal(targetCombination(cards,3,stamp).available,true);
 assert.equal(targetCombination(cards.map(c=>({...c,best:{...c.best,probability:65}})),3,stamp).available,false);
 assert.equal(targetCombination(cards.map(c=>({...c,homeTeamId:2})),2,stamp).available,false);
 assert.equal(targetCombination(cards.map((c,i)=>({...c,bookmaker:{id:i}})),2,stamp).available,false);
 assert.equal(targetCombination(cards,2,stamp+3600001).available,false);
});

test('live deltas require a comparable fresh observation; missing stats are never zero',()=>{
 const base={fixtureId:1,status:'1H',minute:20,at:iso(stamp),homeGoals:0,awayGoals:0,shots:3,xg:.2,corners:1,redCards:0};
 const current={...base,minute:25,at:iso(stamp+300000),shots:8,xg:.9,corners:4};
 assert.equal(liveChange(current,[base]).type,'ATTACKING_ACTIVITY');
 assert.equal(liveChange({...current,xg:null,corners:null},[base]),null);
 assert.equal(liveChange({...current,at:iso(stamp+30*60000)},[base]),null);
 assert.equal(liveChange({...current,shots:1,xg:.1,corners:0},[base]),null);
 assert.equal(liveSnapshot({id:1,status:'1H',score:'0-0',matchMinutes:25},null,stamp).xg,null);
});

function memoryStore(){
 const days=new Map(),events=new Map();
 return {days,events,load:async d=>structuredClone(days.get(d)||null),lock:async()=>true,
  save:async(d,s)=>{days.set(d,structuredClone({...days.get(d),...s}));},
  createEvent:async(k,e)=>{if(events.has(k))return false;events.set(k,structuredClone(e));return true;},
  updateEvent:async(k,p)=>{if(!events.has(k))throw Error('missing event');events.set(k,{...events.get(k),...p});},
  pending:async()=>[...events].filter(([,e])=>e.result==='pending').map(([key,e])=>({key,...e}))};
}
test('closed-browser monitor freezes before sending, survives restart and stops at request cap',async()=>{
 const store=memoryStore();let clock=stamp,sends=0,reads=0;
 const opts={store,now:()=>clock,getMatches:()=>({ready:true,matches:[match()]}),getCalibration:()=>null,
  readLive:async()=>{reads++;return [{...match(),status:'1H',score:'0-0',matchMinutes:20}];},readStats:async()=>null,
  refreshForecast:()=>null,readFinal:async()=>null,requestLimit:1,
  send:async()=>{assert.ok([...store.events.values()].some(e=>e.delivery==='reserved'));sends++;return {success:true};},log:{}};
 await createDailyDeskService(opts).tick();assert.equal(sends,1);
 clock+=3600000;await createDailyDeskService(opts).tick();assert.equal(sends,1);assert.equal(reads,1);
 clock+=300000;await createDailyDeskService(opts).tick();assert.equal(reads,1);
 const pick=[...store.events.values()].find(e=>e.type==='DAILY_PICK');assert.ok(pick.probabilities.over15);
});

test('no notification is sent when durable recording fails',async()=>{
 const store=memoryStore();store.createEvent=async()=>{throw Error('database offline');};let sends=0;
 const svc=createDailyDeskService({store,getMatches:()=>({ready:true,matches:[match()]}),getCalibration:()=>null,
  send:async()=>{sends++;},now:()=>stamp,readFinal:async()=>null,log:{}});
 await svc.tick();assert.equal(sends,0);
});

test('stored daily predictions settle from final regulation score',async()=>{
 const store=memoryStore();await store.createEvent('old',{fixtureId:1,kickoffUTC:iso(stamp-4*3600000),result:'pending',probabilities:{over15:.8,under25:.6}});
 const svc=createDailyDeskService({store,getMatches:()=>({ready:false,matches:[]}),getCalibration:()=>null,
  readFinal:async()=>({fixture:{status:{short:'FT'}},score:{fulltime:{home:2,away:1}},goals:{home:2,away:1}}),
  send:async()=>({success:true}),now:()=>stamp,log:{}});
 await svc.tick();assert.equal(store.events.get('old').outcomes.over15,'won');assert.equal(store.events.get('old').outcomes.under25,'lost');
});

test('midnight rollover retains the watched fixture and exposes delivered live updates',async()=>{
 const store=memoryStore();const clock=Date.parse('2026-09-27T23:05:00Z');
 const previous={fixtureId:7,status:'2H',minute:65,at:iso(clock-300000),homeGoals:0,awayGoals:0,shots:3,xg:.2,corners:1,redCards:0};
 const card={id:7,home:'Home',away:'Away',kickoffUTC:iso(clock-70*60000),history:{season:2026}};
 await store.save('2026-09-27',{desk:{cards:[card]},history:{7:[previous]},lastAlerts:{}});
 let sent=0;
 const svc=createDailyDeskService({store,now:()=>clock,getMatches:()=>({ready:false,matches:[]}),getCalibration:()=>null,
  readLive:async()=>[{id:7,status:'2H',score:'1-0',matchMinutes:70}],readStats:async()=>null,
  refreshForecast:()=>null,readFinal:async()=>null,send:async()=>{sent++;return {success:true};},log:{}});
 await svc.tick();assert.equal(sent,1);
 const view=await svc.view();assert.equal(view.recentUpdates[0].type,'SCORE_CHANGE');assert.equal(view.recentUpdates[0].delivery,'sent');
 await svc.tick();assert.equal(sent,1);
});

test('zero message budget still records predictions without a missing digest update',async()=>{
 const store=memoryStore();let sends=0;
 const svc=createDailyDeskService({store,getMatches:()=>({ready:true,matches:[match()]}),getCalibration:()=>null,
  send:async()=>{sends++;},now:()=>stamp,readFinal:async()=>null,messageLimit:0,log:{}});
 assert.equal((await svc.tick()).ok,true);assert.equal(sends,0);
 assert.ok([...store.events.values()].some(e=>e.type==='DAILY_PICK'));
});
