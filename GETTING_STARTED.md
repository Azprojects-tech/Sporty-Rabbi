# 🚀 Getting Started with SportyRabbi

Your sports betting analytics portal is ready! Here's how to get it running:

## Step 1: Set Up Environment Variables

### Backend (.env file)
```bash
cd backend
copy .env.example .env
```

Then edit `.env` with real secrets.

Edit `backend/.env` and fill in:
- **API_FOOTBALL_KEY**: Get free at [api-football.com](https://www.api-football.com)
- **TWILIO_ACCOUNT_SID**: Get from [twilio.com](https://www.twilio.com) (optional, for WhatsApp)
- **TWILIO_AUTH_TOKEN**: From Twilio dashboard
- **TWILIO_WHATSAPP_FROM**: Pre-assigned Twilio WhatsApp sender
- **ALERT_PHONE_NUMBER**: Your recipient WhatsApp number
- **GEMINI_API_KEY / GROQ_API_KEY**: AI narrative + enrichment providers
- **Firebase service account JSON**: required at `backend/firebase-service-account.json` (or equivalent secret mount in production)

### Frontend (.env file)
```bash
cd frontend
copy .env.example .env
```

## Step 2: Persistence Setup (Firestore)

This project uses Firebase Firestore (no PostgreSQL and no migration step).

1. Ensure `backend/firebase-service-account.json` is present locally.
2. Confirm `FIREBASE_PROJECT_ID` in `backend/.env` matches that service account.
3. In cloud deploys (Railway), mount credentials as secrets instead of committing files.

## Step 3: Start Development Servers

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

## Step 4: Access the Portal

Open your browser and go to:
```
http://localhost:5173
```

You should see the SportyRabbi dashboard with:
- 🔴 Live Matches section
- 📊 Analytics & confidence scores
- 💡 Betting alerts
- 📈 Bet tracker & P&L stats

## Instant Deploy Command

From project root, run:

```bash
npm run deploy
```

What it does automatically:
- Stages all local changes
- Creates a commit with a timestamp message
- Pushes the current branch to GitHub origin

Optional custom commit message:

```bash
npm run deploy:msg -- "deploy: your message"
```

After push, linked Railway and Netlify auto-deploy pipelines will run as usual.

## API Endpoints Available

Once backend is running, test these endpoints:

```bash
# Health check
curl http://localhost:3000/api/health

# Get live matches
curl http://localhost:3000/api/live

# Get bet stats
curl http://localhost:3000/api/stats
```

## First Time Setup Checklist

- [ ] Firebase service account available to backend runtime
- [ ] Backend .env file filled with API_FOOTBALL_KEY
- [ ] Backend server running on port 3000
- [ ] Frontend server running on port 5173
- [ ] Dashboard loads without errors

## Troubleshooting

### Firestore connection fails
- Verify `backend/firebase-service-account.json` exists and is valid
- Verify `FIREBASE_PROJECT_ID` matches your Firebase project

### Frontend won't load
- Ensure backend is running on port 3000
- Check browser console for CORS errors

## That's it! 🎉

Your portal is ready. **Remember: Bet responsibly!**
