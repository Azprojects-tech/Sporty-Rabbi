# SportyRabbi — Complete System Documentation
**Last updated: May 30, 2026**

---

## 1. Project Purpose

SportyRabbi is a real-time football betting analytics portal. It scrapes live global fixtures, runs them through a proprietary 15-parameter AI scoring engine (Agent 47 V8), and surfaces high-confidence betting recommendations with WhatsApp alerts.

The product is NOT a sportsbook. It is a decision-support tool that tells the user **which bets to place** and at which stake, based on statistical modelling.

---

## 2. Live Deployment

| Service | URL | Platform |
|---------|-----|----------|
| Frontend | https://sporty-rabbit.netlify.app | Netlify (auto-deploy from GitHub main) |
| Backend | https://web-production-cccff.up.railway.app | Railway (auto-deploy from GitHub main) |
| GitHub repo | https://github.com/Azprojects-tech/Sporty-Rabbi | branch: `main` |

---

## 3. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TailwindCSS |
| Backend | Node.js (ESM), Express, `ws` WebSocket |
| Real-time data | API-Football v3 (api-sports.io) |
| AI — NL search | Google Gemini 2.5 Flash (with Google Search grounding) |
| AI — LLM fallback | Groq (llama-3.3-70b-versatile) with 3-model fallback chain |
| Database | Firebase Firestore (alerts + bets persistence) |
| Notifications | Twilio WhatsApp Business sandbox |
| Scheduling | node-cron |

---

## 4. Repository Structure

```
SportyRabbi/
├── backend/
│   ├── src/
│   │   ├── server.js                 ← Main server: Express + WebSocket + all routes
│   │   ├── config/firebase.js        ← Firebase Admin SDK init
│   │   └── services/
│   │       ├── agent47Service.js     ← The V8 engine (15-parameter scoring)
│   │       ├── geminiService.js      ← Gemini/Groq bridge + calibration + enrichment
│   │       ├── liveAnalyticsService.js ← In-play next-goal + momentum
│   │       ├── analyticsService.js   ← Team form / H2H / fixture preview helpers
│   │       └── notificationService.js ← Twilio WhatsApp
│   ├── firebase-service-account.json ← Firestore credentials (DO NOT commit)
│   └── .env                          ← Local dev env (see Section 8)
├── frontend/
│   ├── src/
│   │   ├── App.jsx                   ← Root: all state, WebSocket listener, routing
│   │   ├── components/
│   │   │   ├── MatchFeed.jsx         ← League-grouped match list
│   │   │   ├── Sidebar.jsx           ← League hierarchy filter
│   │   │   ├── DetailPanel.jsx       ← Per-match right panel
│   │   │   ├── AnalyticsModal.jsx    ← Full V8 breakdown popup
│   │   │   ├── BetSlips.jsx          ← Auto-generated tier 1/2/3 bet slips
│   │   │   ├── BetComponents.jsx     ← BetLogger for manual bet tracking
│   │   │   ├── AlertHistory.jsx      ← Alert feed panel
│   │   │   └── LiveAnalysisPanel.jsx ← In-play momentum panel
│   │   ├── hooks/useMatches.js       ← (unused legacy) 
│   │   └── services/api.js           ← axios client + WebSocket manager
│   └── .env                          ← VITE_API_BASE_URL
└── package.json                      ← Root workspace (npm run dev starts both)
```

---

## 5. Data Flow (End-to-End)

### 5a. Calibration (startup + every 6 hours)
```
[startup / cron 0,6,12,18 UTC]
    → calibrateDay() [geminiService.js]
        → Gemini 2.5 Flash + Google Search grounding
        → Returns: confirmed fixture list (10-60 matches) with today's schedule
    → enrichFixturesWithV8() [geminiService.js]
        → Batches of 5 fixtures
        → Gemini Search: real form, position, xG, H2H, squad news per team
        → Falls back to Groq (no search) if Gemini fails
        → Cache per fixture pair (12h TTL)
    → enriched fixtures passed to analyzeV6() [agent47Service.js]
        → Full 15-parameter V8 score computed
    → calibrationStore = { matches: [...], highConfidence: [...], calibratedAt }
    → upcomingMatches = calibrationStore.matches
    → broadcast({ type: 'UPCOMING_MATCHES' }) to all WebSocket clients
```

