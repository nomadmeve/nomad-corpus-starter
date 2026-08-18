import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  classifyGateRoute,
  loadGateConfig,
  parseGateToken,
  verifyPassword,
  createGateToken,
} from '../src/gate.js';

const TEST_ITERATIONS = 10_000;

function startStubUpstream() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url.startsWith('/echo')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-stub': 'yes' });
      res.end(JSON.stringify({ url: req.url, method: req.method }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'error' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function startGate({ token, upstream, researchUpstream, dialogueUpstream, maxAttempts }) {
  const { startGateServer } = await import('../src/gate.js');
  return startGateServer({
    host: '127.0.0.1',
    port: 0,
    upstream,
    researchUpstream,
    dialogueUpstream,
    token,
    maxAttempts,
  });
}

function validToken() {
  return 'pbkdf2.sha256.10000.aW50ZWdyYXRpb24tc2FsdA.hTg7fJ0j8q1Yb0nQdVZ2aXW3cS5uE6rKvNmL4pIoDwA';
}

function stop(...servers) {
  for (const server of servers) {
    server.close();
    if (server.closeAllConnections) server.closeAllConnections();
  }
}

describe('loadGateConfig — bounded public gate contract', () => {
  it('defaults to loopback 3080 and the local DaoCanon upstream', () => {
    const config = loadGateConfig({ DAO_CANON_GATE_TOKEN: validToken() });
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3080);
    assert.equal(config.upstream, 'http://127.0.0.1:3040');
    assert.equal(config.researchUpstream, 'http://127.0.0.1:3060');
  });

  it('accepts the explicit container wildcard while keeping loopback as the default', () => {
    assert.equal(loadGateConfig({
      HOST: '0.0.0.0',
      DAO_CANON_GATE_TOKEN: validToken(),
    }).host, '0.0.0.0');
  });

  it('rejects unsupported HOST values exactly like the API', () => {
    assert.throws(() => loadGateConfig({ HOST: 'example.com', DAO_CANON_GATE_TOKEN: validToken() }), RangeError);
    assert.throws(() => loadGateConfig({ HOST: '', DAO_CANON_GATE_TOKEN: validToken() }), RangeError);
  });

  it('defaults to a loopback dialogue upstream on 3070', () => {
    const config = loadGateConfig({ DAO_CANON_GATE_TOKEN: validToken() });
    assert.equal(config.dialogueUpstream, 'http://127.0.0.1:3070');
  });

  it('requires a well-formed gate token and refuses to boot without one', () => {
    assert.throws(() => loadGateConfig({}), /DAO_CANON_GATE_TOKEN/);
    assert.throws(() => loadGateConfig({ DAO_CANON_GATE_TOKEN: '' }), /DAO_CANON_GATE_TOKEN/);
    assert.throws(
      () => loadGateConfig({ DAO_CANON_GATE_TOKEN: '$2a$14$notpbkdf2' }),
      /DAO_CANON_GATE_TOKEN/,
    );
  });
});

describe('parseGateToken and verifyPassword', () => {
  it('parses the self-describing token shape', () => {
    const token = parseGateToken('pbkdf2.sha256.10000.c2FsdA.aGFzaA');
    assert.deepEqual(token, {
      scheme: 'pbkdf2',
      digest: 'sha256',
      iterations: 10_000,
      salt: 'c2FsdA',
      hash: 'aGFzaA',
    });
  });

  it('rejects malformed tokens instead of guessing', () => {
    for (const bad of [
      '',
      'bcrypt.sha256.10000.c2FsdA.aGFzaA',
      'pbkdf2.md5.10000.c2FsdA.aGFzaA',
      'pbkdf2.sha256.zero.c2FsdA.aGFzaA',
      'pbkdf2.sha256.10000.c2FsdA',
      'pbkdf2.sha256.10000.c2FsdA.aGFzaA.extra',
      'pbkdf2.sha256.999.c2FsdA.aGFzaA',
      'pbkdf2.sha256.10000.c2FsdA!.aGFzaA',
    ]) {
      assert.throws(() => parseGateToken(bad), RangeError, String(bad));
    }
  });

  it('verifies the exact password behind a token and rejects others', () => {
    const token = createGateToken('통합-비밀번호-1', TEST_ITERATIONS);
    assert.equal(verifyPassword('통합-비밀번호-1', token), true);
    assert.equal(verifyPassword('통합-비밀번호-2', token), false);
    assert.equal(verifyPassword('', token), false);
  });

  it('rejects overlong passwords without spending hash work on them', () => {
    const token = createGateToken('짧은-암호', TEST_ITERATIONS);
    assert.equal(verifyPassword('x'.repeat(2000), token), false);
  });
});

describe('gate HTTP contract — single-password login gate', () => {
  it('serves /gate-health without auth and never proxies it', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: validToken(),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gate.port}/gate-health`);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('redirects unauthenticated visitors to the single-field login page', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: validToken(),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gate.port}/`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.match(response.headers.get('location'), /^\/gate-login\?next=%2F$/);

      const login = await fetch(`http://127.0.0.1:${gate.port}/gate-login`);
      assert.equal(login.status, 200);
      const html = await login.text();
      assert.match(html, /type="password"/);
      assert.match(html, /<form[^>]*method="post"[^>]*action="\/gate-login"/);
      assert.doesNotMatch(html, /name="username"/i, 'login page must not ask for a username');
      assert.match(login.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(login.headers.get('cache-control'), 'no-store');
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('rejects a wrong password with the login page and no session cookie', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: createGateToken('정답-암호', TEST_ITERATIONS),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent('잘못된-암호')}&next=%2F`,
        redirect: 'manual',
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('set-cookie'), null);
      const html = await response.text();
      assert.match(html, /비밀번호가 맞지 않습니다/);
      assert.doesNotMatch(html, /role="alert" hidden/);
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('grants an HttpOnly same-site session on the correct password and proxies afterwards', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: createGateToken('정답-암호', TEST_ITERATIONS),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const login = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent('정답-암호')}&next=%2Fv1%2Fsearch%3Fmode%3Dtitle`,
        redirect: 'manual',
      });
      assert.equal(login.status, 302);
      assert.equal(login.headers.get('location'), '/v1/search?mode=title');
      const cookieHeader = login.headers.get('set-cookie');
      assert.match(cookieHeader, /^daocanon_session=[^;]+;/);
      assert.match(cookieHeader, /HttpOnly/i);
      assert.match(cookieHeader, /SameSite=Strict/i);
      assert.match(cookieHeader, /Path=\//i);
      const cookie = cookieHeader.split(';')[0];

      const proxied = await fetch(`http://127.0.0.1:${gate.port}/health`, {
        headers: { cookie },
      });
      assert.equal(proxied.status, 200);
      assert.deepEqual(await proxied.json(), { status: 'ok' });

      const echo = await fetch(`http://127.0.0.1:${gate.port}/echo?a=1`, {
        headers: { cookie },
      });
      assert.deepEqual(await echo.json(), { url: '/echo?a=1', method: 'GET' });
      assert.equal(echo.headers.get('x-stub'), 'yes');
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('treats forged or unknown session cookies as anonymous', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: validToken(),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${gate.port}/health`, {
        headers: { cookie: 'daocanon_session=0000000000000000' },
        redirect: 'manual',
      });
      assert.equal(response.status, 302);
      assert.match(response.headers.get('location'), /^\/gate-login/);
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('neutralizes open-redirect attempts through the next parameter', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: createGateToken('정답-암호', TEST_ITERATIONS),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      for (const evil of ['%2F%2Fevil.example', 'https%3A%2F%2Fevil.example', '%2F..%2Fetc']) {
        const login = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `password=${encodeURIComponent('정답-암호')}&next=${evil}`,
          redirect: 'manual',
        });
        assert.equal(login.status, 302, evil);
        assert.equal(login.headers.get('location'), '/', evil);
      }
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('rate-limits repeated failed attempts from one address', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: createGateToken('정답-암호', TEST_ITERATIONS),
      upstream: `http://127.0.0.1:${upstream.port}`,
      maxAttempts: 3,
    });
    try {
      for (let i = 0; i < 3; i += 1) {
        const response = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'password=wrong',
          redirect: 'manual',
        });
        assert.equal(response.status, 401);
      }
      const locked = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent('정답-암호')}`,
        redirect: 'manual',
      });
      assert.equal(locked.status, 429);
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('marks the session cookie Secure when the edge reports https', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: createGateToken('정답-암호', TEST_ITERATIONS),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const login = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-proto': 'https',
        },
        body: `password=${encodeURIComponent('정답-암호')}&next=%2F`,
        redirect: 'manual',
      });
      assert.equal(login.status, 302);
      assert.match(login.headers.get('set-cookie'), /Secure/i);
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('returns a safe 502 envelope when the upstream is unreachable', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: createGateToken('정답-암호', TEST_ITERATIONS),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const login = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent('정답-암호')}&next=%2F`,
        redirect: 'manual',
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];
      upstream.server.close();
      const down = await fetch(`http://127.0.0.1:${gate.port}/health`, {
        headers: { cookie },
      });
      assert.equal(down.status, 502);
      const body = await down.json();
      assert.equal(body.status, 'error');
      assert.ok(!JSON.stringify(body).includes('ECONNREFUSED'));
    } finally {
      stop(gate.server, upstream.server);
    }
  });

  it('refuses oversized login bodies and malformed methods safely', async () => {
    const upstream = await startStubUpstream();
    const gate = await startGate({
      token: validToken(),
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    try {
      const oversized = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${'x'.repeat(20000)}`,
        redirect: 'manual',
      });
      assert.equal(oversized.status, 400);

      const wrongMethod = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'DELETE',
        redirect: 'manual',
      });
      assert.equal(wrongMethod.status, 405);
      assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
    } finally {
      stop(gate.server, upstream.server);
    }
  });
});

describe('authenticated dual-surface routing', () => {
  it('classifies only explicit research paths and otherwise defaults to DaoCanon', () => {
    assert.deepEqual(classifyGateRoute('/'), { target: 'daocanon', path: '/' });
    assert.deepEqual(classifyGateRoute('/v1/catalog?a=1'), {
      target: 'daocanon', path: '/v1/catalog?a=1',
    });
    assert.deepEqual(classifyGateRoute('/app.js'), {
      target: 'daocanon', path: '/app.js',
    });
    assert.deepEqual(classifyGateRoute('/styles.css'), {
      target: 'daocanon', path: '/styles.css',
    });
    assert.deepEqual(classifyGateRoute('/research/'), { target: 'research', path: '/' });
    assert.deepEqual(classifyGateRoute('/research?x=1'), {
      target: 'research', path: '/?x=1',
    });
    assert.deepEqual(classifyGateRoute('/research/deep?q=1'), {
      target: 'research', path: '/deep?q=1',
    });
    assert.deepEqual(classifyGateRoute('/assets/app.js'), {
      target: 'research', path: '/assets/app.js',
    });
    assert.deepEqual(classifyGateRoute('/api/daoism-research/v1/sources'), {
      target: 'research', path: '/api/daoism-research/v1/sources',
    });
    assert.deepEqual(classifyGateRoute('/api/daocanon/v1/catalog'), {
      target: 'research', path: '/api/daocanon/v1/catalog',
    });
    assert.equal(classifyGateRoute('/researcher').target, 'daocanon');
  });

  it('classifies /api/dialogue/* to the dialogue upstream with the path preserved', () => {
    assert.deepEqual(classifyGateRoute('/api/dialogue/v1/chat'), {
      target: 'dialogue', path: '/api/dialogue/v1/chat',
    });
    assert.deepEqual(classifyGateRoute('/api/dialogue/v1/chat?a=1'), {
      target: 'dialogue', path: '/api/dialogue/v1/chat?a=1',
    });
    assert.equal(classifyGateRoute('/api/dialogue/x').target, 'dialogue');
    assert.equal(classifyGateRoute('/api/dialogu').target, 'daocanon');
    assert.equal(classifyGateRoute('/api/dialogue').target, 'daocanon');
  });

  it('classifies /api/agent/* to the extended-dialogue upstream with the path preserved', () => {
    assert.deepEqual(classifyGateRoute('/api/agent/v1/health'), {
      target: 'agent', path: '/api/agent/v1/health',
    });
    assert.equal(classifyGateRoute('/api/agent').target, 'daocanon');
  });

  it('fans out authenticated /api/dialogue/* POST bodies to the dialogue upstream unchanged', async () => {
    const makeUpstream = (name) => new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            name, url: req.url, method: req.method,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
    const stage1 = await makeUpstream('stage1');
    const research = await makeUpstream('research');
    const dialogue = await makeUpstream('dialogue');
    const password = 'dialogue-gate-password';
    const gate = await startGate({
      token: createGateToken(password, TEST_ITERATIONS),
      upstream: `http://127.0.0.1:${stage1.port}`,
      researchUpstream: `http://127.0.0.1:${research.port}`,
      dialogueUpstream: `http://127.0.0.1:${dialogue.port}`,
    });
    try {
      const login = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent(password)}&next=%2F`,
        redirect: 'manual',
      });
      const cookie = login.headers.get('set-cookie').split(';')[0];

      const payload = JSON.stringify({
        schema_version: 'dialogue.request.v0.1',
        mode: 'selected_evidence',
        question: '이 세 근거만 놓고 비교해줘',
        evidence: [],
        locale: 'ko-KR',
      });
      const response = await fetch(`http://127.0.0.1:${gate.port}/api/dialogue/v1/chat`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: payload,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        name: 'dialogue', url: '/api/dialogue/v1/chat', method: 'POST', body: payload,
      });

      const stage1Probe = await fetch(`http://127.0.0.1:${gate.port}/v1/catalog`, {
        headers: { cookie },
      });
      assert.deepEqual(await stage1Probe.json(), {
        name: 'stage1', url: '/v1/catalog', method: 'GET', body: '',
      });
    } finally {
      stop(gate.server, stage1.server, research.server, dialogue.server);
    }
  });

  it('preserves one authenticated session across both selected upstreams', async () => {
    const makeUpstream = (name) => new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name, url: req.url, method: req.method }));
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
    const stage1 = await makeUpstream('stage1');
    const research = await makeUpstream('research');
    const password = 'dual-surface-password';
    const gate = await startGate({
      token: createGateToken(password, TEST_ITERATIONS),
      upstream: `http://127.0.0.1:${stage1.port}`,
      researchUpstream: `http://127.0.0.1:${research.port}`,
    });
    try {
      const anonymous = await fetch(`http://127.0.0.1:${gate.port}/research/`, {
        redirect: 'manual',
      });
      assert.equal(anonymous.status, 302);
      assert.equal(anonymous.headers.get('location'), '/gate-login?next=%2Fresearch%2F');

      const login = await fetch(`http://127.0.0.1:${gate.port}/gate-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `password=${encodeURIComponent(password)}&next=%2Fresearch%2F`,
        redirect: 'manual',
      });
      assert.equal(login.status, 302);
      assert.equal(login.headers.get('location'), '/research/');
      const cookie = login.headers.get('set-cookie').split(';')[0];

      const stage1Response = await fetch(`http://127.0.0.1:${gate.port}/v1/catalog?a=1`, {
        headers: { cookie },
      });
      assert.deepEqual(await stage1Response.json(), {
        name: 'stage1', url: '/v1/catalog?a=1', method: 'GET',
      });

      const researchResponse = await fetch(`http://127.0.0.1:${gate.port}/research/?q=2`, {
        headers: { cookie },
      });
      assert.deepEqual(await researchResponse.json(), {
        name: 'research', url: '/?q=2', method: 'GET',
      });

      const assetResponse = await fetch(`http://127.0.0.1:${gate.port}/assets/app.js`, {
        headers: { cookie },
      });
      assert.deepEqual(await assetResponse.json(), {
        name: 'research', url: '/assets/app.js', method: 'GET',
      });

      for (const stage1Asset of ['/app.js', '/styles.css']) {
        const response = await fetch(`http://127.0.0.1:${gate.port}${stage1Asset}`, {
          headers: { cookie },
        });
        assert.deepEqual(await response.json(), {
          name: 'stage1', url: stage1Asset, method: 'GET',
        });
      }

      const composedStage1Api = await fetch(
        `http://127.0.0.1:${gate.port}/api/daocanon/v1/catalog`,
        { headers: { cookie } },
      );
      assert.deepEqual(await composedStage1Api.json(), {
        name: 'research', url: '/api/daocanon/v1/catalog', method: 'GET',
      });
    } finally {
      stop(gate.server, stage1.server, research.server);
    }
  });
});
