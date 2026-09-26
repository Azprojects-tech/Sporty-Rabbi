import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSimpleCard, suggestCombos, comboTotals, legOdds, compactMarketProbabilities } from '../../shared/simpleCard.js';
import { buildCalibrationMap } from '../../shared/pickCalibration.js';
import { validateDoubleSlip, settleDoubleSlip, isDoubleSlip } from '../../shared/betLogging.js';

const picksAt = (marketKey, p, n, rate) => Array.from({ length: n }, (_, i) => ({ marketKey, p, won: i < Math.round(n * rate) ? 1 : 0, leagueId: 39 }));
const calibration = buildCalibrationMap([...picksAt('over25', 70, 500, 0.6), ...picksAt('over15', 80, 500, 0.79)]);
const NOW = Date.parse('2026-09-26T10:00:00Z');
const game = (id, probs, extra = {}) => ({
  id, home: `H${id}`, away: `A${id}`, league: 'L', leagueId: 39, status: 'NS', kickoffUTC: '2026-09-26T15:00:00Z',
  analysis: { recommendations: [], marketProbabilities: probs }, ...extra,
});

test('card shows corrected chances and "No prediction" (null) instead of 0', () => {
  const card = buildSimpleCard(game(1, { over15: 0.8, over25: 0.7, home_win: 0.5 }), calibration);
  assert.ok(card.markets.over25.chance < 66);          // corrected down from 70
  assert.equal(card.markets.over25.stated, 70);
  assert.equal(card.markets.draw, null);               // no figure -> No prediction
  assert.equal(card.markets.away_win, null);
  assert.equal(buildSimpleCard({ id: 2, analysis: { recommendations: [] } }, calibration), null);
  assert.equal(buildSimpleCard({ id: 3 }, calibration), null);
});

test('card falls back to a recommended pick when the feed has no market chances', () => {
  const card = buildSimpleCard({ id: 4, analysis: { recommendations: [{ marketKey: 'over15', modelProbability: 80 }] } }, calibration);
  assert.ok(card.markets.over15.chance > 75 && card.markets.over15.chance < 80);
  assert.equal(card.markets.over25, null);
});

test('compact feed keeps only the card market chances', () => {
  const probs = compactMarketProbabilities({ poisson: { marketProbabilities: { over15: 0.81234567, over45: 0.2, draw: 0 } } });
  assert.deepEqual(probs, { over15: 0.8123 });
  assert.equal(compactMarketProbabilities({}), null);
});

test('leg odds: stored bookmaker price, else an estimate from the chance', () => {
  assert.deepEqual(legOdds(80, 1.3), { odds: 1.3, estimate: false });
  assert.deepEqual(legOdds(80, null), { odds: 1.25, estimate: true });
  assert.equal(legOdds(null, null), null);
});

test('combined chance is the product of chances; typed SportyBet odds replace estimates', () => {
  const legs = [{ chance: 80, odds: 1.25, estimate: true }, { chance: 70, odds: 1.43, estimate: true }];
  assert.deepEqual(comboTotals(legs), { chance: 56, odds: 1.79, estimate: true });
  assert.deepEqual(comboTotals([{ ...legs[0], userOdds: '1.40' }, { ...legs[1], userOdds: 1.5 }]), { chance: 56, odds: 2.1, estimate: false });
});

