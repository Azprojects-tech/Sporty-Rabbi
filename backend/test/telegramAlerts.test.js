import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/services/notificationService.js';
import { splitMessage, redactToken, sendTelegramMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from '../src/services/telegramService.js';
import { createAlertGuard, readAlertGuardSettings } from '../src/services/alertGuard.js';

// Fake credentials only — no real network is ever used in these tests.
const FAKE_TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijklmn';
const FAKE_CHAT = '987654321';
const TG_ENV = { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: FAKE_CHAT };

function mockFetch(responder = () => ({ ok: true, result: { message_id: 1 } })) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const payload = await responder(body, calls.length);
    return { status: payload?.ok ? 200 : (payload?.error_code || 400), json: async () => payload };
  };
  fn.calls = calls;
  return fn;
}

function mockWhatsApp(result = { success: true, sid: 'SM_fake' }) {
  const calls = [];
  const fn = async (body) => { calls.push(body); return result; };
  fn.calls = calls;
  return fn;
}

function captureLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { log: push, warn: push, error: push, lines, text: () => lines.join('\n') };
}

function makeNotifier({ env = TG_ENV, fetchImpl = mockFetch(), whatsApp = mockWhatsApp(), whatsAppEnabled = true, clock } = {}) {
  const logger = captureLogger();
  const notifier = createNotifier({ env, fetchImpl, whatsAppSender: whatsApp, whatsAppEnabled, logger, now: clock ? () => clock.t : Date.now });
  return { notifier, fetchImpl, whatsApp, logger };
}

test('Telegram is used when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are both set', async () => {
  const { notifier, fetchImpl, whatsApp, logger } = makeNotifier();
  assert.equal(notifier.getActiveChannel(), 'telegram');
  const result = await notifier.sendAlert('Goal alert: A vs B');
  assert.equal(result.success, true);
  assert.equal(result.channel, 'telegram');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(whatsApp.calls.length, 0);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.body, { chat_id: FAKE_CHAT, text: 'Goal alert: A vs B' });
  assert.equal('parse_mode' in call.body, false, 'plain text, no parse_mode');
  assert.match(logger.text(), /\[Telegram\] Alert delivered/);
  assert.equal(logger.text().includes(FAKE_TOKEN), false, 'token never logged');
});

test('falls back to the WhatsApp sender when either Telegram variable is missing', async () => {
  for (const env of [{}, { TELEGRAM_BOT_TOKEN: FAKE_TOKEN }, { TELEGRAM_CHAT_ID: FAKE_CHAT }, { TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: FAKE_CHAT }]) {
    const { notifier, fetchImpl, whatsApp } = makeNotifier({ env });
    assert.equal(notifier.getActiveChannel(), 'whatsapp');
    const result = await notifier.sendAlert('hello');
    assert.equal(result.channel, 'whatsapp');
    assert.equal(result.success, true);
    assert.equal(result.sid, 'SM_fake');
    assert.equal(fetchImpl.calls.length, 0, 'no Telegram call');
    assert.deepEqual(whatsApp.calls, ['hello']);
  }
});

test('nothing configured keeps the original "Twilio not configured" result', async () => {
  const whatsApp = mockWhatsApp({ success: false, error: 'Twilio not configured' });
  const { notifier, fetchImpl } = makeNotifier({ env: {}, whatsApp, whatsAppEnabled: false });
  assert.equal(notifier.getActiveChannel(), 'none');
  const result = await notifier.sendAlert('hello');
  assert.equal(result.success, false);
  assert.equal(result.error, 'Twilio not configured');
  assert.equal(fetchImpl.calls.length, 0);
});

test('Telegram ok:false is a failure, logged with the description, and the token is redacted', async () => {
  const fetchImpl = mockFetch(() => ({ ok: false, error_code: 400, description: `Bad Request: chat not found (bot${FAKE_TOKEN})` }));
  const { notifier, logger } = makeNotifier({ fetchImpl });
  const result = await notifier.sendAlert('hello');
  assert.equal(result.success, false);
  assert.equal(result.channel, 'telegram');
  assert.equal(result.errorCode, 400);
  assert.match(result.error, /chat not found/);
  assert.equal(result.error.includes(FAKE_TOKEN), false);
  assert.match(logger.text(), /\[Telegram\] Send failed: Bad Request: chat not found/);
  assert.doesNotMatch(logger.text(), /Alert delivered/);
  assert.equal(logger.text().includes(FAKE_TOKEN), false);
});

