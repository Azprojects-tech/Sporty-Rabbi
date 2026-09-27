import test from 'node:test';
import assert from 'node:assert/strict';
import { walkForwardDynamicStrengthAudit } from '../../shared/dynamicStrengthBacktest.js';

function doc(i,{version='V10.6C-Unified-Decisions',futureShift=0}={}){
  const teams=['Alpha','Bravo','Charlie','Delta'];
  const home=teams[i%4],away=teams[(i+1+(i%2))%4];
  const strong=home==='Alpha'||away==='Alpha';
  const hg=home==='Alpha'?3:away==='Alpha'?0:(i%3===0?2:1);
  const ag=away==='Alpha'?3:home==='Alpha'?0:(i%4===0?2:1);
  const kickoff=Date.UTC(2026,0,1+i+futureShift,15);
  return{
    matchId:String(i+futureShift*10000),home,away,league:'Test League',leagueId:999,leagueCountry:'Test',
    predictedAt:new Date(kickoff-3600000).toISOString(),kickoffUTC:new Date(kickoff).toISOString(),
    finalScore:home==='Alpha'?'3-0':away==='Alpha'?'0-3':String(hg)+'-'+String(ag),
    analysisVersion:version,snapshotType:'PRE_MATCH',
    modelState:{marketProbabilities:{home_win:strong?.34:.38,draw:.32,away_win:strong?.34:.30,over15:.55,over25:.45,under25:.55,btts:.5}},
  };
}

test('walk-forward audit predicts only after seed history and never auto-promotes',()=>{
  const docs=Array.from({length:80},(_,i)=>doc(i));
  const r=walkForwardDynamicStrengthAudit(docs,{targetVersion:'V10.6C-Unified-Decisions',seedLeagueMatches:12,minTeamMatches:1});
  assert.ok(r.comparableFixtures>20);
  assert.equal(r.challenger.fixtures,r.champion.fixtures);
  assert.equal(r.automaticPromotion,false);
  assert.ok(Number.isFinite(r.delta.logLoss));
});

test('walk-forward audit filters champion comparison to requested engine version',()=>{
  const docs=[
    ...Array.from({length:50},(_,i)=>doc(i,{version:'OLD'})),
    ...Array.from({length:30},(_,i)=>doc(i+50,{version:'V10.6C-Unified-Decisions'})),
  ];
  const current=walkForwardDynamicStrengthAudit(docs,{targetVersion:'V10.6C-Unified-Decisions',seedLeagueMatches:10,minTeamMatches:1});
  const all=walkForwardDynamicStrengthAudit(docs,{targetVersion:null,seedLeagueMatches:10,minTeamMatches:1});
  assert.ok(current.comparableFixtures<all.comparableFixtures);
  assert.ok(current.comparableFixtures>0);
});

test('later fixtures add later evaluations without rewriting the earlier audit population',()=>{
  const prefix=Array.from({length:50},(_,i)=>doc(i));
  const a=walkForwardDynamicStrengthAudit(prefix,{targetVersion:null,seedLeagueMatches:10,minTeamMatches:1});
  const future=[...prefix,...Array.from({length:20},(_,i)=>doc(i+50,{futureShift:100}))];
  const b=walkForwardDynamicStrengthAudit(future,{targetVersion:null,seedLeagueMatches:10,minTeamMatches:1});
  assert.equal(a.champion.fixtures,40);
  assert.ok(b.champion.fixtures>a.champion.fixtures);
  assert.equal(a.targetVersion,'ALL');
  assert.equal(b.targetVersion,'ALL');
});
