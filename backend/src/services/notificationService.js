import { Twilio } from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilio = new Twilio(accountSid, authToken);
const whatsappNumber = process.env.TWILIO_WHATSAPP_NUMBER;

export async function sendWhatsAppAlert(phoneNumber, message) {
  if (!accountSid || !authToken) {
    console.warn('Twilio not configured - skipping WhatsApp alert');
    return { success: false, reason: 'not_configured' };
  }

  try {
    const result = await twilio.messages.create({
      from: whatsappNumber,
      to: `whatsapp:${phoneNumber}`,
      body: message,
    });

    console.log(`✓ WhatsApp alert sent to ${phoneNumber}: ${result.sid}`);
    return { success: true, messageId: result.sid };
  } catch (error) {
    console.error('Failed to send WhatsApp alert:', error.message);
    return { success: false, error: error.message };
  }
}

export async function sendSMSAlert(phoneNumber, message) {
  if (!accountSid || !authToken) {
    console.warn('Twilio not configured - skipping SMS alert');
    return { success: false, reason: 'not_configured' };
  }

  try {
    const result = await twilio.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber,
      body: message,
    });

    console.log(`✓ SMS alert sent to ${phoneNumber}: ${result.sid}`);
    return { success: true, messageId: result.sid };
  } catch (error) {
    console.error('Failed to send SMS alert:', error.message);
    return { success: false, error: error.message };
  }
}

export function formatAlertMessage(alert) {
  return `🎯 *Betting Alert*\n\n${alert.title}\n\n${alert.description}\n\n📊 Confidence: ${alert.confidence_score}%\n\n💡 Bet: ${alert.recommended_bet}\n\n👉 Place bet at SportyBet: sportybet.com`;
}
