import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  CONVERT_DIRECTIONS,
  TRANSLATE_SOURCE_LANGUAGES,
  TRANSLATE_TARGET_LANGUAGES,
  TRANSLATE_MODELS,
  TEXT_API_TIMEOUT_MS,
  parseTextApiUrl,
  readJsonBody,
  validateConvertRequest,
  validateTranslateRequest,
  createTextProxyHandlers,
} from '../src/text-proxy.js';

function makeReq(chunks, { delay } = { delay: false }) {
  const s = new Readable({
    read() {
      if (chunks.length === 0) {
        this.push(null);
        return;
      }
      const chunk = chunks.shift();
      if (delay) {
        setTimeout(() => this.push(chunk), 10);
      } else {
        this.push(chunk);
      }
    },
  });
  return s;
}

describe('text-proxy constants — real local-text-api contract', () => {
  it('freezes convert directions to s2t/t2s only', () => {
    assert.deepEqual([...CONVERT_DIRECTIONS], ['s2t', 't2s']);
    assert.throws(() => CONVERT_DIRECTIONS.push('x'), TypeError);
  });

  it('freezes translate source languages to classical_zh/zh only', () => {
    assert.deepEqual([...TRANSLATE_SOURCE_LANGUAGES], ['classical_zh', 'zh']);
    assert.throws(() => TRANSLATE_SOURCE_LANGUAGES.push('x'), TypeError);
  });

  it('freezes translate target language to ko only', () => {
    assert.deepEqual([...TRANSLATE_TARGET_LANGUAGES], ['ko']);
    assert.throws(() => TRANSLATE_TARGET_LANGUAGES.push('x'), TypeError);
  });

  it('freezes the two documented local translation models', () => {
    assert.deepEqual([...TRANSLATE_MODELS], [
      'gemma4:12b',
      'gemma4:26b',
    ]);
    assert.throws(() => TRANSLATE_MODELS.push('x'), TypeError);
  });

  it('allows the local translation service its documented 120-second budget', () => {
    assert.equal(TEXT_API_TIMEOUT_MS, 120_000);
  });
});

describe('parseTextApiUrl', () => {
  it('returns the default when env is empty', () => {
    assert.equal(parseTextApiUrl(undefined), 'http://text-api:3000');
    assert.equal(parseTextApiUrl(null), 'http://text-api:3000');
    assert.equal(parseTextApiUrl(''), 'http://text-api:3000');
  });

  it('accepts explicit http and https URLs', () => {
    assert.equal(parseTextApiUrl('http://localhost:4000'), 'http://localhost:4000');
    assert.equal(parseTextApiUrl('https://text.example.com'), 'https://text.example.com');
  });

  it('rejects non-URL strings', () => {
    assert.throws(() => parseTextApiUrl('not a url'), RangeError);
  });

  it('rejects non-http(s) protocols', () => {
    assert.throws(() => parseTextApiUrl('ftp://text-api:3000'), RangeError);
    assert.throws(() => parseTextApiUrl('file:///etc/passwd'), RangeError);
    assert.throws(() => parseTextApiUrl('gopher://text-api:3000'), RangeError);
  });
});

