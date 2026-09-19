# SportyRabbi: one-engine audit and repair
19 September 2026 · audited main `ee186120d23785f1eb968da00259a7f80316239f`

## Decision
Sporty has useful components, but its supporting indicators are more elaborate than its actual probability model. The right rebuild is a single match forecast with named inputs, followed by price decisions and delivery. Combining fifteen context scores into a larger percentage would double-count evidence and would not solve the problem.

This package implements the deterministic integration repairs described below. It does **not** claim to have trained or validated a new live-xG model. No GitHub push, deployment, notification or production-data write was performed. All repository files were compared against GitHub's main tree before editing an isolated copy.

## What the stored results show
The read-only audit retrieved the latest **10,000 prediction documents**, covering prediction timestamps 29 August–19 September. More records exist. It is a bounded sample, not the entire database. Pending fixtures and snapshots created at/after kickoff were excluded; each fixture was counted once using its first valid prematch snapshot.

- 8,618 settled fixtures remained; 1,358 documents were pending and 24 were not valid prematch snapshots.
- Of these, **864 fixtures** used V10.6A-Coherent-Core (also the probability model used by V10.6B).
- Their **1,751 selected market calls won 67.7%**, versus **72.4% average stated probability**: a 4.7 percentage-point overprediction in this sample.
- Multiple market calls belong to the same fixture. These are not 1,751 independent bets, and are not profit figures.
- Across different historical cohorts, V10.1 selected calls won 65.2%, versus 67.7% for V10.6A. Different dates, competitions and selections prevent attributing that difference solely to the release.

| Current model: selected market | Calls | Actual wins | Mean predicted probability |
|---|---:|---:|---:|
| Home win | 139 | 66.9% | 69.3% |
| Away win | 63 | 65.1% | 65.1% |
| Both teams score | 298 | 61.4% | 70.4% |
| Over 1.5 | 589 | 78.4% | 80.4% |
| Over 2.5 | 525 | 62.1% | 67.6% |
| Under 2.5 | 137 | 59.1% | 67.8% |

The largest current gaps are BTTS and Under 2.5, not a universal failure of every market. A sample agreement such as Away win's 65.1% is not proof of future calibration. The frozen ledger is primarily prematch: these figures cannot validate the live 0–0 complaint.

The audit scripts also evaluate all supported markets in saved probability distributions, not only displayed picks. They use frozen inputs and recorded final regulation scores, never today's revised statistics to reconstruct yesterday's evidence.

## What we found in the code
| Component | Actual behaviour before repair | Assessment/action |
|---|---|---|
| Historical team rates | Last-ten goals for/against; fixed league priors; small-sample shrinkage | Useful baseline, not fitted opposition-adjusted team strength. Normalize completed fixtures before deriving rates. |
| Historical xG | Used only if all four xG/xGA averages exist | Keep separate from cumulative live xG. The suspected unit mix-up was already fixed in main. |
| Live probabilities | Historical rates scaled by remaining time, score and configured red-card factors | Does not respond to observed live xG or shots. Requires a fitted live model, not a guessed extra multiplier. |
| Live cache | Could retain old probabilities when the score stayed unchanged | Recompute on the observed clock/score using stored historical inputs, including cache hits. |
| Live analysis routes | Separate POST and GET paths with different enrichment inputs | Route both through the same enrichment/analysis handler. |
| Market ranking | Highest probability first, regardless of value | Separate most-likely listed market and best eligible priced market. |
| Legacy checks | First recommendation could trigger rejection of the whole list | Apply evidence and price gates independently to each market. Remove retired override functions. |
| Next-goal panel | Shared-rate calculation when available; separate shot/conversion fallback otherwise | Use the same team-rate core; return unavailable if it is missing. |
| Shot context | One path mixed on-target with total shots and projected the count twice; late path returned raw count | Keep total-shot units consistent, convert once and preserve verified zero. |
| Goal Fest | Separate xG/shot/goal pace activity index | Retain as activity context; not a calibrated event probability. Alert integration still needs work. |
| Explanation cards | Largest context scores presented near predictions | Add an explicit card identifying inputs actually used by the forecast. |
| Confidence display | Probability and evidence quality mixed into an extra score | Keep model probability separate; compatibility evidence score now reports input quality. |
| Tickets | Probability floor, EV, current prices, fixture/team/bookmaker checks | Preserve these gates, including the 51.2% model-derived combination floor. |
| Recorded bets | Repaired settlement and reference odds | Preserve. Reference prices do not establish actual taken prices or returns. |

