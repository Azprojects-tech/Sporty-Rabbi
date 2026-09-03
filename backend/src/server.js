/**
 * 🐰 SportyRabbi Backend Server
 * 
 * Real-time football betting analytics with:
 *   - REST API endpoints
 *   - WebSocket live data stream
 *   - API-Football integration (live matches every 30s)
 *   - Twilio WhatsApp alerts
 */

import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import cron from 'node-cron';
import axios from 'axios';
import { initFirebase, getDb } from './config/firebase.js';
import { getTeamForm, getH2H, getFixturePreview, getStandings, getTeamStatistics, getTeamInjuries } from './services/analyticsService.js';
import { analyzeV9 } from './services/agent47Service.js';
import { sendWhatsApp, sendBettingAlert, twilioEnabled } from './services/notificationService.js';
import {
  naturalLanguageToMatchData,
  fetchLiveMatchesViaGemini,
  fetchUpcomingMatchesViaGemini,
  calibrateDay,
  enrichFixturesWithGemini,
  generateMatchNarrative,
  fetchAndReasonContextAdjustments,
} from './services/geminiService.js';
import {
  calculateNextGoalProbability,
  calculateMomentum,
  calculateBetValue,
  generateBettingAlert,
  calculateGoalFestSignal,
  classifyAlertLifecycle,
} from './services/liveAnalyticsService.js';
import { getPhaseConfidencePolicy } from '../../shared/confidencePolicy.js';
import { getLeagueStatDefaults } from '../../shared/leagueDefaults.js';
import { detectCompetitionContext } from '../../shared/competitionModelProfile.js';
import { getCompetitionRiskPolicy } from '../../shared/competitionRiskPolicy.js';
import { MARKET, finiteNumberOrNull, offeredOddsForMarket, getTopExecutableRecommendation } from '../../shared/marketKeys.js';
import {
  buildPredictionLedgerDocument,
  buildPredictionLedgerId,
  isSettleableMarket,
  normalizePredictionLedgerDocument,
  settleMarketPrediction,
  settlePredictionDocument,
  summarizePredictionDocuments,
} from '../../shared/predictionLedger.js';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// ─── WHITELIST CONFIG ──────────────────────────────────────────────────────
// Only track these specific leagues (ID-based for maximum control)
// All regulated leagues are shown — no whitelist restriction.
// Confidence filtering is phase-aware (PRE/EARLY/MID/LATE live) in backend and frontend.
// The constant below is kept only for the TheSportsDB league-ID lookup helper.
const WHITELISTED_LEAGUE_IDS = null; // null = accept all leagues

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────

// Aggressive CORS middleware - override all headers
app.use((req, res, next) => {
  // Clear any existing CORS headers that might be set by proxies
  res.removeHeader('Access-Control-Allow-Origin');
  
  // Set permissive CORS headers
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Accept, Accept-Language, Content-Language, Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  });
  
  // Handle preflight requests immediately
  if (req.method === 'OPTIONS') {
    return res.send('OK');
  }
  
  next();
});

app.use(express.json());

// ─── IN-MEMORY DATA STORE ────────────────────────────────────────────────────
// No database needed for MVP - data stored in memory
let liveMatches = [];
let upcomingMatches = [];
// Per-match analysis cache: avoids re-running 8 API calls per match on every poll.
// Invalidated when score changes or after 5 minutes.
const liveAnalysisCache = new Map(); // matchId → { result, score, timestamp }
const LIVE_ANALYSIS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let alerts = [];
let bets = [];
let calibrationStore = {
  matches: [],
  highConfidence: [],
  dailySchedule: [],
  preparedDateUK: null,
  calibratedAt: null,
  totalScanned: 0,
  lastTrigger: null,
  lastStartedAt: null,
  lastCompletedAt: null,
};
let calibrationRunning = false;
let calibrationPromise = null;
const calibrationRunMeta = {
  runningTrigger: null,
  runningSince: null,
  lastTrigger: null,
  lastStartedAt: null,
  lastCompletedAt: null,
};

function runCalibrationSafely(trigger = 'manual') {
  if (calibrationPromise) {
    console.log(`[Calibrate] ${trigger} skipped: calibration already running`);
    return calibrationPromise;
  }

  const startedAt = new Date().toISOString();
  calibrationRunMeta.runningTrigger = trigger;
  calibrationRunMeta.runningSince = startedAt;
  calibrationRunMeta.lastTrigger = trigger;
  calibrationRunMeta.lastStartedAt = startedAt;

  calibrationRunning = true;
  calibrationPromise = runCalibration()
    .catch((err) => {
      console.error(`[Calibrate] ${trigger} run error:`, err.message);
      throw err;
    })
    .finally(() => {
      const completedAt = new Date().toISOString();
      calibrationRunMeta.lastCompletedAt = completedAt;
      calibrationRunMeta.runningTrigger = null;
      calibrationRunMeta.runningSince = null;
      calibrationStore.lastCompletedAt = completedAt;

      calibrationRunning = false;
      calibrationPromise = null;
    });

  return calibrationPromise;
}

// ─── FIREBASE INIT ───────────────────────────────────────────────────────────
initFirebase();

// ─── WEBSOCKET SERVER ──────────────────────────────────────────────────────

const clients = new Set();

wss.on('connection', (ws) => {
  try {
    clients.add(ws);
    console.log(`✓ Portal connected (${clients.size} users)`);
    
    // Send initial state
    const connectedMsg = JSON.stringify({ type: 'CONNECTED', message: '🐰 SportyRabbi live feed active' });
    const liveMsg = JSON.stringify({ type: 'LIVE_MATCHES', payload: liveMatches || [] });
    const upcomingMsg = JSON.stringify({ type: 'UPCOMING_MATCHES', payload: upcomingMatches || [] });
    
    if (ws.readyState === ws.OPEN) {
      ws.send(connectedMsg);
      ws.send(liveMsg);
      ws.send(upcomingMsg);
      console.log(`  ✅ Sent ${liveMatches.length} live + ${upcomingMatches.length} upcoming matches`);
    }
  } catch (err) {
    console.error('❌ Connection error:', err.message);
  }

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`✓ Portal disconnected (${clients.size} users)`);
  });

  ws.on('error', (err) => {
    console.error('WS Error:', err.message);
    clients.delete(ws);
  });
});

// Broadcast to all connected clients
function broadcast(message) {
  try {
    const jsonStr = JSON.stringify(message);
    let sent = 0;
    let failed = 0;
    
    clients.forEach((ws) => {
      try {
        if (ws.readyState === ws.OPEN) {
          ws.send(jsonStr);
          sent++;
        }
      } catch (err) {
        failed++;
        console.error('  ⚠️  Failed to send to client:', err.message);
      }
    });
    
    if (failed > 0) {
      console.log(`  📤 Broadcast: ${sent} sent, ${failed} failed`);
    }
  } catch (err) {
    console.error('❌ Broadcast error:', err.message);
  }
}

// ─── API-FOOTBALL INTEGRATION ──────────────────────────────────────────────

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';
const API_DAILY_SOFT_STOP = Number(process.env.API_DAILY_SOFT_STOP || 50); // stop at 50 remaining (saves 50 for the day)
const API_MINUTE_SOFT_STOP = Number(process.env.API_MINUTE_SOFT_STOP || 1);
const API_DAILY_WARNING_THRESHOLD = (() => {
  const parsed = Number(process.env.API_DAILY_WARNING_THRESHOLD || 120);
  if (!Number.isFinite(parsed)) return Math.max(API_DAILY_SOFT_STOP, 120);
  return Math.max(API_DAILY_SOFT_STOP, Math.floor(parsed));
})();

const quotaState = {
  dailyLimit: null,
  dailyRemaining: null,
  minuteLimit: null,
  minuteRemaining: null,
  isPaused: false,
  pauseReason: '',
  pausedAt: null,
  resumeAt: null,
  lastUpdatedAt: null,
};

const quotaNoticeState = {
  warnedDate: null,
  exhaustedDate: null,
  lastKind: null,
  lastSentAt: null,
};

function getUtcDateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getQuotaSummary() {
  const status = quotaState.dailyRemaining === 0
    ? 'EXHAUSTED'
    : quotaState.isPaused
      ? 'PAUSED'
      : quotaState.dailyRemaining != null && quotaState.dailyRemaining <= API_DAILY_WARNING_THRESHOLD
        ? 'LOW'
        : 'OK';
  return {
    status,
    dailyRemaining: quotaState.dailyRemaining,
    dailyLimit: quotaState.dailyLimit,
    minuteRemaining: quotaState.minuteRemaining,
    minuteLimit: quotaState.minuteLimit,
    softStops: {
      daily: API_DAILY_SOFT_STOP,
      minute: API_MINUTE_SOFT_STOP,
    },
    warningThreshold: API_DAILY_WARNING_THRESHOLD,
    isPaused: quotaState.isPaused,
    pauseReason: quotaState.pauseReason,
    pausedAt: quotaState.pausedAt,
    resumeAt: quotaState.resumeAt,
    lastUpdatedAt: quotaState.lastUpdatedAt,
    notifications: { ...quotaNoticeState },
  };
}

function emitQuotaNotice(kind, message) {
  const today = getUtcDateStamp();
  if (kind === 'warning' && quotaNoticeState.warnedDate === today) return;
  if (kind === 'exhausted' && quotaNoticeState.exhaustedDate === today) return;

  if (kind === 'warning') quotaNoticeState.warnedDate = today;
  if (kind === 'exhausted') quotaNoticeState.exhaustedDate = today;
  quotaNoticeState.lastKind = kind;
  quotaNoticeState.lastSentAt = new Date().toISOString();

  const type = kind === 'exhausted' ? 'quota_expired' : 'quota_warning';
  saveAlert({
    type,
    home: 'SYSTEM',
    away: 'API-FOOTBALL',
    league: 'Quota Monitor',
    status: 'NS',
    matchMinutes: 0,
    confidence: 0,
    message,
    sentAt: new Date().toISOString(),
  }).catch((err) => {
    console.warn(`[Quota] Failed to persist ${type} alert: ${err.message}`);
  });

  broadcast({ type: 'QUOTA_STATUS', payload: getQuotaSummary() });
}

function getNextUtcMidnightIso() {
  const now = new Date();
  const nextUtcMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    5,
  ));
  return nextUtcMidnight.toISOString();
}

function parseHeaderInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function setQuotaPause(reason, resumeAt = null) {
  if (!quotaState.isPaused || quotaState.pauseReason !== reason) {
    console.warn(`🛑 Quota guard active: ${reason}`);
  }
  quotaState.isPaused = true;
  quotaState.pauseReason = reason;
  quotaState.pausedAt = new Date().toISOString();
  quotaState.resumeAt = resumeAt;
}

function clearQuotaPause() {
  if (quotaState.isPaused) {
    console.log('✅ Quota guard lifted, API polling resumed');
  }
  quotaState.isPaused = false;
  quotaState.pauseReason = '';
  quotaState.pausedAt = null;
  quotaState.resumeAt = null;
}

function maybeAutoResumeQuotaGuard() {
  if (!quotaState.isPaused || !quotaState.resumeAt) return;
  const now = Date.now();
  const resumeAtTs = Date.parse(quotaState.resumeAt);
  if (!Number.isNaN(resumeAtTs) && now >= resumeAtTs) {
    clearQuotaPause();
  }
}

function updateQuotaFromHeaders(headers = {}) {
  const dailyLimit = parseHeaderInt(headers['x-ratelimit-requests-limit']);
  const dailyRemaining = parseHeaderInt(headers['x-ratelimit-requests-remaining']);
  const minuteLimit = parseHeaderInt(headers['x-ratelimit-limit']);
  const minuteRemaining = parseHeaderInt(headers['x-ratelimit-remaining']);

  if (dailyLimit !== null) quotaState.dailyLimit = dailyLimit;
  if (dailyRemaining !== null) quotaState.dailyRemaining = dailyRemaining;
  if (minuteLimit !== null) quotaState.minuteLimit = minuteLimit;
  if (minuteRemaining !== null) quotaState.minuteRemaining = minuteRemaining;
  quotaState.lastUpdatedAt = new Date().toISOString();

  if (
    quotaState.dailyRemaining != null
    && quotaState.dailyRemaining > API_DAILY_SOFT_STOP
    && quotaState.dailyRemaining <= API_DAILY_WARNING_THRESHOLD
  ) {
    emitQuotaNotice(
      'warning',
      `Quota warning: API-Football daily calls remaining = ${quotaState.dailyRemaining}. Approaching limit.`
    );
  }

  if (quotaState.dailyRemaining === 0) {
    emitQuotaNotice(
      'exhausted',
      'Quota expired: API-Football daily quota is exhausted. API calls are paused until next UTC day.'
    );
  }

  if (quotaState.dailyRemaining !== null && quotaState.dailyRemaining <= API_DAILY_SOFT_STOP) {
    setQuotaPause(
      `Daily remaining ${quotaState.dailyRemaining} <= soft stop ${API_DAILY_SOFT_STOP}`,
      getNextUtcMidnightIso(),
    );
    return;
  }

  if (quotaState.minuteRemaining !== null && quotaState.minuteRemaining <= API_MINUTE_SOFT_STOP) {
    // Brief cooldown for minute rate-limit pressure.
    const resumeAt = new Date(Date.now() + 60 * 1000).toISOString();
    setQuotaPause(
      `Minute remaining ${quotaState.minuteRemaining} <= soft stop ${API_MINUTE_SOFT_STOP}`,
      resumeAt,
    );
    return;
  }

  clearQuotaPause();
}

function shouldSkipApiCalls() {
  maybeAutoResumeQuotaGuard();
  return quotaState.isPaused;
}

// Heartbeat guarantees paused quota state self-recovers even during low traffic periods.
const QUOTA_GUARD_HEARTBEAT_MS = Number(process.env.QUOTA_GUARD_HEARTBEAT_MS || 15000);
if (QUOTA_GUARD_HEARTBEAT_MS > 0) {
  setInterval(() => {
    maybeAutoResumeQuotaGuard();
  }, QUOTA_GUARD_HEARTBEAT_MS);
  console.log(`⏱ Quota guard heartbeat enabled (${QUOTA_GUARD_HEARTBEAT_MS} ms)`);
} else {
  console.log('⏱ Quota guard heartbeat disabled (QUOTA_GUARD_HEARTBEAT_MS <= 0)');
}

// ─── RESPONSE CACHING (minimize API calls on paid plans) ──────────────────
const cache = {
  liveMatches: { data: [], timestamp: 0 },
  upcomingMatches: { data: [], timestamp: 0 },
};

const livePollMetrics = {
  lastStartedAt: null,
  lastCompletedAt: null,
  lastDurationMs: null,
  lastSourceCount: 0,
  lastAnalyzedCount: 0,
  lastUsedCache: false,
  lastError: null,
};

function toNumberWithMin(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

const LIVE_POLL_INTERVAL = toNumberWithMin(process.env.LIVE_POLL_INTERVAL, 30, 5);
const ENABLE_ADAPTIVE_LIVE_POLL = String(process.env.ENABLE_ADAPTIVE_LIVE_POLL || 'false').toLowerCase() === 'true';
const LIVE_POLL_INTERVAL_WHEN_LIVE = toNumberWithMin(
  process.env.LIVE_POLL_INTERVAL_WHEN_LIVE,
  Math.min(LIVE_POLL_INTERVAL, 12),
  5,
);
const POLL_TICK_SECONDS = ENABLE_ADAPTIVE_LIVE_POLL
  ? Math.min(LIVE_POLL_INTERVAL, LIVE_POLL_INTERVAL_WHEN_LIVE)
  : LIVE_POLL_INTERVAL;
let lastLivePollRunAt = 0;

// V10.5A live-refresh policy.
// Daily preparation remains at 05:00 UK. While at least one portal client is connected,
// the backend makes one shared lightweight live-fixture request per refresh interval.
// Deep enrichment remains on the separate live-intelligence cadence / deliberate clicks.
const DAILY_PREP_TIMEZONE = 'Europe/London';
const DAILY_PREP_MAX_ANALYZED_FIXTURES = toNumberWithMin(
  process.env.DAILY_PREP_MAX_ANALYZED_FIXTURES,
  1250,
  1,
);
const DAILY_PREP_TEAM_CALL_BUDGET = toNumberWithMin(
  process.env.DAILY_PREP_TEAM_CALL_BUDGET,
  2500,
  2,
);
const PORTAL_OPEN_REFRESH_COOLDOWN_MS = toNumberWithMin(
  process.env.PORTAL_OPEN_REFRESH_COOLDOWN_MS,
  15000,
  5000,
);
const PORTAL_ACTIVE_LIVE_REFRESH_SECONDS = toNumberWithMin(
  process.env.PORTAL_ACTIVE_LIVE_REFRESH_SECONDS,
  60,
  30,
);
const GOAL_FEST_SCAN_SECONDS = toNumberWithMin(process.env.GOAL_FEST_SCAN_SECONDS,300,120);
const GOAL_FEST_SCAN_LIMIT = toNumberWithMin(process.env.GOAL_FEST_SCAN_LIMIT,16,1);
const GOAL_FEST_ALERT_THRESHOLD = toNumberWithMin(process.env.GOAL_FEST_ALERT_THRESHOLD,70,60);
// Normal Prediction Desk clicks are local/cache-only. Set true only if we later
// deliberately decide that clicking a match may spend API-Football quota.
const ALLOW_ON_DEMAND_API_ENRICHMENT = String(
  process.env.ALLOW_ON_DEMAND_API_ENRICHMENT || 'false'
).toLowerCase() === 'true';
const ALLOW_MANUAL_DAILY_PREP = String(
  process.env.ALLOW_MANUAL_DAILY_PREP || 'false'
).toLowerCase() === 'true';

function getUkDateStamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DAILY_PREP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getUkHour(date = new Date()) {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone: DAILY_PREP_TIMEZONE,
    hour: '2-digit', hour12: false,
  }).format(date);
  return Number.parseInt(hour, 10) || 0;
}

function getEffectiveDailyPrepTeamBudget() {
  if (quotaState.dailyRemaining == null) return DAILY_PREP_TEAM_CALL_BUDGET;
  const spendable = Math.max(0, quotaState.dailyRemaining - API_DAILY_SOFT_STOP);
  return Math.min(DAILY_PREP_TEAM_CALL_BUDGET, spendable);
}

function selectDailyPrepCandidates(fixtures = [], maxFixtures = DAILY_PREP_MAX_ANALYZED_FIXTURES, teamBudget = DAILY_PREP_TEAM_CALL_BUDGET) {
  const valid = fixtures
    .filter((f) => f?.homeTeamId && f?.awayTeamId && f?.season != null && f?.kickoffUTC)
    .filter((f) => ['NS', 'TBD'].includes(String(f.status || 'NS').toUpperCase()))
    .sort((a, b) => Date.parse(a.kickoffUTC) - Date.parse(b.kickoffUTC));

  const target = Math.min(valid.length, maxFixtures, Math.floor(Math.max(0, teamBudget) / 2));
  if (target <= 0) return [];
  if (target >= valid.length) return valid;
  if (target === 1) return [valid[Math.floor(valid.length / 2)]];

  // Spread the bounded deep-analysis budget across the whole football day.
  const picked = [];
  const used = new Set();
  for (let i = 0; i < target; i++) {
    const idx = Math.round(i * (valid.length - 1) / (target - 1));
    if (!used.has(idx)) {
      used.add(idx);
      picked.push(valid[idx]);
    }
  }
  return picked;
}

function mergeDailySchedule(schedule = [], analyzed = []) {
  const byId = new Map(analyzed.map((m) => [String(m.id), m]));
  const byTeams = new Map(analyzed.map((m) => [`${String(m.home).toLowerCase()}|${String(m.away).toLowerCase()}`, m]));
  return (schedule || []).map((lite) => {
    const deep = byId.get(String(lite.id))
      || byTeams.get(`${String(lite.home).toLowerCase()}|${String(lite.away).toLowerCase()}`);
    if (!deep) return lite;
    return {
      ...lite,
      ...deep,
      id: lite.id,
      kickoffUTC: lite.kickoffUTC || deep.kickoffUTC || null,
      _calibrated: true,
      _lite: false,
    };
  });
}

function compactDailyAnalysis(analysis) {
  if (!analysis) return null;
  const recommendations = Array.isArray(analysis.recommendations)
    ? analysis.recommendations.map((r) => ({
        type: r?.type ?? null,
        marketKey: r?.marketKey ?? null,
        selection: r?.selection ?? null,
        confidence: r?.confidence ?? null,
        modelProbability: r?.modelProbability ?? r?.confidence ?? null,
        tier: r?.tier ?? null,
        decisionState: r?.decisionState ?? null,
      }))
    : [];
  return {
    dailySignal: analysis.dailySignal ?? null,
    recommendations,
    odds: analysis.odds ?? null,
  };
}

function compactAnalyzedMatch(match, includeCompactAnalysis = false) {
  if (!match) return null;
  const { analysis, contextAdjustments, ...rest } = match;
  const compact = {
    ...rest,
    dailySignal: analysis?.dailySignal ?? match.dailySignal ?? null,
    _calibrated: true,
    _lite: false,
  };
  if (includeCompactAnalysis) {
    compact.analysis = compactDailyAnalysis(analysis) || match.analysis || null;
  }
  return compact;
}

