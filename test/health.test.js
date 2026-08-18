import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
);

function rawRequest(port, requestLine) {
  return new Promise((resolve, reject) => {
    let socket;
    const timer = setTimeout(() => {
      socket?.destroy();
      reject(new Error('raw request timeout'));
    }, 3000);
    socket = net.connect(port, '127.0.0.1', () => {
      socket.write(requestLine);
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('loadConfig', () => {
  it('returns defaults when env is empty', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.daoCanonRoot, '/mnt/d/Lab/ScholarLib/Corpus/DaoCanon');
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 3040);
  });

  it('reads DAO_CANON_ROOT and PORT from env', () => {
    const cfg = loadConfig({ DAO_CANON_ROOT: '/tmp/x', PORT: '9999' });
    assert.equal(cfg.daoCanonRoot, '/tmp/x');
    assert.equal(cfg.port, 9999);
  });

  it('accepts the explicit container wildcard while keeping loopback as the default', () => {
    assert.equal(loadConfig({}).host, '127.0.0.1');
    assert.equal(loadConfig({ HOST: '127.0.0.1' }).host, '127.0.0.1');
    assert.equal(loadConfig({ HOST: '0.0.0.0' }).host, '0.0.0.0');
  });

  it('rejects empty, hostname, and unsupported address HOST values', () => {
    for (const host of ['', 'localhost', '::', '192.0.2.1', '0.0.0.0 ']) {
      assert.throws(() => loadConfig({ HOST: host }), RangeError, host);
    }
  });

  it('rejects non-numeric PORT', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), RangeError);
  });

  it('rejects an explicitly empty PORT', () => {
    assert.throws(() => loadConfig({ PORT: '' }), RangeError);
  });

  it('rejects PORT with trailing garbage', () => {
    assert.throws(() => loadConfig({ PORT: '80abc' }), RangeError);
  });

  it('rejects PORT out of range', () => {
    assert.throws(() => loadConfig({ PORT: '0' }), RangeError);
    assert.throws(() => loadConfig({ PORT: '70000' }), RangeError);
  });

  it('defaults DAO_CANON_TEXT_API_URL to the internal text-api service', () => {
    assert.equal(loadConfig({}).textApiUrl, 'http://text-api:3000');
    assert.equal(loadConfig({ DAO_CANON_TEXT_API_URL: '' }).textApiUrl, 'http://text-api:3000');
  });

  it('reads DAO_CANON_TEXT_API_URL from env', () => {
    const cfg = loadConfig({ DAO_CANON_TEXT_API_URL: 'http://localhost:4001' });
    assert.equal(cfg.textApiUrl, 'http://localhost:4001');
  });

  it('rejects an invalid DAO_CANON_TEXT_API_URL', () => {
    assert.throws(() => loadConfig({ DAO_CANON_TEXT_API_URL: 'not a url' }), RangeError);
    assert.throws(() => loadConfig({ DAO_CANON_TEXT_API_URL: 'ftp://text-api:3000' }), RangeError);
  });
});

describe('GET /health — corpus available', () => {
  let server;
  let baseUrl;
  let tempDir;

  before(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'daocanon-test-'),
    );
    const config = loadConfig({ DAO_CANON_ROOT: tempDir });
    server = createServer(config);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('returns 200 with JSON content type', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('application/json'));
  });

  it('reports process up and corpus readable', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.request_id, 'string');
    assert.equal(body.data.process, 'up');
    assert.equal(body.data.corpus.configured, true);
    assert.equal(body.data.corpus.readable, true);
  });

  it('does not expose absolute paths', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const text = await res.text();
    assert.ok(
      !text.includes(tempDir),
      'response must not contain the corpus absolute path',
    );
  });

  // S2-CATALOG-01 intentionally extends the S1 health response: after a
  // successful catalog build, health reports catalog readiness and count.
  it('reports catalog readiness and work count after a successful build', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    assert.equal(body.data.process, 'up');
    assert.equal(body.data.corpus.readable, true);
    assert.equal(body.data.catalog.ready, true);
    assert.equal(body.data.catalog.work_count, 0);
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.equal(body.error.code, 'not_found');
  });

  it('returns 405 with Allow header for POST /health', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.ok(res.headers.get('allow').includes('GET'));
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.equal(body.error.code, 'method_not_allowed');
  });

  it('returns 405 for PUT /health', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'PUT' });
    assert.equal(res.status, 405);
  });

  it('survives a malformed Host header', async () => {
    const port = server.address().port;
    const response = await rawRequest(
      port,
      'GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n',
    );
    assert.ok(response.includes('HTTP/1.1'), 'server must respond');
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  });

  it('returns 400 for a malformed absolute-form request target', async () => {
    const port = server.address().port;
    const response = await rawRequest(
      port,
      'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
    );
    assert.ok(response.includes('400'), 'must return 400');
    assert.ok(
      response.includes('application/json'),
      'must be JSON content type',
    );
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200, 'server must remain available');
  });
});

