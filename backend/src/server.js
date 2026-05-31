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
import { getTeamForm, getH2H, getFixturePreview, getStandings } from './services/analyticsService.js';
import { analyzeV9 } from './services/agent47Service.js';
import { sendWhatsApp, sendBettingAlert, twilioEnabled } from './services/notificationService.js';
import {
  naturalLanguageToMatchData,
  fetchLiveMatchesViaGemini,
  fetchUpcomingMatchesViaGemini,
  calibrateDay,
  enrichFixturesWithGemini,
  generateMatchNarrative,
} from './services/geminiService.js';
import {
  calculateNextGoalProbability,
  calculateMomentum,
  calculateBetValue,
  generateBettingAlert,
} from './services/liveAnalyticsService.js';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// ─── WHITELIST CONFIG ──────────────────────────────────────────────────────
// Only track these specific leagues (ID-based for maximum control)
// All regulated leagues are shown — no whitelist restriction.
// V9 confidence filtering (>=80%) is done on the frontend "80%+ Picks" tab.
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
let alerts = [];
let bets = [];
let calibrationStore = { matches: [], highConfidence: [], calibratedAt: null, totalScanned: 0 };

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

// ─── RESPONSE CACHING (minimize API calls on paid plans) ──────────────────
const cache = {
  liveMatches: { data: [], timestamp: 0 },
  upcomingMatches: { data: [], timestamp: 0 },
};

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
  ⏱️  Poll Mode:  ${API_KEY ? `API-Football every ${process.env.LIVE_POLL_INTERVAL || 5}s` : 'No API key — set API_FOOTBALL_KEY in .env'}
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
      setQuotaPause('Received 429 from API-Football', getNextUtcMidnightIso());
      console.error('⚠️  API RATE LIMIT EXCEEDED - quota guard enabled until UTC reset');
    }
    return [];
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
      setQuotaPause('API-Football suspended/rate-limited', getNextUtcMidnightIso());
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
      setQuotaPause('Received 429 from API-Football', getNextUtcMidnightIso());
    }
    return [];
  }
}

// Strip non-primitive values from match object (prevents React errors)
function sanitizeMatch(match) {
  return {
    id: match.id || 0,
    home: String(match.home || ''),
    away: String(match.away || ''),
    score: String(match.score || '0-0'),
    possession: {
      home: Number(match.possession?.home || 0),
      away: Number(match.possession?.away || 0),
    },
    shots: {
      home: Number(match.shots?.home || 0),
      away: Number(match.shots?.away || 0),
    },
    xg: {
      home: Number(match.xg?.home || 0),
      away: Number(match.xg?.away || 0),
    },
    status: String(match.status || ''),
    matchMinutes: Number(match.matchMinutes || 0),
    confidence: Number(match.confidence || 50),
    opportunities: Array.isArray(match.opportunities) ? match.opportunities.map(String) : [],
    league: String(match.league || 'Unknown'),
    leagueId: Number(match.leagueId || 0),
    matchType: String(match.matchType || 'League'),
    leagueCountry: String(match.leagueCountry || ''),
    homeTeamId: match.homeTeamId || null,
    awayTeamId: match.awayTeamId || null,
    cards: {
      home: { yellow: Number(match.cards?.home?.yellow || 0), red: Number(match.cards?.home?.red || 0) },
      away: { yellow: Number(match.cards?.away?.yellow || 0), red: Number(match.cards?.away?.red || 0) },
    },
  };
}