Over 0.5 must be at least as likely as Over 1.5 and Over 2.5 under a coherent model. Seeing it frequently is partly a ranking consequence, not proof of a wrong probability. Under 2.5 becoming more likely as a scoreless match progresses is also plausible. The defects are stale state, weak live adaptation and presenting probability ordering as opportunity ordering.

## Research and design choices
**Team strength:** estimate attack and defence jointly across opponents, with home advantage, league/season structure, time decay and partial pooling for sparse/promoted teams. Simple goals averages cannot fully distinguish scoring against strong and weak opponents. Dixon–Coles establishes a fitted goal-model framework; Crowder and colleagues extend attack/defence strength through time. These support the model structure, not Rabbi's existing numerical coefficients. [Dixon & Coles, 1997](https://rss.onlinelibrary.wiley.com/doi/10.1111/1467-9876.00065); [Crowder et al., 2002](https://academic.oup.com/jrsssd/article/51/2/157/7120674).

**Live events:** model remaining goal arrivals using time, score, red-card difference and measured match events. Robberechts and colleagues evaluate a Bayesian live model with contextual events across eight seasons in major European leagues. This supports testing live event features and time-varying effects instead of inventing a fixed pressure bonus. It does not establish performance on Rabbi's youth/lower-league coverage. [Robberechts et al., KDD 2021](https://arxiv.org/html/1906.05029v2).

