import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseFdCsv, fdSeasonCode, fdCodeForMatch, matchTeamName, buildLeagueCornersModel, expectedCorners,
  overProbability, predictCorners, settleCornersLines, cornersMarketKey,
} from '../../shared/cornersModel.js';
import { createCornersService, cornersDocsForCalibration } from '../src/services/cornersService.js';
import { extractSettledPicks, marketFamily } from '../../shared/pickCalibration.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 26, 9);
const fmt = (t) => { const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`; };
// A small league: "Corner FC" wins lots of corners at home, "Quiet Town" few.
function leagueCsv({ games = 80 } = {}) {
  const teams = ['Corner FC', 'Quiet Town', 'Middle United', 'Bristol Rvs', 'Man United', 'Sheffield Weds'];
  const lines = ['Div,Date,Time,HomeTeam,AwayTeam,FTHG,FTAG,HC,AC'];
  for (let i = 0; i < games; i++) {
    const h = teams[i % teams.length];
    const a = teams[(i + 1 + Math.floor(i / teams.length)) % teams.length];
    if (h === a) continue;
    const hc = h === 'Corner FC' ? 9 : h === 'Quiet Town' ? 2 : 5;
    const ac = a === 'Corner FC' ? 6 : a === 'Quiet Town' ? 1 : 4;
    lines.push(`E2,${fmt(NOW - (games - i) * 3 * DAY)},15:00,${h},${a},1,1,${hc},${ac}`);
  }
  return lines.join('\n');
}

test('results file parsing keeps only rows with both corner counts', () => {
  const rows = parseFdCsv('Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HC,AC\nE0,20/09/2026,A,B,1,0,7,3\nE0,21/09/26,C,D,0,0,,2\nE0,bad,E,F,1,1,4,4');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].home, rows[0].hc, rows[0].ac, rows[0].date], ['A', 7, 3, Date.UTC(2026, 8, 20)]);
  assert.deepEqual(parseFdCsv('Div,Date,HomeTeam,AwayTeam\nE0,20/09/2026,A,B'), []); // no corners columns
});

test('season codes and league coverage', () => {
  assert.equal(fdSeasonCode(new Date(NOW)), '2627');
  assert.equal(fdSeasonCode(new Date(NOW), -1), '2526');
  assert.equal(fdSeasonCode(new Date(Date.UTC(2027, 2, 1))), '2627');
  assert.equal(fdCodeForMatch({ leagueId: 41, leagueCountry: 'England' }), 'E2');
  assert.equal(fdCodeForMatch({ leagueId: 39, leagueCountry: 'Faroe-Islands' }), null); // same id, wrong country
  assert.equal(fdCodeForMatch({ leagueId: 9999, leagueCountry: 'Scotland', league: 'Premiership' }), 'SC0');
  assert.equal(fdCodeForMatch({ leagueId: 9999, leagueCountry: 'Kenya', league: 'Premier League' }), null);
});

test('team names are matched to the results file carefully', () => {
  const names = ['Man United', 'Man City', 'Bristol Rvs', 'Bristol City', 'Dundee', 'Dundee United', 'Sheffield Weds', 'Buyuksehyr', 'St Etienne'];
  assert.equal(matchTeamName('Manchester United', names), 'Man United');
  assert.equal(matchTeamName('Bristol Rovers', names), 'Bristol Rvs');
  assert.equal(matchTeamName('Dundee Utd', names), 'Dundee United');
  assert.equal(matchTeamName('Sheffield Wednesday', names), 'Sheffield Weds');
  assert.equal(matchTeamName('Başakşehir', names), 'Buyuksehyr');
  assert.equal(matchTeamName('Saint Etienne', names), 'St Etienne');
  assert.equal(matchTeamName('Real Sociedad II', names), null);
  assert.equal(matchTeamName('Real Sociedad II', ['Sociedad', 'Sociedad B']), 'Sociedad B');
  assert.equal(matchTeamName('Celta de Vigo II', ['Celta', 'Celta B']), 'Celta B');
  assert.equal(matchTeamName('Celta de Vigo II', ['Celta']), null); // reserve never mapped to the first team
});

test('model: recent-weighted team averages shrunk to the league, expected total from both sides', () => {
  const model = buildLeagueCornersModel(parseFdCsv(leagueCsv()), { now: NOW });
  assert.ok(model.ratings['Corner FC'].homeFor > model.ratings['Quiet Town'].homeFor);
  assert.ok(model.ratings['Corner FC'].homeFor < 9, 'shrunk toward the league average');
  const busy = expectedCorners(model, 'Corner FC', 'Middle United').total;
  const quiet = expectedCorners(model, 'Quiet Town', 'Middle United').total;
  assert.ok(busy > quiet + 3);
  assert.equal(buildLeagueCornersModel(parseFdCsv(leagueCsv({ games: 20 })), { now: NOW }), null); // too few games
});

test('over-line chance: Poisson and negative binomial', () => {
  // Poisson(10): P(X > 9.5) = 1 - P(X <= 9) = 0.5421
  assert.equal(+overProbability(10, 9.5).toFixed(4), 0.5421);
  // Extra spread pulls a line above the mean toward 50%… and widens tails.
  assert.ok(overProbability(8, 10.5, 10) > overProbability(8, 10.5));
  assert.ok(overProbability(10, 8.5) > overProbability(10, 9.5) && overProbability(10, 9.5) > overProbability(10, 10.5));
  assert.equal(overProbability(0, 9.5), null);
});

test('prediction per fixture, main line nearest an even chance, "No prediction" otherwise', () => {
  const models = { E2: buildLeagueCornersModel(parseFdCsv(leagueCsv()), { now: NOW }) };
  const p = predictCorners(models, { leagueId: 41, leagueCountry: 'England', home: 'Manchester United', away: 'Bristol Rovers' });
  assert.equal(p.status, 'AVAILABLE');
  assert.ok([8.5, 9.5, 10.5].includes(p.line));
  assert.equal(p.stated, p.lines[cornersMarketKey(p.line)]);
  for (const l of [8.5, 9.5, 10.5]) assert.ok(Math.abs(p.lines[cornersMarketKey(p.line)] - 50) <= Math.abs(p.lines[cornersMarketKey(l)] - 50));
  assert.equal(predictCorners(models, { leagueId: 1, home: 'X', away: 'Y' }).reason, 'LEAGUE_NOT_COVERED');
  assert.equal(predictCorners(models, { leagueId: 42, leagueCountry: 'England', home: 'A', away: 'B' }).reason, 'LEAGUE_DATA_UNAVAILABLE');
  assert.equal(predictCorners(models, { leagueId: 41, leagueCountry: 'England', home: 'Nobody', away: 'Quiet Town' }).reason, 'TEAM_NOT_FOUND');
});

test('settlement per line', () => {
  assert.deepEqual(settleCornersLines({ corners_over85: 60, corners_over95: 50, corners_over105: 40 }, 10),
    { corners_over85: 'won', corners_over95: 'won', corners_over105: 'lost' });
});

function fakeDb() {
  const docs = new Map();
  const ref = (id) => ({
    create: async (v) => { if (docs.has(id)) { const e = new Error('exists'); e.code = 6; throw e; } docs.set(id, { ...v }); },
    update: async (u) => docs.set(id, { ...docs.get(id), ...u }),
  });
  return {
    docs,
    collection: () => ({
      doc: ref,
      where: (_f, _op, val) => ({ limit: () => ({ get: async () => {
        const hits = [...docs.entries()].filter(([, v]) => v.result === val);
        return { size: hits.length, docs: hits.map(([id, v]) => ({ data: () => v, ref: ref(id) })) };
      } }) }),
    }),
  };
}

test('service: downloads files, records one prediction per fixture, settles from the results file', async () => {
  let clock = NOW;
  let csv = leagueCsv();
  const fetched = [];
  const db = fakeDb();
  const svc = createCornersService({
    getDb: () => db, now: () => clock, log: {},
    fetchText: async (url) => { fetched.push(url); if (!url.endsWith('/E2.csv')) throw new Error('404'); return csv; },
  });
  await svc.refresh();
  assert.ok(fetched.some((u) => u.includes('/2627/E2.csv')) && fetched.some((u) => u.includes('/2526/E2.csv')));
  assert.equal(svc.status().leagues[0].code, 'E2');
  const fixture = { id: 555, leagueId: 41, leagueCountry: 'England', home: 'Corner FC', away: 'Quiet Town', status: 'NS', kickoffUTC: new Date(NOW + 6 * 3600000).toISOString() };
  assert.equal(await svc.recordPredictions([fixture, { ...fixture, id: 556, leagueId: 1 }]), 1);
  assert.equal(await svc.recordPredictions([fixture]), 0); // never recorded twice
  const saved = db.docs.get('corners_555');
  assert.equal(saved.result, 'pending');
  assert.equal(saved.fdHome, 'Corner FC');
  // Result appears in the file two days later.
  clock = NOW + 2 * DAY;
  csv += `\nE2,${fmt(NOW)},15:00,Corner FC,Quiet Town,2,0,8,3`;
  await svc.refresh();
  const r = await svc.settlePending();
  assert.equal(r.settled, 1);
  const settled = db.docs.get('corners_555');
  assert.equal(settled.totalCorners, 11);
  assert.equal(settled.results.corners_over105, 'won');
  // Settled corners feed the calibration layer as picks.
  const picks = extractSettledPicks(cornersDocsForCalibration([settled]));
  assert.equal(picks.length, 3);
  assert.equal(marketFamily('corners_over95'), 'corners');
});

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
test('corners are wired into the feed, a daily job and the card', () => {
  const server = read('../src/server.js');
  const view = read('../../frontend/src/components/SimpleView.jsx');
  const calib = read('../src/services/pickCalibrationService.js');
  assert.match(server, /corners: cornersForCard\(m\)/);
  assert.match(server, /cron\.schedule\('15 6 \* \* \*'[\s\S]{0,80}refreshCorners/);
  assert.match(server, /app\.get\('\/api\/corners\/status'/);
  assert.match(calib, /cornersDocsForCalibration/);
  assert.match(view, /corners\?\.status === 'AVAILABLE'/);
  assert.match(view, /No prediction/);
});
