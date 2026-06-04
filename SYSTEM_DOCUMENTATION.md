# SportyRabbi — Complete System Documentation
**Last updated: May 31, 2026 — commit `48c044f`**

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

Calibration is the backbone of the system. It runs once on startup and every 6 hours thereafter, building the enriched fixture store that powers both the upcoming matches view and the click-time analysis fallback.

```
[startup / cron 0,6,12,18 UTC]

STEP 1 — Fixture Discovery
    → API-Football /fixtures?date=today       (primary, authenticated)
    → TheSportsDB (free, no key)              (fallback if API-Football empty)
    → calibrateDay() [geminiService.js]       (Gemini+Search grounding, last resort)
    → raw[] = fixture list, 10–60 matches

STEP 2 — Context Adjustment (TWO-LLM PIPELINE — added May 31, 2026)
    → fetchAndReasonContextAdjustments(raw[]) [geminiService.js]

    [Gemini 2.5 Flash + Google Search — ONE call for ALL fixtures]
        "Find confirmed news in last 72h: injuries, suspensions, manager changes"
        → newsMap: Map<"home:away" → {homeInjuries, awayInjuries, homeManagerChange,
                         awayManagerChange, notes}>
        → Per absent player: name, position, ROLE, recentImpact, recentContributionNotes
        → NEVER fabricates — omits fixtures with no confirmed news
        → 2-hour cache (keyed by date) to avoid re-fetching within same cycle

    [Groq llama-3.3-70b-versatile — PARALLEL, one call per fixture with news]
        Input: confirmed news + current V9 inputs (squadIntegrity, keyAbsences)
        Reasoning: weighs ACTUAL recent contribution, not historical reputation
            - recentImpact=high   → 10–18 point squad integrity adjustment
            - recentImpact=medium → 5–10 points
            - recentImpact=low    → 0–5 points (may return null if negligible)
        Output: {homeSquadIntegrity, awaySquadIntegrity,
                 homeKeyAbsencesAdd[], awayKeyAbsencesAdd[],
                 contextWarnings[], adjustmentReasoning}
    → contextAdjMap: Map<"home:away" → adjustments>
    → Fully graceful: calibration continues normally if this step errors

STEP 3 — Enrichment
    → enrichFixturesWithGemini(fixtureList) [geminiService.js]
        → Batches of 5 → Gemini Search: form, xG, H2H, standings per team
        → Groq fallback (no search) if Gemini quota exhausted
        → 12h cache per fixture pair

STEP 4 — Apply Context Adjustments + Run V9
    For each fixture in raw[]:
        → matchData built from enriched stats
        → contextAdjMap.get(key) applied to matchData BEFORE analyzeV9():
              matchData.homeSquadIntegrity = adj.homeSquadIntegrity (clamped 0-100)
              matchData.homeKeyAbsences.push(...adj.homeKeyAbsencesAdd)
              (same for away side)
        → analyzeV9(matchData) → full 15-parameter V9 score
        → matchObj.calibratedInputs = all 30 V9 input fields (stored for click fallback)
        → matchObj.contextAdjustments = adj (stored for transparency/debugging)

STEP 5 — Store + Broadcast
    → calibrationStore = { matches: [...], highConfidence: [...], calibratedAt }
    → upcomingMatches = calibrationStore.matches
    → broadcast({ type: 'UPCOMING_MATCHES' }) to all WebSocket clients
    → High-confidence matches (≥65%) trigger WhatsApp alert
```

Live match fallback note:
- Live fixtures are fetched first, then enriched by V9.
- If enrichment or V9 fails for one live fixture, the backend keeps a minimal fallback row instead of dropping that match from the feed.
- WhatsApp alerting is still threshold-based: `<65%` silent, `65–79%` standard alert, `80%+` premium alert.

---

### 5b. Live Polling (every 30 seconds)