### 5b. Live Polling (every 5 seconds)
```
[cron every 5s]
    → pollLiveMatches()
        → API-Football /fixtures?status=LIVE
        → analyzeMatch() per fixture    ← ⚠️ CURRENTLY USES 3-RULE SCORING (bug)
                                            FIXED: now merges calibration store + V8
        → liveMatches[] updated
        → broadcast({ type: 'LIVE_MATCHES' }) to WebSocket clients

    → pollUpcomingMatches()
        → If calibrationStore < 6h old: uses calibration data (skips API)
        → Else: API-Football /fixtures?status=NS&date=today+tomorrow
        → analyzeMatch() per fixture
        → upcomingMatches[] updated
        → broadcast({ type: 'UPCOMING_MATCHES' })
```

### 5c. Frontend WebSocket Client
```
App.jsx
    connectWebSocket() → wss://web-production-cccff.up.railway.app
    on('LIVE_MATCHES')     → setAllMatches(merge live + upcoming)
    on('UPCOMING_MATCHES') → setAllMatches(merge live + upcoming)
    on('NEW_ALERT')        → add to alerts[]
    on('BET_LOGGED')       → add to bets[]
    on('BET_UPDATED')      → update in bets[]

    Every 30s: GET /api/matches/live (HTTP fallback)
```

### 5d. Match Detail / Analytics Request
```
User clicks match → DetailPanel.jsx
    → GET /api/analytics/match/:id
    → naturalLanguageToMatchData() or calibrationStore lookup
    → analyzeV6() → full 15-param analysis
    → returns { recommendations, poisson, parameters, bookieEdges, ... }
    → renders in AnalyticsModal.jsx
```

---

## 6. Agent 47 V8 Engine — Full Reference

**File**: `backend/src/services/agent47Service.js`
**Entry point**: `analyzeV6(matchData)` (also exported as default)
**Version label**: `"V8-Master"` (despite function name `analyzeV6`, it IS the V8 logic)

### 6a. 15 Parameters + Weights

| # | Parameter | Weight | Description |
|---|-----------|--------|-------------|
| P1 | Motivation Gap | 16% | Title/relegation stakes, late-season pressure, MWV index |
| P2 | Star Power | 7% | Key player availability vs absences (position-weighted) |
| P3 | H2H History | 8% | Last N meetings: goals avg, over-rate, win distribution |
| P4 | Form (L10) | 12% | Recent 5 weighted 1.6× heavier than previous 5. Coiled Spring detection |
| P5 | Scoring Timing | 7% | % goals in 76-90' window vs league baseline |
| P6 | Defensive Gap | 7% | Goals against avg + CB injury + GK error flags |
| P7 | Poisson | 9% | Derived from Poisson model, score = Over2.5% × 0.8 |
| P8 | xG Attack | 6% | Expected goals scored per game avg |
| P9 | xGA Defense | 5% | Expected goals conceded per game avg |
| P10 | Pace / Conversion | 4% | Shots per game + conversion % |
| P11 | Timezone / Structural | 2% | Currently returns 100 (placeholder) |
| P12 | Fixture Confirmed | 1% | Always 100 |
| P13 | Squad Integrity | 5% | Overall % first-choice squad available |
| P14 | League Lifecycle | 1% | Gameweek % through season, phase label |
| P15 | Crisis / Drought | 10% | Goal droughts (3+ scoreless), losing runs (4+), interim coach instability |

**Total weight: 100%**

### 6b. Tier System

| Tier | Name | Confidence | Stake % |
|------|------|------------|---------|
| 1 | Capital Security | ≥85% | 3-5% purse |
| 2 | Balanced Play | 72-84% | 2-3% purse |
| 3 | Aggressive Play | 65-71% | 1-2% purse |
| 4 | Calculated Chaos | 55-64% | ≤1% purse |

