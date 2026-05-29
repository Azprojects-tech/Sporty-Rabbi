/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║            TWILIO WHATSAPP NOTIFICATION SERVICE              ║
 * ║   Sends betting alerts via WhatsApp when confidence ≥ 65%    ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

import twilio from 'twilio';

const SID       = process.env.TWILIO_ACCOUNT_SID;
const TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const FROM      = process.env.TWILIO_WHATSAPP_FROM  || 'whatsapp:+14155238886';
const TO        = process.env.ALERT_PHONE_NUMBER;

const ENABLED = Boolean(SID && TOKEN && TO);

let client = null;
if (ENABLED) {
  client = twilio(SID, TOKEN);
  console.log(`[WhatsApp] Twilio ready → ${TO}`);
} else {
  console.warn('[WhatsApp] Twilio not configured — alerts disabled. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ALERT_PHONE_NUMBER.');
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
    `🔗 https://sporty-rabbit.netlify.app`,
  ].filter(l => l !== null).join('\n');

  return sendWhatsApp(lines);
}

export const twilioEnabled = ENABLED;
