# V10.11 — Daily picks and Telegram monitoring

Built against GitHub main 46ab4b2f4437b0611b5d56d0f853400d70a59f17.
The installer creates v10-11-daily-desk locally. It does not commit, push, merge or deploy.

## What changes

- Daily picks becomes the opening screen. Up to six games show home/draw/away, over 1.5, over 2.5 and BTTS percentages, the chosen market, minimum acceptable odds, reference bookmaker price and historical inputs. All matches, detailed analysis, records and played bets remain accessible.
- Combinations aim for total decimal odds 2.0–2.3 or 3.0–3.45. They require current prematch prices from one bookmaker, different fixtures and teams, a model probability floor of at least 51.2%, and at least 5% expected value calculated using that floor. An empty result is allowed. The floor is computed from estimated probabilities; it is not an observed success rate.
- One Telegram digest contains the shortlist. A five-minute server monitor follows those games with the portal closed. It compares fresh observations and sends score changes, red cards, increased attacking activity or increased corner activity. It does not run a pair of conversational AI agents or make additional LLM calls.
- Live updates also appear under Daily picks. Their Telegram status means the send API succeeded or failed, not that the recipient read the message. The existing Alerts tab remains the legacy alert history.
- A new corners model reuses the implementation from the unmerged feat/corners-model branch. It uses football-data.co.uk historical results for supported leagues, with separate home/away rates, recency weighting, small-sample shrinkage and a count distribution. Prematch over 8.5/9.5/10.5 estimates appear where team/league coverage exists. No live corner probability or live bookmaker price is invented. Corners are not included in the combined tickets.
- Frozen daily and live forecasts are written to Firestore before notifications, and settled against final regulation scores. Corners have a separate recorded/settled history. Existing My Bets remains in place.
- The same effective recommendation probability now drives recommendation display, price checks, expected value and the existing ticket builder. Raw model probabilities remain stored for evaluation.

## Historical check completed

A read-only snapshot of 20,000 prediction documents was fetched from the existing portal. Pagination still had more records, so this is not the entire database. The snapshot includes multiple engine versions.

The calibration check extracted 26,662 settled market rows across versions, then restricted evaluation to the current V10.6C-Unified-Decisions model and frozen prematch records with valid timestamps and raw probabilities. Seven prediction dates remained. Training contained 2,345 market rows. Later dates were reserved for validation and testing; results settled after a partition boundary could not train an earlier partition.

Result: NO_IMPROVEMENT_PROVEN. No market correction was approved. Examples from the final test period: over 2.5 Brier error increased from 0.24662 to 0.25780; under 2.5 increased from 0.19815 to 0.20533. Lower is better. The intermediate validation sample was also too small for promotion. Full metrics are in sporty-v111-validation.json.

Consequently the patch does not activate the previous unvalidated correction. It uses raw model probabilities unless a future version-matched correction passes the chronological sample and error gates. This is an engineering evaluation gate, not evidence of improved profit. The underlying goals model has not been replaced with a newly fitted team-strength model in this release. There is no established post-release success rate yet.

## Activation and limits

Existing Telegram credentials and Firestore are required. No WhatsApp sandbox setup is involved. DAILY_DESK_ENABLED defaults to true when Telegram is the active channel. Set it to false to disable the new monitoring path.

- First check: within five minutes of backend start, after daily preparation is available. Initial corners downloads can add several minutes.
- Up to six selected games; twelve candidates considered for reference odds.
- Default 400 additional live/final-status request attempts per UK day. The existing API quota guard, pacing and 429 circuit still apply. Daily preparation and odds have their own existing budgets.
- Maximum twelve notification events per day, three per fixture, with ten-minute fixture cooldown; a long Telegram message may be split into several Telegram messages by the existing sender.
- Live tracking: kickoff through three hours after kickoff, starting alerts at minute 12. Late matches carry across UK midnight. It does not monitor every game in the world or scan SportyBet markets.
- Missing xG blocks the xG-based activity trigger, but score/red-card/corner activity can still trigger where their required observations exist. Match probabilities use the existing historical goal-rate, score/time and card model; a measured xG surge is context, not an untested probability multiplier.
- Notifications are reserved before sending. Failed or ambiguous sends are recorded and not automatically retried, to avoid duplicate messages. Restart recovery keeps the shortlist, budgets and recent observations.
- Settlement checks are bounded to two fixtures per tick and at most once per fixture per 30 minutes, starting three hours after kickoff. Missing results become unresolved after seven days. This stores evaluation data; it does not yet add a new performance dashboard for desk events.
- The prior two-hour live-intelligence job and legacy morning/Goal Fest outbound messages are suppressed while Daily Desk is enabled. Portal Goal Fest visuals remain. New selected-game Telegram messages use the activity/score/card triggers above, not the old Goal Fest score threshold.
- The daily shortlist and combination prices are frozen. The UI marks expired quotes; it does not claim prices remain available. Reference bookmaker markets do not prove SportyBet offers the same line.

## Validation and installation

260 backend tests pass; production frontend/backend build passes. Server/service syntax checks pass. Patch application is checked against the clean source baseline. No real Telegram message, live bet, deployment or remote database mutation was made during testing. No browser visual test was performed.

1. Open SportyRabbi in VS Code and a PowerShell terminal at its repository root.
2. Open Install_SportyRabbi_V10_11.ps1 as text, copy everything and paste into that terminal.
3. The script requires a clean working tree and the exact main commit above. If the repository changed, it stops rather than overwriting newer work. It creates the feature branch, applies the patch, runs tests and builds.
4. Send the terminal output back before release. Nothing is deployed by the installer.

Next model work should use the newly recorded outcomes to evaluate goal/win/corner markets separately, then compare a fitted team-strength model on later matches. Coach, lineup and player changes should only change probabilities after their incremental value is measured. This release supplies a simpler operating loop and consistent decisions; it does not label an untested model as more accurate.