### 6c. Bet Slip Generator (BetSlips.jsx → /api/bets/slips)

Uses `calibrationStore.matches` sorted by confidence:
- **Tier 1 Singles**: ≥85% confidence, stake = 35% of bankroll ÷ count
- **Tier 2 Accumulator**: 2-3 legs ≥72%, stake = 25% bankroll
- **Tier 3 Value Combo**: 2-4 legs ≥65%, prefer Over2.5/BTTS
- Dynamic bankroll protection: if bankroll < ₦100k, heavier Tier 1 allocation

### 6d. Poisson Model

Uses attack strength × opponent defensive weakness:
```
lH = (homeXgAvg / leagueAvg) × (awayXgaAvg / leagueAvg) × leagueAvg
lA = (awayXgAvg / leagueAvg) × (homeXgaAvg / leagueAvg) × leagueAvg
```
Produces: Over 0.5/1.5/2.5/3.5 probabilities, BTTS%, most likely scoreline.

### 6e. League Variance Scalars

| League | Scalar | Effect |
|--------|--------|--------|
| Premier League | 1.00 | Baseline |
| La Liga, Bundesliga, Ligue 1, Serie A | 1.00 | Baseline |
| Brasileirão, Indonesian Liga 1 | 1.15 | Widens confidence range |

### 6f. Special Detections

- **Coiled Spring**: home/awayXgAvg > goals avg by 35%+ AND xG trend not declining → +12 pts to form score
- **PSG Trap**: possession ≥70% → warns of stalling xG conversion
- **MWV Index**: both teams in title/relegation battles → draw market value, cascade goal risk
- **Early Goal Multiplier**: goal before minute 20 → +40% to Over 3.5 probability
- **Bookie Edge Detector**: outputs narrative edges the bookmaker may be mispricing

---

## 7. API Endpoints (Backend)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Server status + quota state |
| GET | `/api/matches/live` | Current live matches from liveMatches[] |
| GET | `/api/matches/upcoming` | Upcoming matches |
| GET | `/api/matches/all` | Both combined |
| GET | `/api/matches/:id` | Single match by ID |
| GET | `/api/analytics/match/:id` | Full V8 analysis for a match |
| POST | `/api/analytics/score` | Score custom matchData object |
| GET | `/api/search?q=` | NL search → Gemini → V8 analysis |
| POST | `/api/calibrate` | Manual re-calibration trigger |
| GET | `/api/calibration/status` | calibrationStore metadata |
| GET | `/api/bets/slips` | Auto-generated Tier 1/2/3 bet slips |
| POST | `/api/bets` | Log a manual bet |
| GET | `/api/bets/history` | All logged bets |
| PATCH | `/api/bets/:id` | Update bet result (won/lost) |
| GET | `/api/alerts` | Alert history |
| GET | `/api/quota` | API-Football quota state |
| GET | `/api/test-whatsapp` | Test WhatsApp alert send |
| GET | `/api/v8/demo` | Demo analysis output |

---

## 8. Environment Variables

### Backend (`backend/.env` and Railway dashboard)

```env
# API-Football
API_FOOTBALL_KEY=<your_api_football_key>

# AI
GEMINI_API_KEY=<your_gemini_api_key>
GROQ_API_KEY=<your_groq_api_key>

# Twilio WhatsApp
TWILIO_ACCOUNT_SID=<your_twilio_account_sid>
TWILIO_AUTH_TOKEN=<your_twilio_auth_token>
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
ALERT_PHONE_NUMBER=whatsapp:+2348072187110

# Config
MIN_CONFIDENCE_ALERT=65
LIVE_POLL_INTERVAL=5
PORT=3000
NODE_ENV=production
CORS_ORIGIN=https://sporty-rabbit.netlify.app
API_DAILY_SOFT_STOP=50
API_MINUTE_SOFT_STOP=1
```

