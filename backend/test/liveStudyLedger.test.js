import test from 'node:test';
import assert from 'node:assert/strict';
import {
  poissonTail,furtherGoalProbabilities,buildLiveStudySnapshot,settleLiveStudySnapshot,
  summarizeSettledLiveStudy,aggregateStudyDocuments,summarizePlayedLiveBets
} from '../../shared/liveStudy.js';

test('further-goal probabilities are nested and based on remaining lambda',()=>{
  const p=furtherGoalProbabilities({home:1.2,away:.8});
  assert.ok(p.gte1>p.gte2 && p.gte2>p.gte3);
  assert.ok(Math.abs(p.gte1-(1-Math.exp(-2)))<1e-12);
  assert.equal(poissonTail(-1,1),null);
});

test('study snapshot freezes baseline and adjusted forecasts plus evidence',()=>{
  const match={id:7,status:'1H',matchMinutes:25,score:'0-0',home:'A',away:'B',
    analysis:{predictionCore:{poisson:{live:{available:true,baselineRemainingLambda:{home:1,away:.7},remainingLambda:{home:1.2,away:.8},
      liveHazard:{version:'LIVE_HAZARD_V1',source:'XG'}}}}}};
  const stats={xg:{home:.7,away:.2},shots:{home:3,away:1},totalShots:{home:7,away:4},corners:{home:4,away:1},cards:{home:{red:0},away:{red:0}}};
  const row=buildLiveStudySnapshot(match,stats,{kickoffUTC:'2026-10-03T12:00:00Z',league:'Test'},Date.parse('2026-10-03T12:25:00Z'));
  assert.equal(row.bucket,25);assert.equal(row.hazardSource,'XG');assert.equal(row.evidence.xg.home,.7);
  assert.ok(row.adjustedFurther.gte2>row.baselineFurther.gte2);
});

test('settlement scores baseline and hazard against goals after the snapshot',()=>{
  const row={settlementStatus:'PENDING',goalsAtSnapshot:1,hazardSource:'XG',
    baselineFurther:{gte1:.6,gte2:.3,gte3:.1},adjustedFurther:{gte1:.8,gte2:.55,gte3:.25}};
  const settled=settleLiveStudySnapshot(row,{home:2,away:1});
  assert.equal(settled.goalsAfter,2);assert.deepEqual(settled.outcome,{gte1:1,gte2:1,gte3:0});
  assert.ok(settled.evaluation.hazard.brierMean<settled.evaluation.baseline.brierMean);
});

test('summaries retain weighted score sums so fixture documents can be aggregated later',()=>{
  const rows=[
    settleLiveStudySnapshot({settlementStatus:'PENDING',goalsAtSnapshot:0,hazardSource:'XG',baselineFurther:{gte1:.4,gte2:.2,gte3:.1},adjustedFurther:{gte1:.6,gte2:.3,gte3:.1}},{home:1,away:0}),
    settleLiveStudySnapshot({settlementStatus:'PENDING',goalsAtSnapshot:0,hazardSource:'NONE',baselineFurther:{gte1:.5,gte2:.2,gte3:.1},adjustedFurther:{gte1:.5,gte2:.2,gte3:.1}},{home:0,away:0}),
  ];
  const one=summarizeSettledLiveStudy(rows);
  assert.equal(one.overall.snapshots,2);assert.equal(one.bySource.XG.snapshots,1);
  const all=aggregateStudyDocuments([{metrics:one},{metrics:one}]);
  assert.equal(all.fixtures,2);assert.equal(all.overall.snapshots,4);
});

test('live price summary counts only real-money singles placed after kickoff',()=>{
  const bets=[
    {source:'USER_PLAYED',slipType:'single',paper:false,createdAt:'2026-10-03T12:10:00Z',kickoffUTC:'2026-10-03T12:00:00Z',marketKey:'over25',modelProbability:60,odds:2,stake:1000,result:'won'},
    {source:'USER_PLAYED',slipType:'single',paper:true,createdAt:'2026-10-03T12:10:00Z',kickoffUTC:'2026-10-03T12:00:00Z',marketKey:'over25',modelProbability:60,odds:2,stake:1000,result:'won'},
    {source:'USER_PLAYED',slipType:'single',paper:false,createdAt:'2026-10-03T11:50:00Z',kickoffUTC:'2026-10-03T12:00:00Z',marketKey:'over25',modelProbability:60,odds:2,stake:1000,result:'won'},
  ];
  const s=summarizePlayedLiveBets(bets);
  assert.equal(s.placed,1);assert.equal(s.settled,1);assert.equal(s.roi,1);assert.ok(s.meanModelEdge>.09&&s.meanModelEdge<.11);
});
