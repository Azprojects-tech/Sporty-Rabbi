import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverOpportunities} from '../../shared/opportunityDiscovery.js';
const now=Date.parse('2026-09-26T09:00:00Z');
const make=(id,p,market='over25')=>({id,home:'Home '+id,away:'Away '+id,homeTeamId:id*2,awayTeamId:id*2+1,league:id%2?'Bundesliga':'Premier League',status:'NS',kickoffUTC:'2026-09-26T16:00:00Z',markets:[{marketKey:market,selection:'Over 2.5',probability:p,odds:null}]});
test('surfaces five-leg goal cluster even when joint probability is low',()=>{
 const result=discoverOpportunities([79,76,74,72,70].map((p,i)=>make(i+1,p)),{now});
 const five=result.find(x=>x.marketKey==='over25'&&x.legs.length===5);
 assert.ok(five);assert.ok(five.combinedProbability<25);assert.equal(five.priceStatus,'PRICE_UNAVAILABLE');
});
test('does not invent probabilities or include kicked-off games',()=>{
 const data=[make(1,80),make(2,78),make(3,75),make(4,NaN)];
 data[2].kickoffUTC='2026-09-25T16:00:00Z';
 assert.equal(discoverOpportunities(data,{now}).length,0);
});
test('does not reuse teams across a combination',()=>{
 const data=[make(1,80),make(2,79),make(3,78)];
 data[1].homeTeamId=data[0].homeTeamId;
 assert.equal(discoverOpportunities(data,{now}).length,0);
});
