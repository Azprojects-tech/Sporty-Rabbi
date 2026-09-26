import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  extractSettledPicks, buildCalibrationMap, correctedChance, applyCurve, isotonic, fitCurve,
  fairMarketChance, minimumOddsWorthTaking, buildPriceCheck, withPriceChecks, OVERRATED_WARNING,
} from '../../shared/pickCalibration.js';
import {
  validateDoubleSlip, settleDoubleSlip, slipProfit, summarizePaperBets, betSettlementOdds,
} from '../../shared/betLogging.js';
import { createPlayedBetSettler, settleDoubleLegsFromFixture } from '../src/services/playedBetSettlementService.js';
import { createPickCalibrationService } from '../src/services/pickCalibrationService.js';
import { normalizePrematchOdds } from '../src/services/prematchOddsService.js';
import { ROUTE_POLICY } from '../src/middleware/security.js';

// Deterministic synthetic history: `n` picks at stated p, of which `rate` won.
function picksAt(marketKey, p, n, rate, extra = {}) {
  const wins = Math.round(n * rate);
  return Array.from({ length: n }, (_, i) => ({ marketKey, p, won: i < wins ? 1 : 0, leagueId: 39, international: false, ...extra }));
}
function ledgerDoc(i, marketKey, p, result, extra = {}) {
  return {
    matchId: 1000 + i, analysisVersion: 'V10.6C-Unified-Decisions', leagueId: 39, leagueCountry: 'England',
    predictedAt: `2026-09-01T0${i % 9}:00:00Z`, kickoffUTC: '2026-09-01T15:00:00Z',
    markets: [{ marketKey, modelProbability: p, result }], ...extra,
  };
}

// ── Calibration ────────────────────────────────────────────────────────────
test('isotonic fit never lets a higher stated chance map lower', () => {
  assert.deepEqual(isotonic([0.5, 0.7, 0.6, 0.8], [1, 1, 1, 1]).map((v) => +v.toFixed(2)), [0.5, 0.65, 0.65, 0.8]);
  const knots = fitCurve([...picksAt('btts', 62, 300, 0.60), ...picksAt('btts', 72, 300, 0.55), ...picksAt('btts', 82, 300, 0.70)]);
  for (let i = 1; i < knots.length; i++) assert.ok(knots[i].y >= knots[i - 1].y);
});

test('overrated market is corrected down toward what actually happened', () => {
  const map = buildCalibrationMap([
    ...picksAt('under25', 67, 600, 0.54),
    ...picksAt('under25', 77, 400, 0.62),
  ]);
  const c67 = correctedChance(map, 'under25', 67);
  assert.ok(c67 < 58 && c67 > 52, `got ${c67}`);
  assert.equal(map.markets.under25.overrated, true);
  assert.equal(map.markets.under25.statedAvg, 71);
  assert.equal(map.markets.under25.actualRate, 57.2);
});

test('well-calibrated market is left almost unchanged', () => {
  const map = buildCalibrationMap(picksAt('over15', 80, 1000, 0.79));
  assert.ok(Math.abs(correctedChance(map, 'over15', 80) - 79) < 0.6);
  assert.equal(map.markets.over15.overrated, false);
});

test('a thin band is shrunk toward the stated chance', () => {
  // 10 picks at 90% that all lost must not drag 90% to ~0.
  const knots = fitCurve([...picksAt('over25', 70, 500, 0.70), ...picksAt('over25', 90, 10, 0)]);
  const top = knots.at(-1);
  assert.ok(top.y > 60, `thin band must not collapse toward 0%, got ${top.y}`);
});

test('markets with too little history borrow their family, else stay unchanged', () => {
  const map = buildCalibrationMap([...picksAt('over25', 70, 400, 0.60), ...picksAt('over35', 70, 20, 0.5)]);
  assert.equal(map.markets.over35.basis, 'family');
  assert.ok(correctedChance(map, 'over35', 70) < 66);
  assert.equal(correctedChance(map, 'btts', 70), 70); // no btts history at all
  assert.equal(correctedChance(null, 'btts', 70), 70);
  assert.equal(correctedChance(map, 'btts', null), null);
});