describe('readJsonBody', () => {
  it('parses a valid JSON body', async () => {
    const req = makeReq([Buffer.from('{"text":"道","direction":"s2t"}')]);
    const body = await readJsonBody(req);
    assert.deepEqual(body, { text: '道', direction: 's2t' });
  });

  it('rejects invalid JSON with invalid_json code', async () => {
    const req = makeReq([Buffer.from('not json')]);
    await assert.rejects(readJsonBody(req), (error) => {
      assert.equal(error.code, 'invalid_json');
      return true;
    });
  });

  it('rejects oversized bodies with body_too_large code', async () => {
    const big = Buffer.alloc(65 * 1024, 'a');
    const req = makeReq([big]);
    await assert.rejects(readJsonBody(req), (error) => {
      assert.equal(error.code, 'body_too_large');
      return true;
    });
  });

  it('rejects an oversized declared content-length before consuming body chunks', async () => {
    const req = makeReq([Buffer.from('{}')]);
    req.headers = { 'content-length': String((64 * 1024) + 1) };
    await assert.rejects(readJsonBody(req), (error) => {
      assert.equal(error.code, 'body_too_large');
      return true;
    });
  });

  it('accepts bodies at exactly the limit', async () => {
    const payload = JSON.stringify({ t: 'x' });
    const padLen = 64 * 1024 - payload.length;
    const padded = payload + ' '.repeat(padLen);
    assert.equal(Buffer.byteLength(padded), 64 * 1024);
    const req = makeReq([Buffer.from(padded)]);
    const body = await readJsonBody(req, 64 * 1024);
    assert.deepEqual(body, { t: 'x' });
  });
});

describe('validateConvertRequest', () => {
  it('accepts a valid s2t convert request', () => {
    assert.deepEqual(validateConvertRequest({ text: '道藏', direction: 's2t' }), {
      text: '道藏',
      direction: 's2t',
    });
  });

  it('accepts a valid t2s convert request', () => {
    assert.deepEqual(validateConvertRequest({ text: '道藏', direction: 't2s' }), {
      text: '道藏',
      direction: 't2s',
    });
  });

  it('rejects empty text', () => {
    assert.throws(
      () => validateConvertRequest({ text: '', direction: 's2t' }),
      (error) => { assert.equal(error.code, 'invalid_text'); return true; },
    );
  });

  it('rejects non-string text', () => {
    assert.throws(
      () => validateConvertRequest({ text: 123, direction: 's2t' }),
      (error) => { assert.equal(error.code, 'invalid_text'); return true; },
    );
  });

  it('rejects unknown direction values', () => {
    for (const bad of ['S2T', 'simplified', 'traditional', 't2t', 's2s', 'original', 'auto']) {
      assert.throws(
        () => validateConvertRequest({ text: '道', direction: bad }),
        (error) => { assert.equal(error.code, 'invalid_direction'); return true; },
        bad,
      );
    }
  });

  it('rejects missing direction', () => {
    assert.throws(
      () => validateConvertRequest({ text: '道' }),
      (error) => { assert.equal(error.code, 'invalid_direction'); return true; },
    );
  });

  it('rejects non-object bodies', () => {
    for (const body of [null, 'string', 42, [], undefined]) {
      assert.throws(
        () => validateConvertRequest(body),
        (error) => { assert.equal(error.code, 'invalid_body'); return true; },
      );
    }
  });
});

