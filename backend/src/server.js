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
} from './services/liveAnalyticsService.js';
import { getPhaseConfidencePolicy } from '../../shared/confidencePolicy.js';
import { getLeagueStatDefaults } from '../../shared/leagueDefaults.js';
import { detectCompetitionContext } from '../../shared/competitionModelProfile.js';
import { getCompetitionRiskPolicy } from '../../shared/competitionRiskPolicy.js';

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
  live: API_KEY ? 2 * 60 * 1000 : 5 * 60 * 1000,      // 2 min (API-Football) or 5 min (no key)
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
  const ttl = getActiveCacheTTL(type);
  
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
  ⏱️  Poll Mode:  ${API_KEY ? `API-Football every ${LIVE_POLL_INTERVAL}s` : 'No API key — set API_FOOTBALL_KEY in .env'}
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
      console.error(`⚠️  API 429 — pause until ${resumeAt} (daily remaining: ${quotaState.dailyRemaining ?? 'unknown'})`);
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
    return [];
  }

  if (shouldSkipApiCalls()) {
    const resumeMsg = quotaState.resumeAt ? ` until ${quotaState.resumeAt}` : '';
    console.warn(`⏸️  Skipping UPCOMING API call due to quota guard${resumeMsg}`);
    return [];
  }

  try {
    const now = new Date();
    const todayDate    = now.toISOString().split('T')[0];
    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    console.log(`📅 Fetching upcoming matches (NS) for ${todayDate} + ${tomorrowDate}...`);

    // Fetch today's remaining NS fixtures AND tomorrow's NS fixtures in parallel
    const [todayRes, tomorrowRes] = await Promise.all([
      axios.get(`${API_BASE}/fixtures`, {
        params: { status: 'NS', date: todayDate, timezone: 'UTC' },
        headers: { 'x-apisports-key': API_KEY },
        timeout: 5000,
      }),
      axios.get(`${API_BASE}/fixtures`, {
        params: { status: 'NS', date: tomorrowDate, timezone: 'UTC' },
        headers: { 'x-apisports-key': API_KEY },
        timeout: 5000,
      }),
    ]);
    updateQuotaFromHeaders(todayRes.headers);
    updateQuotaFromHeaders(tomorrowRes.headers);

    const todayFixtures    = todayRes.data.response    || [];
    const tomorrowFixtures = tomorrowRes.data.response || [];
    const fixtures = [...todayFixtures, ...tomorrowFixtures];
    console.log(`📊 API returned ${todayFixtures.length} today + ${tomorrowFixtures.length} tomorrow = ${fixtures.length} upcoming fixtures`);

    return fixtures;
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
    }
    return [];
  }
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
    confidence: Number(match.confidence || 50),
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
      id:            `${homeId || hName}-${awayId || aName}-${(fixture.date || '').split('T')[0]}`,
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

/**
 * Process an array of raw API-Football match objects through analyzeMatch()
 * in small batches to avoid 429 bursts. Each batch runs in parallel, but
 * batches are serialised with a small gap between them.
 * BATCH_SIZE=3 means at most 3×8=24 simultaneous API-Football calls.
 */
