# SportyRabbi Project Handover

Last updated: 2026-06-06
Head commit: 4eccf62

## 1) Current Snapshot

SportyRabbi is running with:
- Frontend: Netlify (https://sporty-rabbit.netlify.app)
- Backend: Railway (auto deploy from main)
- Repo: https://github.com/Azprojects-tech/Sporty-Rabbi
- Branch: main

Recent shipped commits:
- 4eccf62: Fix standings source status fallback labeling
- 328e880: Fix phased live analysis, source transparency, and panel reliability
- 90a5bcb: Reduce placeholder live stats and enrich recent opposition summaries
- 317f034: Fix backend startup syntax and analyzeMatch key absences scope
- 5af9b64: Add EV sanity checks and post-match calibration hook

## 2) What Is Implemented (Confirmed)

### A) No placeholders policy
- Unknown values now show Unavailable instead of fake defaults.
- Backend no longer forces fake 50/50 possession and 0/0 shots/xG in key live shaping paths.

### B) League ranking visibility
- Ranking and points are propagated to analysis output and shown in analyst narrative context.
- Right panel Data Snapshot includes table context per team.

### C) Phased live analysis (requested behavior)
Implemented in server blending paths:
- Early live: baseline-heavy
- Mid live: blended baseline + live
- Late live: live-dominant/live-only where live values exist

### D) Chaos/Edges panel reliability
- Fixed chaos binding mismatch (analysis returns chaosVariables; panel reads that correctly now).
- Added explicit empty states where data is unavailable.
- Tab switch now resets scroll to avoid stuck/cutoff panel behavior.

### E) Data-source transparency
Right panel now shows Data Sources row:
- Standings status/source
- Live feed status/source
- Direct fixture-stats pull status/source

## 3) Production Smoke Test Notes

Verified on Netlify after deploy:
- Analyst note includes ranking context when available.
- Data Sources row appears in Data Snapshot.
- Chaos tab shows content correctly.
- Edges tab shows explicit empty-state when no edges.

Important caveat:
- Live in-play direct-stats behavior is deployed, but final verification still depends on having active live fixtures in covered competitions at test time.

## 4) Why Some Live Fields Still Show Unavailable

This is now intentional and source-driven, not placeholder-driven.
Main causes:
1. API-Football live fixture feed omits some granular stats for certain fixtures/competitions.
2. Direct fixture statistics endpoint can also return missing stats for some matches.
3. Quota/rate/subscription constraints can prevent live stat enrichment.

The new Data Sources row explains which source succeeded or failed per analysis response.

## 5) Key Files To Start From

Backend:
- backend/src/server.js
  - live shaping, phase blending, /api/analyze, direct fixture stats pull
- backend/src/services/agent47Service.js
  - V9 engine, recommendations, win call logic, output payload
- backend/src/services/geminiService.js
  - narrative generation with ranking context and phase instruction

Frontend:
- frontend/src/components/DetailPanel.jsx
  - right panel UI, Data Snapshot, Data Sources row, Chaos/Edges tabs
- frontend/src/components/MatchFeed.jsx
- frontend/src/components/MatchComponents.jsx
- frontend/src/components/AnalyticsModal.jsx

## 6) Open Risks / Follow-ups

1. Live fixture specific verification
- Run targeted production checks during active live windows to confirm:
  - Live feed status transitions
  - Direct stats pull status transitions
  - Late-phase live-dominant behavior in real in-play events

2. Add debug endpoint (optional)
- A small backend endpoint exposing source-status counters for the last N analyses would speed operations debugging.

3. Ranking fallback clarity
- When standings come from calibrated fallback (not API standings), it is currently labeled fallback/calibrated-inputs.
- Keep this behavior; do not regress to silently marking unavailable.

## 7) Commands For Fast Re-entry

From repository root:

- Install and run:
  - npm run install-all
  - npm run dev

- Validate build:
  - npm run build

- Quick repo state:
  - git status --short
  - git log --oneline -n 10

## 8) New Chat Starter (Copy/Paste)

Use this in a new chat to continue quickly:

"Read PROJECT_HANDOVER.md and continue from head commit 4eccf62.
Prioritize production validation on live fixtures for Data Sources row transitions (standings/live feed/direct pull), phase-behavior checks (early/mid/late), and win-call behavior under strong live WINS_ONLY recommendations.
If mismatch is found, patch backend/server.js and frontend/DetailPanel.jsx first, then rebuild and summarize with file-level diffs."

## 9) Ownership Notes

- Main branch is deploy branch.
- Railway and Netlify auto-deploy from push to main.
- Keep all user-visible missing fields as Unavailable (do not reintroduce placeholders).
