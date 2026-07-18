# SportyRabbi Continuity And Hardening Guide

## Purpose

This document is the quick restart guide for any new Copilot session.
It captures what SportyRabbi is, what objective we are pursuing, and the hardening sequence currently approved.

## Project Objective

SportyRabbi is a football analytics and decision-assistance system with three linked goals:

1. Prediction brain:
   - Estimate probabilities for football betting markets, with first priority on goals markets.
2. Decision assistant:
   - Return disciplined states (`BET`, `NO_BET`, `WATCH_LIVE`, `NEEDS_PRICE`) instead of forcing picks.
3. Evidence and delivery:
   - Persist predictions, settle outcomes, measure calibration/performance, and deliver valid WhatsApp alerts.

Core principle: fail closed when evidence or price quality is insufficient.

## Canonical Audit Reference

Primary external audit (ChatGPT partner handoff) is stored in-repo at:

- `docs/Sporty-Rabbi_Copilot_Hardening_Directive.md`

This file is treated as an engineering hardening directive, not auto-approved truth. Every recommendation must be validated against current code before implementation.

## Current Implementation Sequence

Implement in small, reviewable phases. Do not batch all phases into one commit.

### Phase 0 (current)

Safety and correctness emergency patch:

1. Fix null-safe 1X2 availability in decision metrics.
2. Enforce `NO_BET` obedience in calibration shortlist, slips, and alert pathways.
3. Stop unknown market fallback odds (`1.5`) and stop deriving fake bookmaker odds.
4. Remove fallback behavior that forces candidates when thresholds are not met.
5. Add baseline safety tests and `npm test` scripts.
6. Resolve broken lint command state (configure or neutralize intentionally).

### Phase 1

Canonical market keys, decision states, value engine contract, and manual odds input flow.

### Phase 2

Data provenance hardening and LLM numeric containment.

### Phase 3+

Competition-season profiles, unified live model, unattended alerts, settlement and calibration loop completion, then controlled staking.

## Session Restart Checklist

When continuity is lost and a new coding session starts:

1. Read `README.md` and this guide.
2. Read `docs/Sporty-Rabbi_Copilot_Hardening_Directive.md` completely.
3. Confirm current branch head and list changed files.
4. Implement only the requested phase.
5. Run tests/build/syntax/lint before reporting.
6. Update `SESSION_CONTINUITY_LOG.md` with date, summary, files, and rollback note.