```
[cron every 30s]
    → API-Football /fixtures?status=LIVE
    → For each live fixture: analyzeMatch()
        → getTeamForm(), getH2H(), getStandings() (1h–6h cached)
        → getTeamInjuries() → homeKeyAbsences, awayKeyAbsences
        → analyzeV9(matchData) with live shots, possession, xG
        → generateBettingAlert() if confidence crosses threshold
    → liveMatches[] updated
    → broadcast({ type: 'LIVE_MATCHES' }) to WebSocket clients
```

---

### 5c. User Click — Match Analysis (`POST /api/analyze`)

This is the most complex path. It blends pre-calibration context with fresh API data and live in-match signals, then runs V9 and generates a Groq narrative.

```
User clicks a match → POST /api/analyze (body: match object from frontend)

STEP 1 — Fresh API-Football stats (if team IDs available)
    → getTeamForm(homeTeamId), getTeamForm(awayTeamId)
    → getH2H(homeTeamId, awayTeamId)
    → getStandings(leagueId)
    → Populates: form strings, xG/xGA averages, positions, points, H2H history
    → API-Football always wins (calibration stats only used as fallback)

STEP 2 — Calibration fallback (for fields API-Football could not fill)
    → Find match in calibrationStore by home/away name
    → calibratedInputs applied ONLY for fields still null/empty after Step 1
    → This preserves Gemini enrichment (from calibration) when API-Football is offline
    → Also applies context-adjusted squad integrity from the calibration cycle

STEP 2a — Live shots & possession blend (added May 31, 2026)
    Active only when: status=LIVE and matchMinutes ≥ 25
    Blend formula (ramps 20% → 60% live weight across minutes 25–90):
        liveWeight = min(0.60, 0.20 + ((matchMins − 25) / 65) × 0.40)
        homeShotsPerGame = (shots.home × 90/matchMins × liveWeight)
                         + (seasonAvgShots × (1 − liveWeight))
        homePossession = possession.home  (direct, no blend — it IS real-time)
    Affects V9 parameters: P10 Pace (scorePace) and P11 Home Advantage (scoreHomeAdvantage)
    Season baseline always anchors early; actual match performance dominates late game

STEP 2b — Live xG projection (existing, ≥15 min, hasLiveXg=true)
    blendWeight = min(0.70, progress × 1.2)   (ramps 0 → 0.70 over ~52 min)
    projFactor = min(90 / matchMins, 3.5)       (cap prevents early-game inflation)
    homeXgAvg = xg.home × (1−blend) + xg.home × projFactor × blend
    Affects V9 parameters: P7 Poisson and P8 xG Edge (the primary goal-probability drivers)

STEP 3 — V9 engine
    → analyzeV9(enriched) with all blended inputs
    → Full 15-parameter score

STEP 4 — Groq narrative
    → generateMatchNarrative(analysis, enriched)
    → 2-3 sentence analyst note — references top 3 V9 parameters
    → Deterministic fallback if Groq unavailable (always returns something)
    → narrative text displayed in DetailPanel below recommendations
```

---

### 5d. Frontend WebSocket Client

```
App.jsx
    connectWebSocket() → wss://web-production-cccff.up.railway.app
    on('LIVE_MATCHES')     → setAllMatches(merge live + upcoming)
    on('UPCOMING_MATCHES') → setAllMatches(merge live + upcoming)
    on('NEW_ALERT')        → add to alerts[]
    on('BET_LOGGED')       → add to bets[]
    on('BET_UPDATED')      → update in bets[]

    Every 30s: GET /api/live (HTTP fallback if WebSocket drops)
```

---

## 6. Agent 47 V9 Engine — Full Reference

**File**: `backend/src/services/agent47Service.js`
**Entry point**: `export function analyzeV9(matchData)`
**Pure mathematics — zero LLM calls.** LLM context adjustments are applied to matchData BEFORE this function runs; the LLM narrative is generated from the output AFTER.

### 6a. 15 Parameters + Weights (V9)

