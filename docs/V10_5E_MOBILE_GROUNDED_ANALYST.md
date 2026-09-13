# V10.5E: mobile access and grounded match notes

Base: production main `9d26b72a9638679ed542097dfa1c9aa9e1fd8bc2`.
Prepared on 13 September 2026. Not deployed by the installer.

## Fixes

- Mobile header wraps into logo/refresh, search, and navigation rows. Record,
  Bet Tools and Alerts stay accessible. Detail opens full-screen with scrolling.
- Goal Fest shows waiting, paused, unavailable, below threshold or active states.
  A deliberate match click checks the selected fixture immediately using the
  existing guarded fixture-statistics request, independently of scanner rotation.
- Scanner skips paused matches and those before minute 12. Statistics failures
  yield an unavailable signal, not a stale active badge.
- Displayed signals must match the current score and be less than 7.5 minutes old.
  Verified xG, score, minute and shots-on-target requirements remain unchanged.
- Selected-match analyst prose uses deterministic, labelled verified evidence,
  not a forced confident LLM recommendation or invented narrative confidence.

## Analyst evidence

Current score/time and score pressure follow the existing live heartbeat without
new API polling. Stoppage-time length is unknown; extra-time uses a 120-minute
regulation endpoint. Evidence at selection is explicitly a timestamped snapshot.

Historical enrichment runs outside the prediction response. It reuses current
exact-season form fixtures, retains their IDs and team orientation, and examines
at most ten completed league fixtures per team before the selected kickoff.
Goals from minute 80 onward include second-half stoppage time. Missing/incomplete
event coverage is excluded after goal totals reconcile with the verified final
score. Counts mean games with late goals, not number of goals. Fewer than five
verified games is explicitly too small to call a reliable pattern.

Season stage uses provider season start/end dates. League performance compares
points/game with the previous season overall, not matched rounds. Cup fixtures
do not receive league-form comparisons. Early-season samples are flagged.

Coach context uses dated provider career records and identifies a predecessor
only when one is recorded. Transfer arrivals use dated incoming records since
last season ended (or current-season start if prior dates are unavailable), with
unique players counted. Records do not establish availability or causal impact.

## Quota and safety

Context calls are single-flight, globally paced and recheck the quota guard after
the pacing wait. Their headers update the existing quota state. Responses are
cached for twelve hours, including valid empty responses. The context cache is
bounded to 1,500 entries. Maximum new context calls per click: 27 (20 event pulls,
one competition metadata pull, two previous-season records, two coaches and two
transfer histories). `ANALYST_CONTEXT_DAILY_CALL_LIMIT` defaults to 160 extra calls
per UTC day; zero disables new context calls. This is additional to existing
click analysis and shared live/Goal Fest calls. No closed-portal context poller.
`enrich:false`, missing IDs/season and quota pause fail closed.

No production secrets are required by the installer or included in the package.
Tests use a local mocked API adapter. No changes to prediction ledger settlement,
stakes, numeric Chaos weights, daily-preparation workflow or production settings.

## Verification and release

Run syntax checks, V10 regression tests, prediction/value engine tests, frontend
build and `git diff --check`. `safety.test.js` imports the server and leaves its
timers active; on Node supporting it, `--test-force-exit` runs the complete suite.

The local cloud browser cannot open this workspace preview. Mobile CSS/navigation
and full-screen detail have regression checks, but real phone geometry and real
provider coverage still require post-install/post-deployment confirmation.

Installer refuses a dirty worktree, wrong base or changed remote main; creates
only a feature branch; applies a preflight-checked patch; runs validation; never
commits, pushes, merges or deploys automatically. Stage exact changed files only.

## Next parameter stage

Keep these facts as analyst context first. Before using them in Chaos/lifecycle
weights, define provenance, sample floors, matched-round seasonal comparisons,
coach-tenure cutoffs and position-weighted squad turnover. Backtest incremental
effects and missing-data behaviour before changing numeric weights. Missing coach
or transfer data must never become a default crisis or neutral-confidence score.
