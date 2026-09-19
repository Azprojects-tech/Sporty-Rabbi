# V10.6B — played selections, alerts and inspectable evidence

Base: 6378b28fc35764ab2a53dc191997a3ad1170df05 (V10.6A on main).
Feature branch: v10-6b-evidence-played-bets.

## What changes

- I PLAYED THIS preserves the exact market's displayed reference odds, bookmaker, provider update time and recording time. Expired reference prices are explicitly marked. Actual taken odds remain a separate field; missing historic prices are not backfilled with today's prices.
- Save failures return an error, rather than reporting a successful permanent record. Stored source keys and deterministic document IDs prevent duplicate played selections after restarts or concurrent clicks.
- Pending played selections receive independent exact-fixture result checks without the prediction ledger's three-day cutoff. Durable settlement completes before the UI is notified. Interrupted writes remain retryable.
- My Bets has a Check results button. Scheduled checks also run through the existing two-hour settlement schedule. Each run reads a page of up to 250 pending records, checks at most 20 fixtures, respects the API quota guard and reuses request pacing. Unfinished/postponed games remain pending. Regulation full-time scores settle full-time markets, including games subsequently entering extra time.
- New actionable alerts appear as an in-app notice even outside the Alerts screen. Goal Fest scan time, activity, missing evidence and quota state appear in Alerts. This does not add notifications while the portal is closed.
- All 15 parameter rows are expandable. Chaos and Edges have keyboard-accessible expandable cards with inputs, methods, sources and their role in Rabbi.
- Team cards show the verified recent league sample, points/game, goals scored/conceded, model scoring rates, published starting XI, lineup continuity, fixture-specific absences, coach tenure and before/during-tenure sample results, and reconciled 80+ goal events.
- Unknown injuries no longer become a full-strength score of 100. Missing crisis, conversion and timing evidence stays unavailable. Context scores are bounded to 0–100. Table position no longer invents title/relegation motivation. An early-goal card requires goal events that reconcile to the current score.
- Analyst/evidence caching uses one-minute keys so old price and lineup context is not held for twenty minutes after a refreshed selection.

## Component review

The V10.6A coherent score matrix remains the owner of market probabilities. The core blends team scoring/conceding inputs, available xG, sample shrinkage and explicit league/home/away priors. Missing core inputs prevent a forecast. Legacy context scores are displayed separately and are not probability multipliers. Arbitrary early-goal and coach-bounce boosts are removed from context claims. Expected value and price/fixture/freshness rules gate priced tickets. The 51.2% combination floor is unchanged.

This patch adds inspectable team/lineup/coach evidence and fixes unsupported context logic. It does not introduce a newly trained opponent-strength model, learned player-ability model, or automatic retraining. Historical evaluation should precede those probability changes. High line and match-specific dependence remain unavailable without the necessary evidence.

## Live-record check, 18 September 2026

Read-only check of the latest 500 prediction records: all labelled V10.6A-Coherent-Core, dated 17–18 September. Their market calls contained 244 wins, 147 losses and 617 pending calls. Settled-call hit rate: 244/391 = 62.4%. More records exist; this is a partial recent sample, not the full version record, ticket success rate, or profit calculation.

Six USER_PLAYED records were present: three won, one lost, two pending. The pending records dated 22 August. The latest 50 stored alerts contained one Goal Fest alert from 13 September and 49 historical calibration alerts. No production records were changed during this review.

## Verification

129 targeted tests passed: existing V10 regression suites plus new market-bound quote, old-bet settlement, durable-write retry, exact-fixture/period, quota/budget, coach dates, lineup identity, historical sample and event-reconciliation tests. Frontend production build and server syntax checks passed. These checks verify functionality; they do not establish an improvement in betting accuracy.

## Apply

Open SportyRabbi_V10_6B_Install.txt, copy the whole file, paste into the VS Code PowerShell terminal at the repository root and run it. The installer requires a clean checkout at the base above, verifies the compressed patch hash, creates the feature branch, applies changes and runs checks. It does not commit, push, merge or deploy. If it stops, send the output without resetting files.

After deployment: open Record → My Bets → Check results; inspect the two old records; click I PLAYED THIS on a new selection and check the saved reference odds; expand Parameters/Chaos/Edges on mobile and desktop; inspect Alerts scan status while the portal is connected. Missing provider results/evidence remain unavailable or pending.