| # | Key | Weight | Description |
|---|-----|--------|-------------|
| P1 | `p1_motivation` | **13%** | Title/relegation stakes, MWV index, late-season pressure |
| P2 | `p2_starPower` | **7%** | Key player availability vs absences (position-weighted); fed by context adjustment pipeline |
| P3 | `p3_h2h` | **3%** | Last N meetings: goals avg, over-rate, win distribution |
| P4 | `p4_form` | **15%** | Weighted L10 (recent 5 = 1.6× heavier). Coiled Spring detection |
| P5 | `p5_scoringTiming` | **5%** | % goals in 76–90' window vs league baseline |
| P6 | `p6_defensiveGap` | **7%** | Goals against avg + CB injury flag + GK error flag |
| P7 | `p7_poisson` | **11%** | Dixon-Coles corrected Poisson (ρ = −0.1) — fixes low-score draw under-prediction |
| P8 | `p8_xg` | **6%** | xG directional differential — who has the attacking xG advantage |
| P9 | `p9_xga` | **5%** | Defensive solidity — each team's xGA vs league average |
| P10 | `p10_pace` | **4%** | Shots per game + conversion %. Live-blended during in-play (Step 2a) |
| P11 | `p11_homeAdvantage` | **3%** | Live possession dominance + shot ratio. Live-blended during in-play (Step 2a) |
| P12 | `p12_market` | **4%** | Poisson model vs bookmaker implied probability divergence |
| P13 | `p13_squad` | **5%** | Competitive context — league tier predictability premium |
| P14 | `p14_lifecycle` | **2%** | Gameweek % through season, phase label |
| P15 | `p15_crisis` | **10%** | Goal droughts (3+), losing runs (4+), interim coach instability |

**Total: 100%**

**V9 vs V8 key changes (committed May 30, 2026 — `5185d1f`):**
- P7: Raw Poisson → Dixon-Coles ρ = −0.1 (fixes systematic under-prediction of 0-0/1-0/0-1/1-1)
- P8: Raw combined xG sum → xG directional differential (eliminates triple-counting with P7 and P9)
- P9: Raw combined xGA → Defensive solidity vs league average (distinct from P7)
- P12: Bookmaker overround → Poisson model vs market implied probability (genuine edge detection)
- P13: Duplicate squad integrity → Competitive context / league tier (new independent signal)

### 6b. Tier System

| Tier | Name | Confidence | Stake % |
|------|------|------------|---------|
| 1 | Capital Security | ≥85% | 3–5% purse |
| 2 | Balanced Play | 72–84% | 2–3% purse |
| 3 | Aggressive Play | 65–71% | 1–2% purse |
| 4 | Calculated Chaos | 55–64% | ≤1% purse |

### 6c. Bet Slip Generator

Uses `calibrationStore.matches` sorted by confidence:
- **Tier 1 Singles**: ≥85% confidence, stake = 35% of bankroll ÷ count
- **Tier 2 Accumulator**: 2–3 legs ≥72%, stake = 25% bankroll
- **Tier 3 Value Combo**: 2–4 legs ≥65%, prefer Over2.5/BTTS

### 6d. Poisson Model (Dixon-Coles corrected)

```
lH = (homeXgAvg / L) × (awayXgaAvg / L) × L    L = 1.35 (league avg per team)
lA = (awayXgAvg / L) × (homeXgaAvg / L) × L

Dixon-Coles ρ correction on low-score cells:
  tau(0,0) = 1 − lH × lA × ρ
  tau(1,0) = 1 + lA × ρ
  tau(0,1) = 1 + lH × ρ
  tau(1,1) = 1 − ρ
  tau(h,a) = 1  for h+a ≥ 3
  ρ = −0.1 (empirically fitted to European football)
```

Produces: Over 0.5/1.5/2.5/3.5 probabilities, BTTS%, most likely scoreline.

### 6e. League Variance Scalars

