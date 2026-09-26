import test from 'node:test';
import assert from 'node:assert/strict';
import {deskCard} from '../../shared/dailyDesk.js';
import {discoverOpportunities} from '../../shared/opportunityDiscovery.js';
test('corners market is represented on percentage scale and can be discovered',()=>{
 const cards=[1,2,3].map(i=>({id:i,home:'Home'+i,away:'Away'+i,homeTeamId:i*2,awayTeamId:i*2+1,league:'Test',status:'NS',kickoffUTC:new Date(Date.now()+86400000).toISOString(),markets:[{marketKey:'corners_over85',selection:'Over 8.5 corners',probability:70}]}));
 const found=discoverOpportunities(cards,{markets:[{key:'corners_over85',title:'Corners cluster',minimum:.65,minimumLegs:3}]});
 assert.equal(found.length,1);assert.equal(found[0].legs.length,3);assert.ok(found[0].combinedProbability>30);
});