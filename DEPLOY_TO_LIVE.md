# 🚀 DEPLOY TO LIVE - Complete Step-by-Step Guide

**You're 5 steps away from LIVE! No coding needed, just follow the clicks.**

---

## ✅ What I've Already Done For You

- ✅ Added your API key to production config
- ✅ Created backend deployment files
- ✅ Created frontend deployment files
- ✅ Configured Netlify auto-deploy
- ✅ Configured Railway auto-deploy
- ✅ Set up WebSocket for live updates

**All you need to do now: Push to GitHub and click deploy buttons.**

---

## 🎯 YOUR LIVE URLS WILL BE:

```
Frontend: https://sporty-rabbi.netlify.app
Backend:  https://sporty-rabbi-backend.railway.app
```

---

# 📋 STEP-BY-STEP DEPLOYMENT

## **STEP 1: Create GitHub Repository** (2 minutes)

### 1a. Go to GitHub
Click here: **https://github.com/new**

### 1b. Fill In These Details

| Field | Value |
|-------|-------|
| Repository name | `sporty-rabbi` |
| Description | `Sports betting analytics portal` |
| Public/Private | **Public** (Netlify needs this) |
| Initialize README | Leave unchecked |

### 1c. Click `Create Repository`

You'll see a page with commands. **Don't run anything yet!** Continue to Step 2.

---

## **STEP 2: Push Your Code to GitHub** (2 minutes)

### 2a. Open Command Prompt/Terminal

**Click Start** → type **`cmd`** → press Enter

### 2b. Navigate to Your Project

Copy & paste this:
```
cd C:\Users\Admin\SportyRabbi
```
Press Enter.

### 2c. Initialize Git & Push

**Copy each command below, paste in Command Prompt, press Enter:**

```
git init
```

```
git add .
```

```
git commit -m "SportyRabbi betting portal - ready for deployment"
```

```
git branch -M main
```

Now look at your GitHub page (from Step 1) and find a line that says:
```
git remote add origin https://github.com/YOUR_USERNAME/sporty-rabbi.git
```

**Copy that exact line** and paste it in Command Prompt.

Press Enter.

Finally, paste this:
```
git push -u origin main
```

**Wait 1-2 minutes.** Then go back to your GitHub page and refresh. **You should see all your files there!** ✅

---

## **STEP 3: Deploy Backend to Railway** (3 minutes)

### 3a. Go to Railway

**https://railway.app**

### 3b. Click `Start Project`

Click the big blue **"Start Project"** button.

### 3c. Choose GitHub

You'll see options. Click **"Deploy from GitHub"**

### 3d. Authorize Railway

Railway will ask permission to access your GitHub.
- Click **"Authorize GitHub"**
- It will ask which repos to allow
- Select your **`sporty-rabbi`** repo
- Click **Install & Authorize**

### 3e. Select Your Repo

Back on Railway:
- Find **`sporty-rabbi`** 
- Click it
- Railway will automatically detect Node.js app

### 3f. Add Environment Variables

This is **IMPORTANT**:

1. After deployment starts, click on your project
2. Click the **"Variables"** tab
3. Click **"Add Variable"** 
4. Add these exact pairs:

**Name:** `API_FOOTBALL_KEY`  
**Value:** `e55dfa2e957bf5f4c5f30d899f7212d6`

Click **"Add"**

**Name:** `PORT`  
**Value:** `3000`

Click **"Add"**

**Name:** `NODE_ENV`  
**Value:** `production`

Click **"Add"**

5. Click the blue **"Deploy"** button

**Wait 3-5 minutes for deployment to complete.**

### 3g. Get Your Backend URL

Once deployed:
1. Click on your backend service
2. Look for **"Public Domain"** or **"Service URL"**
3. It will look like: `https://sporty-rabbi-backend.railway.app`

**⭐ COPY THIS URL - You need it for Step 4**

---

## **STEP 4: Update Frontend & Deploy to Netlify** (3 minutes)

### 4a. Update Frontend Environment