test('league and internationals adjustments apply only with enough picks', () => {
  const map = buildCalibrationMap([
    ...picksAt('over15', 75, 2000, 0.75),
    ...picksAt('over15', 75, 400, 0.55, { leagueId: 5, international: true }),
  ]);
  assert.ok(map.leagues['5'].adjustment < -3);
  assert.ok(correctedChance(map, 'over15', 75, { leagueId: 5 }) < correctedChance(map, 'over15', 75, { leagueId: 39 }));
  // Unknown international competition falls back to the internationals adjustment.
  assert.ok(map.internationals.adjustment < 0);
  assert.ok(correctedChance(map, 'over15', 75, { leagueId: 999, leagueCountry: 'World' }) < correctedChance(map, 'over15', 75, { leagueId: 999 }));
});

test('applyCurve interpolates between bands and keeps the edge shift outside them', () => {
  const knots = [{ x: 60, y: 50 }, { x: 80, y: 60 }];
  assert.equal(applyCurve(knots, 70), 55);
  assert.equal(applyCurve(knots, 90), 70);
  assert.equal(applyCurve(knots, 50), 40);
});

test('ledger extraction: V10 only, no win-call rows, no after-kickoff or repeat predictions', () => {
  const docs = [
    ledgerDoc(1, 'btts', 70, 'won'),
    { ...ledgerDoc(2, 'btts', 70, 'lost'), matchId: 1001, predictedAt: '2026-09-01T09:30:00Z' }, // repeat of match 1001
    ledgerDoc(3, 'btts', 70, 'lost', { analysisVersion: null }),                              // legacy engine
    ledgerDoc(4, 'btts', 70, 'won', { predictedAt: '2026-09-01T16:00:00Z' }),                 // after kickoff
    ledgerDoc(5, 'home_win', 70, 'won', { markets: [{ marketKey: 'home_win', modelProbability: 70, result: 'won', source: 'WIN_CALL' }] }),
    ledgerDoc(6, 'over25', 65, 'pending'),
    ledgerDoc(7, 'over25', 65, 'lost', { leagueCountry: 'World' }),
  ];
  const picks = extractSettledPicks(docs);
  assert.deepEqual(picks.map((p) => [p.marketKey, p.won, p.international]), [['btts', 1, false], ['over25', 0, true]]);
});

// ── Margin removal and minimum odds ─────────────────────────────────────────
test('bookmaker margin is removed by normalising all outcomes', () => {
  const r = fairMarketChance({ over25: 1.80, under25: 2.00 }, 'under25');
  // implied 0.5556 + 0.5 = 1.0556 → under fair = 0.5 / 1.0556 = 47.4%
  assert.equal(r.fairChance, 47.4);
  assert.equal(r.margin, 5.6);
  const x = fairMarketChance({ homeWin: 2.0, draw: 3.4, awayWin: 3.8 }, 'home_win');
  assert.equal(x.fairChance, 47.3);
  assert.equal(fairMarketChance({ btts: 1.7 }, 'btts').fairChance, null); // one-sided price can't be de-margined
  assert.equal(fairMarketChance({ btts: 1.7, bttsNo: 2.1 }, 'btts').fairChance, 55.3);
});

test('minimum odds worth taking = 1.05 / corrected chance, 2 dp', () => {
  assert.equal(minimumOddsWorthTaking(60), 1.75);
  assert.equal(minimumOddsWorthTaking(54.4), 1.94);
  assert.equal(minimumOddsWorthTaking(null), null);
  assert.equal(minimumOddsWorthTaking(0), null);
});

