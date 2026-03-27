# 🐰 SportyRabbi - TECH STACK & DEPLOYMENT GUIDE

---

## 📦 TECHNOLOGY STACK

### **Frontend (React 18 + Vite)**
```
├── React 18.2.0         - UI framework (hooks-based)
├── Vite 5.4             - Build tool (lightning fast)
├── Tailwind CSS 3        - Utility-first styling
├── Axios 1.6            - HTTP client
├── lucide-react         - Icon library
└── WebSocket (ws)       - Real-time connection
```

**Browser Compatibility**: Chrome 90+, Firefox 88+, Safari 14+, Edge 90+

### **Backend (Node.js + Express)**
```
├── Node.js 22.x         - Runtime
├── Express 4.18         - Web framework
├── node-schedule 2.3    - Cron jobs (polling)
├── Axios 1.6            - HTTP client
├── ws 8.x               - WebSocket server
├── dotenv 16            - Environment variables
└── twilio (optional)    - WhatsApp/SMS alerts
```

**Node Version**: 22.22.2 (managed by Railway)

### **External Services**
```
├── API-Football v3      - Live match data (100 calls/day free)
├── Railway              - Backend hosting + PostgreSQL ready
├── Netlify              - Frontend hosting + CDN
├── GitHub               - Source control + CI/CD
└── Twilio (optional)    - Alert system
```

---

## 🚀 DEPLOYMENT ARCHITECTURE

### **Frontend Deployment (Netlify)**

**Build Process**:
```bash
npm run build            # Vite creates /dist folder
                         # Output: optimized HTML/CSS/JS
```

**Deployment Trigger**:
- Automatic on push to `main` branch
- Build: ~2 minutes
- Live: ~30 seconds after build completes

**Configuration**:
```yaml
Build Command: npm run build
Publish Directory: dist
Environment Variables:
  - VITE_API_BASE_URL=https://web-production-cccff.up.railway.app/api

Redirects Rule (_redirects file):
  /api/*  https://web-production-cccff.up.railway.app/api/:splat  200
  /*    /index.html   200
```

**Why `_redirects`?**
- Prevents CORS errors from Railway
- Client requests `/api/foo` 
- Netlify intercepts, forwards to Railway
- Response comes back through Netlify (same origin!)
- Browser accepts response (no CORS block)

### **Backend Deployment (Railway)**

**Build Process**:
```bash
npm install --legacy-peer-deps  # Install deps
node backend/src/server.js      # Start server
```

**Deployment Trigger**:
- Automatic on push to `main` branch
- Procfile detects Node.js project
- Build: ~3 minutes
- Live: ~1 minute after build

**Configuration** (`Procfile`):
```
web: node backend/src/server.js
```

**Environment Variables** (Railway Dashboard):
```
API_FOOTBALL_KEY=e55dfa2e957bf5f4c5f30d899f7212d6
TRACKED_LEAGUES=1,2,3,4,39,78,135,140
LIVE_POLL_INTERVAL=30
PORT=3000
NODE_ENV=production
```

**Node Scaling**:
- Auto-scales CPU/RAM based on demand
- Starts: 0.5 CPU, 512MB RAM
- Max: 2 CPU, 4GB RAM (configurable)
- ~$5/month for standard tier

---

## 📋 DEPLOYMENT CHECKLIST

### **Initial Setup (One-time)**
- [ ] GitHub repo created (Azprojects-tech/Sporty-Rabbi)
- [ ] Railway project linked to GitHub
- [ ] Netlify site linked to GitHub
- [ ] Environment variables set on Railway dashboard
- [ ] Netlify `_redirects` deployed
- [ ] Backend health check confirmed
- [ ] Frontend loads without CORS errors

### **Before Each Deploy**
- [ ] All code committed to git
- [ ] No uncommitted changes: `git status` is clean
- [ ] Tests pass locally (if any)
- [ ] Build succeeds locally: `npm run build`
- [ ] No console errors: `npm run dev`

