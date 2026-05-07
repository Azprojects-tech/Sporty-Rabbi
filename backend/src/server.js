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
import twilio from 'twilio';
import { getTeamForm, getH2H, getFixturePreview } from './services/analyticsService.js';
import { analyzeV6 } from './services/agent47Service.js';
import {
  naturalLanguageToMatchData,
  fetchLiveMatchesViaGemini,
  fetchUpcomingMatchesViaGemini,
  calibrateDay,
  enrichFixturesWithV8,
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
// V8 confidence filtering (>=80%) is done on the frontend "80%+ Picks" tab.
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
  📌 API Key:    ${API_KEY ? '✅ API-Football set (Gemini fallback ready)' : '🤖 Gemini-only mode (AI fixture data)'}
  🌐 API Base:   ${API_BASE}
  ⏱️  Poll Mode:  ${API_KEY ? `API-Football every ${process.env.LIVE_POLL_INTERVAL || 5}s + Gemini fallback` : 'Gemini every 5 min (preserves quota)'}
  🏆 Leagues:    ${WHITELISTED_LEAGUE_IDS.size} whitelisted
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
    
    // First try to get LIVE matches
    const response = await axios.get(`${API_BASE}/fixtures`, {
      params: { 
        status: 'LIVE',
        timezone: 'UTC'
      },
      headers: { 'x-apisports-key': API_KEY },
      timeout: 5000,
    });
    updateQuotaFromHeaders(response.headers);

    let fixtures = response.data.response || [];
    console.log(`  ℹ️  Got ${fixtures.length} LIVE fixtures`);
    
    // If no LIVE matches, try getting ANY recent matches (all statuses)
    if (fixtures.length === 0) {
      console.log('  📊 No LIVE or FT matches, trying to fetch any recent fixtures...');
      try {
        const allResponse = await axios.get(`${API_BASE}/fixtures`, {
          params: { 
            timezone: 'UTC',
            last: 5  // Get last 5 fixtures
          },
          headers: { 'x-apisports-key': API_KEY },
          timeout: 5000,
        });
        updateQuotaFromHeaders(allResponse.headers);
        
        const allFixtures = allResponse.data.response || [];
        console.log(`  📋 Got ${allFixtures.length} recent fixtures`);
        fixtures = allFixtures;
      } catch (innerErr) {
        console.error('  ❌ Failed to fetch recent fixtures:', innerErr.message);
      }
    }
    
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

// League name → leagueId mapping for TheSportsDB responses
const SPORTSDB_LEAGUE_MAP = {
  'english premier league': 39,
  'premier league': 39,
  'spanish la liga': 140,
  'la liga': 140,
  'german bundesliga': 78,
  'bundesliga': 78,
  'italian serie a': 135,
  'serie a': 135,
  'french ligue 1': 61,
  'ligue 1': 61,
  'portuguese primeira liga': 64,
  'primeira liga': 64,
  'liga nos': 64,
  'turkish super lig': 203,
  'süper lig': 203,
  'saudi professional league': 541,
  'saudi pro league': 541,
  'champions league': 1,
  'uefa champions league': 1,
  'europa league': 3,
  'uefa europa league': 3,
  'conference league': 849,
  'uefa europa conference league': 849,
  'world cup': 4,
  'fifa world cup': 4,
  'world cup qualification': 18,
  'european championship': 2,
  'copa america': 5,
  'africa cup of nations': 6,
  'nations league': 16,
  'uefa nations league': 16,
  'mls': 253,
  'major league soccer': 253,
  'scottish premiership': 179,
  'eredivisie': 88,
  'belgian pro league': 144,
  'serie a (brazil)': 71,
  'brasileirao': 71,
};

function sportsDbLeagueToId(leagueName) {
  const key = (leagueName || '').toLowerCase().trim();
  for (const [name, id] of Object.entries(SPORTSDB_LEAGUE_MAP)) {
    if (key.includes(name) || name.includes(key)) return id;
  }
  return 0;
}

/**
 * Fetch today's fixtures from TheSportsDB (completely free, no API key).
 * Returns fixtures in the same shape as fetchTodayFixturesFromApi() consumers expect.
 */
async function fetchTodayFixturesFromSportsDB() {
  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[Calibrate] Fetching today's fixtures from TheSportsDB: ${today}`);
    const response = await axios.get(
      `https://www.thesportsdb.com/api/v1/json/3/eventsday.php`,
      { params: { d: today, s: 'Soccer' }, timeout: 10000 }
    );
    const events = response.data?.events || [];
    if (!events.length) {
      console.log('[Calibrate] TheSportsDB: no events for today');
      return [];
    }

    // Normalise to the shape runCalibration expects for enrichFixturesWithV8
    const fixtures = events
      .filter(e => e.strHomeTeam && e.strAwayTeam && e.strStatus !== 'Match Finished')
      .map(e => {
        const leagueId = sportsDbLeagueToId(e.strLeague || '');
        const kickoffUTC = (e.dateEvent && e.strTime)
          ? `${e.dateEvent}T${e.strTime}Z`
          : null;
        return {
          // Wrap in the API-Football-like shape that the caller converts
          fixture: { id: e.idEvent, date: kickoffUTC },
          teams: {
            home: { name: e.strHomeTeam, id: null },
            away: { name: e.strAwayTeam, id: null },
          },
          league: {
            id: leagueId,
            name: e.strLeague || 'Unknown',
            country: e.strCountry || '',
          },
        };
      })
      .filter(f => !!f.league.id); // all regulated leagues

    console.log(`[Calibrate] TheSportsDB: ${fixtures.length} fixtures found`);
    return fixtures;
  } catch (err) {
    console.warn(`[Calibrate] TheSportsDB fetch failed: ${err.message}`);
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
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    // Format dates as YYYY-MM-DD
    const tomorrowDate = tomorrow.toISOString().split('T')[0];
    
    console.log(`📅 Fetching upcoming matches (NS) for ${tomorrowDate}...`);
    
    // API-Football prefers 'date' parameter over 'from/to' for fixture queries
    const response = await axios.get(`${API_BASE}/fixtures`, {
      params: {
        status: 'NS', // Not Started
        date: tomorrowDate,
        timezone: 'UTC'
      },
      headers: { 'x-apisports-key': API_KEY },
      timeout: 5000,
    });
    updateQuotaFromHeaders(response.headers);

    const fixtures = response.data.response || [];
    console.log(`📊 API returned ${fixtures.length} upcoming fixtures`);
    
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
  };
}

