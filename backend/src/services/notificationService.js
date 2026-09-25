/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║                 SPORTYRABBI ALERT NOTIFICATIONS              ║
 * ║   Telegram bot (preferred) with Twilio WhatsApp fallback     ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Channel selection (checked on every send):
 *   - TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID both set → Telegram is the active channel.
 *   - Otherwise → the existing Twilio WhatsApp code below is used unchanged.
 *
 * Every alert (either channel) passes the safety cap in alertGuard.js:
 *   ALERT_MAX_PER_DAY (default 30 per rolling 24h) and ALERT_DEDUP_MINUTES (default 60).
 *
 * Exported names kept for existing call sites: sendWhatsApp, sendBettingAlert, twilioEnabled.
 * sendWhatsApp() now means "send an alert on the active channel".
 */

import twilio from 'twilio';
import { getTelegramConfig, sendTelegramMessage, redactToken } from './telegramService.js';
import { createAlertGuard, readAlertGuardSettings } from './alertGuard.js';

// ─── Twilio WhatsApp (fallback channel) ──────────────────────────────────────

const SID       = process.env.TWILIO_ACCOUNT_SID;
const TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const NODE_ENV  = process.env.NODE_ENV || 'development';
const IS_PROD   = NODE_ENV === 'production';
// FROM must be in format: whatsapp:+14155238886 (Twilio sandbox or approved sender)
const FROM      = process.env.TWILIO_WHATSAPP_FROM || '';
// TO must be your phone in format: whatsapp:+2348012345678
// TWILIO_WHATSAPP_TO is canonical; ALERT_PHONE_NUMBER remains backward compatible.
const _TO_RAW   = process.env.TWILIO_WHATSAPP_TO || process.env.ALERT_PHONE_NUMBER || '';
const TO        = _TO_RAW && !_TO_RAW.startsWith('whatsapp:') ? `whatsapp:${_TO_RAW}` : _TO_RAW;

const anyTwilioConfig = Boolean(SID || TOKEN || FROM || TO);
const missingTwilioVars = [
  !SID && 'TWILIO_ACCOUNT_SID',
  !TOKEN && 'TWILIO_AUTH_TOKEN',
  !FROM && 'TWILIO_WHATSAPP_FROM',
  !TO && 'TWILIO_WHATSAPP_TO (or ALERT_PHONE_NUMBER)',
].filter(Boolean);

if (IS_PROD && anyTwilioConfig && missingTwilioVars.length > 0) {
  throw new Error(`[WhatsApp] Invalid production Twilio configuration. Missing: ${missingTwilioVars.join(', ')}`);
}

const ENABLED = Boolean(SID && TOKEN && FROM && TO);
const telegramAtStartup = getTelegramConfig(process.env);

let client = null;
if (ENABLED) {
  client = twilio(SID, TOKEN);
  console.log(`[WhatsApp] Twilio ready → ${TO}${telegramAtStartup.enabled ? ' (fallback only; Telegram is active)' : ''}`);
} else if (!telegramAtStartup.enabled) {
  console.warn('[WhatsApp] Twilio not configured — alerts disabled. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (preferred), or TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, and TWILIO_WHATSAPP_TO (or ALERT_PHONE_NUMBER).');
}

/**
 * Send a WhatsApp message through Twilio (the original sender, used as fallback).
 * Twilio "accepting" a message does not mean it was delivered (e.g. sandbox error 63015
 * is reported later, asynchronously), so the log says "accepted", not "sent".
 * @param {string} body — plain text message
 * @returns {Promise<{success: boolean, sid?: string, error?: string}>}
 */
