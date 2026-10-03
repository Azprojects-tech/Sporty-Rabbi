import test from 'node:test';
import assert from 'node:assert/strict';
import {dueWatchStages,watchMarketKey,watchMessage} from '../src/services/watchService.js';

const kickoff=Date.parse('2026-10-03T12:00:00Z');
const base={
 fixtureId:'1',home:'Alpha',away:'Beta',league:'Test League',country:'GB',
 kickoffUTC:new Date(kickoff).toISOString(),market:'Over 2.5 goals',marketKey:'over25',
 modelProbability:68,active:true,kickoffAlertAt:null,minute5AlertAt:null,minute10AlertAt:null,
};

test('watched goal markets map to the one-engine market keys',()=>{
 assert.equal(watchMarketKey('Over 1.5 goals'),'over15');
 assert.equal(watchMarketKey('Over 2.5 goals'),'over25');
 assert.equal(watchMarketKey('Over 3.5 goals'),'over35');
 assert.equal(watchMarketKey('Over 8.5 corners'),null);
});

test('watch waits for a real live minute before five and ten minute checks',()=>{
 assert.deepEqual(dueWatchStages(base,kickoff),['kickoff']);
 const started={...base,kickoffAlertAt:new Date(kickoff).toISOString()};
 assert.deepEqual(dueWatchStages(started,kickoff+5*60000,null),[]);
 assert.deepEqual(dueWatchStages(started,kickoff+5*60000,{minute:5}),['minute5']);
 const five={...started,minute5AlertAt:new Date(kickoff+5*60000).toISOString()};
 assert.deepEqual(dueWatchStages(five,kickoff+9*60000,{minute:9}),[]);
 assert.deepEqual(dueWatchStages(five,kickoff+10*60000,{minute:10}),['minute10']);
 assert.deepEqual(dueWatchStages({...five,minute10AlertAt:new Date(kickoff+10*60000).toISOString()},kickoff+11*60000,{minute:11}),[]);
});

test('five-minute Telegram message shows original and current exact-market probability',()=>{
 const item={...base,kickoffAlertAt:new Date(kickoff).toISOString()};
 const msg=watchMessage(item,'minute5',{minute:5,homeGoals:0,awayGoals:0,probabilities:{over25:.61}});
 assert.match(msg,/5′ MARKET CHECK/);
 assert.match(msg,/Pre-match model: 68\.0%/);
 assert.match(msg,/Current live estimate: 61\.0%/);
 assert.match(msg,/needs 3 more goals/);
 assert.match(msg,/exact line and current price/);
});

test('goal already scored reduces the goals still needed on the watched line',()=>{
 const item={...base,kickoffAlertAt:new Date(kickoff).toISOString()};
 const msg=watchMessage(item,'minute5',{minute:5,homeGoals:1,awayGoals:0,probabilities:{over25:.74}});
 assert.match(msg,/1-0/);
 assert.match(msg,/needs 2 more goals/);
});