// Analyze match for betting opportunities
function analyzeMatch(match) {
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
      return s ? (typeof s.value === 'number' ? s.value : parseInt(s.value)) : 0;
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

    // Simple confidence scoring
    let confidence = 50; // baseline
    if (possession.home > 60) confidence += 10;
    if (shots.home > shots.away) confidence += 15;
    if (xg.home > xg.away + 0.5) confidence += 10;

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
      statusStr = fixture.status.short; // 'NS', 'LV', 'FT', etc.
    } else if (typeof fixture.status === 'string') {
      statusStr = fixture.status;
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
      matchMinutes: matchMinutesElapsed || 1,
      confidence: Math.min(confidence, 95),
      opportunities: confidence > 65 ? ['Strong signal detected'] : [],
      league: league.name || 'Unknown',
      leagueId: league.id || 0,
      matchType,
      leagueCountry: league.country || '',
    };
    
    // Sanitize before returning
    return sanitizeMatch(analyzed);
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
      processedMatches = matches ? matches.map(analyzeMatch).filter(m => m !== null) : [];
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
    let processedMatches;

    if (!API_KEY) {
      // ── Gemini mode: data already in app format, just sanitize ──────────
      console.log('🤖 Fetching upcoming matches via Gemini...');
      const raw = await withGeminiLock(() => fetchUpcomingMatchesViaGemini());
      processedMatches = (raw || []).map(sanitizeMatch);
    } else {
      // ── API-Football mode: parse raw fixture format ──────────────────────
      console.log('🔄 Polling upcoming matches...');
      const matches = await fetchUpcomingMatches();
      console.log(`📥 Fetched ${matches ? matches.length : 0} raw fixtures`);
      processedMatches = matches ? matches.map(analyzeMatch).filter(m => m !== null) : [];

      // ── Fallback to Gemini if API-Football returned nothing ──────────────
      if (processedMatches.length === 0) {
        console.log('🤖 API-Football returned 0 upcoming — trying Gemini fallback...');
        const raw = await withGeminiLock(() => fetchUpcomingMatchesViaGemini());
        processedMatches = (raw || []).map(sanitizeMatch);
      }
    }

    if (processedMatches.length > 0) {
      upcomingMatches = processedMatches;
      console.log(`✅ Processed ${upcomingMatches.length} upcoming matches`);
      setCache('upcomingMatches', upcomingMatches);
      
      broadcast({ type: 'UPCOMING_MATCHES', payload: upcomingMatches });
      console.log(`✓ Broadcasted ${upcomingMatches.length} upcoming matches to ${clients.size} clients`);
    } else {
      console.log('ℹ️  No upcoming matches in next 24 hours');
      upcomingMatches = [];
      setCache('upcomingMatches', []);
      broadcast({ type: 'UPCOMING_MATCHES', payload: [] });
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
  runCalibration().catch(err => console.error('[AutoCal] Startup failed:', err.message));
}, 5000);