test('price check: warning on historically overrated markets, minimum odds even without a market price', () => {
  const map = buildCalibrationMap([...picksAt('under25', 68, 800, 0.54), ...picksAt('over15', 80, 800, 0.79)]);
  map.validation={status:'APPROVED',version:'test'};
  const context={status:'NS',analysisVersion:'test',rawProbabilities:{under25:.68,over25:.32,over15:.80,under15:.2}};
  const noPrice = buildPriceCheck({ marketKey: 'under25', modelProbability: 68 }, { calibration: map, context });
  assert.equal(noPrice.noMarketPrice, true);
  assert.equal(noPrice.fairMarketChance, null);
  assert.equal(noPrice.minimumOdds, minimumOddsWorthTaking(noPrice.correctedChance));
  assert.equal(noPrice.warning, OVERRATED_WARNING);
  const snap = { status: 'AVAILABLE', bookmaker: { name: 'Bet365' }, odds: { over15: 1.25, under15: 3.9 } };
  const priced = buildPriceCheck({ marketKey: 'over15', modelProbability: 80 }, { calibration: map, oddsSnapshot: snap, context });
  assert.equal(priced.warning, null);
  assert.equal(priced.noMarketPrice, false);
  assert.equal(priced.bookmakerOdds, 1.25);
  assert.equal(priced.bookmaker, 'Bet365');
  assert.equal(priced.fairMarketChance, 75.7);
});

test('withPriceChecks adds data and never removes a pick', () => {
  const analysis = { oddsSnapshot: null, recommendations: [
    { marketKey: 'under25', modelProbability: 70, selection: 'Under 2.5' },
    { marketKey: null, selection: 'No bet' },
    { marketKey: 'next_goal_home', modelProbability: 60 },
  ] };
  const out = withPriceChecks(analysis, null);
  assert.equal(out.recommendations.length, 3);
  assert.equal(out.recommendations[0].priceCheck.correctedChance, null);
  assert.equal(out.recommendations[0].priceCheck.minimumOdds, 1.5); // falls back to stated chance
  assert.equal(out.recommendations[1].priceCheck, undefined);
  assert.equal(analysis.recommendations[0].priceCheck, undefined); // input untouched
});

