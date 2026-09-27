import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFdGoalsCsv, mapMatchToHistoricalNames } from '../../shared/historicalGoalsData.js';
import { DYNAMIC_STRENGTH_DEFAULTS } from '../../shared/dynamicStrengthModel.js';
import { createDynamicStrengthService } from '../src/services/dynamicStrengthService.js';

function csv(rows=110){
  const out=['Date,HomeTeam,AwayTeam,FTHG,FTAG'];
  const teams=['Man United','Chelsea','Arsenal','Liverpool'];
  for(let i=0;i<rows;i++){
    const d=new Date(Date.UTC(2026,7,1)-i*86400000);
    const dd=String(d.getUTCDate()).padStart(2,'0'),mm=String(d.getUTCMonth()+1).padStart(2,'0'),yy=String(d.getUTCFullYear()).slice(-2);
    const home=teams[i%4],away=teams[(i+1)%4];
    out.push(`${dd}/${mm}/${yy},${home},${away},${home==='Man United'?2:1},${away==='Liverpool'?2:1}`);
  }
  return out.join('\n');
}

test('goals-history parser does not require corner columns',()=>{
  const rows=parseFdGoalsCsv('Date,HomeTeam,AwayTeam,FTHG,FTAG\n01/09/26,Man United,Chelsea,2,1');
  assert.equal(rows.length,1);
  assert.equal(rows[0].hg,2);
  assert.equal(rows[0].ag,1);
});

test('team identity adapter maps API-Football spelling to football-data spelling',()=>{
  const mapped=mapMatchToHistoricalNames(
    {leagueId:39,home:'Manchester United',away:'Chelsea'},
    {'39':['Man United','Chelsea','Arsenal']}
  );
  assert.equal(mapped.home,'Man United');
  assert.equal(mapped.away,'Chelsea');
});

test('external results expand V11.1 training without changing model thresholds',async()=>{
  assert.deepEqual(DYNAMIC_STRENGTH_DEFAULTS,{
    halfLifeDays:365,windowDays:730,priorGames:4,iterations:24,rho:-0.08,
    minLeagueMatches:80,minTeamMatches:3,minLambda:0.08,maxLambda:4.5,
  });
  const svc=createDynamicStrengthService({
    now:()=>Date.UTC(2026,8,27),
    log:{log(){},warn(){}},
    fetchText:async url=>{
      if(url.endsWith('/E0.csv'))return csv();
      throw new Error('not supplied in test');
    },
  });
  const status=await svc.rebuildFromLedger([]);
  assert.equal(status.ready,true);
  assert.ok(status.externalTrainingRows>=100);
  assert.ok(status.externalHistory.leagues>=1);
  const p=svc.predict({leagueId:39,home:'Manchester United',away:'Chelsea',status:'NS'});
  assert.equal(p.status,'AVAILABLE');
  assert.ok(Number.isFinite(p.marketProbabilities.home_win));
  assert.ok(p.homeMatches>=3&&p.awayMatches>=3);
});
