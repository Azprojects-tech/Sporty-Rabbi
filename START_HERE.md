# 🚀 START HERE - SportyRabbi Setup (5 minutes)

You have **zero coding experience**? Perfect! This is designed for you. Just follow these simple steps:

---

## Step 1: Get Your Free API Key (2 minutes)

1. Go to: **https://www.api-football.com**
2. Click the big blue **"Get Free API Key"** button
3. Sign up (email + password)
4. You'll get your key - it looks like: `abc123def456xyz`

**Copy this key.** You'll need it in Step 2.

---

## Step 2: Put the Key in the Right Place (1 minute)

1. Open the folder: **`SportyRabbi → backend`**
2. Find the file called **`.env`** (it's a hidden file)
3. Open it with Notepad
4. Find this line:
   ```
   API_FOOTBALL_KEY=your_api_key_here
   ```
5. Replace **`your_api_key_here`** with your actual key from Step 1
6. Save the file

**That's it!** Everything else is already set up for you.

---

## Step 3: Start the System (2 minutes)

### Option A: Using VS Code (Easiest)

1. Open VS Code
2. Click **Terminal** → **New Terminal** (from top menu)
3. Copy & paste this command:
   ```
   npm run dev
   ```
4. Press **Enter**
5. Wait for the message that says:
   ```
   REST API → http://localhost:3000/api
   WebSocket → ws://localhost:3000
   ```

### Option B: Using Command Prompt

1. Press **Windows Key + R**
2. Type: `cmd`
3. Press **Enter**
4. Copy & paste:
   ```
   cd C:\Users\Admin\SportyRabbi
   npm run dev
   ```
5. Press **Enter** and wait for the message (same as above)

---

## Step 4: Open the Dashboard

Once you see the "REST API" message, open your browser and go to:

```
http://localhost:5173
```

**You should see the SportyRabbi dashboard!** 🎉

- 🔴 **Live Matches** - shows live football matches
- 📈 **My Bets** - log your bets here
- ⚡ **Opportunities** - shows high-confidence betting signals

---

## 🎯 What Should Happen

✅ You'll see **live football matches** (if any are playing)  
✅ You can **log your bets** in the right panel  
✅ The dashboard will **update in real-time**  
✅ You can track your **win rate and P&L**

---

## ⚠️ Troubleshooting (If Something Goes Wrong)

### **"Cannot find module" error**
- This means npm packages didn't install right
- Solution: Run this in the Terminal:
  ```
  cd C:\Users\Admin\SportyRabbi
  npm install
  ```
- Wait 2-3 minutes, then try `npm run dev` again

### **"localhost refused to connect"**
- The backend isn't running
- Make sure you ran `npm run dev` and see the "REST API" message
- If you don't see it, run the command again

### **Dashboard is blank**
- The backend is running but no matches are live
- This is normal! Check back during a football match
- The system polls every 30 seconds for live matches

### **"API_FOOTBALL_KEY not set" warning**
- You didn't fill in the .env file correctly
- Go back to Step 2 and make sure you:
  - Found the `.env` file in `backend` folder
  - Replaced `your_api_key_here` with your actual key
  - Saved the file

---

## 🛑 To Stop the System

In the Terminal where `npm run dev` is running:
- Press **Ctrl + C** (hold both keys together)
- The system will stop

---

## 💡 Quick Tips

- **Keep the Terminal open** while using the dashboard - that's how the backend stays running
- **No database needed** - everything runs in memory for now
- **Free tier is enough** to test - you get 100 API calls per day
- **WhatsApp alerts optional** - if you want them, set up Twilio (advanced)

---

## ✅ You're Done!

That's literally all you need to do. The system is now:
- ✓ Polling live matches every 30 seconds
- ✓ Analyzing matches for betting opportunities
- ✓ Letting you log and track your bets
- ✓ Calculating your win rate and P&L

**Go log some bets and start tracking your performance!** 🐰⚡

---

**Questions?** Check the live dashboard - it has status indicators showing everything is working.