test('suggestions: legs from different games, near 2.0 / 3.0, higher chance first, no pick reused', () => {
  const card = (id, key, chance, bookmakerOdds = null) => ({
    id, home: `H${id}`, away: `A${id}`, status: 'NS', kickoffUTC: '2026-09-26T15:00:00Z',
    simpleCard: { markets: { [key]: { chance, stated: chance, bookmakerOdds } } },
  });
  const matches = [
    card(1, 'over15', 75, 1.40), card(2, 'over15', 72, 1.42), card(3, 'over25', 62, 1.62),
    card(4, 'over25', 58, 1.72), card(5, 'home_win', 66, 1.45), card(6, 'over15', 90, 1.05), // too short to use
    { ...card(7, 'over15', 80, 1.45), status: '1H' },                                           // already started
    { id: 8, home: 'H8', away: 'A8', status: 'NS', kickoffUTC: '2026-09-26T15:00:00Z',
      simpleCard: { markets: { over15: { chance: 74, bookmakerOdds: 1.4 }, over25: { chance: 60, bookmakerOdds: 1.45 } } } },
  ];
  const combos = suggestCombos(matches, { now: NOW });
  assert.ok(combos.length >= 2);
  const seen = new Set();
  for (const c of combos) {
    const ids = c.legs.map((l) => String(l.matchId));
    assert.equal(new Set(ids).size, ids.length, 'no two legs from the same match');
    assert.ok(Math.abs(c.odds - c.target) / c.target <= 0.08, `odds ${c.odds} near ${c.target}`);
    assert.ok(!ids.includes('6') && !ids.includes('7'));
    for (const l of c.legs) { assert.ok(!seen.has(l.key)); seen.add(l.key); }
  }
  const twos = combos.filter((c) => c.target === 2);
  for (let i = 1; i < twos.length; i++) assert.ok(twos[i - 1].chance >= twos[i].chance);
  assert.equal(combos[0].legs.every((l) => l.estimate === false), true);
});

test('trebles can be logged and settle like doubles', () => {
  const leg = (id, over = {}) => ({ matchId: id, marketKey: 'over15', selection: 'Over 1.5', ...over });
  const ok = validateDoubleSlip({ slipType: 'treble', stake: 500, combinedOdds: 3.1, legs: [leg(1), leg(2), leg(3)] });
  assert.equal(ok.ok, true);
  assert.equal(ok.slipType, 'treble');
  assert.match(validateDoubleSlip({ slipType: 'treble', stake: 5, combinedOdds: 3, legs: [leg(1), leg(2)] }).error, /three picks/);
  assert.match(validateDoubleSlip({ slipType: 'treble', stake: 5, combinedOdds: 3, legs: [leg(1), leg(2), leg(2)] }).error, /different match/);
  assert.equal(isDoubleSlip({ slipType: 'treble', legs: [] }), true);
  const r = (a, b, c) => [leg(1, a), leg(2, b), leg(3, c)];
  assert.equal(settleDoubleSlip(r({ result: 'won' }, { result: 'won' }, { result: 'won' }), 3.1).result, 'won');
  assert.equal(settleDoubleSlip(r({ result: 'won' }, { result: 'lost' }, {}), 3.1).result, 'lost');
  const v = settleDoubleSlip(r({ result: 'void' }, { result: 'won', odds: 1.4 }, { result: 'won', odds: 1.5 }), 3.1);
  assert.deepEqual([v.result, v.effectiveOdds], ['won', 2.1]);
  assert.equal(settleDoubleSlip(r({ result: 'void' }, { result: 'won' }, { result: 'won', odds: 1.5 }), 3.1).result, 'review');
});

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
test('simple view is the default; technical list stays behind Details', () => {
  const app = read('../../frontend/src/App.jsx');
  const view = read('../../frontend/src/components/SimpleView.jsx');
  const server = read('../src/server.js');
  assert.match(app, /localStorage\.getItem\('sportyrabbi\.viewMode'\) \|\| 'simple'/);
  assert.match(app, /viewMode === 'simple' \?[\s\S]{0,80}<SimpleView/);
  assert.match(app, /<MatchFeed/); // technical list kept
  assert.match(view, /No prediction/);
  assert.match(view, /Coming soon/);
  assert.match(view, /Build my double/);
  assert.match(view, /\(estimate\)/);
  assert.match(view, /I played this/);
  assert.match(view, />\s*Details\s*</);
  assert.match(server, /marketProbabilities: compactMarketProbabilities\(analysis\)/);
  assert.match(server, /simpleCard: buildSimpleCard\(m, pickCalibration\.getMap\(\)\)/);
  assert.match(server, /backfillCardProbabilities\(restoredAnalyzed\)/);
});
