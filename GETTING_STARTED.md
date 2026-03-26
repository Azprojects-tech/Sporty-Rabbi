# 🚀 Getting Started with SportyRabbi

Your sports betting analytics portal is ready! Here's how to get it running:

## Step 1: Set Up Environment Variables

### Backend (.env file)
```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` and fill in:
- **DATABASE_URL**: PostgreSQL connection string (local or cloud)
  - Example: `postgresql://postgres:password@localhost:5432/sporty_rabbi`
- **API_FOOTBALL_KEY**: Get free at [api-football.com](https://www.api-football.com)
- **TWILIO_ACCOUNT_SID**: Get from [twilio.com](https://www.twilio.com) (optional, for WhatsApp)
- **TWILIO_AUTH_TOKEN**: From Twilio dashboard
- **TWILIO_WHATSAPP_NUMBER**: Pre-assigned Twilio WhatsApp number
- **JWT_SECRET**: Any random string for auth (e.g., `your-super-secret-key`)

### Frontend (.env file)
```bash
cd frontend
cp .env.example .env
```

The frontend `.env` defaults are fine for local development.

## Step 2: Database Setup

### If using PostgreSQL locally:

```bash
# Create database
createdb sporty_rabbi

# Or using psql:
psql -U postgres -c "CREATE DATABASE sporty_rabbi;"
```

### If using a cloud database (e.g., Railway, Heroku):
Just set the `DATABASE_URL` in backend/.env to your cloud database connection string.

## Step 3: Initialize Database Schema

```bash
cd backend
npm run migrate
```

This creates all tables:
- `matches` - Live/upcoming football matches
- `odds` - Betting odds
- `bets` - Your logged bets
- `alerts` - Generated betting alerts
- `teams` - Football teams
- `leagues` - Football leagues

## Step 4: Start Development Servers

### Option A: Run both together (from root)
```bash
npm run dev
```

This starts:
- **Frontend**: http://localhost:5173 (React dashboard)
- **Backend**: http://localhost:3000/api (Express API)

### Option B: Run separately (in two terminals)

Terminal 1 - Backend:
```bash
cd backend
npm run dev
```

Terminal 2 - Frontend:
```bash
cd frontend
npm run dev
```

## Step 5: Access the Portal

Open your browser and go to:
```
http://localhost:5173
```

You should see the SportyRabbi dashboard with:
- 🔴 Live Matches section
- 📊 Analytics & confidence scores
- 💡 Betting alerts
- 📈 Bet tracker & P&L stats

## API Endpoints Available

Once backend is running, test these endpoints:

```bash
# Health check
curl http://localhost:3000/api/health

# Get live matches
curl http://localhost:3000/api/matches/live

# Get bet stats
curl http://localhost:3000/api/bets/stats
```

## First Time Setup Checklist

- [ ] PostgreSQL installed and running (or cloud DB configured)
- [ ] Backend .env file filled with API_FOOTBALL_KEY
- [ ] Database created and migrated
- [ ] Backend server running on port 3000
- [ ] Frontend server running on port 5173
- [ ] Dashboard loads without errors

## Troubleshooting

### Database connection fails
- Check PostgreSQL is running: `psql -U postgres`
- Verify DATABASE_URL format in .env

### Frontend won't load
- Ensure backend is running on port 3000
- Check browser console for CORS errors

## That's it! 🎉

Your portal is ready. **Remember: Bet responsibly!**