test('network errors are failures and never leak the token', async () => {
  const fetchImpl = async (url) => { throw new TypeError(`fetch failed for ${url}`); };
  const result = await sendTelegramMessage({ token: FAKE_TOKEN, chatId: FAKE_CHAT, text: 'x', fetchImpl });
  assert.equal(result.success, false);
  assert.match(result.error, /fetch failed/);
  assert.equal(result.error.includes(FAKE_TOKEN), false);
  assert.equal(redactToken(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`, ''), 'https://api.telegram.org/bot[REDACTED]/sendMessage');
});

test('a non-JSON / missing ok response is treated as failure', async () => {
  const fetchImpl = async () => ({ status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } });
  const result = await sendTelegramMessage({ token: FAKE_TOKEN, chatId: FAKE_CHAT, text: 'x', fetchImpl });
  assert.equal(result.success, false);
  assert.match(result.error, /HTTP 502/);
});

test('messages longer than 4096 characters are split into several Telegram messages', async () => {
  const line = 'x'.repeat(99) + '\n'; // 100 chars per line
  const long = line.repeat(100).trimEnd(); // ~10,000 chars
  const chunks = splitMessage(long);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.equal(chunks.join('\n'), long, 'splitting at newlines loses no content');

  // No newlines or spaces: hard split, never breaking an emoji surrogate pair.
  const emoji = '⚽🐰'.repeat(3000);
  const hard = splitMessage(emoji);
  for (const c of hard) {
    assert.ok(c.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
    assert.equal(/[\uD800-\uDBFF]$/.test(c), false, 'no dangling high surrogate');
  }
  assert.equal(hard.join(''), emoji);

  let id = 0;
  const fetchImpl = mockFetch(() => ({ ok: true, result: { message_id: ++id } }));
  const { notifier, logger } = makeNotifier({ fetchImpl });
  const result = await notifier.sendAlert(long);
  assert.equal(result.success, true);
  assert.equal(fetchImpl.calls.length, chunks.length);
  assert.deepEqual(fetchImpl.calls.map((c) => c.body.text), chunks);
  assert.equal(result.parts, chunks.length);
  assert.match(logger.text(), new RegExp(`in ${chunks.length} parts`));
});

test('a failing part stops the send and reports which part failed', async () => {
  const fetchImpl = mockFetch((body, n) => (n === 2 ? { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' } : { ok: true, result: { message_id: n } }));
  const result = await sendTelegramMessage({ token: FAKE_TOKEN, chatId: FAKE_CHAT, text: 'y'.repeat(9000), fetchImpl });
  assert.equal(result.success, false);
  assert.equal(result.sentParts, 1);
  assert.match(result.error, /^Part 2\/3: Too Many Requests/);
});

test('daily cap: at most ALERT_MAX_PER_DAY alerts per rolling 24 hours, skips are logged', async () => {
  const clock = { t: Date.UTC(2026, 8, 25, 12) };
  const env = { ...TG_ENV, ALERT_MAX_PER_DAY: '3', ALERT_DEDUP_MINUTES: '60' };
  const { notifier, fetchImpl, logger } = makeNotifier({ env, clock });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await notifier.sendAlert(`alert ${i}`)).success, true);
    clock.t += 60_000;
  }
  const capped = await notifier.sendAlert('alert 4');
  assert.equal(capped.success, false);
  assert.equal(capped.skipped, true);
  assert.equal(capped.reason, 'daily-cap');
  assert.equal(fetchImpl.calls.length, 3);
  assert.match(logger.text(), /\[Alerts\] Skipped alert \(daily-cap/);

  clock.t += 24 * 60 * 60 * 1000 - 3 * 60_000; // first alert is now 24h old
  assert.equal((await notifier.sendAlert('alert 5')).success, true);
  assert.equal(fetchImpl.calls.length, 4);
});

test('duplicate filter: identical message within ALERT_DEDUP_MINUTES is skipped', async () => {
  const clock = { t: Date.UTC(2026, 8, 25, 12) };
  const env = { ...TG_ENV, ALERT_DEDUP_MINUTES: '60' };
  const { notifier, fetchImpl, logger } = makeNotifier({ env, clock });
  assert.equal((await notifier.sendAlert('Same alert')).success, true);
  clock.t += 59 * 60_000;
  const dup = await notifier.sendAlert('Same alert');
  assert.equal(dup.skipped, true);
  assert.equal(dup.reason, 'duplicate');
  assert.match(logger.text(), /\[Alerts\] Skipped alert \(duplicate/);
  assert.equal((await notifier.sendAlert('Different alert')).success, true);
  clock.t += 2 * 60_000; // 61 minutes after the first send
  assert.equal((await notifier.sendAlert('Same alert')).success, true);
  assert.equal(fetchImpl.calls.length, 3);
});

test('cap and duplicate filter also protect the WhatsApp fallback', async () => {
  const env = { ALERT_MAX_PER_DAY: '2' };
  const { notifier, whatsApp } = makeNotifier({ env });
  await notifier.sendAlert('a');
  assert.equal((await notifier.sendAlert('a')).reason, 'duplicate');
  await notifier.sendAlert('b');
  assert.equal((await notifier.sendAlert('c')).reason, 'daily-cap');
  assert.deepEqual(whatsApp.calls, ['a', 'b']);
});

test('failed sends do not use up the cap or block a retry', async () => {
  let fail = true;
  const fetchImpl = mockFetch(() => (fail ? { ok: false, error_code: 500, description: 'Internal Server Error' } : { ok: true, result: { message_id: 7 } }));
  const { notifier } = makeNotifier({ env: { ...TG_ENV, ALERT_MAX_PER_DAY: '1' }, fetchImpl });
  assert.equal((await notifier.sendAlert('retry me')).success, false);
  fail = false;
  assert.equal((await notifier.sendAlert('retry me')).success, true);
  assert.equal(notifier.getGuardStats().sentLast24h, 1);
});

test('ALERT_MAX_PER_DAY / ALERT_DEDUP_MINUTES parsing uses safe defaults', () => {
  assert.deepEqual(readAlertGuardSettings({}), { maxPerDay: 30, dedupMinutes: 60 });
  assert.deepEqual(readAlertGuardSettings({ ALERT_MAX_PER_DAY: '10', ALERT_DEDUP_MINUTES: '0' }), { maxPerDay: 10, dedupMinutes: 0 });
  assert.deepEqual(readAlertGuardSettings({ ALERT_MAX_PER_DAY: 'abc', ALERT_DEDUP_MINUTES: '-5' }), { maxPerDay: 30, dedupMinutes: 60 });
  assert.deepEqual(readAlertGuardSettings({ ALERT_MAX_PER_DAY: '0' }), { maxPerDay: 30, dedupMinutes: 60 });
  const guard = createAlertGuard({ maxPerDay: 5, dedupMinutes: 0 });
  assert.equal(guard.reserve('x').allowed, true);
  assert.equal(guard.reserve('x').allowed, true, 'dedup 0 disables the duplicate filter');
});

test('sendTestAlert reports channel, ok and error', async () => {
  const good = makeNotifier();
  const r1 = await good.notifier.sendTestAlert();
  assert.equal(r1.channel, 'telegram');
  assert.equal(r1.ok, true);
  assert.equal(r1.error, null);
  assert.match(good.fetchImpl.calls[0].body.text, /SportyRabbi test alert \(Telegram\)/);

  const bad = makeNotifier({ fetchImpl: mockFetch(() => ({ ok: false, error_code: 401, description: 'Unauthorized' })) });
  const r2 = await bad.notifier.sendTestAlert();
  assert.deepEqual({ channel: r2.channel, ok: r2.ok, error: r2.error }, { channel: 'telegram', ok: false, error: 'Unauthorized' });

  const wa = makeNotifier({ env: {} });
  const r3 = await wa.notifier.sendTestAlert();
  assert.equal(r3.channel, 'whatsapp');
  assert.equal(r3.ok, true);
  assert.match(r3.note, /not confirmed delivered/);
});

test('server.js exposes POST /api/test-alert and the route is admin-only', async () => {
  const fs = await import('node:fs');
  const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(serverSource, /app\.post\('\/api\/test-alert'/);
  const { ROUTE_POLICY, ACCESS } = await import('../src/middleware/security.js');
  assert.ok(ROUTE_POLICY.some((r) => r.method === 'post' && r.path === '/api/test-alert' && r.access === ACCESS.ADMIN));
});