### **After Deploy**
- [ ] Check frontend:  https://sporty-rabbi.netlify.app
- [ ] Check backend health: https://web-production-cccff.up.railway.app/api/health
- [ ] Test live match endpoint: `/api/live`
- [ ] Test WebSocket connection
- [ ] No errors in Railway logs
- [ ] No errors in Netlify deployment logs

---

## 🔧 LOCAL DEVELOPMENT SETUP

### **Prerequisites**
```bash
Node.js 18+ (verify: node --version)
npm 9+ (verify: npm --version)
Git (verify: git --version)
```

### **Installation**
```bash
# Clone repo
git clone https://github.com/Azprojects-tech/Sporty-Rabbi.git
cd SportyRabbi

# Install root dependencies
npm install

# Install backend
cd backend
npm install --legacy-peer-deps
cd ..

# Install frontend
cd frontend
npm install
cd ..
```

### **Environment Setup**

**Backend** (`backend/.env`):
```env
API_FOOTBALL_KEY=e55dfa2e957bf5f4c5f30d899f7212d6
TRACKED_LEAGUES=1,2,3,4,39,78,135,140
LIVE_POLL_INTERVAL=30
PORT=3000
NODE_ENV=development
```

**Frontend** (`frontend/.env`):
```env
VITE_API_BASE_URL=http://localhost:3000/api
```

### **Running Locally**

**Option 1: Both together**
```bash
npm run dev    # From root (runs both concurrently)
```

**Option 2: Separately in different terminals**
```bash
# Terminal 1 - Backend
cd backend
npm run dev
# Listens on http://localhost:3000

# Terminal 2 - Frontend
cd frontend
npm run dev
# Runs on http://localhost:5173
```

**Access**:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3000/api
- WebSocket: ws://localhost:3000

---

## 📊 PROJECT STRUCTURE

### **Backend (`backend/src/`)**

```
backend/src/
├── server.js                          🔑 MAIN SERVER
│   ├── Express app setup
│   ├── CORS middleware
│   ├── WebSocket server (WSS)
│   ├── All REST endpoints (/api/*)
│   ├── In-memory data store
│   └── Error handlers
│
├── services/
│   ├── analyticsService.js            File: Team form, H2H
│   ├── liveAnalyticsService.js        🔑 Next goal %, momentum, bet value
│   ├── matchService.js                (Future: detailed match queries)
│   └── notificationService.js         (Future: Twilio integration)
│
├── jobs/
│   └── scheduler.js                   Cron job for API polling
│
├── config/
│   └── database.js                    (Reserved for DB connection)
│
├── db/
│   ├── schema.js                      (Future: table definitions)
│   └── migrate.js                     (Future: migration runner)
│
└── index.js                           Entry point
```

### **Frontend (`frontend/src/`)**

```
frontend/src/
├── App.jsx                            🔑 MAIN APP
│   ├── Tab routing (Live/Tracking/Alerts)
│   ├── Match grid
│   ├── Analytics panel (if match selected)
│   └── WebSocket event handlers
│
├── components/
│   ├── MatchComponents.jsx            Match card, confidence score
│   ├── AnalyticsModal.jsx             Team form, H2H modal (pre-match)
│   ├── LiveAnalysisPanel.jsx          🔑 Live analytics (in-play)
│   ├── BetComponents.jsx              Bet logger, stats dashboard
│   └── (other UI components)
│
├── services/
│   └── api.js                         🔑 API CLIENT
│       ├── Axios setup
│       ├── WebSocket handler
│       ├── Event listeners
│       └── Data sync logic
│
├── hooks/
│   └── (Custom React hooks - as needed)
│
├── index.css                          🔑 STYLES
│   ├── Tailwind directives
│   ├── Custom components
│   └── Mobile optimizations
│
├── main.jsx                           React entry point
└── index.html
```

---

