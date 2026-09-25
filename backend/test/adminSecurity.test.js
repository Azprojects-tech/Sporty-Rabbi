import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import {
  ACCESS,
  ROUTE_POLICY,
  applyRoutePolicy,
  createAdminAuth,
  createCorsMiddleware,
  createOriginMatcher,
  extractAdminToken,
  parseAllowedOrigins,
  safeTokenEqual,
} from '../src/middleware/security.js';

const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('../../frontend/src/services/api.js', import.meta.url), 'utf8');
const TOKEN = 'test-admin-token-0123456789abcdef';

// Build a small app wired exactly like server.js (CORS → route policy → json → handlers).
async function startApp({ token, allowedOrigins } = {}) {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const app = express();
  app.use(createCorsMiddleware({ patterns: parseAllowedOrigins(allowedOrigins) }));
  const auth = createAdminAuth({ getToken: () => token, logger });
  applyRoutePolicy(app, auth);
  app.use(express.json());
  const ok = (req, res) => res.json({ ok: true, path: req.path });
  app.get('/api/test-whatsapp', ok);
  app.post('/api/test-whatsapp', ok);
  app.post('/api/quota/reset', ok);
  app.post('/api/calibrate', ok);
  app.get('/api/calibrate/results', ok);
  app.get('/api/debug/live-raw', ok);
  app.get('/api/debug/upcoming-sources', ok);
  app.post('/api/predictions/settle', ok);
  app.get('/api/predictions', ok);
  app.post('/api/analyze/natural', ok);
  app.post('/api/analyze', ok);
  app.post('/api/bet-value', ok);
  app.get('/api/bets', ok);
  app.post('/api/bets', ok);
  app.post('/api/bets/played', ok);
  app.post('/api/bets/settle', ok);
  app.patch('/api/bets/:id', ok);
  app.get('/api/health', ok);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, headers = {}) => fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : '{}',
  });
  return { call, warnings, close: () => new Promise((r) => server.close(r)) };
}

const ADMIN_CASES = [
  ['GET', '/api/test-whatsapp'],
  ['HEAD', '/api/test-whatsapp'],
  ['POST', '/api/test-whatsapp'],
  ['GET', '/API/Test-WhatsApp/'], // Express routing is case-insensitive and ignores a trailing slash
  ['POST', '/api/quota/reset'],
  ['POST', '/api/calibrate'],
  ['GET', '/api/debug/live-raw'],
  ['GET', '/api/debug/upcoming-sources'],
  ['GET', '/API/DEBUG/live-raw'],
  ['POST', '/api/predictions/settle'],
  ['POST', '/api/analyze/natural'],
  ['PATCH', '/api/bets/123'],
];
const UI_WRITE_CASES = [
  ['POST', '/api/bets'],
  ['POST', '/api/bets/played'],
  ['POST', '/api/bets/settle'],
];
const PUBLIC_CASES = [
  ['GET', '/api/health'],
  ['GET', '/api/bets'],
  ['GET', '/api/predictions'],
  ['GET', '/api/calibrate/results'],
  ['POST', '/api/analyze'],
  ['POST', '/api/bet-value'],
];

test('safeTokenEqual compares in constant time and rejects empty/mismatched values', () => {
  assert.equal(safeTokenEqual(TOKEN, TOKEN), true);
  assert.equal(safeTokenEqual(TOKEN + 'x', TOKEN), false);
  assert.equal(safeTokenEqual('short', TOKEN), false);
  assert.equal(safeTokenEqual('', ''), false);
  assert.equal(safeTokenEqual(undefined, TOKEN), false);
  assert.equal(safeTokenEqual(TOKEN, null), false);
});

