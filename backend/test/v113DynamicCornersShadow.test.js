import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DYNAMIC_CORNERS_VERSION,
  buildDynamicCornersModel,
  predictDynamicCorners,
} from '../../shared/dynamicCornersModel.js';

function rows(){
  const out=[]; const teams=['Alpha','Bravo','Charlie','Delta']; const start=Date.UTC(2026,0,1);
  for(let i=0;i<120;i++){
    const home=teams[i%4],away=teams[(i+1+(i%2))%4];
    if(home===away)continue;
    const strength={Alpha:8,Bravo:2,Charlie:5,Delta:5};
    out.push({date:start+i*86400000,home,away,hc:Math.max(0,Math.round((strength[home]+4)/2)),ac:Math.max(0,Math.round(strength[away]/2))});
  }
  return out;
}

test('dynamic corners learns team-specific expected totals and line probabilities',()=>{
  const model=buildDynamicCornersModel(rows());
  assert.ok(model);
  const p=predictDynamicCorners(model,{home:'Alpha',away:'Bravo'});
  assert.equal(p.version,DYNAMIC_CORNERS_VERSION);
  assert.equal(p.status,'AVAILABLE');
  assert.ok(p.expectedHome>p.expectedAway);
  assert.ok(Number.isFinite(p.lines.corners_over85));
});

test('dynamic corners refuses unseen teams instead of fabricating a number',()=>{
  const model=buildDynamicCornersModel(rows());
  const p=predictDynamicCorners(model,{home:'Unknown',away:'Bravo'});
  assert.equal(p.status,'UNAVAILABLE');
  assert.equal(p.reason,'TEAM_HISTORY_TOO_THIN');
});
