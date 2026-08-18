import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createTextProxyHandlers } from '../src/text-proxy.js';

function readBody(response) {
  return new Promise((resolve) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function rawRequest({ port, method, pathname, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      async (response) => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: await readBody(response),
        });
      },
    );
    request.once('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function startServer({ textApiUrl, fetchImpl, timeoutMs }) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daocanon-route-'));
  const env = { DAO_CANON_ROOT: root };
  if (textApiUrl !== undefined) env.DAO_CANON_TEXT_API_URL = textApiUrl;
  const config = loadConfig(env);
  const handlerOptions = fetchImpl ? { fetchImpl } : undefined;
  if (timeoutMs !== undefined) Object.assign(handlerOptions, { timeoutMs });
  const textProxyHandlers = createTextProxyHandlers(
    { textApiUrl: config.textApiUrl },
    handlerOptions,
  );
  const server = createServer(config, { textProxyHandlers });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

describe('/v1/text/convert — HTTP route', () => {
  let srv;
  let captured;

  before(async () => {
    captured = { url: null, body: null };
    const fetchImpl = async (url, init) => {
      captured.url = url;
      captured.body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ status: 'ok', data: { converted: '道藏繁' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    srv = await startServer({ textApiUrl: 'http://text-api:3000', fetchImpl });
  });

  after(async () => {
    await srv.close();
  });

  it('forwards s2t to text-api and returns data.converted', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'POST', pathname: '/v1/text/convert',
      body: { text: '道藏', direction: 's2t' },
    });
    assert.equal(response.status, 200);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'ok');
    assert.equal(json.data.converted, '道藏繁');
    assert.equal(captured.url, 'http://text-api:3000/v1/cjk/convert');
    assert.deepEqual(captured.body, { text: '道藏', direction: 's2t' });
  });

  it('returns 400 invalid_direction for an unknown direction', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'POST', pathname: '/v1/text/convert',
      body: { text: '道', direction: 'simplified' },
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, 'invalid_direction');
  });

  it('returns 400 invalid_text for empty text', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'POST', pathname: '/v1/text/convert',
      body: { text: '', direction: 's2t' },
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, 'invalid_text');
  });

  it('returns 400 invalid_json for non-JSON body', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'POST', pathname: '/v1/text/convert',
      body: 'not json',
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, 'invalid_json');
  });

  it('returns 405 method_not_allowed for GET on the convert route', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'GET', pathname: '/v1/text/convert',
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'POST');
    assert.equal(JSON.parse(response.body).error.code, 'method_not_allowed');
  });
});

describe('/v1/text/translate — HTTP route', () => {
  let srv;
  let captured;
  const capturedCalls = [];

  before(async () => {
    captured = null;
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      capturedCalls.push({ url, body });
      captured = { url, body };
      return new Response(
        JSON.stringify({ status: 'ok', data: { translation: '도장' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    srv = await startServer({ textApiUrl: 'http://text-api:3000', fetchImpl });
  });

  after(async () => {
    await srv.close();
  });

  it('forwards classical_zh/ko/gemma4:12b to text-api and returns data.translation', async () => {
    capturedCalls.length = 0;
    const response = await rawRequest({
      port: srv.port, method: 'POST', pathname: '/v1/text/translate',
      body: {
        text: '道藏',
        source_language: 'classical_zh',
        target_language: 'ko',
        model: 'gemma4:12b',
      },
    });
    assert.equal(response.status, 200);
    const json = JSON.parse(response.body);
    assert.equal(json.status, 'ok');
    assert.equal(json.data.translation, '도장');
    assert.equal(captured.url, 'http://text-api:3000/v1/translate');
    assert.deepEqual(captured.body, {
      text: '道藏',
      source_language: 'classical_zh',
      target_language: 'ko',
      model: 'gemma4:12b',
    });
  });

  it('forwards only the two documented Gemma models without rewriting them', async () => {
    capturedCalls.length = 0;
    for (const model of ['gemma4:12b', 'gemma4:26b']) {
      const response = await rawRequest({
        port: srv.port, method: 'POST', pathname: '/v1/text/translate',
        body: { text: '道', source_language: 'zh', target_language: 'ko', model },
      });
      assert.equal(response.status, 200);
      assert.equal(JSON.parse(response.body).data.translation, '도장');
    }
    const observed = capturedCalls.map((call) => call.body.model);
    assert.deepEqual(observed, ['gemma4:12b', 'gemma4:26b']);
  });

  it('rejects an off-contract source language with invalid_source_language', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'POST', pathname: '/v1/text/translate',
      body: { text: '道', source_language: 'en', target_language: 'ko', model: 'gemma4:12b' },
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, 'invalid_source_language');
  });

  it('rejects a non-ko target language with invalid_target_language', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'POST', pathname: '/v1/text/translate',
      body: { text: '道', source_language: 'zh', target_language: 'en', model: 'gemma4:12b' },
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, 'invalid_target_language');
  });

  it('rejects an off-contract model with invalid_model', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'POST', pathname: '/v1/text/translate',
      body: { text: '道', source_language: 'zh', target_language: 'ko', model: 'gpt4' },
    });
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error.code, 'invalid_model');
  });

  it('returns 405 method_not_allowed for GET on the translate route', async () => {
    const response = await rawRequest({
      port: srv.port, method: 'GET', pathname: '/v1/text/translate',
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'POST');
    assert.equal(JSON.parse(response.body).error.code, 'method_not_allowed');
  });
});

