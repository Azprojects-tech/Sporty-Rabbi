import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeV9 } from '../src/services/agent47Service.js';
import { decideMarkets, summarizeMarketDecisions } from '../src/services/marketDecisionService.js';
import { refreshLiveForecast } from '../src/services/liveForecastRefreshService.js';
import { completedFixtureHistory } from '../../shared/completedFixtureHistory.js';
import { calculateNextGoalProbability, calculateMomentum } from '../src/services/liveAnalyticsService.js';

const base={id:77,home:'A',away:'B',leagueId:39,season:2026,status:'2H',matchMinutes:50,score:'0-0',
 homeGoalsAvgFor:1.5,homeGoalsAvgAgainst:1.2,awayGoalsAvgFor:1.1,awayGoalsAvgAgainst:1.3,
 homeSampleSize:8,awaySampleSize:8,homeForm:'W-D-W-L-W',awayForm:'D-L-W-D-L'};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('0-0 clock refresh recomputes every market and agrees with a fresh analysis',()=>{
 const previous={...base,analysis:analyzeV9(base)};
 const now={id:77,home:'A',away:'B',leagueId:39,season:2026,status:'2H',matchMinutes:75,score:'0-0'};
 const updated=refreshLiveForecast(now,previous), direct=analyzeV9({...base,...now});
 assert.ok(updated.analysis.poisson.marketProbabilities.over05 < previous.analysis.poisson.marketProbabilities.over05);
 for(const key of Object.keys(direct.poisson.marketProbabilities)) close(updated.analysis.poisson.marketProbabilities[key],direct.poisson.marketProbabilities[key]);
 assert.equal(updated.analysis.forecastContract.state.minute,75);
 assert.equal(updated._staleAnalysis,false);
});
test('score changes, cards and historical xG survive refresh without reusing old probabilities',()=>{
 const data={...base,homeXgAvg:1.8,homeXgaAvg:1,awayXgAvg:1.2,awayXgaAvg:1.4,homeCards:{red:1}};
 const previous={...data,analysis:analyzeV9(data)};
 const now={id:77,home:'A',away:'B',leagueId:39,season:2026,status:'2H',matchMinutes:65,score:'1-1'};
 const updated=refreshLiveForecast({...now,cards:{home:{red:null}}},previous), direct=analyzeV9({...data,...now});
 close(updated.analysis.poisson.marketProbabilities.home_win,direct.poisson.marketProbabilities.home_win);
 close(updated.analysis.poisson.marketProbabilities.btts,1);
 assert.ok(!updated.analysis.recommendations.some(r=>r.marketKey==='btts'));
 assert.equal(refreshLiveForecast({...now,id:78},previous),null);
 assert.equal(refreshLiveForecast({...now,season:2025},previous),null);
 const extra=refreshLiveForecast({...now,status:'ET',matchMinutes:100},previous);
 assert.deepEqual(extra.analysis.recommendations,[]);
});
test('one weak market cannot discard a separate valid priced market; price beats raw probability in opportunity ranking',()=>{
 const core={coreReady:true,reliability:80,poisson:{marketProbabilities:{over05:.95,over25:.70,btts:.48}}};
 const recs=Object.entries(core.poisson.marketProbabilities).map(([marketKey,probability01])=>({marketKey,probability01,selection:marketKey,type:'GOALS_ONLY'}));
 const decided=decideMarkets(recs,core,{over05:1.02,over25:1.7,btts:3});
 assert.equal(decided[0].marketKey,'over25');
 assert.equal(decided[0].decisionState,'BET');
 assert.equal(decided.find(r=>r.marketKey==='btts').decisionState,'NO_BET');
 const summary=summarizeMarketDecisions(decided);
 assert.equal(summary.mostLikely.marketKey,'over05');
 assert.equal(summary.bestPriced.marketKey,'over25');
 for(const r of decided) close(r.probability01,core.poisson.marketProbabilities[r.marketKey]);
 assert.ok(decideMarkets(recs,core).every(r=>r.decisionState!=='BET'));
});
test('live evidence is visible but never falsely claimed as a fitted probability adjustment',()=>{
 const a=analyzeV9({...base,xg:{home:1.8,away:.8},shots:{home:6,away:3}});
 assert.equal(a.forecastContract.liveEvidence.xg.home,1.8);
 assert.equal(a.forecastContract.inputsUsed.liveXg,false);
 assert.equal(a.forecastContract.inputsUsed.liveScoreAndClock,true);
 assert.equal(a.forecastContract.probabilityCalibration,'NOT_FITTED');
 assert.equal(a.decisionMetrics.recommendationConfidence.score,a.predictionCore.reliability);
 const live=calculateNextGoalProbability({...base,analysis:a});
 close(live.nextGoal.home.probability01,a.poisson.marketProbabilities.next_goal_home);
 assert.ok(calculateNextGoalProbability({...base,xg:{home:1,away:1},shots:{home:4,away:4},homeConversionPct:20,awayConversionPct:20}).error);
});
test('momentum accepts provider 1H and 2H codes',()=>{
 for(const status of ['1H','2H']) assert.ok(calculateMomentum({...base,status,xg:{home:1,away:.5},shots:{home:5,away:2},possession:{home:60,away:40}}).home);
});
test('history excludes incomplete, duplicate, wrong-season, future and unrelated fixtures and uses regulation scores',()=>{
 const fixture=(id,status='FT',home=2,away=1)=>({fixture:{id,date:'2026-09-01T12:00:00Z',status:{short:status}},
  league:{id:39,season:2026},teams:{home:{id:1},away:{id:2}},goals:{home,away}});
 const extra={...fixture(8,'AET',3,2),score:{fulltime:{home:1,away:1}}};
 const rows=[fixture(1),fixture(1),fixture(2,'2H'),fixture(3,'FT',null,1),fixture(4,'AET'),
 {...fixture(5),league:{id:39,season:2025}}, {...fixture(6),fixture:{id:6,date:'2026-10-01',status:{short:'FT'}}},
 {...fixture(7),teams:{home:{id:3},away:{id:4}}},extra];
 const result=completedFixtureHistory(rows,{teamId:1,leagueId:39,season:2026,before:Date.parse('2026-09-19')});
 assert.deepEqual(result.map(r=>r.fixture.id),[1,8]);
 assert.deepEqual(result[1].goals,{home:1,away:1});
});