// Re-calibrate at top of every 6th hour (00:00, 06:00, 12:00, 18:00 UTC)
cron.schedule('0 0,6,12,18 * * *', () => {
  console.log('[AutoCal] Scheduled 6-hour recalibration starting...');
  runCalibration().catch(err => console.error('[AutoCal] Scheduled failed:', err.message));
});

// ─── TWILIO WHATSAPP ALERTS ────────────────────────────────────────────────

async function sendWhatsAppAlert(message) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  const to = process.env.ALERT_PHONE_NUMBER;

  if (!sid || !token || !to) {
    console.log('ℹ️  Twilio not configured - alerts will only show in portal');
    return;
  }

  try {
    const client = twilio(sid, token);
    await client.messages.create({
      from,
      to,
      body: message,
    });
    console.log('✓ WhatsApp alert sent');
  } catch (error) {
    console.error('❌ WhatsApp error:', error.message);
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
    m.status === 'NS' && (m.confidence || 0) >= 65 && m.leagueId > 0
  );

  if (pool.length === 0) {
    return { tier1: null, tier2: null, tier3: null, pool: 0, generatedAt: new Date().toISOString() };
  }

  pool.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  // ── TIER 1: Singles ≥90% ──────────────────────────────────────────────────
  const tier1Candidates = pool.filter(m => (m.confidence || 0) >= 90).slice(0, 3);
  const tier1 = tier1Candidates.map(m => {
    const sel = bestSelection(m);
    const odds = oddsForSelection(m, sel.type);
    const stake = Math.round(bankroll * 0.35 / Math.max(tier1Candidates.length, 1));
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

  // ── TIER 2: Accumulator 2-3 legs, each ≥82% ───────────────────────────────
  const tier2Legs = pool
    .filter(m => (m.confidence || 0) >= 82 && !tier1Candidates.find(t => t.id === m.id))
    .slice(0, 3);
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
  const tier2Stake = Math.round(bankroll * 0.25);
  const tier2 = tier2Legs.length >= 2 ? {
    ...tier2Combined,
    stake: tier2Stake,
    potentialReturn: Math.round(tier2Stake * tier2Combined.combinedOdds),
    potentialProfit: Math.round(tier2Stake * (tier2Combined.combinedOdds - 1)),
  } : null;

  // ── TIER 3: Value combo 2-4 legs ≥72% — mix of Over2.5/BTTS/Win ──────────
  const tier3Candidates = pool
    .filter(m => (m.confidence || 0) >= 72 && (m.confidence || 0) < 82)
    .slice(0, 4);
  // Prefer Over2.5 / BTTS for attacking games, Win for dominant home sides
  const tier3Legs = tier3Candidates.map(m => {
    const recs = m.analysis?.recommendations || [];
    // Pick highest-odds V8-backed rec that isn't straight win
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
  const tier3Stake = Math.round(bankroll * 0.10);
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
    },
    pool: pool.length,
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

app.get('/api/live', (req, res) => {
  const matchType = req.query.matchType ? String(req.query.matchType) : null;
  
  let filtered = matchType ? liveMatches.filter(m => m.matchType === matchType) : liveMatches;
  res.json({ count: filtered.length, matches: filtered });
});

app.get('/api/upcoming', (req, res) => {
  const matchType = req.query.matchType ? String(req.query.matchType) : null;
  
  let filtered = matchType ? upcomingMatches.filter(m => m.matchType === matchType) : upcomingMatches;
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

app.get('/api/alerts', (req, res) => {
  res.json({ count: alerts.length, alerts: alerts.slice(-20) });
});

app.get('/api/bets', (req, res) => {
  res.json({ count: bets.length, bets });
});

// ── Bet slip tier suggestions ─────────────────────────────────────────────
app.get('/api/bets/slips', (req, res) => {
  const bankroll = Number(req.query.bankroll) || BANKROLL;
  const slips = generateBetSlips(bankroll);
  res.json(slips);
});

app.post('/api/bets', (req, res) => {
  const bet = {
    id: Date.now(),
    ...req.body,
    createdAt: new Date().toISOString(),
  };
  bets.push(bet);
  broadcast({ type: 'BET_LOGGED', payload: bet });
  res.json({ success: true, bet });
});

app.patch('/api/bets/:id', (req, res) => {
  const idx = bets.findIndex((b) => b.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Bet not found' });

  bets[idx] = { ...bets[idx], ...req.body, updatedAt: new Date().toISOString() };
  broadcast({ type: 'BET_UPDATED', payload: bets[idx] });
  res.json({ success: true, bet: bets[idx] });
});

app.get('/api/stats', (req, res) => {
  const wins = bets.filter((b) => b.result === 'won').length;
  const losses = bets.filter((b) => b.result === 'lost').length;
  const winRate = bets.length > 0 ? ((wins / bets.length) * 100).toFixed(1) : 0;

  res.json({
    totalBets: bets.length,
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

app.get('/api/live-analysis/:matchId', (req, res) => {
  try {
    const { matchId } = req.params;
    // Handle both string and numeric IDs
    const match = liveMatches.find((m) => m.id == matchId || m.id === parseInt(matchId));

    if (!match) {
      return res.status(404).json({ error: 'Match not found in live matches' });
    }

    const nextGoalProb = calculateNextGoalProbability(match);
    const momentum = calculateMomentum(match);
    const alerts = generateBettingAlert(match, nextGoalProb, momentum);

    res.json({
      matchId,
      home: match.home,
      away: match.away,
      nextGoal: nextGoalProb.nextGoal || null,
      goalPace: nextGoalProb.goalPace || null,
      momentum,
      alerts,
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

// ─── AGENT 47 V6 FRONTIER ENDPOINTS ──────────────────────────────────────────

/**
 * POST /api/analyze
 * Accepts a matchData object and returns full V6 Frontier analysis.
 * Works offline — no live API required.
 *
 * Body: see analyzeV6() JSDoc in agent47Service.js
 */
app.post('/api/analyze', (req, res) => {
  try {
    const matchData = req.body;
    if (!matchData || typeof matchData !== 'object') {
      return res.status(400).json({ error: 'Request body must be a matchData object' });
    }
    const analysis = analyzeV6(matchData);
    res.json(analysis);
  } catch (error) {
    console.error('V6 analysis error:', error.message);
    res.status(500).json({ error: 'Analysis failed', detail: error.message });
  }
});

/**
 * GET /api/analyze/live/:matchId
 * Runs V6 analysis on a live match already in the in-memory store.
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
      // Live stats from in-memory match
      homeXgAvg:            match.xg?.home  || 1.2,
      awayXgAvg:            match.xg?.away  || 1.0,
      homeXgaAvg:           match.xg?.away  || 1.2,
      awayXgaAvg:           match.xg?.home  || 1.0,
      homePossession:       match.possession?.home || 50,
      homeShotsPerGame:     match.shots?.home || 5,
      awayShotsPerGame:     match.shots?.away || 4,
      // Defaults — caller can override via POST /api/analyze for full analysis
      homeSquadIntegrity:   parseInt(q.homeSquad) || 90,
      awaySquadIntegrity:   parseInt(q.awaySquad) || 90,
      referee:              q.referee || null,
      venue:                q.venue   || null,
    };

    const analysis = analyzeV6(matchData);
    res.json(analysis);
  } catch (error) {
    console.error('V6 live analysis error:', error.message);
    res.status(500).json({ error: 'Live analysis failed', detail: error.message });
  }
});

/**
 * POST /api/analyze/natural
 * Natural language → Gemini → matchData → V6 analysis.
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

    const analysis = analyzeV6(matchData);

    // Attach Gemini metadata to the response so the UI can show a confidence caveat
    analysis.gemini = { confidence: geminiConfidence, notes: geminiNotes, query: query.trim() };

    res.json(analysis);
  } catch (error) {
    console.error('[Gemini] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ─── SHARED CALIBRATION LOGIC ────────────────────────────────────────────────

/**
 * runCalibration()
 * Uses Gemini Search grounding to fetch today's real global fixtures,
 * runs V8 analysis on each, populates calibrationStore + upcomingMatches.
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
      .filter(f => !!f.league?.id) // all leagues
      .map(f => ({
        home: f.teams?.home?.name,
        away: f.teams?.away?.name,
        league: f.league?.name,
        leagueId: f.league?.id,
        country: f.league?.country,
        kickoffUTC: f.fixture?.date,
      }))
      .filter(f => f.home && f.away);

    console.log(`[Calibrate] ${fixtureList.length} whitelisted fixtures from API-Football — enriching with Gemini V8...`);
    if (fixtureList.length > 0) {
      const enriched = await enrichFixturesWithV8(fixtureList);
      raw = enriched || [];
      dataSource = 'API-Football + Gemini V8';
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
        leagueId: f.league?.id,
        country: f.league?.country,
        kickoffUTC: f.fixture?.date,
      })).filter(f => f.home && f.away);

      console.log(`[Calibrate] ${fixtureList.length} fixtures from TheSportsDB — enriching with Gemini V8...`);
      if (fixtureList.length > 0) {
        const enriched = await enrichFixturesWithV8(fixtureList);
        raw = enriched || [];
        dataSource = 'TheSportsDB + Gemini V8';
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
      const matchData = {
        home: matchMeta.home || f.home || 'Unknown',
        away: matchMeta.away || f.away || 'Unknown',
        league: matchMeta.league || 'Unknown',
        leagueId: matchMeta.leagueId || 0,
        status: matchMeta.status || 'NS',
        matchMinutes: matchMeta.minute || 0,
        score: matchMeta.status === 'LIVE' ? `${matchMeta.homeScore || 0}-${matchMeta.awayScore || 0}` : '0-0',
        home: f.home,
        away: f.away,
        h2h: f.h2h,
        odds: f.odds,
        context: f.context,
        homeXgAvg: f.home?.xgAvg || 1.3,
        awayXgAvg: f.away?.xgAvg || 1.1,
        homeXgaAvg: f.away?.xgaAvg || 1.2,
        awayXgaAvg: f.home?.xgaAvg || 1.2,
        homePossession: 50,
        homeShotsPerGame: 12,
        awayShotsPerGame: 10,
      };

      const analysis = analyzeV6(matchData);
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
      matchObj.analysis = analysis;
      // Calibration is for scheduled fixtures only — no real-time scores available.
      // Force NS so fabricated live states never reach the UI.
      matchObj.status = 'NS';
      matchObj.score = '0-0';
      matchObj.matchMinutes = 0;
      analyzed.push(matchObj);
    } catch (vErr) {
      console.warn(`[Calibrate] V8 skip: ${f.match?.home} vs ${f.match?.away}: ${vErr.message}`);
    }
  }

  const highConfidence = analyzed.filter(m => m.confidence >= 80);
  calibrationStore = {
    matches: analyzed,
    highConfidence,
    calibratedAt: new Date().toISOString(),
    totalScanned: raw.length,
  };

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
 * runs V8 on every match, stores and returns all results + 80%+ picks.
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
 * GET /api/search?q=Arsenal
 * Natural language team/match search → Gemini → V8 analysis.
 */
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Provide ?q=team+name or match description' });
  try {
    const { matchData, geminiConfidence, geminiNotes } = await naturalLanguageToMatchData(q);
    const analysis = analyzeV6(matchData);
    analysis.gemini = { confidence: geminiConfidence, notes: geminiNotes, query: q };
    res.json(analysis);
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

server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║         🐰 SportyRabbi Backend         ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  REST API     → http://localhost:${PORT}/api     ║`);
  console.log(`║  WebSocket    → ws://localhost:${PORT}         ║`);
  console.log(`║  Polling      → every ${process.env.LIVE_POLL_INTERVAL || 30}s          ║`);
  console.log('╚════════════════════════════════════════╝\n');
});