test('extractAdminToken reads Bearer and x-admin-token headers', () => {
  assert.equal(extractAdminToken({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN);
  assert.equal(extractAdminToken({ headers: { authorization: `bearer   ${TOKEN}` } }), TOKEN);
  assert.equal(extractAdminToken({ headers: { 'x-admin-token': ` ${TOKEN} ` } }), TOKEN);
  assert.equal(extractAdminToken({ headers: { authorization: `Basic ${TOKEN}` } }), null);
  assert.equal(extractAdminToken({ headers: {} }), null);
});

test('ADMIN_TOKEN unset: admin routes fail closed (503), UI writes stay open with one warning', async () => {
  const app = await startApp({ token: undefined });
  try {
    for (const [method, path] of ADMIN_CASES) {
      const res = await app.call(method, path);
      assert.equal(res.status, 503, `${method} ${path}`);
      if (method !== 'HEAD') assert.equal((await res.json()).code, 'ADMIN_TOKEN_NOT_CONFIGURED');
    }
    for (const [method, path] of [...UI_WRITE_CASES, ...UI_WRITE_CASES]) {
      assert.equal((await app.call(method, path)).status, 200, `${method} ${path}`);
    }
    for (const [method, path] of PUBLIC_CASES) {
      assert.equal((await app.call(method, path)).status, 200, `${method} ${path}`);
    }
    const openWarnings = app.warnings.filter((w) => w.includes('ADMIN_TOKEN is not set'));
    assert.equal(openWarnings.length, 1, 'warning is logged once per process');
  } finally { await app.close(); }
});

test('ADMIN_TOKEN set: admin and UI write routes need the correct token; reads stay open', async () => {
  const app = await startApp({ token: TOKEN });
  try {
    for (const [method, path] of [...ADMIN_CASES, ...UI_WRITE_CASES]) {
      const missing = await app.call(method, path);
      assert.equal(missing.status, 401, `${method} ${path} without token`);
      if (method !== 'HEAD') assert.equal((await missing.json()).code, 'ADMIN_TOKEN_REQUIRED');

      const wrong = await app.call(method, path, { authorization: 'Bearer wrong-token' });
      assert.equal(wrong.status, 401, `${method} ${path} wrong token`);
      if (method !== 'HEAD') assert.equal((await wrong.json()).code, 'ADMIN_TOKEN_INVALID');

      assert.equal((await app.call(method, path, { authorization: `Bearer ${TOKEN}` })).status, 200, `${method} ${path} bearer`);
      assert.equal((await app.call(method, path, { 'x-admin-token': TOKEN })).status, 200, `${method} ${path} x-admin-token`);
    }
    for (const [method, path] of PUBLIC_CASES) {
      assert.equal((await app.call(method, path)).status, 200, `${method} ${path}`);
    }
  } finally { await app.close(); }
});

test('CORS allows the Netlify site, its deploy previews and localhost only', () => {
  const allowed = createOriginMatcher(parseAllowedOrigins(undefined));
  for (const origin of [
    'https://sporty-rabbi.netlify.app',
    'https://deploy-preview-42--sporty-rabbi.netlify.app',
    'https://security-admin-token--sporty-rabbi.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:4173',
  ]) assert.equal(allowed(origin), true, origin);
  for (const origin of [
    'https://evil.example',
    'http://sporty-rabbi.netlify.app',
    'https://sporty-rabbi.netlify.app.evil.example',
    'https://x--sporty-rabbi.netlify.app.evil.example',
    'https://a.b--sporty-rabbi.netlify.app',
    'https://other-site.netlify.app',
    'http://localhost.evil.example:5173',
    'null',
    '',
    undefined,
  ]) assert.equal(allowed(origin), false, String(origin));
});

test('ALLOWED_ORIGINS overrides the default list; "*" is an explicit allow-all', () => {
  const custom = createOriginMatcher(parseAllowedOrigins('https://example.com, https://*.example.org/'));
  assert.equal(custom('https://example.com'), true);
  assert.equal(custom('https://app.example.org'), true);
  assert.equal(custom('https://sporty-rabbi.netlify.app'), false);
  assert.equal(createOriginMatcher(parseAllowedOrigins('*'))('https://anything.example'), true);
  assert.deepEqual(parseAllowedOrigins('  '), parseAllowedOrigins(undefined));
});

test('CORS middleware echoes allowed origins and answers preflight', async () => {
  const app = await startApp({ token: TOKEN });
  try {
    const good = await app.call('GET', '/api/health', { origin: 'https://sporty-rabbi.netlify.app' });
    assert.equal(good.headers.get('access-control-allow-origin'), 'https://sporty-rabbi.netlify.app');
    assert.match(good.headers.get('vary') || '', /Origin/i);

    const bad = await app.call('GET', '/api/health', { origin: 'https://evil.example' });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);

    const noOrigin = await app.call('GET', '/api/health');
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);

    const preflight = await app.call('OPTIONS', '/api/bets', {
      origin: 'https://deploy-preview-7--sporty-rabbi.netlify.app',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://deploy-preview-7--sporty-rabbi.netlify.app');
    assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
    assert.match(preflight.headers.get('access-control-allow-headers'), /X-Admin-Token/);

    const badPreflight = await app.call('OPTIONS', '/api/bets', { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
    assert.equal(badPreflight.status, 403);
    assert.equal(badPreflight.headers.get('access-control-allow-origin'), null);
  } finally { await app.close(); }
});

test('server.js wires CORS and the route policy before any route handler and drops wildcard CORS', () => {
  const corsAt = serverSource.indexOf('app.use(createCorsMiddleware(');
  const policyAt = serverSource.indexOf('applyRoutePolicy(app, adminAuth)');
  const firstRoute = serverSource.search(/app\.(get|post|put|patch|delete|all)\(\s*'\/api/);
  assert.ok(corsAt > 0 && policyAt > corsAt, 'CORS then policy');
  assert.ok(firstRoute > policyAt, 'policy registered before the first /api route');
  assert.doesNotMatch(serverSource, /'Access-Control-Allow-Origin':\s*'\*'/);
});

test('every state-changing or side-effect route in server.js is classified', () => {
  const routes = [...serverSource.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
    .map(([, method, path]) => ({ method, path }));
  const classified = (method, path) => ROUTE_POLICY.some((r) =>
    (r.prefix ? path.toLowerCase().startsWith(r.path) : r.path === path) && (r.method === method || r.method === 'all'));
  // Non-GET routes that intentionally stay public: read-only computations used by match views.
  const PUBLIC_NON_GET = new Set(['post /api/analyze', 'post /api/bet-value']);
  for (const { method, path } of routes) {
    if (method === 'get') continue;
    assert.ok(classified(method, path) || PUBLIC_NON_GET.has(`${method} ${path}`),
      `${method.toUpperCase()} ${path} must be listed in ROUTE_POLICY or the public allowlist`);
  }
  // GET routes with side effects must be admin-only.
  for (const path of ['/api/test-whatsapp', '/api/debug/live-raw', '/api/debug/upcoming-sources']) {
    assert.ok(routes.some((r) => r.method === 'get' && r.path === path), `${path} still exists`);
    assert.ok(classified('get', path), `GET ${path} is protected`);
  }
  for (const rule of ROUTE_POLICY) assert.ok(Object.values(ACCESS).includes(rule.access));
});

test('cron jobs call functions directly, not the protected HTTP routes', () => {
  const cronBlocks = [...serverSource.matchAll(/cron\.schedule\([\s\S]*?\n\}, \{ timezone/g)].map((m) => m[0]);
  assert.ok(cronBlocks.length >= 2);
  for (const block of cronBlocks) {
    assert.doesNotMatch(block, /\/api\//);
    assert.doesNotMatch(block, /axios|fetch\(/);
  }
  assert.doesNotMatch(serverSource, /(axios\.\w+|fetch)\(\s*[`'"]https?:\/\/(localhost|127\.0\.0\.1)/);
});

test('frontend sends a stored admin token on writes only and never hard-codes one', () => {
  assert.match(apiSource, /localStorage\.getItem\(ADMIN_TOKEN_KEY\)/);
  assert.match(apiSource, /method !== 'get' && method !== 'head'/);
  assert.match(apiSource, /Authorization = `Bearer \$\{token\}`/);
  assert.match(apiSource, /ADMIN_TOKEN_REQUIRED/);
  assert.doesNotMatch(apiSource, /ADMIN_TOKEN\s*=\s*['"`][^'"`]+['"`]/);
  assert.doesNotMatch(apiSource, /VITE_ADMIN_TOKEN/);
});
