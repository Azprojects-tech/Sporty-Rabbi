import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCornersShadow } from '../../shared/cornersShadowEvaluation.js';

test('corners shadow evidence gate stays collecting on a small sample',()=>{
  const docs=Array.from({length:20},(_,i)=>({
    result:'settled',totalCorners:i%2?10:8,expectedTotal:9.8,lines:{corners_over85:60,corners_over95:48,corners_over105:36},
    challenger:{status:'AVAILABLE',expectedTotal:9.1,lines:{corners_over85:58,corners_over95:45,corners_over105:32}},
  }));
  const r=evaluateCornersShadow(docs);
  assert.equal(r.status,'COLLECTING_SHADOW_RESULTS');
  assert.equal(r.automaticPromotion,false);
  assert.equal(r.fixtures,20);
});

test('corners shadow evidence pass requires both lower MAE and lower Brier',()=>{
  const docs=Array.from({length:220},(_,i)=>{
    const total=i%2?10:8;
    return {result:'settled',totalCorners:total,expectedTotal:11.5,
      lines:{corners_over85:85,corners_over95:75,corners_over105:65},
      challenger:{status:'AVAILABLE',expectedTotal:9,
        lines:{corners_over85:50,corners_over95:45,corners_over105:35}}};
  });
  const r=evaluateCornersShadow(docs);
  assert.equal(r.status,'EVIDENCE_PASS');
  assert.ok(r.challenger.mae<r.current.mae);
  assert.ok(r.challenger.brier<r.current.brier);
});
