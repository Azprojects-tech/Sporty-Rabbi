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

// ─── RESPONSE CACHING (minimize API calls on paid plans) ──────────────────
const cache = {
  liveMatches: { data: [], timestamp: 0 },
  upcomingMatches: { data: [], timestamp: 0 },
};

const CACHE_TTL = {
  live: 5000,        // Cache live matches for 5 seconds (they change frequently)
  upcoming: 30000,   // Cache upcoming matches for 30 seconds (they change less)
};

function getCached(type) {
  const cached = cache[type];
  const now = Date.now();
  const ttl = CACHE_TTL[type === 'liveMatches' ? 'live' : 'upcoming'];
  
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
  📌 API Key:  ${API_KEY ? '✅ SET' : '❌ NOT SET'}
  🌐 API Base: ${API_BASE}
  ⏱️  Poll Interval: ${process.env.LIVE_POLL_INTERVAL || 5}s
  🏆 Tracked Leagues: ${process.env.TRACKED_LEAGUES}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

async function fetchLiveMatches() {
  if (!API_KEY) {
    console.warn('⚠️  API_FOOTBALL_KEY not set - skipping live data. Set it in .env');
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
    // Check if rate limited
    if (error.response?.status === 429) {
      console.error('⚠️  API RATE LIMIT EXCEEDED (100 calls/day on free tier)');
    }
    return [];
  }
}

async function fetchUpcomingMatches() {
  if (!API_KEY) {
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

    const fixtures = response.data.response || [];
    console.log(`📊 API returned ${fixtures.length} upcoming fixtures`);
    
    return fixtures;
  } catch (error) {
    console.error('❌ Upcoming matches error:', error.message);
    return [];
  }
}

// Analyze match for betting opportunities
function analyzeMatch(match) {
  try {
    const fixture = match.fixture || {};
    const goals = match.goals || {};
    const stats = match.statistics || [];
    const teams = match.teams || {};

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

    return {
      id: fixture.id || Math.random(),
      home: teams.home?.name || 'Unknown',
      away: teams.away?.name || 'Unknown',
      score: `${goals.home || 0}-${goals.away || 0}`,
      possession,
      shots,
      xg,
      status: fixture.status || 'Unknown',
      matchMinutes: matchMinutesElapsed || 1, // For analytics calculations
      confidence: Math.min(confidence, 95),
      opportunities: confidence > 65 ? ['Strong signal detected'] : [],
    };
  } catch (error) {
    console.error('❌ Error analyzing match:', error.message);
    return null; // Skip this match
  }
}

// ─── LIVE POLLER (with smart response caching) ──────────────────────────

let isPolling = false;

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
    const matches = await fetchLiveMatches();
    
    if (matches && matches.length > 0) {
      liveMatches = matches.map(analyzeMatch).filter(m => m !== null);
      setCache('liveMatches', liveMatches);
      broadcast({ type: 'LIVE_MATCHES', payload: liveMatches });
      console.log(`✓ Updated ${liveMatches.length} live matches`);
    } else {
      console.log('ℹ️  No live matches right now');
      liveMatches = [];
      setCache('liveMatches', []);
    }
  } catch (error) {
    console.error('❌ Poll error:', error.message);
  } finally {
    isPolling = false;
  }
}

// Poll for upcoming matches (next 24 hours)
async function pollUpcomingMatches() {
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
    console.log('🔄 Polling upcoming matches...');
    const matches = await fetchUpcomingMatches();
    
    console.log(`📥 Fetched ${matches ? matches.length : 0} raw fixtures`);
    
    if (matches && matches.length > 0) {
      upcomingMatches = matches.map(analyzeMatch).filter(m => m !== null);
      console.log(`✅ Analyzed ${upcomingMatches.length} upcoming matches`);
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

// Start polling with adaptive frequency based on paid API tier limits
// Paid tier: Higher quota available, can poll more frequently with smart caching
const pollInterval = process.env.LIVE_POLL_INTERVAL || 5; // Default: 5s for paid plans
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

console.log(`⏰ Live polling started (every ${pollInterval}s)`);
console.log(`   API-Football subscribed plan: Higher quota available`);
console.log(`   Live matches: cached for 5 seconds`);
console.log(`   Upcoming matches: cached for 30 seconds`);
console.log(`   Smart response caching: enabled ✓`);

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

// ─── REST API ENDPOINTS ────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ status: '✓ Online', timestamp: new Date().toISOString() });
});

app.get('/api/live', (req, res) => {
  res.json({ count: liveMatches.length, matches: liveMatches });
});

app.get('/api/upcoming', (req, res) => {
  res.json({ count: upcomingMatches.length, matches: upcomingMatches });
});

app.get('/api/alerts', (req, res) => {
  res.json({ count: alerts.length, alerts: alerts.slice(-20) });
});

app.get('/api/bets', (req, res) => {
  res.json({ count: bets.length, bets });
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