**Market baseline:** a 2026 preprint combines kickoff-market calibration with a time-varying post-shot-xG covariate, evaluated on 140 EPL matches. It offers a relevant challenger design, but is a limited preprint evaluation; its accuracy/ROI does not transfer to SportyRabbi. Ordinary API-Football xG is not post-shot xG, so copying its coefficient would be invalid. [Clegg, Song & Cartlidge, 2026](https://arxiv.org/abs/2605.16066).

**Evaluation:** assess probabilities with proper scoring rules such as log loss and Brier score, plus calibration by market, competition and match phase. Success rate alone changes when we choose easier markets. Preserve chronological development/validation/test blocks; keep all states from a fixture together. [Gneiting & Raftery, 2007](https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jasa.pdf).

**Coach changes:** do not automatically add a new-manager bonus. A Bundesliga study attributes observed post-dismissal improvement to regression towards the mean. That is a reason to test the feature with opponent/strength controls, not a universal assertion that coaches never matter. [Heuer et al., 2011](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0017664).

## The proposed unified engine
1. **Verified match record.** Fixture/team IDs, competition/season, market period, score/clock, timestamp and units. Separate unavailable, observed zero, season averages and cumulative live events. Keep original observations for replay.
2. **Prematch strength model.** Fit attack/defence and league/home effects on completed historical fixtures available before prediction time. Test xG, venue splits and opponent-adjusted recent form. Store fitted parameters and training cutoff.
3. **Live update.** Start with that prematch estimate. Update goal intensity with score/time/cards and timestamped xG/shot changes. Compare a simple conditional Poisson model with fitted time-varying alternatives; do not transplant another study's coefficients.
4. **One outcome distribution.** Produce regulation 1X2, totals, BTTS and next-goal probabilities from one compatible process. Expected score, explanations and alerts identify the same model version and observed match state.
5. **Price decision.** Compare the selected probability with fresh exact-market odds, retaining bookmaker, period and timestamp. A market benchmark must use a complete contemporaneous market with margin removed; missing prices mean value is unavailable. SportyBet's price/market availability remains unverified.
6. **Portfolio and delivery.** Form tickets only from eligible markets. Preserve stake caps, duplicate/correlation controls and the 51.2% combination criterion. Every alert records the forecast and price that caused it.
7. **Evaluation and promotion.** Fit challengers offline; compare them on subsequent fixtures. Keep a baseline and rollback version. Promotion follows improved held-out scoring/calibration and pricing results, not a few wins or a larger percentage.

The same feature must not enter as form, crisis, momentum and chaos four times. Each gets an explicit role and an ablation test: compare the model with and without that feature on the same future matches.

## Where the fifteen parameters belong
| Existing indicator | Role in the rebuilt engine |
|---|---|
| Motivation | Verified competition scenarios as candidate features; table position alone is not motivation. |
| Star power | Confirmed lineup/player impact, availability and minutes; train effects rather than fixed deductions. |
| H2H | Context; test incremental information after current team strength, venue and squad changes. |
| Form | Time-varying, opponent-adjusted attack/defence; avoid counting the same results twice. |
| Timing | Time-dependent scoring hazard, pooled when team-specific samples are small. |
| Defensive gap | Part of the opponent's fitted defence term. |
| Poisson | Probability calculation, not an independent vote to add back to itself. |
| xG edge | Verified chance-quality observations at the correct historical/live time scale. |
| Defensive solidity | xGA contribution to defence, jointly estimated with goals conceded. |
| Pace | Live event-rate candidate; shots and xG are correlated and need joint testing. |
| Home advantage | Fitted league/team venue effects, not possession dominance. |
| Market divergence | Price comparison and separately tested market-informed baseline. |
| Competition context | League/competition parameters and appropriate data coverage. |
| Lifecycle | Season/sample effects; factual standings scenarios where relevant. |
| Crisis | Descriptive history; no automatic “goals are due” boost. |

Lineups, coach changes, late goals and Chaos remain useful information even if an ablation finds no extra forecasting benefit. They must not be described as numerical model drivers until they actually are.

## Experiment performed now
A reproducible offline experiment tested 15 shared-rate scale/balance combinations while preserving a coherent score distribution. It used only V10.6A frozen rates and valid prematch timestamps.

- Training: 450 fixtures, 16–17 September.
- Validation: 377 fixtures, 18 September.
- Test: 37 settled fixtures from the incomplete 19 September day.
- Candidate selected on training only: total rate scale 1.0, home/away balance 0.85.
- Combined proper-score objective (lower better): training 0.80452 baseline vs 0.80401 candidate; validation **0.78476 vs 0.78998 (worse)**; test 0.80568 vs 0.80247.

**Do not deploy that adjustment.** The validation worsened and the test window is short. This is an experiment on existing frozen rates, not a fitted team-strength/live-events rebuild or a proven accuracy uplift.

## What is ready and what remains
**Ready as V10.6C:** clock/cache repairs, one analysis entrypoint, shared next-goal basis, per-market decisions/value ordering, history normalization, shot-unit repair, evidence-use trace, removal of retired override code, and reproducible audit/calibration scripts. Numerical priors and the probability model itself have not been newly fitted.

**Next modelling work:** collect league-wide historical fixture/opponent records and timestamped in-play event snapshots with provider provenance; train dynamic strength and live-event challengers; add lineup/coach/timing features individually; validate across multiple chronological periods and covered competitions. The current prematch ledger lacks the live xG trajectories needed to retrospectively train or verify the live-pressure repair.

**Alerts follow that work:** make Goal Fest/activity metrics distinct from market probabilities, align alert payloads with shared forecasts, add delivery tracking and then permanent WhatsApp/background Tier 1–3 monitoring. The sandbox note remains valid.

Validation: 138 targeted regression tests passed and production frontend build passed. Backend syntax checked separately (its npm build only prints “Backend ready”). Two pre-existing assertions in the old `safety.test.js` also fail on unchanged V10.6B; that test imports the server and leaves listeners running. They are documented, not represented as passing or changed to hide failures.

Install using the included guarded PowerShell script on clean main at the audited commit. It creates a feature branch and applies/checks the patch. It does not commit, push, merge, deploy, fetch odds or send messages.
