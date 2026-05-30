# SportyRabbi — Football Betting Analytics Portal

Real-time football match analytics with a 15-parameter AI scoring engine (Agent 47 V9), WhatsApp alerts, and a live React dashboard.

**Live:** [sporty-rabbit.netlify.app](https://sporty-rabbit.netlify.app)  
**Engine version:** V9 — commit `5185d1f` (May 30, 2026)

---

## Features

- **Live match feed** — WebSocket-pushed scores, possession %, shots on target, xG
- **Agent 47 V9 engine** — 15-parameter Dixon-Coles Poisson model with confidence scoring 0–100
- **AI analyst notes** — Groq llama-3.3-70b narrative; Gemini 2.5 Flash search for calibration
- **WhatsApp alerts** — Fires via Twilio when confidence ≥ 65%
- **Bet slip logging** — Log manual bets, track P&L and win rate
- **Pre-match calibration** — Auto-runs every 6 h; enriches fixtures with real form/standings via Gemini Search

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite + TailwindCSS |
| Backend | Node.js ESM + Express 4 (single `server.js`) |
| Real-time | WebSocket (`ws`) + `node-cron` polling every 30 s |
| Persistence | **Firebase Firestore** (alerts, bets) |
| Data source | API-Football v3 (`v3.football.api-sports.io`) |
| AI (narrative) | Groq `llama-3.3-70b-versatile` |
| AI (search/calibration) | Google Gemini 2.5 Flash with Search grounding |
| Alerts | Twilio WhatsApp sandbox |
| Deploy | Railway (backend) + Netlify (frontend) |

---

## Project Structure

```
SportyRabbi/
├── backend/
│   ├── src/
│   │   ├── server.js                  ← All routes, polling, WebSocket, cron jobs
│   │   ├── config/firebase.js         ← Firebase Admin SDK
│   │   └── services/
│   │       ├── agent47Service.js      ← V9 engine: analyzeV9(), Dixon-Coles Poisson
│   │       ├── geminiService.js       ← Gemini/Groq bridge, calibration, match narrative
│   │       ├── analyticsService.js    ← Team form / H2H / standings (API-Football, cached)
│   │       ├── liveAnalyticsService.js← In-play next-goal + momentum
│   │       └── notificationService.js ← Twilio WhatsApp
│   ├── firebase-service-account.json  ← Firestore credentials (NOT committed)
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/                ← MatchFeed, DetailPanel, BetSlips, AlertHistory, …
│   │   ├── hooks/useMatches.js        ← WebSocket + REST state management
│   │   └── services/api.js            ← Axios API client
│   └── package.json
├── package.json                       ← Root workspace (npm run dev runs both)
└── SYSTEM_DOCUMENTATION.md           ← Full technical reference
```

---

## Quick Start (Local Dev)

### Prerequisites
- Node.js 18+
- API-Football key (free tier at [api-football.com](https://www.api-football.com))
- Firebase project with Firestore enabled (service account JSON)
- Twilio account (optional — WhatsApp alerts)

### Setup

```bash
# Install all dependencies (root + backend + frontend)
npm run install-all

# Configure backend
cp backend/.env.example backend/.env
# Edit backend/.env — see Environment Variables below

# Configure frontend
# Create frontend/.env
echo "VITE_API_BASE_URL=http://localhost:3000/api" > frontend/.env
```

### Run

```bash
npm run dev
# Frontend → http://localhost:5173
# Backend  → http://localhost:3000
```

---

## Environment Variables

**`backend/.env`**
```
API_FOOTBALL_KEY=your_api_football_key
GOOGLE_AI_API_KEY=your_gemini_api_key
GROQ_API_KEY=your_groq_api_key
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_WHATSAPP_TO=whatsapp:+1234567890
NODE_ENV=development
PORT=3000
```

> Firebase credentials come from `backend/firebase-service-account.json` (not committed — add to Railway as env var or file mount in production).

**`frontend/.env`**
```
VITE_API_BASE_URL=http://localhost:3000/api
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/matches` | All cached matches (live + upcoming) |
| GET | `/api/matches/live` | Live matches only |
| GET | `/api/matches/upcoming` | Upcoming (calibrated) fixtures |
| POST | `/api/analyze` | Run V9 analysis on a match (body: matchData) |
| POST | `/api/calibrate` | Trigger manual calibration run |
| GET | `/api/alerts` | Recent alerts from Firestore |
| POST | `/api/bets` | Log a bet |
| GET | `/api/bets` | Bet history |
| PATCH | `/api/bets/:id` | Update bet result |
| GET | `/api/bets/stats` | P&L, win rate, ROI |
| GET | `/api/search?q=...` | NL match search (Groq → Gemini fallback) |

---

## Agent 47 V9 — Parameter Summary

| # | Parameter | Weight | Signal |
|---|-----------|--------|--------|
| P1 | Motivation | 13% | Title/relegation stakes |
| P2 | Star Power | 7% | Key player availability |
| P3 | H2H | 3% | Historical meeting patterns |
| P4 | Form (L10) | **15%** | Recent 5 games weighted 1.6× heavier |
| P5 | Scoring Timing | 5% | Goals in 76–90' window |
| P6 | Defensive Gap | 7% | Goals-against avg + injury flags |
| P7 | Poisson | **11%** | Dixon-Coles corrected Poisson distribution |
| P8 | xG Edge | 6% | Directional xG differential |
| P9 | Def. Solidity | 5% | Team xGA vs league average |
| P10 | Pace | 4% | Shots per game + conversion % |
| P11 | Home Adv. | 3% | Live possession + shot dominance |
| P12 | Mkt. Diverge. | 4% | Poisson model vs bookmaker implied probability |
| P13 | Comp. Context | 5% | League tier predictability premium |
| P14 | Lifecycle | 2% | Season phase |
| P15 | Crisis | **10%** | Goal droughts, losing streaks, manager instability |

---

## Deployment

Both services auto-deploy on `git push origin main`:
- **Backend** → Railway (builds `backend/`, runs `node src/server.js`)
- **Frontend** → Netlify (builds `frontend/`, publishes `dist/`)

See [SYSTEM_DOCUMENTATION.md](SYSTEM_DOCUMENTATION.md) for full technical reference including data flow diagrams, Firestore schema, and model improvement roadmap.

---

## Disclaimer

⚠️ This platform provides analysis only. You bear all financial risk. Bet responsibly.

## License

Private / Proprietary