describe('GET /health — corpus unavailable', () => {
  let server;
  let baseUrl;
  const badPath = `/tmp/daocanon-nonexistent-${process.pid}`;

  before(async () => {
    const config = loadConfig({ DAO_CANON_ROOT: badPath });
    server = createServer(config);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns 503 with corpus_unavailable', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 503);
    assert.ok(res.headers.get('content-type').includes('application/json'));
    const body = await res.json();
    assert.equal(body.status, 'error');
    assert.equal(body.error.code, 'corpus_unavailable');
  });

  it('does not leak stack traces or absolute paths', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const text = await res.text();
    assert.ok(!text.includes(badPath), 'must not contain the configured path');
    assert.ok(!text.includes('    at '), 'must not contain stack traces');
  });
});

describe('GET /health — corpus root is a regular file', () => {
  let server;
  let baseUrl;
  let tempFile;

  before(async () => {
    tempFile = path.join(os.tmpdir(), `daocanon-file-${process.pid}`);
    await fs.promises.writeFile(tempFile, 'not a directory');
    const config = loadConfig({ DAO_CANON_ROOT: tempFile });
    server = createServer(config);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.promises.rm(tempFile, { force: true });
  });

  it('returns 503 for a regular file', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'corpus_unavailable');
  });
});

describe('createServer', () => {
  it('returns a server with listen and close methods', () => {
    const server = createServer(loadConfig({ DAO_CANON_ROOT: '/tmp' }));
    assert.equal(typeof server.listen, 'function');
    assert.equal(typeof server.close, 'function');
  });
});

describe('process behavior', () => {
  async function getFreePort() {
    const tmp = net.createServer();
    await new Promise((resolve, reject) => {
      tmp.once('error', reject);
      tmp.listen(0, '127.0.0.1', resolve);
    });
    const port = tmp.address().port;
    await new Promise((resolve) => tmp.close(resolve));
    return port;
  }

  async function startChild(tmpDir) {
    const port = await getFreePort();
    const child = spawn('node', ['src/server.js'], {
      cwd: repoRoot,
      env: { ...process.env, PORT: String(port), DAO_CANON_ROOT: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (error) =>
        resolve({ code: null, signal: null, error }),
      );
    });

    try {
      const listenLine = await new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.removeListener('data', onData);
          child.removeListener('error', onError);
          child.removeListener('exit', onEarlyExit);
        };
        const onData = (chunk) => {
          const value = chunk.toString();
          if (value.includes('listening')) {
            cleanup();
            resolve(value.trim());
          }
        };
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        const onEarlyExit = (code, signal) => {
          cleanup();
          reject(
            new Error(`server exited before listening: code=${code} signal=${signal}`),
          );
        };
        timer = setTimeout(() => {
          cleanup();
          reject(new Error('server start timeout'));
        }, 5000);
        child.stdout.on('data', onData);
        child.once('error', onError);
        child.once('exit', onEarlyExit);
      });

      return { child, port, listenLine, exitPromise };
    } catch (error) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exitPromise;
      throw error;
    }
  }

  async function waitForExit(exitPromise, timeoutMs = 5000) {
    let timer;
    try {
      return await Promise.race([
        exitPromise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('shutdown timeout')),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function killChild(child, exitPromise) {
    if (
      child?.pid &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill('SIGKILL');
    }
    if (exitPromise) await exitPromise;
  }

  function firstNonLoopbackIpv4() {
    for (const entries of Object.values(os.networkInterfaces())) {
      const found = entries?.find(
        (entry) => entry.family === 'IPv4' && !entry.internal,
      );
      if (found) return found.address;
    }
    return null;
  }

  function connectTo(host, port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('connect timeout'));
      }, 500);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  it('importing server.js does not start a listener', async () => {
    const code =
      'const m = await import("./src/server.js"); console.log(typeof m.createServer);';
    const result = await new Promise((resolve, reject) => {
      execFile(
        'node',
        ['--input-type=module', '-e', code],
        { cwd: repoRoot, timeout: 5000 },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        },
      );
    });
    assert.equal(result, 'function');
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    it(`direct execution binds loopback and shuts down on ${signal}`, async () => {
      const tmpDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'daocanon-proc-'),
      );
      let child;
      let port;
      let listenLine;
      let exitPromise;
      try {
        ({ child, port, listenLine, exitPromise } = await startChild(tmpDir));
        assert.ok(
          listenLine.includes('127.0.0.1'),
          'must log loopback bind address',
        );

        const res = await fetch(`http://127.0.0.1:${port}/health`);
        assert.equal(res.status, 200);
        const nonLoopback = firstNonLoopbackIpv4();
        if (nonLoopback) {
          await assert.rejects(connectTo(nonLoopback, port));
        }

        child.kill(signal);
        const result = await waitForExit(exitPromise);
        assert.equal(result.code, 0);
        assert.equal(result.signal, null);
      } finally {
        await killChild(child, exitPromise);
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
    });
  }

  it('bounds SIGTERM shutdown with an incomplete client request', async () => {
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'daocanon-proc-'),
    );
    let child;
    let port;
    let exitPromise;
    let socket;
    try {
      ({ child, port, exitPromise } = await startChild(tmpDir));
      socket = net.connect(port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: ');

      child.kill('SIGTERM');
      const result = await waitForExit(exitPromise, 1500);
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
    } finally {
      socket?.destroy();
      await killChild(child, exitPromise);
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
