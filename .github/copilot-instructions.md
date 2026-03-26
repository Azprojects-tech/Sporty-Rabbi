# SportyRabbi Project Instructions

## Project Overview
SportyRabbi is a full-stack sports betting analytics portal that analyzes live football matches and provides intelligent betting recommendations with real-time alerts.

### Tech Stack
- **Frontend**: React 18 + Vite + TailwindCSS
- **Backend**: Node.js + Express + PostgreSQL
- **Real-time Data**: API-Football integration with 30-second polling
- **Notifications**: Twilio (WhatsApp/SMS alerts)
- **Database**: PostgreSQL with scheduled sync jobs

## Project Structure

```
SportyRabbi/
├── frontend/                 # React dashboard
│   ├── src/
│   │   ├── App.jsx          # Main dashboard component
│   │   ├── components/      # UI components (MatchCard, BetLogger, etc.)
│   │   ├── hooks/           # Custom React hooks (useMatches, useBetStats)
│   │   ├── services/        # API client (axios)
│   │   ├── index.css        # Tailwind + custom styles
│   │   └── main.jsx         # React entry point
│   ├── index.html
│   ├── vite.config.js
│   ├── tailwind.config.js
│   └── package.json
│
├── backend/                  # Express API server
│   ├── src/
│   │   ├── index.js         # Server entry point
│   │   ├── config/
│   │   │   └── database.js  # PostgreSQL pool setup
│   │   ├── db/
│   │   │   ├── schema.js    # Database table definitions
│   │   │   └── migrate.js   # Migration runner
│   │   ├── routes/          # Express endpoints
│   │   │   ├── matches.js   # /api/matches/*
│   │   │   ├── analytics.js # /api/analytics/*
│   │   │   └── bets.js      # /api/bets/*
│   │   ├── services/        # Business logic
│   │   │   ├── matchService.js    # API-Football sync & queries
│   │   │   ├── analyticsService.js # Confidence scoring & alerts
│   │   │   └── notificationService.js # Twilio WhatsApp/SMS
│   │   └── jobs/
│   │       └── scheduler.js  # Node-schedule for live polling
│   └── package.json
│
├── package.json             # Root workspace config
├── README.md
├── .gitignore
└── GETTING_STARTED.md       # Setup instructions
```

## Key Features

### 1. Live Dashboard
- Real-time match scores, possession %, shots on target, xG (expected goals)
- Filter by league (EPL, La Liga, Serie A, Bundesliga, Champions League)
- Click any match for detailed analysis

### 2. Analytics Engine
- **Pre-match analysis**: Team form, head-to-head, odds movement
- **In-play detection**: Momentum shifts, goal droughts, possession dominance
- **Confidence scoring**: 0-100% for each recommended bet
- **Value detection**: Identify when odds offer edge over probability

### 3. Intelligent Alerts
- Fires when opportunity confidence > 65%
- Sent via WhatsApp/SMS (Twilio) or on-screen notification
- Shows bet recommendation and reasoning
- Deep link to SportyBet for manual placement

### 4. Bet Tracking
- Log bets manually with match ID, odds, stake, selection
- Track win/loss status and returns
- Dashboard P&L, win rate, ROI by bet type
- Historical analysis to see which bet types work best

### 5. Real-Time Data Sync
- Backend polls API-Football every 30 seconds for live matches
- Updates: score, possession, shots, xG, card status
- Generates alerts automatically when opportunities detected
- No direct API calls from frontend (CORS-safe)

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
   - Add endpoint in `backend/src/routes/*.js`
   - Add logic in `backend/src/services/*.js`
   - Update database schema if needed in `backend/src/db/schema.js`
   - Run migration: `cd backend && npm run migrate`

2. **Frontend** (UI):
   - Create component in `frontend/src/components/`
   - Add API call in `frontend/src/services/api.js`
   - Add React hook if needed in `frontend/src/hooks/`
   - Import and use in `frontend/src/App.jsx` or route

3. **Test**:
   ```bash
   curl http://localhost:3000/api/health  # Check backend
   curl http://localhost:3000/api/matches/live  # Check data
   ```

### Database Changes

1. Update schema in `backend/src/db/schema.js`
2. Run migration: `cd backend && npm run migrate`
3. Verify tables: `psql -d sporty_rabbi -c "\dt"`

### Adding API-Football Data

The sync happens automatically every 30 sec in `backend/src/jobs/scheduler.js`.