describe('validateTranslateRequest', () => {
  it('accepts a valid classical_zh translation request', () => {
    assert.deepEqual(validateTranslateRequest({
      text: '道藏', source_language: 'classical_zh', target_language: 'ko', model: 'gemma4:12b',
    }), {
      text: '道藏', source_language: 'classical_zh', target_language: 'ko', model: 'gemma4:12b',
    });
  });

  it('accepts a valid zh translation request with each of the four models', () => {
    for (const model of TRANSLATE_MODELS) {
      assert.deepEqual(validateTranslateRequest({
        text: '道藏', source_language: 'zh', target_language: 'ko', model,
      }), {
        text: '道藏', source_language: 'zh', target_language: 'ko', model,
      });
    }
  });

  it('rejects empty text', () => {
    assert.throws(
      () => validateTranslateRequest({
        text: '', source_language: 'classical_zh', target_language: 'ko', model: 'gemma4:12b',
      }),
      (error) => { assert.equal(error.code, 'invalid_text'); return true; },
    );
  });

  it('rejects unknown source_language', () => {
    for (const bad of ['ko', 'en', 'auto', 'classical']) {
      assert.throws(
        () => validateTranslateRequest({
          text: '道', source_language: bad, target_language: 'ko', model: 'gemma4:12b',
        }),
        (error) => { assert.equal(error.code, 'invalid_source_language'); return true; },
        bad,
      );
    }
  });

  it('rejects non-ko target_language', () => {
    for (const bad of ['en', 'ja', 'ko-KR', 'korean']) {
      assert.throws(
        () => validateTranslateRequest({
          text: '道', source_language: 'zh', target_language: bad, model: 'gemma4:12b',
        }),
        (error) => { assert.equal(error.code, 'invalid_target_language'); return true; },
        bad,
      );
    }
  });

  it('rejects unknown or off-contract models', () => {
    for (const bad of ['gpt4', 'exaone', 'gemma', 'llama', 'polyglot', 'ornith', 'qwen3']) {
      assert.throws(
        () => validateTranslateRequest({
          text: '道', source_language: 'zh', target_language: 'ko', model: bad,
        }),
        (error) => { assert.equal(error.code, 'invalid_model'); return true; },
        bad,
      );
    }
  });

  it('rejects missing required fields', () => {
    assert.throws(
      () => validateTranslateRequest({ text: '道', target_language: 'ko', model: 'gemma4:12b' }),
      (error) => { assert.equal(error.code, 'invalid_source_language'); return true; },
    );
    assert.throws(
      () => validateTranslateRequest({ text: '道', source_language: 'zh', model: 'gemma4:12b' }),
      (error) => { assert.equal(error.code, 'invalid_target_language'); return true; },
    );
    assert.throws(
      () => validateTranslateRequest({ text: '道', source_language: 'zh', target_language: 'ko' }),
      (error) => { assert.equal(error.code, 'invalid_model'); return true; },
    );
  });

  it('rejects non-object bodies', () => {
    for (const body of [null, [], 'string', 42]) {
      assert.throws(
        () => validateTranslateRequest(body),
        (error) => { assert.equal(error.code, 'invalid_body'); return true; },
      );
    }
  });
});

describe('createTextProxyHandlers — convert', () => {
  it('posts validated body to /v1/cjk/convert and returns data.converted', async () => {
    let capturedUrl;
    let capturedBody;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        status: 'ok', data: { converted: '道藏繁' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
    );
    const result = await handlers.handleConvert({ text: '道藏', direction: 's2t' });
    assert.equal(capturedUrl, 'http://text-api:3000/v1/cjk/convert');
    assert.deepEqual(capturedBody, { text: '道藏', direction: 's2t' });
    assert.deepEqual(result, { converted: '道藏繁' });
  });

  it('forwards t2s with the validated body', async () => {
    let capturedUrl;
    let capturedBody;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        status: 'ok', data: { converted: '道藏简' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
    );
    const result = await handlers.handleConvert({ text: '道藏', direction: 't2s' });
    assert.equal(capturedUrl, 'http://text-api:3000/v1/cjk/convert');
    assert.deepEqual(capturedBody, { text: '道藏', direction: 't2s' });
    assert.deepEqual(result, { converted: '道藏简' });
  });

  it('strips trailing slashes from the base URL', async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ status: 'ok', data: { converted: 'x' } }), { status: 200 });
    };
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000///' }, { fetchImpl },
    );
    await handlers.handleConvert({ text: '道', direction: 's2t' });
    assert.equal(capturedUrl, 'http://text-api:3000/v1/cjk/convert');
  });

  it('rejects upstream responses missing data.converted', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ status: 'ok', data: {} }), { status: 200 });
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
    );
    await assert.rejects(
      handlers.handleConvert({ text: '道', direction: 's2t' }),
      (error) => { assert.equal(error.code, 'text_service_error'); return true; },
    );
  });
});

