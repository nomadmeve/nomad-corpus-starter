import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// DaoCanon public-access gate.
//
// Single-password login gate in front of the read-only DaoCanon API. It
// replaces the former two-field Caddy credential prompt so visitors only type
// one password on a dedicated login page.
//
// Boundaries:
// - listens on 127.0.0.1:3080 by default (container uses HOST=0.0.0.0,
//   host publish stays 127.0.0.1:3080);
// - the token is a self-describing PBKDF2-SHA256 hash; plaintext passwords
//   are never stored;
// - sessions are random IDs in an in-memory set; restart means re-login;
// - failed logins are rate-limited per address;
// - anonymous visitors are redirected to /gate-login; only /gate-health and
//   the login page are reachable without a session;
// - proxy errors return a safe JSON envelope without path or stack leakage.

const MAX_PASSWORD_LENGTH = 1000;
const MAX_LOGIN_BODY_BYTES = 8192;
const MAX_NEXT_LENGTH = 512;
const SESSION_COOKIE = 'daocanon_session';
const PBKDF2_KEY_LENGTH = 32;
const DEFAULT_MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 5 * 60 * 1000;

function parsePort(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw);
  if (!/^[0-9]+$/.test(s)) {
    throw new RangeError(`PORT must be a decimal integer, got "${s}"`);
  }
  const n = Number(s);
  if (n < 1 || n > 65535) {
    throw new RangeError(`PORT out of range 1..65535: ${n}`);
  }
  return n;
}

function parseHost(raw) {
  if (raw === undefined || raw === null) return '127.0.0.1';
  const host = String(raw);
  if (host === '127.0.0.1' || host === '0.0.0.0') return host;
  throw new RangeError(`HOST must be 127.0.0.1 or 0.0.0.0, got "${host}"`);
}

export function parseGateToken(raw) {
  const s = String(raw ?? '');
  const parts = s.split('.');
  if (parts.length !== 5) {
    throw new RangeError('DAO_CANON_GATE_TOKEN must have the shape scheme.digest.iterations.salt.hash');
  }
  const [scheme, digest, iterationsRaw, salt, hash] = parts;
  if (scheme !== 'pbkdf2' || digest !== 'sha256') {
    throw new RangeError('DAO_CANON_GATE_TOKEN must be pbkdf2.sha256');
  }
  if (!/^[0-9]+$/.test(iterationsRaw)) {
    throw new RangeError('DAO_CANON_GATE_TOKEN iterations must be a decimal integer');
  }
  const iterations = Number(iterationsRaw);
  if (iterations < 10_000) {
    throw new RangeError('DAO_CANON_GATE_TOKEN iterations must be at least 10000');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(salt) || !/^[A-Za-z0-9_-]+$/.test(hash)) {
    throw new RangeError('DAO_CANON_GATE_TOKEN salt and hash must be base64url');
  }
  return { scheme, digest, iterations, salt, hash };
}

export function createGateToken(password, iterations = 120_000) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto
    .pbkdf2Sync(String(password), salt, iterations, PBKDF2_KEY_LENGTH, 'sha256')
    .toString('base64url');
  return `pbkdf2.sha256.${iterations}.${salt}.${hash}`;
}