function chunkArray(items = [], size = 50) {
  const safeSize = Math.max(1, Number(size) || 50);
  const chunks = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

function getCurrentLivePollIntervalSeconds() {
  if (!ENABLE_ADAPTIVE_LIVE_POLL) return LIVE_POLL_INTERVAL;
  const hasLiveMatches = Array.isArray(liveMatches) && liveMatches.length > 0;
  const quotaHealthy = !quotaState.isPaused;
  return hasLiveMatches && quotaHealthy ? LIVE_POLL_INTERVAL_WHEN_LIVE : LIVE_POLL_INTERVAL;
}

function getLiveFreshnessMeta() {
  const now = Date.now();
  const lastDataTs = cache.liveMatches.timestamp || 0;
  const ageMs = lastDataTs > 0 ? now - lastDataTs : null;
  const currentInterval = getCurrentLivePollIntervalSeconds();
  return {
    currentIntervalSeconds: currentInterval,
    baseIntervalSeconds: LIVE_POLL_INTERVAL,
    adaptiveEnabled: ENABLE_ADAPTIVE_LIVE_POLL,
    adaptiveLiveIntervalSeconds: LIVE_POLL_INTERVAL_WHEN_LIVE,
    cacheTimestamp: lastDataTs > 0 ? new Date(lastDataTs).toISOString() : null,
    cacheAgeMs: ageMs,
    cacheAgeSeconds: ageMs == null ? null : +(ageMs / 1000).toFixed(1),
    metrics: { ...livePollMetrics },
  };
}

const CACHE_TTL = {
  live: API_KEY ? Math.max(15, LIVE_POLL_INTERVAL - 2) * 1000 : 5 * 60 * 1000, // keep live scores near poll cadence
  upcoming: API_KEY ? 5 * 60 * 1000 : 15 * 60 * 1000,  // 5 min (API-Football) or 15 min (no key)
};

// When API-Football quota is paused, extend cache TTL so Gemini isn't hammered
function getActiveCacheTTL(type) {
  const isLive = type === 'liveMatches';
  if (!API_KEY || quotaState.isPaused) {
    return isLive ? 5 * 60 * 1000 : 15 * 60 * 1000;
  }
  return isLive ? CACHE_TTL.live : CACHE_TTL.upcoming;
}

function getCached(type) {
  const cached = cache[type];
  const now = Date.now();
  let ttl = getActiveCacheTTL(type);

  // Empty match arrays should refresh quickly; otherwise users can get stuck on
  // a stale "no games" state even when API data becomes available moments later.
  if (cached && Array.isArray(cached.data) && cached.data.length === 0) {
    ttl = Math.min(ttl, 15 * 1000);
  }
  
  if (cached && now - cached.timestamp < ttl) {
    console.log(`  💾 Using cached ${type} (${Math.round((now - cached.timestamp) / 1000)}s old)`);
    return cached.data;
  }
  return null;
}

function setCache(type, data) {
  cache[type] = { data, timestamp: Date.now() };
  console.log(`  💾 Cached ${type}: ${data.length} items`);
}

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🐰 SportyRabbi Backend Starting
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📌 API Key:    ${API_KEY ? '✅ API-Football configured' : '⚠️  API_FOOTBALL_KEY not set — live data unavailable'}
  🌐 API Base:   ${API_BASE}
  ⏱️  API Mode:   ${API_KEY ? '05:00 UK daily preparation + shared portal-active live refresh' : 'No API key — set API_FOOTBALL_KEY in .env'}
  🏆 Leagues:    All regulated leagues (no whitelist)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

async function fetchLiveMatches() {
  if (!API_KEY) {
    console.warn('⚠️  API_FOOTBALL_KEY not set - skipping live data. Set it in .env');
    return [];
  }

  if (shouldSkipApiCalls()) {
    const resumeMsg = quotaState.resumeAt ? ` until ${quotaState.resumeAt}` : '';
    console.warn(`⏸️  Skipping LIVE API call due to quota guard${resumeMsg}`);
    return [];
  }

  try {
    console.log('🔄 Fetching LIVE matches from API-Football...');
    
    // API-Football v3: use `live=all` to get every currently in-play fixture globally.
    // Do NOT use `status=LIVE` — that is a status code filter, not the live-feed param.
    const response = await axios.get(`${API_BASE}/fixtures`, {
      params: { 
        live: 'all',
        timezone: 'UTC'
      },
      headers: { 'x-apisports-key': API_KEY },
      timeout: 5000,
    });
    updateQuotaFromHeaders(response.headers);

    const fixtures = response.data.response || [];
    console.log(`  ℹ️  Got ${fixtures.length} LIVE fixtures`);
    
    return fixtures;
  } catch (error) {
    console.error('❌ API error fetching live:', error.response?.status || error.message);
    if (error.response?.headers) {
      updateQuotaFromHeaders(error.response.headers);
    }
    // Check if rate limited
    if (error.response?.status === 429) {
      // Distinguish minute-rate-limit 429 (short pause) from daily-exhaustion 429 (midnight)
      const dailyOk = quotaState.dailyRemaining === null || quotaState.dailyRemaining > API_DAILY_SOFT_STOP;
      const resumeAt = dailyOk
        ? new Date(Date.now() + 2 * 60 * 1000).toISOString()  // 2-min cooldown
        : getNextUtcMidnightIso();                              // truly exhausted → midnight
      setQuotaPause('Received 429 from API-Football', resumeAt);
      if (!dailyOk || quotaState.dailyRemaining === 0) {
        emitQuotaNotice(
          'exhausted',
          'Quota expired: API-Football daily quota is exhausted. API calls are paused until next UTC day.'
        );
      }
      console.error(`⚠️  API 429 — pause until ${resumeAt} (daily remaining: ${quotaState.dailyRemaining ?? 'unknown'})`);
    }
    if (error.response?.status === 402) {
      setQuotaPause('API-Football subscription quota exhausted', getNextUtcMidnightIso());
      emitQuotaNotice(
        'exhausted',
        'Quota expired: API-Football subscription quota is exhausted. API calls are paused until next UTC day.'
      );
    }
    return [];
  }
}

const fixtureStatsCache = new Map();
const FIXTURE_STATS_CACHE_TTL = 30 * 1000;

async function fetchFixtureStatistics(fixtureId) {
  if (!API_KEY || !fixtureId || shouldSkipApiCalls()) return null;
  const cached = fixtureStatsCache.get(fixtureId);
  if (cached && (Date.now() - cached.ts) < FIXTURE_STATS_CACHE_TTL) return cached.data;

  try {
    const response = await axios.get(`${API_BASE}/fixtures/statistics`, {
      params: { fixture: fixtureId },
      headers: { 'x-apisports-key': API_KEY },
      timeout: 5000,
    });
    updateQuotaFromHeaders(response.headers);
    const rows = response.data?.response || [];
    if (!rows.length) return null;

    const homeStats = rows[0]?.statistics || [];
    const awayStats = rows[1]?.statistics || [];
    const getStat = (arr, key) => {
      const s = arr.find((x) => x.type === key);
      if (!s || s.value == null) return null;
      const parsed = typeof s.value === 'number' ? s.value : parseFloat(s.value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const stats = {
      possession: { home: getStat(homeStats, 'Ball Possession'), away: getStat(awayStats, 'Ball Possession') },
      shots: { home: getStat(homeStats, 'Shots on Goal'), away: getStat(awayStats, 'Shots on Goal') },
      totalShots: { home: getStat(homeStats, 'Total Shots'), away: getStat(awayStats, 'Total Shots') },
      xg: { home: getStat(homeStats, 'expected_goals'), away: getStat(awayStats, 'expected_goals') },
      cards: {
        home: { yellow: getStat(homeStats, 'Yellow Cards') || 0, red: getStat(homeStats, 'Red Cards') || 0 },
        away: { yellow: getStat(awayStats, 'Yellow Cards') || 0, red: getStat(awayStats, 'Red Cards') || 0 },
      },
    };

    fixtureStatsCache.set(fixtureId, { ts: Date.now(), data: stats });
    return stats;
  } catch (error) {
    if (error.response?.headers) updateQuotaFromHeaders(error.response.headers);
    return null;
  }
}

/**
 * Fetch ALL of today's fixtures from API-Football (one call, very cheap).
 * Returns raw API-Football fixture objects (not yet analyzed).
 */
async function fetchTodayFixturesFromApi() {
  if (!API_KEY || shouldSkipApiCalls()) return [];
  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[Calibrate] Fetching today's schedule from API-Football: ${today}`);
    const response = await axios.get(`${API_BASE}/fixtures`, {
      params: { date: today, timezone: 'UTC' },
      headers: { 'x-apisports-key': API_KEY },
      timeout: 10000,
    });
    updateQuotaFromHeaders(response.headers);
    const fixtures = response.data.response || [];
    console.log(`[Calibrate] API-Football: ${fixtures.length} fixtures for today`);
    return fixtures;
  } catch (err) {
    console.warn(`[Calibrate] API-Football today fetch failed: ${err.message}`);
    if (err.response?.headers) updateQuotaFromHeaders(err.response.headers);
    if (err.response?.status === 429 || err.response?.status === 402) {
      const dailyOk = quotaState.dailyRemaining === null || quotaState.dailyRemaining > API_DAILY_SOFT_STOP;
      const resumeAt = (err.response?.status === 402 || !dailyOk)
        ? getNextUtcMidnightIso()
        : new Date(Date.now() + 2 * 60 * 1000).toISOString();
      setQuotaPause('API-Football suspended/rate-limited', resumeAt);
      if (err.response?.status === 402 || !dailyOk || quotaState.dailyRemaining === 0) {
        emitQuotaNotice(
          'exhausted',
          'Quota expired: API-Football daily quota is exhausted. API calls are paused until next UTC day.'
        );
      }
    }
    return [];
  }
}



// TheSportsDB league name → leagueId fallback
const SPORTSDB_LEAGUE_MAP = {
  'english premier league': 39,   'premier league': 39,
  'spanish la liga': 140,         'la liga': 140,
  'german bundesliga': 78,        'bundesliga': 78,
  'italian serie a': 135,         'serie a': 135,
  'french ligue 1': 61,           'ligue 1': 61,
  'portuguese primeira liga': 94, 'primeira liga': 94,
  'turkish super lig': 203,       'sper lig': 203,
  'saudi professional league': 307, 'saudi pro league': 307,
  'champions league': 2,          'uefa champions league': 2,
  'europa league': 3,             'uefa europa league': 3,
  'conference league': 848,       'uefa europa conference league': 848,
  'russian premier league': 235,  'russian cup': 236,
  'turkish cup': 204,
  'world cup': 1,                 'fifa world cup': 1,
  'european championship': 4,
  'copa america': 9,
  'nations league': 16,           'uefa nations league': 16,
  'mls': 253,                     'major league soccer': 253,
  'scottish premiership': 179,
  'eredivisie': 88,
  'belgian pro league': 144,
  'brasileirao': 71,              'serie a (brazil)': 71,
  // ── Asia / Pacific ────────────────────────────────────────
  'chinese super league': 169,    'china super league': 169,
  'chinese football association super league': 169,
  'k league 1': 292,              'k-league 1': 292,
  'korean k league': 292,
  'j1 league': 98,                'j league': 98,
  'meiji yasuda j1 league': 98,
  'a-league': 188,                'a league': 188,
  'indonesian liga 1': 313,       'liga 1': 313,
  'afc champions league': 17,
  // ── International ─────────────────────────────────────────
  'international friendlies': 1,  'friendlies': 1,
  'international friendly': 1,
  // ── South America ─────────────────────────────────────────
  'argentine primera division': 128, 'superliga argentina': 128,
  'copa libertadores': 13,
  'copa sudamericana': 11,
};

function sportsDbLeagueToId(leagueName) {
  const key = (leagueName || '').toLowerCase().trim();
  for (const [name, id] of Object.entries(SPORTSDB_LEAGUE_MAP)) {
    if (key.includes(name) || name.includes(key)) return id;
  }
  return 0;
}

/**
 * Fetch today + tomorrow fixtures from TheSportsDB (free fallback when API-Football unavailable).
 */
async function fetchTodayFixturesFromSportsDB() {
  try {
    const today    = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    const [todayRes, tomorrowRes] = await Promise.all([
      axios.get('https://www.thesportsdb.com/api/v1/json/3/eventsday.php', { params: { d: today, s: 'Soccer' }, timeout: 10000 }),
      axios.get('https://www.thesportsdb.com/api/v1/json/3/eventsday.php', { params: { d: tomorrow, s: 'Soccer' }, timeout: 10000 }),
    ]);

    const todayEvents    = todayRes.data?.events    || [];
    const tomorrowEvents = tomorrowRes.data?.events || [];
    const events = [...todayEvents, ...tomorrowEvents];

    if (!events.length) {
      console.log('[Calibrate] TheSportsDB: no events for today or tomorrow');
      return [];
    }

    const fixtures = events
      .filter(e => e.strHomeTeam && e.strAwayTeam && e.strStatus !== 'Match Finished')
      .map(e => {
        const leagueId = sportsDbLeagueToId(e.strLeague || '');
        const kickoffUTC = (e.dateEvent && e.strTime) ? `${e.dateEvent}T${e.strTime}Z` : null;
        return {
          fixture: { id: e.idEvent, date: kickoffUTC },
          teams: {
            home: { name: e.strHomeTeam, id: null },
            away: { name: e.strAwayTeam, id: null },
          },
          league: {
            id:      leagueId,
            name:    e.strLeague || 'Unknown',
            country: e.strCountry || '',
          },
        };
      })
      .filter(f => !!f.teams.home.name && !!f.teams.away.name);

    console.log(`[Calibrate] TheSportsDB fallback: ${todayEvents.length} today + ${tomorrowEvents.length} tomorrow = ${fixtures.length} fixtures`);
    return fixtures;
  } catch (err) {
    console.warn(`[Calibrate] TheSportsDB fallback failed: ${err.message}`);
    return [];
  }
}

async function fetchUpcomingMatches() {
  if (!API_KEY) {
    console.warn('⚠️  API_FOOTBALL_KEY missing for upcoming feed; using TheSportsDB fallback');
    return await fetchTodayFixturesFromSportsDB();
  }

  if (shouldSkipApiCalls()) {
    const resumeMsg = quotaState.resumeAt ? ` until ${quotaState.resumeAt}` : '';
    console.warn(`⏸️  Skipping UPCOMING API call due to quota guard${resumeMsg}`);
    return await fetchTodayFixturesFromSportsDB();
  }

  try {
    const now = new Date();
    const toIsoDate = (d) => d.toISOString().split('T')[0];
    const isUpcomingStatus = (fixture) => {
      const status = String(fixture?.fixture?.status?.short || '').toUpperCase();
      return status === 'NS' || status === 'TBD' || status === 'PST';
    };

    // Primary strategy: ask API-Football for the next global fixtures directly.
    // This is broader and more reliable than day-bound windows.
    console.log('📅 Fetching global upcoming fixtures via next=200...');
    const nextRes = await axios.get(`${API_BASE}/fixtures`, {
      params: { next: 200, timezone: 'UTC' },
      headers: { 'x-apisports-key': API_KEY },
      timeout: 7000,
    });
    updateQuotaFromHeaders(nextRes.headers);

    const nextFixtures = (nextRes.data.response || []).filter(isUpcomingStatus);
    console.log(`📊 API next-window returned ${nextFixtures.length} upcoming fixtures`);
    if (nextFixtures.length > 0) {
      return nextFixtures;
    }

    const todayDate    = now.toISOString().split('T')[0];
    const tomorrowDate = toIsoDate(new Date(now.getTime() + 24 * 60 * 60 * 1000));

    console.log(`📅 Fetching upcoming matches for ${todayDate} + ${tomorrowDate}...`);

    // Fetch both dates and filter upcoming statuses locally. This avoids missing
    // fixtures when providers label them as TBD instead of NS.
    const [todayRes, tomorrowRes] = await Promise.all([
      axios.get(`${API_BASE}/fixtures`, {
        params: { date: todayDate, timezone: 'UTC' },
        headers: { 'x-apisports-key': API_KEY },
        timeout: 5000,
      }),
      axios.get(`${API_BASE}/fixtures`, {
        params: { date: tomorrowDate, timezone: 'UTC' },
        headers: { 'x-apisports-key': API_KEY },
        timeout: 5000,
      }),
    ]);
    updateQuotaFromHeaders(todayRes.headers);
    updateQuotaFromHeaders(tomorrowRes.headers);

    const todayFixtures    = (todayRes.data.response || []).filter(isUpcomingStatus);
    const tomorrowFixtures = (tomorrowRes.data.response || []).filter(isUpcomingStatus);
    const fixtures = [...todayFixtures, ...tomorrowFixtures];
    console.log(`📊 API returned ${todayFixtures.length} today + ${tomorrowFixtures.length} tomorrow = ${fixtures.length} upcoming fixtures`);

    if (fixtures.length > 0) {
      return fixtures;
    }

    // Fallback horizon: if today+tomorrow are empty, scan next few days so the UI
    // does not look "down" during calendar gaps or UTC boundary windows.
    const fallbackDates = [2, 3, 4, 5].map(days => toIsoDate(new Date(now.getTime() + days * 24 * 60 * 60 * 1000)));
    console.log(`📅 No NS fixtures in primary window; expanding search to ${fallbackDates.join(', ')}`);

    const fallbackResponses = await Promise.all(
      fallbackDates.map(date =>
        axios.get(`${API_BASE}/fixtures`, {
          params: { date, timezone: 'UTC' },
          headers: { 'x-apisports-key': API_KEY },
          timeout: 5000,
        })
      )
    );

    fallbackResponses.forEach(res => updateQuotaFromHeaders(res.headers));
    const fallbackFixtures = fallbackResponses
      .flatMap(res => res.data.response || [])
      .filter(isUpcomingStatus);
    console.log(`📊 Fallback window returned ${fallbackFixtures.length} upcoming fixtures`);

    if (fallbackFixtures.length > 0) {
      return fallbackFixtures;
    }

    // Final fallback: free public source to avoid empty portal when API-Football
    // has temporary schedule gaps or provider-side anomalies.
    const sportsDbFixtures = await fetchTodayFixturesFromSportsDB();
    if (sportsDbFixtures.length > 0) {
      console.log(`📊 TheSportsDB fallback returned ${sportsDbFixtures.length} upcoming fixtures`);
      return sportsDbFixtures;
    }

    return fallbackFixtures;
  } catch (error) {
    console.error('❌ Upcoming matches error:', error.message);
    if (error.response?.headers) {
      updateQuotaFromHeaders(error.response.headers);
    }
    if (error.response?.status === 429) {
      const dailyOk = quotaState.dailyRemaining === null || quotaState.dailyRemaining > API_DAILY_SOFT_STOP;
      const resumeAt = dailyOk
        ? new Date(Date.now() + 2 * 60 * 1000).toISOString()
        : getNextUtcMidnightIso();
      setQuotaPause('Received 429 from API-Football', resumeAt);
      if (!dailyOk || quotaState.dailyRemaining === 0) {
        emitQuotaNotice(
          'exhausted',
          'Quota expired: API-Football daily quota is exhausted. API calls are paused until next UTC day.'
        );
      }
    }
    if (error.response?.status === 402) {
      setQuotaPause('API-Football subscription quota exhausted', getNextUtcMidnightIso());
      emitQuotaNotice(
        'exhausted',
        'Quota expired: API-Football subscription quota is exhausted. API calls are paused until next UTC day.'
      );
    }

    // Error-path fallback: if API-Football times out or fails, still try
    // public source so the feed is not empty.
    const sportsDbFixtures = await fetchTodayFixturesFromSportsDB();
    if (sportsDbFixtures.length > 0) {
      console.log(`📊 TheSportsDB error-path fallback returned ${sportsDbFixtures.length} upcoming fixtures`);
      return sportsDbFixtures;
    }

    return [];
  }
}

/**
 * Pure helper: build the possession/shots/xg snapshot for a calibration fixture.
 * Exported so tests can assert no synthetic values are substituted.
 */
export function buildCalibrationSnapshotStats(f) {
  return {
    possession: { home: null, away: null },
    shots:      { home: null, away: null },
    xg:         { home: f?.home?.xgAvg ?? null, away: f?.away?.xgAvg ?? null },
  };
}

// Strip non-primitive values from match object (prevents React errors)
function sanitizeMatch(match) {
  const numOrNull = (v) => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    id: match.id || 0,
    home: String(match.home || ''),
    away: String(match.away || ''),
    score: String(match.score || '0-0'),
    possession: {
      home: numOrNull(match.possession?.home),
      away: numOrNull(match.possession?.away),
    },
    shots: {
      home: numOrNull(match.shots?.home),
      away: numOrNull(match.shots?.away),
    },
    xg: {
      home: numOrNull(match.xg?.home),
      away: numOrNull(match.xg?.away),
    },
    status: String(match.status || ''),
    matchMinutes: Number(match.matchMinutes || 0),
    confidence: Number(match.confidence || 0),
    decisionProbability: numOrNull(match.decisionProbability),
    opportunities: Array.isArray(match.opportunities) ? match.opportunities.map(String) : [],
    league: String(match.league || 'Unknown'),
    leagueId: Number(match.leagueId || 0),
    matchType: String(match.matchType || 'League'),
    leagueCountry: String(match.leagueCountry || ''),
    homePosition: numOrNull(match.homePosition),
    awayPosition: numOrNull(match.awayPosition),
    homePoints: numOrNull(match.homePoints),
    awayPoints: numOrNull(match.awayPoints),
    totalTeams: numOrNull(match.totalTeams),
    season: match.season ?? null,
    homeTeamId: match.homeTeamId || null,
    awayTeamId: match.awayTeamId || null,
    cards: {
      home: { yellow: Number(match.cards?.home?.yellow || 0), red: Number(match.cards?.home?.red || 0) },
      away: { yellow: Number(match.cards?.away?.yellow || 0), red: Number(match.cards?.away?.red || 0) },
    },
  };
}

// ─── LIVE-DATA BLENDING HELPERS ─────────────────────────────────────────────
// Both functions implement the same principle:
//   season avg = a strong prior built from many games;
//   live observation = evidence accumulated so far this match.
//   The prior is assigned a "priorStrength" in equivalent minutes so its weight
//   decays relative to live data as the match progresses.
//
// Count stats (shots, xG, goals) follow a Poisson process.
// Bayesian conjugate update with Gamma(α, β) prior gives:
//   posterior_rate_per_90 = (seasonAvg * N + liveCount * 90) / (N + elapsedMin)
// where N = priorStrength = minutes equivalent of season-level confidence.
//
// Proportion stats (possession %) use the same weighted-mean formula:
//   posterior_pct = (seasonAvg * N + livePct * elapsedMin) / (N + elapsedMin)
//
// Recommended prior strengths (calibrated to typical within-game variance):
//   xG / goals  → N =  90 min (1 full game) — converges fast; xG reflects current tactics
//   Shots total → N = 180 min (2 full games) — moderately stable; game plan can shift
//   Possession  → N = 360 min (4 full games) — very stable team characteristic

/**
 * Bayesian Poisson blend for count-based stats (shots, xG, goals).
 * @param {number} seasonAvg    - season average per 90 min
 * @param {number} liveCount    - cumulative count observed this match
 * @param {number} elapsedMin   - minutes elapsed
 * @param {number} priorStrength - equivalent game-minutes of prior confidence
 * @returns {number} blended value per 90 min
 */
function blendCountStat(seasonAvg, liveCount, elapsedMin, priorStrength) {
  if (!elapsedMin || elapsedMin <= 0) return seasonAvg;
  return (seasonAvg * priorStrength + liveCount * 90) / (priorStrength + elapsedMin);
}

/**
 * Weighted-average blend for proportion stats (possession %).
 * @param {number} seasonAvg    - season average proportion (0–100)
 * @param {number} livePct      - live observed proportion (0–100)
 * @param {number} elapsedMin   - minutes elapsed
 * @param {number} priorStrength - equivalent game-minutes of prior confidence
 * @returns {number} blended proportion
 */
function blendPctStat(seasonAvg, livePct, elapsedMin, priorStrength) {
  if (!elapsedMin || elapsedMin <= 0) return seasonAvg;
  return (seasonAvg * priorStrength + livePct * elapsedMin) / (priorStrength + elapsedMin);
}

function getLivePhase(matchMinutes = 0) {
  if (matchMinutes < 25) return 'EARLY';
  if (matchMinutes < 70) return 'MID';
  return 'LATE';
}

function phaseBlendCountStat(seasonAvg, liveCount, elapsedMin, priorStrength) {
  if (liveCount == null || liveCount <= 0) return seasonAvg;
  const phase = getLivePhase(elapsedMin);
  if (phase === 'LATE') return liveCount;
  if (phase === 'MID') return blendCountStat(seasonAvg, liveCount, elapsedMin, priorStrength);
  return blendCountStat(seasonAvg, liveCount, elapsedMin, priorStrength * 1.8);
}

function phaseBlendPctStat(seasonAvg, livePct, elapsedMin, priorStrength) {
  if (livePct == null || livePct <= 0) return seasonAvg;
  const phase = getLivePhase(elapsedMin);
  if (phase === 'LATE') return livePct;
  if (phase === 'MID') return blendPctStat(seasonAvg, livePct, elapsedMin, priorStrength);
  return blendPctStat(seasonAvg, livePct, elapsedMin, priorStrength * 1.8);
}

/**
 * Lightweight fixture parser — extracts display fields from a raw API-Football
 * fixture object without making ANY additional API calls.
 * Used for upcoming matches on cold start (calibration store empty).
 * These entries are flagged _lite:true and replaced once calibration runs.
 */
function parseLightFixture(match) {
  try {
    const fixture = match.fixture || {};
    const teams   = match.teams   || {};
    const league  = match.league  || {};
    const goals   = match.goals   || {};

    let statusStr = 'NS';
    if (typeof fixture.status === 'object' && fixture.status?.short) {
      statusStr = fixture.status.short;
    } else if (typeof fixture.status === 'string') {
      statusStr = fixture.status;
    }

    const homeId = teams.home?.id   || null;
    const awayId = teams.away?.id   || null;
    const hName  = teams.home?.name || 'Unavailable';
    const aName  = teams.away?.name || 'Unavailable';
    const hGoals = goals.home ?? 0;
    const aGoals = goals.away ?? 0;

    return {
      id:            fixture.id || `${homeId || hName}-${awayId || aName}-${(fixture.date || '').split('T')[0]}`,
      home:          hName,
      away:          aName,
      homeTeamId:    homeId,
      awayTeamId:    awayId,
      score:         `${hGoals}-${aGoals}`,
      status:        statusStr,
      matchMinutes:  fixture.status?.elapsed || 0,
      kickoffUTC:    fixture.date || null,
      league:        league.name  || 'Unavailable',
      leagueId:      league.id    || 0,
      leagueCountry: league.country || '',
      season:         league.season ?? null,
      confidence:    null,
      opportunities: [],
      possession:    { home: null, away: null },
      shots:         { home: null, away: null },
      xg:            { home: null, away: null },
      _lite:         true,
    };
  } catch {
    return null;
  }
}

// Rotate deep background enrichment instead of enriching every live fixture at once.
// Every live fixture is still visible immediately; fixtures outside this window are
// enriched on later cycles or on-demand when the user opens them.
let liveEnrichmentCursor = 0;
const LIVE_BACKGROUND_ENRICH_LIMIT = Math.max(
  1,
  Number(process.env.LIVE_BACKGROUND_ENRICH_LIMIT || 12),
);

function pickLiveBackgroundEnrichment(matches = []) {
  if (!Array.isArray(matches) || matches.length === 0) return [];
  const limit = Math.min(LIVE_BACKGROUND_ENRICH_LIMIT, matches.length);
  const picked = [];
  for (let i = 0; i < limit; i++) {
    picked.push(matches[(liveEnrichmentCursor + i) % matches.length]);
  }
  liveEnrichmentCursor = (liveEnrichmentCursor + limit) % matches.length;
  return picked;
}

/**
 * Process raw API-Football match objects through analyzeMatch() in small batches.
 * API calls inside analyticsService are additionally deduplicated and paced.
 */
async function batchAnalyze(matches, batchSize = 2) {
  const results = [];
  for (let i = 0; i < matches.length; i += batchSize) {
    const batch = matches.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(analyzeMatch));
    results.push(...batchResults);
    // Small inter-batch gap only when more batches remain — avoids minute-limit spikes
    if (i + batchSize < matches.length) {
      await new Promise(r => setTimeout(r, 800));
    }
  }
  return results.filter(m => m !== null);
}

