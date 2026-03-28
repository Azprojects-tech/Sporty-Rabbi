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
  // Health check
  getHealth: () => client.get('/health'),

  // Live matches
  getLiveMatches: () => client.get('/live'),

  // Upcoming matches (with optional league filtering)
  getUpcoming: (leagueId) => {
    if (leagueId) {
      return client.get('/upcoming', { params: { leagueId } });
    }
    return client.get('/upcoming');
  },

  // Leagues
  getLeagues: () => client.get('/leagues'),

  // Bets
  logBet: (data) => client.post('/bets', data),
  getBets: () => client.get('/bets'),
  updateBet: (id, data) => client.patch(`/bets/${id}`, data),

  // Stats
  getStats: () => client.get('/stats'),

  // Alerts
  getAlerts: () => client.get('/alerts'),
};

// ─── WEBSOCKET CLIENT ─────────────────────────────────────────────────────

let ws = null;
let listeners = {};
let reconnectAttempts = 0;
const MAX_RETRIES = 5;

export function connectWebSocket(onReady) {
  // Use direct Railway URL for WebSocket (can't be proxied through Netlify)
  // Convert https:// to wss:// automatically
  const wsUrl = import.meta.env.VITE_WS_URL || 
    'wss://web-production-cccff.up.railway.app';

  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('✓ Connected to SportyRabbi');
      reconnectAttempts = 0;
      if (onReady) onReady();
      resolve(ws);
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
      reject(error);
    };

    ws.onclose = () => {
      console.log('⚠️  Disconnected from SportyRabbi');
      // Auto-reconnect after 3 seconds
      if (reconnectAttempts < MAX_RETRIES) {
        reconnectAttempts++;
        setTimeout(() => connectWebSocket(onReady), 3000);
      }
    };
  });
}

// Listen for specific message types
export function on(eventType, callback) {
  if (!listeners[eventType]) {
    listeners[eventType] = [];
  }
  listeners[eventType].push(callback);
}

// Stop listening
export function off(eventType, callback) {
  if (listeners[eventType]) {
    listeners[eventType] = listeners[eventType].filter((cb) => cb !== callback);
  }
}

export default apiService;