### Frontend (`frontend/.env`)
```env
VITE_API_BASE_URL=http://localhost:3000/api
```
For production: `VITE_API_BASE_URL=https://web-production-cccff.up.railway.app/api` (set in Netlify dashboard)

---

## 9. Sidebar League Hierarchy

Leagues sorted by tier in sidebar, then by match count within tier:

| Tier | Leagues |
|------|---------|
| 1 (International) | Int Friendlies (1), World Cup (4), EURO/Copa America (9), Nations League (16) |
| 2 (UEFA Club) | Champions League (2), Europa League (3), Conference League (848) |
| 3 (Top 5 Europe) | Premier League (39), La Liga (140), Bundesliga (78), Serie A (135), Ligue 1 (61) |
| 4 (Strong Euro + Cups) | Championship, Ligue 2, 2. Bundesliga, Serie B, Eredivisie, Primeira Liga, Super Lig, Russian, Scottish, Belgian, Saudi, Copa Libertadores, Sudamericana |
| 5 (Americas/Asia) | MLS, Brazilian, Argentine, J-League, K-League, Chinese Super League, Indonesian Liga 1, A-League, AFC CL |

---

## 10. In-Memory State (No Database for Matches)

The backend holds all match data in RAM. A Railway restart wipes everything and triggers auto-calibration (5s delay) to refill. This is by design for the MVP.

```javascript
let liveMatches = [];          // Current live API-Football fixtures
let upcomingMatches = [];      // Today + tomorrow NS fixtures
let alerts = [];               // Last 100 alerts (also in Firestore)
let bets = [];                 // All logged bets (also in Firestore)
let calibrationStore = {
  matches: [],                 // V8-enriched fixtures from calibration
  highConfidence: [],          // Subset ≥65% confidence
  calibratedAt: null,
  totalScanned: 0,
};
```

---

## 11. Key Known Issues / Gaps (as of May 30, 2026)

### Critical
1. **`analyzeMatch()` uses 3-rule scorer instead of V8** — Live matches from API-Football get confidence from possession/shots/xG only, not the 15-parameter V8 engine. FIXED in session of May 30.

### Moderate
2. **`liveAnalyticsService.js` is crude** — `calculateNextGoalProbability()` multiplies xG by 10% conversion rate which is conceptually wrong (xG already IS expected goals). Should use remaining xG from Poisson projection.
3. **No real-time xG from API-Football** — The `expected_goals` stat is often null or 0 in live matches; we fall back to 0 which degrades V8 accuracy.
4. **P11 (Timezone) and P12 (Fixture) are stub 100s** — These parameters always return 100 and add no signal. Their weights (3% combined) could be reallocated.
5. **No historical bet outcome tracking** — Bet slips are generated but there is no feedback loop to measure if V8 predictions were correct over time.

### Minor
6. **Groq `llama-3.1-70b-versatile` deprecated** — In fallback chain; may cause 404s. Already handled by try/catch fallback logic.
7. **Calibration uses Gemini knowledge cut-off** — If running between seasons or for leagues Gemini doesn't know well (Indonesian Liga 1, Korean K-League), xG/form estimates will be less accurate.
8. **WhatsApp alert fires per `saveAlert()` call** — If the same match generates multiple alerts rapidly (e.g., during calibration + live poll), duplicate WhatsApp messages may be sent.
9. **No pagination on match feed** — All matches rendered as DOM nodes. Memoization added May 30 but no virtualization. With 100+ matches this may still lag.

---

## 12. AI Provider Configuration

### Gemini (Google)
- **Used for**: Calibration (Google Search grounding), match enrichment (search grounding), NL match search
- **Model**: `gemini-2.5-flash` primary, fallback chain: `gemini-2.5-flash-lite → gemini-flash-latest → gemini-2.0-flash`
- **Key capability**: Google Search grounding → real-time fixture/form data