| League | Scalar |
|--------|--------|
| Premier League (39) | 1.00 (baseline) |
| La Liga (140), Bundesliga (78) | 0.97 |
| Serie A (135) | 0.93 |
| Ligue 1 (61) | 0.90 |
| Brasileirão (71) | 0.70 |
| Unknown | 0.93 |

### 6f. Special Detection Flags

- **Coiled Spring**: homeXgAvg > goalsAvg by ≥35% AND xG trend stable → +12 pts to form score
- **PSG Trap**: possession ≥70% → warns of stalling xG conversion risk
- **MWV Index**: both teams in title/relegation battles → draw market + cascade goal flags
- **Early Goal Multiplier**: goal before minute 20 → +40% to Over 3.5 probability
- **Bookie Edge Detector**: outputs narrative edges on potentially mispriced markets

---

## 7. Two-LLM Pipeline Architecture

This is the genuine analytical layer added May 31, 2026. It is distinct from enrichment (which fills in statistics) and from narrative (which writes text). Its purpose is to adjust V9's mathematical inputs based on real-world contextual facts no API provides.

### 7a. Why Two LLMs (not one)?

| LLM | Unique Capability | Role in Pipeline |
|-----|------------------|-----------------|
| **Gemini 2.5 Flash** | Google Search grounding — can browse the live web | Fact-gathering: fetches confirmed news for all fixtures in ONE call |
| **Groq (llama-3.3-70b-versatile)** | Fast, structured JSON reasoning, OpenAI-compatible | Analytical reasoning: translates news facts into numeric parameter adjustments |

The value is **asymmetric, not collaborative**. Gemini does what only it can do (web access). Groq does what LLMs do well (structured reasoning from given facts). They are not cross-checking each other — they are performing different functions in sequence.

### 7b. What Gemini Fetches

One call per calibration cycle covering all fixtures. The prompt instructs Gemini to:
- Find confirmed news from the last 72 hours only
- Look for: injuries/suspensions confirmed by club or credible journalist, manager sackings (last 7 days), confirmed lineup information from official sources
- For each absent player, assess: **role** (defensive-anchor, creative-hub, goalscorer, shot-stopper, set-piece-taker, ball-winner), **recentImpact** (high/medium/low), and **recentContributionNotes** (factual description: goals in last N games, clean sheets, team results without them)
- Never fabricate — omits fixtures with no confirmed news
- Returns structured JSON array

**The role + recentImpact fields solve the reputation trap**: a historically famous player in poor current form (e.g. a star striker with 2 goals in last 10, team still winning) gets `recentImpact: low` and will receive a small or null adjustment. A less-famous defensive anchor whose team has lost 3 of 4 without them gets `recentImpact: high` and receives a proportionally larger adjustment.

### 7c. What Groq Reasons

Parallel calls — one per fixture that has confirmed news. Receives:
- The confirmed news facts from Gemini (including role and recent impact)
- Current V9 inputs: homeSquadIntegrity, awaySquadIntegrity, homeKeyAbsences, awayKeyAbsences

Reasoning rules enforced by system prompt:
- Adjustments bounded at original ±20, clamped 0–100
- Only add players to keyAbsences if CONFIRMED absent — never invent
- Weight by recentImpact: high = 10–18 pt range, medium = 5–10, low = 0–5 (can return null)
- A goalkeeper in recent poor form who is absent may be neutral or positive for opposition
- A defensive anchor whose absence changes team results warrants larger adjustment than a goal scorer with low recent output

Returns: `{ homeSquadIntegrity, awaySquadIntegrity, homeKeyAbsencesAdd[], awayKeyAbsencesAdd[], contextWarnings[], adjustmentReasoning }`

### 7d. How Adjustments Flow Into V9

```
matchData.homeSquadIntegrity = adj.homeSquadIntegrity  (clamped 0–100)
matchData.homeKeyAbsences.push(...adj.homeKeyAbsencesAdd)
               ↓
analyzeV9(matchData)
    → scoreStarPower(homeSquadIntegrity, awaySquadIntegrity, homeKeyAbsences, awayKeyAbsences)
    → P2 Star Power (7% weight)  ← primary impact point

Stored on matchObj.contextAdjustments for debugging and transparency
```

