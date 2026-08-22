import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildPredictionLedgerDocument,
  settleMarketPrediction,
  settlePredictionDocument,
  summarizePredictionDocuments,
} from '../../shared/predictionLedger.js';
import { MARKET } from '../../shared/marketKeys.js';

test('ledger freezes every genuine score-settleable Agent47 market independently', () => {
  const doc = buildPredictionLedgerDocument({
    id: 123,
    home: 'Home FC',
    away: 'Away FC',
    league: 'Test League',
    kickoffUTC: '2026-08-22T15:00:00Z',
    analysis: {
      analysisVersion: 'V10-test',
      dailySignal: { eligible: true, score: 84 },
      recommendations: [
        { type: 'WINS_ONLY', selection: 'Home FC Win', confidence: 76 },
        { type: 'GOALS_ONLY', selection: 'Over 1.5 Goals', confidence: 88 },
        { type: 'GOALS_ONLY', selection: 'Under 4.5 Goals', confidence: 82 },
        { type: 'GOALS_ONLY', selection: 'Both Teams to Score', confidence: 71 },
        { type: 'NO_BET', selection: 'No Bet', confidence: 40 },
      ],
    },
  }, {
    predictedAt: '2026-08-22T05:00:00Z',
    preparedDateUK: '2026-08-22',
  });

  assert.equal(doc.markets.length, 4);
  assert.deepEqual(doc.markets.map((m) => m.marketKey), [
    MARKET.HOME_WIN,
    MARKET.OVER_15,
    MARKET.UNDER_45,
    MARKET.BTTS,
  ]);
  assert.equal(doc.settlementStatus, 'PENDING');
});

test('1X2 markets settle correctly from final score', () => {
  assert.equal(settleMarketPrediction(MARKET.HOME_WIN, 2, 1), 'won');
  assert.equal(settleMarketPrediction(MARKET.DRAW, 2, 2), 'won');
  assert.equal(settleMarketPrediction(MARKET.AWAY_WIN, 0, 1), 'won');
  assert.equal(settleMarketPrediction(MARKET.HOME_WIN, 1, 3), 'lost');
});

test('goal totals settle independently including 4.5 lines', () => {
  assert.equal(settleMarketPrediction(MARKET.OVER_15, 1, 1), 'won');
  assert.equal(settleMarketPrediction(MARKET.OVER_25, 1, 1), 'lost');
  assert.equal(settleMarketPrediction(MARKET.UNDER_45, 3, 1), 'won');
  assert.equal(settleMarketPrediction(MARKET.UNDER_35, 3, 1), 'lost');
});

test('BTTS settlement uses actual final score', () => {
  assert.equal(settleMarketPrediction(MARKET.BTTS, 3, 1), 'won');
  assert.equal(settleMarketPrediction(MARKET.BTTS, 3, 0), 'lost');
});

test('one match can score win and goals predictions separately', () => {
  const doc = buildPredictionLedgerDocument({
    id: 88,
    home: 'A',
    away: 'B',
    analysis: {
      recommendations: [
        { type: 'WINS_ONLY', selection: 'A Win', confidence: 75 },
        { type: 'GOALS_ONLY', selection: 'Over 2.5 Goals', confidence: 80 },
        { type: 'GOALS_ONLY', selection: 'Under 4.5 Goals', confidence: 83 },
      ],
    },
  }, { predictedAt: '2026-08-22T05:00:00Z', preparedDateUK: '2026-08-22' });

  const settled = settlePredictionDocument(doc, 2, 1, '2026-08-22T17:00:00Z');
  assert.deepEqual(settled.markets.map((m) => m.result), ['won', 'won', 'won']);
  assert.equal(settled.finalScore, '2-1');
});

test('summary counts market calls, not merely matches', () => {
  const docs = [{
    predictionId: 'x',
    markets: [
      { marketKey: MARKET.HOME_WIN, result: 'won' },
      { marketKey: MARKET.OVER_25, result: 'lost' },
      { marketKey: MARKET.UNDER_45, result: 'won' },
    ],
  }];
  const summary = summarizePredictionDocuments(docs);
  assert.equal(summary.matchesRecorded, 1);
  assert.equal(summary.settledCalls, 3);
  assert.equal(summary.won, 2);
  assert.equal(summary.hitRate, 66.7);
});

test('server exposes separate Sporty ledger and exact My Bets endpoint', () => {
  const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/predictions'/);
  assert.match(server, /app\.post\('\/api\/bets\/played'/);
  assert.match(server, /source: 'USER_PLAYED'/);
  assert.match(server, /settlePredictionLedger/);
  assert.match(server, /permanent ledger/);
  assert.equal(server.includes('deleteAfter: deleteAfter.toISOString()'), false);
});

test('GUI exposes Track Record and I PLAYED THIS', () => {
  const app = fs.readFileSync(new URL('../../frontend/src/App.jsx', import.meta.url), 'utf8');
  const detail = fs.readFileSync(new URL('../../frontend/src/components/DetailPanel.jsx', import.meta.url), 'utf8');
  const hub = fs.readFileSync(new URL('../../frontend/src/components/PerformanceHub.jsx', import.meta.url), 'utf8');
  assert.match(app, /PerformanceHub/);
  assert.match(app, />\s*Record\s*</);
  assert.match(detail, /I PLAYED THIS/);
  assert.match(hub, /SportyRabbi Record/);
  assert.match(hub, /My Bets/);
});