describe('/v1/text/* — service error mapping', () => {
  it('maps network failure to 503 text_service_unavailable', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    const srv = await startServer({ textApiUrl: 'http://text-api:3000', fetchImpl });
    try {
      const response = await rawRequest({
        port: srv.port, method: 'POST', pathname: '/v1/text/convert',
        body: { text: '道', direction: 's2t' },
      });
      assert.equal(response.status, 503);
      assert.equal(JSON.parse(response.body).error.code, 'text_service_unavailable');
    } finally {
      await srv.close();
    }
  });

  it('maps abort timeout to 504 text_service_timeout', async () => {
    const fetchImpl = async (_url, init) => {
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const srv = await startServer({
      textApiUrl: 'http://text-api:3000', fetchImpl, timeoutMs: 25,
    });
    try {
      const response = await rawRequest({
        port: srv.port, method: 'POST', pathname: '/v1/text/translate',
        body: { text: '道', source_language: 'zh', target_language: 'ko', model: 'gemma4:12b' },
      });
      assert.equal(response.status, 504);
      assert.equal(JSON.parse(response.body).error.code, 'text_service_timeout');
    } finally {
      await srv.close();
    }
  });

  it('maps upstream 5xx with structured error to the upstream code at 502', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 502,
      async json() {
        return { error: { code: 'upstream_internal' } };
      },
    });
    const srv = await startServer({ textApiUrl: 'http://text-api:3000', fetchImpl });
    try {
      const response = await rawRequest({
        port: srv.port, method: 'POST', pathname: '/v1/text/convert',
        body: { text: '道', direction: 's2t' },
      });
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(response.body).error.code, 'upstream_internal');
    } finally {
      await srv.close();
    }
  });

  it('falls back to text_service_error when upstream body is not JSON', async () => {
    const fetchImpl = async () => new Response('not json', { status: 502 });
    const srv = await startServer({ textApiUrl: 'http://text-api:3000', fetchImpl });
    try {
      const response = await rawRequest({
        port: srv.port, method: 'POST', pathname: '/v1/text/convert',
        body: { text: '道', direction: 's2t' },
      });
      assert.equal(response.status, 502);
      assert.equal(JSON.parse(response.body).error.code, 'text_service_error');
    } finally {
      await srv.close();
    }
  });

  it('returns 413 body_too_large when the request body exceeds 64 KiB', async () => {
    const fetchImpl = async () => new Response('', { status: 200 });
    const srv = await startServer({ textApiUrl: 'http://text-api:3000', fetchImpl });
    try {
      const big = 'a'.repeat(65 * 1024);
      const response = await rawRequest({
        port: srv.port, method: 'POST', pathname: '/v1/text/convert',
        body: { text: big, direction: 's2t' },
      });
      assert.equal(response.status, 413);
      assert.equal(JSON.parse(response.body).error.code, 'body_too_large');
    } finally {
      await srv.close();
    }
  });
});

describe('loadConfig — DAO_CANON_TEXT_API_URL validation', () => {
  it('uses the default when DAO_CANON_TEXT_API_URL is empty', () => {
    const config = loadConfig({});
    assert.equal(config.textApiUrl, 'http://text-api:3000');
  });

  it('accepts explicit http(s) URLs', () => {
    assert.equal(
      loadConfig({ DAO_CANON_TEXT_API_URL: 'http://localhost:4000' }).textApiUrl,
      'http://localhost:4000',
    );
    assert.equal(
      loadConfig({ DAO_CANON_TEXT_API_URL: 'https://text.example.com' }).textApiUrl,
      'https://text.example.com',
    );
  });

  it('rejects non-URL strings with a RangeError', () => {
    assert.throws(() => loadConfig({ DAO_CANON_TEXT_API_URL: 'not a url' }), RangeError);
  });

  it('rejects non-http(s) protocols', () => {
    assert.throws(() => loadConfig({ DAO_CANON_TEXT_API_URL: 'ftp://text-api:3000' }), RangeError);
    assert.throws(() => loadConfig({ DAO_CANON_TEXT_API_URL: 'file:///etc/passwd' }), RangeError);
  });
});