async function batchAnalyze(matches, batchSize = 3) {
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
      let homePosition = 10, awayPosition = 10, homePoints = 40, awayPoints = 40, totalTeams = 20;
      let gameWeek = 30;
      let homeAvgGF = null, homeAvgGA = null, awayAvgGF = null, awayAvgGA = null;
      let homeGoalDrought = 0, awayGoalDrought = 0, homeRecentLosses = 0, awayRecentLosses = 0;
      let homeConversionPct = null, awayConversionPct = null;
      let homeSeasonShots = null, awaySeasonShots = null;
      let homeSeasonPossession = null;
      let homeLateGoalPct = null, awayLateGoalPct = null;
      let homeSquadIntegrity = 85, awaySquadIntegrity = 85;
      let homeKeyAbsences = [], awayKeyAbsences = [];
      const homeTeamId = teams.home?.id;
      const awayTeamId = teams.away?.id;
      if (homeTeamId && awayTeamId) {
        const [hRes, aRes, h2hRes, standingsRes, hStatsRes, aStatsRes, hInjRes, aInjRes] = await Promise.allSettled([
          getTeamForm(homeTeamId, league.id),
          getTeamForm(awayTeamId, league.id),
          getH2H(homeTeamId, awayTeamId),
          getStandings(league.id),
          getTeamStatistics(homeTeamId, league.id),
          getTeamStatistics(awayTeamId, league.id),
          getTeamInjuries(homeTeamId, league.id),
          getTeamInjuries(awayTeamId, league.id),
        ]);
        // Convert 'WWDLWWDLWW' → 'W-W-D-L-W-W-D-L-W-W' for parseForm()
        if (hRes.status === 'fulfilled' && !hRes.value?.offline && hRes.value?.stats) {
          const hs = hRes.value.stats;
          if (hs.form)  homeFormStr      = hs.form.split('').join('-');
          if (parseFloat(hs.avgGoalsFor)     > 0) homeAvgGF        = parseFloat(hs.avgGoalsFor);
          if (parseFloat(hs.avgGoalsAgainst) > 0) homeAvgGA        = parseFloat(hs.avgGoalsAgainst);
          if (hs.goalDrought  != null) homeGoalDrought  = hs.goalDrought;
          if (hs.recentLosses != null) homeRecentLosses = hs.recentLosses;
          if (hs.recentOpposition) match.homeRecentOpposition = hs.recentOpposition;
        }
        if (aRes.status === 'fulfilled' && !aRes.value?.offline && aRes.value?.stats) {
          const as = aRes.value.stats;
          if (as.form)  awayFormStr      = as.form.split('').join('-');
          if (parseFloat(as.avgGoalsFor)     > 0) awayAvgGF        = parseFloat(as.avgGoalsFor);
          if (parseFloat(as.avgGoalsAgainst) > 0) awayAvgGA        = parseFloat(as.avgGoalsAgainst);
          if (as.goalDrought  != null) awayGoalDrought  = as.goalDrought;
          if (as.recentLosses != null) awayRecentLosses = as.recentLosses;
          if (as.recentOpposition) match.awayRecentOpposition = as.recentOpposition;
        }
        // Build h2h history from aggregate stats for scoreH2H()
        if (h2hRes.status === 'fulfilled' && !h2hRes.value?.offline && h2hRes.value?.stats?.teamAWins != null) {
          const s = h2hRes.value.stats;
          const n = (s.teamAWins || 0) + (s.teamBWins || 0) + (s.draws || 0);
          // Only use goal data when the API actually returned it; never fabricate when totalGoals=0
          const gpg = n > 0 && s.totalGoals > 0 ? s.totalGoals / n : null;
          const gH = gpg != null ? Math.round(gpg * 0.55) : 1;
          const gA = gpg != null ? Math.round(gpg * 0.45) : 1;
          for (let i = 0; i < (s.teamAWins || 0); i++) h2hHistory.push({ homeGoals: gH + 1, awayGoals: gA, winner: 'home' });
          for (let i = 0; i < (s.teamBWins || 0); i++) h2hHistory.push({ homeGoals: gA, awayGoals: gH + 1, winner: 'away' });
          for (let i = 0; i < (s.draws || 0); i++)     h2hHistory.push({ homeGoals: gA, awayGoals: gA, winner: 'draw' });
        }
        // Real league standings — position, points and gameWeek for P1/P14
        if (standingsRes.status === 'fulfilled' && !standingsRes.value?.offline && standingsRes.value?.teams) {
          const tms = standingsRes.value.teams;
          totalTeams = standingsRes.value.totalTeams || 20;
          if (tms[homeTeamId]) { homePosition = tms[homeTeamId].position; homePoints = tms[homeTeamId].points; }
          if (tms[awayTeamId]) { awayPosition = tms[awayTeamId].position; awayPoints = tms[awayTeamId].points; }
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
          const leagueDefaults = getLeagueStatDefaults(league.id || 0);
          // Phase logic: early uses baseline-heavy priors, mid blends, late uses live-only values.
          const hXgAvg  = isLive && homeAvgGF ? phaseBlendCountStat(homeAvgGF, xg.home, liveMin, 90) : (xg.home > 0 ? xg.home : homeAvgGF);
          const aXgAvg  = isLive && awayAvgGF ? phaseBlendCountStat(awayAvgGF, xg.away, liveMin, 90) : (xg.away > 0 ? xg.away : awayAvgGF);
          // xGA / defensive quality — away xG against home defense.
          const hXgaAvg = isLive && homeAvgGA ? phaseBlendCountStat(homeAvgGA, xg.away, liveMin, 90) : (xg.away > 0 ? xg.away : homeAvgGA);
          const aXgaAvg = isLive && awayAvgGA ? phaseBlendCountStat(awayAvgGA, xg.home, liveMin, 90) : (xg.home > 0 ? xg.home : awayAvgGA);
          // Shots per game — N=180 (moderately stable; tactical changes take time)
          const baseHomeShots = homeSeasonShots || leagueDefaults.homeShotsPerGame;
          const baseAwayShots = awaySeasonShots || leagueDefaults.awayShotsPerGame;
          const hShots  = isLive ? phaseBlendCountStat(baseHomeShots, totalShots.home, liveMin, 180) : baseHomeShots;
          const aShots  = isLive ? phaseBlendCountStat(baseAwayShots, totalShots.away, liveMin, 180) : baseAwayShots;
          // Possession — N=360 (very stable; a team's style rarely shifts mid-match)
          const hPoss   = isLive ? phaseBlendPctStat(homeSeasonPossession || 50, possession.home, liveMin, 360) : (homeSeasonPossession || 50);
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
        // Derive total game weeks from league size: (n-1)*2 rounds in a round-robin
        totalGW: totalTeams > 1 ? (totalTeams - 1) * 2 : 38,
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
        confidence       = analysisObj.overallScore || 50;
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
      confidence: Math.min(Math.max(Math.round(confidence), 10), 98),
      opportunities: opportunitiesArr.filter(Boolean),
      league: league.name || 'Unknown',
      leagueId: league.id || 0,
      matchType,
      leagueCountry: league.country || '',
      homePosition,
      awayPosition,
      homePoints,
      awayPoints,
      totalTeams,
      cards,
      homeConversionPct,
      awayConversionPct,
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
      confidence: 50,
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

async function pollLiveMatches() {
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
  const cached = getCached('liveMatches');
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
      processedMatches = matches ? await batchAnalyze(matches, 3) : [];
      livePollMetrics.lastAnalyzedCount = processedMatches.length;
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

// Start polling — 30s default keeps well within API-Football's 300 req/min rate limit
// even when 20+ live matches are being analyzed (1 fixture call + cached analysis).
cron.schedule(`*/${POLL_TICK_SECONDS} * * * * *`, async () => {
  try {
    // Poll live matches
    try {
      const now = Date.now();
      const targetIntervalMs = getCurrentLivePollIntervalSeconds() * 1000;
      if (now - lastLivePollRunAt >= targetIntervalMs) {
        lastLivePollRunAt = now;
        await pollLiveMatches();
      }
    } catch (err) {
      console.error('❌ Live poll failed:', err.message);
    }
    
    // Poll upcoming matches
    try {
      await pollUpcomingMatches();
    } catch (err) {
      console.error('❌ Upcoming poll failed:', err.message);
    }
  } catch (error) {
    console.error('❌ Critical polling error:', error.message);
  }
});

console.log(`⏰ Polling started (tick ${POLL_TICK_SECONDS}s, base ${LIVE_POLL_INTERVAL}s${ENABLE_ADAPTIVE_LIVE_POLL ? `, live ${LIVE_POLL_INTERVAL_WHEN_LIVE}s` : ''})`);
console.log(`   Data source: ${API_KEY ? 'API-Football' : '🤖 Gemini 2.0 Flash + Google Search'}`);
console.log(`   Live cache TTL:     ${CACHE_TTL.live / 1000}s`);
console.log(`   Upcoming cache TTL: ${CACHE_TTL.upcoming / 1000}s`);

// ─── AUTO-CALIBRATION ──────────────────────────────────────────────────────
// Run once 5 seconds after startup so real fixtures are available immediately,
// then re-run every 6 hours to refresh the day's schedule.

setTimeout(() => {
  console.log('[AutoCal] Startup calibration — fetching today\'s real fixtures via Gemini Search...');
  runCalibrationSafely('startup').then(store => {
    if (!store || store.matches.length === 0) {
      // Retry once after 3 minutes if startup calibration produced nothing
      console.warn('[AutoCal] Startup produced 0 matches — scheduling retry in 3 minutes...');
      setTimeout(() => {
        console.log('[AutoCal] Retry calibration (first attempt yielded 0 matches)...');
        runCalibrationSafely('startup-retry').catch(() => {});
      }, 3 * 60 * 1000);
    }
  }).catch(err => {
    console.error('[AutoCal] Startup failed:', err.message);
    // Retry once after 3 minutes on error too
    setTimeout(() => {
      console.log('[AutoCal] Retry calibration after startup error...');
      runCalibrationSafely('startup-error-retry').catch(() => {});
    }, 3 * 60 * 1000);
  });
}, 5000);

// Re-calibrate at top of every 6th hour (00:00, 06:00, 12:00, 18:00 UTC)
cron.schedule('0 0,6,12,18 * * *', () => {
  console.log('[AutoCal] Scheduled 6-hour recalibration starting...');
  runCalibrationSafely('scheduled').catch(() => {});
  purgeOldPredictions().catch(err => console.warn('[AutoCal] Prediction purge failed:', err.message));
});

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
  if (lastSent && Date.now() - lastSent < ALERT_DEDUP_MS) return;
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
  broadcast({ type: 'NEW_ALERT', payload: alertPayload });

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
  const conf = match.confidence || 50;
  const poi  = match.analysis?.poisson?.probabilities;  // V9 Poisson-derived probabilities
  // Use Gemini-estimated odds if available, otherwise derive from confidence/Poisson
  const deriveOdds = (impliedProb) => Math.max(1.05, +(1 / Math.min(impliedProb, 0.97)).toFixed(2));
  switch (selType) {
    case 'home_win':  return o.homeWin  || deriveOdds(conf / 100);
    case 'away_win':  return o.awayWin  || deriveOdds(conf / 100);
    case 'over25':    return o.over25   || (poi?.over25 != null ? deriveOdds(poi.over25 / 100) : deriveOdds(0.62));
    case 'btts':      return o.btts     || (poi?.btts   != null ? deriveOdds(poi.btts   / 100) : deriveOdds(0.55));
    case 'draw':      return o.draw     || (poi?.draw   != null ? deriveOdds(poi.draw   / 100) : deriveOdds(0.28));
    default:          return 1.5;
  }
}

function bestSelection(match) {
  const recs = match.analysis?.recommendations || [];
  if (recs.length > 0) {
    const top = recs[0];
    return { label: top.selection || top.label || 'Win', type: top.type || 'home_win' };
  }
  // Fallback: home win if confidence high enough
  return { label: `${match.home} Win`, type: 'home_win' };
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
      return { ...m, _competitionFamily: ctx.family, _riskPolicy: risk, _familyCalibration: familyCalibration };
    })
    .filter((m) => m.status === 'NS' && (m.confidence || 0) >= Math.max(
      52,
      m._riskPolicy.confidenceFloor +
      modeProfile.confidenceFloorAdjustment +
      (modeCalibration.confidenceFloorAdjustment || 0) +
      (m._familyCalibration?.confidenceFloorAdjustment || 0)
    ));

  if (pool.length === 0) {
    return { tier1: null, tier2: null, tier3: null, pool: 0, generatedAt: new Date().toISOString() };
  }

  pool.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

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

  // ── TIER 1: Singles ≥85% — fall back to top match if none qualify ─────────
  const tier1Candidates = (pool.filter(m => (m.confidence || 0) >= 85).slice(0, 3).length > 0
    ? pool.filter(m => (m.confidence || 0) >= 85).slice(0, 3)
    : pool.slice(0, 1)); // best available if no high-confidence match
  const tier1 = tier1Candidates.map(m => {
    const sel = bestSelection(m);
    const odds = oddsForSelection(m, sel.type);
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
      confidence: m.confidence,
      odds: +odds.toFixed(2),
      stake: guardedStake,
      potentialReturn: Math.round(guardedStake * odds),
      potentialProfit: Math.round(guardedStake * (odds - 1)),
    };
  });

  // ── TIER 2: Accumulator 2-3 legs, each ≥72% — fall back to top 3 available ─
  const tier2Legs = (pool
    .filter(m => (m.confidence || 0) >= 72 && !tier1Candidates.find(t => t.id === m.id))
    .slice(0, 3).length >= 2
      ? pool.filter(m => (m.confidence || 0) >= 72 && !tier1Candidates.find(t => t.id === m.id)).slice(0, 3)
      : pool.filter(m => !tier1Candidates.find(t => t.id === m.id)).slice(0, 3));
  const tier2Combined = tier2Legs.reduce((acc, m) => {
    const sel = bestSelection(m);
    return {
      legs: [...acc.legs, {
        match: `${m.home} vs ${m.away}`,
        league: m.league,
        leagueId: m.leagueId,
        competitionFamily: m._competitionFamily,
        kickoffUTC: m.kickoffUTC,
        selection: sel.label,
        selectionType: sel.type,
        confidence: m.confidence,
        odds: +oddsForSelection(m, sel.type).toFixed(2),
      }],
      combinedOdds: +(acc.combinedOdds * oddsForSelection(m, sel.type)).toFixed(2),
    };
  }, { legs: [], combinedOdds: 1.0 });
  const tier2StakeRaw = t2Pct > 0 ? Math.round(bankroll * t2Pct) : 0;
  const tier2RiskMultiplier = tier2Legs.length > 0
    ? Math.min(...tier2Legs.map(m => m._riskPolicy.stakeMultiplier * (m._familyCalibration?.stakeMultiplierAdjustment || 1)))
    : 1;
  const tier2Stake = Math.round(tier2StakeRaw * tier2RiskMultiplier * modeProfile.stakeMultiplier * (modeCalibration.stakeMultiplierAdjustment || 1));
  const tier2 = tier2Legs.length >= 2 ? {
    ...tier2Combined,
    stake: tier2Stake,
    potentialReturn: Math.round(tier2Stake * tier2Combined.combinedOdds),
    potentialProfit: Math.round(tier2Stake * (tier2Combined.combinedOdds - 1)),
  } : null;

  // ── TIER 3: Value combo 2-4 legs ≥65% — fall back to remaining pool ────────
  const tier3Candidates = (pool
    .filter(m => (m.confidence || 0) >= 65 && (m.confidence || 0) < 72)
    .slice(0, 4).length >= 2
      ? pool.filter(m => (m.confidence || 0) >= 65 && (m.confidence || 0) < 72).slice(0, 4)
      : pool.filter(m => !tier1Candidates.find(t => t.id === m.id) && !tier2Legs.find(t => t.id === m.id)).slice(0, 4));
  // Prefer Over2.5 / BTTS for attacking games, Win for dominant home sides
  const tier3Legs = tier3Candidates.map(m => {
    const recs = m.analysis?.recommendations || [];
    // Pick highest-odds V9-backed rec that isn't straight win
    const valueRec = recs.find(r =>
      r.type === 'over25' || r.type === 'btts' || r.type === 'away_win'
    ) || recs[0];
    const sel = valueRec
      ? { label: valueRec.selection || valueRec.label, type: valueRec.type || 'over25' }
      : { label: `${m.home} or ${m.away} Over 2.5`, type: 'over25' };
    return {
      match: `${m.home} vs ${m.away}`,
      league: m.league,
      leagueId: m.leagueId,
      competitionFamily: m._competitionFamily,
      kickoffUTC: m.kickoffUTC,
      selection: sel.label,
      selectionType: sel.type,
      confidence: m.confidence,
      odds: +oddsForSelection(m, sel.type).toFixed(2),
    };
  });
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

app.get('/api/live', (req, res) => {
  const matchType = req.query.matchType ? String(req.query.matchType) : null;
  
  let filtered = matchType ? liveMatches.filter(m => m.matchType === matchType) : liveMatches;
  res.json({
    count: filtered.length,
    matches: filtered,
    freshness: getLiveFreshnessMeta(),
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
      const firestoreAlerts = snapshot.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
      return res.json({ count: firestoreAlerts.length, alerts: firestoreAlerts });
    } catch (err) {
      console.error('Firestore alerts read error:', err.message);
      // Fall through to in-memory
    }
  }
  res.json({ count: alerts.length, alerts: alerts.slice(0, 50) });
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
        const alertConf = alert.confidence || match.confidence || 0;
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

    const hasPair = (obj) => Number(obj?.home) > 0 && Number(obj?.away) > 0;
    const preLiveStats = {
      possession: hasPair(body.possession),
      shots: hasPair(body.shots),
      xg: hasPair(body.xg),
    };
    let directFixtureStatsStatus = { status: 'not_attempted', source: 'fixture-statistics' };
    let standingsStatus = { status: 'unavailable', source: homeTeamId && awayTeamId ? 'api-football-standings' : 'not-requested' };

    // ── Step 1: Fetch real form, H2H, standings (same as polling path) ──────
    let enriched = { ...body };
    if (homeTeamId && awayTeamId) {
      const [hRes, aRes, h2hRes, standingsRes] = await Promise.allSettled([
        getTeamForm(homeTeamId, leagueId),
        getTeamForm(awayTeamId, leagueId),
        getH2H(homeTeamId, awayTeamId),
        getStandings(leagueId),
      ]);
      if (hRes.status === 'fulfilled' && !hRes.value?.offline && hRes.value?.stats) {
        const hs = hRes.value.stats;
        if (hs.form) enriched.homeForm = hs.form.split('').join('-');
        if (!enriched.hasLiveXg && parseFloat(hs.avgGoalsFor)     > 0) enriched.homeXgAvg           = parseFloat(hs.avgGoalsFor);
        if (!enriched.hasLiveXg && parseFloat(hs.avgGoalsAgainst) > 0) enriched.homeXgaAvg          = parseFloat(hs.avgGoalsAgainst);
        enriched.homeGoalsAvgFor      = parseFloat(hs.avgGoalsFor)     || enriched.homeXgAvg;
        enriched.homeGoalsAvgAgainst  = parseFloat(hs.avgGoalsAgainst) || enriched.homeXgaAvg;
        if (hs.goalDrought  != null) enriched.homeGoalDrought  = hs.goalDrought;
        if (hs.recentLosses != null) enriched.homeRecentLosses = hs.recentLosses;
        if (hs.recentOpposition) enriched.homeRecentOpposition = hs.recentOpposition;
      }
      if (aRes.status === 'fulfilled' && !aRes.value?.offline && aRes.value?.stats) {
        const as = aRes.value.stats;
        if (as.form) enriched.awayForm = as.form.split('').join('-');
        if (!enriched.hasLiveXg && parseFloat(as.avgGoalsFor)     > 0) enriched.awayXgAvg           = parseFloat(as.avgGoalsFor);
        if (!enriched.hasLiveXg && parseFloat(as.avgGoalsAgainst) > 0) enriched.awayXgaAvg          = parseFloat(as.avgGoalsAgainst);
        enriched.awayGoalsAvgFor      = parseFloat(as.avgGoalsFor)     || enriched.awayXgAvg;
        enriched.awayGoalsAvgAgainst  = parseFloat(as.avgGoalsAgainst) || enriched.awayXgaAvg;
        if (as.goalDrought  != null) enriched.awayGoalDrought  = as.goalDrought;
        if (as.recentLosses != null) enriched.awayRecentLosses = as.recentLosses;
        if (as.recentOpposition) enriched.awayRecentOpposition = as.recentOpposition;
      }
      if (h2hRes.status === 'fulfilled' && !h2hRes.value?.offline && h2hRes.value?.stats?.teamAWins != null) {
        const s = h2hRes.value.stats;
        const n = (s.teamAWins || 0) + (s.teamBWins || 0) + (s.draws || 0);
        // Only use goal data when the API actually returned it; never fabricate when totalGoals=0
        const gpg = n > 0 && s.totalGoals > 0 ? s.totalGoals / n : null;
        const gH = gpg != null ? Math.round(gpg * 0.55) : 1;
        const gA = gpg != null ? Math.round(gpg * 0.45) : 1;
        enriched.h2hHistory = [];
        for (let i = 0; i < (s.teamAWins || 0); i++) enriched.h2hHistory.push({ homeGoals: gH+1, awayGoals: gA,   winner: 'home' });
        for (let i = 0; i < (s.teamBWins || 0); i++) enriched.h2hHistory.push({ homeGoals: gA,   awayGoals: gH+1, winner: 'away' });
        for (let i = 0; i < (s.draws    || 0); i++) enriched.h2hHistory.push({ homeGoals: gA,   awayGoals: gA,   winner: 'draw' });
      }
      if (standingsRes.status === 'fulfilled' && !standingsRes.value?.offline && standingsRes.value?.teams) {
        const tms = standingsRes.value.teams;
        enriched.totalTeams = standingsRes.value.totalTeams || 20;
        if (tms[homeTeamId]) { enriched.homePosition = tms[homeTeamId].position; enriched.homePoints = tms[homeTeamId].points; }
        if (tms[awayTeamId]) { enriched.awayPosition = tms[awayTeamId].position; enriched.awayPoints = tms[awayTeamId].points; }
        const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
        if (played > 0) enriched.gameWeek = played;
        standingsStatus = { status: 'available', source: 'api-football-standings' };
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
      if (!enriched.homeForm)                  enriched.homeForm            = ci.homeForm;
      if (!enriched.awayForm)                  enriched.awayForm            = ci.awayForm;
      if (enriched.homeXgAvg           == null) enriched.homeXgAvg           = ci.homeXgAvg;
      if (enriched.awayXgAvg           == null) enriched.awayXgAvg           = ci.awayXgAvg;
      if (enriched.homeXgaAvg          == null) enriched.homeXgaAvg          = ci.homeXgaAvg;
      if (enriched.awayXgaAvg          == null) enriched.awayXgaAvg          = ci.awayXgaAvg;
      if (enriched.homeGoalsAvgFor     == null) enriched.homeGoalsAvgFor     = ci.homeGoalsAvgFor;
      if (enriched.awayGoalsAvgFor     == null) enriched.awayGoalsAvgFor     = ci.awayGoalsAvgFor;
      if (enriched.homeGoalsAvgAgainst == null) enriched.homeGoalsAvgAgainst = ci.homeGoalsAvgAgainst;
      if (enriched.awayGoalsAvgAgainst == null) enriched.awayGoalsAvgAgainst = ci.awayGoalsAvgAgainst;
      if (!enriched.homePosition)              enriched.homePosition        = ci.homePosition;
      if (!enriched.awayPosition)              enriched.awayPosition        = ci.awayPosition;
      if (!enriched.homePoints)                enriched.homePoints          = ci.homePoints;
      if (!enriched.awayPoints)                enriched.awayPoints          = ci.awayPoints;
      if (!enriched.totalTeams)                enriched.totalTeams          = ci.totalTeams;
      if (!enriched.gameWeek)                  enriched.gameWeek            = ci.gameWeek;
      if (enriched.homeSquadIntegrity  == null) enriched.homeSquadIntegrity  = ci.homeSquadIntegrity;
      if (enriched.awaySquadIntegrity  == null) enriched.awaySquadIntegrity  = ci.awaySquadIntegrity;
      if (enriched.homeConversionPct   == null) enriched.homeConversionPct   = ci.homeConversionPct;
      if (enriched.awayConversionPct   == null) enriched.awayConversionPct   = ci.awayConversionPct;
      if (!enriched.homeShotsPerGame)           enriched.homeShotsPerGame    = ci.homeShotsPerGame;
      if (!enriched.awayShotsPerGame)           enriched.awayShotsPerGame    = ci.awayShotsPerGame;
      if (!enriched.h2hHistory?.length)         enriched.h2hHistory          = ci.h2hHistory;
    }

    // ── Step 1b: Actively pull fixture live stats when available ───────────
    // API-Football /fixtures live feed often omits granular statistics for some fixtures.
    // On analysis click, we attempt a direct fixture-stat pull to avoid false "Unavailable".
    if (isLive && fixtureId) {
      const directStats = await fetchFixtureStatistics(fixtureId);
      if (directStats) {
        directFixtureStatsStatus = { status: 'available', source: 'fixture-statistics' };
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
        directFixtureStatsStatus = { status: 'unavailable', source: 'fixture-statistics' };
      }
    }

    const finalLiveStats = {
      possession: hasPair(enriched.possession),
      shots: hasPair(enriched.shots),
      xg: hasPair(enriched.xg),
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
        const baseH = enriched.homeShotsPerGame || 12;
        enriched.homeShotsPerGame = parseFloat(phaseBlendCountStat(baseH, liveShotsH, matchMins, 180).toFixed(1));
      }
      if (aShots > 0) {
        const liveShotsA = aShots * norm;
        const baseA = enriched.awayShotsPerGame || 10;
        enriched.awayShotsPerGame = parseFloat(phaseBlendCountStat(baseA, liveShotsA, matchMins, 180).toFixed(1));
      }
      if (hPoss != null && hPoss > 0) {
        enriched.homePossession = parseFloat(phaseBlendPctStat(enriched.homePossession || 50, hPoss, matchMins, 360).toFixed(1));
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

    // ── Step 4: Groq narrative — analyst note layered on top of V9 output ───
    try {
      const narrative = await generateMatchNarrative(analysis, enriched);
      if (narrative) analysis.narrative = narrative;
    } catch (narErr) {
      console.warn('[Narrative] Groq narrative skipped:', narErr.message);
    }

    res.json(analysis);
  } catch (error) {
    console.error('V9 analysis error:', error.message);
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

    const [standingsRes, hStatsRes, aStatsRes, hInjRes, aInjRes] = await Promise.allSettled([
      getStandings(leagueId),
      getTeamStatistics(homeTeamId, leagueId),
      getTeamStatistics(awayTeamId, leagueId),
      getTeamInjuries(homeTeamId, leagueId),
      getTeamInjuries(awayTeamId, leagueId),
    ]);

    let homePosition = 10, awayPosition = 10, homePoints = 40, awayPoints = 40, totalTeams = 20, gameWeek = 30;
    if (standingsRes.status === 'fulfilled' && !standingsRes.value?.offline && standingsRes.value?.teams) {
      const tms = standingsRes.value.teams;
      totalTeams = standingsRes.value.totalTeams || 20;
      if (tms[homeTeamId]) { homePosition = tms[homeTeamId].position; homePoints = tms[homeTeamId].points; }
      if (tms[awayTeamId]) { awayPosition = tms[awayTeamId].position; awayPoints = tms[awayTeamId].points; }
      const played = Math.max(tms[homeTeamId]?.played || 0, tms[awayTeamId]?.played || 0);
      if (played > 0) gameWeek = played;
    }

    let homeSquadIntegrity = 85, awaySquadIntegrity = 85;
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
    const leagueDefaults = getLeagueStatDefaults(leagueId);
    const baseHomeShots = homeSeasonShots || leagueDefaults.homeShotsPerGame;
    const baseAwayShots = awaySeasonShots || leagueDefaults.awayShotsPerGame;

    const matchData = {
      home: match.home, away: match.away, league: match.league, leagueId,
      country: match.leagueCountry || '',
      round: match.round || '',
      isKnockout: (match.round || '').toLowerCase().includes('knockout') || (match.round || '').toLowerCase().includes('round of') || (match.round || '').toLowerCase().includes('quarter') || (match.round || '').toLowerCase().includes('semi') || (match.round || '').toLowerCase().includes('final'),
      notes: match.notes || '',
      matchType: match.matchType || 'League',
      status: 'LIVE', matchMinutes: liveMin, score: match.score || '0-0',
      gameWeek, totalGW: totalTeams > 1 ? (totalTeams - 1) * 2 : 38, totalTeams,
      homePosition, awayPosition, homePoints, awayPoints,
      homeSquadIntegrity, awaySquadIntegrity,
      homeKeyAbsences, awayKeyAbsences,
      homeConversionPct, awayConversionPct,
      homePossession:   isLive ? phaseBlendPctStat(homeSeasonPossession || 50, livePoss, liveMin, 360) : (homeSeasonPossession || 50),
      homeShotsPerGame: isLive ? phaseBlendCountStat(baseHomeShots, liveShotsHome, liveMin, 180) : baseHomeShots,
      awayShotsPerGame: isLive ? phaseBlendCountStat(baseAwayShots, liveShotsAway, liveMin, 180) : baseAwayShots,
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
 * Uses Gemini Search grounding to fetch today's real global fixtures,
 * runs V9 analysis on each, populates calibrationStore + upcomingMatches.
 * Called on startup, every 6 hours, and via POST /api/calibrate.
 */
async function runCalibration() {
  console.log('[Calibrate] Starting day calibration (API-Football → TheSportsDB → Gemini Search)...');

  // ── Flush stale data before fetching fresh ────────────────────────────────
  calibrationStore = { matches: [], highConfidence: [], calibratedAt: null, totalScanned: 0 };
  upcomingMatches = [];
  cache.upcomingMatches = { data: [], timestamp: 0 };
  console.log('[Calibrate] Flushed stale state. Running fresh calibration...');

  let raw = [];
  let dataSource = 'unknown';

  // Team stats maps: populated when API-Football team IDs are available
  const calTeamIdMap = new Map(); // normalizedName → { id, leagueId }
  const calTeamStats = new Map(); // teamId → { conversionPct, avgShotsTotal, avgPossession, squadIntegrity }

  // ── Step 1: Real fixture list from API-Football ────────────────────────────
  const apiFixtures = await fetchTodayFixturesFromApi();
  if (apiFixtures.length > 0) {
    const fixtureList = apiFixtures
      .map(f => ({
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        homeTeamId: f.teams?.home?.id,
        awayTeamId: f.teams?.away?.id,
        league: f.league?.name,
        leagueId: f.league?.id || 0,
        country: f.league?.country,
        kickoffUTC: f.fixture?.date,
      }))
      .filter(f => f.home && f.away);

    // Build name→ID map and pre-fetch team stats/injuries in parallel (all cached 2–6 h)
    for (const f of fixtureList) {
      if (f.homeTeamId) calTeamIdMap.set(f.home.toLowerCase(), { id: f.homeTeamId, leagueId: f.leagueId });
      if (f.awayTeamId) calTeamIdMap.set(f.away.toLowerCase(), { id: f.awayTeamId, leagueId: f.leagueId });
    }
    if (calTeamIdMap.size > 0) {
      const uniqueTeams = [...new Map([...calTeamIdMap.values()].map(v => [v.id, v])).values()];
      await Promise.allSettled(uniqueTeams.map(async ({ id, leagueId }) => {
        try {
          const [statsRes, injRes] = await Promise.all([
            getTeamStatistics(id, leagueId),
            getTeamInjuries(id, leagueId),
          ]);
          calTeamStats.set(id, {
            conversionPct:  statsRes?.stats?.conversionPct ?? null,
            avgShotsTotal:  statsRes?.stats?.avgShotsTotal ?? null,
            avgPossession:  statsRes?.stats?.avgPossession ?? null,
            squadIntegrity: injRes?.squadIntegrity         ?? null,
          });
        } catch (_) {}
      }));
      console.log(`[Calibrate] Pre-fetched real API stats for ${calTeamStats.size} teams`);
    }

    console.log(`[Calibrate] ${fixtureList.length} whitelisted fixtures from API-Football — enriching with Gemini...`);
    if (fixtureList.length > 0) {
      const enriched = await enrichFixturesWithGemini(fixtureList).catch(() => null);
      if (enriched && enriched.length > 0) {
        raw = enriched;
        dataSource = 'API-Football + Gemini';
      } else {
        console.log('[Calibrate] Enrichment unavailable for API-Football fixtures — trying next source');
      }
    }
  }

  // ── Step 2: TheSportsDB (free, no API key) ─────────────────────────────────
  if (raw.length === 0) {
    console.log('[Calibrate] API-Football unavailable — trying TheSportsDB (free)...');
    const sportsDbFixtures = await fetchTodayFixturesFromSportsDB();
    if (sportsDbFixtures.length > 0) {
      const fixtureList = sportsDbFixtures.map(f => ({
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        league: f.league?.name,
        leagueId: f.league?.id || 0,
        country: f.league?.country,
        kickoffUTC: f.fixture?.date,
        isKnockout: f.league?.isKnockout || false,
        round: f.league?.round || null,
        notes: f.league?.notes || null,
      })).filter(f => f.home && f.away);

      console.log(`[Calibrate] ${fixtureList.length} fixtures from TheSportsDB — enriching with Gemini...`);
      if (fixtureList.length > 0) {
        const enriched = await enrichFixturesWithGemini(fixtureList).catch(() => null);
        if (enriched && enriched.length > 0) {
          raw = enriched;
          dataSource = 'TheSportsDB + Gemini';
        } else {
          console.log('[Calibrate] Enrichment unavailable for TheSportsDB fixtures — trying Gemini Search');
        }
      }
    }
  }

  // ── Step 3: Gemini Search grounding (last resort) ──────────────────────────
  if (raw.length === 0) {
    console.log('[Calibrate] Both fixture APIs unavailable — falling back to Gemini Search grounding...');
    const fixtures = await calibrateDay();
    raw = fixtures || [];
    dataSource = 'Gemini Search';
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
    contextAdjMap = await fetchAndReasonContextAdjustments(fixturesForCtx);
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
      const hRealStats = hLookup ? calTeamStats.get(hLookup.id) : null;
      const aRealStats = aLookup ? calTeamStats.get(aLookup.id) : null;
      const calTotalTeams = f.context?.totalTeams || matchMeta.totalTeams || 20;
      const calTotalGW    = f.context?.totalGameWeeks || matchMeta.totalGW ||
        (calTotalTeams > 1 ? (calTotalTeams - 1) * 2 : 38);

      const matchData = {
        home: homeName,
        away: awayName,
        league: matchMeta.league || 'Unknown',
        leagueId: matchMeta.leagueId || 0,
        country: matchMeta.country || '',
        round: matchMeta.round || '',
        isKnockout: Boolean(matchMeta.isKnockout) || String(matchMeta.round || '').toLowerCase().includes('knockout') || String(matchMeta.round || '').toLowerCase().includes('round of') || String(matchMeta.round || '').toLowerCase().includes('quarter') || String(matchMeta.round || '').toLowerCase().includes('semi') || String(matchMeta.round || '').toLowerCase().includes('final'),
        notes: matchMeta.notes || '',
        matchType: matchMeta.matchType || (matchMeta.isKnockout ? 'Cup' : 'League'),
        status: matchMeta.status || 'NS',
        matchMinutes: matchMeta.minute || 0,
        score: matchMeta.status === 'LIVE' ? `${matchMeta.homeScore || 0}-${matchMeta.awayScore || 0}` : '0-0',
        // ── Competition context (from Gemini/Groq enrichment) ──
        homePosition:      f.home?.leaguePosition  || f.context?.homePosition  || matchMeta.homePosition  || 10,
        awayPosition:      f.away?.leaguePosition  || f.context?.awayPosition  || matchMeta.awayPosition  || 10,
        homePoints:        f.context?.homePoints   || matchMeta.homePoints   || 40,
        awayPoints:        f.context?.awayPoints   || matchMeta.awayPoints   || 40,
        totalTeams:        calTotalTeams,
        gameWeek:          f.context?.gameWeek     || matchMeta.gameWeek     || 30,
        totalGW:           calTotalGW,
        // ── Team form strings ──────────────────────────────────────────────────
        homeForm: Array.isArray(f.home?.recentForm)
          ? f.home.recentForm.join('-')
          : (matchMeta.homeForm || null),
        awayForm: Array.isArray(f.away?.recentForm)
          ? f.away.recentForm.join('-')
          : (matchMeta.awayForm || null),
        // ── Squad quality: real API-Football injuries → integrity, Gemini as fallback ──
        homeSquadIntegrity: hRealStats?.squadIntegrity ?? f.home?.squadIntegrity ?? 85,
        awaySquadIntegrity: aRealStats?.squadIntegrity ?? f.away?.squadIntegrity ?? 85,
        // ── Goal expectation ──────────────────────────────────────────────────
        homeXgAvg:  f.home?.xgAvg  || null,
        awayXgAvg:  f.away?.xgAvg  || null,
        homeXgaAvg: f.home?.xgaAvg || null,
        awayXgaAvg: f.away?.xgaAvg || null,
        // ── Conversion / shots: real API-Football stats, Gemini as fallback ──
        homeConversionPct: hRealStats?.conversionPct ?? f.home?.conversionPct ?? null,
        awayConversionPct: aRealStats?.conversionPct ?? f.away?.conversionPct ?? null,
        homeShotsPerGame:  hRealStats?.avgShotsTotal ?? f.home?.shotsPerGame  ?? null,
        awayShotsPerGame:  aRealStats?.avgShotsTotal ?? f.away?.shotsPerGame  ?? null,
        homePossession:    hRealStats?.avgPossession ?? 50,
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
      const matchObj = sanitizeMatch({
        id: `cal_${matchMeta.home}_${matchMeta.away}`.replace(/\s/g, '_').slice(0, 50),
        home: matchMeta.home || 'Unknown',
        away: matchMeta.away || 'Unknown',
        score: matchMeta.status === 'LIVE' ? `${matchMeta.homeScore || 0}-${matchMeta.awayScore || 0}` : '0-0',
        possession: { home: 50, away: 50 },
        shots: { home: 0, away: 0 },
        xg: { home: f.home?.xgAvg || 1.2, away: f.away?.xgAvg || 1.0 },
        status: matchMeta.status || 'NS',
        matchMinutes: matchMeta.minute || 0,
        confidence: analysis.overallScore || 50,
        opportunities: (analysis.recommendations || []).slice(0, 2).map(r => r.selection),
        league: matchMeta.league || 'Unknown',
        leagueId: matchMeta.leagueId || 0,
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
        homeForm:            matchData.homeForm            ?? null,
        awayForm:            matchData.awayForm            ?? null,
        homeXgAvg:           matchData.homeXgAvg           ?? null,
        awayXgAvg:           matchData.awayXgAvg           ?? null,
        homeXgaAvg:          matchData.homeXgaAvg          ?? null,
        awayXgaAvg:          matchData.awayXgaAvg          ?? null,
        homeGoalsAvgFor:     matchData.homeGoalsAvgFor     ?? null,
        awayGoalsAvgFor:     matchData.awayGoalsAvgFor     ?? null,
        homeGoalsAvgAgainst: matchData.homeGoalsAvgAgainst ?? null,
        awayGoalsAvgAgainst: matchData.awayGoalsAvgAgainst ?? null,
        homePosition:        matchData.homePosition        ?? 10,
        awayPosition:        matchData.awayPosition        ?? 10,
        homePoints:          matchData.homePoints          ?? 40,
        awayPoints:          matchData.awayPoints          ?? 40,
        totalTeams:          matchData.totalTeams          ?? 20,
        gameWeek:            matchData.gameWeek            ?? 30,
        homeSquadIntegrity:  matchData.homeSquadIntegrity  ?? 85,
        awaySquadIntegrity:  matchData.awaySquadIntegrity  ?? 85,
        homeConversionPct:   matchData.homeConversionPct   ?? null,
        awayConversionPct:   matchData.awayConversionPct   ?? null,
        homeShotsPerGame:    matchData.homeShotsPerGame    ?? null,
        awayShotsPerGame:    matchData.awayShotsPerGame    ?? null,
        h2hHistory:          matchData.h2hHistory          ?? [],
        homeLateGoalPct:     matchData.homeLateGoalPct     ?? null,
        awayLateGoalPct:     matchData.awayLateGoalPct     ?? null,
        homeGoalDrought:     matchData.homeGoalDrought     ?? 0,
        awayGoalDrought:     matchData.awayGoalDrought     ?? 0,
        homeRecentLosses:    matchData.homeRecentLosses    ?? 0,
        awayRecentLosses:    matchData.awayRecentLosses    ?? 0,
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

  const highConfidence = analyzed.filter(m => m.confidence >= getPhaseConfidencePolicy(m.status, m.matchMinutes || 0).premiumThreshold);
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
    calibratedAt: new Date().toISOString(),
    totalScanned: raw.length,
    calibrationHealth,
    lastTrigger: calibrationRunMeta.lastTrigger,
    lastStartedAt: calibrationRunMeta.lastStartedAt,
    lastCompletedAt: calibrationRunMeta.lastCompletedAt,
  };

  // Persist to Firestore so calibration survives server restarts
  const _calDb = getDb();
  if (_calDb) {
    try {
      await _calDb.collection('calibration').doc('latest').set({
        matches: analyzed,
        highConfidence,
        calibratedAt: calibrationStore.calibratedAt,
        totalScanned: raw.length,
        calibrationHealth,
        savedAt: new Date().toISOString(),
      });
      console.log(`🔥 Calibration persisted to Firestore (${analyzed.length} matches)`);
    } catch (err) {
      console.warn('⚠️  Calibration Firestore save failed:', err.message);
    }

    // ── Track forward predictions for long-term calibration measurement ──────
    if (analyzed.length > 0) {
      try {
        const predBatch = _calDb.batch();
        const today = new Date().toISOString().split('T')[0];
        const deleteAfter = new Date();
        deleteAfter.setDate(deleteAfter.getDate() + 90);
        for (const m of analyzed) {
          const docRef = _calDb.collection('predictions').doc(
            `${m.id}_${today}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
          );
          predBatch.set(docRef, {
            matchId: m.id,
            home: m.home, away: m.away,
            league: m.league, leagueId: m.leagueId || 0,
            kickoffUTC: m.kickoffUTC || null,
            confidence: m.confidence || 0,
            recommendations: (m.analysis?.recommendations || []).slice(0, 3).map(r => ({
              type: r.type, selection: r.selection, confidence: r.confidence,
            })),
            predictedAt: calibrationStore.calibratedAt,
            deleteAfter: deleteAfter.toISOString(),
            outcome: null,
            settledAt: null,
          }, { merge: false });
        }
        await predBatch.commit();
        console.log(`[Calibrate] ${analyzed.length} predictions stored in Firestore (TTL: 90 days)`);
      } catch (predErr) {
        console.warn('[Calibrate] Prediction tracking save failed:', predErr.message);
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
    for (const m of analyzed) {
      const conf = m.confidence || 0;
      const policy = getPhaseConfidencePolicy(m.status, m.matchMinutes || 0);
      if (conf < policy.standardThreshold) continue;

      const matchKey = `${m.home}|${m.away}`;
      if (alreadySentToday.has(matchKey)) continue;
      alreadySentToday.add(matchKey);

      const isPremium = conf >= policy.premiumThreshold;
      const topRec    = m.analysis?.recommendations?.[0];
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

  // ── Immediately populate upcomingMatches so WebSocket / polling serves real data ──
  if (analyzed.length > 0) {
    upcomingMatches = analyzed;
    setCache('upcomingMatches', analyzed);
    broadcast({ type: 'UPCOMING_MATCHES', payload: analyzed });
    console.log(`[Calibrate] Done: ${analyzed.length} real fixtures loaded, ${highConfidence.length} premium picks (phase-aware threshold)`);
  } else {
    console.warn('[Calibrate] Done but 0 fixtures — upcomingMatches unchanged');
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
  res.json({
    ...calibrationStore,
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

    // ── Step 2: nothing in cache — LLM synthesis ──────────────────────────
    console.log(`[Search] "${q}" → no cache hits, falling back to LLM`);
    const { matchData, geminiConfidence, geminiNotes } = await naturalLanguageToMatchData(q);
    const analysis = analyzeV9(matchData);
    analysis.gemini = { confidence: geminiConfidence, notes: geminiNotes, query: q };
    return res.json({ type: 'synthetic', analysis, query: q });
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
  console.log(`║  Polling      → every ${process.env.LIVE_POLL_INTERVAL || 30}s          ║`);
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
        const ageMs = Date.now() - new Date(data.calibratedAt || data.savedAt).getTime();
        if (ageMs < 12 * 60 * 60 * 1000) {
          calibrationStore = {
            matches:        data.matches        || [],
            highConfidence: data.highConfidence || [],
            calibratedAt:   data.calibratedAt   || null,
            totalScanned:   data.totalScanned   || 0,
          };
          console.log(`🔥 Restored calibration: ${calibrationStore.matches.length} matches (${Math.round(ageMs / 60000)}m old)`);
        }
      }
    } catch (err) {
      console.warn('⚠️  Could not restore calibration from Firestore:', err.message);
    }
  }
});

