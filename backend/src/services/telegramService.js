/**
 * Telegram Bot API sender for SportyRabbi alerts.
 *
 * Uses POST https://api.telegram.org/bot<TOKEN>/sendMessage with { chat_id, text }.
 * Messages are sent as plain text (no parse_mode), so no escaping is needed.
 * Texts longer than Telegram's 4096-character limit are split into several messages.
 *
 * The bot token is a secret: it is never logged and is redacted from every error string.
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Read Telegram settings. Both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required. */
export function getTelegramConfig(env = process.env) {
  const token = String(env?.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = String(env?.TELEGRAM_CHAT_ID ?? '').trim();
  const missing = [!token && 'TELEGRAM_BOT_TOKEN', !chatId && 'TELEGRAM_CHAT_ID'].filter(Boolean);
  return {
    token,
    chatId,
    enabled: Boolean(token && chatId),
    partial: Boolean(token || chatId) && !(token && chatId),
    missing,
  };
}

/** Remove the bot token (and anything shaped like a bot token / bot URL segment) from text. */
export function redactToken(text, token) {
  let out = String(text ?? '');
  if (token) out = out.split(token).join('[REDACTED]');
  out = out.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
  out = out.replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]');
  return out;
}

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Split text into chunks of at most `max` characters (UTF-16 units, as Telegram counts).
 * Prefers breaking at a newline, then at a space; never splits an emoji surrogate pair.
 */
export function splitMessage(text, max = TELEGRAM_MAX_MESSAGE_LENGTH) {
  const s = String(text ?? '');
  if (s.length <= max) return [s];
  const chunks = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    let dropSeparator = true;
    if (cut < max / 2) {
      cut = rest.lastIndexOf(' ', max);
      if (cut < max / 2) {
        cut = max;
        dropSeparator = false;
        if (isHighSurrogate(rest.charCodeAt(cut - 1))) cut -= 1;
      }
    }
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(dropSeparator ? cut + 1 : cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function describeError(err, token) {
  const parts = [err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Request timed out' : err?.message];
  if (err?.cause?.message && err.cause.message !== err?.message) parts.push(err.cause.message);
  return redactToken(parts.filter(Boolean).join(': ') || 'Unknown error', token);
}

/**
 * Send one alert text to Telegram (split into parts when needed).
 * Success only when Telegram answers ok: true for every part.
 * @returns {Promise<{success: boolean, parts: number, sentParts: number, messageIds: number[], error?: string, errorCode?: number}>}
 */
export async function sendTelegramMessage({
  token,
  chatId,
  text,
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const body = String(text ?? '');
  if (!token || !chatId) {
    return { success: false, parts: 0, sentParts: 0, messageIds: [], error: 'Telegram not configured' };
  }
  if (!body.trim()) {
    return { success: false, parts: 0, sentParts: 0, messageIds: [], error: 'Message text is empty' };
  }

  const chunks = splitMessage(body);
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const messageIds = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const failure = (error, errorCode) => ({
      success: false,
      parts: chunks.length,
      sentParts: i,
      messageIds,
      error: chunks.length > 1 ? `Part ${i + 1}/${chunks.length}: ${error}` : error,
      ...(errorCode !== undefined ? { errorCode } : {}),
    });

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunks[i] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return failure(describeError(err, token));
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    if (!data || data.ok !== true) {
      const description = data?.description || `HTTP ${res?.status ?? '?'} without a valid Telegram response`;
      return failure(redactToken(description, token), data?.error_code ?? res?.status);
    }
    if (data.result?.message_id !== undefined) messageIds.push(data.result.message_id);
  }

  return { success: true, parts: chunks.length, sentParts: chunks.length, messageIds };
}
