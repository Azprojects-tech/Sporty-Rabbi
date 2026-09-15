import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrematchOdds, createPrematchOddsService, isCurrentPrematchQuote } from '../src/services/prematchOddsService.js';
const now=Date.parse('2026-09-14T12:00:00Z');
const payload=(id=123) => ({errors:[],response:[{fixture:{id},update:'2026-09-14T11:00:00Z',bookmakers:[{id:8,name:'Book',bets:[
  {id:1,name:'Match Winner',values:[{value:'Home',odd:'2.10'},{value:'Draw',odd:'3.2'},{value:'Away',odd:'3.8'}]},
  {id:5,name:'Goals Over/Under',values:[{value:'Over 1.5',odd:'1.4'},{value:'Under 2.5',odd:'1.8'}]},
  {id:8,name:'Both Teams Score',values:[{value:'Yes',odd:'1.9'}]},
  {id:99,name:'Other Period',values:[{value:'Home',odd:'9'}]},
]}]}]});
test('prematch odds map known full-time market IDs, attach provenance, and keep prices from one book',()=>{
  const q=normalizePrematchOdds(payload(),123,{now});
  assert.deepEqual(q.odds,{homeWin:2.1,draw:3.2,awayWin:3.8,over15:1.4,under25:1.8,btts:1.9});
  assert.equal(q.bookmaker.id,8); assert.equal(q.period,'REGULATION');
  assert.equal(isCurrentPrematchQuote(q,123,now),true);
  assert.equal(isCurrentPrematchQuote(q,124,now),false);
  assert.equal(isCurrentPrematchQuote(q,123,now+4*3600000),false);
});
test('provider errors, wrong fixture, future, missing and stale updates do not become odds',()=>{
  assert.equal(normalizePrematchOdds(payload(124),123,{now}).status,'UNAVAILABLE');
  assert.equal(normalizePrematchOdds({...payload(),errors:{token:'unavailable'}},123,{now}).status,'UNAVAILABLE');
  for(const update of [null,'invalid','2026-09-14T07:00:00Z','2026-09-14T13:00:00Z']) {
    const p=payload(); p.response[0].update=update;
    assert.equal(normalizePrematchOdds(p,123,{now}).status,'UNAVAILABLE');
  }
});
test('invalid or suspended odds and a bookmaker mismatch are excluded',()=>{
  const p=payload(); p.response[0].bookmakers[0].bets[0].values=[{value:'Home',odd:'2',suspended:true},{value:'Away',odd:null},{value:'Draw',odd:'1'}];
  assert.equal(normalizePrematchOdds(p,123,{now}).odds.homeWin,undefined);
  assert.equal(normalizePrematchOdds(p,123,{now,bookmakerId:99}).status,'UNAVAILABLE');
});
test('concurrent callers and repeated reads share one request; daily budget caps new fixtures',async()=>{
  let calls=0;
  const svc=createPrematchOddsService({now:()=>now,dailyLimit:1,request:async(path,config)=>{calls++;assert.equal(path,'/odds');assert.equal(config.params.fixture,123);return {data:payload()};}});
  const results=await Promise.all([svc.get(123),svc.get(123),svc.get(123)]);
  assert.ok(results.every(q=>q.status==='AVAILABLE')); assert.equal(calls,1);
  await svc.get(123); assert.equal(calls,1);
  assert.equal((await svc.get(124)).reason,'ODDS_DAILY_BUDGET_REACHED');
});
test('quota and configuration gates prevent calls; empty coverage is cached for fifteen minutes',async()=>{
  let calls=0,clock=now;
  const request=async()=>{calls++; return {data:{response:[]}};};
  assert.equal((await createPrematchOddsService({available:false,request}).get(123)).reason,'API_NOT_CONFIGURED');
  const svc=createPrematchOddsService({request,now:()=>clock});
  await svc.get(123,{canLaunch:()=>false}); assert.equal(calls,0);
  await svc.get(123); clock+=2*60000; await svc.get(123); assert.equal(calls,1);
  clock+=15*60000; await svc.get(123); assert.equal(calls,2);
});
test('errors preserve quota headers and queued calls receive the launch guard',async()=>{
  let headers=null;
  const svc=createPrematchOddsService({now:()=>now,request:async(_p,_c,guard)=>{
    assert.equal(guard(),true); throw {response:{status:429,headers:{remaining:0}}};
  }});
  const q=await svc.get(123,{onResponse:h=>{headers=h;}});
  assert.equal(q.status,'UNAVAILABLE'); assert.deepEqual(headers,{remaining:0});
});