test('odds feed keeps BTTS "No" so its margin can be removed', () => {
  const now = Date.parse('2026-09-26T08:00:00Z');
  const snap = normalizePrematchOdds({ response: [{ fixture: { id: 7 }, update: '2026-09-26T07:00:00Z', bookmakers: [{ id: 8, name: 'Bet365', bets: [
    { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.70' }, { value: 'No', odd: '2.10' }] },
  ] }] }] }, 7, { now });
  assert.equal(snap.odds.btts, 1.7);
  assert.equal(snap.odds.bttsNo, 2.1);
});

// ── Calibration service (periodic rebuild) ──────────────────────────────────
function fakeDb(docs) {
  const saved = {};
  const query = (offset = 0, lim = 1e9) => ({
    where: () => query(offset, lim), orderBy: () => query(offset, lim), limit: (l) => query(offset, l),
    startAfter: (last) => query(last.__i + 1, lim),
    get: async () => ({ docs: docs.slice(offset, offset + lim).map((d, j) => ({ data: () => d, __i: offset + j })) }),
  });
  return {
    saved,
    collection: (name) => name === 'predictions' ? query() : {
      doc: (id) => ({ get: async () => ({ exists: Boolean(saved[id]), data: () => saved[id] }), set: async (v) => { saved[id] = v; } }),
    },
  };
}

test('calibration service rebuilds from the ledger (paged), saves, and skips when fresh', async () => {
  const docs = Array.from({ length: 400 }, (_, i) => ledgerDoc(i, 'under25', 68, i % 100 < 54 ? 'won' : 'lost', { matchId: 5000 + i }));
  const db = fakeDb(docs);
  let clock = Date.parse('2026-09-26T06:30:00Z');
  const svc = createPickCalibrationService({ getDb: () => db, now: () => clock, pageSize: 150, log: {} });
  const r = await svc.rebuild('test');
  assert.equal(r.ok, true);
  assert.equal(r.documents, 400);
  assert.equal(svc.getMap().validation.status, 'INSUFFICIENT_HISTORY');
  assert.deepEqual(db.saved.current.validation.approvedMarkets, []);
  clock += 3600000;
  assert.equal((await svc.refreshIfStale()).skipped, true);
  clock += 24 * 3600000;
  assert.equal((await svc.refreshIfStale()).ok, true);
  assert.equal(svc.getMap().builtAt, new Date(clock).toISOString());
});

// ── Doubles ─────────────────────────────────────────────────────────────────
const leg = (over = {}) => ({ matchId: 1, marketKey: 'over15', selection: 'Over 1.5', result: 'pending', ...over });

test('double validation: two different matches, combined odds and stake required', () => {
  const ok = validateDoubleSlip({ stake: 1000, combinedOdds: 2.4, legs: [leg(), leg({ matchId: 2, odds: '1.5' })] });
  assert.equal(ok.ok, true);
  assert.equal(ok.combinedOdds, 2.4);
  assert.equal(ok.legs[1].odds, 1.5);
  assert.equal(ok.legs[0].odds, null);
  assert.match(validateDoubleSlip({ stake: 1000, legs: [leg(), leg({ matchId: 2 })] }).error, /Combined SportyBet odds/);
  assert.match(validateDoubleSlip({ combinedOdds: 2, legs: [leg(), leg({ matchId: 2 })] }).error, /Stake/);
  assert.match(validateDoubleSlip({ stake: 5, combinedOdds: 2, legs: [leg(), leg()] }).error, /different match/);
  assert.match(validateDoubleSlip({ stake: 5, combinedOdds: 2, legs: [leg()] }).error, /two picks/);
  assert.match(validateDoubleSlip({ stake: 5, combinedOdds: 2, legs: [leg(), leg({ matchId: 2, odds: 0.9 })] }).error, /own odds/);
  assert.equal(validateDoubleSlip({ stake: 5, combinedOdds: 2, legs: [leg(), leg({ matchId: 2, marketKey: 'corners' })] }, { isSettleable: (k) => k !== 'corners' }).ok, false);
});

test('double settlement: won only if both win, lost if either loses, pending otherwise', () => {
  assert.equal(settleDoubleSlip([leg({ result: 'won' }), leg({ result: 'won' })], 2.4).result, 'won');
  assert.equal(settleDoubleSlip([leg({ result: 'won' }), leg({ result: 'won' })], 2.4).effectiveOdds, 2.4);
  assert.equal(settleDoubleSlip([leg({ result: 'lost' }), leg()], 2.4).result, 'lost');
  assert.equal(settleDoubleSlip([leg({ result: 'won' }), leg({ result: 'lost' })], 2.4).result, 'lost');
  assert.equal(settleDoubleSlip([leg({ result: 'won' }), leg()], 2.4).result, 'pending');
});

test('double settlement: a void leg reduces it to a single, else manual review', () => {
  const r1 = settleDoubleSlip([leg({ result: 'void', odds: 1.6 }), leg({ result: 'won', odds: 1.5 })], 2.4);
  assert.deepEqual([r1.result, r1.effectiveOdds], ['won', 1.5]);
  const r2 = settleDoubleSlip([leg({ result: 'void', odds: 1.6 }), leg({ result: 'won' })], 2.4);
  assert.deepEqual([r2.result, r2.effectiveOdds], ['won', 1.5]); // 2.4 / 1.6
  const r3 = settleDoubleSlip([leg({ result: 'void' }), leg({ result: 'won' })], 2.4);
  assert.deepEqual([r3.result, r3.needsReview], ['review', true]);
  assert.equal(settleDoubleSlip([leg({ result: 'void' }), leg({ result: 'lost' })], 2.4).result, 'lost');
  assert.equal(settleDoubleSlip([leg({ result: 'void' }), leg({ result: 'void' })], 2.4).result, 'void');
});

test('double profit/loss in Naira uses stake × combined (or effective) odds', () => {
  assert.equal(slipProfit({ stake: 1000, odds: 2.4, result: 'won' }), 1400);
  assert.equal(slipProfit({ stake: 1000, odds: 2.4, result: 'lost' }), -1000);
  assert.equal(slipProfit({ stake: 1000, odds: 2.4, effectiveOdds: 1.5, result: 'won' }), 500);
  assert.equal(slipProfit({ stake: 1000, odds: 2.4, result: 'void' }), 0);
  assert.equal(slipProfit({ stake: 1000, odds: 2.4, result: 'review' }), null);
  assert.equal(betSettlementOdds({ odds: 1.9 }), 1.9); // old singles unchanged
  assert.equal(summarizePaperBets([{ stake: 100, odds: 3, effectiveOdds: 2, result: 'won' }]).netProfit, 100);
});

test('settler settles each leg from its own fixture and saves one slip', async () => {
  const now = Date.parse('2026-09-26T22:00:00Z');
  const bet = { source: 'USER_PLAYED', slipType: 'double', result: 'pending', odds: 2.4, stake: 1000,
    legs: [leg({ matchId: 11, kickoffUTC: '2026-09-26T13:00:00Z' }), leg({ matchId: 12, marketKey: 'btts', kickoffUTC: '2026-09-26T15:00:00Z' })] };
  const fixtures = {
    11: { fixture: { id: 11, status: { short: 'FT' } }, goals: { home: 2, away: 1 }, score: { fulltime: { home: 2, away: 1 } } },
    12: { fixture: { id: 12, status: { short: 'FT' } }, goals: { home: 1, away: 1 }, score: { fulltime: { home: 1, away: 1 } } },
  };
  const saves = [];
  const settle = createPlayedBetSettler({ loadPending: async () => [bet], fetchFixture: async (id) => fixtures[id], save: async (b, u) => saves.push(u), now: () => now });
  const r = await settle();
  assert.equal(r.checked, 2);
  assert.equal(r.settled, 1);
  assert.equal(saves.at(-1).result, 'won');
  assert.deepEqual(saves.at(-1).legs.map((l) => l.result), ['won', 'won']);
});

test('a cancelled fixture voids that leg of a double; singles are unaffected', () => {
  const bet = { slipType: 'double', odds: 2.4, legs: [leg({ matchId: 1, result: 'won', odds: 1.5 }), leg({ matchId: 2 })] };
  const u = settleDoubleLegsFromFixture(bet, 2, null, 'CANC', 'now');
  assert.equal(u.legs[1].result, 'void');
  assert.equal(u.result, 'won');
  assert.equal(u.effectiveOdds, 1.5);
  assert.equal(settleDoubleLegsFromFixture(bet, 2, null, 'NS', 'now'), null);
  assert.equal(settleDoubleLegsFromFixture({ marketKey: 'over15', matchId: 2 }, 2, null, 'CANC', 'now'), null);
});

// ── Wiring (static checks, server.js is not started in tests) ───────────────
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
test('server wires corrected chance into analysis, feed, bet logging and a daily rebuild', () => {
  const server = read('../src/server.js');
  assert.match(server, /res\.json\(withCorrectedChances\(analysis, enriched\)\)/);
  assert.match(server, /function withFixtureStatuses[\s\S]{0,300}withCorrectedChances/);
  assert.match(server, /priceCheckAtLogging: priceCheckAtLogging\(/);
  assert.match(server, /cron\.schedule\('30 6 \* \* \*'[\s\S]{0,120}pickCalibration\.rebuild/);
  assert.match(server, /slipType === SLIP_DOUBLE\) return recordPlayedDouble/);
  assert.ok(ROUTE_POLICY.some((r) => r.path === '/api/calibration/rebuild' && r.access === 'admin'));
});

test('frontend shows corrected chance, minimum odds, warning and the single/double form', () => {
  const panel = read('../../frontend/src/components/DetailPanel.jsx') + read('../../frontend/src/components/PlayedBetForm.jsx');
  const hub = read('../../frontend/src/components/PerformanceHub.jsx');
  assert.match(panel, /Corrected chance/);
  assert.match(panel, /Minimum SportyBet odds worth taking/);
  assert.match(panel, /no market price/);
  assert.match(panel, /priceCheck\.warning/);
  assert.match(panel, /Double/);
  assert.match(panel, /Combined SportyBet odds/);
  assert.match(hub, /slipType === 'double'/);
});
