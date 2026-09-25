import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  isPaperBet, splitPaperBets, summarizePaperBets, validateBetStakeAndOdds,
} from '../../shared/betLogging.js';
import { analyzeV9 } from '../src/services/agent47Service.js';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const server = read('../src/server.js');
const panel = read('../../frontend/src/components/DetailPanel.jsx');
const feed = read('../../frontend/src/components/MatchFeed.jsx');
const cards = read('../../frontend/src/components/MatchComponents.jsx');
const app = read('../../frontend/src/App.jsx');
const sidebar = read('../../frontend/src/components/Sidebar.jsx');
const logger = read('../../frontend/src/components/BetComponents.jsx');
const hub = read('../../frontend/src/components/PerformanceHub.jsx');

// ── G: bet logging ─────────────────────────────────────────────────────────
test('G: stake and SportyBet odds are required for a new bet', () => {
  assert.equal(validateBetStakeAndOdds({}).ok, false);
  assert.match(validateBetStakeAndOdds({ odds: 1.8 }).error, /Stake is required/);
  assert.match(validateBetStakeAndOdds({ stake: 500 }).error, /SportyBet odds are required/);
  assert.equal(validateBetStakeAndOdds({ stake: 0, odds: 1.8 }).ok, false);
  assert.equal(validateBetStakeAndOdds({ stake: 500, odds: 1 }).ok, false);
  assert.equal(validateBetStakeAndOdds({ stake: 'abc', odds: 1.8 }).ok, false);
  const ok = validateBetStakeAndOdds({ stake: '500', odds: '1.85' });
  assert.deepEqual(ok, { ok: true, stake: 500, odds: 1.85, paper: false, bookmaker: 'SportyBet' });
  assert.equal(validateBetStakeAndOdds({ stake: 500, odds: 1.85, paper: true }).paper, true);
  assert.equal(validateBetStakeAndOdds({ stake: 500, odds: 1.85, paper: 'yes-please' }).paper, false);
});

test('G: practice bets are separated from real money; old records without the flag stay real', () => {
  const bets = [
    { result: 'won', stake: 1000, odds: 2 },               // legacy record: real
    { result: 'lost', stake: 500, odds: 1.8, paper: false },
    { result: 'won', stake: 200, odds: 3, paper: true },
    { result: 'pending', stake: 100, odds: 1.5, paper: true },
  ];
  const { real, paper } = splitPaperBets(bets);
  assert.equal(real.length, 2);
  assert.equal(paper.length, 2);
  assert.equal(isPaperBet(bets[0]), false);
  assert.deepEqual(summarizePaperBets(paper), { total: 2, settled: 1, won: 1, lost: 0, winRate: 100, netProfit: 400 });
});

test('G: both bet routes validate, store paper/bookmaker, and stats exclude practice bets', () => {
  const played = server.slice(server.indexOf("app.post('/api/bets/played'"), server.indexOf("app.get('/api/health'"));
  assert.match(played, /validateBetStakeAndOdds\(req\.body\)/);
  assert.match(played, /paper: betInputs\.paper/);
  const manual = server.slice(server.indexOf("app.post('/api/bets', async"), server.indexOf("app.patch('/api/bets/:id'"));
  assert.match(manual, /validateBetStakeAndOdds\(req\.body\)/);
  assert.match(manual, /status\(400\)/);
  assert.match(manual, /bookmaker: betInputs\.bookmaker/);
  for (const route of ["app.get('/api/stats', async", "app.get('/api/stats/competition'", "app.get('/api/stats/mode'"]) {
    const start = server.indexOf(route);
    const block = server.slice(start, server.indexOf('\napp.', start + 10));
    assert.match(block, /splitPaperBets\(allBets\)/, route);
    assert.match(block, /practiceBets: summarizePaperBets\(paperBets\)/, route);
  }
  assert.match(server, /splitPaperBets\(allBets \|\| \[\]\)\.real/);
  // existing records are never edited by this change: PATCH is untouched
  assert.match(server, /const updates = \{ \.\.\.req\.body, updatedAt: new Date\(\)\.toISOString\(\) \};/);
});

test('G: the UI asks for stake, SportyBet odds and an optional practice flag', () => {
  assert.match(panel, /Stake \(₦\)/);
  assert.match(panel, /SportyBet odds/);
  assert.match(panel, /Practice \(no real money\)/);
  assert.match(panel, /bookmaker: 'SportyBet'/);
  assert.match(logger, /placeholder="SportyBet odds"/);
  assert.match(logger, /name="paper"/);
  assert.match(logger, /Enter the stake you placed/);
  assert.match(hub, /Real profit\/loss/);
  assert.match(hub, /PRACTICE/);
});

