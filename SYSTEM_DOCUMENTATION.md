# SportyRabbi — Complete System Documentation
**Last updated: May 30, 2026 — commit `5185d1f`**

---

## 1. Project Purpose

SportyRabbi is a real-time football betting analytics portal. It scrapes live global fixtures, runs them through a proprietary 15-parameter AI scoring engine (Agent 47 **V9**), and surfaces high-confidence betting recommendations with WhatsApp alerts.

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
│   │       ├── agent47Service.js     ← The V9 engine (15-parameter scoring, Dixon-Coles Poisson)
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
    → enrichFixturesWithGemini() [geminiService.js]
        → Batches of 5 fixtures
        → Gemini Search: real form, position, xG, H2H, squad news per team
        → Falls back to Groq (no search) if Gemini fails
        → Cache per fixture pair (12h TTL)
    → enriched fixtures passed to analyzeV9() [agent47Service.js]
        → Full 15-parameter V9 score computed (Dixon-Coles Poisson)
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
    → POST /api/analyze  (body: matchData incl. homeTeamId, awayTeamId, matchType)
    → Step 1: fetch real team form, H2H, standings from API-Football (if IDs available)
    → Step 2: live xG projection (matchMins ≥ 15)
    → Step 3: analyzeV9() → full 15-param V9 analysis
    → Step 4: generateMatchNarrative() → Groq analyst note (always fires; deterministic fallback if Groq unavailable)
    → returns { recommendations, poisson, parameters, bookieEdges, narrative, ... }
    → renders in DetailPanel.jsx (parameters, tier rec, analyst note)