// Analyze match for betting opportunities
async function analyzeMatch(match) {
  try {
    const fixture = match.fixture || {};
    const goals = match.goals || {};
    const stats = match.statistics || [];

    // ── Per-match analysis cache ──────────────────────────────────────────────
    // The 8 API calls (form, H2H, standings, stats×2, injuries×2) are expensive.
    // Reuse cached analysis if the score hasn't changed and it's < 5 minutes old.
    const matchId = fixture.id;
    const currentScore = `${goals.home ?? 0}-${goals.away ?? 0}`;
    if (matchId) {
      const cached = liveAnalysisCache.get(matchId);
      if (cached && cached.score === currentScore && (Date.now() - cached.timestamp) < LIVE_ANALYSIS_CACHE_TTL) {
        // Update only real-time fields; keep expensive analysis from cache
        const homeStats = (stats && stats[0]) ? stats[0].statistics || [] : [];
        const awayStats = (stats && stats[1]) ? stats[1].statistics || [] : [];
        const getStat = (arr, key) => {
          const s = arr.find(s => s.type === key);
          if (!s || s.value == null) return null;
          const parsed = typeof s.value === 'number' ? s.value : parseFloat(s.value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const getStatZero = (arr, key) => {
          const v = getStat(arr, key);
          return v == null ? 0 : v;
        };
        const liveElapsed = typeof fixture.status === 'object' ? (fixture.status?.elapsed || 0) : 0;
        return {
          ...cached.result,
          score: currentScore,
          matchMinutes: liveElapsed || cached.result.matchMinutes,
          possession: { home: getStat(homeStats, 'Ball Possession'), away: getStat(awayStats, 'Ball Possession') },
          shots:       { home: getStat(homeStats, 'Shots on Goal'),   away: getStat(awayStats, 'Shots on Goal') },
          xg:          { home: getStat(homeStats, 'expected_goals'),  away: getStat(awayStats, 'expected_goals') },
          cards: {
            home: { yellow: getStatZero(homeStats, 'Yellow Cards'), red: getStatZero(homeStats, 'Red Cards') },
            away: { yellow: getStatZero(awayStats, 'Yellow Cards'), red: getStatZero(awayStats, 'Red Cards') },
          },
        };
      }
    }
    const teams = match.teams || {};
    const league = match.league || {};

    const homeStats = (stats && stats[0]) ? stats[0].statistics || [] : [];
    const awayStats = (stats && stats[1]) ? stats[1].statistics || [] : [];

    const getStat = (stats, key) => {
      const s = stats.find((s) => s.type === key);
      if (!s || s.value === null || s.value === undefined) return null;
      const parsed = typeof s.value === 'number' ? s.value : parseFloat(s.value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const getStatZero = (stats, key) => {
      const v = getStat(stats, key);
      return v == null ? 0 : v;
    };

    const possession = {
      home: getStat(homeStats, 'Ball Possession'),
      away: getStat(awayStats, 'Ball Possession'),
    };

    const shots = {
      home: getStat(homeStats, 'Shots on Goal'),
      away: getStat(awayStats, 'Shots on Goal'),
    };

    // Total shots (not just on-goal) — consistent basis for season-avg blend
    const totalShots = {
      home: getStat(homeStats, 'Total Shots'),
      away: getStat(awayStats, 'Total Shots'),
    };

    const xg = {
      home: getStat(homeStats, 'expected_goals'),
      away: getStat(awayStats, 'expected_goals'),
    };

    const cards = {
      home: { yellow: getStatZero(homeStats, 'Yellow Cards'), red: getStatZero(homeStats, 'Red Cards') },
      away: { yellow: getStatZero(awayStats, 'Yellow Cards'), red: getStatZero(awayStats, 'Red Cards') },
    };

    // Calculate match elapsed time (approximate from fixture)
    const now = new Date();
    const kickoffTime = fixture.date ? new Date(fixture.date) : now;
    const matchMinutesElapsed = Math.max(0, Math.floor((now - kickoffTime) / 60000));

    // Determine match type from league name and round
    let matchType = 'League';
    const leagueName = (league.name || '').toLowerCase();
    const round = (league.round || '').toLowerCase();
    
    if (leagueName.includes('friendly') || leagueName.includes('international')) {
      matchType = 'Friendly';
    } else if (round.includes('qualifier')) {
      matchType = 'Qualifier';
    } else if (leagueName.includes('cup') || leagueName.includes('champion')) {
      matchType = 'Cup';
    }

    // Get status - handle both string and object format
    let statusStr = 'NS';
    if (typeof fixture.status === 'object' && fixture.status?.short) {
      statusStr = fixture.status.short; // '1H', 'HT', '2H', 'NS', 'FT', etc.
    } else if (typeof fixture.status === 'string') {
      statusStr = fixture.status;
    }
    // API-Football NEVER sends 'LIVE' — in-play codes are '1H', 'HT', '2H', 'ET', etc.
    const LIVE_CODES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE']);
    const normalizedStatus = LIVE_CODES.has(statusStr) ? 'LIVE' : statusStr;
    // Use API-provided elapsed minute (accurate) over kickoff-time calculation (can drift)
    const liveElapsed = typeof fixture.status === 'object' ? (fixture.status?.elapsed || 0) : 0;

    // ── V9-powered confidence scoring ──────────────────────────────────────────
    // Priority 1: calibration store lookup (home+away name match) — reuses pre-computed V9.
    // Priority 2: V9 with live stats + real form/standings fetched from API-Football.
    const normalize = (s) => (s || '').toLowerCase().trim();
    const homeN = normalize(teams.home?.name);
    const awayN = normalize(teams.away?.name);
    const calMatch = calibrationStore.matches.find(m =>
      normalize(m.home) === homeN && normalize(m.away) === awayN
    );

    let confidence, opportunitiesArr, analysisObj, kickoffUTC;

    if (calMatch && normalizedStatus !== 'LIVE') {
      // Pre-match only: reuse Gemini-enriched calibration analysis
      confidence       = calMatch.confidence;
      opportunitiesArr = calMatch.opportunities || [];
      analysisObj      = calMatch.analysis || null;
      kickoffUTC       = calMatch.kickoffUTC || fixture.date || null;
    } else {
      // Live match (always fresh) or no calibration — run V9 with actual live data
      const liveMin = liveElapsed || matchMinutesElapsed || 0;

      // ── Fetch real team form, H2H + league standings from API-Football (cached) ──
      let homeFormStr = null;
      let awayFormStr = null;
      let h2hHistory = [];
      let homePosition = null, awayPosition = null, homePoints = null, awayPoints = null, totalTeams = null;
      let gameWeek = null;
      let homeAvgGF = null, homeAvgGA = null, awayAvgGF = null, awayAvgGA = null;
      let homeSampleSize = null, awaySampleSize = null;
      let homeGoalDrought = 0, awayGoalDrought = 0, homeRecentLosses = 0, awayRecentLosses = 0;
      let homeConversionPct = null, awayConversionPct = null;
      let homeSeasonShots = null, awaySeasonShots = null;
      let homeSeasonPossession = null;
      let homeLateGoalPct = null, awayLateGoalPct = null;
      let homeSquadIntegrity = null, awaySquadIntegrity = null;
      let homeKeyAbsences = [], awayKeyAbsences = [];
      const homeTeamId = teams.home?.id;
      const awayTeamId = teams.away?.id;
      if (homeTeamId && awayTeamId) {
        const [hRes, aRes, standingsRes, hStatsRes, aStatsRes, hInjRes, aInjRes] = await Promise.allSettled([
          getTeamForm(homeTeamId, league.id, league.season ?? null),
          getTeamForm(awayTeamId, league.id, league.season ?? null),
          getStandings({ leagueId: league.id, season: league.season ?? null, homeTeamId, awayTeamId }),
          getTeamStatistics(homeTeamId, league.id, league.season ?? null),
          getTeamStatistics(awayTeamId, league.id, league.season ?? null),
          getTeamInjuries(homeTeamId, league.id, league.season ?? null),
          getTeamInjuries(awayTeamId, league.id, league.season ?? null),
        ]);
        // Convert 'WWDLWWDLWW' → 'W-W-D-L-W-W-D-L-W-W' for parseForm()
        if (hRes.status === 'fulfilled' && !hRes.value?.offline && hRes.value?.stats) {
          const hs = hRes.value.stats;
          if (hs.form)  homeFormStr      = hs.form.split('').join('-');
          homeSampleSize = Array.isArray(hRes.value.matches) ? hRes.value.matches.length : null;
          if (parseFloat(hs.avgGoalsFor)     >= 0) homeAvgGF        = parseFloat(hs.avgGoalsFor);
          if (parseFloat(hs.avgGoalsAgainst) >= 0) homeAvgGA = parseFloat(hs.avgGoalsAgainst);
          if (hs.goalDrought  != null) homeGoalDrought  = hs.goalDrought;
          if (hs.recentLosses != null) homeRecentLosses = hs.recentLosses;
          if (hs.recentOpposition) match.homeRecentOpposition = hs.recentOpposition;
        }
        if (aRes.status === 'fulfilled' && !aRes.value?.offline && aRes.value?.stats) {
          const as = aRes.value.stats;
          if (as.form)  awayFormStr      = as.form.split('').join('-');
          awaySampleSize = Array.isArray(aRes.value.matches) ? aRes.value.matches.length : null;
          if (parseFloat(as.avgGoalsFor)     >= 0) awayAvgGF        = parseFloat(as.avgGoalsFor);
          if (parseFloat(as.avgGoalsAgainst) >= 0) awayAvgGA = parseFloat(as.avgGoalsAgainst);
          if (as.goalDrought  != null) awayGoalDrought  = as.goalDrought;
          if (as.recentLosses != null) awayRecentLosses = as.recentLosses;
          if (as.recentOpposition) match.awayRecentOpposition = as.recentOpposition;
        }
        // V10.1: aggregate H2H counts are not converted into invented scorelines.
        // H2H remains optional until exact historical fixture rows are oriented safely
        // relative to the current home/away teams.
        h2hHistory = [];
        // Real league standings — position, points and gameWeek for P1/P14
        if (standingsRes.status === 'fulfilled' && standingsRes.value?.status === 'AVAILABLE' && standingsRes.value?.teams) {
          const tms = standingsRes.value.teams;
          totalTeams = standingsRes.value.totalTeams || null;
          if (tms[homeTeamId]) { homePosition = tms[homeTeamId].position ?? null; homePoints = tms[homeTeamId].points ?? null; }
          if (tms[awayTeamId]) { awayPosition = tms[awayTeamId].position ?? null; awayPoints = tms[awayTeamId].points ?? null; }
          const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
          if (played > 0) gameWeek = played;
        }
        // Season team statistics: conversion rate, shots/game, possession (P10 Pace + P11 HomeAdv)
        if (hStatsRes.status === 'fulfilled' && !hStatsRes.value?.offline && hStatsRes.value?.stats) {
          const hs = hStatsRes.value.stats;
          if (hs.conversionPct != null) homeConversionPct    = hs.conversionPct;
          if (hs.avgShotsTotal >  0)    homeSeasonShots      = hs.avgShotsTotal;
          if (hs.avgPossession != null) homeSeasonPossession = hs.avgPossession;
          if (hs.lateGoalPct   != null) homeLateGoalPct      = hs.lateGoalPct;
        }
        if (aStatsRes.status === 'fulfilled' && !aStatsRes.value?.offline && aStatsRes.value?.stats) {
          const as = aStatsRes.value.stats;
          if (as.conversionPct != null) awayConversionPct = as.conversionPct;
          if (as.avgShotsTotal >  0)    awaySeasonShots   = as.avgShotsTotal;
          if (as.lateGoalPct   != null) awayLateGoalPct   = as.lateGoalPct;
        }
        // Squad integrity + key absences for P2 Star Power position-weighted impact
        if (hInjRes.status === 'fulfilled' && !hInjRes.value?.offline) {
          if (hInjRes.value.squadIntegrity != null) homeSquadIntegrity = hInjRes.value.squadIntegrity;
          if (hInjRes.value.keyAbsences?.length)   homeKeyAbsences    = hInjRes.value.keyAbsences;
        }
        if (aInjRes.status === 'fulfilled' && !aInjRes.value?.offline) {
          if (aInjRes.value.squadIntegrity != null) awaySquadIntegrity = aInjRes.value.squadIntegrity;
          if (aInjRes.value.keyAbsences?.length)   awayKeyAbsences    = aInjRes.value.keyAbsences;
        }
      }

      const matchData = {
        home: teams.home?.name || 'Unknown',
        away: teams.away?.name || 'Unknown',
        league: league.name || 'Unknown',
        leagueId: league.id || 0,
        season: league.season ?? null,
        country: league.country || '',
        round: league.round || '',
        isKnockout: round.includes('knockout') || round.includes('round of') || round.includes('quarter') || round.includes('semi') || round.includes('final'),
        notes: league.type || '',
        matchType,
        status: normalizedStatus,   // 'LIVE' for in-play — triggers live logic in agent47
        matchMinutes: liveMin,
        score: `${goals.home || 0}-${goals.away || 0}`,
        // ── Live-data blending: Bayesian update of season averages with match evidence ──
        // Pre-match (NS): season avg only. Live: blend decaying toward live observation.
        // See blendCountStat / blendPctStat for derivation and prior-strength rationale.
        ...(() => {
          const isLive = normalizedStatus === 'LIVE' && liveMin > 0;
          // homeXgAvg: genuine in-play xG from API-Football only; null otherwise.
          // Goals-per-game (homeAvgGF) is fed to homeGoalsAvgFor below — not here.
          const hXgAvg  = xg.home != null && xg.home > 0 ? xg.home : null;
          const aXgAvg  = xg.away != null && xg.away > 0 ? xg.away : null;
          const hXgaAvg = xg.away != null && xg.away > 0 ? xg.away : null;
          const aXgaAvg = xg.home != null && xg.home > 0 ? xg.home : null;
          // Shots per game — N=180 (moderately stable; tactical changes take time)
          const baseHomeShots = homeSeasonShots ?? null;
          const baseAwayShots = awaySeasonShots ?? null;
          const hShots  = isLive && totalShots.home != null
            ? (baseHomeShots != null ? phaseBlendCountStat(baseHomeShots, totalShots.home, liveMin, 180) : null)
            : baseHomeShots;
          const aShots  = isLive && totalShots.away != null
            ? (baseAwayShots != null ? phaseBlendCountStat(baseAwayShots, totalShots.away, liveMin, 180) : null)
            : baseAwayShots;
          // Possession: only blend if we have a season baseline; live-only when baseline is missing
          const hPoss   = isLive && possession.home != null
            ? (homeSeasonPossession != null ? phaseBlendPctStat(homeSeasonPossession, possession.home, liveMin, 360) : possession.home)
            : (homeSeasonPossession ?? null);
          return {
            homeXgAvg: hXgAvg, awayXgAvg: aXgAvg,
            homeXgaAvg: hXgaAvg, awayXgaAvg: aXgaAvg,
            homeShotsPerGame: hShots, awayShotsPerGame: aShots,
            homePossession: hPoss,
          };
        })(),
        // Season goal averages fed to P4 coiled spring and P6 defensive gap (unchanged)
        homeGoalsAvgFor:     homeAvgGF,
        awayGoalsAvgFor:     awayAvgGF,
        homeSampleSize,
        awaySampleSize,
        homeGoalsAvgAgainst: homeAvgGA,
        awayGoalsAvgAgainst: awayAvgGA,
        homeConversionPct,
        awayConversionPct,
        homeForm:  homeFormStr,
        awayForm:  awayFormStr,
        h2hHistory,
        homePosition,
        awayPosition,
        homePoints,
        awayPoints,
        totalTeams,
        gameWeek,
        totalGW: (totalTeams != null && totalTeams > 1) ? (totalTeams - 1) * 2 : null,
        homeSquadIntegrity,
        awaySquadIntegrity,
        homeKeyAbsences,
        awayKeyAbsences,
        homeLateGoalPct,
        awayLateGoalPct,
        homeCards: cards.home,
        awayCards: cards.away,
        homeGoalDrought,
        awayGoalDrought,
        homeRecentLosses,
        awayRecentLosses,
        homeRecentOpposition: match.homeRecentOpposition || null,
        awayRecentOpposition: match.awayRecentOpposition || null,
      };
      try {
        analysisObj      = analyzeV9(matchData);
        confidence       = getTopExecutableRecommendation({ home: teams.home?.name, away: teams.away?.name, analysis: analysisObj })?.probability || 0;
        opportunitiesArr = (analysisObj.recommendations || []).slice(0, 2).map(r => r.selection || r.label || '');
      } catch (v9Err) {
        console.warn(`[analyzeMatch] V9 error for ${teams.home?.name} vs ${teams.away?.name}: ${v9Err.message} — dropping match`);
        return null; // Unanalyzable match must not enter the pool with a fake confidence
      }
      kickoffUTC = fixture.date || null;
    }

    const analyzed = {
      id: fixture.id || `${teams.home?.id || ''}-${teams.away?.id || ''}-${(fixture.date || '').slice(0, 10)}`,
      homeTeamId: teams.home?.id || null,
      awayTeamId: teams.away?.id || null,
      home: teams.home?.name || 'Unknown',
      away: teams.away?.name || 'Unknown',
      score: `${goals.home || 0}-${goals.away || 0}`,
      possession,
      shots,
      xg,
      status: statusStr,
      isLive: normalizedStatus === 'LIVE',
      matchMinutes: liveElapsed || matchMinutesElapsed || 0,
      confidence: confidence > 0 ? Math.min(Math.max(Math.round(confidence), 10), 98) : 0,
      decisionProbability: confidence > 0 ? Math.min(Math.max(Math.round(confidence), 10), 98) : 0,
      opportunities: opportunitiesArr.filter(Boolean),
      league: league.name || 'Unknown',
      leagueId: league.id || 0,
      season: league.season ?? null,
      matchType,
      leagueCountry: league.country || '',
      homePosition: analysisObj?.match?.homePosition ?? calMatch?.homePosition ?? null,
      awayPosition: analysisObj?.match?.awayPosition ?? calMatch?.awayPosition ?? null,
      homePoints: analysisObj?.match?.homePoints ?? calMatch?.homePoints ?? null,
      awayPoints: analysisObj?.match?.awayPoints ?? calMatch?.awayPoints ?? null,
      totalTeams: analysisObj?.match?.totalTeams ?? calMatch?.totalTeams ?? null,
      cards,
      homeConversionPct: analysisObj?.predictionCore?.inputSummary?.homeConversionPct ?? null,
      awayConversionPct: analysisObj?.predictionCore?.inputSummary?.awayConversionPct ?? null,
    };
    
    const result = sanitizeMatch(analyzed);
    if (analysisObj) result.analysis = analysisObj;
    if (kickoffUTC) result.kickoffUTC = kickoffUTC;
    // Store in per-match cache so the next poll reuses this analysis
    if (matchId) {
      liveAnalysisCache.set(matchId, { result, score: currentScore, timestamp: Date.now() });
    }
    return result;
  } catch (error) {
    console.error('❌ Error analyzing match:', error.message);
    const fixture = match.fixture || {};
    const goals = match.goals || {};
    const teams = match.teams || {};
    const league = match.league || {};
    const statusStr = typeof fixture.status === 'object' && fixture.status?.short
      ? fixture.status.short
      : String(fixture.status || 'NS');

    // Fail open for live fixtures: keep the match visible even if enrichment/V9 fails.
    return sanitizeMatch({
      id: fixture.id || `${teams.home?.id || ''}-${teams.away?.id || ''}-${(fixture.date || '').slice(0, 10)}`,
      homeTeamId: teams.home?.id || null,
      awayTeamId: teams.away?.id || null,
      home: teams.home?.name || 'Unknown',
      away: teams.away?.name || 'Unknown',
      score: `${goals.home || 0}-${goals.away || 0}`,
      possession: { home: null, away: null },
      shots: { home: null, away: null },
      xg: { home: null, away: null },
      status: statusStr,
      matchMinutes: typeof fixture.status === 'object' ? (fixture.status?.elapsed || 0) : 0,
      confidence: 0,
      decisionProbability: null,
      opportunities: [],
      league: league.name || 'Unknown',
      leagueId: league.id || 0,
      matchType: 'League',
      leagueCountry: league.country || '',
      cards: {
        home: { yellow: 0, red: 0 },
        away: { yellow: 0, red: 0 },
      },
    });
  }
}

// ─── LIVE POLLER (with smart response caching) ──────────────────────────

let isPolling = false;

// Prevent concurrent Gemini calls — only one at a time to avoid rate-limit spikes
let geminiLock = false;
async function withGeminiLock(fn) {
  if (geminiLock) {
    console.log('[Gemini] Skipping — another Gemini call already in progress');
    return [];
  }
  geminiLock = true;
  try {
    return await fn();
  } finally {
    geminiLock = false;
  }
}

async function pollLiveMatches({ forceApi = false, enrich = false } = {}) {
  if (isPolling) {
    console.log('⏳ Polling already in progress, skipping...');
    return;
  }

  const pollStarted = Date.now();
  livePollMetrics.lastStartedAt = new Date(pollStarted).toISOString();
  livePollMetrics.lastError = null;
  livePollMetrics.lastSourceCount = 0;
  livePollMetrics.lastAnalyzedCount = 0;
  livePollMetrics.lastUsedCache = false;
  
  // Check cache first
  const cached = forceApi ? null : getCached('liveMatches');
  if (cached !== null) {
    livePollMetrics.lastUsedCache = true;
    livePollMetrics.lastAnalyzedCount = cached.length;
    livePollMetrics.lastCompletedAt = new Date().toISOString();
    livePollMetrics.lastDurationMs = Date.now() - pollStarted;
    if (cached.length > 0) {
      liveMatches = cached;
      broadcast({ type: 'LIVE_MATCHES', payload: liveMatches });
    }
    return;
  }

  isPolling = true;

  try {
    let processedMatches = [];

    if (API_KEY && !shouldSkipApiCalls()) {
      // ── API-Football mode only — no Gemini fallback for live scores ──────
      // Gemini has no real-time score data; fabricated live games mislead users.
      const matches = await fetchLiveMatches();
      livePollMetrics.lastSourceCount = Array.isArray(matches) ? matches.length : 0;

      // First paint: publish every authoritative live fixture immediately with
      // score/status/minute. Reuse a prior analysis only when the score is unchanged.
      const previousById = new Map(
        (Array.isArray(liveMatches) ? liveMatches : []).map((m) => [String(m.id), m])
      );
      const lightweightLive = (matches || [])
        .map(parseLightFixture)
        .filter(Boolean)
        .map((lite) => {
          const previous = previousById.get(String(lite.id));
          const gfAge = previous?.goalFest?.evaluatedAt
            ? Date.now() - Date.parse(previous.goalFest.evaluatedAt)
            : Number.POSITIVE_INFINITY;
          const recentGoalFest = previous?.goalFest && gfAge < GOAL_FEST_SCAN_SECONDS * 1500
            ? previous.goalFest
            : null;
          if (!previous || previous.score !== lite.score) return lite;
          if (!previous.analysis) {
            return recentGoalFest ? { ...lite, goalFest:recentGoalFest, _staleGoalFest:true } : lite;
          }
          return {
            ...lite,
            confidence: previous.confidence ?? lite.confidence,
            decisionProbability: previous.decisionProbability ?? lite.decisionProbability,
            opportunities: previous.opportunities || [],
            possession: previous.possession || lite.possession,
            shots: previous.shots || lite.shots,
            xg: previous.xg || lite.xg,
            goalFest: recentGoalFest || null,
            analysis: previous.analysis,
            _lite: false,
            _staleAnalysis: true,
          };
        });

      if (lightweightLive.length > 0) {
        liveMatches = lightweightLive;
        broadcast({ type: 'LIVE_MATCHES', payload: liveMatches });
      }

      // Deep enrichment is deliberately rotated across a bounded window.
      // Clicking any non-enriched match still triggers on-demand analysis.
      const enrichmentBatch = enrich ? pickLiveBackgroundEnrichment(matches || []) : [];
      const enrichedSubset = enrichmentBatch.length > 0
        ? await batchAnalyze(enrichmentBatch, 2)
        : [];
      const enrichedById = new Map(enrichedSubset.map((m) => [String(m.id), m]));

      processedMatches = lightweightLive.map(
        (lite) => enrichedById.get(String(lite.id)) || lite
      );
      livePollMetrics.lastAnalyzedCount = enrichedSubset.length;
    }
    // If API-Football quota is exhausted or unavailable, live tab stays empty.
    // Real-time scores require a real-time source.
    
    if (processedMatches.length > 0) {
      liveMatches = processedMatches;
      setCache('liveMatches', liveMatches);
      broadcast({ type: 'LIVE_MATCHES', payload: liveMatches });
      console.log(`✓ Updated ${liveMatches.length} live matches`);
    } else {
      console.log('ℹ️  No live matches right now');
      liveMatches = [];
      setCache('liveMatches', []);
      broadcast({ type: 'LIVE_MATCHES', payload: [] });
    }
  } catch (error) {
    console.error('❌ Poll error:', error.message);
    livePollMetrics.lastError = error.message;
  } finally {
    livePollMetrics.lastCompletedAt = new Date().toISOString();
    livePollMetrics.lastDurationMs = Date.now() - pollStarted;
    isPolling = false;
  }
}

let portalLiveRefreshPromise = null;
let lastPortalLiveRefreshAt = 0;

async function refreshLiveOnPortalOpen() {
  if (!API_KEY || shouldSkipApiCalls()) return liveMatches;

  const now = Date.now();
  if (portalLiveRefreshPromise) return portalLiveRefreshPromise;
  if (lastPortalLiveRefreshAt > 0 && (now - lastPortalLiveRefreshAt) < PORTAL_OPEN_REFRESH_COOLDOWN_MS) {
    return liveMatches;
  }

  lastPortalLiveRefreshAt = now;
  portalLiveRefreshPromise = pollLiveMatches({ forceApi: true, enrich: false })
    .then(() => liveMatches)
    .finally(() => { portalLiveRefreshPromise = null; });
  return portalLiveRefreshPromise;
}

// V10.5A: one shared lightweight refresh for all connected portal users.
// This spends ONE global live-fixture request per interval, not one request per match
// and not one request per browser. Deep enrichment is deliberately disabled here.
let portalActiveLiveRefreshInFlight = false;

async function refreshLiveForConnectedPortals() {
  if (clients.size === 0 || !API_KEY || shouldSkipApiCalls() || portalActiveLiveRefreshInFlight) {
    return;
  }

  // Portal-open/manual refresh may already have fetched fresh data. Avoid a near-duplicate call.
  const cacheAgeMs = cache.liveMatches.timestamp > 0
    ? Date.now() - cache.liveMatches.timestamp
    : Number.POSITIVE_INFINITY;
  if (cacheAgeMs < PORTAL_ACTIVE_LIVE_REFRESH_SECONDS * 1000) {
    return;
  }

  portalActiveLiveRefreshInFlight = true;
  try {
    await pollLiveMatches({ forceApi: true, enrich: false });
    await runGoalFestSignalScan('portal-active');
  } catch (err) {
    console.warn('[LiveRefresh] Shared portal refresh failed:', err.message);
  } finally {
    portalActiveLiveRefreshInFlight = false;
  }
}

setInterval(() => {
  refreshLiveForConnectedPortals().catch((err) =>
    console.warn('[LiveRefresh] Timer error:', err.message)
  );
}, PORTAL_ACTIVE_LIVE_REFRESH_SECONDS * 1000);

console.log(
  `   Portal live refresh: every ${PORTAL_ACTIVE_LIVE_REFRESH_SECONDS}s while at least one portal is connected (lightweight)`
);


// V10.5D: cheap, bounded Goal Fest scan while the portal is in use.
let goalFestScanInFlight=false;
let goalFestScanCursor=0;
let lastGoalFestScanAt=0;

function pickGoalFestScanMatches(matches=[]) {
  const liveStatuses=new Set(['LIVE','1H','2H','HT','ET','BT','P','INT']);
  const eligible=(Array.isArray(matches)?matches:[])
    .filter(m=>m?.id && liveStatuses.has(String(m.status||'').toUpperCase()));
  if(!eligible.length) return [];
  const limit=Math.min(GOAL_FEST_SCAN_LIMIT, eligible.length);
  const out=[];
  for(let i=0;i<limit;i++) out.push(eligible[(goalFestScanCursor+i)%eligible.length]);
  goalFestScanCursor=(goalFestScanCursor+limit)%eligible.length;
  return out;
}

async function runGoalFestSignalScan(trigger='portal-active') {
  if(clients.size===0 || !API_KEY || shouldSkipApiCalls() || goalFestScanInFlight)
    return {scanned:0,active:0};

  const now=Date.now();
  if(lastGoalFestScanAt && now-lastGoalFestScanAt < GOAL_FEST_SCAN_SECONDS*1000)
    return {scanned:0,active:0,cooldown:true};

  const batch=pickGoalFestScanMatches(liveMatches);
  if(!batch.length) return {scanned:0,active:0};

  goalFestScanInFlight=true;
  lastGoalFestScanAt=now;
  let scanned=0, active=0;

  try {
    for(const match of batch) {
      if(shouldSkipApiCalls()) break;
      const stats=await fetchFixtureStatistics(match.id);
      if(!stats) continue;

      const observed={...match, possession:stats.possession, shots:stats.shots, xg:stats.xg, cards:stats.cards};
      const goalFest=calculateGoalFestSignal(observed);
      scanned++;

      liveMatches=liveMatches.map(m=>String(m.id)===String(match.id)
        ? {...m, possession:stats.possession, shots:stats.shots, xg:stats.xg, cards:stats.cards,
           goalFest, _staleGoalFest:false}
        : m);

      if(goalFest.active && Number(goalFest.score)>=GOAL_FEST_ALERT_THRESHOLD) {
        active++;
        await saveAlert({
          matchId:match.id, home:match.home, away:match.away,
          league:match.league, leagueId:match.leagueId||0,
          matchType:match.matchType||'League', country:match.leagueCountry||'',
          type:'GOAL_FEST',
          message:`GOAL FEST ${goalFest.level}: ${goalFest.summary}`,
          confidence:goalFest.score, goalFest,
          status:match.status, matchMinutes:match.matchMinutes||0,
          sentAt:new Date().toISOString(),
        });
      }

      await new Promise(r=>setTimeout(r,120));
    }

    setCache('liveMatches', liveMatches);
    broadcast({type:'LIVE_MATCHES', payload:liveMatches});
    console.log(`[GoalFest] ${trigger}: scanned ${scanned}, active ${active}`);
    return {scanned,active};
  } catch(err) {
    console.warn('[GoalFest] scan failed:',err.message);
    return {scanned,active,error:err.message};
  } finally {
    goalFestScanInFlight=false;
  }
}

console.log(`   Goal Fest scan: every ${GOAL_FEST_SCAN_SECONDS}s, max ${GOAL_FEST_SCAN_LIMIT} live matches/pass`);

async function pollUpcomingMatches() {
  // ── If calibration ran recently, use it instead of Gemini knowledge-only ──
  if (calibrationStore.matches.length > 0 && calibrationStore.calibratedAt) {
    const ageMs = Date.now() - new Date(calibrationStore.calibratedAt).getTime();
    if (ageMs < 6 * 60 * 60 * 1000) { // less than 6 hours old
      if (upcomingMatches.length !== calibrationStore.matches.length) {
        upcomingMatches = calibrationStore.matches;
        setCache('upcomingMatches', upcomingMatches);
      }
      if (upcomingMatches.length > 0) {
        broadcast({ type: 'UPCOMING_MATCHES', payload: upcomingMatches });
      }
      return;
    }
  }

  // Check cache first
  const cached = getCached('upcomingMatches');
  if (cached !== null) {
    if (cached.length > 0) {
      upcomingMatches = cached;
      broadcast({ type: 'UPCOMING_MATCHES', payload: upcomingMatches });
    }
    return;
  }

  try {
    let processedMatches = [];

    if (API_KEY) {
      // ── API-Football mode: parse raw fixture format ──────────────────────
      console.log('🔄 Polling upcoming matches...');
      const matches = await fetchUpcomingMatches();
      console.log(`📥 Fetched ${matches ? matches.length : 0} raw fixtures`);

      if (matches && matches.length > 0) {
        // Cold start (calibration empty): use zero-call lightweight parser so we never
        // burst 400+ API calls on a fresh deploy. Calibration will enrich these later.
        // Warm (calibration ran): still use lightweight — calibration is the enrichment source.
        processedMatches = matches.map(parseLightFixture).filter(m => m !== null);
        console.log(`📋 Parsed ${processedMatches.length} upcoming fixtures (lightweight, no extra API calls)`);
      }
    }
    // No Gemini fallback — it hallucinates wrong fixtures.
    // If API-Football is unavailable, calibration data (above) is the source of truth.

    if (processedMatches.length > 0) {
      upcomingMatches = processedMatches;
      console.log(`✅ Processed ${upcomingMatches.length} upcoming matches`);
      setCache('upcomingMatches', upcomingMatches);
      
      broadcast({ type: 'UPCOMING_MATCHES', payload: upcomingMatches });
      console.log(`✓ Broadcasted ${upcomingMatches.length} upcoming matches to ${clients.size} clients`);
    } else {
      // Do NOT cache [] or broadcast [] — calibration data is the source of truth.
      // Wiping the feed here would erase valid calibration matches while the cron
      // is firing before calibration has had time to complete on a fresh deploy.
      console.log('ℹ️  API-Football returned 0 upcoming fixtures this cycle — retaining existing data');
    }
  } catch (error) {
    console.error('❌ Upcoming matches poll error:', error.message);
  }
}

// V10.3: no permanent live/upcoming polling. The daily schedule and analysis are
// prepared once at 05:00 UK; live state is refreshed only when the portal opens.
console.log('⏰ Continuous API-Football polling disabled');
console.log('   Daily preparation: 05:00 Europe/London');
console.log('   Live refresh: one request when the portal opens');

cron.schedule('0 5 * * *', () => {
  console.log('[DailyPrep] 05:00 UK preparation starting...');
  runCalibrationSafely('daily-05:00-uk')
    .then(() => settlePredictionLedger('post-daily-prep'))
    .catch((err) => console.error('[DailyPrep] Scheduled preparation failed:', err.message));
}, { timezone: DAILY_PREP_TIMEZONE });

const LIVE_INTELLIGENCE_INTERVAL_HOURS = toNumberWithMin(
  process.env.LIVE_INTELLIGENCE_INTERVAL_HOURS,
  2,
  1,
);
const DAILY_PREP_WHATSAPP_ALERT_LIMIT = toNumberWithMin(
  process.env.DAILY_PREP_WHATSAPP_ALERT_LIMIT,
  8,
  0,
);

async function runLiveIntelligenceScan(trigger = 'scheduled') {
  if (!API_KEY || shouldSkipApiCalls()) {
    console.log(`[LiveIntel] ${trigger} skipped — API unavailable or quota guard active.`);
    return { scanned: 0, alerts: 0 };
  }

  console.log(`[LiveIntel] ${trigger} scan starting...`);
  await pollLiveMatches({ forceApi: true, enrich: true });

  let qualifyingAlerts = 0;
  for (const match of liveMatches || []) {
    const requiredLiveMetrics = [
      match?.shots?.home, match?.shots?.away,
      match?.xg?.home, match?.xg?.away,
      match?.possession?.home, match?.possession?.away,
    ];
    const hasObservedEvidence = requiredLiveMetrics.every((value) =>
      value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    );
    if (!hasObservedEvidence) continue;

    const nextGoalProb = calculateNextGoalProbability(match);
    const momentum = calculateMomentum(match);
    const matchAlerts = generateBettingAlert(match, nextGoalProb, momentum) || [];

    for (const alert of matchAlerts) {
      const alertConf = Number(
        alert?.probability ?? alert?.confidence ??
        match?.decisionProbability ?? match?.confidence ?? 0
      );
      const policy = getPhaseConfidencePolicy(match.status, match.matchMinutes || 0);
      if (!Number.isFinite(alertConf) || alertConf < policy.standardThreshold) continue;

      qualifyingAlerts += 1;
      await saveAlert({
        matchId: match.id,
        home: match.home,
        away: match.away,
        league: match.league,
        leagueId: match.leagueId || 0,
        matchType: match.matchType || 'League',
        country: match.leagueCountry || '',
        type: alert.type || 'LIVE_INTELLIGENCE',
        message: alert.message || alert.selection || 'Agent47 live opportunity',
        confidence: alertConf,
        status: match.status,
        matchMinutes: match.matchMinutes || 0,
        sentAt: new Date().toISOString(),
      });
    }
  }

  console.log(`[LiveIntel] ${trigger} complete: ${liveMatches.length} live fixtures, ${qualifyingAlerts} qualifying alerts.`);
  return { scanned: liveMatches.length, alerts: qualifyingAlerts };
}

cron.schedule(`0 */${LIVE_INTELLIGENCE_INTERVAL_HOURS} * * *`, async () => {
  try {
    await runLiveIntelligenceScan('scheduled-2h');
  } catch (err) {
    console.error('[LiveIntel] Scheduled scan failed:', err.message);
  }
  try {
    await settlePredictionLedger('scheduled-2h');
  } catch (err) {
    console.error('[PredictionLedger] Scheduled settlement failed:', err.message);
  }
}, { timezone: DAILY_PREP_TIMEZONE });

console.log(`   Periodic live intelligence: every ${LIVE_INTELLIGENCE_INTERVAL_HOURS}h (12 base scans/day at 2h)`);

// ─── ALERT PERSISTENCE ────────────────────────────────────────────────────

// ── Alert dedup: prevent same match+type firing more than once per 30 minutes ──────────────
const recentAlertKeys = new Map(); // key → timestamp
const ALERT_DEDUP_MS = 30 * 60 * 1000; // 30 minutes

async function saveAlert(alertData) {
  const confidencePolicy = getPhaseConfidencePolicy(alertData.status || 'NS', alertData.matchMinutes || 0);
  const competitionContext = detectCompetitionContext({
    leagueId: alertData.leagueId || 0,
    league: alertData.league || '',
    country: alertData.country || '',
    matchType: alertData.matchType || '',
    round: alertData.round || '',
    isKnockout: Boolean(alertData.isKnockout),
    notes: alertData.notes || '',
  });
  const riskPolicy = getCompetitionRiskPolicy(competitionContext.family);
  const standardThreshold = Math.min(95, (alertData.standardThreshold || confidencePolicy.standardThreshold) + riskPolicy.thresholdAdjustment);
  const premiumThreshold = Math.min(99, (alertData.premiumThreshold || confidencePolicy.premiumThreshold) + riskPolicy.thresholdAdjustment);
  const alertPayload = {
    ...alertData,
    phase: alertData.phase || confidencePolicy.phase,
    standardThreshold,
    premiumThreshold,
    competitionFamily: alertData.competitionFamily || competitionContext.family,
    confidenceTier: alertData.confidenceTier || ((alertData.confidence || 0) >= premiumThreshold ? 'PREMIUM' : (alertData.confidence || 0) >= standardThreshold ? 'STANDARD' : 'LOW'),
  };

  // Dedup: skip if same match+type was sent within the last 30 minutes
  const key = `${alertPayload.home}|${alertPayload.away}|${alertPayload.type || 'alert'}`;
  const lastSent = recentAlertKeys.get(key);
  const alertDedupMs = alertPayload.type === 'GOAL_FEST' ? 10 * 60 * 1000 : ALERT_DEDUP_MS;
  if (lastSent && Date.now() - lastSent < alertDedupMs) return;
  recentAlertKeys.set(key, Date.now());
  // Purge stale entries
  for (const [k, ts] of recentAlertKeys) {
    if (Date.now() - ts > ALERT_DEDUP_MS) recentAlertKeys.delete(k);
  }
  // Always keep in memory (last 100)
  alerts.unshift(alertPayload);
  if (alerts.length > 100) alerts.pop();

  // Persist to Firestore if available
  const db = getDb();
  if (db) {
    try {
      await db.collection('alerts').add(alertPayload);
    } catch (err) {
      console.error('⚠️  Firestore alert save failed:', err.message);
    }
  }

  // Initialize calibration cache from whatever bets are available in memory.
  recomputePostMatchCalibrationFromBets(bets);

  // Broadcast to portal
  broadcast({ type: 'NEW_ALERT', payload: decorateAlertFreshness(alertPayload) });

  // Send WhatsApp alert for high-confidence opportunities
  if ((alertPayload.confidence || 0) >= alertPayload.standardThreshold) {
    const confStr = alertPayload.confidence ? `${alertPayload.confidence}%` : '–';
    const msg = [
      `🐰 SportyRabbi Alert`,
      `⚽ ${alertPayload.home} vs ${alertPayload.away}`,
      `🏆 ${alertPayload.league || 'Match'}`,
      `📊 Confidence: ${confStr}`,
      `💡 ${alertPayload.message || alertPayload.type}`,
      `📚 Family: ${alertPayload.competitionFamily || 'UNKNOWN'}`,
      `⏱ Phase: ${confidencePolicy.phase} (standard ${alertPayload.standardThreshold}%, premium ${alertPayload.premiumThreshold}%)`,
      `🕐 ${new Date(alertPayload.sentAt).toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos' })}`,
    ].join('\n');
    sendWhatsApp(msg).catch(() => {});
  }
}

function decorateAlertFreshness(alert, now = Date.now()) {
  const live = (liveMatches || []).find((match) => String(match.id) === String(alert?.matchId));
  return {
    ...alert,
    ...classifyAlertLifecycle(alert, live, new Date(now)),
  };
}

// ─── BET SLIP TIER ENGINE ─────────────────────────────────────────────────────
/**
 * Generates Tier 1 / Tier 2 / Tier 3 bet slips from the calibration store.
 *
 * BANKROLL MODEL  (₦250,000 daily / target ₦100,000 profit):
 *   Tier 1 — near-certain singles (≥90% confidence, implied odds 1.05-1.50)
 *             Stake: 35% bankroll → target +₦35–52k on ~1.4 avg odds
 *   Tier 2 — accumulator 2-3 legs (each ≥82% confidence, combined 2.0–3.5x)
 *             Stake: 25% bankroll → target +₦50–88k on ~3.0 avg combined odds
 *   Tier 3 — value combos 2-4 legs (each ≥72% confidence, combined 4.0–8.0x)
 *             Stake: 10% bankroll → target +₦40–80k on ~5.0 avg combined odds
 *
 * Total expected if all hit: ~₦125–220k profit from ₦70k total stake.
 * Realistic expectation (70% hit rate): ~₦90–150k profit.
 */

const BANKROLL = 250000; // ₦ — adjust via env if needed later
const DAILY_TARGET_PROFIT = Number(process.env.DAILY_TARGET_PROFIT || 100000); // ₦ target, e.g. 250k -> 350k

const SLIP_MODES = {
  safe: {
    key: 'safe',
    label: 'Safe',
    confidenceFloorAdjustment: 3,
    allocationMultipliers: { tier1: 1.12, tier2: 0.9, tier3: 0.75 },
    maxTotalStakePct: 0.5,
    stakeMultiplier: 0.85,
    maxSingleStakePctMultiplier: 0.9,
  },
  balanced: {
    key: 'balanced',
    label: 'Balanced',
    confidenceFloorAdjustment: 0,
    allocationMultipliers: { tier1: 1.0, tier2: 1.0, tier3: 1.0 },
    maxTotalStakePct: 0.7,
    stakeMultiplier: 1.0,
    maxSingleStakePctMultiplier: 1.0,
  },
  aggressive: {
    key: 'aggressive',
    label: 'Aggressive',
    confidenceFloorAdjustment: -3,
    allocationMultipliers: { tier1: 0.9, tier2: 1.2, tier3: 1.45 },
    maxTotalStakePct: 0.85,
    stakeMultiplier: 1.2,
    maxSingleStakePctMultiplier: 1.18,
  },
};

function resolveSlipMode(mode = 'balanced') {
  const key = String(mode || 'balanced').toLowerCase();
  return SLIP_MODES[key] || SLIP_MODES.balanced;
}

function normalizeSlipMode(mode) {
  if (!mode) return null;
  const key = String(mode).toLowerCase();
  if (SLIP_MODES[key]) return key;
  if (key === 'med' || key === 'normal') return 'balanced';
  if (key === 'high' || key === 'risk') return 'aggressive';
  if (key === 'low' || key === 'conservative') return 'safe';
  return key;
}

const postMatchCalibrationStore = {
  updatedAt: null,
  totalSettled: 0,
  byMode: {},
  byFamily: {},
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function settledBetProfit(bet) {
  const stake = Number(bet.stake || 0);
  const odds = Number(bet.odds || 0);
  const explicitProfit = Number(bet.profit);
  const payout = Number(bet.payout || bet.returnAmount || 0);

  if (bet.result === 'won') {
    if (Number.isFinite(explicitProfit)) return explicitProfit;
    if (Number.isFinite(payout) && payout > 0 && stake > 0) return payout - stake;
    if (Number.isFinite(odds) && odds > 1 && stake > 0) return stake * (odds - 1);
    return 0;
  }

  if (bet.result === 'lost') {
    return stake > 0 ? -stake : 0;
  }

  return 0;
}

function deriveCalibrationAdjustment(bucket, minSample = 8) {
  if (!bucket || bucket.settled < minSample) {
    return {
      settled: bucket?.settled || 0,
      winRate: bucket?.settled > 0 ? +((bucket.won / bucket.settled) * 100).toFixed(1) : null,
      roi: bucket?.stakeTurnover > 0 ? +((bucket.netProfit / bucket.stakeTurnover) * 100).toFixed(1) : null,
      avgConfidence: bucket?.confCount > 0 ? +(bucket.confSum / bucket.confCount).toFixed(1) : null,
      calibrationGap: null,
      confidenceFloorAdjustment: 0,
      stakeMultiplierAdjustment: 1,
    };
  }

  const winRate = +((bucket.won / bucket.settled) * 100).toFixed(1);
  const avgConfidence = bucket.confCount > 0 ? +(bucket.confSum / bucket.confCount).toFixed(1) : null;
  const calibrationGap = avgConfidence == null ? null : +(winRate - avgConfidence).toFixed(1);
  const roi = bucket.stakeTurnover > 0 ? +((bucket.netProfit / bucket.stakeTurnover) * 100).toFixed(1) : null;

  let confidenceFloorAdjustment = 0;
  if (calibrationGap != null) {
    if (calibrationGap < -8) confidenceFloorAdjustment = Math.min(4, Math.round(Math.abs(calibrationGap) / 6));
    else if (calibrationGap > 8) confidenceFloorAdjustment = -Math.min(3, Math.round(calibrationGap / 8));
  }

  let stakeMultiplierAdjustment = 1;
  if (roi != null) {
    if (roi >= 12) stakeMultiplierAdjustment += Math.min(0.12, roi / 100);
    else if (roi <= -12) stakeMultiplierAdjustment -= Math.min(0.15, Math.abs(roi) / 90);
  }

  return {
    settled: bucket.settled,
    winRate,
    roi,
    avgConfidence,
    calibrationGap,
    confidenceFloorAdjustment,
    stakeMultiplierAdjustment: +clamp(stakeMultiplierAdjustment, 0.85, 1.15).toFixed(3),
  };
}

function recomputePostMatchCalibrationFromBets(allBets = bets) {
  const settled = (allBets || []).filter((b) => b.result === 'won' || b.result === 'lost');
  const byMode = {};
  const byFamily = {};

  for (const bet of settled) {
    const mode = normalizeSlipMode(bet.slipMode || bet.mode || bet.riskMode) || 'unassigned';
    const family = bet.competitionFamily || detectCompetitionContext({
      leagueId: bet.leagueId || 0,
      league: bet.leagueName || bet.league || '',
      country: bet.leagueCountry || bet.country || '',
      matchType: bet.matchType || '',
      round: bet.round || '',
      isKnockout: Boolean(bet.isKnockout),
      notes: bet.notes || '',
    }).family;
    const stake = Number(bet.stake || 0);
    const profit = settledBetProfit(bet);
    const confidence = Number(bet.confidence);

    if (!byMode[mode]) byMode[mode] = { settled: 0, won: 0, stakeTurnover: 0, netProfit: 0, confSum: 0, confCount: 0 };
    if (!byFamily[family]) byFamily[family] = { settled: 0, won: 0, stakeTurnover: 0, netProfit: 0, confSum: 0, confCount: 0 };

    byMode[mode].settled++;
    byFamily[family].settled++;
    if (bet.result === 'won') {
      byMode[mode].won++;
      byFamily[family].won++;
    }
    if (stake > 0) {
      byMode[mode].stakeTurnover += stake;
      byFamily[family].stakeTurnover += stake;
    }
    byMode[mode].netProfit += profit;
    byFamily[family].netProfit += profit;
    if (Number.isFinite(confidence)) {
      byMode[mode].confSum += confidence;
      byMode[mode].confCount++;
      byFamily[family].confSum += confidence;
      byFamily[family].confCount++;
    }
  }

  postMatchCalibrationStore.byMode = Object.fromEntries(
    Object.entries(byMode).map(([key, bucket]) => [key, deriveCalibrationAdjustment(bucket, 8)])
  );
  postMatchCalibrationStore.byFamily = Object.fromEntries(
    Object.entries(byFamily).map(([key, bucket]) => [key, deriveCalibrationAdjustment(bucket, 10)])
  );
  postMatchCalibrationStore.totalSettled = settled.length;
  postMatchCalibrationStore.updatedAt = new Date().toISOString();
}

function getModeCalibrationAdjustment(modeKey) {
  const key = normalizeSlipMode(modeKey) || 'balanced';
  return postMatchCalibrationStore.byMode[key] || {
    settled: 0,
    confidenceFloorAdjustment: 0,
    stakeMultiplierAdjustment: 1,
  };
}

function getFamilyCalibrationAdjustment(family) {
  return postMatchCalibrationStore.byFamily[family] || {
    settled: 0,
    confidenceFloorAdjustment: 0,
    stakeMultiplierAdjustment: 1,
  };
}

function applyModeAllocation(base, modeProfile) {
  const weighted = {
    tier1: base.tier1 * modeProfile.allocationMultipliers.tier1,
    tier2: base.tier2 * modeProfile.allocationMultipliers.tier2,
    tier3: base.tier3 * modeProfile.allocationMultipliers.tier3,
  };
  const sum = weighted.tier1 + weighted.tier2 + weighted.tier3;
  if (sum <= 0) return { tier1: 0, tier2: 0, tier3: 0 };
  const scale = Math.min(1, modeProfile.maxTotalStakePct / sum);
  return {
    tier1: +(weighted.tier1 * scale).toFixed(4),
    tier2: +(weighted.tier2 * scale).toFixed(4),
    tier3: +(weighted.tier3 * scale).toFixed(4),
  };
}

function oddsForSelection(match, selType) {
  const o    = match.analysis?.odds || match.odds || {};
  return offeredOddsForMarket(o, selType);
}

function bestSelection(match) {
  const top = getTopExecutableRecommendation(match);
  if (!top) return null;
  return {
    label: top.recommendation.selection || top.recommendation.label || top.marketKey,
    type: top.marketKey,
  };
}

function generateBetSlips(bankroll = BANKROLL, mode = 'balanced') {
  const modeProfile = resolveSlipMode(mode);
  const modeCalibration = getModeCalibrationAdjustment(modeProfile.key);
  const pool = calibrationStore.matches
    .map((m) => {
      const ctx = detectCompetitionContext({
        leagueId: m.leagueId,
        league: m.league,
        country: m.leagueCountry,
        matchType: m.matchType,
        round: m.round,
        isKnockout: (m.round || '').toLowerCase().includes('knockout') || (m.round || '').toLowerCase().includes('round of') || (m.round || '').toLowerCase().includes('quarter') || (m.round || '').toLowerCase().includes('semi') || (m.round || '').toLowerCase().includes('final'),
        notes: m.notes,
      });
      const risk = getCompetitionRiskPolicy(ctx.family);
      const familyCalibration = getFamilyCalibrationAdjustment(ctx.family);
      const topExecutable = getTopExecutableRecommendation(m);
      return {
        ...m,
        _competitionFamily: ctx.family,
        _riskPolicy: risk,
        _familyCalibration: familyCalibration,
        _topExecutable: topExecutable,
      };
    })
    .filter((m) => m.status === 'NS' && m._topExecutable && (m.decisionProbability || m.confidence || 0) >= Math.max(
      52,
      m._riskPolicy.confidenceFloor +
      modeProfile.confidenceFloorAdjustment +
      (modeCalibration.confidenceFloorAdjustment || 0) +
      (m._familyCalibration?.confidenceFloorAdjustment || 0)
    ));

  if (pool.length === 0) {
    return { tier1: null, tier2: null, tier3: null, pool: 0, generatedAt: new Date().toISOString() };
  }

  pool.sort((a, b) => (b.decisionProbability || b.confidence || 0) - (a.decisionProbability || a.confidence || 0));

  // ── Dynamic stake allocation: protect capital when bankroll is small ─────
  // Low bankroll → heavier weight on Tier 1 (safest), smaller Tiers 2+3.
  // Kelly-inspired: never risk more than 60% of bankroll total.
  //   bankroll < 20k  → Tier1=50%, Tier2=10%, Tier3=skip
  //   bankroll < 50k  → Tier1=45%, Tier2=15%, Tier3=5%
  //   bankroll < 100k → Tier1=40%, Tier2=20%, Tier3=8%
  //   bankroll ≥ 100k → Tier1=35%, Tier2=25%, Tier3=10%
  let t1Pct, t2Pct, t3Pct;
  if (bankroll < 20000) {
    t1Pct = 0.50; t2Pct = 0.10; t3Pct = 0.00;
  } else if (bankroll < 50000) {
    t1Pct = 0.45; t2Pct = 0.15; t3Pct = 0.05;
  } else if (bankroll < 100000) {
    t1Pct = 0.40; t2Pct = 0.20; t3Pct = 0.08;
  } else {
    t1Pct = 0.35; t2Pct = 0.25; t3Pct = 0.10;
  }
  const modeAllocation = applyModeAllocation({ tier1: t1Pct, tier2: t2Pct, tier3: t3Pct }, modeProfile);
  t1Pct = modeAllocation.tier1;
  t2Pct = modeAllocation.tier2;
  t3Pct = modeAllocation.tier3;

  // ── TIER 1: Singles ≥85% — no fallback forcing ───────────────────────────
  const tier1Candidates = pool.filter(m => (m.decisionProbability || m.confidence || 0) >= 85).slice(0, 3);
  const tier1 = tier1Candidates.map(m => {
    const sel = bestSelection(m);
    if (!sel) return null;
    const odds = oddsForSelection(m, sel.type);
    if (odds == null) return null;
    const rawStake = Math.round(bankroll * t1Pct / Math.max(tier1Candidates.length, 1));
    const guardedStake = Math.round(Math.min(
      rawStake *
        m._riskPolicy.stakeMultiplier *
        modeProfile.stakeMultiplier *
        (modeCalibration.stakeMultiplierAdjustment || 1) *
        (m._familyCalibration?.stakeMultiplierAdjustment || 1),
      bankroll * m._riskPolicy.maxSingleStakePct * modeProfile.maxSingleStakePctMultiplier
    ));
    return {
      match: `${m.home} vs ${m.away}`,
      league: m.league,
      leagueId: m.leagueId,
      competitionFamily: m._competitionFamily,
      kickoffUTC: m.kickoffUTC,
      selection: sel.label,
      selectionType: sel.type,
      confidence: m.decisionProbability || m.confidence,
      odds: +odds.toFixed(2),
      stake: guardedStake,
      potentialReturn: Math.round(guardedStake * odds),
      potentialProfit: Math.round(guardedStake * (odds - 1)),
    };
  }).filter(Boolean);

  // ── TIER 2: Accumulator 2-3 legs, each ≥72% — no fallback forcing ────────
  const tier2Legs = pool
    .filter(m => (m.decisionProbability || m.confidence || 0) >= 72 && !tier1Candidates.find(t => t.id === m.id))
    .slice(0, 3)
    .filter(m => {
      const sel = bestSelection(m);
      return sel && oddsForSelection(m, sel.type) != null;
    });
  const tier2Combined = tier2Legs.reduce((acc, m) => {
    const sel = bestSelection(m);
    if (!sel) return acc;
    const legOdds = oddsForSelection(m, sel.type);
    if (legOdds == null) return acc;
    return {
      legs: [...acc.legs, {
        match: `${m.home} vs ${m.away}`,
        league: m.league,
        leagueId: m.leagueId,
        competitionFamily: m._competitionFamily,
        kickoffUTC: m.kickoffUTC,
        selection: sel.label,
        selectionType: sel.type,
        confidence: m.decisionProbability || m.confidence,
        odds: +legOdds.toFixed(2),
      }],
      combinedOdds: +(acc.combinedOdds * legOdds).toFixed(2),
    };
  }, { legs: [], combinedOdds: 1.0 });
  const tier2StakeRaw = t2Pct > 0 ? Math.round(bankroll * t2Pct) : 0;
  const tier2RiskMultiplier = tier2Legs.length > 0
    ? Math.min(...tier2Legs.map(m => m._riskPolicy.stakeMultiplier * (m._familyCalibration?.stakeMultiplierAdjustment || 1)))
    : 1;
  const tier2Stake = Math.round(tier2StakeRaw * tier2RiskMultiplier * modeProfile.stakeMultiplier * (modeCalibration.stakeMultiplierAdjustment || 1));
  const tier2 = tier2Combined.legs.length >= 2 ? {
    ...tier2Combined,
    stake: tier2Stake,
    potentialReturn: Math.round(tier2Stake * tier2Combined.combinedOdds),
    potentialProfit: Math.round(tier2Stake * (tier2Combined.combinedOdds - 1)),
  } : null;

  // ── TIER 3: Value combo 2-4 legs ≥65% and <72% — no fallback forcing ─────
  const tier3Candidates = pool
    .filter(m => (m.decisionProbability || m.confidence || 0) >= 65 && (m.decisionProbability || m.confidence || 0) < 72)
    .filter(m => !tier1Candidates.find(t => t.id === m.id) && !tier2Legs.find(t => t.id === m.id))
    .slice(0, 4);
  const tier3Legs = tier3Candidates.map(m => {
    const sel = bestSelection(m);
    if (!sel) return null;
    const odds = oddsForSelection(m, sel.type);
    if (odds == null) return null;
    return {
      match: `${m.home} vs ${m.away}`,
      league: m.league,
      leagueId: m.leagueId,
      competitionFamily: m._competitionFamily,
      kickoffUTC: m.kickoffUTC,
      selection: sel.label,
      selectionType: sel.type,
      confidence: m.decisionProbability || m.confidence,
      odds: +odds.toFixed(2),
    };
  }).filter(Boolean);
  const tier3CombinedOdds = +tier3Legs.reduce((acc, l) => acc * l.odds, 1.0).toFixed(2);
  const tier3StakeRaw = t3Pct > 0 ? Math.round(bankroll * t3Pct) : 0;
  const tier3RiskMultiplier = tier3Candidates.length > 0
    ? Math.min(...tier3Candidates.map(m => m._riskPolicy.stakeMultiplier * (m._familyCalibration?.stakeMultiplierAdjustment || 1)))
    : 1;
  const tier3Stake = Math.round(tier3StakeRaw * tier3RiskMultiplier * modeProfile.stakeMultiplier * (modeCalibration.stakeMultiplierAdjustment || 1));
  const tier3 = tier3Legs.length >= 2 ? {
    legs: tier3Legs,
    combinedOdds: tier3CombinedOdds,
    stake: tier3Stake,
    potentialReturn: Math.round(tier3Stake * tier3CombinedOdds),
    potentialProfit: Math.round(tier3Stake * (tier3CombinedOdds - 1)),
  } : null;

  const totalStake = (tier1.reduce((s, t) => s + t.stake, 0)) +
    (tier2?.stake || 0) + (tier3?.stake || 0);
  const bestCaseProfit = (tier1.reduce((s, t) => s + t.potentialProfit, 0)) +
    (tier2?.potentialProfit || 0) + (tier3?.potentialProfit || 0);

  return {
    tier1,
    tier2,
    tier3,
    summary: {
      mode: modeProfile.key,
      modeLabel: modeProfile.label,
      availableModes: Object.keys(SLIP_MODES),
      bankroll,
      targetProfit: DAILY_TARGET_PROFIT,
      targetBankroll: bankroll + DAILY_TARGET_PROFIT,
      totalStake,
      totalStakePercent: +((totalStake / bankroll) * 100).toFixed(1),
      bestCaseProfit,
      bestCaseProfitPercent: +((bestCaseProfit / bankroll) * 100).toFixed(1),
      progressToTargetPct: DAILY_TARGET_PROFIT > 0
        ? +Math.min((bestCaseProfit / DAILY_TARGET_PROFIT) * 100, 999).toFixed(1)
        : null,
      profitGapToTarget: DAILY_TARGET_PROFIT - bestCaseProfit,
      postMatchCalibration: {
        updatedAt: postMatchCalibrationStore.updatedAt,
        totalSettled: postMatchCalibrationStore.totalSettled,
        mode: modeCalibration,
      },
      allocation: { tier1: Math.round(t1Pct * 100), tier2: Math.round(t2Pct * 100), tier3: Math.round(t3Pct * 100) },
    },
    generatedAt: new Date().toISOString(),
  };
}

// ─── REST API ENDPOINTS ────────────────────────────────────────────────────

// ── Manual quota guard reset ─────────────────────────────────────────────
app.post('/api/quota/reset', (req, res) => {
  const wasPaused = quotaState.isPaused;
  clearQuotaPause();
  console.log('[Admin] Quota guard manually reset via POST /api/quota/reset');
  res.json({
    ok: true,
    wasPaused,
    message: wasPaused ? 'Quota guard cleared. API polling will resume on next poll cycle.' : 'Quota guard was not active.',
  });
});

// ── Debug: raw live fixture count from API-Football (no analyzeMatch) ──────
app.get('/api/debug/live-raw', async (req, res) => {
  try {
    const raw = await fetchLiveMatches();
    const sample = (raw || []).slice(0, 5).map(m => ({
      id: m.fixture?.id,
      home: m.teams?.home?.name,
      away: m.teams?.away?.name,
      league: m.league?.name,
      country: m.league?.country,
      status: m.fixture?.status?.short,
      elapsed: m.fixture?.status?.elapsed,
    }));
    res.json({ rawCount: (raw || []).length, sample, quotaState });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Debug: compare upcoming coverage across sources (API-Football vs fallback) ──
app.get('/api/debug/upcoming-sources', async (req, res) => {
  const summarizeStatuses = (fixtures = []) => {
    const buckets = {};
    for (const f of fixtures) {
      const s = String(f?.fixture?.status?.short || '').toUpperCase() || 'UNKNOWN';
      buckets[s] = (buckets[s] || 0) + 1;
    }
    return buckets;
  };
  const summarizeCountries = (fixtures = []) => {
    const buckets = {};
    for (const f of fixtures) {
      const c = String(f?.league?.country || 'Unknown');
      buckets[c] = (buckets[c] || 0) + 1;
    }
    return Object.entries(buckets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([country, count]) => ({ country, count }));
  };
  const isUpcoming = (f) => {
    const status = String(f?.fixture?.status?.short || '').toUpperCase();
    return status === 'NS' || status === 'TBD' || status === 'PST';
  };

  try {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let apiNextRaw = [];
    let apiTodayRaw = [];
    let apiTomorrowRaw = [];

    if (API_KEY && !shouldSkipApiCalls()) {
      const [nextRes, todayRes, tomorrowRes] = await Promise.all([
        axios.get(`${API_BASE}/fixtures`, {
          params: { next: 200, timezone: 'UTC' },
          headers: { 'x-apisports-key': API_KEY },
          timeout: 8000,
        }),
        axios.get(`${API_BASE}/fixtures`, {
          params: { date: today, timezone: 'UTC' },
          headers: { 'x-apisports-key': API_KEY },
          timeout: 8000,
        }),
        axios.get(`${API_BASE}/fixtures`, {
          params: { date: tomorrow, timezone: 'UTC' },
          headers: { 'x-apisports-key': API_KEY },
          timeout: 8000,
        }),
      ]);

      updateQuotaFromHeaders(nextRes.headers);
      updateQuotaFromHeaders(todayRes.headers);
      updateQuotaFromHeaders(tomorrowRes.headers);

      apiNextRaw = nextRes.data?.response || [];
      apiTodayRaw = todayRes.data?.response || [];
      apiTomorrowRaw = tomorrowRes.data?.response || [];
    }

    const sportsDbRaw = await fetchTodayFixturesFromSportsDB();
    const apiWindowRaw = [...apiTodayRaw, ...apiTomorrowRaw];

    res.json({
      timestamp: new Date().toISOString(),
      quotaGuard: {
        isPaused: quotaState.isPaused,
        pauseReason: quotaState.pauseReason,
        dailyRemaining: quotaState.dailyRemaining,
        minuteRemaining: quotaState.minuteRemaining,
      },
      apiFootball: {
        next200: {
          rawCount: apiNextRaw.length,
          upcomingCount: apiNextRaw.filter(isUpcoming).length,
          statuses: summarizeStatuses(apiNextRaw),
          topCountries: summarizeCountries(apiNextRaw),
        },
        todayPlusTomorrow: {
          rawCount: apiWindowRaw.length,
          upcomingCount: apiWindowRaw.filter(isUpcoming).length,
          statuses: summarizeStatuses(apiWindowRaw),
          topCountries: summarizeCountries(apiWindowRaw),
        },
      },
      sportsDb: {
        rawCount: sportsDbRaw.length,
        topCountries: summarizeCountries(sportsDbRaw),
      },
      currentFeed: {
        liveCount: liveMatches.length,
        upcomingCount: upcomingMatches.length,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message, quotaState });
  }
});

// ─── V10.5B PREDICTION LEDGER ──────────────────────────────────────────────

function finalScoreFromProviderFixture(raw = {}) {
  const status = String(raw?.fixture?.status?.short || '').toUpperCase();
  if (!['FT', 'AET', 'PEN'].includes(status)) return null;

  const h = raw?.score?.fulltime?.home;
  const a = raw?.score?.fulltime?.away;
  if (Number.isFinite(Number(h)) && Number.isFinite(Number(a))) {
    return { home: Number(h), away: Number(a), status };
  }

  if (status === 'FT' && Number.isFinite(Number(raw?.goals?.home)) && Number.isFinite(Number(raw?.goals?.away))) {
    return { home: Number(raw.goals.home), away: Number(raw.goals.away), status };
  }
  return null;
}

async function fetchFinishedFixturesForUtcDate(dateStamp) {
  if (!API_KEY || shouldSkipApiCalls()) return [];
  const response = await axios.get(`${API_BASE}/fixtures`, {
    params: { date: dateStamp, timezone: 'UTC' },
    headers: { 'x-apisports-key': API_KEY },
    timeout: 10000,
  });
  updateQuotaFromHeaders(response.headers);
  return Array.isArray(response.data?.response) ? response.data.response : [];
}

async function settleRecentUserPlayedBets(matchId, homeGoals, awayGoals, settledAt) {
  const db = getDb();
  let settled = 0;

  for (const bet of bets) {
    if (bet?.source !== 'USER_PLAYED') continue;
    if (String(bet.matchId) !== String(matchId)) continue;
    if (bet.result === 'won' || bet.result === 'lost') continue;
    const result = settleMarketPrediction(bet.marketKey, homeGoals, awayGoals);
    if (!result) continue;

    bet.result = result;
    bet.finalScore = `${homeGoals}-${awayGoals}`;
    bet.settledAt = settledAt;
    bet.updatedAt = settledAt;
    settled += 1;

    if (db && bet.firestoreId) {
      try {
        await db.collection('bets').doc(bet.firestoreId).update({
          result,
          finalScore: bet.finalScore,
          settledAt,
          updatedAt: settledAt,
        });
      } catch (err) {
        console.warn('[PredictionLedger] My Bets settlement save failed:', err.message);
      }
    }
    broadcast({ type: 'BET_UPDATED', payload: bet });
  }

  if (settled > 0) recomputePostMatchCalibrationFromBets(bets);
  return settled;
}

async function settlePredictionLedger(trigger = 'manual') {
  const db = getDb();
  if (!db || !API_KEY || shouldSkipApiCalls()) {
    return { trigger, checked: 0, settledMatches: 0, settledCalls: 0, settledUserBets: 0 };
  }

  // Only recent records need routine settlement. Older unresolved/postponed fixtures remain
  // permanently stored as pending rather than being guessed or deleted.
  const recentCutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const snapshot = await db.collection('predictions')
    .where('predictedAt', '>=', recentCutoff)
    .get();

  const pending = snapshot.docs
    .map((d) => normalizePredictionLedgerDocument({ predictionId: d.id, ...d.data() }))
    .filter((p) => !p.settledAt && p.settlementStatus !== 'SETTLED')
    .filter((p) => {
      const kickoff = Date.parse(p.kickoffUTC || '');
      return Number.isFinite(kickoff) && kickoff <= Date.now() - (2 * 60 * 60 * 1000);
    });

  if (pending.length === 0) {
    return { trigger, checked: 0, settledMatches: 0, settledCalls: 0, settledUserBets: 0 };
  }

  const byDate = new Map();
  for (const p of pending) {
    const kickoff = new Date(p.kickoffUTC);
    const dateStamp = kickoff.toISOString().slice(0, 10);
    if (!byDate.has(dateStamp)) byDate.set(dateStamp, []);
    byDate.get(dateStamp).push(p);
  }

  let settledMatches = 0;
  let settledCalls = 0;
  let settledUserBets = 0;
  const settledAt = new Date().toISOString();

  for (const [dateStamp, datePredictions] of byDate) {
    let rawFixtures = [];
    try {
      rawFixtures = await fetchFinishedFixturesForUtcDate(dateStamp);
    } catch (err) {
      console.warn(`[PredictionLedger] Result fetch failed for ${dateStamp}: ${err.message}`);
      continue;
    }
    const rawById = new Map(rawFixtures.map((f) => [String(f?.fixture?.id), f]));

    const writes = [];
    for (const prediction of datePredictions) {
      const raw = rawById.get(String(prediction.matchId));
      const final = finalScoreFromProviderFixture(raw);
      if (!final) continue;

      const settledDoc = settlePredictionDocument(
        prediction,
        final.home,
        final.away,
        settledAt,
        final.status,
      );
      const marketSettledCount = (settledDoc.markets || []).filter((m) =>
        m.result === 'won' || m.result === 'lost'
      ).length;
      if (marketSettledCount === 0) continue;

      writes.push({
        predictionId: prediction.predictionId,
        markets: settledDoc.markets,
        settlementStatus: 'SETTLED',
        finalScore: settledDoc.finalScore,
        finalStatus: settledDoc.finalStatus,
        settledAt,
      });
      settledMatches += 1;
      settledCalls += marketSettledCount;
      settledUserBets += await settleRecentUserPlayedBets(
        prediction.matchId,
        final.home,
        final.away,
        settledAt,
      );
    }

    for (const writeChunk of chunkArray(writes, 400)) {
      const batch = db.batch();
      for (const update of writeChunk) {
        const ref = db.collection('predictions').doc(update.predictionId);
        batch.update(ref, {
          markets: update.markets,
          settlementStatus: update.settlementStatus,
          finalScore: update.finalScore,
          finalStatus: update.finalStatus,
          settledAt: update.settledAt,
        });
      }
      if (writeChunk.length > 0) await batch.commit();
    }
  }

  console.log(`[PredictionLedger] ${trigger}: settled ${settledMatches} matches / ${settledCalls} market calls / ${settledUserBets} My Bets`);
  return { trigger, checked: pending.length, settledMatches, settledCalls, settledUserBets };
}

app.get('/api/predictions', async (req, res) => {
  const db = getDb();
  if (!db) {
    return res.json({
      predictions: [],
      summary: summarizePredictionDocuments([]),
      message: 'Prediction ledger storage is unavailable.',
    });
  }

  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 500);
    const snapshot = await db.collection('predictions')
      .orderBy('predictedAt', 'desc')
      .limit(limit)
      .get();
    const predictions = snapshot.docs.map((d) =>
      normalizePredictionLedgerDocument({ predictionId: d.id, ...d.data() })
    );
    res.json({
      predictions,
      summary: summarizePredictionDocuments(predictions),
    });
  } catch (err) {
    console.error('[PredictionLedger] Read failed:', err.message);
    res.status(500).json({ error: 'Prediction ledger read failed' });
  }
});

app.post('/api/predictions/settle', async (req, res) => {
  try {
    const result = await settlePredictionLedger('manual-api');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Exact user selection. This is deliberately separate from SportyRabbi's own ledger.
app.post('/api/bets/played', async (req, res) => {
  const marketKey = String(req.body?.marketKey || '');
  if (!isSettleableMarket(marketKey)) {
    return res.status(400).json({ error: 'This market is not score-settleable yet.' });
  }
  if (!req.body?.matchId || !req.body?.selection) {
    return res.status(400).json({ error: 'matchId and exact selection are required.' });
  }

  const sourceKey = [
    String(req.body.matchId),
    marketKey,
    String(req.body.selection).trim().toLowerCase(),
  ].join('|');

  const duplicate = bets.find((b) =>
    b.source === 'USER_PLAYED' && b.sourceKey === sourceKey
  );
  if (duplicate) return res.json({ success: true, duplicate: true, bet: duplicate });

  const competitionContext = detectCompetitionContext({
    leagueId: req.body.leagueId || 0,
    league: req.body.league || '',
    country: req.body.leagueCountry || '',
    matchType: req.body.matchType || '',
  });

  const now = new Date().toISOString();
  const bet = {
    id: Date.now(),
    source: 'USER_PLAYED',
    sourceKey,
    predictionId: req.body.predictionId || null,
    matchId: req.body.matchId,
    home: req.body.home || '',
    away: req.body.away || '',
    matchName: req.body.matchName || `${req.body.home || ''} vs ${req.body.away || ''}`.trim(),
    league: req.body.league || 'Unknown',
    leagueName: req.body.league || 'Unknown',
    leagueId: req.body.leagueId || 0,
    leagueCountry: req.body.leagueCountry || '',
    matchType: req.body.matchType || 'League',
    competitionFamily: req.body.competitionFamily || competitionContext.family,
    kickoffUTC: req.body.kickoffUTC || null,
    marketKey,
    betType: marketKey,
    selection: String(req.body.selection),
    confidence: finiteNumberOrNull(req.body.confidence),
    modelProbability: finiteNumberOrNull(req.body.modelProbability ?? req.body.confidence),
    dailySignalScore: finiteNumberOrNull(req.body.dailySignalScore),
    analysisVersion: req.body.analysisVersion || null,
    analysisTimestamp: req.body.analysisTimestamp || null,
    odds: finiteNumberOrNull(req.body.odds),
    stake: finiteNumberOrNull(req.body.stake),
    result: 'pending',
    finalScore: null,
    settledAt: null,
    createdAt: now,
  };

  const db = getDb();
  if (db) {
    try {
      // If the linked prediction is already settled, settle this user selection immediately.
      if (bet.predictionId) {
        const predSnap = await db.collection('predictions').doc(bet.predictionId).get();
        if (predSnap.exists) {
          const pred = normalizePredictionLedgerDocument({
            predictionId: predSnap.id,
            ...predSnap.data(),
          });
          if (pred.finalScore && pred.settledAt) {
            const [h, a] = String(pred.finalScore).split('-').map(Number);
            const result = settleMarketPrediction(marketKey, h, a);
            if (result) {
              bet.result = result;
              bet.finalScore = pred.finalScore;
              bet.settledAt = pred.settledAt;
            }
          }
        }
      }
      const ref = await db.collection('bets').add(bet);
      bet.firestoreId = ref.id;
    } catch (err) {
      console.warn('[MyBets] Firestore save failed:', err.message);
    }
  }

  bets.unshift(bet);
  if (bets.length > 500) bets.pop();
  recomputePostMatchCalibrationFromBets(bets);
  broadcast({ type: 'BET_LOGGED', payload: bet });
  res.status(201).json({ success: true, bet });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: '✓ Online',
    timestamp: new Date().toISOString(),
    liveFreshness: getLiveFreshnessMeta(),
    quotaGuard: {
      isPaused: quotaState.isPaused,
      pauseReason: quotaState.pauseReason,
      pausedAt: quotaState.pausedAt,
      resumeAt: quotaState.resumeAt,
      dailyRemaining: quotaState.dailyRemaining,
      dailyLimit: quotaState.dailyLimit,
      minuteRemaining: quotaState.minuteRemaining,
      minuteLimit: quotaState.minuteLimit,
      softStops: {
        daily: API_DAILY_SOFT_STOP,
        minute: API_MINUTE_SOFT_STOP,
      },
      lastUpdatedAt: quotaState.lastUpdatedAt,
    },
  });
});

app.get('/api/quota-status', (req, res) => {
  res.json(getQuotaSummary());
});

// ── WhatsApp test endpoint ─────────────────────────────────────────────────
app.post('/api/test-whatsapp', async (req, res) => {
  const msg = req.body?.message || `🎯 SportyRabbi test alert — ${new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC. WhatsApp alerts are working! ✅`;
  const result = await sendWhatsApp(msg);
  res.json({ twilioEnabled, ...result });
});

// GET version — trigger a test alert directly from the browser address bar
app.get('/api/test-whatsapp', async (req, res) => {
  const msg = `🎯 SportyRabbi test alert — ${new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC. WhatsApp alerts are working! ✅`;
  const result = await sendWhatsApp(msg);
  res.json({ twilioEnabled, ...result });
});

app.get('/api/live', async (req, res) => {
  try {
    await refreshLiveOnPortalOpen();
    await runGoalFestSignalScan('manual-live');
  } catch (err) {
    console.warn('[PortalOpen] Live refresh failed; serving last cached state:', err.message);
  }

  const matchType = req.query.matchType ? String(req.query.matchType) : null;
  const filtered = matchType ? liveMatches.filter(m => m.matchType === matchType) : liveMatches;
  res.json({
    count: filtered.length,
    matches: filtered,
    freshness: getLiveFreshnessMeta(),
    refreshPolicy: 'portal-active-shared+manual',
  });
});

app.get('/api/upcoming', (req, res) => {
  const matchType = req.query.matchType ? String(req.query.matchType) : null;
  
  // Prefer in-memory upcomingMatches; fall back to calibrationStore if it's richer
  let source = upcomingMatches;
  if (source.length === 0 && calibrationStore.matches.length > 0) {
    source = calibrationStore.matches;
  }
  
  let filtered = matchType ? source.filter(m => m.matchType === matchType) : source;
  res.json({ count: filtered.length, matches: filtered });
});

app.get('/api/leagues', (req, res) => {
  const leagues = {};
  
  upcomingMatches.forEach(match => {
      if (match.leagueId !== null && match.leagueId !== undefined && match.league) {
        if (!leagues[match.leagueId]) {
          leagues[match.leagueId] = {
            id: match.leagueId,
            name: match.league,
            country: match.leagueCountry || '',
            matchType: match.matchType || 'League',
            count: 0,
          };
        }
        leagues[match.leagueId].count++;
      }
    });
  
  const result = Object.values(leagues)
    .sort((a, b) => b.count - a.count);
  
  res.json(result);
});

app.get('/api/matchTypes', (req, res) => {
  const types = {};
  
  upcomingMatches.forEach(match => {
      const type = match.matchType || 'League';
      if (!types[type]) {
        types[type] = { name: type, count: 0 };
      }
      types[type].count++;
    });
  
  const result = Object.values(types)
    .sort((a, b) => b.count - a.count);
  
  res.json(result);
});

app.get('/api/alerts', async (req, res) => {
  const db = getDb();
  if (db) {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const snapshot = await db.collection('alerts')
        .orderBy('sentAt', 'desc')
        .limit(limit)
        .get();
      const firestoreAlerts = snapshot.docs.map(d => decorateAlertFreshness({ firestoreId: d.id, ...d.data() }));
      return res.json({ count: firestoreAlerts.length, alerts: firestoreAlerts });
    } catch (err) {
      console.error('Firestore alerts read error:', err.message);
      // Fall through to in-memory
    }
  }
  const decoratedAlerts = alerts.slice(0, 50).map((alert) => decorateAlertFreshness(alert));
  res.json({ count: decoratedAlerts.length, alerts: decoratedAlerts });
});

app.get('/api/bets', async (req, res) => {
  const db = getDb();
  if (db) {
    try {
      const snapshot = await db.collection('bets')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();
      const firestoreBets = snapshot.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
      return res.json({ count: firestoreBets.length, bets: firestoreBets });
    } catch (err) {
      console.error('Firestore bets read error:', err.message);
    }
  }
  res.json({ count: bets.length, bets });
});

// ── Bet slip tier suggestions ─────────────────────────────────────────────
app.get('/api/bets/slips', (req, res) => {
  const bankroll = Number(req.query.bankroll) || BANKROLL;
  const mode = req.query.mode || 'balanced';
  const slips = generateBetSlips(bankroll, mode);
  res.json(slips);
});

app.post('/api/bets', async (req, res) => {
  // Normalize manual bet type labels to engine categories for pattern analysis
  const BET_TYPE_MAP = {
    home_win: 'WINS_ONLY', away_win: 'WINS_ONLY', draw: 'NEUTRAL',
    over: 'GOALS_ONLY', under: 'GOALS_ONLY', btts: 'GOALS_ONLY',
  };
  const competitionContext = detectCompetitionContext({
    leagueId: req.body.leagueId || req.body.matchLeagueId || 0,
    league: req.body.leagueName || req.body.league || '',
    country: req.body.leagueCountry || req.body.country || '',
    matchType: req.body.matchType || req.body.fixtureType || '',
    round: req.body.round || '',
    isKnockout: Boolean(req.body.isKnockout),
    notes: req.body.notes || '',
  });

  const bet = {
    id: Date.now(),
    ...req.body,
    betType: BET_TYPE_MAP[req.body.betType] || req.body.betType || 'UNKNOWN',
    slipMode: normalizeSlipMode(req.body.slipMode || req.body.mode || req.body.riskMode),
    competitionFamily: req.body.competitionFamily || competitionContext.family,
    createdAt: new Date().toISOString(),
  };

  // Persist to Firestore if available
  const db = getDb();
  if (db) {
    try {
      const docRef = await db.collection('bets').add(bet);
      bet.firestoreId = docRef.id;
    } catch (err) {
      console.error('⚠️  Firestore bet save failed:', err.message);
    }
  }

  // Keep in memory as fallback
  bets.unshift(bet);
  if (bets.length > 500) bets.pop();
  recomputePostMatchCalibrationFromBets(bets);

  broadcast({ type: 'BET_LOGGED', payload: bet });
  res.json({ success: true, bet });
});

app.patch('/api/bets/:id', async (req, res) => {
  const db = getDb();

  // Try Firestore first (using firestoreId passed from frontend, or id as string)
  if (db && req.body.firestoreId) {
    try {
      const ref = db.collection('bets').doc(req.body.firestoreId);
      const updates = { ...req.body, updatedAt: new Date().toISOString() };
      delete updates.firestoreId;
      await ref.update(updates);
      const updated = { ...(await ref.get()).data(), firestoreId: req.body.firestoreId };
      const existingIdx = bets.findIndex((b) => b.firestoreId === req.body.firestoreId || String(b.id) === String(req.params.id));
      if (existingIdx >= 0) bets[existingIdx] = { ...bets[existingIdx], ...updated };
      else {
        bets.unshift(updated);
        if (bets.length > 500) bets.pop();
      }
      recomputePostMatchCalibrationFromBets(bets);
      broadcast({ type: 'BET_UPDATED', payload: updated });
      return res.json({ success: true, bet: updated });
    } catch (err) {
      console.error('⚠️  Firestore bet update failed:', err.message);
    }
  }

  // Fallback to in-memory
  const idx = bets.findIndex((b) => b.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Bet not found' });

  bets[idx] = { ...bets[idx], ...req.body, updatedAt: new Date().toISOString() };
  recomputePostMatchCalibrationFromBets(bets);
  broadcast({ type: 'BET_UPDATED', payload: bets[idx] });
  res.json({ success: true, bet: bets[idx] });
});

app.get('/api/stats', async (req, res) => {
  const db = getDb();
  let allBets = bets;

  if (db) {
    try {
      const snapshot = await db.collection('bets').get();
      allBets = snapshot.docs.map(d => d.data());
    } catch (err) {
      console.error('Firestore stats read error:', err.message);
    }
  }

  const wins = allBets.filter((b) => b.result === 'won').length;
  const losses = allBets.filter((b) => b.result === 'lost').length;
  const winRate = allBets.length > 0 ? ((wins / allBets.length) * 100).toFixed(1) : 0;

  res.json({
    totalBets: allBets.length,
    wins,
    losses,
    winRate: `${winRate}%`,
    liveBetsAvailable: liveMatches.length,
  });
});

app.get('/api/stats/competition', async (req, res) => {
  const db = getDb();
  let allBets = bets;

  if (db) {
    try {
      const snapshot = await db.collection('bets').get();
      allBets = snapshot.docs.map(d => d.data());
    } catch (err) {
      console.error('Firestore competition stats read error:', err.message);
    }
  }

  const settled = allBets.filter((b) => b.result === 'won' || b.result === 'lost');
  const byFamily = {};

  for (const bet of settled) {
    const family = bet.competitionFamily || detectCompetitionContext({
      leagueId: bet.leagueId || 0,
      league: bet.leagueName || bet.league || '',
      country: bet.leagueCountry || bet.country || '',
      matchType: bet.matchType || '',
      round: bet.round || '',
      isKnockout: Boolean(bet.isKnockout),
      notes: bet.notes || '',
    }).family;

    if (!byFamily[family]) {
      byFamily[family] = {
        family,
        settled: 0,
        won: 0,
        lost: 0,
        avgConfidence: null,
        confidenceCount: 0,
        confidenceSum: 0,
      };
    }

    byFamily[family].settled++;
    if (bet.result === 'won') byFamily[family].won++;
    else byFamily[family].lost++;
    if (bet.confidence != null) {
      byFamily[family].confidenceCount++;
      byFamily[family].confidenceSum += Number(bet.confidence) || 0;
    }
  }

  const rows = Object.values(byFamily).map((r) => {
    const winRate = r.settled > 0 ? +((r.won / r.settled) * 100).toFixed(1) : 0;
    const avgConfidence = r.confidenceCount > 0
      ? +(r.confidenceSum / r.confidenceCount).toFixed(1)
      : null;
    return {
      family: r.family,
      settled: r.settled,
      won: r.won,
      lost: r.lost,
      winRate,
      avgConfidence,
      calibrationGap: avgConfidence == null ? null : +(winRate - avgConfidence).toFixed(1),
    };
  }).sort((a, b) => b.settled - a.settled);

  res.json({
    totalSettled: settled.length,
    families: rows,
  });
});

app.get('/api/stats/mode', async (req, res) => {
  const db = getDb();
  let allBets = bets;

  if (db) {
    try {
      const snapshot = await db.collection('bets').get();
      allBets = snapshot.docs.map(d => d.data());
    } catch (err) {
      console.error('Firestore mode stats read error:', err.message);
    }
  }

  const settled = allBets.filter((b) => b.result === 'won' || b.result === 'lost');
  const byMode = {};

  const profitForBet = (bet) => {
    const stake = Number(bet.stake || 0);
    const odds = Number(bet.odds || 0);
    const explicitProfit = Number(bet.profit);
    const payout = Number(bet.payout || bet.returnAmount || 0);

    if (bet.result === 'won') {
      if (Number.isFinite(explicitProfit)) return explicitProfit;
      if (Number.isFinite(payout) && payout > 0 && stake > 0) return payout - stake;
      if (Number.isFinite(odds) && odds > 1 && stake > 0) return stake * (odds - 1);
      return 0;
    }

    if (bet.result === 'lost') {
      return stake > 0 ? -stake : 0;
    }

    return 0;
  };

  for (const bet of settled) {
    const mode = normalizeSlipMode(bet.slipMode || bet.mode || bet.riskMode) || 'unassigned';
    const stake = Number(bet.stake || 0);
    const profit = profitForBet(bet);

    if (!byMode[mode]) {
      byMode[mode] = {
        mode,
        settled: 0,
        won: 0,
        lost: 0,
        stakeTurnover: 0,
        netProfit: 0,
      };
    }

    byMode[mode].settled++;
    if (bet.result === 'won') byMode[mode].won++;
    else byMode[mode].lost++;
    if (stake > 0) byMode[mode].stakeTurnover += stake;
    byMode[mode].netProfit += profit;
  }

  const rows = Object.values(byMode)
    .map((r) => {
      const winRate = r.settled > 0 ? +((r.won / r.settled) * 100).toFixed(1) : 0;
      const roi = r.stakeTurnover > 0 ? +((r.netProfit / r.stakeTurnover) * 100).toFixed(1) : null;
      return {
        mode: r.mode,
        settled: r.settled,
        won: r.won,
        lost: r.lost,
        winRate,
        stakeTurnover: Math.round(r.stakeTurnover),
        netProfit: Math.round(r.netProfit),
        roi,
      };
    })
    .sort((a, b) => b.settled - a.settled || (b.roi ?? -999) - (a.roi ?? -999));

  const bestMode = rows
    .filter((r) => r.settled >= 5 && r.roi != null)
    .sort((a, b) => b.roi - a.roi)[0] || null;

  res.json({
    totalSettled: settled.length,
    modes: rows,
    bestMode,
    note: rows.length === 0
      ? 'No settled bets with mode tags yet. Start logging bets with slipMode to unlock tracking.'
      : 'Best mode requires at least 5 settled bets with valid stake/odds inputs.',
  });
});

app.get('/api/stats/calibration-hook', (req, res) => {
  res.json({
    updatedAt: postMatchCalibrationStore.updatedAt,
    totalSettled: postMatchCalibrationStore.totalSettled,
    byMode: postMatchCalibrationStore.byMode,
    byFamily: postMatchCalibrationStore.byFamily,
  });
});

// ── Bet pattern analysis ─────────────────────────────────────────────────────
app.get('/api/bets/patterns', async (req, res) => {
  const db = getDb();
  let allBets = bets;
  if (db) {
    try {
      const snapshot = await db.collection('bets').get();
      allBets = snapshot.docs.map(d => d.data());
    } catch (err) {
      console.error('Firestore bets patterns error:', err.message);
    }
  }

  const settled = allBets.filter(b => b.result === 'won' || b.result === 'lost');
  if (settled.length === 0) {
    return res.json({
      summary: { totalSettled: 0, message: 'No settled bets yet. Patterns will appear after results are recorded.' },
      byBetType: [], byConfidenceBand: [], byLeague: [], byHour: [], flags: [],
    });
  }

  const MIN_SAMPLE = 5;

  function groupStats(items) {
    const won = items.filter(b => b.result === 'won').length;
    const total = won + items.filter(b => b.result === 'lost').length;
    const winRate = total > 0 ? +((won / total) * 100).toFixed(1) : null;
    const withConf = items.filter(b => b.confidence != null);
    const avgConf = withConf.length > 0
      ? +(withConf.reduce((s, b) => s + Number(b.confidence), 0) / withConf.length).toFixed(1)
      : null;
    const calibrationGap = (winRate != null && avgConf != null)
      ? +(winRate - avgConf).toFixed(1) : null;
    // CLV: only when both entry odds and closing odds are recorded
    const betsWithCLV = items.filter(b => b.closingOdds != null && b.odds != null && Number(b.closingOdds) > 0);
    const avgCLV = betsWithCLV.length >= 3
      ? +(betsWithCLV.reduce((s, b) => s + ((Number(b.odds) - Number(b.closingOdds)) / Number(b.closingOdds)) * 100, 0) / betsWithCLV.length).toFixed(2)
      : null;
    return { settled: total, won, lost: total - won, winRate, avgConf, calibrationGap, avgCLV, clvSampleSize: betsWithCLV.length };
  }

  function detectFlag(stats, label) {
    if (stats.settled < MIN_SAMPLE) return null;
    if (stats.calibrationGap != null && stats.calibrationGap < -20)
      return { severity: 'HIGH', type: 'OVERCONFIDENT', label,
        message: `${label}: winning ${stats.winRate}% but avg stated confidence ${stats.avgConf}%. Overconfident by ${Math.abs(stats.calibrationGap)}pp.` };
    if (stats.calibrationGap != null && stats.calibrationGap > 20)
      return { severity: 'MEDIUM', type: 'UNDERCONFIDENT', label,
        message: `${label}: winning ${stats.winRate}% vs ${stats.avgConf}% stated. Consider increasing stake here.` };
    if (stats.winRate < 35)
      return { severity: 'HIGH', type: 'LOW_HIT_RATE', label,
        message: `${label}: only ${stats.winRate}% win rate over ${stats.settled} bets. Review selection criteria.` };
    if (stats.winRate > 80 && stats.settled >= 8)
      return { severity: 'LOW', type: 'HIGH_HIT_RATE', label,
        message: `${label}: strong ${stats.winRate}% win rate. This category is outperforming — consider increasing allocation.` };
    return null;
  }

  // 1. By bet type (engine category)
  const betTypeKeys = [...new Set(settled.map(b => b.betType || b.type || 'UNKNOWN'))];
  const byBetType = betTypeKeys.map(type => {
    const items = settled.filter(b => (b.betType || b.type || 'UNKNOWN') === type);
    const stats = groupStats(items);
    return { type, ...stats, flag: detectFlag(stats, `Bet type: ${type}`) };
  }).sort((a, b) => b.settled - a.settled);

  // 2. By confidence band (10-point buckets)
  const BANDS = [
    { label: '90-100%', min: 90, max: 100, mid: 95 },
    { label: '80-89%',  min: 80, max: 89,  mid: 85 },
    { label: '70-79%',  min: 70, max: 79,  mid: 75 },
    { label: '60-69%',  min: 60, max: 69,  mid: 65 },
    { label: '50-59%',  min: 50, max: 59,  mid: 55 },
    { label: '<50%',    min: 0,  max: 49,  mid: 40 },
  ];
  const betsWithConf = settled.filter(b => b.confidence != null);
  const byConfidenceBand = BANDS.map(({ label, min, max, mid }) => {
    const items = betsWithConf.filter(b => Number(b.confidence) >= min && Number(b.confidence) <= max);
    if (items.length === 0) return null;
    const stats = groupStats(items);
    const calibGap = stats.winRate != null ? +(stats.winRate - mid).toFixed(1) : null;
    const flag = items.length >= MIN_SAMPLE && calibGap != null
      ? (calibGap < -20
          ? { severity: 'HIGH', type: 'OVERCONFIDENT', label: `Band ${label}`,
              message: `At ${label} confidence: winning only ${stats.winRate}%. Model overestimates by ${Math.abs(calibGap)}pp.` }
          : calibGap > 20
          ? { severity: 'MEDIUM', type: 'UNDERCONFIDENT', label: `Band ${label}`,
              message: `At ${label} confidence: winning ${stats.winRate}% — better than stated. Increase stake here.` }
          : null)
      : null;
    return { band: label, midConf: mid, ...stats, calibrationGapFromBand: calibGap, flag };
  }).filter(Boolean);

  // 3. By league (top 15 by volume)
  const leagueKeys = [...new Set(settled.map(b => b.leagueName || b.league || 'Unknown'))];
  const byLeague = leagueKeys.map(league => {
    const items = settled.filter(b => (b.leagueName || b.league || 'Unknown') === league);
    const stats = groupStats(items);
    return { league, ...stats, flag: detectFlag(stats, `League: ${league}`) };
  }).sort((a, b) => b.settled - a.settled).slice(0, 15);

  // 4. By UTC hour when bet was placed
  const byHour = [];
  for (let h = 0; h < 24; h++) {
    const items = settled.filter(b => {
      try { return new Date(b.createdAt).getUTCHours() === h; } catch { return false; }
    });
    if (items.length === 0) continue;
    const stats = groupStats(items);
    byHour.push({ hour: h, label: `${String(h).padStart(2, '0')}:00 UTC`, ...stats,
      flag: detectFlag(stats, `Hour ${h}:00 UTC`) });
  }

  // Aggregate all flags sorted by severity
  const allFlags = [
    ...byBetType.map(g => g.flag),
    ...byConfidenceBand.map(g => g.flag),
    ...byLeague.map(g => g.flag),
    ...byHour.map(g => g.flag),
  ].filter(Boolean).sort((a, b) =>
    ['HIGH', 'MEDIUM', 'LOW'].indexOf(a.severity) - ['HIGH', 'MEDIUM', 'LOW'].indexOf(b.severity)
  );

  const totalWon = settled.filter(b => b.result === 'won').length;
  const overallWinRate = +((totalWon / settled.length) * 100).toFixed(1);
  const allAvgConf = betsWithConf.length > 0
    ? +(betsWithConf.reduce((s, b) => s + Number(b.confidence), 0) / betsWithConf.length).toFixed(1)
    : null;
  const overallCalGap = allAvgConf != null ? +(overallWinRate - allAvgConf).toFixed(1) : null;

  res.json({
    summary: {
      totalSettled: settled.length,
      totalWon,
      totalLost: settled.length - totalWon,
      overallWinRate,
      avgStatedConfidence: allAvgConf,
      overallCalibrationGap: overallCalGap,
      calibrationStatus: overallCalGap == null ? 'No confidence data'
        : overallCalGap < -20 ? '🔴 OVERCONFIDENT — model overstates probability'
        : overallCalGap > 20  ? '🟡 UNDERCONFIDENT — model understates probability'
        : '🟢 WELL CALIBRATED',
      lastUpdated: new Date().toISOString(),
    },
    byBetType,
    byConfidenceBand,
    byLeague,
    byHour,
    flags: allFlags,
    dataQuality: {
      betsWithConfidence: betsWithConf.length,
      betsWithLeague: settled.filter(b => b.leagueName || b.league).length,
      note: betsWithConf.length < 10
        ? 'Calibration improves with more data. Log at least 10 settled bets with confidence scores for meaningful patterns.'
        : null,
    },
  });
});


// ─── ANALYTICS ENDPOINTS ────────────────────────────────────────────────────

app.get('/api/team-form/:teamId', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { league } = req.query;
    
    const formData = await getTeamForm(parseInt(teamId), league ? parseInt(league) : null);
    res.json(formData);
  } catch (error) {
    console.error('Error fetching team form:', error.message);
    res.status(500).json({ error: 'Could not fetch team form data' });
  }
});

app.get('/api/h2h/:homeTeamId/:awayTeamId', async (req, res) => {
  try {
    const { homeTeamId, awayTeamId } = req.params;
    
    const h2hData = await getH2H(parseInt(homeTeamId), parseInt(awayTeamId));
    res.json(h2hData);
  } catch (error) {
    console.error('Error fetching H2H:', error.message);
    res.status(500).json({ error: 'Could not fetch H2H data' });
  }
});

app.get('/api/fixture-preview/:fixtureId/:homeTeamId/:awayTeamId', async (req, res) => {
  try {
    const { fixtureId, homeTeamId, awayTeamId } = req.params;
    const { league } = req.query;
    
    const preview = await getFixturePreview(
      parseInt(fixtureId),
      parseInt(homeTeamId),
      parseInt(awayTeamId),
      league ? parseInt(league) : null
    );
    
    res.json(preview);
  } catch (error) {
    console.error('Error fetching fixture preview:', error.message);
    res.status(500).json({ error: 'Could not fetch fixture preview' });
  }
});

// ─── LIVE ANALYTICS ENDPOINTS ───────────────────────────────────────────────

app.get('/api/live-analysis/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    // Handle both string and numeric IDs
    const match = liveMatches.find((m) => m.id == matchId || m.id === parseInt(matchId));

    if (!match) {
      return res.status(404).json({ error: 'Match not found in live matches' });
    }

    const nextGoalProb = calculateNextGoalProbability(match);
    const momentum = calculateMomentum(match);
    const matchAlerts = generateBettingAlert(match, nextGoalProb, momentum);

    // Persist high-confidence alerts
    if (matchAlerts && matchAlerts.length > 0) {
      for (const alert of matchAlerts) {
        const alertConf = alert.probability || alert.confidence || match.decisionProbability || match.confidence || 0;
        const policy = getPhaseConfidencePolicy(match.status, match.matchMinutes || 0);
        if (alertConf >= policy.standardThreshold) {
          await saveAlert({
            matchId: match.id,
            home: match.home,
            away: match.away,
            league: match.league,
            type: alert.type || 'in-play',
            message: alert.message || alert,
            confidence: alertConf,
            status: match.status,
            matchMinutes: match.matchMinutes || 0,
            sentAt: new Date().toISOString(),
          });
        }
      }
    }

    res.json({
      matchId,
      home: match.home,
      away: match.away,
      nextGoal: nextGoalProb.nextGoal || null,
      goalPace: nextGoalProb.goalPace || null,
      momentum,
      alerts: matchAlerts,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error calculating live analysis:', error.message);
    res.status(500).json({ error: 'Could not calculate live analysis' });
  }
});

app.post('/api/bet-value', (req, res) => {
  try {
    const { probability, odds } = req.body;

    if (!probability || !odds) {
      return res.status(400).json({ error: 'Missing probability or odds' });
    }

    const valueAnalysis = calculateBetValue(probability, odds);
    res.json(valueAnalysis);
  } catch (error) {
    console.error('Error calculating bet value:', error.message);
    res.status(500).json({ error: 'Could not calculate bet value' });
  }
});

// ─── V10.2 ANALYST-NARRATIVE CACHE ──────────────────────────────────────────
// Football analysis must never wait on prose generation.
// /api/analyze returns the mathematical result immediately, while this cache
// fills asynchronously. The frontend polls the cheap cache endpoint.
const narrativeCache = new Map();
const narrativeInFlight = new Map();
const NARRATIVE_CACHE_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.NARRATIVE_CACHE_TTL_MS || 20 * 60 * 1000),
);

function buildNarrativeKey(matchData = {}) {
  const fixtureIdentity = matchData.fixtureId
    || matchData.id
    || `${String(matchData.home || '').toLowerCase()}|${String(matchData.away || '').toLowerCase()}|${matchData.season ?? ''}`;
  const status = String(matchData.status || 'NS').toUpperCase();
  const score = String(matchData.score || '0-0');
  const minute = Number(matchData.matchMinutes || 0);
  const live = status === 'LIVE' || ['1H', '2H', 'HT', 'ET', 'BT', 'P'].includes(status);
  const minuteBucket = live ? Math.floor(minute / 10) : 0;
  return Buffer.from(`${fixtureIdentity}|${score}|${minuteBucket}`).toString('base64url');
}

function readNarrativeCache(key) {
  const cached = narrativeCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > NARRATIVE_CACHE_TTL_MS) {
    narrativeCache.delete(key);
    return null;
  }
  return cached.narrative;
}

function startNarrativeGeneration(key, analysis, matchData) {
  const cached = readNarrativeCache(key);
  if (cached) return Promise.resolve(cached);
  if (narrativeInFlight.has(key)) return narrativeInFlight.get(key);

  const task = generateMatchNarrative(analysis, matchData)
    .then((narrative) => {
      if (narrative) {
        narrativeCache.set(key, { narrative, timestamp: Date.now() });
      }
      return narrative || null;
    })
    .catch((err) => {
      console.warn('[Narrative] background generation skipped:', err.message);
      return null;
    })
    .finally(() => narrativeInFlight.delete(key));

  narrativeInFlight.set(key, task);
  return task;
}

app.get('/api/analyze/narrative/:key', (req, res) => {
  const key = String(req.params.key || '');
  const narrative = readNarrativeCache(key);
  if (narrative) {
    return res.json({ status: 'available', narrative });
  }
  if (narrativeInFlight.has(key)) {
    return res.status(202).json({ status: 'pending' });
  }
  return res.status(404).json({ status: 'missing' });
});

// ─── AGENT 47 V9 ENDPOINTS ─────────────────────────────────────────────────

/**
 * POST /api/analyze
 * Full V9 analysis for a match card click.
 * Fetches real form, H2H, standings from API-Football (1h cache),
 * applies live xG projection when in-play, runs V9, then layers
 * a Groq narrative summary on top.
 *
 * Required body fields: home, away, leagueId, status
 * Optional enrichment:  homeTeamId, awayTeamId (enables real form/standings)
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Request body must be a matchData object' });
    }

    const homeTeamId = body.homeTeamId;
    const awayTeamId = body.awayTeamId;
    const leagueId   = body.leagueId || 0;
    const isLive     = body.status === 'LIVE' || ['1H','2H','HT','ET','BT','P'].includes(body.status);
    const matchMins  = body.matchMinutes || 0;
    const fixtureId  = body.fixtureId || body.id || null;

    const hasMetricValue = (v) => finiteNumberOrNull(v) != null;
    const hasAnyMetric = (obj) => hasMetricValue(obj?.home) || hasMetricValue(obj?.away);
    const preLiveStats = {
      possession: hasAnyMetric(body.possession),
      shots: hasAnyMetric(body.shots),
      xg: hasAnyMetric(body.xg),
    };
    let directFixtureStatsStatus = { status: 'not_attempted', source: 'fixture-statistics', reason: null };
    let standingsStatus = { status: 'unavailable', source: homeTeamId && awayTeamId ? 'api-football-standings' : 'not-requested' };

    // ── Step 1: deliberate user-click enrichment ────────────────────────────
    // A match click means "give me the full Agent47 evidence desk". We spend calls
    // here intentionally, while retaining the quota guard and analytics-service cache.
    let enriched = { ...body };
    const clickEnrichmentEnabled = body.enrich !== false;
    if (clickEnrichmentEnabled && homeTeamId && awayTeamId) {
      const season = body.season ?? body.fixtureContext?.season ?? null;
      if (!shouldSkipApiCalls()) {
        const [hRes, aRes, standingsRes, hStatsRes, aStatsRes, hInjRes, aInjRes, h2hRes] = await Promise.allSettled([
          getTeamForm(homeTeamId, leagueId, season),
          getTeamForm(awayTeamId, leagueId, season),
          getStandings({ leagueId, season, homeTeamId, awayTeamId }),
          getTeamStatistics(homeTeamId, leagueId, season),
          getTeamStatistics(awayTeamId, leagueId, season),
          getTeamInjuries(homeTeamId, leagueId, season),
          getTeamInjuries(awayTeamId, leagueId, season),
          getH2H(homeTeamId, awayTeamId),
        ]);

        if (hRes.status === 'fulfilled' && !hRes.value?.offline && hRes.value?.stats) {
          const hs = hRes.value.stats;
          if (hs.form) enriched.homeForm = hs.form.split('').join('-');
          enriched.homeSampleSize = Array.isArray(hRes.value.matches) ? hRes.value.matches.length : null;
          const homeGoalsFor = Number.parseFloat(hs.avgGoalsFor);
          const homeGoalsAgainst = Number.parseFloat(hs.avgGoalsAgainst);
          if (Number.isFinite(homeGoalsFor)) enriched.homeGoalsAvgFor = homeGoalsFor;
          if (Number.isFinite(homeGoalsAgainst)) enriched.homeGoalsAvgAgainst = homeGoalsAgainst;
          if (hs.goalDrought != null) enriched.homeGoalDrought = hs.goalDrought;
          if (hs.recentLosses != null) enriched.homeRecentLosses = hs.recentLosses;
          if (hs.recentOpposition) enriched.homeRecentOpposition = hs.recentOpposition;
        }

        if (aRes.status === 'fulfilled' && !aRes.value?.offline && aRes.value?.stats) {
          const as = aRes.value.stats;
          if (as.form) enriched.awayForm = as.form.split('').join('-');
          enriched.awaySampleSize = Array.isArray(aRes.value.matches) ? aRes.value.matches.length : null;
          const awayGoalsFor = Number.parseFloat(as.avgGoalsFor);
          const awayGoalsAgainst = Number.parseFloat(as.avgGoalsAgainst);
          if (Number.isFinite(awayGoalsFor)) enriched.awayGoalsAvgFor = awayGoalsFor;
          if (Number.isFinite(awayGoalsAgainst)) enriched.awayGoalsAvgAgainst = awayGoalsAgainst;
          if (as.goalDrought != null) enriched.awayGoalDrought = as.goalDrought;
          if (as.recentLosses != null) enriched.awayRecentLosses = as.recentLosses;
          if (as.recentOpposition) enriched.awayRecentOpposition = as.recentOpposition;
        }

        if (standingsRes.status === 'fulfilled' && standingsRes.value?.status === 'AVAILABLE' && standingsRes.value?.teams) {
          const tms = standingsRes.value.teams;
          enriched.totalTeams = standingsRes.value.totalTeams || null;
          if (tms[homeTeamId]) {
            enriched.homePosition = tms[homeTeamId].position ?? null;
            enriched.homePoints = tms[homeTeamId].points ?? null;
          }
          if (tms[awayTeamId]) {
            enriched.awayPosition = tms[awayTeamId].position ?? null;
            enriched.awayPoints = tms[awayTeamId].points ?? null;
          }
          const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
          if (played > 0) enriched.gameWeek = played;
          standingsStatus = { status: 'available', source: 'api-football-standings' };
        }

        if (hStatsRes.status === 'fulfilled' && !hStatsRes.value?.offline && hStatsRes.value?.stats) {
          const hs = hStatsRes.value.stats;
          if (hs.conversionPct != null) enriched.homeConversionPct = hs.conversionPct;
          if (hs.avgShotsTotal != null) enriched.homeShotsPerGame = hs.avgShotsTotal;
          if (hs.avgPossession != null) enriched.homePossession = hs.avgPossession;
          if (hs.lateGoalPct != null) enriched.homeLateGoalPct = hs.lateGoalPct;
        }
        if (aStatsRes.status === 'fulfilled' && !aStatsRes.value?.offline && aStatsRes.value?.stats) {
          const as = aStatsRes.value.stats;
          if (as.conversionPct != null) enriched.awayConversionPct = as.conversionPct;
          if (as.avgShotsTotal != null) enriched.awayShotsPerGame = as.avgShotsTotal;
          if (as.lateGoalPct != null) enriched.awayLateGoalPct = as.lateGoalPct;
        }

        if (hInjRes.status === 'fulfilled' && !hInjRes.value?.offline) {
          if (hInjRes.value?.squadIntegrity != null) enriched.homeSquadIntegrity = hInjRes.value.squadIntegrity;
          if (Array.isArray(hInjRes.value?.keyAbsences)) enriched.homeKeyAbsences = hInjRes.value.keyAbsences;
        }
        if (aInjRes.status === 'fulfilled' && !aInjRes.value?.offline) {
          if (aInjRes.value?.squadIntegrity != null) enriched.awaySquadIntegrity = aInjRes.value.squadIntegrity;
          if (Array.isArray(aInjRes.value?.keyAbsences)) enriched.awayKeyAbsences = aInjRes.value.keyAbsences;
        }

        // Exact H2H rows are safe only after re-orienting every historical score
        // to the CURRENT fixture's home/away teams. Never convert aggregate counts
        // into invented scorelines.
        enriched.h2hHistory = [];
        if (h2hRes.status === 'fulfilled' && Array.isArray(h2hRes.value?.matches)) {
          const normName = (s) => String(s || '').toLowerCase().trim();
          const currentHome = normName(enriched.home);
          const currentAway = normName(enriched.away);
          enriched.h2hHistory = h2hRes.value.matches.map((m) => {
            const histHome = normName(m.home);
            const histAway = normName(m.away);
            let homeGoals = null;
            let awayGoals = null;
            if (histHome === currentHome && histAway === currentAway) {
              homeGoals = Number(m.homeGoals);
              awayGoals = Number(m.awayGoals);
            } else if (histHome === currentAway && histAway === currentHome) {
              homeGoals = Number(m.awayGoals);
              awayGoals = Number(m.homeGoals);
            } else {
              return null;
            }
            if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
            return {
              homeGoals,
              awayGoals,
              winner: homeGoals > awayGoals ? 'home' : homeGoals < awayGoals ? 'away' : 'draw',
            };
          }).filter(Boolean);
        }
      } else {
        enriched.h2hHistory = [];
      }
    }

    // ── Gemini calibration fallback — restore enriched inputs when API-Football is offline ──
    // When calibration ran with Gemini-sourced stats (no API-Football key / quota guard),
    // those values are stored in calMatch.calibratedInputs. Apply them here only for fields
    // that the API-Football enrichment above could not populate — API-Football always wins.
    const _calNorm = (s) => (s || '').toLowerCase().trim();
    const calFb = calibrationStore.matches.find(m =>
      _calNorm(m.home) === _calNorm(enriched.home) && _calNorm(m.away) === _calNorm(enriched.away)
    );
    if (calFb?.calibratedInputs) {
      const ci = calFb.calibratedInputs;
      const requestedSeason = body.season ?? body.fixtureContext?.season ?? null;
      if (ci.source === 'API_FOOTBALL' && requestedSeason != null && ci.season === requestedSeason) {
        if (!enriched.homeForm) enriched.homeForm = ci.homeForm;
        if (!enriched.awayForm) enriched.awayForm = ci.awayForm;
        if (enriched.homeGoalsAvgFor == null) enriched.homeGoalsAvgFor = ci.homeGoalsAvgFor;
        if (enriched.awayGoalsAvgFor == null) enriched.awayGoalsAvgFor = ci.awayGoalsAvgFor;
        if (enriched.homeGoalsAvgAgainst == null) enriched.homeGoalsAvgAgainst = ci.homeGoalsAvgAgainst;
        if (enriched.awayGoalsAvgAgainst == null) enriched.awayGoalsAvgAgainst = ci.awayGoalsAvgAgainst;
        if (enriched.homeSampleSize == null) enriched.homeSampleSize = ci.homeSampleSize;
        if (enriched.awaySampleSize == null) enriched.awaySampleSize = ci.awaySampleSize;
      }
    }

    // ── Step 1b: optional on-demand fixture stats ───────────────────────────
    // V10.3 defaults this OFF so Prediction Desk clicks do not spend API-Football
    // quota. The portal-open live refresh remains the normal daytime API trigger.
    if (clickEnrichmentEnabled && isLive && fixtureId) {
      if (!API_KEY) {
        directFixtureStatsStatus = { status: 'unavailable', source: 'fixture-statistics', reason: 'API_FOOTBALL_KEY_missing' };
      } else if (shouldSkipApiCalls()) {
        directFixtureStatsStatus = {
          status: 'unavailable',
          source: 'fixture-statistics',
          reason: quotaState.isPaused
            ? `quota_guard_paused: ${quotaState.pauseReason || 'unknown'}`
            : 'api_calls_temporarily_skipped',
        };
      } else {
        const directStats = await fetchFixtureStatistics(fixtureId);
        if (directStats) {
          directFixtureStatsStatus = { status: 'available', source: 'fixture-statistics', reason: null };
          if (directStats.possession?.home != null || directStats.possession?.away != null) {
            enriched.possession = {
              home: directStats.possession?.home ?? enriched.possession?.home ?? null,
              away: directStats.possession?.away ?? enriched.possession?.away ?? null,
            };
          }
          if (directStats.shots?.home != null || directStats.shots?.away != null) {
            enriched.shots = {
              home: directStats.shots?.home ?? enriched.shots?.home ?? null,
              away: directStats.shots?.away ?? enriched.shots?.away ?? null,
            };
          }
          if (directStats.xg?.home != null || directStats.xg?.away != null) {
            enriched.xg = {
              home: directStats.xg?.home ?? enriched.xg?.home ?? null,
              away: directStats.xg?.away ?? enriched.xg?.away ?? null,
            };
            enriched.hasLiveXg = true;
          }
          if (directStats.cards) {
            enriched.homeCards = directStats.cards.home;
            enriched.awayCards = directStats.cards.away;
          }
        } else {
          directFixtureStatsStatus = {
            status: 'unavailable',
            source: 'fixture-statistics',
            reason: 'provider_returned_no_stats_for_fixture',
          };
        }
      }
    } else if (isLive && !clickEnrichmentEnabled) {
      directFixtureStatsStatus = {
        status: 'not_requested',
        source: 'fixture-statistics',
        reason: 'click_enrichment_disabled',
      };
    } else if (isLive && !fixtureId) {
      directFixtureStatsStatus = { status: 'unavailable', source: 'fixture-statistics', reason: 'missing_fixture_id' };
    }

    const finalLiveStats = {
      possession: hasAnyMetric(enriched.possession),
      shots: hasAnyMetric(enriched.shots),
      xg: hasAnyMetric(enriched.xg),
    };
    const liveMetricCount = [finalLiveStats.possession, finalLiveStats.shots, finalLiveStats.xg].filter(Boolean).length;
    const preMetricCount = [preLiveStats.possession, preLiveStats.shots, preLiveStats.xg].filter(Boolean).length;
    const liveStatsStatus = {
      status: liveMetricCount === 0 ? 'unavailable' : liveMetricCount === 3 ? 'available' : 'partial',
      source: liveMetricCount > preMetricCount ? 'fixture-statistics+live-feed' : 'live-feed',
    };

    enriched.dataSourceStatus = {
      standings: standingsStatus,
      liveStats: isLive ? liveStatsStatus : { status: 'not_applicable', source: 'pre-match' },
      directFixtureStats: isLive ? directFixtureStatsStatus : { status: 'not_applicable', source: 'pre-match' },
    };

    // ── Step 2a: Phase-based live shots & possession blending ───────────────
    // EARLY: baseline-heavy, MID: blended, LATE: live-only when available.
    if (isLive) {
      const hShots = enriched.shots?.home ?? 0;
      const aShots = enriched.shots?.away ?? 0;
      const hPoss  = enriched.possession?.home ?? null;
      const norm  = matchMins > 0 ? (90 / matchMins) : 1;
      if (hShots > 0) {
        const liveShotsH = hShots * norm;
        const baseH = enriched.homeShotsPerGame ?? null;
        if (baseH != null) enriched.homeShotsPerGame = parseFloat(phaseBlendCountStat(baseH, liveShotsH, matchMins, 180).toFixed(1));
      }
      if (aShots > 0) {
        const liveShotsA = aShots * norm;
        const baseA = enriched.awayShotsPerGame ?? null;
        if (baseA != null) enriched.awayShotsPerGame = parseFloat(phaseBlendCountStat(baseA, liveShotsA, matchMins, 180).toFixed(1));
      }
      if (hPoss != null && hPoss > 0) {
        const basePoss = enriched.homePossession ?? null;
        enriched.homePossession = basePoss != null
          ? parseFloat(phaseBlendPctStat(basePoss, hPoss, matchMins, 360).toFixed(1))
          : hPoss;
      }
    }

    // ── Step 2: Live xG projection ───────────────────────────────────────────
    // Only runs when ACTUAL in-match accumulated xG was available (hasLiveXg=true).
    // Never runs on season-average fallback defaults — those would be squashed by
    // the Poisson interaction formula (lH = avg² / L) giving absurd λ values.
    if (isLive && matchMins >= 15 && enriched.hasLiveXg) {
      const phase = getLivePhase(matchMins);
      if (phase === 'LATE') {
        if (enriched.xg?.home > 0) {
          enriched.homeXgAvg = enriched.xg.home;
          enriched.awayXgaAvg = enriched.xg.home;
        }
        if (enriched.xg?.away > 0) {
          enriched.awayXgAvg = enriched.xg.away;
          enriched.homeXgaAvg = enriched.xg.away;
        }
      } else {
        const progress    = Math.min(matchMins / 90, 1.0);
        const projFactor  = Math.min(90 / matchMins, 3.2);
        const blendWeight = phase === 'MID' ? Math.min(0.55, progress * 1.05) : Math.min(0.35, progress * 0.8);
        const project = (v) => v > 0
          ? Math.min(v * (1 - blendWeight) + v * projFactor * blendWeight, 3.5)
          : v;
        enriched.homeXgAvg  = project(enriched.homeXgAvg  || 0);
        enriched.homeXgaAvg = project(enriched.homeXgaAvg || 0);
        enriched.awayXgAvg  = project(enriched.awayXgAvg  || 0);
        enriched.awayXgaAvg = project(enriched.awayXgaAvg || 0);
      }
      // Detect early goal for V9 chaos variable
      const [hG, aG] = (enriched.score || '0-0').split('-').map(n => parseInt(n) || 0);
      if (hG + aG > 0 && matchMins <= 20) {
        enriched.earlyGoalScored = true;
        enriched.earlyGoalMinute = matchMins;
      }
    }

    // ── Step 3: Run V9 engine ────────────────────────────────────────────────
    const analysis = analyzeV9(enriched);

    // ── Step 4: analyst note is non-blocking ────────────────────────────────
    const narrativeKey = buildNarrativeKey(enriched);
    const cachedNarrative = readNarrativeCache(narrativeKey);
    analysis.narrativeKey = narrativeKey;
    if (cachedNarrative) {
      analysis.narrative = cachedNarrative;
      analysis.narrativeStatus = 'available';
    } else {
      analysis.narrativeStatus = 'pending';
      startNarrativeGeneration(narrativeKey, analysis, enriched);
    }

    // Critical path ends here: return football analysis without waiting for an LLM.
    res.json(analysis);
  } catch (error) {
    console.error('V10 analysis error:', error.message);
    res.status(500).json({ error: 'Analysis failed', detail: error.message });
  }
});

/**
 * GET /api/analyze/live/:matchId
 * Runs V9 analysis on a live match already in the in-memory store.
 * If the polling cycle already computed a V9 analysis for this match, returns it directly.
 * Otherwise fetches real standings + team stats from API-Football (all cached 1–6 h) and runs V9.
 */
app.get('/api/analyze/live/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const match = liveMatches.find((m) => m.id == matchId || m.id === parseInt(matchId));
    if (!match) return res.status(404).json({ error: 'Match not found in live matches' });

    // Fast path: polling already ran V9 with real data for this match
    if (match.analysis) return res.json(match.analysis);

    // Slow path: match exists but V9 was skipped — fetch real context and re-run
    const homeTeamId = match.homeTeamId;
    const awayTeamId = match.awayTeamId;
    const leagueId   = match.leagueId;

    const onDemandDisabled = { status: 'rejected', reason: new Error('ON_DEMAND_API_ENRICHMENT_DISABLED') };
    const [standingsRes, hStatsRes, aStatsRes, hInjRes, aInjRes] = !shouldSkipApiCalls()
      ? await Promise.allSettled([
          getStandings({ leagueId, season: match.season ?? null, homeTeamId, awayTeamId }),
          getTeamStatistics(homeTeamId, leagueId, match.season ?? null),
          getTeamStatistics(awayTeamId, leagueId, match.season ?? null),
          getTeamInjuries(homeTeamId, leagueId, match.season ?? null),
          getTeamInjuries(awayTeamId, leagueId, match.season ?? null),
        ])
      : [onDemandDisabled, onDemandDisabled, onDemandDisabled, onDemandDisabled, onDemandDisabled];

    let homePosition = null, awayPosition = null, homePoints = null, awayPoints = null, totalTeams = null, gameWeek = null;
    if (standingsRes.status === 'fulfilled' && standingsRes.value?.status === 'AVAILABLE' && standingsRes.value?.teams) {
      const tms = standingsRes.value.teams;
      totalTeams = standingsRes.value.totalTeams || null;
      if (tms[homeTeamId]) { homePosition = tms[homeTeamId].position ?? null; homePoints = tms[homeTeamId].points ?? null; }
      if (tms[awayTeamId]) { awayPosition = tms[awayTeamId].position ?? null; awayPoints = tms[awayTeamId].points ?? null; }
      const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
      if (played > 0) gameWeek = played;
    }

    let homeSquadIntegrity = null, awaySquadIntegrity = null;
    let homeConversionPct = null, awayConversionPct = null;
    let homeSeasonShots = null, awaySeasonShots = null, homeSeasonPossession = null;
    let homeLateGoalPct = null, awayLateGoalPct = null;
    if (hStatsRes.status === 'fulfilled' && !hStatsRes.value?.offline && hStatsRes.value?.stats) {
      const s = hStatsRes.value.stats;
      if (s.conversionPct != null) homeConversionPct    = s.conversionPct;
      if (s.avgShotsTotal  >  0)   homeSeasonShots      = s.avgShotsTotal;
      if (s.avgPossession != null) homeSeasonPossession = s.avgPossession;
      if (s.lateGoalPct   != null) homeLateGoalPct      = s.lateGoalPct;
    }
    if (aStatsRes.status === 'fulfilled' && !aStatsRes.value?.offline && aStatsRes.value?.stats) {
      const s = aStatsRes.value.stats;
      if (s.conversionPct != null) awayConversionPct = s.conversionPct;
      if (s.avgShotsTotal  >  0)   awaySeasonShots   = s.avgShotsTotal;
      if (s.lateGoalPct   != null) awayLateGoalPct   = s.lateGoalPct;
    }
    if (hInjRes.status === 'fulfilled' && !hInjRes.value?.offline && hInjRes.value?.squadIntegrity != null) homeSquadIntegrity = hInjRes.value.squadIntegrity;
    if (aInjRes.status === 'fulfilled' && !aInjRes.value?.offline && aInjRes.value?.squadIntegrity != null) awaySquadIntegrity = aInjRes.value.squadIntegrity;
    let homeKeyAbsences = [], awayKeyAbsences = [];
    if (hInjRes.status === 'fulfilled' && !hInjRes.value?.offline && hInjRes.value?.keyAbsences?.length) homeKeyAbsences = hInjRes.value.keyAbsences;
    if (aInjRes.status === 'fulfilled' && !aInjRes.value?.offline && aInjRes.value?.keyAbsences?.length) awayKeyAbsences = aInjRes.value.keyAbsences;

    const liveMin       = match.matchMinutes || 0;
    const isLive        = match.isLive && liveMin > 0;
    const livePoss      = match.possession?.home || 0;
    const liveShotsHome = match.shots?.home || 0;
    const liveShotsAway = match.shots?.away || 0;
    const liveXgHome    = match.xg?.home || 0;
    const liveXgAway    = match.xg?.away || 0;
    const baseHomeShots = homeSeasonShots ?? null;
    const baseAwayShots = awaySeasonShots ?? null;

    const matchData = {
      home: match.home, away: match.away, league: match.league, leagueId,
      country: match.leagueCountry || '',
      round: match.round || '',
      isKnockout: (match.round || '').toLowerCase().includes('knockout') || (match.round || '').toLowerCase().includes('round of') || (match.round || '').toLowerCase().includes('quarter') || (match.round || '').toLowerCase().includes('semi') || (match.round || '').toLowerCase().includes('final'),
      notes: match.notes || '',
      matchType: match.matchType || 'League',
      status: 'LIVE', matchMinutes: liveMin, score: match.score || '0-0',
      gameWeek, totalGW: (totalTeams != null && totalTeams > 1) ? (totalTeams - 1) * 2 : null, totalTeams,
      homePosition, awayPosition, homePoints, awayPoints,
      homeSquadIntegrity, awaySquadIntegrity,
      homeKeyAbsences, awayKeyAbsences,
      homeConversionPct, awayConversionPct,
      homePossession:   isLive && livePoss > 0
        ? (homeSeasonPossession != null ? phaseBlendPctStat(homeSeasonPossession, livePoss, liveMin, 360) : livePoss)
        : (homeSeasonPossession ?? null),
      homeShotsPerGame: isLive && liveShotsHome > 0 && baseHomeShots != null ? phaseBlendCountStat(baseHomeShots, liveShotsHome, liveMin, 180) : baseHomeShots,
      awayShotsPerGame: isLive && liveShotsAway > 0 && baseAwayShots != null ? phaseBlendCountStat(baseAwayShots, liveShotsAway, liveMin, 180) : baseAwayShots,
      homeLateGoalPct,
      awayLateGoalPct,
      // Use observed live xG directly; null when not yet accumulated (avoids fake tier-bucket defaults)
      homeXgAvg:  liveXgHome > 0 ? liveXgHome : null,
      awayXgAvg:  liveXgAway > 0 ? liveXgAway : null,
      homeXgaAvg: liveXgAway > 0 ? liveXgAway : null,
      awayXgaAvg: liveXgHome > 0 ? liveXgHome : null,
      cards: match.cards,
    };

    res.json(analyzeV9(matchData));
  } catch (error) {
    console.error('V9 live analysis error:', error.message);
    res.status(500).json({ error: 'Live analysis failed', detail: error.message });
  }
});

/**
 * POST /api/analyze/natural
 * Natural language → Gemini → matchData → V9 analysis + Groq narrative.
 * Body: { query: "Persija is playing now" }
 */
app.post('/api/analyze/natural', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Provide a { "query": "<match description>" } body.' });
    }

    console.log(`[Gemini] Natural language query: "${query.trim()}"`);
    const { matchData, geminiConfidence, geminiNotes } = await naturalLanguageToMatchData(query.trim());

    const analysis = analyzeV9(matchData);
    analysis.gemini = { confidence: geminiConfidence, notes: geminiNotes, query: query.trim() };

    // Add Groq narrative
    try {
      const narrative = await generateMatchNarrative(analysis, matchData);
      if (narrative) analysis.narrative = narrative;
    } catch (_) {}

    res.json(analysis);
  } catch (error) {
    console.error('[Gemini] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── CALIBRATION ENGINE ──────────────────────────────────────────────────────

/**
 * Compute Brier Score and Log Loss from settled bets that have a confidence value.
 * Returns null when fewer than 5 settled bets with confidence exist.
 */
function computeCalibrationHealth(settledBets) {
  const withConf = settledBets.filter(b => b.confidence != null && (b.result === 'won' || b.result === 'lost'));
  if (withConf.length < 5) return null;

  const N = withConf.length;
  let brierSum = 0, logLossSum = 0, wins = 0;
  for (const b of withConf) {
    const p = Math.min(Math.max(Number(b.confidence) / 100, 0.0001), 0.9999);
    const y = b.result === 'won' ? 1 : 0;
    brierSum   += (p - y) ** 2;
    logLossSum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    if (y) wins++;
  }

  const brier   = +(brierSum   / N).toFixed(4);
  const logLoss = +(logLossSum / N).toFixed(4);
  const winRate = +(wins / N * 100).toFixed(1);
  const avgConf = +(withConf.reduce((s, b) => s + Number(b.confidence), 0) / N).toFixed(1);
  const calGap  = +(winRate - avgConf).toFixed(1);

  const brierStatus   = brier   < 0.18 ? '🟢 EXCELLENT' : brier   < 0.22 ? '🟢 GOOD' : brier   < 0.25 ? '🟡 FAIR' : '🔴 POOR';
  const logLossStatus = logLoss < 0.30 ? '🟢 EXCELLENT' : logLoss < 0.35 ? '🟢 GOOD' : logLoss < 0.40 ? '🟡 FAIR' : '🔴 POOR';
  const calStatus     = Math.abs(calGap) < 10
    ? '🟢 WELL CALIBRATED'
    : calGap < -20 ? '🔴 OVERCONFIDENT'
    : calGap >  20 ? '🟡 UNDERCONFIDENT'
    : '🟡 SLIGHT DEVIATION';

  return {
    sampleSize: N,
    brierScore: brier,    brierStatus,
    logLoss,              logLossStatus,
    winRate,
    avgStatedConfidence: avgConf,
    calibrationGap: calGap,
    calibrationStatus: calStatus,
    halt:    brier > 0.25 || logLoss > 0.45,
    caution: brier > 0.22 || logLoss > 0.40,
  };
}

/**
 * Purge prediction records older than 90 days from Firestore.
 * Called from the 6-hour scheduled cron to keep storage lean.
 */
async function purgeOldPredictions() {
  const db = getDb();
  if (!db) return;
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const snap = await db.collection('predictions')
      .where('predictedAt', '<', cutoff.toISOString())
      .limit(500)
      .get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    console.log(`[Predictions] Purged ${snap.size} records older than 90 days`);
  } catch (err) {
    console.warn('[Predictions] Purge failed:', err.message);
  }
}

/**
 * runCalibration()
 * Fetches today's authoritative fixture schedule, performs a bounded current-season
 * analysis pass, then populates calibrationStore + upcomingMatches.
 * Normally called at 05:00 Europe/London, with one restart catch-up if that run was missed.
 */
async function runCalibration() {
  console.log('[Calibrate] Starting day calibration (API-Football → TheSportsDB → Gemini Search)...');

  // Build the new day off-screen. Keep the current feed visible until the
  // replacement daily schedule has been prepared successfully.
  console.log('[Calibrate] Building fresh daily state without wiping the current feed...');

  let raw = [];
  let dailySchedule = [];
  let dataSource = 'unknown';

  // Team stats maps: populated when API-Football team IDs are available
  const calTeamIdMap = new Map(); // normalizedName → { id, leagueId }
  const calTeamStats = new Map(); // teamId → { conversionPct, avgShotsTotal, avgPossession, squadIntegrity }

  // ── Step 1: one authoritative fixture-list call for the whole day ──────────
  const apiFixtures = await fetchTodayFixturesFromApi();
  if (apiFixtures.length > 0) {
    // Keep ALL fixtures lightweight for display. Heavy analysis is bounded below.
    dailySchedule = apiFixtures
      .map(parseLightFixture)
      .filter(Boolean)
      .filter((m) => m.kickoffUTC)
      .sort((a, b) => Date.parse(a.kickoffUTC) - Date.parse(b.kickoffUTC));

    const fixtureList = apiFixtures
      .map(f => ({
        fixtureId: f.fixture?.id ?? null,
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        homeTeamId: f.teams?.home?.id,
        awayTeamId: f.teams?.away?.id,
        league: f.league?.name,
        leagueId: f.league?.id || 0,
        season: f.league?.season ?? null,
        country: f.league?.country,
        kickoffUTC: f.fixture?.date,
        status: f.fixture?.status?.short || 'NS',
      }))
      .filter(f => f.home && f.away && f.kickoffUTC);

    const teamBudget = getEffectiveDailyPrepTeamBudget();
    const candidateFixtures = selectDailyPrepCandidates(
      fixtureList,
      DAILY_PREP_MAX_ANALYZED_FIXTURES,
      teamBudget,
    );

    for (const f of candidateFixtures) {
      if (f.homeTeamId) calTeamIdMap.set(f.home.toLowerCase(), { id: f.homeTeamId, leagueId: f.leagueId, season: f.season });
      if (f.awayTeamId) calTeamIdMap.set(f.away.toLowerCase(), { id: f.awayTeamId, leagueId: f.leagueId, season: f.season });
    }

    if (calTeamIdMap.size > 0) {
      const uniqueTeams = [
        ...new Map(
          [...calTeamIdMap.values()].map((v) => [`${v.id}:${v.leagueId}:${v.season}`, v])
        ).values(),
      ].slice(0, teamBudget);

      await Promise.allSettled(uniqueTeams.map(async ({ id, leagueId, season }) => {
        if (season == null) return;
        try {
          const formRes = await getTeamForm(id, leagueId, season);
          const stats = formRes?.stats || null;
          if (!stats || stats.error) return;
          calTeamStats.set(`${id}:${leagueId}:${season}`, {
            source: 'API_FOOTBALL',
            season,
            form: stats.form || null,
            avgGoalsFor: Number.isFinite(Number(stats.avgGoalsFor)) ? Number(stats.avgGoalsFor) : null,
            avgGoalsAgainst: Number.isFinite(Number(stats.avgGoalsAgainst)) ? Number(stats.avgGoalsAgainst) : null,
            sampleSize: Array.isArray(formRes.matches) ? formRes.matches.length : null,
          });
        } catch (_) {}
      }));
      console.log(`[DailyPrep] Verified form loaded for ${calTeamStats.size} team contexts (budget ${teamBudget})`);
    }

    console.log(`[DailyPrep] ${dailySchedule.length} fixtures listed; ${candidateFixtures.length} selected for deep morning analysis`);
    raw = candidateFixtures.map((f) => ({
      match: {
        fixtureId: f.fixtureId,
        home: f.home,
        away: f.away,
        homeTeamId: f.homeTeamId,
        awayTeamId: f.awayTeamId,
        league: f.league,
        leagueId: f.leagueId,
        season: f.season,
        country: f.country,
        kickoffUTC: f.kickoffUTC,
        status: 'NS',
        minute: 0,
      },
    }));
    dataSource = 'API-Football verified bounded daily core';
  }

  // ── Step 2: TheSportsDB (free, no API key) ─────────────────────────────────
  // Only fall back for fixture discovery when API-Football produced NO schedule.
  // A zero deep-analysis budget must not discard a valid authoritative schedule.
  if (dailySchedule.length === 0) {
    console.log('[Calibrate] API-Football unavailable — TheSportsDB may supply fixture discovery only.');
    const sportsDbFixtures = await fetchTodayFixturesFromSportsDB();
    dailySchedule = sportsDbFixtures
      .map(parseLightFixture)
      .filter(Boolean)
      .filter((m) => m.kickoffUTC && getUkDateStamp(new Date(m.kickoffUTC)) === getUkDateStamp())
      .sort((a, b) => Date.parse(a.kickoffUTC) - Date.parse(b.kickoffUTC));

    const fallbackCandidates = dailySchedule.slice(0, DAILY_PREP_MAX_ANALYZED_FIXTURES);
    raw = fallbackCandidates.map((lite) => ({
      match: {
        fixtureId: lite.id,
        home: lite.home,
        away: lite.away,
        homeTeamId: lite.homeTeamId ?? null,
        awayTeamId: lite.awayTeamId ?? null,
        league: lite.league,
        leagueId: lite.leagueId || 0,
        season: lite.season ?? null,
        country: lite.leagueCountry || '',
        kickoffUTC: lite.kickoffUTC,
        status: 'NS',
        minute: 0,
      },
    }));
    dataSource = 'TheSportsDB fixture-only';
  }

  // ── Step 3: No synthetic fixture generation ───────────────────────────────
  if (raw.length === 0 && dailySchedule.length === 0) {
    console.log('[Calibrate] No authoritative fixture source available — no predictive scan generated.');
  } else if (raw.length === 0) {
    console.log('[DailyPrep] Authoritative schedule retained; deep analysis skipped by quota budget.');
  }

  console.log(`[Calibrate] Processing ${raw.length} fixtures from ${dataSource}`);

  // ── Context adjustments: Gemini+Search news + Groq parameter reasoning ──────
  // ONE Gemini call gets confirmed today's news for all fixtures (injuries,
  // suspensions, manager changes). Then Groq runs per-fixture IN PARALLEL to
  // reason about which V9 inputs to adjust. Applied to matchData BEFORE V9 runs.
  // Fully graceful — calibration continues normally if this step errors.
  const _ctxKey = (h, a) => `${(h || '').toLowerCase().trim()}:${(a || '').toLowerCase().trim()}`;
  let contextAdjMap = new Map();
  try {
    const fixturesForCtx = raw.map(f => ({
      home:               (f.match?.home  || (typeof f.home  === 'string' ? f.home  : null)) || 'Unknown',
      away:               (f.match?.away  || (typeof f.away  === 'string' ? f.away  : null)) || 'Unknown',
      league:             f.match?.league || '',
      homeSquadIntegrity: f.home?.squadIntegrity ?? null,
      awaySquadIntegrity: f.away?.squadIntegrity ?? null,
      homeKeyAbsences:    [],
      awayKeyAbsences:    [],
    }));
    // V10.1: LLMs do not mutate model-critical numeric inputs.
    contextAdjMap = new Map();
  } catch (err) {
    console.warn('[Calibrate] Context adjustment step failed (non-fatal):', err.message);
  }

  const analyzed = [];
  for (const f of raw) {
    try {
      const matchMeta = f.match || {};
      const homeName = matchMeta.home || (typeof f.home === 'string' ? f.home : null) || 'Unknown';
      const awayName = matchMeta.away || (typeof f.away === 'string' ? f.away : null) || 'Unknown';
      // Look up real API-Football stats for this match (available when data source is API-Football)
      const hLookup    = calTeamIdMap.get(homeName.toLowerCase());
      const aLookup    = calTeamIdMap.get(awayName.toLowerCase());
      const hRealStats = hLookup ? calTeamStats.get(`${hLookup.id}:${hLookup.leagueId}:${hLookup.season}`) : null;
      const aRealStats = aLookup ? calTeamStats.get(`${aLookup.id}:${aLookup.leagueId}:${aLookup.season}`) : null;
      const calTotalTeams = f.context?.totalTeams ?? matchMeta.totalTeams ?? null;
      const calTotalGW    = (calTotalTeams != null && calTotalTeams > 1) ? (calTotalTeams - 1) * 2 : null;

      const matchData = {
        home: homeName,
        away: awayName,
        league: matchMeta.league || 'Unknown',
        leagueId: matchMeta.leagueId || 0,
        season: matchMeta.season ?? null,
        country: matchMeta.country || '',
        round: matchMeta.round || '',
        isKnockout: Boolean(matchMeta.isKnockout) || String(matchMeta.round || '').toLowerCase().includes('knockout') || String(matchMeta.round || '').toLowerCase().includes('round of') || String(matchMeta.round || '').toLowerCase().includes('quarter') || String(matchMeta.round || '').toLowerCase().includes('semi') || String(matchMeta.round || '').toLowerCase().includes('final'),
        notes: matchMeta.notes || '',
        matchType: matchMeta.matchType || (matchMeta.isKnockout ? 'Cup' : 'League'),
        status: matchMeta.status || 'NS',
        matchMinutes: matchMeta.minute || 0,
        score: matchMeta.status === 'LIVE' ? `${matchMeta.homeScore || 0}-${matchMeta.awayScore || 0}` : '0-0',
        // ── Competition context — null when not supplied for this fixture season ──
        homePosition:      null,
        awayPosition:      null,
        homePoints:        null,
        awayPoints:        null,
        totalTeams:        calTotalTeams,
        gameWeek:          f.context?.gameWeek     ?? matchMeta.gameWeek     ?? null,
        totalGW:           calTotalGW,
        // ── Verified current-season core evidence ───────────────────────────────
        homeForm: hRealStats?.form ? hRealStats.form.split('').join('-') : null,
        awayForm: aRealStats?.form ? aRealStats.form.split('').join('-') : null,
        homeGoalsAvgFor: hRealStats?.avgGoalsFor ?? null,
        homeGoalsAvgAgainst: hRealStats?.avgGoalsAgainst ?? null,
        awayGoalsAvgFor: aRealStats?.avgGoalsFor ?? null,
        awayGoalsAvgAgainst: aRealStats?.avgGoalsAgainst ?? null,
        homeSampleSize: hRealStats?.sampleSize ?? null,
        awaySampleSize: aRealStats?.sampleSize ?? null,
        // ── Squad quality: real API-Football injuries → integrity, no fake fallback ──
        homeSquadIntegrity: null,
        awaySquadIntegrity: null,
        // ── Goal expectation ──────────────────────────────────────────────────
        homeXgAvg:  null,
        awayXgAvg:  null,
        homeXgaAvg: null,
        awayXgaAvg: null,
        // ── Conversion / shots: real API-Football stats, Gemini as fallback ──
        homeConversionPct: null,
        awayConversionPct: null,
        homeShotsPerGame:  null,
        awayShotsPerGame:  null,
        homePossession:    null,
        homeStats: f.home,
        awayStats: f.away,
        h2h: f.h2h,
        odds: f.odds,
        context: f.context,
      };

      // Apply Gemini+Groq context adjustments (confirmed facts only, bounded ±20)
      const ctxAdj = contextAdjMap.get(_ctxKey(homeName, awayName));
      if (ctxAdj) {
        if (ctxAdj.homeSquadIntegrity != null)  matchData.homeSquadIntegrity = Math.max(0, Math.min(100, ctxAdj.homeSquadIntegrity));
        if (ctxAdj.awaySquadIntegrity != null)  matchData.awaySquadIntegrity = Math.max(0, Math.min(100, ctxAdj.awaySquadIntegrity));
        if (ctxAdj.homeKeyAbsencesAdd?.length)  matchData.homeKeyAbsences    = [...(matchData.homeKeyAbsences || []), ...ctxAdj.homeKeyAbsencesAdd];
        if (ctxAdj.awayKeyAbsencesAdd?.length)  matchData.awayKeyAbsences    = [...(matchData.awayKeyAbsences || []), ...ctxAdj.awayKeyAbsencesAdd];
      }

      const analysis = analyzeV9(matchData);
      const resolvedMatchType = analysis?.match?.competitionContext?.family === 'DOMESTIC_CUP'
        || analysis?.match?.competitionContext?.family?.includes('KNOCKOUT')
        ? 'Cup'
        : (matchData.matchType || 'League');
      const snapshotStats = buildCalibrationSnapshotStats(f);
      const matchObj = sanitizeMatch({
        id: matchMeta.fixtureId || (`cal_${matchMeta.home}_${matchMeta.away}`.replace(/\s/g, '_').slice(0, 50)),
        home: matchMeta.home || 'Unknown',
        away: matchMeta.away || 'Unknown',
        score: matchMeta.status === 'LIVE' ? `${matchMeta.homeScore || 0}-${matchMeta.awayScore || 0}` : '0-0',
        possession: snapshotStats.possession,
        shots:      snapshotStats.shots,
        xg:         snapshotStats.xg,
        status: matchMeta.status || 'NS',
        matchMinutes: matchMeta.minute || 0,
        confidence: analysis?.dailySignal?.score ?? 0,
        decisionProbability: getTopExecutableRecommendation({ home: matchMeta.home, away: matchMeta.away, analysis })?.probability || 0,
        opportunities: (analysis.recommendations || []).slice(0, 2).map(r => r.selection),
        league: matchMeta.league || 'Unknown',
        leagueId: matchMeta.leagueId || 0,
        season: matchMeta.season ?? null,
        homeTeamId: matchMeta.homeTeamId ?? null,
        awayTeamId: matchMeta.awayTeamId ?? null,
        matchType: resolvedMatchType,
        leagueCountry: matchMeta.country || '',
      });
      matchObj.kickoffUTC = matchMeta.kickoffUTC || null;
      matchObj.round = matchMeta.round || null;
      matchObj.notes = matchMeta.notes || null;
      matchObj.analysis = analysis;
      // Preserve V9 inputs so they survive as fallbacks when the user clicks and API-Football is offline.
      // API-Football wins when available; these values are only used to fill gaps.
      matchObj.calibratedInputs = {
        source: 'API_FOOTBALL',
        season: matchData.season ?? null,
        homeForm: matchData.homeForm ?? null,
        awayForm: matchData.awayForm ?? null,
        homeGoalsAvgFor: matchData.homeGoalsAvgFor ?? null,
        awayGoalsAvgFor: matchData.awayGoalsAvgFor ?? null,
        homeGoalsAvgAgainst: matchData.homeGoalsAvgAgainst ?? null,
        awayGoalsAvgAgainst: matchData.awayGoalsAvgAgainst ?? null,
        homeSampleSize: matchData.homeSampleSize ?? null,
        awaySampleSize: matchData.awaySampleSize ?? null,
      };
      // Store context adjustments for transparency (null if none applied this cycle)
      matchObj.contextAdjustments = ctxAdj || null;
      // Calibration is for scheduled fixtures only — no real-time scores available.
      // Force NS so fabricated live states never reach the UI.
      matchObj.status = 'NS';
      matchObj.score = '0-0';
      matchObj.matchMinutes = 0;
      analyzed.push(matchObj);
    } catch (vErr) {
      console.warn(`[Calibrate] V9 skip: ${f.match?.home} vs ${f.match?.away}: ${vErr.message}`);
    }
  }

  // V10.5B: freeze one immutable PRE-MATCH snapshot identity for this preparation run.
  // Later live analysis may change, but this original prediction ID never changes.
  const ledgerPredictedAt = new Date().toISOString();
  const ledgerPreparedDateUK = getUkDateStamp();
  for (const m of analyzed) {
    m.predictionId = buildPredictionLedgerId(m.id, ledgerPreparedDateUK, ledgerPredictedAt);
  }

  // Full Agent47 analyses remain in-process for current-run model logic.
  // Portal/WebSocket payloads stay compact so a 1,000+ fixture day cannot recreate
  // the V10.2 oversized-feed/OOM failure.
  const compactAnalyzed = analyzed.map((m) => compactAnalyzedMatch(m, false));
  const persistedAnalyzed = analyzed.map((m) => compactAnalyzedMatch(m, true));
  const preparedSchedule = mergeDailySchedule(dailySchedule, compactAnalyzed);
  const persistedSchedule = mergeDailySchedule(dailySchedule, persistedAnalyzed);
  const highConfidence = analyzed.filter((m) =>
    m.analysis?.dailySignal?.eligible === true
  );
  // ── Compute calibration health from settled bets ─────────────────────────
  const _settledBets = bets.filter(b => b.result === 'won' || b.result === 'lost');
  const calibrationHealth = computeCalibrationHealth(_settledBets);
  if (calibrationHealth?.halt) {
    console.warn(`[Calibrate] ⚠️  Model health: ${calibrationHealth.calibrationStatus} — Brier ${calibrationHealth.brierScore}, LogLoss ${calibrationHealth.logLoss}`);
  } else if (calibrationHealth) {
    console.log(`[Calibrate] Model health: ${calibrationHealth.calibrationStatus} (Brier ${calibrationHealth.brierScore}, n=${calibrationHealth.sampleSize})`);
  }

  calibrationStore = {
    matches: analyzed,
    highConfidence,
    dailySchedule,
    preparedDateUK: ledgerPreparedDateUK,
    calibratedAt: ledgerPredictedAt,
    totalScanned: dailySchedule.length || raw.length,
    analyzedCount: analyzed.length,
    calibrationHealth,
    lastTrigger: calibrationRunMeta.lastTrigger,
    lastStartedAt: calibrationRunMeta.lastStartedAt,
    lastCompletedAt: calibrationRunMeta.lastCompletedAt,
  };

  // Persist to Firestore so calibration survives server restarts
  const _calDb = getDb();
  if (_calDb) {
    try {
      const calRef = _calDb.collection('calibration').doc('latest');
      const chunkCol = calRef.collection('scheduleChunks');
      const scheduleChunks = chunkArray(persistedSchedule, 50);

      // Replace previous chunk set transactionally enough for our small chunk count.
      // Chunk docs keep each Firestore document comfortably below the 1 MiB ceiling.
      const existingChunks = await chunkCol.get();
      const chunkBatch = _calDb.batch();
      existingChunks.docs.forEach((d) => chunkBatch.delete(d.ref));
      scheduleChunks.forEach((matches, index) => {
        chunkBatch.set(chunkCol.doc(String(index).padStart(4, '0')), {
          index,
          matches,
        });
      });
      await chunkBatch.commit();

      // Parent document contains metadata only; no giant matches arrays.
      await calRef.set({
        schemaVersion: 2,
        scheduleChunkCount: scheduleChunks.length,
        preparedDateUK: calibrationStore.preparedDateUK,
        calibratedAt: calibrationStore.calibratedAt,
        totalScanned: calibrationStore.totalScanned,
        analyzedCount: analyzed.length,
        highConfidenceCount: highConfidence.length,
        calibrationHealth,
        savedAt: new Date().toISOString(),
      });
      console.log(`🔥 Calibration persisted to Firestore in ${scheduleChunks.length} schedule chunks (${analyzed.length} analyzed)`);
    } catch (err) {
      console.warn('⚠️  Calibration Firestore save failed:', err.message);
    }

    // ── Immutable Prediction Ledger ───────────────────────────────────────────
    // Every genuine score-settleable Agent47 market is frozen here.
    // The document ID includes the preparation timestamp, so a later analysis cannot overwrite it.
    if (analyzed.length > 0) {
      try {
        let savedPredictionCount = 0;
        for (const predictionChunk of chunkArray(analyzed, 400)) {
          const predBatch = _calDb.batch();
          for (const m of predictionChunk) {
            const ledgerDoc = buildPredictionLedgerDocument(m, {
              predictionId: m.predictionId,
              predictedAt: ledgerPredictedAt,
              preparedDateUK: ledgerPreparedDateUK,
            });
            if (!ledgerDoc) continue;
            const docRef = _calDb.collection('predictions').doc(ledgerDoc.predictionId);
            predBatch.set(docRef, ledgerDoc, { merge: false });
            savedPredictionCount += 1;
          }
          await predBatch.commit();
        }
        console.log(`[Calibrate] ${savedPredictionCount} predictions stored in Firestore in <=400-write batches (permanent ledger)`);
      } catch (predErr) {
        console.warn('[Calibrate] Prediction ledger save failed:', predErr.message);
      }
    }
  }

  // ── Two-tier WhatsApp alerts (phase-aware thresholds) ─────────────────────
  // conf >= premiumThreshold  → 🏆 HIGH CONFIDENCE (premium)
  // conf >= standardThreshold → 📊 CALIBRATION PICK (standard)
  // conf < standardThreshold  → silent (stored + searchable, no alert)
  try {
    const today = new Date().toDateString();
    const alreadySentToday = new Set(
      alerts.filter(a => a.type?.startsWith('calibration') && new Date(a.sentAt).toDateString() === today)
            .map(a => `${a.home}|${a.away}`)
    );
    const dailyAlertMatches = highConfidence
      .slice()
      .sort((a, b) => (b.analysis?.dailySignal?.score ?? 0) - (a.analysis?.dailySignal?.score ?? 0))
      .slice(0, DAILY_PREP_WHATSAPP_ALERT_LIMIT);

    for (const m of dailyAlertMatches) {
      const topExecutable = getTopExecutableRecommendation(m);
      if (!topExecutable) continue;
      const conf = m.analysis?.dailySignal?.score ?? m.confidence ?? 0;
      const policy = getPhaseConfidencePolicy(m.status, m.matchMinutes || 0);
      if (conf < policy.standardThreshold) continue;

      const matchKey = `${m.home}|${m.away}`;
      if (alreadySentToday.has(matchKey)) continue;
      alreadySentToday.add(matchKey);

      const isPremium = conf >= policy.premiumThreshold;
      const topRec    = topExecutable.recommendation;
      const alertType = isPremium ? 'calibration_premium' : 'calibration';
      const message   = isPremium
        ? `🏆 HIGH CONFIDENCE: ${topRec ? `${topRec.selection} — ${topRec.confidence}% confidence` : `${m.home} vs ${m.away} — ${conf}% overall`}`
        : topRec
          ? `📊 ${topRec.selection} — Tier ${topRec.tier}, ${topRec.confidence}% confidence`
          : `📊 ${m.home} vs ${m.away} — ${conf}% confidence`;

      await saveAlert({
        matchId: m.id,
        home: m.home,
        away: m.away,
        league: m.league,
        type: alertType,
        message,
        confidence: conf,
        confidenceTier: isPremium ? 'PREMIUM' : 'STANDARD',
        status: m.status || 'NS',
        matchMinutes: m.matchMinutes || 0,
        phase: policy.phase,
        standardThreshold: policy.standardThreshold,
        premiumThreshold: policy.premiumThreshold,
        kickoffUTC: m.kickoffUTC || null,
        sentAt: new Date().toISOString(),
      }).catch(e => console.warn(`[Calibrate] Alert save failed: ${e.message}`));
    }
  } catch (alertErr) {
    console.warn(`[Calibrate] Alert loop error: ${alertErr.message}`);
  }

  // Publish the complete day; deep analysis is merged only for bounded candidates.
  if (preparedSchedule.length > 0) {
    upcomingMatches = preparedSchedule;
    setCache('upcomingMatches', preparedSchedule);
    broadcast({ type: 'UPCOMING_MATCHES', payload: preparedSchedule });
    console.log(`[DailyPrep] Ready: ${preparedSchedule.length} fixtures, ${analyzed.length} analyzed, ${highConfidence.length} 80+ eligible signals`);
  } else {
    console.warn('[DailyPrep] No fixtures prepared — retaining existing upcoming feed');
  }

  return calibrationStore;
}

// ─── CALIBRATION & SEARCH ENDPOINTS ─────────────────────────────────────────

/**
 * POST /api/calibrate
 * Fire-and-forget: starts calibration in the background and returns immediately.
 * Poll GET /api/calibrate/results to get the outcome.
 */
app.post('/api/calibrate', (req, res) => {
  if (!ALLOW_MANUAL_DAILY_PREP) {
    return res.status(403).json({
      status: 'disabled',
      message: 'Manual daily preparation is disabled. The controlled scan runs at 05:00 UK.',
      preparedDateUK: calibrationStore.preparedDateUK || null,
      calibratedAt: calibrationStore.calibratedAt || null,
    });
  }
  if (calibrationRunning) {
    return res.json({
      status: 'already_running',
      message: 'Calibration is already in progress.',
      runningTrigger: calibrationRunMeta.runningTrigger,
      runningSince: calibrationRunMeta.runningSince,
    });
  }
  res.json({
    status: 'started',
    trigger: 'manual-background',
    message: 'Calibration started. Poll /api/calibrate/results for progress.',
  });
  // Run async in background — response already sent
  runCalibrationSafely('manual-background').catch(() => {});
});

/**
 * GET /api/calibrate/results
 * Returns the last stored calibration results without re-running.
 */
app.get('/api/calibrate/results', (req, res) => {
  const compactMatches = mergeDailySchedule(
    calibrationStore.dailySchedule || [],
    (calibrationStore.matches || []).map((m) => compactAnalyzedMatch(m, true)).filter(Boolean),
  );
  const compactHighConfidence = compactMatches.filter((m) =>
    (m.dailySignal || m.analysis?.dailySignal)?.eligible === true
  );

  res.json({
    matches: compactMatches,
    highConfidence: compactHighConfidence,
    preparedDateUK: calibrationStore.preparedDateUK || null,
    calibratedAt: calibrationStore.calibratedAt || null,
    totalScanned: calibrationStore.totalScanned || compactMatches.length,
    analyzedCount: calibrationStore.analyzedCount || 0,
    calibrationHealth: calibrationStore.calibrationHealth || null,
    running: calibrationRunning,
    runningTrigger: calibrationRunMeta.runningTrigger,
    runningSince: calibrationRunMeta.runningSince,
  });
});

/**
 * Fuzzy-search the in-memory match pool (live + upcoming) for matches whose
 * home/away team names, league name, or country match the query tokens.
 *
 * Handles common spelling variants and abbreviations:
 *   "brasil" → "brazil", "rb" → "red bull", "atletico" → "atletico", …
 */
function searchMatchPool(query) {
  const LIVE_STATUSES = new Set(['LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P', 'SUSP', 'INT']);

  // Detect "live" intent before stripping those words
  const liveIntent = /\b(live|now|playing|currently|right now)\b/i.test(query);

  // Normalise: lowercase + strip accents + common spelling variants
  const norm = (s) =>
    (s || '')
      .toLowerCase()
      .replace(/[àáâãä]/g, 'a')
      .replace(/[èéêë]/g, 'e')
      .replace(/[ìíîï]/g, 'i')
      .replace(/[òóôõö]/g, 'o')
      .replace(/[ùúûü]/g, 'u')
      .replace(/[ñ]/g, 'n')
      .replace(/[ç]/g, 'c');

  // Expand abbreviations / common aliases in the query
  const ALIASES = [
    [/\brb\b/g,           'red bull'],
    [/\batleti\b/g,       'atletico'],
    [/\bbarca\b/g,        'barcelona'],
    [/\bbvb\b/g,          'dortmund'],
    [/\bpsg\b/g,          'paris saint'],
    [/\bbrasil\b/g,       'brazil'],
    [/\bespana\b/g,       'spain'],
    [/\bdeutschland\b/g,  'germany'],
    [/\bholland\b/g,      'netherlands'],
    [/\bucl\b/g,          'champions'],
    [/\buel\b/g,          'europa'],
    [/\bwc\b/g,           'world cup'],
    [/\bpl\b/g,           'premier league'],
    [/\bserie\s*a\b/g,    'serie a'],
  ];

  let normalised = norm(query).replace(/\b(live|now|playing|currently|right now)\b/g, '').trim();
  for (const [pattern, replacement] of ALIASES) {
    normalised = normalised.replace(pattern, replacement);
  }

  const tokens = normalised.split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return { matches: [], liveIntent };

  const pool = [...liveMatches, ...upcomingMatches];

  const scored = pool
    .map((m) => {
      const hay = norm(`${m.home} ${m.away} ${m.league} ${m.leagueCountry}`);
      let score = 0;
      for (const tok of tokens) {
        if (hay.includes(tok)) score += 2;
        // Extra weight for whole-word boundary match
        try { if (new RegExp(`\\b${tok}\\b`).test(hay)) score += 1; } catch (_) { /* skip bad token */ }
      }
      // Always boost live matches slightly (real-time relevance)
      const isLive = LIVE_STATUSES.has(m.status);
      if (isLive) score += 0.5;
      // Extra boost when the user explicitly wants live
      if (liveIntent && isLive) score += 3;
      return { m, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return { matches: scored.slice(0, 6).map((s) => s.m), liveIntent };
}

/**
 * GET /api/search?q=red bull live
 * 1. Fuzzy-search the live/upcoming match cache → return real match objects
 * 2. If nothing found → LLM synthesis fallback (Groq/Gemini)
 */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Provide ?q=team+name or match description' });
  try {
    // ── Step 1: search real in-memory matches ─────────────────────────────
    const { matches, liveIntent } = searchMatchPool(q);
    if (matches.length > 0) {
      console.log(`[Search] "${q}" → ${matches.length} real match(es) found`);
      return res.json({ type: 'matches', matches, liveIntent, query: q });
    }

    // ── Step 2: no authoritative fixture found — fail closed ─────────────
    console.log(`[Search] "${q}" → no authoritative cache hit`);
    return res.status(404).json({
      type: 'not_found',
      matches: [],
      query: q,
      message: 'No authoritative fixture found in the current live/upcoming pool.',
    });
  } catch (err) {
    console.error('[Search] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ──────────────────────────────────────────────────────────

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  // Don't exit - keep server alive
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
  // Don't exit - keep server alive
});

server.listen(PORT, async () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║         🐰 SportyRabbi Backend         ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  REST API     → http://localhost:${PORT}/api     ║`);
  console.log(`║  WebSocket    → ws://localhost:${PORT}         ║`);
  console.log('║  API schedule → 05:00 UK + portal-open refresh ║');
  console.log('╚════════════════════════════════════════╝\n');

  // Pre-load bets from Firestore into memory cache on startup
  const db = getDb();
  if (db) {
    try {
      const snapshot = await db.collection('bets').orderBy('createdAt', 'desc').limit(200).get();
      bets = snapshot.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
      recomputePostMatchCalibrationFromBets(bets);
      console.log(`🔥 Loaded ${bets.length} bets from Firestore`);
    } catch (err) {
      console.warn('⚠️  Could not pre-load bets from Firestore:', err.message);
    }

    // Restore calibration store from Firestore (avoids cold-start delay; skip if >12h old)
    try {
      const calDoc = await db.collection('calibration').doc('latest').get();
      if (calDoc.exists) {
        const data = calDoc.data();
        const storedAt = data.calibratedAt || data.savedAt || null;
        const preparedDateUK = data.preparedDateUK
          || (storedAt ? getUkDateStamp(new Date(storedAt)) : null);
        if (preparedDateUK === getUkDateStamp()) {
          let restoredSchedule = data.dailySchedule || data.matches || [];

          if (Number(data.scheduleChunkCount || 0) > 0) {
            const chunkSnap = await calDoc.ref.collection('scheduleChunks').orderBy('index').get();
            const chunkSchedule = chunkSnap.docs.flatMap((d) => {
              const chunkData = d.data();
              return Array.isArray(chunkData.matches) ? chunkData.matches : [];
            });
            if (chunkSchedule.length > 0) restoredSchedule = chunkSchedule;
          }

          if (restoredSchedule.length > 0) {
            const restoredAnalyzed = restoredSchedule.filter((m) =>
              m?._calibrated === true || m?.dailySignal != null || m?.analysis?.dailySignal != null
            );
            const restoredHighConfidence = restoredAnalyzed.filter((m) =>
              (m.dailySignal || m.analysis?.dailySignal)?.eligible === true
            );

            calibrationStore = {
              matches: restoredAnalyzed,
              highConfidence: restoredHighConfidence,
              dailySchedule: restoredSchedule,
              preparedDateUK,
              calibratedAt: data.calibratedAt || null,
              totalScanned: data.totalScanned || restoredSchedule.length,
              analyzedCount: data.analyzedCount || restoredAnalyzed.length,
              calibrationHealth: data.calibrationHealth || null,
            };
            upcomingMatches = restoredSchedule;
            setCache('upcomingMatches', upcomingMatches);
            console.log(`🔥 Restored today's chunked daily preparation: ${upcomingMatches.length} fixtures, ${restoredAnalyzed.length} analyzed summaries`);
          } else {
            console.warn('[DailyPrep] Stored metadata found but schedule chunks were empty; startup catch-up will rebuild the day.');
          }
        }
      }
    } catch (err) {
      console.warn('⚠️  Could not restore calibration from Firestore:', err.message);
    }
  }

  // Settle any recently finished prediction ledger entries once after startup.
  setTimeout(() => {
    settlePredictionLedger('startup')
      .catch((err) => console.warn('[PredictionLedger] Startup settlement failed:', err.message));
  }, 8000);

  // If Railway was offline at 05:00, catch up ONCE after it starts later that day.
  // A normal restart after today's preparation reuses Firestore and spends zero prep calls.
  const todayUK = getUkDateStamp();
  const hourUK = getUkHour();
  if (hourUK >= 5 && calibrationStore.preparedDateUK !== todayUK) {
    console.log(`[DailyPrep] Today's ${todayUK} preparation is missing; scheduling one startup catch-up.`);
    setTimeout(() => {
      runCalibrationSafely('startup-catchup-after-05:00')
        .then(() => settlePredictionLedger('post-daily-prep'))
        .catch((err) => console.error('[DailyPrep] Startup catch-up failed:', err.message));
    }, 2500);
  } else if (calibrationStore.preparedDateUK === todayUK) {
    console.log(`[DailyPrep] ${todayUK} already prepared — restart uses persisted data with zero preparation calls.`);
  }
});