async function sendViaTwilioWhatsApp(body) {
  if (!ENABLED || !client) {
    return { success: false, error: 'Twilio not configured' };
  }
  try {
    const msg = await client.messages.create({ from: FROM, to: TO, body });
    console.log(`[WhatsApp] Accepted by Twilio (not confirmed delivered): ${msg.sid}`);
    return { success: true, sid: msg.sid };
  } catch (err) {
    console.error('[WhatsApp] Send failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── Channel routing + safety cap ────────────────────────────────────────────

function preview(text) {
  const firstLine = String(text ?? '').split('\n').find((l) => l.trim()) || '';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}

/**
 * Build a notifier. Exposed for tests (inject env, fetch, WhatsApp sender, clock, logger).
 */
export function createNotifier({
  env = process.env,
  fetchImpl = (...args) => globalThis.fetch(...args),
  whatsAppSender = sendViaTwilioWhatsApp,
  whatsAppEnabled = ENABLED,
  now = Date.now,
  logger = console,
} = {}) {
  const guard = createAlertGuard({ ...readAlertGuardSettings(env), now });

  function getActiveChannel() {
    if (getTelegramConfig(env).enabled) return 'telegram';
    return whatsAppEnabled ? 'whatsapp' : 'none';
  }

  async function deliver(channel, text) {
    if (channel === 'telegram') {
      const { token, chatId } = getTelegramConfig(env);
      let result;
      try {
        result = await sendTelegramMessage({ token, chatId, text, fetchImpl });
      } catch (err) {
        result = { success: false, error: redactToken(err?.message || 'Unknown error', token) };
      }
      if (result.success) {
        const partInfo = result.parts > 1 ? ` in ${result.parts} parts` : '';
        logger.log(`[Telegram] Alert delivered${partInfo} (Telegram ok: true, message_id ${result.messageIds.join(', ')})`);
      } else {
        logger.error(`[Telegram] Send failed: ${redactToken(result.error, token)}`);
      }
      return { channel, ...result };
    }
    // WhatsApp fallback: original code path (it does its own logging).
    const result = await whatsAppSender(text);
    return { channel, ...result };
  }

  /**
   * Send an alert on the active channel, subject to the daily cap and duplicate filter.
   * @returns {Promise<{success: boolean, channel: string, skipped?: boolean, reason?: string, error?: string}>}
   */
  async function sendAlert(body) {
    const text = String(body ?? '');
    const channel = getActiveChannel();
    if (channel === 'none') {
      // Nothing configured: keep the original "Twilio not configured" result, no cap bookkeeping.
      const result = await whatsAppSender(text);
      return { channel, ...result };
    }

    const slot = guard.reserve(text);
    if (!slot.allowed) {
      logger.warn(`[Alerts] Skipped alert (${slot.reason}: ${slot.detail}): "${preview(text)}"`);
      return { success: false, channel, skipped: true, reason: slot.reason, error: `Skipped: ${slot.detail}` };
    }

    const result = await deliver(channel, text);
    if (!result.success) slot.release();
    return result;
  }

  /** Send a short test message on the active channel and report the outcome. */
  async function sendTestAlert(message) {
    const channel = getActiveChannel();
    const label = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    const text = message
      || `🐰 SportyRabbi test alert (${label}) — ${new Date(now()).toLocaleTimeString('en-GB', { timeZone: 'Europe/London' })} UK time. Alerts are working ✅`;
    const result = await sendAlert(text);
    return {
      channel: result.channel,
      ok: Boolean(result.success),
      error: result.success ? null
        : result.channel === 'none' ? 'No alert channel configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or the Twilio WhatsApp variables)'
        : (result.error || 'Unknown error'),
      ...(result.skipped ? { skipped: true, reason: result.reason } : {}),
      ...(result.sid ? { sid: result.sid } : {}),
      ...(result.messageIds ? { messageIds: result.messageIds } : {}),
      ...(result.channel === 'whatsapp' && result.success ? { note: 'Accepted by Twilio, not confirmed delivered' } : {}),
    };
  }

  return { sendAlert, sendTestAlert, getActiveChannel, getGuardStats: () => guard.stats() };
}

const notifier = createNotifier();

if (telegramAtStartup.enabled) {
  console.log('[Alerts] Telegram bot configured — alerts go to Telegram.');
} else if (telegramAtStartup.partial) {
  console.warn(`[Alerts] Telegram partially configured (missing ${telegramAtStartup.missing.join(', ')}) — using WhatsApp fallback.`);
}
{
  const s = notifier.getGuardStats();
  console.log(`[Alerts] Safety cap: max ${s.maxPerDay} alerts per 24h, duplicate filter ${s.dedupMinutes} min.`);
}

export const sendAlert = notifier.sendAlert;
export const sendTestAlert = notifier.sendTestAlert;
export const getActiveAlertChannel = notifier.getActiveChannel;
export const getAlertGuardStats = notifier.getGuardStats;

/**
 * Send an alert message on the active channel (Telegram if configured, else WhatsApp).
 * Name kept for backward compatibility with existing call sites.
 * @param {string} body — plain text message
 */
export async function sendWhatsApp(body) {
  return notifier.sendAlert(body);
}

/**
 * Send a betting opportunity alert.
 */
export async function sendBettingAlert({ home, away, league, confidence, recommendation, odds }) {
  // WhatsApp renders *text* as bold; Telegram plain text would show the asterisks.
  const bold = (s) => (getActiveAlertChannel() === 'telegram' ? s : `*${s}*`);
  const lines = [
    `🎯 ${bold('SportyRabbi Alert')}`,
    ``,
    `⚽ ${home} vs ${away}`,
    `🏆 ${league}`,
    ``,
    `📊 Confidence: ${bold(`${confidence}%`)}`,
    `💡 Bet: ${bold(recommendation)}`,
    odds ? `💰 Odds: ${odds}` : null,
    ``,
    `🔗 https://sporty-rabbi.netlify.app`,
  ].filter(l => l !== null).join('\n');

  return sendWhatsApp(lines);
}

export const twilioEnabled = ENABLED;
export const telegramEnabled = telegramAtStartup.enabled;
