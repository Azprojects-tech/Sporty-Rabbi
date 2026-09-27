# V11 research programme — dynamic team strength challenger

Date: 27 September 2026

## Objective

Replace the weak part of the current forecast — recent goals-for/goals-against averages treated largely without opponent adjustment — with a fitted, opponent-aware team-strength process. Keep every unproven contextual feature out of the probability until it demonstrates held-out value.

This is a challenger, not an automatic production replacement.

## Research basis

The architecture follows the useful parts of the Dixon–Coles family: team attack and defence strengths, home advantage, a coherent score distribution and low-score dependence. It also follows the live-model principle that score state and time remaining change goal intensity.

Primary references:

- Dixon, M. J. & Coles, S. G. (1997), *Modelling Association Football Scores and Inefficiencies in the Football Betting Market*, JRSS Series C.
- Dixon, M. & Robinson, M. (1998), *A Birth Process Model for Association Football Matches*, The Statistician.
- Maia, L. F. G. N. et al. (2026), *Stochastic modelling of football matches using dynamic regressors*, International Journal of Forecasting.

The implementation deliberately does **not** copy coefficients from another study. Parameters are selected from held-out football results and then shadow-tested on SportyRabbi's own ledger.

## External benchmark data

Source: Football-Data.co.uk match results mirrored in the public GitHub dataset vibedatascience/footballdatacouk_leagues_games_results_big5.

Leagues: Premier League, La Liga, Bundesliga, Serie A and Ligue 1.

The research parse contained 13,483 matches from 2018/19 through the partial 2025/26 season, with earlier seasons used as model warm-up.

Chronology:

- model warm-up: historical seasons before 2023/24
- validation: 2023/24
- held-out test: 2024/25
- fresh check: partial 2025/26

No future match was used to predict an earlier match.

## Candidate model

For home team i and away team j:

log(lambda_home) = league_base + home_advantage + attack_i - defence_j

log(lambda_away) = league_base + attack_j - defence_i

After each completed match, attack and defence parameters are updated from the Poisson scoring error. Constant-step online learning gives newer evidence more influence while retaining the opponent adjustment. The validated learning rate is 0.015. A Dixon–Coles low-score correction with rho -0.08 is retained.

This means a 3–0 result against a weak defence does not have the same implied team-strength meaning as a 3–0 result against a strong defence.

## Benchmark against the current recent-goals approximation

Lower is better for every number below.

| Period | Model | 1X2 log loss | 1X2 RPS | O2.5 Brier | O1.5 Brier | BTTS Brier |
|---|---|---:|---:|---:|---:|---:|
| 2023/24 validation | current approximation | 1.00977 | 0.20537 | 0.24842 | 0.17116 | 0.24872 |
| 2023/24 validation | V11 dynamic strength | **0.97281** | **0.19382** | **0.23745** | **0.16433** | **0.24375** |
| 2024/25 held-out | current approximation | 1.01197 | 0.20983 | 0.24935 | 0.17382 | 0.25032 |
| 2024/25 held-out | V11 dynamic strength | **0.98146** | **0.20020** | **0.24145** | **0.16996** | **0.24658** |
| 2025/26 fresh partial | current approximation | 1.02314 | 0.21192 | 0.26099 | 0.18972 | 0.25870 |
| 2025/26 fresh partial | V11 dynamic strength | **0.98502** | **0.19892** | **0.24772** | **0.18149** | **0.25061** |

The improvement repeated on validation, a later full season, and a still later partial season. That is enough to justify a shadow trial, not enough to declare a universal betting edge.

## Features deliberately tested and not promoted

Historical shots on target, total shots and corners were tested as additional rate modifiers. They produced a small 1X2 gain in some splits but did not consistently improve the goal-market scores. An additional Elo result-rating balance term produced only marginal gains.

They are therefore **not** in V11.0. More parameters are not automatically a better model.

Historical xG/xGA remains a high-priority candidate, but SportyRabbi's current production feed does not provide genuine historical xG averages. Live xG and live shots remain contextual evidence until a time-stamped live hazard model is trained.

Lineups, coach changes, injuries, late-goal history, motivation and crisis indicators remain recorded/explained where available. They do not alter V11 probabilities until an ablation test proves incremental held-out value.

## Production shadow rules

V11.0 is trained from SportyRabbi's own settled prediction ledger, not from today's result data.

A league needs at least 60 settled fixtures in the training window. Each team needs at least three prior ledger matches. Otherwise V11 returns unavailable.

Every new prematch ledger record freezes both the current production/champion probability vector and the V11 shadow probability vector.

After settlement, the challenger is compared with the champion using 1X2 log loss, ranked probability score and Brier scores for Over 1.5, Over 2.5, Under 2.5 and BTTS.

The evidence gate requires at least 500 shadow fixtures over at least 14 prediction dates. It can report EVIDENCE_PASS, but it **never promotes itself automatically**.

## Current architecture decision

- V10.6C remains the production decision engine.
- V11.0 dynamic strength runs in shadow.
- Odds remain an execution/value input, never a way to inflate the model probability.
- Corners remain a separate fitted count model.
- Live xG/shots are not converted into probability until a fitted live model exists.
- Future V11 components are promoted one at a time by chronological held-out tests and then by SportyRabbi shadow results.