### 7e. What the LLMs Do NOT Do

- They do not run V9 or modify its math
- They do not generate the analysis output — that is pure V9
- They do not replace data from API-Football — those values always win
- The Groq narrative is generated separately AFTER V9 runs (unchanged from before this pipeline)

---

## 8. LLM Call Inventory (All 6 Call Sites)

| Function | LLM | Purpose | Search? | When |
|----------|-----|---------|---------|------|
| `naturalLanguageToMatchData()` | Groq primary, Gemini fallback | Parse NL query → match params | No | On `/api/search` |
| `calibrateDay()` | Gemini only | Fetch today's schedule when API-Football unavailable | Yes | Calibration step 1 |
| `enrichFixturesWithGemini()` | Gemini primary, Groq fallback | Fill form/xG/H2H/standings per fixture | Yes (Gemini) / No (Groq) | Calibration step 3 |
| `fetchTodayMatchNews()` *(new)* | Gemini only | Confirmed news for all fixtures: injuries, roles, recent impact | Yes | Calibration step 2 |
| `fetchAndReasonContextAdjustments()` *(new)* | Groq (parallel) | Translate news facts into numeric V9 input adjustments | No | Calibration step 2 |
| `generateMatchNarrative()` | Groq primary, deterministic fallback | 2–3 sentence analyst note from V9 output | No | Every analysis (calibration + click) |

---

## 9. Live Analysis — How It Works In Detail

When a match is **live** and a user clicks it, three layers of in-play data augment the V9 analysis:

### Layer 1: Live xG projection (Step 2b — pre-existing)
Applies when `hasLiveXg = true` (actual in-match accumulated xG was available from API-Football).
Projects what the final xG will be if current rate continues. Blend ramps from 0% → 70% across the first ~52 minutes.
Feeds: **P7 Poisson** (the primary goal-count probability driver) and **P8 xG Edge**.

### Layer 2: Live shots & possession blend (Step 2a — added May 31, 2026)
Applies when `matchMinutes ≥ 25` (regardless of whether xG data is available).
Uses actual in-game shots on target and live possession percentage.
- Shots normalised to 90-min rate, then blended with season average (20% → 60% weight across 25–90 min)
- Possession used directly (no blend — it is a real-time 100% signal)
Feeds: **P10 Pace** (scorePace: shots × conversion) and **P11 Home Advantage** (scoreHomeAdvantage: possession dominance).

### Layer 3: Live momentum + next-goal probability (liveAnalyticsService.js)
Computed separately from V9 inputs and displayed as an in-play overlay:
- **Momentum** = (possession × 0.3) + (shots share × 0.4) + (xG share × 0.3) — normalized 0–100%
- **Next-goal probability** = Poisson P(≥1 goal in remaining time): `1 − e^(−λ)` where λ is blended xG rate + shots proxy
- Displayed in `LiveAnalysisPanel.jsx` alongside V9 recommendations

**Nothing in the live path fully overrides V9**. The pre-match calibrated baseline (form, H2H, motivation, squad integrity, historical patterns) remains. Only the performance metrics that have live equivalents (shots, possession, xG rate) are blended in with proportional weight.

---

