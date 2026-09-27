import test from 'node:test';
import assert from 'node:assert/strict';
import { parseApiFootballHistoryFixtures, createApiFootballHistoryService } from '../src/services/apiFootballHistoryService.js';
import { DYNAMIC_STRENGTH_DEFAULTS } from '../../shared/dynamicStrengthModel.js';

function fixture(i,{leagueId=999,season=2026,status='FT'}={}){
  return {
    fixture:{id:1000+i,date:new Date(Date.UTC(2026,0,1+i)).toISOString(),status:{short:status}},
    league:{id:leagueId,name:'Lower League',country:'Test',season},
    teams:{home:{name:'Home '+(i%6)},away:{name:'Away '+((i+1)%6)}},
    goals:{home:i%3,away:(i+1)%3},
  };
}

test('API-Football history parser keeps completed regulation results only',()=>{
  const rows=parseApiFootballHistoryFixtures([fixture(1),fixture(2,{status:'NS'}),fixture(3,{status:'AET'})]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].leagueId,999);
  assert.equal(rows[0].source,'API_FOOTBALL');
});

test('API-Football history service caches a league season and reuses it',async()=>{
  let calls=0;
  const svc=createApiFootballHistoryService({
    getDb:()=>null,
    canCall:()=>true,
    onResponse:()=>{},
    request:async()=>{calls++;return{data:{response:Array.from({length:90},(_,i)=>fixture(i))},headers:{}};},
  });
  const a=await svc.fetchSeason(999,2026);
  const b=await svc.fetchSeason(999,2026);
  assert.equal(a.ok,true);
  assert.equal(a.rows.length,90);
  assert.equal(b.skipped,true);
  assert.equal(calls,1);
});

test('lower-league data expansion does not alter V11.1 model thresholds',()=>{
  assert.deepEqual(DYNAMIC_STRENGTH_DEFAULTS,{
    halfLifeDays:365,windowDays:730,priorGames:4,iterations:24,rho:-0.08,
    minLeagueMatches:80,minTeamMatches:3,minLambda:0.08,maxLambda:4.5,
  });
});