To add a new data point:
1. Parse from API response in `backend/src/services/matchService.js` → `syncMatchToDatabase()`
2. Add column to matches table in schema
3. Update TypeScript types if using TS
4. Query it from frontend

## Key API Endpoints

### Matches
- `GET /api/matches/live` - Live matches with current stats
- `GET /api/matches/upcoming` - Matches starting in next 24h
- `GET /api/matches/:id` - Match details + odds + alerts
- `POST /api/matches/sync` - Manual sync (called every 30s automatically)

### Analytics
- `GET /api/analytics/match/:id` - Pre-match confidence score
- `GET /api/analytics/in-play/:id` - Live betting opportunities
- `POST /api/analytics/score` - Score a specific bet selection

### Bets
- `POST /api/bets` - Log a new bet
- `GET /api/bets/history` - Your bet history
- `GET /api/bets/stats` - Win rate, ROI, P&L
- `PATCH /api/bets/:id` - Update bet result (won/lost)

## Configuration

### Environment Variables

**Backend** (`backend/.env`):
```
DATABASE_URL=postgresql://...
API_FOOTBALL_KEY=your_key
TWILIO_ACCOUNT_SID=your_sid
TWILIO_AUTH_TOKEN=your_token
NODE_ENV=development
PORT=3000
```

**Frontend** (`frontend/.env`):
```
VITE_API_BASE_URL=http://localhost:3000/api
```

## Debugging

### Browser DevTools
- Open http://localhost:5173 in Chrome/Firefox
- Check Network tab to see API calls
- Check Console for errors
- React DevTools extension helps

### Backend Logs
- Run with `npm run dev` to see console logs
- Each API call logs execution time
- Scheduled jobs log when they run

### Database Debugging
```bash
psql -d sporty_rabbi
SELECT * FROM matches WHERE status = 'LIVE';
SELECT * FROM alerts ORDER BY sent_at DESC LIMIT 5;
SELECT * FROM bets WHERE status IS NULL;
```

## Performance Considerations

1. **API-Football**: Free tier has rate limits. Monitor in `services/matchService.js`
2. **Database**: Add indexes for frequently queried columns as data grows
3. **Frontend**: Component memoization in React to avoid re-renders
4. **Polling**: Currently 30s intervals - adjust in `backend/src/jobs/scheduler.js`

## Deployment

### Backend (Railway/Render)
1. Push to GitHub
2. Connect repo to Railway
3. Set environment variables
4. Database URL from their PostgreSQL addon
5. Deploy

### Frontend (Vercel)
1. Connect GitHub repo to Vercel
2. Set VITE_API_BASE_URL to production backend URL
3. Deploy

## Production Checklist

- [ ] All env vars set (API keys, database URL, secrets)
- [ ] Database backups enabled
- [ ] Frontend VITE_API_BASE_URL points to prod API
- [ ] CORS_ORIGIN set to frontend domain
- [ ] Rate limiting configured on API
- [ ] Error logging set up (Sentry, etc.)
- [ ] Health checks monitored

## Code Style & Standards

- Use ES6+ syntax (import/export, arrow functions, destructuring)
- Component files: PascalCase (MatchCard.jsx)
- Utility functions: camelCase (formatOdds.js)
- Consistent indentation (2 spaces)
- Comments for complex logic
- PropTypes or TypeScript for type safety

## Troubleshooting Common Issues

| Issue | Solution |
|-------|----------|
| "Cannot GET /api/matches" | Backend not running. Run `cd backend && npm run dev` |
| CORS errors in browser | Check CORS_ORIGIN in backend/.env |
| Database connection error | Verify DATABASE_URL, PostgreSQL running |
| No live matches showing | Check API_FOOTBALL_KEY, monitor sync job in logs |
| Slow performance | Reduce polling frequency, add database indexes |

## Next Development Steps

1. Add league filtering to frontend
2. Implement user authentication (login/password)
3. Add email alerts in addition to WhatsApp
4. Build historical stats visualization
5. Add odds tracking (monitor line movement over time)
6. Mobile app version
7. Machine learning for better confidence scores

## Resources

- [API-Football Docs](https://www.api-football.com/documentation)
- [Express.js Guide](https://expressjs.com)
- [React Hooks](https://react.dev/reference/react)
- [TailwindCSS Docs](https://tailwindcss.com)
- [PostgreSQL Docs](https://www.postgresql.org/docs/)
- [Twilio Node Docs](https://www.twilio.com/docs/libraries/node)

---

**Last Updated**: March 26, 2026
**Project Status**: ✅ Ready for Development