## 10. API Endpoints (Backend)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Server status + quota state |
| GET | `/api/live` | Current live matches |
| GET | `/api/upcoming` | Upcoming (calibrated) fixtures |
| GET | `/api/leagues` | Available leagues with counts |
| GET | `/api/matchTypes` | Available match types with counts |
| POST | `/api/analyze` | Full V9 analysis (body: matchData incl. homeTeamId, awayTeamId) |
| GET | `/api/analyze/live/:matchId` | Full V9 analysis for a cached live match |
| POST | `/api/calibrate` | Manual re-calibration trigger |
| GET | `/api/calibrate/results` | calibrationStore metadata + running flag |
| GET | `/api/bets/slips` | Auto-generated Tier 1/2/3 bet slips |
| POST | `/api/bets` | Log a manual bet |
| GET | `/api/bets` | Bet history |
| PATCH | `/api/bets/:id` | Update bet result (won/lost) |
| GET | `/api/stats` | P&L, win rate, ROI |
| GET | `/api/alerts` | Alert history from Firestore |
| GET | `/api/search?q=` | NL search → Groq/Gemini → V9 analysis |
| POST | `/api/quota/reset` | Manually clear quota-guard pause |
| GET | `/api/debug/live-raw` | Raw API-Football live fixture debug sample |
| GET | `/api/test-whatsapp` | Test WhatsApp alert |

---

## 11. Environment Variables

### Backend (`backend/.env` and Railway dashboard)

```env
# API-Football
API_FOOTBALL_KEY=<your_key>

# AI
GEMINI_API_KEY=<your_gemini_key>
GROQ_API_KEY=<your_groq_key>

# Twilio WhatsApp
TWILIO_ACCOUNT_SID=<sid>
TWILIO_AUTH_TOKEN=<token>
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
ALERT_PHONE_NUMBER=whatsapp:+2348072187110

# Config
MIN_CONFIDENCE_ALERT=65
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
Production: set `VITE_API_BASE_URL=https://web-production-cccff.up.railway.app/api` in Netlify dashboard.

---

## 12. In-Memory State

The backend holds all match data in RAM. A Railway restart wipes everything and triggers auto-calibration (5s delay) to refill.

```javascript
let liveMatches = [];          // Current live API-Football fixtures
let upcomingMatches = [];      // Today + tomorrow NS fixtures
let alerts = [];               // Last 100 alerts (also in Firestore)
let bets = [];                 // All logged bets (also in Firestore)

let calibrationStore = {
  matches: [],                 // V9-enriched + context-adjusted fixtures
  highConfidence: [],          // Subset ≥65% confidence
  calibratedAt: null,
  totalScanned: 0,
};
```

Each fixture in `calibrationStore.matches`:
```javascript
{
  id, home, away, league, leagueId, leagueCountry,
  homeTeamId, awayTeamId,            // preserved for click-time API calls
  score, status, matchMinutes, kickoffUTC,
  possession, shots, xg,
  confidence,                        // V9 overallScore (0–100)
  opportunities: [],                 // top recommendation labels
  analysis: {                        // full analyzeV9() output
    recommendations: [], parameters: { p1..p15 },
    poisson: {}, chaosVariables: {}, bookieEdges: [],
    overallScore: N,
  },
  calibratedInputs: { /* all 30 V9 input fields */ },  // click-time fallback
  contextAdjustments: { /* Groq adjustment or null */ } // transparency
}
```

---

## 13. AI Provider Configuration

### Gemini (Google)
- **Models**: `gemini-2.5-flash` primary → `gemini-2.5-flash-lite` → `gemini-flash-latest` → `gemini-2.0-flash`
- **Key capability**: Google Search grounding (web access) — used in news fetch, calibration, enrichment
- **Used for**: News fetch (Step 2), calibration schedule discovery, fixture enrichment

### Groq (Meta Llama)
- **Models**: `llama-3.3-70b-versatile` primary → `llama-3.1-8b-instant` → `gemma2-9b-it` → `mixtral-8x7b-32768`
- **Key capability**: Fast structured JSON reasoning, parallel calls, generous free tier (14,400 req/day)
- **Used for**: Context parameter reasoning (Step 2), NL search parsing, match narrative generation
- **Limitation**: No web search access

### Provider priority by use case
| Use case | Primary | Fallback |
|----------|---------|---------|
| News fetch (calibration step 2) | Gemini+Search | None (graceful skip) |
| Context reasoning (step 2) | Groq | None (graceful skip) |
| Fixture schedule (step 1) | API-Football | TheSportsDB → Gemini+Search |
| Fixture enrichment (step 3) | Gemini+Search | Groq (no search) |
| NL search | Groq | Gemini |
| Match narrative | Groq | Deterministic template |

