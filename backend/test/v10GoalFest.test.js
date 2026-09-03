import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {calculateGoalFestSignal} from '../src/services/liveAnalyticsService.js';

const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');
const feed=fs.readFileSync(new URL('../../frontend/src/components/MatchFeed.jsx',import.meta.url),'utf8');
const panel=fs.readFileSync(new URL('../../frontend/src/components/DetailPanel.jsx',import.meta.url),'utf8');
const alerts=fs.readFileSync(new URL('../../frontend/src/components/AlertHistory.jsx',import.meta.url),'utf8');

test('Goal Fest fails closed without verified xG',()=>{
  const r=calculateGoalFestSignal({status:'1H',matchMinutes:30,score:'1-0',shots:{home:4,away:2},xg:{home:null,away:null}});
  assert.equal(r.active,false);assert.equal(r.status,'INSUFFICIENT_DATA');assert.equal(r.score,null);
});
test('Goal Fest waits until minute 12',()=>{
  const r=calculateGoalFestSignal({status:'1H',matchMinutes:8,score:'1-0',shots:{home:3,away:2},xg:{home:.8,away:.5}});
  assert.equal(r.active,false);assert.equal(r.status,'TOO_EARLY');
});
test('strong verified trajectory activates Goal Fest',()=>{
  const r=calculateGoalFestSignal({status:'1H',matchMinutes:35,score:'1-1',shots:{home:5,away:4},xg:{home:1.5,away:1.2}});
  assert.equal(r.active,true);assert.ok(r.score>=85);assert.equal(r.level,'HOT');assert.ok(r.projectedFinalGoals>3);
});
test('quiet match stays below threshold',()=>{
  const r=calculateGoalFestSignal({status:'2H',matchMinutes:60,score:'1-0',shots:{home:2,away:1},xg:{home:.7,away:.4}});
  assert.equal(r.active,false);assert.ok(r.score<70);
});
test('scanner is portal-active bounded and quota-aware',()=>{
  assert.match(server,/GOAL_FEST_SCAN_SECONDS/);assert.match(server,/GOAL_FEST_SCAN_LIMIT/);
  assert.match(server,/clients\.size===0/);assert.match(server,/shouldSkipApiCalls\(\)/);
  assert.match(server,/fetchFixtureStatistics\(match\.id\)/);assert.match(server,/type:'GOAL_FEST'/);
});
test('Goal Fest is visible in feed and detail',()=>{
  assert.match(feed,/GOAL FEST/);assert.match(feed,/match\?\.goalFest\?\.active/);
  assert.match(panel,/GOAL FEST/);assert.match(panel,/match\?\.goalFest\?\.active/);
});
test('alerts default to actionable and preserve audit views',()=>{
  assert.match(alerts,/useState\('actionable'\)/);assert.match(alerts,/30\*60\*1000/);
  assert.match(alerts,/Today/);assert.match(alerts,/History/);assert.match(alerts,/Goal Fest/);assert.match(alerts,/EXPIRED/);
});