// ── D: honest display ──────────────────────────────────────────────────────
const noData = { home: 'A', away: 'B', league: 'L', leagueId: 39, season: 2026, status: 'NS', score: '0-0' };

test('D: no model means no score (the legacy composite is never shown as a prediction)', () => {
  const a = analyzeV9(noData);
  assert.equal(a.predictionCore.coreReady, false);
  assert.equal(a.overallScore, null);
  assert.equal(a.decisionMetrics.signalStrength.score, null);
  assert.equal(typeof a.legacyOverallScore, 'number', 'kept only as a diagnostic field');
});

test('D: "Data" is scaled by game sample so 4/4 inputs from 2 games is not 100%', () => {
  const thin = analyzeV9({ ...noData, homeGoalsAvgFor: 1.5, homeGoalsAvgAgainst: 1, awayGoalsAvgFor: 1.2, awayGoalsAvgAgainst: 1.3, homeSampleSize: 2, awaySampleSize: 8 });
  const dc = thin.decisionMetrics.dataCompleteness;
  assert.equal(dc.score, 100, 'coverage score (drives decisions) unchanged');
  assert.equal(dc.displayScore, 20);
  assert.equal(dc.displayLabel, 'Low');
  assert.match(dc.sampleText, /2 of 10 recent games/);
  const full = analyzeV9({ ...noData, homeGoalsAvgFor: 1.5, homeGoalsAvgAgainst: 1, awayGoalsAvgFor: 1.2, awayGoalsAvgAgainst: 1.3, homeSampleSize: 10, awaySampleSize: 12 });
  assert.equal(full.decisionMetrics.dataCompleteness.displayScore, 100);
  assert.equal(thin.decisionMetrics.decisionStatus.status, full.decisionMetrics.decisionStatus.status);
});

test('D: match panel drops V9/T-tier labels, renames Signal, hides empty parameters and handles no-pick', () => {
  assert.equal(/>\s*V9\s*</.test(panel), false);
  assert.equal(panel.includes('T{tier}'), false);
  assert.equal(panel.includes('Signal {modelSignalScore}%'), false);
  assert.match(panel, /Pick score \{Math\.round\(modelSignalScore\)\}\/100/);
  assert.match(panel, /It is NOT the chance of winning/);
  assert.match(panel, /No pick — no market passed the thresholds/);
  assert.match(panel, /Not available for this match/);
  assert.match(panel, /PARAMS\.filter\(\(\{ key \}\) => P\[key\]\?\.score != null\)/);
  assert.match(panel, /dataCompleteness\?\.displayScore/);
  assert.match(panel, /LOCKED AT KICKOFF/);
  assert.match(panel, /Goal-rate evidence/);
  assert.match(panel, /Missing: \$\{missingInputs\.join/);
  assert.equal(panel.includes('overallScore = 0'), false);
  // live in-match xG is no longer sent as a season xG average
  assert.equal(panel.includes('homeXgAvg:        (match.xg?.home'), false);
});

test('D: feed shows "No prediction" instead of 0% and scores as /100', () => {
  assert.match(feed, /No prediction/);
  assert.equal(feed.includes('match.confidence || 0'), false);
  assert.match(feed, /\{value\}\/100/);
  assert.equal(cards.includes('A47 {conf}%'), false);
  assert.equal(cards.includes('match.confidence || 0'), false);
});

test('D: old V8 / "80%+ Signal" labels are gone and feed statuses update in place', () => {
  assert.equal(app.includes('V8 Bet Slips'), false);
  assert.equal(app.includes('80%+ Signal'), false);
  assert.equal(sidebar.includes('80%+ Signal'), false);
  assert.match(app, /Daily 80\+ Pick Candidates/);
  assert.match(app, /incomingById\.get\(String\(m\.id\)\)/);
});

test('D: Record page rounds probabilities', () => {
  assert.equal(hub.includes("{m.modelProbability ?? m.confidence ?? '—'}%"), false);
  assert.equal(hub.includes("{b.modelProbability ?? b.confidence ?? '—'}%"), false);
  assert.match(hub, /Math\.round\(n \* 10\) \/ 10/);
});
