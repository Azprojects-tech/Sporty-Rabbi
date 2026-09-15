# V10.6A — prediction consistency, odds and daily tickets

Base: `629a226ae4f1a8abe1850e756cec0592847d1232` (V10.5E).
Feature branch: `v10-6a-engine-odds-repair`.

## Changes ready to apply

- One score distribution supplies regulation 1X2, BTTS and goal totals. Over 0.5 now includes the same Dixon–Coles adjustment as the other prematch markets.
- Live forecasts use remaining time and the current score. Next-home-goal, next-away-goal and no-further-goal form one complete set of outcomes. Team cards and score-state rate adjustments are applied once.
- Recommendations and the separate win call retain the selected market's probability. Signal strength, data quality and model probability stay separate. Percentage bonuses are removed.
- Regulation markets are unavailable in extra time or when remaining stoppage time is unknown. Missing final scores are not converted into 0–0; extra-time totals do not settle regulation bets.
- Analyst notes state the available counts, dates, probabilities and prices. The repeated prediction/guarantee disclaimers are removed; missing information is still labelled unavailable.
- API-Football prematch odds use the existing configured API key, shared request pacing, quota guard and 429 circuit. A default limit of 120 odds attempts per UTC day per running instance, single-flight requests and caching bound additional requests. Empty coverage is cached for 15 minutes; network failures for one minute. The quota guard continues to apply across football requests.
- Quotes carry fixture, bookmaker, market period, provider update time and expiry. Only supported regulation market IDs with matching names are accepted. Four-hour expiry follows the provider's approximately three-hour prematch refresh cycle. Fixture coverage is determined by the actual response.
- Click analysis and bounded daily/Bet Desk shortlists obtain odds. A shortlist stops launching requests after five seconds; individual odds HTTP requests have a four-second timeout. Bookmaker snapshots are archived when Firestore is available.
- Bet Desk requires an explicit BET decision, future fixture, current odds and at least 5% calculated expected value. Missing prices never become synthetic odds. Live fixtures do not use prematch quotes.
- Every double and treble must satisfy the 51.2% whole-ticket floor below and the ticket-level 5% expected-value floor. All legs use one bookmaker. Repeated fixtures and teams are excluded. Fixtures are not reused across the generated singles, double and treble.
- New ledger records retain full-precision probabilities, model rates, core inputs, odds metadata and model version. Existing recorded results are unchanged. Prediction history adds cursor pagination; the old single-page limit no longer prevents a complete subsequent export.
- Forecast evaluation reports probability bands, Brier score and log loss without declaring a four-bet sample “well calibrated” or halting a correctly calibrated model because of a fixed absolute log-loss cutoff. Small-sample pattern messages no longer tell users to increase stakes.

## The 51.2% rule

The initial implementation uses the Fréchet lower bound from model marginal probabilities:

`max(0, p1 + p2 + ... + pn - (n - 1)) >= 0.512`

This allows dependence between outcomes. It is a lower bound within the model, not an empirical confidence interval or a fitted joint-probability estimate. It never clamps a failed ticket up to 51.2%.

Examples:

| Legs | Model probability floor | Outcome |
|---|---:|---|
| 80%, 80% | 60% | Probability gate passes |
| 80%, 80%, 80% | 40% | Rejected |
| 84%, 84%, 84% | 52% | Probability gate passes |
| 84%, 84%, 83.2% | 51.2% | Boundary passes |

The price must also pass: `floor * standardCombinedOdds - 1 >= 0.05`.
Standard combined odds are the product of the same bookmaker's individual decimal prices. They are labelled “Standard odds”; no bookmaker account is connected to confirm or place a multiple. No bets are placed by this release.

The existing stake allocation model remains in use, with a 60% overall ceiling on the entered session budget and existing competition-specific single-stake caps. This release does not introduce a trained portfolio staking model. “Best case” is the payout if all generated tickets win, not expected profit.

## Configuration

No new subscription or key is needed for this adapter. Existing `API_FOOTBALL_KEY` is reused.

```dotenv
ENABLE_PREMATCH_ODDS=true
ODDS_DAILY_CALL_BUDGET=120
ODDS_BOOKMAKER_ID=
```

An empty bookmaker ID selects the returned bookmaker with the most supported markets, breaking ties by ID. Set an API-Football bookmaker ID to constrain all offers to a particular provider. Unsupported or unavailable quotes display as unavailable. These defaults are active without editing Railway variables.

Read-only diagnostics after deployment: `/api/health`, `/api/odds/status`, `/api/predictions?limit=500`. History responses include `pagination.hasMore` and `pagination.nextCursor`; pass that cursor to the next request. Opening Bet Desk refreshes a bounded odds shortlist and can archive newly observed quotes.

## Validation and deployment

The supplied installer checks the exact base commit, remote main and a clean checkout; verifies its embedded patch hash; creates the feature branch; applies the patch; then runs syntax checks, 118 regression/numerical/service tests, the production build and `git diff --check`. It does not commit, push, merge or deploy. It stops and preserves the working files if any check fails.

Local checks cover score-distribution identities, live BTTS, competing goal events, period handling, missing final scores, odds freshness and quota/cache behaviour, selected-market decisions and every slip mode. Odds tests use provider-shaped fixtures; successful production odds coverage still needs to be observed with the configured account after deployment. The installer repeats tests and the build on the user's Windows checkout.

## Next phase: V10.6B

Build the historical evaluation and challenger-model pipeline on these corrected contracts: chronological train/validation/test splits; opponent-adjusted time-varying team strengths; league and promoted-team priors; separate live scoring hazards; calibration by market with versioned held-out evaluation; price movement and closing-price capture; and actual taken-odds/stake recording. Evaluate verified lineup, coach, transfer and late-goal features against the baseline before changing production probabilities. Promote an enhancement only when the held-out comparison supports it. The old ledger's mislabeled win-call scores must not train the new probability calibration.

## Provider references

- [API-Football plans include prematch and in-play odds](https://www.api-football.com/pricing).
- [API-Football guide: odds endpoints, update cycles, seven-day prematch history and separate live market IDs](https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide).

The independent research and audit supplied earlier remain the broader system design; this release implements the audited calculation and execution repairs first.
