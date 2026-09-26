import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { detectCompetitionContext } from '../../shared/competitionModelProfile.js';
import { getCompetitionRiskPolicy } from '../../shared/competitionRiskPolicy.js';
import { combinationProbabilityFloor, eligibleTicketCandidates, chooseCombination } from '../src/services/ticketSelectionService.js';
const now=Date.parse('2026-09-14T12:00:00Z');
const match=(id=1,p=.84,price=1.5)=>({id,home:'Home '+id,away:'Away '+id,status:'NS',kickoffUTC:'2026-09-14T18:00:00Z',
  homeTeamId:id*2,awayTeamId:id*2+1,oddsSnapshot:{status:'AVAILABLE',source:'API_FOOTBALL',fixtureId:id,kind:'PRE_MATCH',period:'REGULATION',
    bookmaker:{id:8,name:'Book'},providerUpdatedAt:'2026-09-14T11:00:00Z',expiresAt:'2026-09-14T15:00:00Z',odds:{over15:price}},
  analysis:{recommendations:[{type:'GOALS_ONLY',selection:'Over 1.5 Goals',marketKey:'over15',probability01:p,modelProbability:p*100,confidence:99,decisionState:'BET',value:{decision:'BET'}}]}});
test('51.2 percent is an exact rejection boundary, never a boosted probability',()=>{
  assert.equal(combinationProbabilityFloor([.84,.84,.832]),.512);
  assert.ok(combinationProbabilityFloor([.84,.84,.832-1e-9])<.512);
  assert.equal(combinationProbabilityFloor([.8,.8,.8]),.4);
  assert.equal(combinationProbabilityFloor([.8,.8]),.6);
});
test('candidate eligibility uses selected probability and enforces both price and decision',()=>{
  assert.equal(eligibleTicketCandidates([match()],now)[0].confidence,84);
  for(const state of ['NO_BET','NEEDS_PRICE','WATCH_LIVE',undefined]) {
    const m=match();m.analysis.recommendations[0].decisionState=state;
    assert.equal(eligibleTicketCandidates([m],now).length,0);
  }
  const m=match();m.analysis.recommendations[0].value.decision='NO_BET';
  assert.equal(eligibleTicketCandidates([m],now).length,0);
  assert.equal(eligibleTicketCandidates([match(1,.84,1.1)],now).length,0);
});
test('stale, missing, wrong-fixture, live and kicked-off prices cannot enter tickets',()=>{
  for(const mutate of [m=>m.oddsSnapshot=null,m=>m.oddsSnapshot.fixtureId=9,m=>m.status='2H',
    m=>m.kickoffUTC='2026-09-14T11:00:00Z',m=>m.oddsSnapshot.expiresAt='2026-09-14T11:59:00Z']) {
    const m=match();mutate(m);assert.equal(eligibleTicketCandidates([m],now).length,0);
  }
});
test('a treble needs the joint floor and a price that meets the EV floor',()=>{
  const candidates=eligibleTicketCandidates([match(1),match(2),match(3)],now);
  const t=chooseCombination(candidates,3);
  assert.equal(t.jointProbabilityLowerBound,.52);
  assert.equal(t.combinedOdds,3.375);
  assert.equal(chooseCombination(candidates.map(c=>({...c,probability01:.8})),3),null);
  assert.equal(chooseCombination(candidates.map(c=>({...c,odds:1.1})),3),null);
});
test('tickets reject fixture reuse, team reuse and mixing bookmaker prices',()=>{
  const c=eligibleTicketCandidates([match(1),match(2)],now);
  assert.equal(chooseCombination([c[0],c[0]],2),null);
  assert.equal(chooseCombination([c[0],{...c[1],homeTeamId:c[0].homeTeamId}],2),null);
  assert.equal(chooseCombination([c[0],{...c[1],bookmaker:{id:9}}],2),null);
  assert.equal(chooseCombination(c,2,new Set(['1'])),null);
});
test('the real server slip builder applies the floor in every mode and stays within its allocation cap',()=>{
  const source=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
  const section=(start,end)=>{
    const a=source.indexOf(start),b=source.indexOf(end,a);
    assert.ok(a>=0 && b>a); return source.slice(a,b);
  };
  const matches=Array.from({length:8},(_,i)=>({...match(i+1,i<3?.9:.84),leagueId:39,league:'Premier League',matchType:'League'}));
  const store={matches};
  const context=vm.createContext({BANKROLL:250000,calibrationStore:store,MIN_COMBINED_PROBABILITY:.512,
    eligibleTicketCandidates:ms=>eligibleTicketCandidates(ms,now),chooseCombination,detectCompetitionContext,getCompetitionRiskPolicy,
    withCorrectedChances:a=>a, getPrematchOddsStatus:()=>({enabled:true})});
  vm.runInContext(section('const SLIP_MODES =','const postMatchCalibrationStore =')+
    section('function applyModeAllocation(','function oddsForSelection(')+
    section('function generateBetSlips(','// ─── REST API ENDPOINTS'),context);
  for(const mode of ['safe','balanced','aggressive']) {
    const data=vm.runInContext(`generateBetSlips(250000,'${mode}')`,context);
    assert.equal(data.pool,8);assert.equal(data.tier1.length,3);
    assert.ok(data.tier2 && data.tier3);
    assert.ok(data.summary.totalStake<=250000*.60);
    for(const ticket of [data.tier2,data.tier3]) assert.ok(ticket.jointProbabilityLowerBound>=.512);
    const ids=[...data.tier1,...data.tier2.legs,...data.tier3.legs].map(l=>l.fixtureId);
    assert.equal(new Set(ids).size,ids.length);
  }
  store.matches=[match(1,.84,1.01)];
  const empty=vm.runInContext('generateBetSlips(250000)',context);
  assert.equal(empty.pool,0);assert.equal(empty.summary.totalStake,0);
});
