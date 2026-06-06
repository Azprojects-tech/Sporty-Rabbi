/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║            TWILIO WHATSAPP NOTIFICATION SERVICE              ║
 * ║   Sends betting alerts via WhatsApp when confidence ≥ 65%    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import twilio from 'twilio';

const SID       = process.env.TWILIO_ACCOUNT_SID;
const TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const NODE_ENV  = process.env.NODE_ENV || 'development';
const IS_PROD   = NODE_ENV === 'production';
// FROM must be in format: whatsapp:+14155238886 (Twilio sandbox or approved sender)
const FROM      = process.env.TWILIO_WHATSAPP_FROM || '';
// TO must be your phone in format: whatsapp:+2348012345678
// ALERT_PHONE_NUMBER can be stored with or without the whatsapp: prefix
const _TO_RAW   = process.env.ALERT_PHONE_NUMBER || '';
const TO        = _TO_RAW && !_TO_RAW.startsWith('whatsapp:') ? `whatsapp:${_TO_RAW}` : _TO_RAW;

const anyTwilioConfig = Boolean(SID || TOKEN || FROM || TO);
const missingTwilioVars = [
  !SID && 'TWILIO_ACCOUNT_SID',
  !TOKEN && 'TWILIO_AUTH_TOKEN',
  !FROM && 'TWILIO_WHATSAPP_FROM',
  !TO && 'ALERT_PHONE_NUMBER',
].filter(Boolean);

if (IS_PROD && anyTwilioConfig && missingTwilioVars.length > 0) {
  throw new Error(`[WhatsApp] Invalid production Twilio configuration. Missing: ${missingTwilioVars.join(', ')}`);
}

const ENABLED = Boolean(SID && TOKEN && FROM && TO);

let client = null;
if (ENABLED) {
  client = twilio(SID, TOKEN);
  console.log(`[WhatsApp] Twilio ready → ${TO}`);
} else {
  console.warn('[WhatsApp] Twilio not configured — alerts disabled. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, ALERT_PHONE_NUMBER.');
}

/**
 * Send a WhatsApp message.
 * @param {string} body — plain text message
 * @returns {Promise<{success: boolean, sid?: string, error?: string}>}
 */
export async function sendWhatsApp(body) {
  if (!ENABLED || !client) {
    return { success: false, error: 'Twilio not configured' };
  }
  try {
    const msg = await client.messages.create({ from: FROM, to: TO, body });
    console.log(`[WhatsApp] Sent: ${msg.sid}`);
    return { success: true, sid: msg.sid };
  } catch (err) {
    console.error('[WhatsApp] Send failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a betting opportunity alert.
 */
export async function sendBettingAlert({ home, away, league, confidence, recommendation, odds }) {
  const lines = [
    `🎯 *SportyRabbi Alert*`,
    ``,
    `⚽ ${home} vs ${away}`,
    `🏆 ${league}`,
    ``,
    `📊 Confidence: *${confidence}%*`,
    `💡 Bet: *${recommendation}*`,
    odds ? `💰 Odds: ${odds}` : null,
    ``,
    `🔗 https://sporty-rabbi.netlify.app`,
  ].filter(l => l !== null).join('\n');

  return sendWhatsApp(lines);
}

export const twilioEnabled = ENABLED;
