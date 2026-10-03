import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLiveHazardEvidence } from '../../shared/liveHazard.js';

const base={
  minute:30,
  baseHomeRate:1.6,
  baseAwayRate:1.2,
  homeRemaining:1.0,
  awayRemaining:.75,
};

test('live xG is the primary evidence source and moves remaining rates conservatively',()=>{
  const hot=applyLiveHazardEvidence({...base,match:{xg:{home:1.4,away:.8}}});
  assert.equal(hot.source,'XG');
  assert.ok(hot.adjustedRemainingLambda.home>base.homeRemaining);
  assert.ok(hot.homeMultiplier<=1.30);
  assert.ok(hot.awayMultiplier>=.75);
});

test('zero xG is observed evidence, not missing evidence',()=>{
  const quiet=applyLiveHazardEvidence({...base,match:{xg:{home:0,away:0}}});
  assert.equal(quiet.source,'XG');
  assert.ok(quiet.adjustedRemainingLambda.home<base.homeRemaining);
  assert.ok(quiet.adjustedRemainingLambda.away<base.awayRemaining);
});

test('shots and SOT are the fallback when xG is unavailable and shot priors exist',()=>{
  const out=applyLiveHazardEvidence({...base,match:{
    homeShotsPerGame:13,awayShotsPerGame:10,
    totalShots:{home:9,away:5},shots:{home:4,away:1},
  }});
  assert.equal(out.source,'SHOTS_SOT');
  assert.notEqual(out.adjustedRemainingLambda.home,base.homeRemaining);
});

test('corners alone never alter goal hazard',()=>{
  const out=applyLiveHazardEvidence({...base,match:{corners:{home:8,away:1}}});
  assert.equal(out.source,'NONE');
  assert.equal(out.adjustedRemainingLambda.home,base.homeRemaining);
  assert.equal(out.adjustedRemainingLambda.away,base.awayRemaining);
});

test('xG takes precedence over shots to avoid double counting live pressure',()=>{
  const out=applyLiveHazardEvidence({...base,match:{
    xg:{home:1.2,away:.6},
    homeShotsPerGame:13,awayShotsPerGame:10,
    totalShots:{home:12,away:8},shots:{home:6,away:3},
  }});
  assert.equal(out.source,'XG');
});
