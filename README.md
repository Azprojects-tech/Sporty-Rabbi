# SportyRabbi - Sports Betting Analytics Portal

A real-time sports betting analytics platform that analyzes football matches and provides intelligent betting recommendations with live alerts.

## Features

✅ **Live Match Dashboard** - Real-time score updates, possession, shots on target, xG analysis  
✅ **Pre-Match Analytics** - Team form, head-to-head stats, odds analysis with confidence scoring  
✅ **In-Play Alerts** - Smart triggers for value betting opportunities during live matches  
✅ **Bet Tracking** - Log bets manually, track P&L, win rates, ROI by bet type  
✅ **Multi-Channel Alerts** - On-screen notifications, WhatsApp messages, SMS alerts (via Twilio)  
✅ **TopLeagues** - English Premier League, La Liga, Serie A, Bundesliga, Champions League, Europa League  

## Tech Stack

**Frontend:** React + Vite + TailwindCSS  
**Backend:** Node.js + Express + PostgreSQL  
**Integrations:** API-Football (live data), Twilio (WhatsApp/SMS), SportyBet (deep links)  
**Database:** PostgreSQL with real-time analytics views  

## Project Structure

```
sporty-rabbi/
├── frontend/          # React dashboard UI
│   ├── src/
│   │   ├── components/    # Reusable UI components
│   │   ├── pages/         # Main pages
│   │   ├── hooks/         # Custom React hooks
│   │   ├── services/      # API client services
│   │   └── styles/        # TailwindCSS styles
│   └── package.json
├── backend/           # Node.js/Express API
│   ├── src/
│   │   ├── routes/        # API endpoints
│   │   ├── models/        # Database models
│   │   ├── services/      # Business logic
│   │   ├── middleware/    # Express middleware
│   │   ├── config/        # Configuration
│   │   └── jobs/          # Scheduled tasks (live polling)
│   └── package.json
├── .github/
│   └── copilot-instructions.md
├── package.json       # Root workspace config
└── README.md
```

## Getting Started

### Prerequisites
- Node.js 18+ and npm
- PostgreSQL (local or cloud)
- API-Football API key (get free tier at [API-Football](https://www.api-football.com))
- Twilio account (optional, for WhatsApp alerts)

### Installation

```bash
# Clone and navigate to project
cd sporty-rabbi

# Install all dependencies
npm run install-all

# Set up environment variables
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# Create database
psql -U postgres -c "CREATE DATABASE sporty_rabbi;"

# Run migrations
npm run migrate --prefix backend
```

### Development

```bash
# Start both frontend and backend in dev mode
npm run dev

# Frontend runs on: http://localhost:5173
# Backend API runs on: http://localhost:3000
```

### Build for Production

```bash
npm run build
npm start
```

## API Endpoints

### Matches
- `GET /api/matches/live` - Get all live matches
- `GET /api/matches/:id` - Get match details with stats
- `GET /api/matches/league/:leagueId` - Get matches by league

### Analytics
- `GET /api/analytics/match/:id` - Pre-match analysis
- `GET /api/analytics/in-play/:id` - In-play opportunity detection
- `POST /api/analytics/score` - Calculate confidence scores

### Bets
- `POST /api/bets` - Log a bet
- `GET /api/bets/history` - Get bet history
- `GET /api/bets/stats` - Get P&L and performance stats

### Alerts
- `GET /api/alerts` - Get recent alerts
- `POST /api/alerts/subscribe` - Subscribe to WhatsApp/SMS alerts

## Environment Variables

Create `.env` files in both `frontend/` and `backend/`:

**backend/.env:**
```
DATABASE_URL=postgresql://user:password@localhost/sporty_rabbi
API_FOOTBALL_KEY=your_api_football_key
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
NODE_ENV=development
PORT=3000
```

**frontend/.env:**
```
VITE_API_BASE_URL=http://localhost:3000/api
VITE_APP_ENV=development
```

## Supported Leagues

- Premier League (EPL)
- La Liga
- Serie A (Calcio)
- Bundesliga
- UEFA Champions League
- UEFA Europa League

## How It Works

1. **Live Data Pull** - Every 15-30 seconds, fetch live match data from API-Football
2. **Real-Time Analysis** - Calculate stats, momentum shifts, value opportunities
3. **Alert Generation** - Trigger notifications when confidence threshold exceeded
4. **User Action** - Portal recommends actions; user places bet manually on SportyBet
5. **Tracking** - Log bet details manually; system tracks performance over time

## Disclaimer

⚠️ **No betting system guarantees wins.** This platform provides analysis and recommendations only. You bear all financial risk. Betting involves risk of loss. Please bet responsibly.

## License

Private / Proprietary

## Next Steps

- Deploy backend to Railway/Render
- Deploy frontend to Vercel
- Configure Twilio for WhatsApp notifications
- Set up database backups
- Add email alerts
- Expand to more leagues
