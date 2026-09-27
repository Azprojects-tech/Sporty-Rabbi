import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DYNAMIC_STRENGTH_VERSION,
  predictDynamicStrength,
  strengthRowsFromLedger,
  trainDynamicStrength,
} from '../../shared/dynamicStrengthModel.js';
import { evaluateShadowChallenger } from '../../shared/challengerEvaluation.js';

function trainingRows(){
  const teams=['Alpha','Bravo','Charlie','Delta'];
  const rows=[];
  let day=Date.UTC(2026,0,1);
  for(let i=0;i<120;i++){
    const home=teams[i%4],away=teams[(i+1+(i%2))%4];
    if(home===away)continue;
    const strength={Alpha:3,Bravo:0,Charlie:1,Delta:1};
    const hg=Math.max(0,strength[home]+(home==='Alpha'?1:0)-(away==='Alpha'?1:0));
    const ag=Math.max(0,strength[away]-(home==='Alpha'?1:0));
    rows.push({fixtureId:String(i),leagueId:39,league:'Premier League',leagueCountry:'England',
      kickoffUTC:new Date(day+i*86400000).toISOString(),kickoff:day+i*86400000,
      home,away,homeKey:home.toLowerCase(),awayKey:away.toLowerCase(),homeGoals:hg,awayGoals:ag});
  }
  return rows;
}

test('V11 dynamic strength learns opponent-adjusted team separation from settled results',()=>{
  const model=trainDynamicStrength(trainingRows());
  assert.equal(model.version,DYNAMIC_STRENGTH_VERSION);
  assert.equal(model.leagueCount,1);
  const p=predictDynamicStrength(model,{leagueId:39,home:'Alpha',away:'Bravo',status:'NS'});
  assert.equal(p.status,'AVAILABLE');
  assert.ok(p.homeLambda>p.awayLambda);
  assert.ok(p.marketProbabilities.home_win>p.marketProbabilities.away_win);
  assert.ok(p.homeMatches>=3&&p.awayMatches>=3);
});

test('V11 falls back safely when league or team history is too thin',()=>{
  const model=trainDynamicStrength(trainingRows());
  assert.equal(predictDynamicStrength(model,{leagueId:140,home:'Alpha',away:'Bravo',status:'NS'}).status,'UNAVAILABLE');
  const p=predictDynamicStrength(model,{leagueId:39,home:'New Club',away:'Bravo',status:'NS'});
  assert.equal(p.status,'UNAVAILABLE');
  assert.equal(p.reason,'TEAM_HISTORY_TOO_THIN');
});

test('ledger training rows deduplicate repeated prediction snapshots and reject unresolved results',()=>{
  const docs=[
    {matchId:1,leagueId:39,home:'A',away:'B',kickoffUTC:'2026-09-01T12:00:00Z',predictedAt:'2026-09-01T08:00:00Z',finalScore:'2-1'},
    {matchId:1,leagueId:39,home:'A',away:'B',kickoffUTC:'2026-09-01T12:00:00Z',predictedAt:'2026-09-01T09:00:00Z',finalScore:'2-1'},
    {matchId:2,leagueId:39,home:'C',away:'D',kickoffUTC:'2026-09-02T12:00:00Z',finalScore:null},
  ];
  const rows=strengthRowsFromLedger(docs);
  assert.equal(rows.length,1);
  assert.equal(rows[0].homeGoals,2);
  assert.equal(rows[0].awayGoals,1);
});

test('shadow evaluation never auto-promotes a small sample',()=>{
  const docs=Array.from({length:20},(_,i)=>({
    matchId:String(i),snapshotType:'PRE_MATCH',predictedAt:'2026-09-01T08:00:00Z',kickoffUTC:'2026-09-01T12:00:00Z',
    finalScore:i%2?'2-1':'1-1',
    modelState:{marketProbabilities:{home_win:.5,draw:.25,away_win:.25,over15:.7,over25:.5,under25:.5,btts:.6}},
    challengerStates:{dynamicStrength:{status:'AVAILABLE',marketProbabilities:{home_win:.52,draw:.25,away_win:.23,over15:.72,over25:.52,under25:.48,btts:.61}}},
  }));
  const e=evaluateShadowChallenger(docs);
  assert.equal(e.status,'COLLECTING_SHADOW_RESULTS');
  assert.equal(e.gate.automaticPromotion,false);
});

test('production server records V11 shadow without routing picks through it',()=>{
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const ledger=fs.readFileSync(new URL('../../shared/predictionLedger.js',import.meta.url),'utf8');
  assert.match(server,/createDynamicStrengthService/);
  assert.match(server,/function analyzeWithChallenger/);
  assert.match(server,/onLedgerRead: docs => dynamicStrength\.rebuildFromLedger/);
  assert.match(ledger,/challengerStates/);
  assert.match(ledger,/schemaVersion: 6/);
});
