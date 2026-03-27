# 🐰 SportyRabbi - QUICK REFERENCE

**STATUS**: 🟢 FULLY LIVE & READY  
**Next Test**: 7:25pm matches start (England vs Uruguay, etc.)

---

## 🔗 QUICK LINKS

| Item | Link |
|------|------|
| **Dashboard** | https://sporty-rabbi.netlify.app |
| **API Health** | https://web-production-cccff.up.railway.app/api/health |
| **GitHub** | https://github.com/Azprojects-tech/Sporty-Rabbi |
| **Detailed Docs** | See `COMPLETE_DOCUMENTATION.md` |

---

## 🎯 WHAT IT DOES

**Live sports betting analytics for real-time decision making:**

1. **Live Dashboard**: Shows football matches with score, possession, shots, xG
2. **Next Goal Predictor**: % chance each team scores next (updated every 10s)
3. **Momentum Meter**: Which team is currently dominating (0-100%)
4. **Goal Pace Tracker**: Projects final goals, alerts Over/Under likelihood
5. **Odds Value Checker**: You paste SportyBet odds → get ✅ VALUE or ❌ NO VALUE
6. **Bet Tracker**: Log bets, update results, see win rate stats

---

## 🏗️ ARCHITECTURE

```
Browser (Desktop/Mobile)
    ↓ (HTTPS REST + Secure WebSocket)
Netlify Frontend (https://sporty-rabbi.netlify.app)
    ↓ (/api/* proxy via _redirects)
Railway Backend (https://web-production-cccff.up.railway.app)
    ↓ (HTTP request every 30 seconds)
API-Football (v3.football.api-sports.io)
    ↓ (Live match data)
Returns: score, possession, shots, xG
```

---

## 📁 KEY FILES

| File | Purpose |
|------|---------|
| `backend/src/server.js` | Main backend server + all REST endpoints |
| `backend/src/services/liveAnalyticsService.js` | Next goal %, momentum, bet value math |
| `frontend/src/App.jsx` | Main frontend UI (tabs + layout) |
| `frontend/src/components/LiveAnalysisPanel.jsx` | In-play analytics panel (during match) |
| `frontend/public/_redirects` | **Netlify CORS proxy fix** |
| `backend/.env.production` | API key + league IDs |

---

## 🔑 API ENDPOINTS (Most Used)

```bash
# Live match analysis
GET /api/live-analysis/:matchId
→ Returns: nextGoal %, momentum, goal pace, alerts

# Check if bet offers value
POST /api/bet-value
Body: {probability: 34, odds: 3.50}
→ Returns: expectedValue %, recommendation

# Bet management
GET /api/bets                    # Get all bets
POST /api/bets                   # Log new bet
PATCH /api/bets/:id              # Update result (won/lost)
GET /api/stats                   # Your stats (win rate, etc)

# Pre-match analytics
GET /api/team-form/:teamId       # Last 10 matches
GET /api/h2h/:teamA/:teamB       # Head-to-head history
```

---

## ⚙️ CONFIG

**Production Environment (Railway)**
- `API_FOOTBALL_KEY`: e55dfa2e957bf5f4c5f30d899f7212d6 ✓
- `TRACKED_LEAGUES`: 1,2,3,4,39,78,135,140 (EPL, La Liga, Bundesliga, etc.)
- `LIVE_POLL_INTERVAL`: 30 seconds
- `PORT`: 3000

**Frontend Config (Netlify)**
- API Base: `/api` (proxies to Railway via `_redirects`)
- WebSocket: `wss://web-production-cccff.up.railway.app`

---

## 🎮 HOW TO USE (7:25pm)

1. Open https://sporty-rabbi.netlify.app
2. Wait for "🟢 Live" indicator
3. See live matches appear with score + stats
4. **Click match card** → analytics panel opens (right side)
5. Watch **4 panels update live**:
   - 🎯 **Next Goal**: Which team more likely to score next
   - ⚙️ **Momentum**: Who's currently dominating
   - ⏱️ **Goal Pace**: Over/Under projections
   - 🚨 **Alerts**: High-probability opportunities