### Groq (Meta Llama)
- **Used for**: NL match analysis (primary), enrichment fallback (no search)
- **Model**: `llama-3.3-70b-versatile` primary, fallback: `llama-3.1-8b-instant → mixtral-8x7b-32768`
- **Free tier**: ~14,400 requests/day
- **Limitation**: No web search access — estimates from training data only

### Provider priority
- NL search (`/api/search`): Groq first, Gemini fallback
- Calibration (`calibrateDay`): Gemini with Search only (Groq has no search)
- Enrichment (`enrichFixturesWithV8`): Gemini with Search first, Groq fallback

---

## 13. WhatsApp Alerts

- **From**: Twilio sandbox `whatsapp:+14155238886`
- **To**: `whatsapp:+2348072187110` (owner's WhatsApp Business line)
- **Trigger**: Any `saveAlert()` where `confidence >= MIN_CONFIDENCE_ALERT` (65)
- **Format**: match name, league, confidence %, recommendation, Nigeria time
- **Confirmed working**: Test fired May 2026, message received

---

## 14. Development Commands

```bash
# Root
npm run dev              # Starts both frontend (5173) and backend (3000)

# Backend only
cd backend && npm run dev

# Frontend only  
cd frontend && npm run dev

# Build frontend for production
cd frontend && npm run build

# Deploy: just push to GitHub
git add -A && git commit -m "..." && git push
# → Railway auto-deploys backend
# → Netlify auto-deploys frontend
```

---

## 15. Model Improvement Roadmap (Priority Order)

### P0 — Done (May 30, 2026)
- [x] `analyzeMatch()` now merges calibration store + V8 scoring for live matches
- [x] React performance: useMemo/useCallback/memo applied
- [x] CSS hover instead of JS DOM mutations

### P1 — Next (high impact on accuracy)
- [ ] Fix `liveAnalyticsService.js` next-goal probability to use proper Poisson remaining-xG
- [ ] P11 (Timezone) and P12 (Fixture) should carry real signal (referee stats, venue conditions)
- [ ] Add home advantage adjustment to Poisson lambdas (+15% for home team by default)
- [ ] Persist V8 outcome tracking — compare prediction vs match result daily

### P2 — Medium term
- [ ] Odds movement tracking — compare opening odds to current. Large movement = sharp money signal
- [ ] Add expected value (EV) calculation per recommendation: `EV = (prob × odds) - 1`
- [ ] User authentication + per-user bankroll / bet history
- [ ] Email alerts in addition to WhatsApp

### P3 — Long term
- [ ] Historical accuracy dashboard — % of V8 tier predictions that won
- [ ] League-specific parameter tuning (different weights for Serie A vs K-League)
- [ ] Machine learning layer to calibrate P-weights from historical outcomes
- [ ] Mobile app

---

## 16. Calibration Flow Detail

```
POST /api/calibrate (or auto every 6h)
    ↓
calibrateDay():
    1. Try API-Football /fixtures?date=today → raw fixture list
    2. If API-Football returns fixtures:
       → enrichFixturesWithV8(fixtureList)
           → batches of 5 → Gemini Search for real form/stats
           → Groq fallback (no search) if Gemini fails
           → each batch → analyzeV6() → V8 score
    3. If API-Football empty/unavailable:
       → calibrateDay() in geminiService → Gemini Search grounding for full schedule
       → enrichFixturesWithV8() same as above
    ↓
calibrationStore.matches = enriched + V8-scored fixtures
calibrationStore.highConfidence = matches ≥65%
upcomingMatches = calibrationStore.matches
broadcast(UPCOMING_MATCHES)
```

Each fixture in calibrationStore has:
```javascript
{
  id, home, away, league, leagueId, leagueCountry,
  score, status, matchMinutes, kickoffUTC,
  possession, shots, xg,
  confidence,          // V8 overall score (0-100)
  opportunities: [],   // top recommendation labels
  analysis: {          // full analyzeV6() output
    recommendations: [],
    parameters: { p1..p15 },
    poisson: {},
    chaosVariables: {},
    bookieEdges: [],
    overallScore: N,
  }
}
```
