# Session Continuity Log

Purpose: Preserve high-signal session outcomes in-repo so context is not lost after VS Code updates, model resets, or interrupted chats.

## 2026-06-04 - Recovered From Git History

Context:
- A prior chat thread was lost after a VS Code update.
- Recovery was performed from git history and applied file diffs.

Shipped commit:
- `0981640` - Harden polling/reconnect flows and align API route docs

Recovered outcomes from that missed thread:
1. Documentation route drift fixed:
- Replaced stale `/api/matches/*` references with current routes like `/api/live`, `/api/upcoming`, `/api/stats`, and `/api/calibrate/results`.
- Updated files: `README.md`, `GETTING_STARTED.md`, `SYSTEM_DOCUMENTATION.md`, `.github/copilot-instructions.md`.

2. Backend hardening:
- Added calibration single-flight protection to avoid overlapping calibration runs from startup/schedule/manual triggers.
- Added quota guard auto-resume heartbeat with env control: `QUOTA_GUARD_HEARTBEAT_MS`.
- Added calibration trigger metadata to calibration status payload.

3. Frontend hardening:
- WebSocket reconnect flow now guards against duplicate connect attempts.
- Added explicit socket disconnect and listener cleanup.
- Added listener dedupe in `on()` registration.

4. Low-risk tuning pass:
- Added optional adaptive polling controls (default conservative):
  - `LIVE_POLL_INTERVAL`
  - `ENABLE_ADAPTIVE_LIVE_POLL`
  - `LIVE_POLL_INTERVAL_WHEN_LIVE`
- Added live freshness telemetry to `/api/live` and `/api/health`.
- Updated `backend/.env.example` to safer defaults.

Operational note:
- Quota heartbeat is local timer logic only; it does not call API-Football directly.

## Documentation Update Protocol (Periodic)

Use this checklist at the end of each substantial session:
1. Add one dated entry in this file with:
- Problem statement
- Decision(s)
- Files changed
- Commit SHA
- Runtime/env toggles introduced
2. If API contracts changed, update both:
- `README.md` endpoint table
- `SYSTEM_DOCUMENTATION.md` endpoint section
3. If risk-related behavior changed (polling/quota/calibration), include rollback knob(s) and defaults.

Template:

```
## YYYY-MM-DD - <Short Title>
- Commit: <sha>
- Summary: <1-3 lines>
- Files: <paths>
- Env: <new/changed vars>
- Rollback: <how to disable/revert behavior quickly>
```

## 2026-06-04 - Competition-Aware Routing + Risk Guardrails
- Commit: pending
- Summary:
  - Added competition-aware model routing for Agent 47 (league/cup/continental/tournament/friendly contexts).
  - Added competition-family risk policy for alert thresholds and bet slip staking caps.
  - Added per-family settled performance endpoint for calibration/ROI monitoring.
- Files:
  - `shared/competitionModelProfile.js`
  - `shared/competitionRiskPolicy.js`
  - `backend/src/services/agent47Service.js`
  - `backend/src/server.js`
  - `README.md`
- Env:
  - No new required env vars for this pass.
- Rollback:
  - Revert routing behavior by rolling back `shared/competitionModelProfile.js` and related `analyzeV9` changes.
  - Revert threshold/stake guardrails by removing `competitionRiskPolicy` integration from `saveAlert()` and `generateBetSlips()`.

## 2026-07-18 - ChatGPT Audit Imported + Phase 0 Safety Hardening
- Commit: pending
- Summary:
  - Imported external audit directive into repo docs and created continuity hardening guide.
  - Implemented Phase 0 safety patch to enforce executable-market confidence and stop fake odds fallbacks.
  - Added baseline Node test coverage for fail-closed behavior and market parsing.
- Files:
  - `docs/Sporty-Rabbi_Copilot_Hardening_Directive.md`
  - `docs/PROJECT_CONTINUITY_AND_HARDENING.md`
  - `shared/marketKeys.js`
  - `backend/src/services/agent47Service.js`
  - `backend/src/server.js`
  - `backend/src/services/notificationService.js`
  - `backend/test/safety.test.js`
  - `backend/package.json`
  - `frontend/package.json`
  - `package.json`
- Env:
  - Twilio destination variable normalized: canonical `TWILIO_WHATSAPP_TO`; legacy alias `ALERT_PHONE_NUMBER` still accepted.
- Rollback:
  - Revert `shared/marketKeys.js` import + usage in `server.js` to restore previous confidence and odds behavior.
  - Revert `agent47Service.js` null-safe 1X2 checks if needed.
  - Revert `backend/test/safety.test.js` and package scripts if test rollout must pause.

## 2026-07-18 - Phase 0.5 Cleanup
- Commit: pending
- Summary:
  - Removed Node ESM warning by setting root package type to module.
  - Added explicit shared `offeredOddsForMarket()` helper and test coverage for unknown market no-projection behavior.
  - Re-verified local checks plus Railway/Netlify production endpoint health.
- Files:
  - `package.json`
  - `shared/marketKeys.js`
  - `backend/src/server.js`
  - `backend/test/safety.test.js`
- Production checks:
  - `GET https://web-production-cccff.up.railway.app/api/health` → 200
  - `GET https://web-production-cccff.up.railway.app/api/calibrate/results` → 200
  - `GET https://sporty-rabbi.netlify.app` → 200

## 2026-07-18 - Phase 1 Minimal Slice (Decision States + Value Engine)
- Commit: pending
- Summary:
  - Added canonical decision-state constants and a pure value engine for fair odds, minimum acceptable odds, and EV-based decisioning.
  - Annotated Agent 47 recommendations with `marketKey`, `decisionState`, and `value` snapshot without breaking existing response fields.
  - Added value engine tests and kept production endpoint sanity green.
- Files:
  - `shared/decisionStates.js`
  - `backend/src/services/valueEngine.js`
  - `backend/src/services/agent47Service.js`
  - `backend/test/valueEngine.test.js`
- Verification:
  - `npm run test` → pass (9 tests)
  - `npm run build` → pass
  - `npm run check-syntax --prefix backend` → pass
  - `GET https://web-production-cccff.up.railway.app/api/health` → 200
  - `GET https://web-production-cccff.up.railway.app/api/calibrate/results` → 200
  - `GET https://sporty-rabbi.netlify.app` → 200
