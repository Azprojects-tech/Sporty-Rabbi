# SportyRabbi Project Instructions

## Project Overview
SportyRabbi is a full-stack sports betting analytics portal that analyzes live football matches using a 15-parameter AI scoring engine (Agent 47 V9) and delivers intelligent betting recommendations with real-time WhatsApp alerts.

### Tech Stack
- **Frontend**: React 18 + Vite + TailwindCSS
- **Backend**: Node.js ESM + Express 4 (all in a single `server.js`)
- **Real-time**: WebSocket (`ws`) + `node-cron` polling every 30 s
- **Database**: Firebase Firestore (alerts, bets — no PostgreSQL)
- **Data Source**: API-Football v3
- **AI**: Groq `llama-3.3-70b-versatile` (narrative) + Gemini 2.5 Flash with Search (calibration/enrichment)
- **Notifications**: Twilio WhatsApp sandbox

## Project Structure

```
SportyRabbi/
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/      # MatchFeed, DetailPanel, BetSlips, AlertHistory, …
│   │   ├── hooks/           # useMatches.js (WebSocket + REST state)
│   │   ├── services/        # api.js (axios)
│   │   ├── index.css
│   │   └── main.jsx
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── server.js              ← ALL routes + WebSocket + cron jobs (single file)
│   │   ├── config/firebase.js     ← Firebase Admin SDK init
│   │   └── services/
│   │       ├── agent47Service.js  ← V9 engine: analyzeV9(), Dixon-Coles Poisson
│   │       ├── geminiService.js   ← Gemini/Groq bridge, calibration, narrative
│   │       ├── analyticsService.js← Team form / H2H / standings (cached 1–6 h)
│   │       ├── liveAnalyticsService.js ← In-play next-goal + momentum
│   │       └── notificationService.js  ← Twilio WhatsApp
│   ├── firebase-service-account.json  ← DO NOT commit — add to Railway secrets
│   └── package.json
│
├── package.json             # Root workspace (npm run dev runs both)
├── README.md
└── SYSTEM_DOCUMENTATION.md # Full technical reference
```

## Agent 47 V9 Engine

Entry point: `export function analyzeV9(matchData)` in `backend/src/services/agent47Service.js`

15 parameters with weights summing to 100%:
- P1 Motivation (13%), P2 Star Power (7%), P3 H2H (3%)
- **P4 Form L10 (15%)** — highest weight
- P5 Scoring Timing (5%), P6 Defensive Gap (7%)
- **P7 Poisson (11%)** — Dixon-Coles ρ = −0.1 corrected
- P8 xG Edge (6%) — directional differential, P9 Def. Solidity (5%) — vs league avg
- P10 Pace (4%), P11 Home Adv. (3%)
- P12 Mkt. Diverge. (4%) — Poisson vs bookmaker implied probability
- P13 Comp. Context (5%) — league tier premium
- P14 Lifecycle (2%), **P15 Crisis (10%)**

## Development Workflow

### Starting Development
```bash
# From root (SportyRabbi/)
npm run dev              # Runs both frontend & backend concurrently

# Or separately:
cd backend && npm run dev    # Backend on :3000
cd frontend && npm run dev   # Frontend on :5173
```

### Adding a New Feature

1. **Backend** (if needs data):
   - Add route/logic in `backend/src/server.js`
   - Add service function in the relevant `backend/src/services/*.js` file
   - Firestore reads/writes go through `config/firebase.js`

2. **Frontend** (UI):
   - Create component in `frontend/src/components/`
   - Add API call in `frontend/src/services/api.js`
   - Add React hook if needed in `frontend/src/hooks/`
   - Import and use in `frontend/src/App.jsx`

3. **Test**:
   ```bash
   curl http://localhost:3000/api/health        # Check backend
   curl http://localhost:3000/api/live          # Check data
   ```

## Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/live` | Live matches only |
| GET | `/api/upcoming` | Upcoming (calibrated) fixtures |
| POST | `/api/analyze` | Run V9 analysis (body: matchData incl. homeTeamId, awayTeamId) |
| POST | `/api/calibrate` | Trigger manual calibration |
| GET | `/api/alerts` | Recent alerts from Firestore |
| POST | `/api/bets` | Log a bet |
| GET | `/api/bets` | Bet history |
| PATCH | `/api/bets/:id` | Update bet result |
| GET | `/api/stats` | P&L, win rate, ROI |
| GET | `/api/search?q=...` | NL match search |

## Configuration

### Environment Variables

**Backend** (`backend/.env`):
```
API_FOOTBALL_KEY=your_key
GOOGLE_AI_API_KEY=your_gemini_key
GROQ_API_KEY=your_groq_key
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
TWILIO_WHATSAPP_TO=whatsapp:+1234567890
NODE_ENV=development
PORT=3000
```

**Frontend** (`frontend/.env`):
```
VITE_API_BASE_URL=http://localhost:3000/api
```

Firebase credentials come from `backend/firebase-service-account.json` (not committed).

## Deployment

Both auto-deploy on `git push origin main`:
- **Backend** → Railway (`node src/server.js`)
- **Frontend** → Netlify (`npm run build` → `dist/`)

## Debugging

### Browser DevTools
- Open http://localhost:5173
- Check Network tab for API calls and WebSocket frames
- Check Console for errors

### Backend Logs
- `npm run dev` streams all console output
- Calibration, polling, and alert events are logged with timestamps

### Firestore
```javascript
// Check alerts
firebase.firestore().collection('alerts').orderBy('sentAt', 'desc').limit(5)
// Check bets
firebase.firestore().collection('bets').get()
```

## Performance Considerations

1. **API-Football**: Pro plan — monitor quota in `analyticsService.js` (1 h / 6 h caches)
2. **Calibration**: Runs every 6 h; manual trigger via POST `/api/calibrate`
3. **Frontend**: useMemo/useCallback/React.memo applied throughout
4. **Polling**: 30 s live match sync — adjust in `server.js` cron schedule

## Troubleshooting Common Issues

| Issue | Solution |
|-------|----------|
| All matches show identical parameters | `homeTeamId`/`awayTeamId` missing in request — check `sanitizeMatch()` output |
| No analyst note on match | Groq/Gemini keys missing in `.env` or quota exhausted |
| No live matches showing | Check `API_FOOTBALL_KEY` validity; quota guard may be active |
| CORS errors in browser | Check `CORS_ORIGIN` in `server.js` or Railway env |
| Firebase errors | Verify `firebase-service-account.json` path and project ID |

---

**Last Updated**: May 30, 2026 — commit `5185d1f`  
**Engine**: Agent 47 V9 | **Deploy**: Railway (backend) + Netlify (frontend)  
**Live URL**: https://sporty-rabbi.netlify.app