describe('createTextProxyHandlers — translate', () => {
  it('posts validated body to /v1/translate and returns data.translation', async () => {
    let capturedUrl;
    let capturedBody;
    let capturedHeaders;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body);
      capturedHeaders = init.headers;
      return new Response(JSON.stringify({
        status: 'ok', data: { translation: '도장' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
    );
    const result = await handlers.handleTranslate({
      text: '道藏', source_language: 'classical_zh', target_language: 'ko', model: 'gemma4:12b',
    });
    assert.equal(capturedUrl, 'http://text-api:3000/v1/translate');
    assert.deepEqual(capturedBody, {
      text: '道藏', source_language: 'classical_zh', target_language: 'ko', model: 'gemma4:12b',
    });
    assert.equal(capturedHeaders['Content-Type'], 'application/json');
    assert.deepEqual(result, { translation: '도장' });
  });

  it('forwards each documented model without rewriting it', async () => {
    for (const model of TRANSLATE_MODELS) {
      let capturedBody;
      const fetchImpl = async (_url, init) => {
        capturedBody = JSON.parse(init.body);
        return new Response(JSON.stringify({
          status: 'ok', data: { translation: '번역' },
        }), { status: 200 });
      };
      const handlers = createTextProxyHandlers(
        { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
      );
      await handlers.handleTranslate({
        text: '道', source_language: 'zh', target_language: 'ko', model,
      });
      assert.equal(capturedBody.model, model, model);
    }
  });

  it('rejects upstream responses missing data.translation', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
    );
    await assert.rejects(
      handlers.handleTranslate({
        text: '道', source_language: 'zh', target_language: 'ko', model: 'gemma4:12b',
      }),
      (error) => { assert.equal(error.code, 'text_service_error'); return true; },
    );
  });
});

describe('createTextProxyHandlers — error mapping', () => {
  it('maps network failure to text_service_unavailable', async () => {
    const fetchImpl = async () => { throw new TypeError('fetch failed'); };
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
    );
    await assert.rejects(
      handlers.handleConvert({ text: '道', direction: 's2t' }),
      (error) => { assert.equal(error.code, 'text_service_unavailable'); return true; },
    );
  });

  it('maps abort timeout to text_service_timeout', async () => {
    const fetchImpl = async (_url, init) => {
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl, timeoutMs: 50 },
    );
    await assert.rejects(
      handlers.handleTranslate({
        text: '道', source_language: 'zh', target_language: 'ko', model: 'gemma4:12b',
      }),
      (error) => { assert.equal(error.code, 'text_service_timeout'); return true; },
    );
  });

  it('maps text-api 500 to text_service_error with upstream code', async () => {
    const mockBody = JSON.stringify({ error: { code: 'upstream_internal' } });
    const fetchImpl = async () => ({
      ok: false,
      status: 500,
      async json() { return JSON.parse(mockBody); },
    });
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
    );
    await assert.rejects(
      handlers.handleConvert({ text: '道', direction: 's2t' }),
      (error) => {
        assert.equal(error.code, 'upstream_internal');
        assert.equal(error.status, 500);
        return true;
      },
    );
  });

  it('collapses upstream service codes to text_service_error', async () => {
    for (const upstream of ['text_service_unavailable', 'text_service_timeout']) {
      const fetchImpl = async () => ({
        ok: false,
        status: 503,
        async json() { return { error: { code: upstream } }; },
      });
      const handlers = createTextProxyHandlers(
        { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
      );
      await assert.rejects(
        handlers.handleConvert({ text: '道', direction: 's2t' }),
        (error) => { assert.equal(error.code, 'text_service_error'); return true; },
      );
    }
  });

  it('falls back to text_service_error when upstream body is not JSON', async () => {
    const fetchImpl = async () => new Response('not json', { status: 502 });
    const handlers = createTextProxyHandlers(
      { textApiUrl: 'http://text-api:3000' }, { fetchImpl },
    );
    await assert.rejects(
      handlers.handleTranslate({
        text: '道', source_language: 'zh', target_language: 'ko', model: 'gemma4:12b',
      }),
      (error) => {
        assert.equal(error.code, 'text_service_error');
        assert.equal(error.status, 502);
        return true;
      },
    );
  });
});
