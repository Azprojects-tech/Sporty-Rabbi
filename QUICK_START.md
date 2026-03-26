# ✅ Your SportyRabbi Checklist

## Phase 1: One-Time Setup (5 minutes)

- [ ] **Get API Key** (free)
  - Go to: https://www.api-football.com
  - Click "Get Free API Key"
  - Copy your key

- [ ] **Put Key in .env**
  - Open: `SportyRabbi → backend → .env`
  - Find: `API_FOOTBALL_KEY=your_api_key_here`
  - Replace with your actual key
  - Save file

✅ **You're done with setup!**

---

## Phase 2: Start the System (Every time you want to use it)

**One command, that's all:**

```
npm run dev
```

Where to run it:
- Open VS Code Terminal (Terminal → New Terminal)
- OR open Command Prompt
- Navigate to: `C:\Users\Admin\SportyRabbi`
- Paste: `npm run dev`
- Press Enter

**What to expect:**
```
╔════════════════════════════════════╗
║    🐰 SportyRabbi Backend         ║
╠════════════════════════════════════╣
║  REST API   → http://localhost:3000 ║
║  WebSocket  → ws://localhost:3000   ║
║  Polling    → every 30s             ║
╚════════════════════════════════════╝
```

✅ If you see this message, you're ready!

---

## Phase 3: Open Your Dashboard

Copy & paste into your browser:
```
http://localhost:5173
```

You should see:
- 🔴 Live Matches (when matches are happening)
- 📈 My Bets (empty at first)
- ⚡ Opportunities (high-confidence betting signals)

✅ **You're running!**

---

## Phase 4: Start Using It

### Logging a Bet

1. Click the **"+ New Bet"** button (right panel)
2. Fill in:
   - Match name (e.g., "Man City vs Liverpool")
   - Bet type (e.g., "Home Win")
   - Odds (e.g., 2.10)
   - Stake (e.g., ₦1000)
3. Click **"✓ Log"**

✅ Your bet is tracked!

### Checking Your Stats

1. Click the **"📈 My Bets"** tab
2. You'll see:
   - Total bets placed
   - Win rate %
   - Wins and losses
   - Your P&L

✅ You're building your track record!

---

## 🛑 To Stop the System

In the Terminal where `npm run dev` is running:
- Press **Ctrl + C** (hold both keys)
- Answer **y** if asked

---

## 🔥 Common Issues & Fixes

### **"Cannot find api-football.com"**
- Go to: https://www.api-football.com (copy-paste in address bar)

### **"localhost refused to connect"**
- Did you run `npm run dev`?
- Is the Terminal still open?
- Do you see the "REST API" message?

### **"API_FOOTBALL_KEY not set" warning**
- You forgot to update the `.env` file
- Go back to Phase 1, Step 2
- Make sure you SAVED the file

### **"No live matches showing"**
- Check what time it is - are there live football matches NOW?
- The system only shows matches that are actively being played
- Try again during a football match

### **Can't see the dashboard**
- Did you copy the exact address: `http://localhost:5173` ?
- Is it in your browser's address bar?
- Check you didn't add any extra spaces

---

## 💡 Pro Tips

- **Keep your Terminal open** - that's the backend running
- **Multiple browsers OK** - you can have it open on phone + laptop
- **Refresh page** if nothing updates (Ctrl + R)
- **Check every 30 seconds** - data updates automatically
- **No database = resets on restart** - logs don't save permanently (yet)

---

## 📊 What Each Tab Does

### 🔴 Live Matches
Shows all football matches currently being played
- Possession %
- Shots taken
- Expected Goals (xG)
- Confidence score (0-100%)

### 📈 My Bets
Your betting history and performance
- Total bets
- Win rate
- Wins vs Losses
- How you're doing

### ⚡ Opportunities
High-confidence betting signals automatically detected
- Only shows bets with 65%+ confidence
- Based on real match stats
- You decide whether to place them

---

## 🎯 Goal

**After setup, you literally just:**
1. Open the dashboard
2. Look for high-confidence opportunities
3. Log your bets
4. Track your performance

**The system does the analysis for you.** ✨

---

## 🆘 Still Stuck?

Check these files in order:
1. **START_HERE.md** - Basic setup
2. **GETTING_STARTED.md** - More detailed
3. **COMPARISON.md** - How it works

Or:
- Look at the dashboard status indicator (top right shows 🟢 Live or 🔴 Offline)
- Check the backend Terminal for error messages
- Make sure API key is in `.env`

---

**You've got this!** 🐰⚡

The system is designed so you literally never have to write code. Just run it, log bets, track wins.