---

## 14. WhatsApp Alerts

- **From**: Twilio sandbox `whatsapp:+14155238886`
- **To**: `whatsapp:+2348072187110`
- **Trigger**: Any `saveAlert()` where `confidence >= MIN_CONFIDENCE_ALERT` (default: 65)
- **Format**: Match name, league, confidence %, recommendation, Nigeria time
- **Deduplication**: 30-minute cooldown per match (prevents calibration + live poll overlap)

---

## 15. Sidebar League Hierarchy

| Tier | Leagues |
|------|---------|
| 1 (International) | World Cup (4), EURO/Copa America (9), Nations League (16), Int Friendlies (1) |
| 2 (UEFA Club) | Champions League (2), Europa League (3), Conference League (848) |
| 3 (Top 5 Europe) | Premier League (39), La Liga (140), Bundesliga (78), Serie A (135), Ligue 1 (61) |
| 4 (Strong Euro + Cups) | Championship, Ligue 2, 2. Bundesliga, Serie B, Eredivisie, Primeira Liga, Super Lig, Russian, Scottish, Belgian, Saudi, Copa Libertadores, Sudamericana |
| 5 (Americas/Asia) | MLS, Brasileirão, Argentine, J-League, K-League, Chinese Super League, Indonesian Liga 1, A-League, AFC CL |

---

## 16. Repository Structure

```
SportyRabbi/
├── backend/
│   ├── src/
│   │   ├── server.js                  ← ALL routes + WebSocket + cron jobs (single file)
│   │   ├── config/firebase.js         ← Firebase Admin SDK init
│   │   └── services/
│   │       ├── agent47Service.js      ← V9 engine: analyzeV9(), Dixon-Coles Poisson (pure math)
│   │       ├── geminiService.js       ← ALL LLM calls: Gemini + Groq pipeline
│   │       ├── liveAnalyticsService.js ← In-play momentum + next-goal probability
│   │       ├── analyticsService.js    ← Team form / H2H / standings (cached 1–6h)
│   │       └── notificationService.js ← Twilio WhatsApp
│   ├── firebase-service-account.json  ← Firestore credentials (DO NOT commit)
│   └── .env
├── frontend/
│   ├── src/
│   │   ├── App.jsx                    ← Root: all state, WebSocket, routing
│   │   ├── components/
│   │   │   ├── MatchFeed.jsx          ← League-grouped match list
│   │   │   ├── Sidebar.jsx            ← League hierarchy filter
│   │   │   ├── DetailPanel.jsx        ← Per-match right panel
│   │   │   ├── AnalyticsModal.jsx     ← Full V9 breakdown popup
│   │   │   ├── BetSlips.jsx           ← Auto-generated tier 1/2/3 bet slips
│   │   │   ├── BetComponents.jsx      ← BetLogger for manual bet tracking
│   │   │   ├── AlertHistory.jsx       ← Alert feed panel
│   │   │   └── LiveAnalysisPanel.jsx  ← In-play momentum panel
│   │   ├── hooks/useMatches.js
│   │   └── services/api.js            ← axios client + WebSocket manager
│   └── .env
└── package.json                       ← Root workspace (npm run dev starts both)
```

---

## 17. Development Commands

```bash
# Root — starts both frontend (5173) and backend (3000)
npm run dev

# Backend only
cd backend && npm run dev

# Frontend only
cd frontend && npm run dev

# Deploy — push to GitHub, auto-deploys both
git add -A && git commit -m "..." && git push
# → Railway auto-deploys backend
# → Netlify auto-deploys frontend
```

---

## 18. Complete Improvement History