test('frozen audit rejects post-kickoff snapshots and counts distinct fixtures',async()=>{
 const {auditFrozenForecasts}=await import('../../scripts/auditFrozenForecasts.mjs');
 const doc={matchId:1,settlementStatus:'SETTLED',finalStatus:'FT',finalScore:'1-0',snapshotType:'PRE_MATCH',
 predictedAt:'2026-09-01T10:00:00Z',kickoffUTC:'2026-09-01T12:00:00Z',analysisVersion:'TEST',
 modelState:{marketProbabilities:{over05:.8,over25:.3}},markets:[{marketKey:'over05',probability01:.8}]};
 const out=auditFrozenForecasts([doc,{...doc,predictedAt:'2026-09-01T11:00:00Z'},
 {...doc,matchId:2,predictedAt:'2026-09-01T13:00:00Z'}]);
 assert.equal(out.settledFixtures,1);assert.equal(out.excluded.duplicateFixture,1);assert.equal(out.excluded.notPrematch,1);
 assert.equal(out.selectedMarketCalls.sampleSize,1);assert.equal(out.allFrozenMarkets.over25.lost,1);
});

test('calibration experiment keeps later fixtures out of parameter selection',async()=>{
 const {compareForecastCalibration}=await import('../../scripts/compareForecastCalibration.mjs');
 const docs=Array.from({length:6},(_,i)=>({matchId:i+1,analysisVersion:'V10.6A-Coherent-Core',settlementStatus:'SETTLED',
  snapshotType:'PRE_MATCH',finalStatus:'FT',finalScore:i%2?'0-1':'1-0',
  predictedAt:`2026-09-0${i+1}T09:00:00Z`,kickoffUTC:`2026-09-0${i+1}T12:00:00Z`,modelState:{homeLambda:1.3,awayLambda:1.1}}));
 const first=compareForecastCalibration(docs);
 const changed=compareForecastCalibration(docs.map((d,i)=>i>=3?{...d,finalScore:'5-0'}:d));
 assert.deepEqual(first.challenger,changed.challenger);
 assert.deepEqual(first.train,changed.train);
 assert.equal(first.selectedOn,'TRAINING_DATA_ONLY');
 assert.equal(first.deploymentDecision,'NOT_APPROVED_SHORT_WINDOW_NO_LIVE_EVENT_VALIDATION');
});

test('shot-rate context uses cumulative counts once and preserves observed zero',async()=>{
 const {phaseBlendCountRate}=await import('../../shared/liveEvidenceRates.js');
 close(phaseBlendCountRate(10,5,45,180),10);
 close(phaseBlendCountRate(10,0,45,180),8);
 close(phaseBlendCountRate(10,8,80,180),9);
 assert.equal(phaseBlendCountRate(10,null,45,180),10);
});