Go back to VS Code.

Open: **`frontend/.env.production`**

**Replace the URL** with your Railway URL from Step 3g:

```
VITE_API_BASE_URL=https://YOUR-RAILWAY-URL.railway.app/api
VITE_WS_URL=wss://YOUR-RAILWAY-URL.railway.app
```

(Keep the `/api` part, just replace the domain)

### 4b. Push Updated Code to GitHub

In Command Prompt (same window):

```
git add .
git commit -m "Update production API URLs"
git push
```

Wait 30 seconds.

### 4c. Deploy on Netlify

1. Go to **https://netlify.com**
2. Click **"Add new site"** → **"Import an existing project"**
3. Select **GitHub** 
4. Find & select **`sporty-rabbi`**
5. Netlify will auto-detect:
   - Build command: `npm run build --prefix frontend`
   - Publish directory: `frontend/dist`
6. Click **"Deploy site"**

**Wait 2-3 minutes for build & deployment.**

### 4d. Get Your Frontend URL

Once deployed, you'll see your Netlify URL at the top:

```
https://sporty-rabbi.netlify.app
```

(The actual URL might be different - use what Netlify gives you)

---

## **STEP 5: Test Your Live App** (1 minute)

### 5a. Open Your Dashboard

**Copy this URL into your browser:**
```
https://sporty-rabbi.netlify.app
```

### 5b. Check Status

You should see:
- ✅ The SportyRabbi dashboard loads
- ✅ Top right shows **🟢 Live** (green indicator)
- ✅ After 30 seconds, live matches appear

### 5c. Test a Bet

1. Click **"+ New Bet"**
2. Fill in:
   - Match name: `Test Match`
   - Bet type: `Home Win`
   - Odds: `2.0`
   - Stake: `100`
3. Click **"✓ Log"**
4. Go to **"My Bets"** tab
5. **You should see your bet logged!** ✅

---

## 🎉 YOU'RE LIVE!

**Your SportyRabbi is now running:**

| Component | URL |
|-----------|-----|
| **Frontend** | https://sporty-rabbi.netlify.app |
| **Backend API** | https://sporty-rabbi-backend.railway.app |
| **Status** | 🟢 Live and Synced |

---

## 🔄 Automatic Updates

From now on:

1. Make any changes locally
2. Run `git add . && git commit -m "message" && git push`
3. **GitHub → Netlify/Railway auto-deploy** (2-3 minutes)
4. Your live site updates automatically! ✨

---

## 📊 What's Running Live Right Now

**Backend (Railway):**
- ✅ Polling API-Football every 30 seconds
- ✅ Analyzing live matches
- ✅ Broadcasting via WebSocket
- ✅ Storing your bets

**Frontend (Netlify):**
- ✅ Your React dashboard
- ✅ Real-time WebSocket connection
- ✅ Bet logging
- ✅ Performance tracking

---

## 🛑 Stop Updates

If you want to make changes locally first:

**Before pushing to GitHub:**

1. Test locally: `npm run dev`
2. Make sure it works
3. Then push: `git push`

---

## ⚠️ Troubleshooting

| Problem | Solution |
|---------|----------|
| Netlify says "build error" | Wait 5 min, refresh page. Check if `npm run build` works locally |
| Backend won't start | Check Railway logs - API key might be wrong |
| "Cannot connect to API" | Make sure `VITE_API_BASE_URL` in frontend/.env.production has correct Railway URL |
| Live matches not showing | Wait 30+ seconds for first poll. Check dashboard shows 🟢 Live |
| WebSocket not connecting | Use `wss://` (with s) not `ws://` |

---

## 🎓 What You Have Now

✅ **Everything fully deployed**
✅ **Auto-updating from GitHub**
✅ **Free hosting (Netlify + Railway free tier)**
✅ **HTTPS secure**
✅ **Real-time WebSocket**
✅ **API-Football integration**

---

**🐰 You're officially LIVE! Congratulations!** 🎉

Go to your Netlify URL and start logging bets!
