import crypto from 'crypto';

const COOKIE_NAME = 'mellow_sim_session';
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FAILURE_THRESHOLD = 5;

const PUBLIC_GET_PATHS = new Set(['/version.json', '/healthz', '/login', '/login.html']);
const PUBLIC_GET_PREFIXES = ['/login-assets/'];
const PUBLIC_POST_PATHS = new Set(['/auth/login']);

function loadUsers() {
  const raw = String(process.env.AUTH_USERS || '').trim();
  if (!raw) return new Map();
  const users = new Map();
  for (const entry of raw.split(',')) {
    const parts = entry.trim().split(':');
    if (parts.length !== 3) continue;
    const [username, hash, salt] = parts.map((p) => p.trim());
    if (!username || !hash || !salt) continue;
    users.set(username.toLowerCase(), { hash: hash.toLowerCase(), salt });
  }
  return users;
}

function loadSecret() {
  const secret = String(process.env.AUTH_SECRET || '').trim();
  if (!secret) {
    throw new Error('AUTH_SECRET is required for authenticated runtime; refusing to start without it');
  }
  if (secret.length < 32) {
    throw new Error('AUTH_SECRET must be at least 32 characters');
  }
  return secret;
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function signToken(username, secret) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${encodeURIComponent(username)}.${exp}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${mac}`;
}

function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [usernameRaw, expStr, mac] = parts;
  const payload = `${usernameRaw}.${expStr}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  if (!timingSafeEqual(mac, expected)) return null;
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
  let username;
  try {
    username = decodeURIComponent(usernameRaw);
  } catch {
    return null;
  }
  if (!username) return null;
  return { username, exp };
}

function parseCookies(header) {
  if (!header || typeof header !== 'string') return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function isPublicPath(req) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (PUBLIC_GET_PATHS.has(req.path)) return true;
    for (const prefix of PUBLIC_GET_PREFIXES) {
      if (req.path.startsWith(prefix)) return true;
    }
  }
  if (req.method === 'POST' && PUBLIC_POST_PATHS.has(req.path)) return true;
  return false;
}

function readBearer(req) {
  const header = req.headers['authorization'];
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return m[1].trim();
}

function readCookieToken(req) {
  const cookies = parseCookies(req.headers['cookie']);
  return cookies[COOKIE_NAME] || null;
}

function isHtmlRequest(req) {
  const accept = req.headers['accept'] || '';
  return accept.includes('text/html') || req.path === '/' || req.path.endsWith('.html');
}

function ipOf(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

export function createAuth({ logger = console } = {}) {
  const secret = loadSecret();
  const users = loadUsers();
  if (users.size === 0) {
    throw new Error('AUTH_USERS is empty; refusing to start without at least one configured user');
  }
  const failures = new Map();

  function recordFailure(ip) {
    const now = Date.now();
    const list = (failures.get(ip) || []).filter((t) => now - t < FAILURE_WINDOW_MS);
    list.push(now);
    failures.set(ip, list);
    return list.length;
  }

  function failureCount(ip) {
    const now = Date.now();
    const list = (failures.get(ip) || []).filter((t) => now - t < FAILURE_WINDOW_MS);
    failures.set(ip, list);
    return list.length;
  }

  function clearFailures(ip) {
    failures.delete(ip);
  }

  function buildCookie(token) {
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${TOKEN_TTL_SECONDS}`,
    ];
    if (process.env.NODE_ENV === 'production') parts.push('Secure');
    return parts.join('; ');
  }

  function clearCookie() {
    const parts = [
      `${COOKIE_NAME}=`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/',
      'Max-Age=0',
    ];
    if (process.env.NODE_ENV === 'production') parts.push('Secure');
    return parts.join('; ');
  }

  function authenticate(username, password) {
    const key = String(username || '').trim().toLowerCase();
    const user = users.get(key);
    if (!user) return null;
    const computed = hashPassword(String(password || ''), user.salt);
    if (!timingSafeEqual(computed, user.hash)) return null;
    return { username: key };
  }

  function middleware() {
    return (req, res, next) => {
      if (isPublicPath(req)) return next();
      const token = readBearer(req) || readCookieToken(req);
      const claims = token ? verifyToken(token, secret) : null;
      if (!claims) {
        if (req.path.startsWith('/api/') || req.path.startsWith('/download/')) {
          res.status(401).json({ error: 'authentication required' });
        } else if (isHtmlRequest(req)) {
          res.redirect(302, `/login?next=${encodeURIComponent(req.originalUrl || req.url)}`);
        } else {
          res.status(401).end();
        }
        return;
      }
      req.user = { username: claims.username };
      next();
    };
  }

  function loginHandler() {
    return (req, res) => {
      const ip = ipOf(req);
      if (failureCount(ip) >= FAILURE_THRESHOLD) {
        res.status(429).json({ error: 'too many failed attempts; try again in 15 minutes' });
        return;
      }
      const { username, password } = req.body || {};
      const result = authenticate(username, password);
      if (!result) {
        const count = recordFailure(ip);
        logger.warn?.(`[auth] failed login from ${ip} (count=${count})`);
        res.status(401).json({ error: 'invalid credentials' });
        return;
      }
      clearFailures(ip);
      const token = signToken(result.username, secret);
      res.setHeader('Set-Cookie', buildCookie(token));
      const next = typeof req.body?.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '/';
      res.json({ ok: true, username: result.username, next, token });
    };
  }

  function logoutHandler() {
    return (_req, res) => {
      res.setHeader('Set-Cookie', clearCookie());
      res.json({ ok: true });
    };
  }

  function whoamiHandler() {
    return (req, res) => {
      res.json({ username: req.user?.username || null });
    };
  }

  return { middleware, loginHandler, logoutHandler, whoamiHandler };
}

export function deriveSaltedHash(password, saltBytes = 16) {
  const salt = crypto.randomBytes(saltBytes).toString('hex');
  const hash = hashPassword(password, salt);
  return { hash, salt };
}
