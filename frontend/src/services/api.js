import axios from 'axios';

// Use environment variable for local dev vs production deployment
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';

const client = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000,
});

// Add error interceptor for better debugging
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      console.error('API Error:', error.response.status, error.response.data);
    } else if (error.request) {
      console.error('Network Error - No response from server:', error.request);
    } else {
      console.error('Error:', error.message);
    }
    return Promise.reject(error);
  }
);

// ─── REST API CLIENT ──────────────────────────────────────────────────────

export const apiService = {
  client, // Expose axios client for direct API calls

  // Health check
  getHealth: () => client.get('/health'),

  // Live matches (with optional filtering)
  getLiveMatches: (leagueId, matchType, excludeAfrica) => {
    const params = {};
    if (leagueId) params.leagueId = leagueId;
    if (matchType) params.matchType = matchType;
    if (excludeAfrica) params.excludeAfrica = true;
    if (Object.keys(params).length) {
      return client.get('/live', { params });
    }
    return client.get('/live');
  },

  // Upcoming matches (with optional filtering)
  getUpcoming: (leagueId, matchType, excludeAfrica) => {
    const params = {};
    if (leagueId) params.leagueId = leagueId;
    if (matchType) params.matchType = matchType;
    if (excludeAfrica) params.excludeAfrica = true;
    if (Object.keys(params).length) {
      return client.get('/upcoming', { params });
    }
    return client.get('/upcoming');
  },

  // Leagues
  getLeagues: () => client.get('/leagues'),
  
  // Match types (Friendly, Qualifier, League, Cup)
  getMatchTypes: () => client.get('/matchTypes'),

  // Bets
  logBet: (data) => client.post('/bets', data),
  getBets: () => client.get('/bets'),
  updateBet: (id, data) => client.patch(`/bets/${id}`, data),
  getBetSlips: (bankroll) => client.get('/bets/slips', { params: bankroll ? { bankroll } : {} }),

  // Stats
  getStats: () => client.get('/stats'),

  // Alerts
  getAlerts: () => client.get('/alerts'),

  // ─── V6 FRONTIER ANALYSIS ──────────────────────────────────────────────────

  // Natural language → Gemini → V6: "Persija is playing now"
  analyzeNatural: (query) => client.post('/analyze/natural', { query }, { timeout: 25000 }),

  // Direct V6 analysis from a structured matchData object
  analyzeMatch: (matchData) => client.post('/analyze', matchData),

  // V6 analysis on a live match already in server memory
  analyzeLive: (matchId, params = {}) => client.get(`/analyze/live/${matchId}`, { params }),
};

// ─── WEBSOCKET CLIENT ─────────────────────────────────────────────────────

let ws = null;
let listeners = {};
let reconnectAttempts = 0;
const MAX_RETRIES = 5;
let reconnectTimer = null;
let activeConnectPromise = null;
let manualDisconnect = false;

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(onReady) {
  if (manualDisconnect || reconnectAttempts >= MAX_RETRIES || reconnectTimer) return;
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket(onReady).catch(() => {
      // Next retry is scheduled by onclose/onerror paths if needed.
    });
  }, 3000);
}

export function connectWebSocket(onReady) {
  if (activeConnectPromise) return activeConnectPromise;
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);

  manualDisconnect = false;
  clearReconnectTimer();

  // Derive WebSocket URL from the API base URL — avoids hardcoding deployment-specific URLs.
  // https://host/api → wss://host  |  http://host/api → ws://host
  const wsUrl = import.meta.env.VITE_WS_URL ||
    API_BASE.replace(/^\/api$/, '').replace(/\/api$/, '').replace(/^https/, 'wss').replace(/^http/, 'ws');

  activeConnectPromise = new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    let settled = false;

    const finish = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      activeConnectPromise = null;
      fn(arg);
    };

    ws.onopen = () => {
      console.log('✓ Connected to SportyRabbi');
      reconnectAttempts = 0;
      clearReconnectTimer();
      if (onReady) onReady();
      finish(resolve)(ws);
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      console.log('📨 Received:', msg.type);

      // Trigger registered listeners
      if (listeners[msg.type]) {
        listeners[msg.type].forEach((cb) => cb(msg.payload || msg));
      }
    };

    ws.onerror = (error) => {
      console.error('❌ WebSocket error:', error);
      finish(reject)(error);
    };

    ws.onclose = () => {
      console.log('⚠️  Disconnected from SportyRabbi');
      activeConnectPromise = null;
      scheduleReconnect(onReady);
    };
  });

  return activeConnectPromise;
}

export function disconnectWebSocket() {
  manualDisconnect = true;
  clearReconnectTimer();
  reconnectAttempts = 0;

  if (ws) {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch (_) {
      // no-op
    }
    ws = null;
  }

  activeConnectPromise = null;
}

// Listen for specific message types
export function on(eventType, callback) {
  if (!listeners[eventType]) {
    listeners[eventType] = [];
  }
  if (!listeners[eventType].includes(callback)) {
    listeners[eventType].push(callback);
  }
}

// Stop listening
export function off(eventType, callback) {
  if (listeners[eventType]) {
    listeners[eventType] = listeners[eventType].filter((cb) => cb !== callback);
  }
}

export default apiService;