## 🔐 CREDENTIALS & SECRETS

### **Stored in Railway Dashboard** (NOT in git)
```
API_FOOTBALL_KEY=e55dfa2e957bf5f4c5f30d899f7212d6
```

### **For Local Development** (in `.env`, gitignored)
```
Same as Railway dashboard
```

### **Never Commit**
- `.env` files
- API keys
- Passwords
- Auth tokens

---

## 🧪 TESTING & VERIFICATION

### **Backend Testing**

```bash
# Health check
curl https://web-production-cccff.up.railway.app/api/health

# Live matches
curl https://web-production-cccff.up.railway.app/api/live

# Live analysis for match ID 1234567
curl https://web-production-cccff.up.railway.app/api/live-analysis/1234567

# Bet value calculation
curl -X POST https://web-production-cccff.up.railway.app/api/bet-value \
  -H "Content-Type: application/json" \
  -d '{"probability":34,"odds":3.50}'
```

### **Frontend Testing**

**Browser DevTools**:
- F12 → Console: Check for errors
- F12 → Network: Monitor API calls
- F12 → Application: Check WebSocket connections

**Manual Testing Checklist**:
- [ ] Dashboard loads
- [ ] "🟢 Live" indicator shows
- [ ] Click match → sidebar opens
- [ ] Analytics panel displays
- [ ] "Log Bet" form submits
- [ ] "My Bets" tab shows logged bets
- [ ] Update bet result works
- [ ] Stats update correctly

---

## 📈 MONITORING & LOGGING

### **Backend Logs** (Railway Dashboard)
- Real-time console output
- Error stack traces
- API response codes
- WebSocket connections/disconnections

### **Frontend Logs** (Browser Console)
- API request/response
- WebSocket events
- React component renders
- Validation errors

### **Metrics to Watch**
- API response time (should be <100ms)
- WebSocket connection stability
- Error rates (should be <1%)
- Number of concurrent connections

---

## 🚨 COMMON DEPLOYMENT ISSUES

### **Issue**: "Cannot GET /api/..." on frontend
**Cause**: Netlify `_redirects` not deployed or malformed  
**Fix**: 
```bash
# Verify _redirects exists in public/
cat frontend/public/_redirects

# Should show:
# /api/*  https://web-production-cccff.up.railway.app/api/:splat  200
# /*    /index.html   200
```

### **Issue**: CORS error in browser console
**Cause**: Direct API call bypassed Netlify proxy  
**Check**: `frontend/src/services/api.js` using relative `/api` paths  
**Fix**: Use `/api/*` not full backend URL

### **Issue**: WebSocket connection fails
**Cause**: Railway backend CORS not configured  
**Fix**: Already fixed in `server.js` aggressive CORS middleware  
**Verify**: Check `server.js` line ~25 for CORS setup

### **Issue**: Build fails on Railway
**Cause**: Node version mismatch or missing peer dependencies  
**Fix**:
```bash
# Local: test with legacy peer deps
npm install --legacy-peer-deps
npm run build
```

### **Issue**: API key exhausted (>100 calls)
**Cause**: Polling too frequently or API-Football quota hit  
**Check**: `LIVE_POLL_INTERVAL` in `.env` (set to 30)  
**Calculate**: 30s interval = 2880 calls/day (under 100 limit? No!)  
**Note**: Free tier may have hourly limits, not daily

---

## 📝 DEPLOYMENT WORKFLOW

### **Typical Workflow**
```bash
# 1. Make changes locally
git status
git add .
git commit -m "Add feature X"

# 2. Push to GitHub
git push origin main

# 3. GitHub → Railway & Netlify auto-trigger builds
# (takes ~3-5 minutes total)

# 4. Verify deployment
# Frontend: open https://sporty-rabbi.netlify.app
# Backend: check https://web-production-cccff.up.railway.app/api/health

# 5. Test features work
# Open browser, DevTools, check console + network tabs
```