// Analyze match for betting opportunities
async function analyzeMatch(match) {
  try {
    const fixture = match.fixture || {};
    const goals = match.goals || {};
    const stats = match.statistics || [];
    const teams = match.teams || {};
    const league = match.league || {};

    const homeStats = (stats && stats[0]) ? stats[0].statistics || [] : [];
    const awayStats = (stats && stats[1]) ? stats[1].statistics || [] : [];

    const getStat = (stats, key) => {
      const s = stats.find((s) => s.type === key);
      if (!s || s.value === null || s.value === undefined) return 0;
      return typeof s.value === 'number' ? s.value : parseFloat(s.value) || 0;
    };

    const possession = {
      home: getStat(homeStats, 'Ball Possession') || 0,
      away: getStat(awayStats, 'Ball Possession') || 0,
    };

    const shots = {
      home: getStat(homeStats, 'Shots on Goal') || 0,
      away: getStat(awayStats, 'Shots on Goal') || 0,
    };

    const xg = {
      home: getStat(homeStats, 'expected_goals') || 0,
      away: getStat(awayStats, 'expected_goals') || 0,
    };

    const cards = {
      home: { yellow: getStat(homeStats, 'Yellow Cards'), red: getStat(homeStats, 'Red Cards') },
      away: { yellow: getStat(awayStats, 'Yellow Cards'), red: getStat(awayStats, 'Red Cards') },
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
      // Per-league xG baselines
      const LEAGUE_XG = {
        39:  [1.55, 1.35], 40:  [1.45, 1.35], 78:  [1.70, 1.50], 79:  [1.55, 1.40],
        135: [1.15, 1.05], 61:  [1.15, 1.05], 140: [1.30, 1.20], 88:  [1.65, 1.45],
        71:  [1.45, 1.30], 94:  [1.30, 1.20], 144: [1.40, 1.30], 235: [1.25, 1.15],
        307: [1.20, 1.10], 2:   [1.35, 1.25], 3:   [1.30, 1.25], 179: [1.40, 1.30],
      };
      const [defHomeXg, defAwayXg] = LEAGUE_XG[league.id] || [1.35, 1.35];

      // ── Fetch real team form, H2H + league standings from API-Football (cached) ──
      let homeFormStr = 'W-L-D-W-L';
      let awayFormStr = 'W-L-D-W-L';
      let h2hHistory = [];
      let homePosition = 10, awayPosition = 10, homePoints = 40, awayPoints = 40, totalTeams = 20;
      let gameWeek = 30;
      let homeAvgGF = null, homeAvgGA = null, awayAvgGF = null, awayAvgGA = null;
      let homeGoalDrought = 0, awayGoalDrought = 0, homeRecentLosses = 0, awayRecentLosses = 0;
      const homeTeamId = teams.home?.id;
      const awayTeamId = teams.away?.id;
      if (homeTeamId && awayTeamId) {
        const [hRes, aRes, h2hRes, standingsRes] = await Promise.allSettled([
          getTeamForm(homeTeamId, league.id),
          getTeamForm(awayTeamId, league.id),
          getH2H(homeTeamId, awayTeamId),
          getStandings(league.id),
        ]);
        // Convert 'WWDLWWDLWW' → 'W-W-D-L-W-W-D-L-W-W' for parseForm()
        if (hRes.status === 'fulfilled' && !hRes.value?.offline && hRes.value?.stats) {
          const hs = hRes.value.stats;
          if (hs.form)  homeFormStr      = hs.form.split('').join('-');
          if (parseFloat(hs.avgGoalsFor)     > 0) homeAvgGF        = parseFloat(hs.avgGoalsFor);
          if (parseFloat(hs.avgGoalsAgainst) > 0) homeAvgGA        = parseFloat(hs.avgGoalsAgainst);
          if (hs.goalDrought  != null) homeGoalDrought  = hs.goalDrought;
          if (hs.recentLosses != null) homeRecentLosses = hs.recentLosses;
        }
        if (aRes.status === 'fulfilled' && !aRes.value?.offline && aRes.value?.stats) {
          const as = aRes.value.stats;
          if (as.form)  awayFormStr      = as.form.split('').join('-');
          if (parseFloat(as.avgGoalsFor)     > 0) awayAvgGF        = parseFloat(as.avgGoalsFor);
          if (parseFloat(as.avgGoalsAgainst) > 0) awayAvgGA        = parseFloat(as.avgGoalsAgainst);
          if (as.goalDrought  != null) awayGoalDrought  = as.goalDrought;
          if (as.recentLosses != null) awayRecentLosses = as.recentLosses;
        }
        // Build h2h history from aggregate stats for scoreH2H()
        if (h2hRes.status === 'fulfilled' && !h2hRes.value?.offline && h2hRes.value?.stats?.teamAWins != null) {
          const s = h2hRes.value.stats;
          const n = (s.teamAWins || 0) + (s.teamBWins || 0) + (s.draws || 0);
          const gpg = n > 0 ? (s.totalGoals || n * 2.5) / n : 2.5;
          const gH = Math.round(gpg * 0.55), gA = Math.round(gpg * 0.45);
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
      }

      const matchData = {
        home: teams.home?.name || 'Unknown',
        away: teams.away?.name || 'Unknown',
        league: league.name || 'Unknown',
        leagueId: league.id || 0,
        status: normalizedStatus,   // 'LIVE' for in-play — triggers live logic in agent47
        matchMinutes: liveMin,
        score: `${goals.home || 0}-${goals.away || 0}`,
        // Attack quality: prefer live match xG, then team's season goals avg, then league default
        homeXgAvg:  xg.home > 0 ? xg.home : (homeAvgGF ?? defHomeXg),
        awayXgAvg:  xg.away > 0 ? xg.away : (awayAvgGF ?? defAwayXg),
        // Defensive quality: team's season goals-conceded avg (correct Poisson input)
        homeXgaAvg: xg.away > 0 ? xg.away : (homeAvgGA ?? defAwayXg),
        awayXgaAvg: xg.home > 0 ? xg.home : (awayAvgGA ?? defHomeXg),
        // Season goal averages fed to P4 coiled spring and P6 defensive gap
        homeGoalsAvgFor:     homeAvgGF ?? defHomeXg,
        awayGoalsAvgFor:     awayAvgGF ?? defAwayXg,
        homeGoalsAvgAgainst: homeAvgGA ?? defAwayXg,
        awayGoalsAvgAgainst: awayAvgGA ?? defHomeXg,
        homePossession: possession.home || 50,
        homeShotsPerGame: shots.home || 10,
        awayShotsPerGame: shots.away || 10,
        homeForm:  homeFormStr,
        awayForm:  awayFormStr,
        h2hHistory,
        homePosition,
        awayPosition,
        homePoints,
        awayPoints,
        totalTeams,
        gameWeek,
        totalGW: 38,
        homeSquadIntegrity: 85,
        awaySquadIntegrity: 85,
        homeCards: cards.home,
        awayCards: cards.away,
        homeGoalDrought,
        awayGoalDrought,
        homeRecentLosses,
        awayRecentLosses,
      };
      try {
        analysisObj      = analyzeV9(matchData);
        confidence       = analysisObj.overallScore || 50;
        opportunitiesArr = (analysisObj.recommendations || []).slice(0, 2).map(r => r.selection || r.label || '');
      } catch (v9Err) {
        console.warn(`[analyzeMatch] V9 error for ${teams.home?.name} vs ${teams.away?.name}: ${v9Err.message}`);
        confidence = 50;
        opportunitiesArr = [];
        analysisObj = null;
      }
      kickoffUTC = fixture.date || null;
    }

    const analyzed = {
      id: fixture.id || Math.random(),
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
      cards,
    };
    
    const result = sanitizeMatch(analyzed);
    if (analysisObj) result.analysis = analysisObj;
    if (kickoffUTC) result.kickoffUTC = kickoffUTC;
    return result;
  } catch (error) {
    console.error('❌ Error analyzing match:', error.message);
    return null; // Skip this match
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
  
  // Check cache first
  const cached = getCached('liveMatches');
  if (cached !== null) {
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
      processedMatches = matches ? (await Promise.all(matches.map(analyzeMatch))).filter(m => m !== null) : [];
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
  } finally {
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
      processedMatches = matches ? (await Promise.all(matches.map(analyzeMatch))).filter(m => m !== null) : [];
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

// Start polling with adaptive frequency based on data source
// API-Football mode: fast polling (5s default)
// Gemini mode: slow polling (every 5s cron, but cache TTL prevents actual Gemini calls more than every 5 min)
const pollInterval = process.env.LIVE_POLL_INTERVAL || 5;
cron.schedule(`*/${pollInterval} * * * * *`, async () => {
  try {
    // Poll live matches
    try {
      await pollLiveMatches();
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

console.log(`⏰ Polling started (cron every ${pollInterval}s)`);
console.log(`   Data source: ${API_KEY ? 'API-Football' : '🤖 Gemini 2.0 Flash + Google Search'}`);
console.log(`   Live cache TTL:     ${CACHE_TTL.live / 1000}s`);
console.log(`   Upcoming cache TTL: ${CACHE_TTL.upcoming / 1000}s`);

// ─── AUTO-CALIBRATION ──────────────────────────────────────────────────────
// Run once 5 seconds after startup so real fixtures are available immediately,
// then re-run every 6 hours to refresh the day's schedule.

setTimeout(() => {
  console.log('[AutoCal] Startup calibration — fetching today\'s real fixtures via Gemini Search...');
  runCalibration().then(store => {
    if (!store || store.matches.length === 0) {
      // Retry once after 3 minutes if startup calibration produced nothing
      console.warn('[AutoCal] Startup produced 0 matches — scheduling retry in 3 minutes...');
      setTimeout(() => {
        console.log('[AutoCal] Retry calibration (first attempt yielded 0 matches)...');
        runCalibration().catch(err => console.error('[AutoCal] Retry failed:', err.message));
      }, 3 * 60 * 1000);
    }
  }).catch(err => {
    console.error('[AutoCal] Startup failed:', err.message);
    // Retry once after 3 minutes on error too
    setTimeout(() => {
      console.log('[AutoCal] Retry calibration after startup error...');
      runCalibration().catch(e => console.error('[AutoCal] Retry failed:', e.message));
    }, 3 * 60 * 1000);
  });
}, 5000);

// Re-calibrate at top of every 6th hour (00:00, 06:00, 12:00, 18:00 UTC)
cron.schedule('0 0,6,12,18 * * *', () => {
  console.log('[AutoCal] Scheduled 6-hour recalibration starting...');
  runCalibration().catch(err => console.error('[AutoCal] Scheduled failed:', err.message));
});

// ─── ALERT PERSISTENCE ────────────────────────────────────────────────────

// ── Alert dedup: prevent same match+type firing more than once per 30 minutes ──────────────
const recentAlertKeys = new Map(); // key → timestamp
const ALERT_DEDUP_MS = 30 * 60 * 1000; // 30 minutes

async function saveAlert(alertData) {
  // Dedup: skip if same match+type was sent within the last 30 minutes
  const key = `${alertData.home}|${alertData.away}|${alertData.type || 'alert'}`;
  const lastSent = recentAlertKeys.get(key);
  if (lastSent && Date.now() - lastSent < ALERT_DEDUP_MS) return;
  recentAlertKeys.set(key, Date.now());
  // Purge stale entries
  for (const [k, ts] of recentAlertKeys) {
    if (Date.now() - ts > ALERT_DEDUP_MS) recentAlertKeys.delete(k);
  }
  // Always keep in memory (last 100)
  alerts.unshift(alertData);
  if (alerts.length > 100) alerts.pop();

  // Persist to Firestore if available
  const db = getDb();
  if (db) {
    try {
      await db.collection('alerts').add(alertData);
    } catch (err) {
      console.error('⚠️  Firestore alert save failed:', err.message);
    }
  }

  // Broadcast to portal
  broadcast({ type: 'NEW_ALERT', payload: alertData });

  // Send WhatsApp alert for high-confidence opportunities
  const minConf = Number(process.env.MIN_CONFIDENCE_ALERT) || 65;
  if ((alertData.confidence || 0) >= minConf) {
    const confStr = alertData.confidence ? `${alertData.confidence}%` : '–';
    const msg = [
      `🐰 SportyRabbi Alert`,
      `⚽ ${alertData.home} vs ${alertData.away}`,
      `🏆 ${alertData.league || 'Match'}`,
      `📊 Confidence: ${confStr}`,
      `💡 ${alertData.message || alertData.type}`,
      `🕐 ${new Date(alertData.sentAt).toLocaleTimeString('en-NG', { timeZone: 'Africa/Lagos' })}`,
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

function oddsForSelection(match, selType) {
  const o = match.analysis?.odds || match.odds || {};
  const conf = match.confidence || 50;
  // Use Gemini-estimated odds if available, otherwise derive from confidence
  const deriveOdds = (impliedProb) => Math.max(1.05, +(1 / Math.min(impliedProb, 0.97)).toFixed(2));
  switch (selType) {
    case 'home_win':  return o.homeWin  || deriveOdds(conf / 100);
    case 'away_win':  return o.awayWin  || deriveOdds(conf / 100);
    case 'over25':    return o.over25   || deriveOdds(0.62);
    case 'btts':      return o.btts     || deriveOdds(0.55);
    case 'draw':      return o.draw     || deriveOdds(0.28);
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

function generateBetSlips(bankroll = BANKROLL) {
  const pool = calibrationStore.matches.filter(m =>
    m.status === 'NS' && (m.confidence || 0) >= 55
  );

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

  // ── TIER 1: Singles ≥85% — fall back to top match if none qualify ─────────
  const tier1Candidates = (pool.filter(m => (m.confidence || 0) >= 85).slice(0, 3).length > 0
    ? pool.filter(m => (m.confidence || 0) >= 85).slice(0, 3)
    : pool.slice(0, 1)); // best available if no high-confidence match
  const tier1 = tier1Candidates.map(m => {
    const sel = bestSelection(m);
    const odds = oddsForSelection(m, sel.type);
    const stake = Math.round(bankroll * t1Pct / Math.max(tier1Candidates.length, 1));
    return {
      match: `${m.home} vs ${m.away}`,
      league: m.league,
      leagueId: m.leagueId,
      kickoffUTC: m.kickoffUTC,
      selection: sel.label,
      selectionType: sel.type,
      confidence: m.confidence,
      odds: +odds.toFixed(2),
      stake,
      potentialReturn: Math.round(stake * odds),
      potentialProfit: Math.round(stake * (odds - 1)),
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
        kickoffUTC: m.kickoffUTC,
        selection: sel.label,
        selectionType: sel.type,
        confidence: m.confidence,
        odds: +oddsForSelection(m, sel.type).toFixed(2),
      }],
      combinedOdds: +(acc.combinedOdds * oddsForSelection(m, sel.type)).toFixed(2),
    };
  }, { legs: [], combinedOdds: 1.0 });
  const tier2Stake = t2Pct > 0 ? Math.round(bankroll * t2Pct) : 0;
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
      kickoffUTC: m.kickoffUTC,
      selection: sel.label,
      selectionType: sel.type,
      confidence: m.confidence,
      odds: +oddsForSelection(m, sel.type).toFixed(2),
    };
  });
  const tier3CombinedOdds = +tier3Legs.reduce((acc, l) => acc * l.odds, 1.0).toFixed(2);
  const tier3Stake = t3Pct > 0 ? Math.round(bankroll * t3Pct) : 0;
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
      bankroll,
      totalStake,
      totalStakePercent: +((totalStake / bankroll) * 100).toFixed(1),
      bestCaseProfit,
      bestCaseProfitPercent: +((bestCaseProfit / bankroll) * 100).toFixed(1),
      allocation: { tier1: Math.round(t1Pct * 100), tier2: Math.round(t2Pct * 100), tier3: Math.round(t3Pct * 100) },
    },
    generatedAt: new Date().toISOString(),
  };
}

// ─── REST API ENDPOINTS ────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: '✓ Online',
    timestamp: new Date().toISOString(),
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
  res.json({ count: filtered.length, matches: filtered });
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
  const slips = generateBetSlips(bankroll);
  res.json(slips);
});

app.post('/api/bets', async (req, res) => {
  const bet = {
    id: Date.now(),
    ...req.body,
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
    const minConf = Number(process.env.MIN_CONFIDENCE_ALERT) || 65;
    if (matchAlerts && matchAlerts.length > 0) {
      for (const alert of matchAlerts) {
        if ((alert.confidence || match.confidence || 0) >= minConf) {
          await saveAlert({
            matchId: match.id,
            home: match.home,
            away: match.away,
            league: match.league,
            type: alert.type || 'in-play',
            message: alert.message || alert,
            confidence: alert.confidence || match.confidence,
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
        enriched.homeGoalsAvgFor      = parseFloat(hs.avgGoalsFor)     || enriched.homeXgAvg  || 1.35;
        enriched.homeGoalsAvgAgainst  = parseFloat(hs.avgGoalsAgainst) || enriched.homeXgaAvg || 1.35;
        if (hs.goalDrought  != null) enriched.homeGoalDrought  = hs.goalDrought;
        if (hs.recentLosses != null) enriched.homeRecentLosses = hs.recentLosses;
      }
      if (aRes.status === 'fulfilled' && !aRes.value?.offline && aRes.value?.stats) {
        const as = aRes.value.stats;
        if (as.form) enriched.awayForm = as.form.split('').join('-');
        if (!enriched.hasLiveXg && parseFloat(as.avgGoalsFor)     > 0) enriched.awayXgAvg           = parseFloat(as.avgGoalsFor);
        if (!enriched.hasLiveXg && parseFloat(as.avgGoalsAgainst) > 0) enriched.awayXgaAvg          = parseFloat(as.avgGoalsAgainst);
        enriched.awayGoalsAvgFor      = parseFloat(as.avgGoalsFor)     || enriched.awayXgAvg  || 1.35;
        enriched.awayGoalsAvgAgainst  = parseFloat(as.avgGoalsAgainst) || enriched.awayXgaAvg || 1.35;
        if (as.goalDrought  != null) enriched.awayGoalDrought  = as.goalDrought;
        if (as.recentLosses != null) enriched.awayRecentLosses = as.recentLosses;
      }
      if (h2hRes.status === 'fulfilled' && !h2hRes.value?.offline && h2hRes.value?.stats?.teamAWins != null) {
        const s = h2hRes.value.stats;
        const n = (s.teamAWins || 0) + (s.teamBWins || 0) + (s.draws || 0);
        const gpg = n > 0 ? (s.totalGoals || n * 2.5) / n : 2.5;
        const gH = Math.round(gpg * 0.55), gA = Math.round(gpg * 0.45);
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
      }
    }

    // ── Step 2: Live xG projection ───────────────────────────────────────────
    // Only runs when ACTUAL in-match accumulated xG was available (hasLiveXg=true).
    // Never runs on season-average fallback defaults — those would be squashed by
    // the Poisson interaction formula (lH = avg² / L) giving absurd λ values.
    if (isLive && matchMins >= 15 && enriched.hasLiveXg) {
      const progress    = Math.min(matchMins / 90, 1.0);
      const projFactor  = Math.min(90 / matchMins, 3.5);    // cap: avoid 15-min × 6 inflation
      const blendWeight = Math.min(progress * 1.2, 0.7);    // 0 → 0.70 over first ~52 min
      const project = (v) => v > 0
        ? Math.min(v * (1 - blendWeight) + v * projFactor * blendWeight, 3.5)
        : v;
      enriched.homeXgAvg  = project(enriched.homeXgAvg  || 0);
      enriched.homeXgaAvg = project(enriched.homeXgaAvg || 0);
      enriched.awayXgAvg  = project(enriched.awayXgAvg  || 0);
      enriched.awayXgaAvg = project(enriched.awayXgaAvg || 0);
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
 * Auto-populates what it can from live stats; pass ?gameWeek=35&totalGW=38 etc via query.
 */
app.get('/api/analyze/live/:matchId', (req, res) => {
  try {
    const { matchId } = req.params;
    const match = liveMatches.find((m) => m.id == matchId || m.id === parseInt(matchId));

    if (!match) {
      return res.status(404).json({ error: 'Match not found in live matches' });
    }

    // Build matchData from live state + optional query overrides
    const q = req.query;
    const matchData = {
      home:                 match.home,
      away:                 match.away,
      league:               match.league,
      leagueId:             match.leagueId,
      status:               'LIVE',
      matchMinutes:         match.matchMinutes || 0,
      score:                match.score || '0-0',
      // League context — caller should pass these for accurate analysis
      gameWeek:             parseInt(q.gameWeek)     || 30,
      totalGW:              parseInt(q.totalGW)      || 38,
      totalTeams:           parseInt(q.totalTeams)   || 20,
      homePosition:         parseInt(q.homePos)      || 10,
      awayPosition:         parseInt(q.awayPos)      || 10,
      homePoints:           parseInt(q.homePts)      || 40,
      awayPoints:           parseInt(q.awayPts)      || 40,
      // Live stats — use actual xG when available, else league-appropriate defaults
      homeXgAvg:            match.xg?.home  || ([2,3,848].includes(match.leagueId) ? 1.55 : [39,140,78,61,135].includes(match.leagueId) ? 1.45 : 1.30),
      awayXgAvg:            match.xg?.away  || ([2,3,848].includes(match.leagueId) ? 1.35 : [39,140,78,61,135].includes(match.leagueId) ? 1.25 : 1.15),
      homeXgaAvg:           match.xg?.away  || ([2,3,848].includes(match.leagueId) ? 1.35 : [39,140,78,61,135].includes(match.leagueId) ? 1.25 : 1.15),
      awayXgaAvg:           match.xg?.home  || ([2,3,848].includes(match.leagueId) ? 1.55 : [39,140,78,61,135].includes(match.leagueId) ? 1.45 : 1.30),
      homePossession:       match.possession?.home || 50,
      homeShotsPerGame:     match.shots?.home || 5,
      awayShotsPerGame:     match.shots?.away || 4,
      // Defaults — caller can override via POST /api/analyze for full analysis
      homeSquadIntegrity:   parseInt(q.homeSquad) || 90,
      awaySquadIntegrity:   parseInt(q.awaySquad) || 90,
      referee:              q.referee || null,
      venue:                q.venue   || null,
    };

    const analysis = analyzeV9(matchData);
    res.json(analysis);
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

// ─── SHARED CALIBRATION LOGIC ────────────────────────────────────────────────

/**
 * Build a minimal fixture object with neutral defaults from a bare fixture list entry.
 * Used as a fallback when Gemini enrichment is unavailable (quota exhausted).
 * Analytics are neutral defaults — V9 engine will still score the match.
 * @param {{ home, away, league, leagueId, country, kickoffUTC }} f
 */
// djb2 hash — gives each match a unique seed without any API call
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) ^ s.charCodeAt(i); h = h >>> 0; }
  return h;
}

function buildDefaultFixture(f) {
  const leagueId   = f.leagueId || 0;
  const leagueName = (f.league || '').toLowerCase();

  // ── Classify competition type ───────────────────────────────────────────────
  const isUEFAKnockout = [2, 3, 848].includes(leagueId) ||
    leagueName.includes('europa') || leagueName.includes('conference') || leagueName.includes('champions');
  const isDomesticCup  = !isUEFAKnockout && (
    leagueName.includes('cup') || leagueName.includes('copa') || leagueName.includes('coupe')
    || leagueName.includes('pokal') || leagueName.includes('vase') || f.isKnockout === true
  );
  const isTopLeague    = [39, 140, 78, 61, 135].includes(leagueId);
  const isMidLeague    = [64, 88, 144, 179, 203, 235, 253, 307, 94].includes(leagueId);

  // ── Set context per competition tier ───────────────────────────────────────
  // UEFA knockouts: both finalists/semifinalists — max motivation, strong form
  // Domestic cup: knockout game — high urgency, moderate form unknown
  // Top-5 league end of season: title/relegation/European spots at stake
  // Mid-tier league: moderate competitive stakes
  // Other: baseline defaults
  let homePos, awayPos, homePoints, awayPoints, totalTeams, gameWeek, totalGW,
      homeForm, awayForm, homeXg, awayXg, homeXga, awayXga, squadInt,
      homeStar, homeShotsAvg, awayShotsAvg, h2hHW, h2hAW, h2hD, h2hGoals, bttsRate,
      homeConv, awayConv;

  if (isUEFAKnockout || isDomesticCup) {
    // Knockout stage — survival motivation maxed for both sides
    // Simulate as "late stage of a 14-round knockout" (lifecycle ≈ 0.93 → "Death Run")
    homePos = 1; awayPos = 2;
    homePoints = 24; awayPoints = 21;  // knockout points (wins × 3)
    totalTeams = 8; gameWeek = 13; totalGW = 14;
    homeForm = 'W-W-D-W-W'; awayForm = 'W-W-W-D-W';
    homeXg = 1.7; awayXg = 1.5;
    homeXga = 1.0; awayXga = 1.1;
    squadInt = 88;
    homeStar = 3; homeShotsAvg = 15; awayShotsAvg = 13;
    homeConv = 14; awayConv = 13;
    h2hHW = 2; h2hAW = 2; h2hD = 1; h2hGoals = 3.2; bttsRate = 0.65;
  } else if (isTopLeague) {
    // Top-5 European league, end of season (GW35/38 → lifecycle 0.92 → "End-Game")
    // Home side assumed to have mild advantage (upper-mid table vs lower-mid)
    homePos = 6; awayPos = 15;
    homePoints = 54; awayPoints = 36;
    totalTeams = 20; gameWeek = 35; totalGW = 38;
    homeForm = 'W-D-W-D-W'; awayForm = 'L-D-L-W-D';
    homeXg = 1.6; awayXg = 1.1;
    homeXga = 1.1; awayXga = 1.6;
    squadInt = 86;
    homeStar = 2; homeShotsAvg = 14; awayShotsAvg = 10;
    homeConv = 12; awayConv = 10;
    h2hHW = 3; h2hAW = 2; h2hD = 5; h2hGoals = 2.5; bttsRate = 0.55;
  } else if (isMidLeague) {
    // Mid-tier European / international league — neutral defaults, slight home edge
    homePos = 7; awayPos = 10;
    homePoints = 42; awayPoints = 36;
    totalTeams = 18; gameWeek = 28; totalGW = 34;
    homeForm = 'W-D-W-L-W'; awayForm = 'D-L-W-D-L';
    homeXg = 1.4; awayXg = 1.2;
    homeXga = 1.2; awayXga = 1.4;
    squadInt = 82;
    homeStar = 2; homeShotsAvg = 12; awayShotsAvg = 10;
    homeConv = 11; awayConv = 10;
    h2hHW = 3; h2hAW = 3; h2hD = 4; h2hGoals = 2.4; bttsRate = 0.52;
  } else {
    // Lower / international / unknown league — conservative defaults
    homePos = 8; awayPos = 11;
    homePoints = 35; awayPoints = 28;
    totalTeams = 16; gameWeek = 22; totalGW = 30;
    homeForm = 'W-D-L-W-D'; awayForm = 'L-D-W-L-D';
    homeXg = 1.2; awayXg = 1.1;
    homeXga = 1.3; awayXga = 1.4;
    squadInt = 78;
    homeStar = 1; homeShotsAvg = 11; awayShotsAvg = 9;
    homeConv = 10; awayConv = 9;
    h2hHW = 3; h2hAW = 3; h2hD = 4; h2hGoals = 2.3; bttsRate = 0.50;
  }

  // ── Per-match seed: gives each game unique realistic values without any LLM ──
  const _seed = hashStr(`${f.home || ''}|${f.away || ''}|${leagueId}`);
  const _jit  = (v, s) => +Math.max(0.3, v + ((_seed % (s * 200 + 1)) / 100 - s)).toFixed(2);
  const _HOME_FORMS = ['W-D-L-W-D','W-W-D-L-W','D-W-D-W-L','W-L-W-D-W','D-W-W-D-L','W-D-W-L-D'];
  const _AWAY_FORMS = ['L-D-W-L-D','D-L-L-W-D','L-W-D-L-D','D-L-W-D-L','L-D-D-W-L','W-D-L-D-L'];
  homeXg       = _jit(homeXg,  0.3);
  awayXg       = _jit(awayXg,  0.25);
  homeXga      = _jit(homeXga, 0.2);
  awayXga      = _jit(awayXga, 0.2);
  homePos      = Math.max(1, Math.min(totalTeams - 1, homePos      + (_seed % 9) - 4));
  awayPos      = Math.max(homePos + 1, Math.min(totalTeams, awayPos + ((_seed >>> 4) % 9) - 4));
  homeShotsAvg = Math.max(6, Math.round(homeShotsAvg + ((_seed >>> 8)  % 5) - 2));
  awayShotsAvg = Math.max(5, Math.round(awayShotsAvg + ((_seed >>> 12) % 5) - 2));
  homeForm     = _HOME_FORMS[(_seed >>> 1) % _HOME_FORMS.length];
  awayForm     = _AWAY_FORMS[(_seed >>> 5) % _AWAY_FORMS.length];

  return {
    match: {
      home: f.home, away: f.away,
      league: f.league || 'Unknown',
      leagueId,
      country: f.country || '',
      status: 'NS', minute: 0, homeScore: 0, awayScore: 0,
      kickoffUTC: f.kickoffUTC || null,
      // Context fields consumed by runCalibration → analyzeV9
      homePosition: homePos,  awayPosition: awayPos,
      homePoints,             awayPoints,
      totalTeams,             gameWeek,     totalGW,
      homeForm,               awayForm,
      round: f.round || null,
      notes: f.notes || null,
    },
    home: {
      motivationScore: isUEFAKnockout || isDomesticCup ? 9 : isTopLeague ? 7 : 6,
      starPlayers: homeStar,
      starPlayersMissing: 0,
      recentForm: homeForm.split('-'),
      goalsScored:    [2, 1, 2, 1, 2].map(v => Math.round(v * (homeXg / 1.5))),
      goalsConceded:  [0, 1, 1, 0, 1].map(v => Math.round(v * (homeXga / 1.0))),
      xgAvg: homeXg, xgaAvg: homeXga,
      pace: isUEFAKnockout ? 8 : 6,
      leaguePosition: homePos,
      squadIntegrity: squadInt,
      conversionPct: homeConv,
      shotsPerGame: homeShotsAvg,
    },
    away: {
      motivationScore: isUEFAKnockout || isDomesticCup ? 9 : isTopLeague ? 5 : 5,
      starPlayers: homeStar,
      starPlayersMissing: 0,
      recentForm: awayForm.split('-'),
      goalsScored:    [1, 1, 2, 1, 1].map(v => Math.round(v * (awayXg / 1.2))),
      goalsConceded:  [1, 1, 0, 1, 2].map(v => Math.round(v * (awayXga / 1.3))),
      xgAvg: awayXg, xgaAvg: awayXga,
      pace: isUEFAKnockout ? 7 : 5,
      leaguePosition: awayPos,
      squadIntegrity: squadInt,
      conversionPct: awayConv,
      shotsPerGame: awayShotsAvg,
    },
    h2h: { homeWins: h2hHW, awayWins: h2hAW, draws: h2hD, avgGoals: h2hGoals, bttsRate },
    odds: {
      homeWin: isUEFAKnockout ? 1.9 : 2.2,
      draw: 3.2,
      awayWin: isUEFAKnockout ? 2.0 : 3.3,
      over25: isUEFAKnockout ? 1.65 : 1.85,
      btts: isUEFAKnockout ? 1.70 : 1.85,
    },
    context: {
      neutralVenue: false, earlyGoal: false, redCard: false,
      gameWeek, totalGameWeeks: totalGW,
      homePoints, awayPoints,
      homePosition: homePos, awayPosition: awayPos,
      totalTeams,
      homeGoalDifferential: Math.round(homeXg * gameWeek * 0.3),
      awayGoalDifferential: Math.round(awayXg * gameWeek * 0.2),
      timezone: 'UTC',
    },
  };
}

/**
 * runCalibration()
 * Uses Gemini Search grounding to fetch today's real global fixtures,
 * runs V9 analysis on each, populates calibrationStore + upcomingMatches.
 * Called on startup, every 6 hours, and via POST /api/calibrate.
 */
async function runCalibration() {
  console.log('[Calibrate] Starting day calibration (API-Football → TheSportsDB → Gemini Search)...');
  let raw = [];
  let dataSource = 'unknown';

  // ── Step 1: Real fixture list from API-Football ────────────────────────────
  const apiFixtures = await fetchTodayFixturesFromApi();
  if (apiFixtures.length > 0) {
    const fixtureList = apiFixtures
      .map(f => ({
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        league: f.league?.name,
        leagueId: f.league?.id || 0,
        country: f.league?.country,
        kickoffUTC: f.fixture?.date,
      }))
      .filter(f => f.home && f.away);

    console.log(`[Calibrate] ${fixtureList.length} whitelisted fixtures from API-Football — enriching with Gemini...`);
    if (fixtureList.length > 0) {
      const enriched = await enrichFixturesWithGemini(fixtureList).catch(() => null);
      if (enriched && enriched.length > 0) {
        raw = enriched;
        dataSource = 'API-Football + Gemini';
      } else {
        // Gemini enrichment failed (quota exhausted etc.) — use raw fixtures with neutral defaults
        raw = fixtureList.map(f => buildDefaultFixture(f));
        dataSource = 'API-Football (no Gemini)';
        console.log(`[Calibrate] Gemini enrichment unavailable — using ${raw.length} API-Football fixtures with default analytics`);
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
          // Gemini enrichment failed — use raw fixtures with neutral defaults
          raw = fixtureList.map(f => buildDefaultFixture(f));
          dataSource = 'TheSportsDB (no Gemini)';
          console.log(`[Calibrate] Gemini enrichment unavailable — using ${raw.length} TheSportsDB fixtures with default analytics`);
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

  const analyzed = [];
  for (const f of raw) {
    try {
      const matchMeta = f.match || {};
      const homeName = matchMeta.home || (typeof f.home === 'string' ? f.home : null) || 'Unknown';
      const awayName = matchMeta.away || (typeof f.away === 'string' ? f.away : null) || 'Unknown';
      const matchData = {
        home: homeName,
        away: awayName,
        league: matchMeta.league || 'Unknown',
        leagueId: matchMeta.leagueId || 0,
        status: matchMeta.status || 'NS',
        matchMinutes: matchMeta.minute || 0,
        score: matchMeta.status === 'LIVE' ? `${matchMeta.homeScore || 0}-${matchMeta.awayScore || 0}` : '0-0',
        // ── Competition context (from buildDefaultFixture / Gemini enrichment) ──
        homePosition:      f.home?.leaguePosition  || f.context?.homePosition  || matchMeta.homePosition  || 10,
        awayPosition:      f.away?.leaguePosition  || f.context?.awayPosition  || matchMeta.awayPosition  || 10,
        homePoints:        f.context?.homePoints   || matchMeta.homePoints   || 40,
        awayPoints:        f.context?.awayPoints   || matchMeta.awayPoints   || 40,
        totalTeams:        f.context?.totalTeams   || matchMeta.totalTeams   || 20,
        gameWeek:          f.context?.gameWeek     || matchMeta.gameWeek     || 30,
        totalGW:           f.context?.totalGameWeeks || matchMeta.totalGW   || 38,
        // ── Team form strings ──────────────────────────────────────────────────
        homeForm: Array.isArray(f.home?.recentForm)
          ? f.home.recentForm.join('-')
          : (matchMeta.homeForm || 'W-L-D-W-L'),
        awayForm: Array.isArray(f.away?.recentForm)
          ? f.away.recentForm.join('-')
          : (matchMeta.awayForm || 'W-L-D-W-L'),
        // ── Squad quality ──────────────────────────────────────────────────────
        homeSquadIntegrity: f.home?.squadIntegrity || 85,
        awaySquadIntegrity: f.away?.squadIntegrity || 85,
        // ── Goal expectation ──────────────────────────────────────────────────
        homeXgAvg:  f.home?.xgAvg  || 1.35,
        awayXgAvg:  f.away?.xgAvg  || 1.35,
        homeXgaAvg: f.home?.xgaAvg || 1.35,
        awayXgaAvg: f.away?.xgaAvg || 1.35,
        // ── Conversion / shots ────────────────────────────────────────────────
        homeConversionPct: f.home?.conversionPct || 11,
        awayConversionPct: f.away?.conversionPct || 10,
        homeShotsPerGame:  f.home?.shotsPerGame  || 12,
        awayShotsPerGame:  f.away?.shotsPerGame  || 10,
        homePossession: 50,
        homeStats: f.home,
        awayStats: f.away,
        h2h: f.h2h,
        odds: f.odds,
        context: f.context,
      };

      const analysis = analyzeV9(matchData);
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
        matchType: 'League',
        leagueCountry: matchMeta.country || '',
      });
      matchObj.kickoffUTC = matchMeta.kickoffUTC || null;
      matchObj.round = matchMeta.round || null;
      matchObj.notes = matchMeta.notes || null;
      matchObj.analysis = analysis;
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

  const highConfidence = analyzed.filter(m => m.confidence >= 80);
  calibrationStore = {
    matches: analyzed,
    highConfidence,
    calibratedAt: new Date().toISOString(),
    totalScanned: raw.length,
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
        savedAt: new Date().toISOString(),
      });
      console.log(`🔥 Calibration persisted to Firestore (${analyzed.length} matches)`);
    } catch (err) {
      console.warn('⚠️  Calibration Firestore save failed:', err.message);
    }
  }

  // ── Send WhatsApp alerts for high-confidence calibration matches ─────────
  try {
    const minConf = Number(process.env.MIN_CONFIDENCE_ALERT) || 65;
    const today = new Date().toDateString();
    const alreadySentToday = new Set(
      alerts.filter(a => a.type === 'calibration' && new Date(a.sentAt).toDateString() === today)
            .map(a => `${a.home}|${a.away}`)
    );
    for (const m of analyzed) {
      if ((m.confidence || 0) >= minConf) {
        const matchKey = `${m.home}|${m.away}`;
        if (!alreadySentToday.has(matchKey)) {
          alreadySentToday.add(matchKey); // prevent duplicates within same run
          const topRec = m.analysis?.recommendations?.[0];
          await saveAlert({
            matchId: m.id,
            home: m.home,
            away: m.away,
            league: m.league,
            type: 'calibration',
            message: topRec
              ? `${topRec.selection} — Tier ${topRec.tier}, ${topRec.confidence}% confidence`
              : 'High-confidence pre-match opportunity detected',
            confidence: m.confidence,
            kickoffUTC: m.kickoffUTC || null,
            sentAt: new Date().toISOString(),
          }).catch(e => console.warn(`[Calibrate] Alert save failed: ${e.message}`));
        }
      }
    }
  } catch (alertErr) {
    console.warn(`[Calibrate] Alert loop error: ${alertErr.message}`);
  }

  // ── Immediately populate upcomingMatches so WebSocket / polling serves real data ──
  if (analyzed.length > 0) {
    upcomingMatches = analyzed;
    setCache('upcomingMatches', analyzed);
    broadcast({ type: 'UPCOMING_MATCHES', payload: analyzed });
    console.log(`[Calibrate] Done: ${analyzed.length} real fixtures loaded, ${highConfidence.length} high confidence (>=80%)`);
  } else {
    console.warn('[Calibrate] Done but 0 fixtures — upcomingMatches unchanged');
  }

  return calibrationStore;
}

// ─── CALIBRATION & SEARCH ENDPOINTS ─────────────────────────────────────────

/**
 * POST /api/calibrate
 * Uses Gemini Search grounding to find today's global fixtures,
 * runs V9 on every match, stores and returns all results + 80%+ picks.
 */
app.post('/api/calibrate', async (req, res) => {
  try {
    const store = await runCalibration();
    res.json({
      success: true,
      totalScanned: store.totalScanned,
      total: store.matches.length,
      highConfidenceCount: store.highConfidence.length,
      calibratedAt: store.calibratedAt,
      matches: store.matches,
      highConfidence: store.highConfidence,
    });
  } catch (err) {
    console.error('[Calibrate] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/calibrate/results
 * Returns the last stored calibration results without re-running.
 */
app.get('/api/calibrate/results', (req, res) => {
  res.json(calibrationStore);
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

