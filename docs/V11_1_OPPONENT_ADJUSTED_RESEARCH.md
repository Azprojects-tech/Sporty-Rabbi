# V11.1 Opponent-Adjusted Strength Research

Date: 27 September 2026

## Purpose

Replace the first V11 online-learning challenger with a simpler, replayable opponent-adjusted team-strength model. The production V10.6C champion remains unchanged while the challenger collects forward evidence.

The new challenger is deliberately narrower than the old 15-parameter presentation layer. It only puts variables into probability when they have a defensible statistical role.

## Research design

The core model follows the long-established attack/defence family used by Dixon-Coles and later dynamic football models:

- one attack factor per team;
- one defence factor per team;
- separate league home and away scoring baselines;
- opponent adjustment through multiplicative attack x opposition-defence rates;
- exponential recency weighting;
- shrinkage toward league average for thin samples;
- one Dixon-Coles score distribution for 1X2, totals and BTTS;
- odds remain a price/value layer, never a probability input.

Context such as coach changes, injuries, motivation, H2H and live pressure remains evidence/explanation until an ablation or held-out test proves incremental value.

## Independent multi-league benchmark

Public historical result files were read from the open `datasets/football-datasets` GitHub mirror, which standardises football-data.co.uk match results.

Leagues:
- Premier League
- La Liga
- Bundesliga
- Serie A
- Ligue 1

The benchmark compared:
1. a reconstruction of the current recent-goals baseline (last ten, small-sample shrinkage, fixed league mean, 1.07/0.97 venue multipliers);
2. the V11.1 opponent-adjusted challenger.

Hyperparameters were selected on 2023/24 validation data only. The best validation setting was:
- half-life: 365 days
- prior strength: 4 pseudo-games
- historical window: 730 days
- 24 fitting iterations
- Dixon-Coles rho: -0.08
- 100% challenger rate (no baseline blend)

### Held-out 2024/25

| Metric | reconstructed baseline | V11.1 challenger | direction |
|---|---:|---:|---|
| 1X2 log loss | 1.01188 | 0.98653 | lower is better |
| 1X2 RPS | 0.20999 | 0.20160 | lower is better |
| Over 2.5 Brier | 0.24906 | 0.24338 | lower is better |
| BTTS Brier | 0.25008 | 0.24713 | lower is better |
| Top 1X2 hit rate | 50.3% | 52.6% | higher is descriptive only |

The challenger improved 1X2 log loss and RPS in every one of the five leagues.

### Second held-out season: 2025/26

| Metric | reconstructed baseline | V11.1 challenger | direction |
|---|---:|---:|---|
| 1X2 log loss | 1.02744 | 0.99821 | lower is better |
| 1X2 RPS | 0.21369 | 0.20368 | lower is better |
| Over 2.5 Brier | 0.25532 | 0.24870 | lower is better |
| BTTS Brier | 0.25227 | 0.24883 | lower is better |
| Top 1X2 hit rate | 48.7% | 52.1% | higher is descriptive only |

This is a second chronological holdout after tuning. It is stronger evidence than a single-season backtest, but it is not evidence of guaranteed profit.

## Why the old V11 shadow was replaced

The first V11 shadow used an online gradient-style update. Production logs showed only 198 comparable current-version fixtures and worse historical replay at that point:

- delta log loss: +0.04939
- delta RPS: +0.01745

Both are regressions because lower is better.

That challenger never controlled production picks. V11.1 replaces the research algorithm while keeping the same shadow-only safety boundary.

## Production promotion gate

V11.1 must not replace the production champion automatically.

Forward shadow evidence remains required:
- at least 500 comparable fixtures;
- at least 14 prediction days;
- 1X2 log loss at least 0.5% better;
- RPS no worse;
- at least three of four binary markets non-worse;
- no binary-market Brier regression greater than 0.002.

A historical pass can justify continued testing. It cannot trigger a production promotion by itself.

## Next research layers

1. **Historical xG challenger** — only when four correctly-scaled historical xG/xGA inputs are available with provenance.
2. **Live hazard model** — train remaining-goal intensity from timestamped score, xG, shots, shots on target, corners and cards. Do not use guessed live multipliers.
3. **Feature ablation** — lineup, coach, rest/travel, late-goal profile and other context are admitted one at a time only if held-out scoring improves.
4. **Market benchmark** — compare against de-vigged bookmaker consensus when complete contemporaneous prices exist.
5. **League-specific calibration** — only after enough forward data per market and competition.

## References

- Dixon & Coles (1997), *Modelling Association Football Scores and Inefficiencies in the Football Betting Market*.
- Crowder et al. (2002), *Dynamic Modelling and Prediction of English Football League Matches for Betting*.
- Gneiting & Raftery (2007), proper scoring rules for probabilistic forecasts.
- Recent football-prediction literature continues to show that bookmaker consensus is a strong benchmark and that model accuracy alone is not evidence of betting edge.

