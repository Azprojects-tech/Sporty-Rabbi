/**
 * SportyRabbi request security: admin token checks, route protection policy, CORS allowlist.
 *
 * ADMIN_TOKEN (optional env var)
 *   - Admin/debug routes ('admin') ALWAYS need the token. If ADMIN_TOKEN is not set they are
 *     refused with 503 (fail closed).
 *   - Write routes the portal UI uses ('ui-write') need the token once ADMIN_TOKEN is set.
 *     While it is unset they stay open (with a one-time warning) so deploying this code
 *     before the Railway variable exists does not break the app.
 *   Accepted headers: `Authorization: Bearer <token>` or `x-admin-token: <token>`.
 *
 * ALLOWED_ORIGINS (optional env var)
 *   Comma-separated browser origins allowed by CORS. `*` inside an entry matches one host label
 *   or a port (e.g. https://*--sporty-rabbi.netlify.app, http://localhost:*). A single `*`
 *   allows every origin (emergency rollback only). When unset, DEFAULT_ALLOWED_ORIGINS apply.
 *
 * Internal cron jobs call service functions directly, never these HTTP routes, so this
 * middleware does not affect them.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const ACCESS = Object.freeze({
  ADMIN: 'admin',
  UI_WRITE: 'ui-write',
});

// Single source of truth for protected routes. Express matching rules apply
// (case-insensitive, optional trailing slash, GET also covers HEAD).
export const ROUTE_POLICY = Object.freeze([
  // Admin / debug — not used by the portal UI. Always require the token.
  { method: 'get',   path: '/api/test-whatsapp',        access: ACCESS.ADMIN,    reason: 'Sends a test alert on the active channel (Telegram or WhatsApp)' },
  { method: 'post',  path: '/api/test-whatsapp',        access: ACCESS.ADMIN,    reason: 'Sends an arbitrary alert message on the active channel' },
  { method: 'post',  path: '/api/test-alert',           access: ACCESS.ADMIN,    reason: 'Sends a short test alert on the active channel (Telegram or WhatsApp)' },
  { method: 'post',  path: '/api/quota/reset',          access: ACCESS.ADMIN,    reason: 'Clears the API-Football quota guard' },
  { method: 'post',  path: '/api/calibrate',            access: ACCESS.ADMIN,    reason: 'Starts a full daily preparation scan (API quota)' },
  { method: 'all',   path: '/api/debug',                access: ACCESS.ADMIN,    reason: 'Debug routes spend API-Football quota', prefix: true },
  { method: 'post',  path: '/api/predictions/settle',   access: ACCESS.ADMIN,    reason: 'Settles the prediction ledger (cron calls the function directly)' },
  { method: 'post',  path: '/api/analyze/natural',      access: ACCESS.ADMIN,    reason: 'Free-text LLM analysis (LLM cost); no UI caller' },
  { method: 'patch', path: '/api/bets/:id',             access: ACCESS.ADMIN,    reason: 'Overwrites any stored bet; no UI caller' },
  // Write routes the portal UI uses. Token required once ADMIN_TOKEN is set.
  { method: 'post',  path: '/api/bets',                 access: ACCESS.UI_WRITE, reason: 'Log a bet (Bet logger form)' },
  { method: 'post',  path: '/api/bets/played',          access: ACCESS.UI_WRITE, reason: 'Record a played recommendation (match detail)' },
  { method: 'post',  path: '/api/bets/settle',          access: ACCESS.UI_WRITE, reason: '"Check results" in Performance (API-Football calls)' },
]);

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  'https://sporty-rabbi.netlify.app',
  'https://*--sporty-rabbi.netlify.app', // Netlify deploy previews / branch deploys
  'http://localhost:*',
  'http://127.0.0.1:*',
]);
export { DEFAULT_ALLOWED_ORIGINS };

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

/** Constant-time string comparison (hashing first removes the length leak). */
export function safeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  return timingSafeEqual(sha256(provided), sha256(expected));
}

