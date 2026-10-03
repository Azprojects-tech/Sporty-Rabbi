import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DYNAMIC_STRENGTH_VERSION,
  fitLeagueStrength,
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

test('production runtime does not wire the V11 research challenger',()=>{
  const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const ledger=fs.readFileSync(new URL('../../shared/predictionLedger.js',import.meta.url),'utf8');
  const detail=fs.readFileSync(new URL('../../frontend/src/components/DetailPanel.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(server,/createDynamicStrengthService|createApiFootballHistoryService|analyzeWithChallenger|dynamicStrength\.|modelChallenger|boot-v11-shadow/);
  assert.doesNotMatch(ledger,/challengerStates/);
  assert.doesNotMatch(detail,/V11\.1|useVisibleV11|visibleForecast/);
  assert.match(server,/const analysis = analyzeV9\(enriched\)/);
});


test('V11.1 batch fit regularises thin samples and keeps league venue rates explicit',()=>{
  const rows=trainingRows();
  const fitted=fitLeagueStrength(rows,{halfLifeDays:365,priorGames:4,iterations:24,minLeagueMatches:80});
  assert.ok(fitted);
  assert.ok(fitted.leagueHome>0&&fitted.leagueAway>0);
  assert.ok(fitted.attack.alpha>fitted.attack.bravo);
  assert.ok(fitted.teamMatches.alpha>=3&&fitted.teamMatches.bravo>=3);
  assert.ok(Number.isFinite(fitted.defence.alpha));
});

test('V11.1 recent results can move strength without future leakage',()=>{
  const base=trainingRows();
  const cutoff=base[80].kickoff;
  const before=fitLeagueStrength(base,{minLeagueMatches:60},cutoff-1);
  const after=fitLeagueStrength(base,{minLeagueMatches:60},base[base.length-1].kickoff);
  assert.ok(before&&after);
  assert.notDeepEqual(before.attack,after.attack);
  assert.ok(before.trainedThrough < after.trainedThrough);
});
