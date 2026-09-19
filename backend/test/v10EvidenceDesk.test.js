import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceDesk, verifiedRecentResults, coachRecord, lineupRecord } from '../src/services/evidenceDeskService.js';
import { captureDisplayedOdds } from '../../shared/playedBetEvidence.js';
import { createPlayedBetSettler } from '../src/services/playedBetSettlementService.js';
import { analyzeV9 } from '../src/services/agent47Service.js';
const now=Date.parse('2026-09-18T12:00:00Z');
const quote={status:'AVAILABLE',source:'API_FOOTBALL',fixtureId:123,kind:'PRE_MATCH',period:'REGULATION',bookmaker:{id:1,name:'Book'},providerUpdatedAt:'2026-09-18T11:00:00Z',expiresAt:'2026-09-18T15:00:00Z',odds:{over15:1.3,over25:1.8}};
test('played odds freeze exact market, bookmaker and time without inventing taken odds',()=>{
 const saved=captureDisplayedOdds(quote,123,'over15',now);quote.odds.over15=1.4;
 assert.equal(saved.price,1.3);assert.equal(saved.bookmaker.name,'Book');assert.equal(saved.recordedAt,new Date(now).toISOString());assert.equal(saved.odds,undefined);
});
test('wrong fixture, absent market and wrong period cannot supply a reference price',()=>{
 for(const [q,id,key] of [[quote,2,'over15'],[quote,123,'btts'],[{...quote,period:'FIRST_HALF'},123,'over15']]) assert.equal(captureDisplayedOdds(q,id,key,now).status,'UNAVAILABLE');
 assert.equal(captureDisplayedOdds(quote,123,'over15',now+86400000).status,'EXPIRED');
});
const bet={source:'USER_PLAYED',result:'pending',matchId:123,marketKey:'over15',kickoffUTC:'2026-08-22T10:00:00Z',firestoreId:'b'};
const fixture={fixture:{id:123,status:{short:'FT'}},goals:{home:2,away:0},score:{fulltime:{home:2,away:0}}};
test('old played bets settle independently, share one run and save before broadcasting',async()=>{
 const events=[];let fetches=0;
 const settle=createPlayedBetSettler({loadPending:async()=>[bet],fetchFixture:async()=>{fetches++;return fixture;},save:async(b,u)=>events.push(u.result),onSettled:()=>events.push('broadcast'),now:()=>now});
 const [a,b]=await Promise.all([settle(),settle()]);assert.equal(a.settled,1);assert.deepEqual(a,b);assert.equal(fetches,1);assert.deepEqual(events,['won','broadcast']);
});
test('failed durable write retries without publishing a settlement',async()=>{
 let fail=true,published=0;
 const settle=createPlayedBetSettler({loadPending:async()=>[bet],fetchFixture:async()=>fixture,save:async()=>{if(fail)throw Error('write failed');},onSettled:()=>published++,now:()=>now});
 assert.equal((await settle()).failed,1);assert.equal(published,0);fail=false;assert.equal((await settle()).settled,1);
});
test('settlement requires exact fixture, completed status and regulation result',async()=>{
 for(const raw of [{...fixture,fixture:{id:222,status:{short:'FT'}}},{...fixture,fixture:{id:123,status:{short:'2H'}}},{...fixture,fixture:{id:123,status:{short:'PST'}}}]){
 const settle=createPlayedBetSettler({loadPending:async()=>[bet],fetchFixture:async()=>raw,save:async()=>assert.fail('must not save'),now:()=>now});assert.equal((await settle()).settled,0);}
 const settle=createPlayedBetSettler({loadPending:async()=>[{...bet,marketKey:'over25'}],fetchFixture:async()=>({...fixture,fixture:{id:123,status:{short:'AET'}},goals:{home:3,away:2},score:{fulltime:{home:1,away:1}}}),save:async(b,u)=>assert.equal(u.result,'lost'),now:()=>now});assert.equal((await settle()).settled,1);
});
test('settlement enforces fixture budget and quota',async()=>{
 let calls=0;const settle=createPlayedBetSettler({loadPending:async()=>Array.from({length:10},(_,i)=>({...bet,matchId:i+1})),fetchFixture:async()=>{calls++;return null;},save:async()=>{},maxFixtures:2,now:()=>now});await settle();await settle();assert.equal(calls,4);
 const paused=createPlayedBetSettler({loadPending:async()=>[bet],fetchFixture:()=>assert.fail(),save:async()=>{},canLaunch:()=>false});assert.equal((await paused()).checked,0);
});
const f={id:1,status:{short:'FT'},leagueId:39,season:2026,date:'2026-09-10T12:00:00Z',homeTeamId:10,awayTeamId:20,homeGoals:2,awayGoals:1};
test('team sample excludes duplicates, future games, other leagues and missing scores',()=>{
 const rows=verifiedRecentResults([f,f,{...f,id:2,leagueId:2},{...f,id:3,homeGoals:null},{...f,id:4,date:'2026-10-01'}],10,39,2026,now);assert.equal(rows.length,1);assert.equal(rows[0].points,3);
});
test('coach comparison uses tenure dates and actual sample sizes',()=>{
 const fixtures=verifiedRecentResults([f,{...f,id:2,date:'2026-09-01',homeGoals:0}],10,39,2026,now);
 const info=coachRecord([{name:'Coach',career:[{team:{id:10},start:'2026-09-05',end:null}]}],10,fixtures,now);
 assert.equal(info.beforePPG,0);assert.equal(info.afterPPG,3);assert.equal(info.afterCount,1);
 assert.equal(coachRecord([{name:'Future',career:[{team:{id:10},start:'2026-10-01'}]}],10,fixtures,now),null);
});
test('published XI requires eleven unique player IDs for the correct team',()=>{
 const line={team:{id:10},startXI:Array.from({length:11},(_,i)=>({player:{id:i+1,name:`P${i}`}}))};
 assert.equal(lineupRecord([line],10).players.length,11);assert.equal(lineupRecord([line],20),null);line.startXI[10]=line.startXI[0];assert.equal(lineupRecord([line],10),null);
});
test('early goal is inspectable only with team-by-team score reconciliation',()=>{
 const match={homeTeamId:10,awayTeamId:20,score:'1-0',matchMinutes:30};
 const evidence={currentEvents:[{type:'Goal',detail:'Normal Goal',team:{id:10,name:'Home'},player:{name:'Player'},time:{elapsed:12}}]};
 assert.equal(buildEvidenceDesk({},match,evidence,now).chaos[0].summary,'Observed');
 assert.equal(buildEvidenceDesk({},{...match,score:'2-0'},evidence,now).chaos[0].summary,'Unavailable');
 assert.equal(buildEvidenceDesk({},match,{},now).chaos[0].summary,'Unavailable');
});
test('parameter fixes preserve coherent core probabilities and bound context scores',()=>{
 const base={home:'Home',away:'Away',status:'NS',leagueId:39,season:2026,homeGoalsAvgFor:1.9,homeGoalsAvgAgainst:5,awayGoalsAvgFor:1.1,awayGoalsAvgAgainst:5,homeForm:'W-W-D',awayForm:'L-D-W',homeSampleSize:8,awaySampleSize:8};
 const a=analyzeV9(base),b=analyzeV9({...base,homeCoach:{improving:true,tenureWeeks:10},earlyGoalScored:true,earlyGoalMinute:5});
 assert.equal(a.parameters.p6_defensiveGap.score,100);assert.equal(a.parameters.p15_crisis.score,null);assert.equal(a.parameters.p2_starPower.score,null);
 assert.deepEqual(a.poisson.marketProbabilities,b.poisson.marketProbabilities);
 assert.equal(b.chaosVariables.earlyGoalBoost,0);
 const desk=buildEvidenceDesk(a,base,{},now);assert.equal(Object.keys(desk.parameters).length,15);assert.equal(desk.panels.length,8);
});