export function verifyPassword(password, tokenString) {
  if (typeof password !== 'string' || password.length === 0) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  let token;
  try {
    token = parseGateToken(tokenString);
  } catch {
    return false;
  }
  const candidate = crypto.pbkdf2Sync(
    password,
    token.salt,
    token.iterations,
    PBKDF2_KEY_LENGTH,
    'sha256',
  );
  const expected = Buffer.from(token.hash, 'base64url');
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export function loadGateConfig(env = process.env) {
  const rawToken = env.DAO_CANON_GATE_TOKEN;
  // Throws on missing/malformed token: the gate refuses to boot without one.
  parseGateToken(rawToken);
  return {
    host: parseHost(env.HOST),
    port: parsePort(env.PORT, 3080),
    upstream: String(env.DAO_CANON_GATE_UPSTREAM || 'http://127.0.0.1:3040'),
    researchUpstream: String(
      env.DAO_CANON_GATE_RESEARCH_UPSTREAM || 'http://127.0.0.1:3060',
    ),
    dialogueUpstream: String(
      env.DAO_CANON_GATE_DIALOGUE_UPSTREAM || 'http://127.0.0.1:3070',
    ),
    agentUpstream: String(
      env.DAO_CANON_GATE_AGENT_UPSTREAM || 'http://127.0.0.1:3090',
    ),
    token: rawToken,
    maxAttempts: parsePort(env.DAO_CANON_GATE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
  };
}

export function classifyGateRoute(rawTarget) {
  const url = new URL(rawTarget, 'http://internal');
  const { pathname, search } = url;
  if (pathname === '/research' || pathname === '/research/') {
    return { target: 'research', path: `/${search}` };
  }
  if (pathname.startsWith('/research/')) {
    return {
      target: 'research',
      path: `${pathname.slice('/research'.length)}${search}`,
    };
  }
  if (
    // The dialogue orchestrator is loopback-internal and only reachable via
    // this gateway fan-out; the browser must never connect to 3070 directly.
    pathname.startsWith('/api/dialogue/')
  ) {
    return { target: 'dialogue', path: `${pathname}${search}` };
  }
  if (pathname.startsWith('/api/agent/')) {
    return { target: 'agent', path: `${pathname}${search}` };
  }
  if (
    // Static ownership is intentionally disjoint: Stage 1 serves /app.js and
    // /styles.css, while Research Web exclusively serves /assets/*. Likewise,
    // Stage 1's own UI calls /v1/*; /api/daocanon/* is the Research Web proxy
    // namespace used to compose read-only Stage 1 data into its own surface.
    pathname.startsWith('/assets/')
    || pathname.startsWith('/api/daoism-research/')
    || pathname.startsWith('/api/daocanon/')
  ) {
    return { target: 'research', path: `${pathname}${search}` };
  }
  return { target: 'daocanon', path: `${pathname}${search}` };
}

function securityHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy',
    "default-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
}

const LOGIN_PAGE = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DaoCanon 입장</title>
  <style>
    body { margin:0; min-height:100vh; display:grid; place-items:center;
      background:#f4efe6; color:#1c1915;
      font-family:"Noto Sans CJK KR","Noto Sans CJK SC","Segoe UI",sans-serif; }
    main { width:min(92vw,380px); background:#fffaf2; border:1px solid #ddd2c0;
      border-radius:16px; padding:36px 32px; box-shadow:0 10px 40px rgba(60,40,20,.08); }
    .mark { width:48px; height:48px; border-radius:13px; background:#7a3e2e; color:#fffaf2;
      display:grid; place-items:center; font-size:24px; margin-bottom:16px; }
    h1 { margin:0 0 6px; font-size:20px; }
    p.hint { margin:0 0 22px; color:#6b645a; font-size:13px; }
    label { display:block; font-size:13px; margin-bottom:8px; }
    input { width:100%; min-height:46px; padding:10px 14px; font:inherit;
      border:1px solid #ddd2c0; border-radius:10px; background:#fff; }
    button { width:100%; min-height:46px; margin-top:16px; font:inherit;
      border:0; border-radius:10px; background:#7a3e2e; color:#fffaf2; cursor:pointer; }
    button:hover { background:#63311f; }
    .error { margin:0 0 14px; color:#8c2f25; font-size:13px; }
    input:focus-visible, button:focus-visible { outline:3px solid rgba(122,62,46,.28); outline-offset:2px; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">道</div>
    <h1>DaoCanon</h1>
    <p class="hint">도장 원문 검색에 입장하려면 비밀번호를 입력하세요.</p>
    <p class="error" id="gate-error" role="alert" __ERROR_HIDDEN__>비밀번호가 맞지 않습니다.</p>
    <form method="post" action="/gate-login">
      <input type="hidden" name="next" value="__NEXT__">
      <label for="password-input">비밀번호</label>
      <input id="password-input" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">입장</button>
    </form>
  </main>
</body>
</html>`;

function sanitizeNext(raw) {
  let next;
  try {
    next = decodeURIComponent(String(raw ?? ''));
  } catch {
    return '/';
  }
  if (typeof next !== 'string' || next.length === 0 || next.length > MAX_NEXT_LENGTH) return '/';
  if (!next.startsWith('/')) return '/';
  if (next.startsWith('//')) return '/';
  if (next.includes('\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/';
  // Reject dot segments outright (same fail-closed stance as the API static
  // routes) so `next` can never escape the site root.
  if (next.split('/').some((segment) => segment === '.' || segment === '..')) return '/';
  return next;
}

function getClientAddress(req) {
  return req.socket?.remoteAddress ?? 'unknown';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > MAX_LOGIN_BODY_BYTES) {
        overflow = true;
        // Drain the rest instead of destroying the socket so the client can
        // still receive the 400 response cleanly.
        req.resume();
        reject(new Error('oversized'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflow) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function loginPageBody(next, { error = false } = {}) {
  const escapedNext = next.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return LOGIN_PAGE
    .replace('__ERROR_HIDDEN__', error ? '' : 'hidden')
    .replace('__NEXT__', escapedNext);
}

export function startGateServer({
  host,
  port,
  upstream,
  researchUpstream = upstream,
  dialogueUpstream = 'http://127.0.0.1:3070',
  agentUpstream = 'http://127.0.0.1:3090',
  token,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}) {
  const upstreamUrl = new URL(upstream);
  const researchUpstreamUrl = new URL(researchUpstream);
  const dialogueUpstreamUrl = new URL(dialogueUpstream);
  const agentUpstreamUrl = new URL(agentUpstream);
  const sessions = new Set();
  const failures = new Map();

  function isLocked(address, now) {
    const entry = failures.get(address);
    if (!entry) return false;
    if (now - entry.since > ATTEMPT_WINDOW_MS) {
      failures.delete(address);
      return false;
    }
    return entry.count >= maxAttempts;
  }

  function recordFailure(address, now) {
    const entry = failures.get(address);
    if (!entry || now - entry.since > ATTEMPT_WINDOW_MS) {
      failures.set(address, { count: 1, since: now });
    } else {
      entry.count += 1;
    }
  }

  function hasSession(req) {
    const header = req.headers.cookie;
    if (!header) return false;
    for (const part of header.split(';')) {
      const trimmed = part.trim();
      if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
        const value = trimmed.slice(SESSION_COOKIE.length + 1);
        if (value.length >= 64 && sessions.has(value)) return true;
        return false;
      }
    }
    return false;
  }

  function redirectToLogin(res, next) {
    const location = `/gate-login?next=${encodeURIComponent(next)}`;
    securityHeaders(res);
    res.writeHead(302, { location });
    res.end();
  }

  function proxyToUpstream(req, res, selectedUpstream, path) {
    const options = {
      protocol: selectedUpstream.protocol,
      hostname: selectedUpstream.hostname,
      port: selectedUpstream.port || (selectedUpstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path,
      headers: { ...req.headers, host: selectedUpstream.host },
    };
    const upstreamReq = http.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on('error', () => {
      securityHeaders(res);
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        status: 'error',
        error: { code: 'upstream_unavailable' },
      }));
    });
    req.pipe(upstreamReq);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://internal');
      const pathname = url.pathname;

      if (pathname === '/gate-health') {
        securityHeaders(res);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }

      if (pathname === '/gate-login') {
        if (req.method === 'GET') {
          const next = sanitizeNext(url.searchParams.get('next'));
          securityHeaders(res);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(loginPageBody(next));
          return;
        }
        if (req.method !== 'POST') {
          securityHeaders(res);
          res.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', error: { code: 'method_not_allowed' } }));
          return;
        }

        const address = getClientAddress(req);
        const now = Date.now();
        let body;
        try {
          body = await readBody(req);
        } catch {
          securityHeaders(res);
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ status: 'error', error: { code: 'invalid_body' } }));
          return;
        }

        if (isLocked(address, now)) {
          securityHeaders(res);
          res.writeHead(429, {
            'retry-after': '300',
            'content-type': 'text/html; charset=utf-8',
          });
          res.end('<p>시도 횟수를 초과했습니다. 잠시 후 다시 시도하세요.</p>');
          return;
        }

        const params = new URLSearchParams(body);
        const password = params.get('password') ?? '';
        const next = sanitizeNext(params.get('next'));

        if (!verifyPassword(password, token)) {
          recordFailure(address, now);
          securityHeaders(res);
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          res.end(loginPageBody(next, { error: true }));
          return;
        }

        failures.delete(address);
        const sessionId = crypto.randomBytes(32).toString('hex');
        sessions.add(sessionId);
        const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        const secure = proto === 'https' ? '; Secure' : '';
        securityHeaders(res);
        res.writeHead(302, {
          location: next,
          'set-cookie': `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict${secure}`,
        });
        res.end();
        return;
      }

      if (hasSession(req)) {
        const route = classifyGateRoute(req.url);
        const selectedUpstream = route.target === 'research'
          ? researchUpstreamUrl
          : route.target === 'dialogue'
            ? dialogueUpstreamUrl
            : route.target === 'agent'
              ? agentUpstreamUrl
              : upstreamUrl;
        proxyToUpstream(req, res, selectedUpstream, route.path);
        return;
      }
      redirectToLogin(res, req.url);
    } catch {
      securityHeaders(res);
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: { code: 'internal_error' } }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({ server, port: server.address().port });
    });
  });
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  const config = loadGateConfig();
  startGateServer(config).then(({ server, port }) => {
    console.log(
      `daocanon-gate listening on ${config.host}:${port}, upstream ${config.upstream}, research ${config.researchUpstream}, dialogue ${config.dialogueUpstream}`,
    );
    let closing = false;
    const shutdown = (signal) => {
      if (closing) return;
      closing = true;
      console.log(`daocanon-gate received ${signal}, shutting down`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
      if (server.closeAllConnections) server.closeAllConnections();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