export function extractAdminToken(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const header = req.headers?.['x-admin-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

export function createAdminAuth({ getToken = () => process.env.ADMIN_TOKEN, logger = console } = {}) {
  let warnedOpen = false;
  let warnedShort = false;

  const configuredToken = () => {
    const token = String(getToken() ?? '').trim();
    if (token && token.length < 24 && !warnedShort) {
      warnedShort = true;
      logger.warn('[Security] ADMIN_TOKEN is shorter than 24 characters; use a long random value.');
    }
    return token || null;
  };

  const checkToken = (req, res, next, expected) => {
    const provided = extractAdminToken(req);
    if (!provided) {
      return res.status(401).json({ error: 'Admin token required.', code: 'ADMIN_TOKEN_REQUIRED' });
    }
    if (!safeTokenEqual(provided, expected)) {
      return res.status(401).json({ error: 'Admin token is invalid.', code: 'ADMIN_TOKEN_INVALID' });
    }
    return next();
  };

  /** Admin/debug routes: always require the token; fail closed if ADMIN_TOKEN is unset. */
  function requireAdmin(req, res, next) {
    const expected = configuredToken();
    if (!expected) {
      return res.status(503).json({
        error: 'This admin endpoint is disabled because ADMIN_TOKEN is not configured on the server.',
        code: 'ADMIN_TOKEN_NOT_CONFIGURED',
      });
    }
    return checkToken(req, res, next, expected);
  }

  /** UI write routes: require the token when ADMIN_TOKEN is set; otherwise allow with a one-time warning. */
  function requireAdminWhenConfigured(req, res, next) {
    const expected = configuredToken();
    if (!expected) {
      if (!warnedOpen) {
        warnedOpen = true;
        logger.warn('[Security] ADMIN_TOKEN is not set — portal write routes (bets, played bets, result checks) are open to anyone. Set ADMIN_TOKEN in Railway to protect them.');
      }
      return next();
    }
    return checkToken(req, res, next, expected);
  }

  return { requireAdmin, requireAdminWhenConfigured, isConfigured: () => Boolean(configuredToken()) };
}

/** Register the route policy guards on an Express app. Call BEFORE the route handlers. */
export function applyRoutePolicy(app, auth, policy = ROUTE_POLICY) {
  for (const rule of policy) {
    const guard = rule.access === ACCESS.ADMIN ? auth.requireAdmin : auth.requireAdminWhenConfigured;
    if (rule.prefix) {
      // app.use matches the path and everything below it (e.g. /api/debug/*).
      app.use(rule.path, guard);
    } else {
      app[rule.method](rule.path, guard);
    }
  }
}

// ─── CORS ──────────────────────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function parseAllowedOrigins(raw = process.env.ALLOWED_ORIGINS) {
  const list = String(raw ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return list.length > 0 ? list : [...DEFAULT_ALLOWED_ORIGINS];
}

function originPatternToRegex(pattern) {
  // '*' matches one DNS label fragment or a port number — never a dot, slash or colon.
  const source = pattern.split('*').map(escapeRegex).join('[a-z0-9-]+');
  return new RegExp(`^${source}$`, 'i');
}

export function createOriginMatcher(patterns = parseAllowedOrigins()) {
  if (patterns.includes('*')) return () => true;
  const exact = new Set(patterns.filter((p) => !p.includes('*')).map((p) => p.toLowerCase()));
  const wildcards = patterns.filter((p) => p.includes('*')).map(originPatternToRegex);
  return (origin) => {
    if (typeof origin !== 'string' || !origin) return false;
    const o = origin.toLowerCase();
    return exact.has(o) || wildcards.some((re) => re.test(o));
  };
}

export function createCorsMiddleware({ patterns = parseAllowedOrigins() } = {}) {
  const isAllowed = createOriginMatcher(patterns);
  return function corsMiddleware(req, res, next) {
    res.removeHeader('Access-Control-Allow-Origin');
    const origin = req.headers.origin;
    res.vary('Origin');
    if (origin && isAllowed(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
        'Access-Control-Allow-Headers': 'Accept, Accept-Language, Content-Language, Content-Type, Authorization, X-Admin-Token',
        'Access-Control-Max-Age': '86400',
      });
    }
    // Preflight: answer immediately. Disallowed origins get no CORS headers, so the browser blocks them.
    if (req.method === 'OPTIONS') {
      return res.status(origin && !isAllowed(origin) ? 403 : 204).end();
    }
    return next();
  };
}
