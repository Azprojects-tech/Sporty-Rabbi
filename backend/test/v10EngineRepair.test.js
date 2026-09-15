import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreDistribution, nextGoalFromRates, remainingForecast, finalScoreFromProviderFixture, observedNumber } from '../../shared/forecastMath.js';
import { evaluateForecasts } from '../../shared/forecastEvaluation.js';
import { buildPredictionCore } from '../src/services/predictionEngineV10.js';
import { analyzeV9 } from '../src/services/agent47Service.js';
import { calculateNextGoalProbability } from '../src/services/liveAnalyticsService.js';
import { evaluateValue } from '../src/services/valueEngine.js';
import { settleMarketPrediction, buildPredictionLedgerDocument } from '../../shared/predictionLedger.js';

const close = (a,b) => assert.ok(Math.abs(a-b)<1e-10, `${a} != ${b}`);
const base = { home:'Home', away:'Away', status:'NS', leagueId:39, season:2026,
  homeGoalsAvgFor:1.9, homeGoalsAvgAgainst:.9, awayGoalsAvgFor:1.1, awayGoalsAvgAgainst:1.7,
  homeForm:'W-W-D-W-W', awayForm:'L-D-W-L-D', homeSampleSize:8, awaySampleSize:8 };

test('every score distribution has coherent 1X2 and complementary ordered totals', () => {
  for (const h of [0,.08,.7,1.5,4.5,20]) for (const a of [0,.08,.9,2,4.5,20]) {
    const p=scoreDistribution(h,a).marketProbabilities;
    close(p.home_win+p.draw+p.away_win,1);
    let prior=1;
    for(const line of ['05','15','25','35','45']) {
      close(p['over'+line]+p['under'+line],1);
      assert.ok(p['over'+line]<=prior+1e-12); prior=p['over'+line];
    }
  }
});
test('Dixon-Coles adjustment is used for over 0.5 and BTTS as well as 1X2', () => {
  const h=1.1,a=.9,rho=-.08;
  const p=scoreDistribution(h,a,{rho}).marketProbabilities;
  close(p.over05,1-Math.exp(-h-a)*(1-h*a*rho));
  close(p.btts,(1-Math.exp(-h))*(1-Math.exp(-a))-Math.exp(-h-a)*h*a*rho);
});
test('live BTTS at 0-0 requires both teams to score', () => {
  const f=remainingForecast({status:'2H',matchMinutes:60,score:'0-0'},3,3);
  close(f.marketProbabilities.btts,(1-Math.exp(-1))**2);
  assert.ok(f.marketProbabilities.btts < f.marketProbabilities.over05);
});
test('live BTTS at 1-0 requires only the away team; completed BTTS is not offered again', () => {
  const f=remainingForecast({status:'2H',matchMinutes:60,score:'1-0'},3,3);
  close(f.marketProbabilities.btts,1-Math.exp(-f.remainingLambda.away));
  const a=analyzeV9({...base,status:'2H',matchMinutes:60,score:'1-1'});
  close(a.poisson.marketProbabilities.btts,1);
  assert.ok(!a.recommendations.some(r=>r.marketKey==='btts'));
});
test('competing next-goal outcomes include no further goal and sum to one', () => {
  for (const h of [0,.1,1,4]) for(const a of [0,.2,2,4]) {
    const p=nextGoalFromRates(h,a); close(p.home+p.away+p.none,1);
    close(p.any,1-p.none);
  }
  assert.deepEqual(nextGoalFromRates(0,0),{home:0,away:0,none:1,any:0});
});
test('live service and engine use exactly the same remaining rates', () => {
  const m={...base,status:'2H',matchMinutes:72,score:'1-0',homeCards:{red:1}};
  const analysis=analyzeV9(m), live=calculateNextGoalProbability({...m,analysis});
  close(live.nextGoal.home.probability01,analysis.poisson.marketProbabilities.next_goal_home);
  close(live.nextGoal.away.probability01,analysis.poisson.marketProbabilities.next_goal_away);
  close(live.nextGoal.none.probability01,analysis.poisson.marketProbabilities.no_more_goal);
});
test('recommendations and win calls retain the selected market probability without bonuses', () => {
  let winCalls=0;
  for(const m of [base,{...base,status:'2H',matchMinutes:65,score:'0-0'},
    {...base,homeGoalsAvgFor:2.6,homeGoalsAvgAgainst:.6,awayGoalsAvgFor:.7,awayGoalsAvgAgainst:2.2}]) {
    const a=analyzeV9(m);
    for(const r of a.recommendations.filter(r=>r.marketKey)) {
      close(r.probability01,a.poisson.marketProbabilities[r.marketKey]);
      close(r.modelProbability,r.probability01*100);
    }
    if(a.winCall?.outcome==='HOME') { close(a.winCall.modelProbability,a.poisson.marketProbabilities.home_win*100); winCalls++; }
    if(a.winCall?.outcome==='AWAY') { close(a.winCall.modelProbability,a.poisson.marketProbabilities.away_win*100); winCalls++; }
  }
  assert.ok(winCalls>0,'The regression must exercise an actual directional win call.');
});
test('half-time has 45 regulation minutes; extra time and unknown stoppage time do not invent them', () => {
  assert.equal(remainingForecast({status:'HT',matchMinutes:48,score:'0-0'},1,1).minutesRemaining,45);
  for(const status of ['ET','BT','P','AET','PEN','FT']) assert.equal(remainingForecast({status,matchMinutes:100,score:'0-0'},1,1).available,false);
  for(const minute of [null,90,94]) assert.equal(remainingForecast({status:'2H',matchMinutes:minute,score:'0-0'},1,1).available,false);
  const a=analyzeV9({...base,status:'ET',matchMinutes:100,score:'1-1'});
  assert.deepEqual(a.recommendations,[]);
});
test('missing and invalid observed numbers remain unavailable instead of becoming zero', () => {
  for(const v of [null,undefined,'',' ',false,true,[],{},NaN,Infinity]) assert.equal(observedNumber(v),null);
  assert.equal(observedNumber(0),0);
  assert.equal(scoreDistribution(-1,1),null);
  assert.equal(scoreDistribution(1,1,{rho:NaN}),null);
});
test('live observed xG does not substitute for missing historical per-game xG', () => {
  const a=buildPredictionCore(base,1.35);
  const b=buildPredictionCore({...base,xg:{home:0,away:0},homeXgAvg:null,homeXgaAvg:null,awayXgAvg:null,awayXgaAvg:null},1.35);
  close(a.poisson.homeLambda,b.poisson.homeLambda);
  assert.equal(b.modelBasis,'GOALS_RATE');
  for(const invalid of [false,-1,' ']) assert.equal(buildPredictionCore({...base,homeGoalsAvgFor:invalid},1.35).coreReady,false);
});
test('settlement rejects null scores and uses only regulation scores for extra-time fixtures', () => {
  const raw={fixture:{status:{short:'FT'}},score:{fulltime:{home:null,away:null}},goals:{home:2,away:1}};
  assert.deepEqual(finalScoreFromProviderFixture(raw),{home:2,away:1,status:'FT'});
  raw.fixture.status.short='AET'; assert.equal(finalScoreFromProviderFixture(raw),null);
  raw.score.fulltime={home:1,away:1}; assert.deepEqual(finalScoreFromProviderFixture(raw),{home:1,away:1,status:'AET'});
  for(const invalid of [null,false,'',-1,1.5]) {
    raw.score.fulltime.home=invalid; assert.equal(finalScoreFromProviderFixture(raw),null);
  }
});
test('minimum odds round upward so the advertised price passes its own EV gate', () => {
  const missing=evaluateValue({calibratedProbability:.512});
  assert.equal(missing.minimumAcceptableOdds,2.06);
  assert.equal(evaluateValue({calibratedProbability:.512,offeredOdds:2.05}).decision,'NO_BET');
  assert.equal(evaluateValue({calibratedProbability:.512,offeredOdds:2.06}).decision,'BET');
});
test('ledger settlement also rejects missing scores, and new snapshots retain original model inputs', () => {
  for(const v of [null,undefined,'',false,-1,1.5]) assert.equal(settleMarketPrediction('under25',v,0),null);
  const analysis=analyzeV9(base), doc=buildPredictionLedgerDocument({...base,id:1,analysis});
  assert.equal(doc.forecastInputs.homeGoalsAvgFor,1.9);
  assert.equal(doc.modelState.homeLambda,analysis.poisson.homeLambda);
  assert.deepEqual(doc.modelState.marketProbabilities,analysis.poisson.marketProbabilities);
});
test('70 percent forecasts winning 70 of 100 are not halted by a fixed log-loss cutoff', () => {
  const r=evaluateForecasts(Array.from({length:100},(_,i)=>({modelProbability:70,result:i<70?'won':'lost'})));
  assert.equal(r.calibrationGap,0); assert.equal(r.brierScore,.21);
  assert.equal(r.halt,false); assert.equal(r.calibrationStatus,'RECORDED');
  assert.equal(evaluateForecasts([{modelProbability:null,result:'lost'}]),null);
});
