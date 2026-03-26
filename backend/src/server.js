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
import cors from 'cors';
import cron from 'node-cron';
import axios from 'axios';
import twilio from 'twilio';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// ─── IN-MEMORY DATA STORE ────────────────────────────────────────────────────
// No database needed for MVP - data stored in memory
let liveMatches = [];
let alerts = [];
let bets = [];

// ─── WEBSOCKET SERVER ──────────────────────────────────────────────────────

const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`✓ Portal connected (${clients.size} users)`);
  
  // Send initial state
  ws.send(JSON.stringify({ type: 'CONNECTED', message: '🐰 SportyRabbi live feed active' }));
  ws.send(JSON.stringify({ type: 'LIVE_MATCHES', payload: liveMatches }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`✓ Portal disconnected (${clients.size} users)`);
  });

  ws.on('error', (err) => {
    console.error('WS Error:', err.message);
  });
});

// Broadcast to all connected clients
function broadcast(message) {
  clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  });
}

// ─── API-FOOTBALL INTEGRATION ──────────────────────────────────────────────

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';

async function fetchLiveMatches() {
  if (!API_KEY) {
    console.warn('⚠️  API_FOOTBALL_KEY not set - skipping live data. Set it in .env');
    return [];
  }

  try {
    const response = await axios.get(`${API_BASE}/fixtures`, {
      params: { status: 'LIVE' },
      headers: { 'x-apisports-key': API_KEY },
      timeout: 5000,
    });

    return response.data.response || [];
  } catch (error) {
    console.error('❌ API error:', error.message);
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

    return {
      id: fixture.id || Math.random(),
      home: teams.home?.name || 'Unknown',
      away: teams.away?.name || 'Unknown',
      score: `${goals.home || 0}-${goals.away || 0}`,
      possession,
      shots,
      xg,
      status: fixture.status || 'Unknown',
      confidence: Math.min(confidence, 95),
      opportunities: confidence > 65 ? ['Strong signal detected'] : [],
    };
  } catch (error) {
    console.error('❌ Error analyzing match:', error.message);
    return null; // Skip this match
  }
}

// ─── LIVE POLLER (runs every 30 seconds) ─────────────────────────────────

let isPolling = false;

async function pollLiveMatches() {
  if (isPolling) {
    console.log('⏳ Polling already in progress, skipping...');
    return; // Skip if already running
  }
  
  isPolling = true;

  try {
    const matches = await fetchLiveMatches();
    
    if (matches && matches.length > 0) {
      liveMatches = matches.map(analyzeMatch).filter(m => m !== null);
      broadcast({ type: 'LIVE_MATCHES', payload: liveMatches });
      console.log(`✓ Updated ${liveMatches.length} live matches`);
    } else {
      console.log('ℹ️  No live matches right now');
    }
  } catch (error) {
    console.error('❌ Poll error:', error.message);
    // Continue - don't crash
  } finally {
    isPolling = false;
  }
}

// Start polling (every 30 seconds) with error handling
cron.schedule(`*/${process.env.LIVE_POLL_INTERVAL || 30} * * * * *`, async () => {
  try {
    await pollLiveMatches();
  } catch (error) {
    console.error('❌ Polling error (continuing):', error.message);
  }
});

console.log(`⏰ Live polling started (every ${process.env.LIVE_POLL_INTERVAL || 30}s)`);

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