### **Rollback (if something breaks)**
```bash
# Revert last commit
git revert HEAD

# Push to trigger re-deploy
git push origin main

# Confirmation: check Railway/Netlify logs for successful re-build
```

---

## 🔄 CONTINUOUS INTEGRATION (CI/CD)

### **What Happens on `git push`**

1. **GitHub Receives Push**
   - Main branch detected
   - Webhooks triggered to Railway & Netlify

2. **Railway Build** (Backend)
   - Clones repo
   - Runs `npm install --legacy-peer-deps`
   - Starts `node src/server.js` per Procfile
   - Port 3000 exposed
   - Environment variables injected
   - Time: ~3 minutes

3. **Netlify Build** (Frontend)
   - Clones repo
   - Runs `npm run build` (Vite output)
   - Deploys `/dist` to CDN
   - Sets environment variables
   - Applies `_redirects` rewrite rules
   - Time: ~2 minutes

4. **Live**
   - Frontend: https://sporty-rabbi.netlify.app (new version)
   - Backend: https://web-production-cccff.up.railway.app (new version)
   - Both accessible immediately

---

## 💰 PRODUCTION COSTS

| Service | Tier | Cost | Notes |
|---------|------|------|-------|
| **Railway** | Starter | $5/mo | Includes 512MB RAM, 0.5CPU, 100GB bandwidth |
| **Netlify** | Free | $0 | Edge caching, build minutes included |
| **GitHub** | Free | $0 | Public repo unlimited |
| **API-Football** | Free | $0 | 100 calls/day (plenty for 30s polling) |
| **Domain** | Netlify default | $0 | `.netlify.app` subdomain |
| **Total** | — | **~$5/mo** | Super affordable! |

---

## 🎯 OPTIMIZATION TIPS

### **Performance**
1. **Frontend Build**: Vite already does code splitting + minification
2. **Backend**: In-memory store is fast (no DB latency)
3. **API Polling**: 30s interval balances freshness vs quota
4. **WebSocket**: Efficient real-time sync (no polling overhead)
5. **Netlify Caching**: CDN caches static assets globally

### **Scalability**
1. **More Users**: Railway auto-scales (add RAM/CPU)
2. **More Matches**: In-memory store should handle 50+ concurrent
3. **Database Future**: PostgreSQL ready on Railway
4. **Load Testing**: Use `ab` or `k6` tools one day

### **Cost Optimization**
1. Currently free tier where possible
2. Railway $5 is minimal (auto-scales down)
3. Can switch to serverless if needed
4. API-Football free tier is sufficient

---

## 📚 USEFUL COMMANDS

### **Development**
```bash
npm run dev                 # Start frontend + backend
cd frontend && npm run dev  # Frontend only
cd backend && npm run dev   # Backend only
```

### **Building**
```bash
npm run build               # Build frontend for production
cd frontend && npm run build
cd backend && npm run build # (Node doesn't need build)
```

### **Deployment**
```bash
git push origin main        # Triggers Railway + Netlify
git log --oneline           # See commit history
git revert HEAD             # Rollback last deploy
```

### **Debugging**
```bash
curl https://web-production-cccff.up.railway.app/api/health
npm run dev                 # Run locally with full logs
tail -f [logfile]           # Watch logs in real-time
```

---

## 🎓 NEXT DEVELOPER CHECKLIST

If you take over this project:

- [ ] Clone repo locally
- [ ] Install Node 18+
- [ ] Run `npm install` in each folder
- [ ] Set up `.env` from Railway dashboard secrets
- [ ] Run `npm run dev` and verify it works
- [ ] Read COMPLETE_DOCUMENTATION.md
- [ ] Check GitHub Actions (if added in future)
- [ ] Review Railway dashboard settings
- [ ] Test all API endpoints locally
- [ ] Make a test commit/push to verify CI/CD works

---

**Good luck maintaining the 🐰! Questions? Check README or troubleshoot in next chat!**