6. **Check Bet Value**:
   - Click "💰 Check Bet Value" button
   - Select bet type (Next Goal, Over/Under)
   - Open SportyBet in separate window
   - Copy decimal odds (e.g., 3.50)
   - Paste into SportyRabbi
   - Click "Check"
   - See: ✅ **VALUE FOUND** (place bet) or ❌ **No value** (skip)

7. **Log Bet**:
   - "Log Bet" button on sidebar
   - Fill match, odds, stake
   - Submit (appears in "My Bets" immediately)

8. **After Match**:
   - Update bet: "My Bets" tab
   - Mark Won/Lost
   - Stats update automatically

---

## 🧪 PRE-MATCH CHECKLIST (Before 7:25pm)

- [ ] Dashboard loads at https://sporty-rabbi.netlify.app
- [ ] "🟢 Live" indicator shows (green)
- [ ] No console errors (F12 → Console tab)
- [ ] Click upcoming match → Stats modal opens
- [ ] "Log Bet" button exists and clickable
- [ ] Mobile view works (rotate to landscape on phone)

---

## 🚀 IF SOMETHING BREAKS

**Check Backend**: https://web-production-cccff.up.railway.app/api/health
- Should see: `{"status":"✓ Online","timestamp":"..."}`
- If error: Backend needs restart (check Railway logs)

**Check Frontend Console** (F12 → Console):
- Any red errors = API call issue
- Usually resolves after 2 seconds

**Force Refresh**: Ctrl+Shift+R (Windows) or Cmd+Shift+R (Mac)

**Restart Everything**:
```bash
git pull origin main
cd backend && npm install && cd ../frontend && npm install
```

---

## 📊 WHAT YOU'LL SEE AT 7:25pm

**Live Match Example: England vs Uruguay**

```
┌─────────────────────────────┐
│  🔴 LIVE                    │
│ England ⚽ Uruguay          │
│    2      -      1          │
├─────────────────────────────┤
│ Possession: 58% | 42%       │
│ Shots: 8 vs 4 | xG: 1.4-0.9 │
├─────────────────────────────┤
│ Confidence: █████████░ 87%  │
└─────────────────────────────┘
```

**Then click the match:**

```
📊 Live Analysis Panel (Right Sidebar)

🎯 Next Goal Probability
   England 38% | Uruguay 24%

⚙️ Momentum Meter
   England 65% | Uruguay 35%
   Possession: 58% vs 42%
   Danger: MEDIUM | LOW

⏱️ Goal Pace
   Current: 0.30 goals/min
   Projected: 2.7 total (OVER 2.5!)

💰 Check Bet Value [Click Here]
```

**Then you input odds:**

```
Select: "England Next Goal (38%)"
Enter Odds: 3.50
Result:
✅ VALUE FOUND!
Expected: +2.3%
Fair Odds: 2.63
Your Odds: 3.50 ← Better!
→ PLACE BET ON SPORTYBET
```

---

## 💡 KEY INSIGHTS

- **Next Goal %**: Based on shots + xG, 10s updates are slow (match changes fast)
- **Momentum**: 0-65% = avoid, 65%+ = watch closely
- **Value Alerts**: Most odds show ❌ (market efficient), but watch for ✅
- **Over/Under**: Great metric - goal pace is predictive
- **Win Rate**: Track after 10+ bets (sample size matters)

---

## 🎯 TODAY'S MATCHES (March 27, 2026)

| Time | Match | League |
|------|-------|--------|
| 19:45 (5:45pm) | England vs Uruguay | Friendlies |
| 19:45 (5:45pm) | Netherlands vs Norway | Friendlies |
| 19:45 (5:45pm) | Switzerland vs Germany | Friendlies |
| 20:00 (6:00pm) | Spain vs Serbia | Friendlies |
| 23:15 (9:15pm) | Argentina vs Mauritania | Friendlies |

You return at 6pm, first 4 matches live at 7:25pm! 🚀

---

## 📞 FRESH CHAT? SAY THIS:

> *"I'm using SportyRabbi - a sports betting analytics portal. Read the COMPLETE_DOCUMENTATION.md file in the repo for full context. For quick ref, also see QUICK_REFERENCE.md."*

Then AI will have everything needed to help! ✨

---

**Good luck at 7:25pm! May the odds be ever in your favor!** 🐰⚽💰