### May 30, 2026 — commit `5185d1f` (Round 1–3)
- **V9 engine** deployed: Dixon-Coles Poisson, xG differential, defensive solidity, competitive context, market divergence
- **`sanitizeMatch()` stripping team IDs** fixed — root cause of identical parameters on all matches
- **P8/P9 triple-counting xG** fixed — P8 now directional differential, P9 now defensive solidity
- **P12 market signal backwards** fixed — now Poisson model vs bookmaker implied probability
- **P13 duplicate squad integrity** fixed — now competitive context / league tier premium
- **Analyst note missing** fixed — `generateMatchNarrative()` always fires; deterministic fallback when Groq unavailable
- **Analyst note regex bug** fixed — `'p\d+_'` → `/p\d+_/`
- React performance: useMemo/useCallback/memo applied throughout

### May 31, 2026 — commit `62c6176`
**Two-LLM contextual parameter adjustment pipeline**
- Added `fetchTodayMatchNews()` — Gemini+Search, ONE call per calibration cycle for all fixtures
- Added `fetchAndReasonContextAdjustments()` — parallel Groq calls for fixtures with confirmed news
- Integrated into `runCalibration()`: applied to matchData BEFORE analyzeV9 runs
- `matchObj.contextAdjustments` stored for transparency/debugging
- Graceful degradation: calibration continues normally on any failure

### May 31, 2026 — commit `48c044f`
**Player role/impact-aware absence reasoning + live shots/possession blend**
- **Gemini news prompt enhanced**: now fetches player `role` (defensive-anchor, creative-hub, set-piece-taker, etc.) and `recentImpact` (high/medium/low) + `recentContributionNotes` — not just name and position
- **Groq system prompt enhanced**: explicit impact-calibrated adjustment magnitude (high=10–18pt, medium=5–10pt, low=0–5pt). Instructs Groq to read `recentImpact` before deciding magnitude. Handles edge cases: poor-form GK absent may be neutral; non-scorer role players assessed on role-specific contribution
- **Live shots & possession blend** added to `/api/analyze` (Step 2a): in-match shots rate and possession blend into `homeShotsPerGame`, `awayShotsPerGame`, `homePossession` for live matches ≥25 min, affecting P10 Pace and P11 Home Advantage

---

## 19. Known Issues / Open Items

| # | Issue | Priority |
|---|-------|---------|
| 1 | No historical bet outcome feedback loop — model weights hand-tuned, not backtested | High |
| 2 | Real-time xG from API-Football often null for lower leagues — falls back to LEAGUE_XG_MAP | Medium |
| 3 | No home advantage lambda in Poisson model (lH × 1.12 vs lA × 0.88 is literature standard) | Medium |
| 4 | Calibration uses Gemini knowledge cut-off for lower leagues (Indonesian Liga 1, K-League) | Medium |
| 5 | No odds movement tracking — sharp money signal missing | Medium |
| 6 | BANKROLL not env-configurable — hardcoded (deferred to next session) | Low |
| 7 | No match feed virtualization — 100+ DOM nodes (memoisation applied; windowing not yet) | Low |
| 8 | WhatsApp alert deduplication by match imperfect during calibration + live overlap | Low |

---

## 20. Model Improvement Roadmap

### P1 — High impact
- [ ] V9 backtesting: persist prediction + actual result, compute tier accuracy over rolling 30 days
- [ ] Home advantage lambda in Poisson model (`lH × 1.12`, `lA × 0.88`)
- [ ] Odds movement tracking: flag large line movements as sharp money signal

### P2 — Medium term
- [ ] Expected value (EV) per recommendation: `EV = (modelProb × odds) − 1`
- [ ] BANKROLL env-configurable (currently hardcoded)
- [ ] Fixture congestion signal: games played in last 21 days as fatigue proxy
- [ ] League-specific Poisson lambda home advantage (PL ≠ Serie A)

### P3 — Long term
- [ ] ML calibration layer: gradient-boosted weights fitted from historical outcomes
- [ ] Historical accuracy dashboard: V9 tier accuracy by parameter driver
- [ ] User authentication + per-user bankroll / bet history
- [ ] Mobile app