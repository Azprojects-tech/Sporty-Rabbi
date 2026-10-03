import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOP_LEAGUE_IDS,buildTopLeaguePicks,buildPortfolioTiers,buildFirstHalfGoalWatch,buildCornersWatch
} from '../../shared/morningSelections.js';

const ko=new Date(Date.now()+6*3600000).toISOString();
function card(id,{leagueId=999,odds=1.5,p=90,line85=70}={}){
  return {id,home:'H'+id,away:'A'+id,homeTeamId:id*2,awayTeamId:id*2+1,league:'League '+leagueId,leagueId,
    kickoffUTC:ko,status:'NS',bookmaker:{id:1,name:'Book'},quoteExpiresAt:new Date(Date.now()+3600000).toISOString(),
    best:{marketKey:'over15',selection:'Over 1.5 goals',decision:'BET',odds,probability:p,minimumOdds:1.2,expectedValue:p/100*odds-1},
    markets:[{marketKey:'over15',selection:'Over 1.5 goals',probability:p,decision:'BET',odds}],
    corners:{expectedTotal:10.2,lines:{corners_over85:line85,corners_over95:line85-8,corners_over105:line85-16},source:'test'}};
}

test('top-league section is an extraction and does not exclude ordinary leagues',()=>{
  const cards=[card(1,{leagueId:39,p:82}),card(2,{leagueId:140,p:79}),card(3,{leagueId:999,p:95})];
  const top=buildTopLeaguePicks(cards);
  assert.equal(top.length,2);
  assert.ok(top.every(c=>TOP_LEAGUE_IDS.has(c.leagueId)));
});

test('four-tier portfolio never reuses fixtures or teams and does not force missing tiers',()=>{
  const cards=[
    card(1,{odds:1.5,p:95}),
    card(2,{odds:1.4,p:90}),card(3,{odds:1.45,p:89}),
    card(4,{odds:1.7,p:90}),card(5,{odds:1.8,p:88}),
    card(6,{odds:1.7,p:92}),card(7,{odds:1.75,p:91}),card(8,{odds:1.7,p:90}),
  ];
  const p=buildPortfolioTiers(cards);
  assert.ok(p.tier1.available&&p.tier2.available&&p.tier3.available&&p.tier4.available);
  const legs=[...p.tier1.legs,...p.tier2.legs,...p.tier3.legs,...p.tier4.legs];
  assert.equal(new Set(legs.map(l=>String(l.fixtureId))).size,legs.length);
  const teams=legs.flatMap(l=>[l.homeTeamId,l.awayTeamId]).map(String);
  assert.equal(new Set(teams).size,teams.length);
  assert.ok(p.tier4.odds>=4.5&&p.tier4.odds<=5.75);
});

test('1H goal watch uses season minute-bucket rates as a separate research probability',()=>{
  const match={id:1,home:'A',away:'B',league:'Test',kickoffUTC:ko,
    analysis:{predictionCore:{poisson:{marketProbabilities:{over15:.82}}}}};
  const home={stats:{played:10,firstHalfGoalsForPerGame:.9,firstHalfGoalsAgainstPerGame:.5}};
  const away={stats:{played:12,firstHalfGoalsForPerGame:.7,firstHalfGoalsAgainstPerGame:.8}};
  const x=buildFirstHalfGoalWatch(match,home,away);
  assert.ok(x);
  assert.equal(x.basis,'RESEARCH_1H_SEASON_MINUTE_BUCKETS');
  assert.ok(x.probability>=68);
  assert.equal(x.regulationOver15,82);
});

test('1H watch refuses thin samples and corners chooses the highest supported useful line',()=>{
  assert.equal(buildFirstHalfGoalWatch({},{stats:{played:2}},{stats:{played:10}}),null);
  const c=buildCornersWatch([card(1,{line85:80})]);
  assert.equal(c.length,1);
  assert.equal(c[0].line,10.5);
  assert.equal(c[0].probability,64);
});
