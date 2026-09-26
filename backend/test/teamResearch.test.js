import test from 'node:test';
import assert from 'node:assert/strict';
import {researchTeam,researchLeague} from '../../shared/teamResearch.js';
const fixtures=[
 {status:'FT',leagueId:1,homeTeamId:10,awayTeamId:11,homeGoals:3,awayGoals:1,homeCorners:6,awayCorners:4},
 {status:'FT',leagueId:1,homeTeamId:12,awayTeamId:10,homeGoals:0,awayGoals:2},
 {status:'NS',leagueId:1,homeTeamId:10,awayTeamId:13,homeGoals:5,awayGoals:0},
 {status:'FT',leagueId:1,homeTeamId:10,awayTeamId:14,homeGoals:null,awayGoals:0},
];
test('research uses completed observed fixtures only',()=>{
 const x=researchTeam(fixtures,10,{minimumSample:2});
 assert.equal(x.sampleSize,2);assert.equal(x.winRate,1);assert.equal(x.over25Rate,.5);
 assert.equal(x.cornersSample,1);assert.equal(x.over85CornersRate,1);
 assert.equal(researchLeague(fixtures,1,{minimumSample:2}).sampleSize,2);
});
test('research never invents evidence when sample missing',()=>{
 const x=researchTeam([],10);
 assert.equal(x.winRate,null);assert.equal(x.sufficientSample,false);
});