```

**Critical data-flow fix (commit `5185d1f`)**: `sanitizeMatch()` now outputs `homeTeamId` and `awayTeamId`. Previously these were stripped, causing all click-analyses to receive null team IDs and fall back to identical neutral defaults on every match.

---

## 6. Agent 47 V9 Engine — Full Reference

**File**: `backend/src/services/agent47Service.js`  
**Entry point**: `export function analyzeV9(matchData)`  
**Version label**: V9 — science-based parameter overhaul (commit `5185d1f`, May 30 2026)

### 6a. 15 Parameters + Weights (V9)

| # | Key | Weight | Description |
|---|-----|--------|-------------|
| P1 | `p1_motivation` | **13%** | Title/relegation stakes, late-season pressure, MWV index |
| P2 | `p2_starPower` | **7%** | Key player availability vs absences (position-weighted) |
| P3 | `p3_h2h` | **3%** | Last N meetings: goals avg, over-rate, win distribution |
| P4 | `p4_form` | **15%** | Recent 5 weighted 1.6× heavier than previous 5. Coiled Spring detection |
| P5 | `p5_scoringTiming` | **5%** | % goals in 76-90' window vs league baseline |
| P6 | `p6_defensiveGap` | **7%** | Goals against avg + CB injury + GK error flags |
| P7 | `p7_poisson` | **11%** | **Dixon-Coles corrected** Poisson — corrects under-prediction of 0-0/1-0/0-1/1-1 |
| P8 | `p8_xg` | **6%** | **xG differential** — directional attacking edge (who has the xG advantage), not raw sum |
| P9 | `p9_xga` | **5%** | **Defensive solidity** — each team's xGA vs league average; high score = tight game |
| P10 | `p10_pace` | **4%** | Shots per game + conversion % |
| P11 | `p11_homeAdvantage` | **3%** | Live possession dominance + shot ratio |
| P12 | `p12_market` | **4%** | **Model vs market divergence** — Poisson O2.5 prob vs bookmaker implied prob |
| P13 | `p13_squad` | **5%** | **Competitive context** — league tier predictability premium (Top-5 = 76, unknown = 44) |
| P14 | `p14_lifecycle` | **2%** | Gameweek % through season, phase label |
| P15 | `p15_crisis` | **10%** | Goal droughts (3+ scoreless), losing runs (4+), interim coach instability |

**Total weight: 100%** (0.13+0.07+0.03+0.15+0.05+0.07+0.11+0.06+0.05+0.04+0.03+0.04+0.05+0.02+0.10 = 1.00)

**V9 vs V8 key changes:**
- P7: Raw Poisson → **Dixon-Coles ρ = −0.1 correction** (fixes systematic under-prediction of low-score draws)
- P8: Raw combined xG sum → **xG directional differential** (eliminates triple-counting xG with P7 and P9)
- P9: Raw combined xGA sum → **Defensive solidity vs league average** (distinct signal from P7)
- P12: Bookmaker overround score → **Poisson model vs market implied probability** (genuine edge detection)
- P13: Duplicate squad integrity (same as P2) → **Competitive context / league tier** (new independent signal)
- P4: 14% → 15% (+1%); P12: 3% → 4% (+1%); P15: 12% → 10% (−2%)

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

### 6d. Poisson Model (Dixon-Coles corrected)

Lambdas use attack strength × opponent defensive weakness:
```
lH = (homeXgAvg / L) × (awayXgaAvg / L) × L   where L = 1.35 (league avg per team)
lA = (awayXgAvg / L) × (homeXgaAvg / L) × L
```

**Dixon-Coles ρ correction** applied to joint probabilities of low-scoring cells:
```
tau(0,0) = 1 − lH × lA × ρ
tau(1,0) = 1 + lA × ρ
tau(0,1) = 1 + lH × ρ
tau(1,1) = 1 − ρ
tau(h,a) = 1 for h+a ≥ 3
ρ = −0.1 (empirically fitted to European football)
```

Produces: Over 0.5/1.5/2.5/3.5 probabilities, BTTS%, most likely scoreline.

**Live xG projection** (POST `/api/analyze` only, `matchMins ≥ 15`): blends accumulated live xG with rate-projected full-match xG. Blend weight ramps from 0% at 15' to 70% at ~52'.

### 6e. League Variance Scalars

| League | Scalar | Effect |
|--------|--------|--------|
| Premier League (39) | 1.00 | Baseline |
| La Liga (140), Bundesliga (78) | 0.97 | Slight reduction |
| Serie A (135) | 0.93 | Tactical variance |
| Ligue 1 (61) | 0.90 | PSG dominance chaos |
| Brasileirão (71) | 0.70 | High variance |
| Unknown leagues | 0.93 | Unknown = uncertainty penalty |

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

## 11. Key Known Issues / Gaps (as of May 30, 2026 — commit `5185d1f`)

### Fixed in this session
- ✅ **`sanitizeMatch()` stripping team IDs** — root cause of identical parameters on all matches. Now passes `homeTeamId`/`awayTeamId` through to the frontend.
- ✅ **P8/P9 triple-counting xG** — P8 now directional differential, P9 now defensive solidity (both distinct from P7 Poisson).
- ✅ **P12 market signal backwards** — now computes Poisson model vs market implied probability divergence.
- ✅ **P13 duplicate squad integrity** — now Competitive Context (league tier premium).
- ✅ **Analyst note missing on some matches** — `generateMatchNarrative()` now always fires; deterministic fallback when Groq unavailable.
- ✅ **Analyst note regex bug** — `'p\d+_'` → `/p\d+_/` (parameter names were never being cleaned in prompts).

### Moderate (open)
1. **`liveAnalyticsService.js` is crude** — `calculateNextGoalProbability()` multiplies xG by 10% conversion rate. Should use remaining-time Poisson projection instead.
2. **No real-time xG from API-Football** — `expected_goals` stat is often null/0 for lower-league live matches. Falls back to per-league LEAGUE_XG_MAP defaults.
3. **No historical bet outcome tracking** — No feedback loop to measure if V9 predictions were correct over time. Model weights are still hand-tuned, not backtested.

### Minor (open)
4. **Groq `llama-3.1-70b-versatile` deprecated** — In fallback chain; handled by try/catch.
5. **Calibration uses Gemini knowledge cut-off** — Lower leagues (Indonesian Liga 1, K-League) may have stale estimates.
6. **WhatsApp alert deduplication** — Same match can generate multiple alerts during calibration + live poll overlap.
7. **No match feed virtualization** — 100+ matches rendered as DOM nodes. Memoization applied but no windowing.

---

## 12. AI Provider Configuration

### Gemini (Google)
- **Used for**: Calibration (Google Search grounding), match enrichment (search grounding), NL match search
- **Model**: `gemini-2.5-flash` primary, fallback chain: `gemini-2.5-flash-lite → gemini-flash-latest → gemini-2.0-flash`
- **Key capability**: Google Search grounding → real-time fixture/form data

### Groq (Meta Llama)
- **Used for**: NL match analysis (primary), enrichment fallback (no search)
- **Model**: `llama-3.3-70b-versatile` primary, fallback: `llama-3.1-8b-instant → mixtral-8x7b-32768`
- **Pro plan**: higher rate limits — see [api-football.com/pricing](https://www.api-football.com/pricing)
- **Limitation**: No web search access — estimates from training data only

### Provider priority
- NL search (`/api/search`): Groq first, Gemini fallback
- Calibration (`calibrateDay`): Gemini with Search only (Groq has no search)
- Enrichment (`enrichFixturesWithGemini`): Gemini with Search first, Groq fallback

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

### Done (May 30, 2026 — commit `5185d1f`)
- [x] V9 engine deployed: Dixon-Coles Poisson, xG differential, defensive solidity, competitive context, market divergence
- [x] `sanitizeMatch()` passes team IDs → real form/standings fetched per click
- [x] `generateMatchNarrative()` always fires with deterministic fallback
- [x] React performance: useMemo/useCallback/memo applied
- [x] P11 and P12 repurposed from stubs to real signals (home advantage + market divergence)
- [x] `analyzeMatch()` merges calibration store + V9 scoring for live matches

### P1 — Next (high impact on accuracy)
- [ ] Fix `liveAnalyticsService.js` — replace xG × 10% conversion with remaining-time Poisson projection
- [ ] V9 backtesting — persist prediction + actual result, compute tier accuracy over rolling 30 days
- [ ] Add home advantage lambda adjustment in Poisson (`lH × 1.12` vs `lA × 0.88` as literature baseline)
- [ ] Odds movement tracking — flag large line movements as sharp money signal

### P2 — Medium term
- [ ] Expected value (EV) calculation per recommendation: `EV = (modelProb × odds) − 1`
- [ ] User authentication + per-user bankroll / bet history
- [ ] Email alerts in addition to WhatsApp
- [ ] Fixture congestion signal — games played in last 21 days as proxy for fatigue (replaces P13 if competitive context proves weak)

### P3 — Long term
- [ ] Historical accuracy dashboard — % of V9 tier predictions that won, by parameter driver
- [ ] League-specific weight tuning (Serie A, K-League behave differently)
- [ ] ML calibration layer — gradient-boosted weights fitted from historical outcomes
- [ ] Mobile app

---

## 16. Calibration Flow Detail

```
POST /api/calibrate (or auto every 6h)
    ↓
calibrateDay():
    1. Try API-Football /fixtures?date=today → raw fixture list
    2. If API-Football returns fixtures:
       → enrichFixturesWithGemini(fixtureList)
           → batches of 5 → Gemini Search for real form/stats
           → Groq fallback (no search) if Gemini fails
           → each batch → analyzeV9() → V9 score
    3. If API-Football empty/unavailable:
       → calibrateDay() in geminiService → Gemini Search grounding for full schedule
       → enrichFixturesWithGemini() same as above
    ↓
calibrationStore.matches = enriched + V9-scored fixtures
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
  confidence,          // V9 overall score (0-100)
  opportunities: [],   // top recommendation labels
  analysis: {          // full analyzeV9() output
    recommendations: [],
    parameters: { p1..p15 },
    poisson: {},
    chaosVariables: {},
    bookieEdges: [],
    overallScore: N,
  }
}
```
