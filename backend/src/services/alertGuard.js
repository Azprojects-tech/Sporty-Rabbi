/**
 * In-memory safety cap for outgoing alerts (any channel).
 *
 *  - ALERT_MAX_PER_DAY    (default 30): at most this many alerts per rolling 24 hours.
 *  - ALERT_DEDUP_MINUTES  (default 60): skip a message identical to one sent within this
 *                                       many minutes. 0 disables the duplicate filter.
 *
 * Counts reset when the server restarts (in-memory by design).
 */
import { createHash } from 'node:crypto';

export const DEFAULT_ALERT_MAX_PER_DAY = 30;
export const DEFAULT_ALERT_DEDUP_MINUTES = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseIntSetting(raw, fallback, min) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const n = Number(text);
  return Number.isSafeInteger(n) && n >= min ? n : fallback;
}

export function readAlertGuardSettings(env = process.env) {
  return {
    maxPerDay: parseIntSetting(env?.ALERT_MAX_PER_DAY, DEFAULT_ALERT_MAX_PER_DAY, 1),
    dedupMinutes: parseIntSetting(env?.ALERT_DEDUP_MINUTES, DEFAULT_ALERT_DEDUP_MINUTES, 0),
  };
}

function messageKey(text) {
  return createHash('sha256').update(String(text ?? '').trim(), 'utf8').digest('hex');
}

export function createAlertGuard({
  maxPerDay = DEFAULT_ALERT_MAX_PER_DAY,
  dedupMinutes = DEFAULT_ALERT_DEDUP_MINUTES,
  now = Date.now,
} = {}) {
  const dedupMs = dedupMinutes * 60 * 1000;
  const sent = []; // { at, key } in send order

  const prune = (t) => {
    for (let i = sent.length - 1; i >= 0; i -= 1) {
      if (t - sent[i].at >= DAY_MS) sent.splice(i, 1);
    }
  };

  /**
   * Reserve a slot for this message. Call release() if the send fails so a failed
   * attempt does not use up the daily allowance or block a retry.
   */
  function reserve(text) {
    const t = now();
    prune(t);
    const key = messageKey(text);
    if (dedupMs > 0 && sent.some((e) => e.key === key && t - e.at < dedupMs)) {
      return { allowed: false, reason: 'duplicate', detail: `identical message already sent in the last ${dedupMinutes} min` };
    }
    if (sent.length >= maxPerDay) {
      return { allowed: false, reason: 'daily-cap', detail: `daily cap of ${maxPerDay} alerts per 24h reached` };
    }
    const entry = { at: t, key };
    sent.push(entry);
    return {
      allowed: true,
      release() {
        const i = sent.indexOf(entry);
        if (i >= 0) sent.splice(i, 1);
      },
    };
  }

  function stats() {
    prune(now());
    return { sentLast24h: sent.length, maxPerDay, dedupMinutes };
  }

  return { reserve, stats };
}
