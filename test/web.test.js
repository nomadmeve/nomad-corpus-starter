import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import {
  buildReaderHash,
  buildSearchUrl,
  buildWorkUrl,
  createRequestGate,
  groupDivisions,
  isModeBusy,
  lineLabel,
  passageContainsRoute,
  paginationState,
  parseReaderHash,
  validateCatalogEnvelope,
  validateHealthEnvelope,
  validateSearchEnvelope,
  validateWorkEnvelope,
  buildConvertUrl,
  buildTranslateUrl,
  buildConvertBody,
  buildTranslateBody,
  CONVERT_TARGETS,
  TRANSLATE_MODELS,
  TRANSLATE_SOURCE_LANGUAGES,
  TRANSLATE_TARGET_LANGUAGES,
  MAX_TRANSLATE_INPUT_CODE_POINTS,
  isConvertDirection,
  isTranslateModel,
  isTranslateSourceLanguage,
  isTranslateTargetLanguage,
  exceedsTranslateInputLimit,
  validateConvertEnvelope,
  validateTranslateEnvelope,
  readerLineDisplayText,
  summarizeReaderLine,
} from '../src/web/app.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function startServer(serverOptions = undefined) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daocanon-web-'));
  const server = createServer(loadConfig({ DAO_CANON_ROOT: root }), serverOptions);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

async function rawGet(baseUrl, requestPath) {
  const target = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: requestPath,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

describe('web static assets — exact packaged contract', () => {
  let srv;

  before(async () => {
    srv = await startServer();
  });

  after(async () => {
    await srv.close();
  });

  const assets = [
    ['/', 'src/web/index.html', 'text/html; charset=utf-8', 'data-app="daocanon-search"'],
    ['/index.html', 'src/web/index.html', 'text/html; charset=utf-8', 'data-app="daocanon-search"'],
    ['/styles.css', 'src/web/styles.css', 'text/css; charset=utf-8', '--accent: #7a3e2e'],
    ['/evidence-workspace.css', 'src/web/evidence-workspace.css', 'text/css; charset=utf-8', '--ew-accent: #2e7a76'],
    ['/app.js', 'src/web/app.js', 'text/javascript; charset=utf-8', 'buildSearchUrl'],
  ];

  for (const [route, relativeFile, contentType, marker] of assets) {
    it(`serves ${route} with the exact packaged body and security headers`, async () => {
      const response = await fetch(`${srv.baseUrl}${route}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), contentType);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const csp = response.headers.get('content-security-policy');
      assert.ok(csp.includes("default-src 'self'"));
      assert.ok(csp.includes("object-src 'none'"));
      const body = await response.text();
      const packaged = await fs.promises.readFile(path.join(repoRoot, relativeFile), 'utf8');
      assert.equal(body, packaged);
      assert.ok(body.includes(marker));
    });
  }

  it('ignores query strings when matching an allowlisted asset', async () => {
    const response = await fetch(`${srv.baseUrl}/app.js?v=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  });
});

describe('web static assets — fail-closed boundaries', () => {
  it('returns secured JSON 405 for unsupported static methods', async () => {
    const srv = await startServer();
    try {
      const response = await fetch(`${srv.baseUrl}/app.js`, { method: 'POST' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(response.headers.get('content-security-policy').includes("object-src 'none'"));
      assert.ok(response.headers.get('content-type').includes('application/json'));
      assert.equal((await response.json()).error.code, 'method_not_allowed');
    } finally {
      await srv.close();
    }
  });

  it('fails safely when a packaged asset cannot be read', async () => {
    const srv = await startServer({
      staticAssetReader: async () => {
        throw new Error('/private/host/path');
      },
    });
    try {
      const response = await fetch(`${srv.baseUrl}/`);
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      const text = await response.text();
      assert.ok(response.headers.get('content-type').includes('application/json'));
      assert.equal(JSON.parse(text).error.code, 'internal_error');
      assert.ok(!text.includes('/private/host/path'));
      assert.ok(!text.includes('    at '));
    } finally {
      await srv.close();
    }
  });

  it('never resolves unknown or encoded traversal paths as assets', async () => {
    const requested = [];
    const srv = await startServer({
      staticAssetReader: async (file) => {
        requested.push(file);
        return 'unexpected';
      },
    });
    try {
      for (const route of [
        '/unknown',
        '/src/server.js',
        '/..%2fsrc%2fserver.js',
        '/%2e%2e%2fsrc%2fserver.js',
        '/styles.css/../server.js',
      ]) {
        const response = await fetch(`${srv.baseUrl}${route}`);
        assert.equal(response.status, 404, route);
        assert.equal((await response.json()).error.code, 'not_found', route);
      }
      assert.deepEqual(requested, []);
    } finally {
      await srv.close();
    }
  });

  it('rejects raw dot segments before URL normalization can reach an allowlisted asset', async () => {
    const requested = [];
    const srv = await startServer({
      staticAssetReader: async (file) => {
        requested.push(file);
        return 'unexpected';
      },
    });
    try {
      for (const route of [
        '/foo/../app.js',
        '/foo/%2e%2e/app.js',
        '/%2e%2e/app.js',
        '/foo/../',
        'http://localhost/foo/../app.js',
        'http://localhost/foo/%2e%2e/app.js',
      ]) {
        const response = await rawGet(srv.baseUrl, route);
        assert.equal(response.status, 404, route);
        assert.equal(JSON.parse(response.body).error.code, 'not_found', route);
      }
      assert.deepEqual(requested, []);
    } finally {
      await srv.close();
    }
  });

  it('keeps API responses JSON-only without static CSP headers', async () => {
    const srv = await startServer();
    try {
      const response = await fetch(`${srv.baseUrl}/health`);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').includes('application/json'));
      assert.equal(response.headers.get('content-security-policy'), null);
    } finally {
      await srv.close();
    }
  });
});

describe('frontend pure contracts', () => {
  it('builds an encoded same-origin search URL with committed pagination', () => {
    const value = buildSearchUrl({
      query: '参 同&契',
      mode: 'title',
      limit: 20,
      offset: 40,
    });
    const url = new URL(value, 'http://localhost');
    assert.equal(url.pathname, '/v1/search');
    assert.equal(url.searchParams.get('q'), '参 同&契');
    assert.equal(url.searchParams.get('mode'), 'title');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.get('offset'), '40');
  });

  it('builds and parses bounded work-reader routes without accepting paths', () => {
    const workId = `dc1_${'a'.repeat(64)}`;
    assert.equal(
      buildReaderHash(workId, 1053, 1054),
      `#/works/${workId}/lines/1053-1054`,
    );
    assert.deepEqual(parseReaderHash(`#/works/${workId}/lines/1053-1054`), {
      workId,
      lineStart: 1053,
      lineEnd: 1054,
    });
    assert.equal(buildWorkUrl(workId, 1053), `/v1/works/${workId}?line=1053`);
    for (const invalid of [
      '#/works/../lines/1-1',
      `#/works/${workId}/lines/0-1`,
      `#/works/${workId}/lines/3-2`,
      `#/works/${workId}/lines/1-3`,
      `#/works/${workId}/lines/1-1/extra`,
    ]) {
      assert.equal(parseReaderHash(invalid), null, invalid);
    }
  });

  it('groups catalog divisions in deterministic first-seen order', () => {
    const records = [
      { division: '太玄部' },
      { division: null },
      { division: '太平部' },
      { division: '太玄部' },
    ];
    assert.deepEqual(groupDivisions(records), [
      { value: '*', label: '전체', count: 4 },
      { value: '太玄部', label: '太玄部', count: 2 },
      { value: null, label: '미분류', count: 1 },
      { value: '太平部', label: '太平部', count: 1 },
    ]);
  });

  it('derives bounded previous and next pagination targets', () => {
    assert.deepEqual(paginationState(45, 20, 20), {
      total: 45,
      offset: 20,
      limit: 20,
      start: 21,
      end: 40,
      hasPrevious: true,
      hasNext: true,
      previousOffset: 0,
      nextOffset: 40,
    });
    assert.deepEqual(paginationState(0, 40, 20), {
      total: 0,
      offset: 40,
      limit: 20,
      start: 0,
      end: 0,
      hasPrevious: true,
      hasNext: false,
      previousOffset: 20,
      nextOffset: 40,
    });
  });

  it('formats physical line ranges without inventing a locator', () => {
    assert.equal(lineLabel({ line_start: 3, line_end: 3 }), 'L3');
    assert.equal(lineLabel({ line_start: 3, line_end: 4 }), 'L3–L4');
    assert.equal(lineLabel({ line_start: null, line_end: null }), null);
  });

  it('keeps catalog and search loading scopes independent', () => {
    assert.equal(isModeBusy('browse', { catalog: true, search: false }), true);
    assert.equal(isModeBusy('title', { catalog: true, search: false }), false);
    assert.equal(isModeBusy('fulltext', { catalog: false, search: true }), true);
  });

  it('rejects malformed successful endpoint envelopes before rendering', () => {
    assert.throws(
      () => validateHealthEnvelope({ status: 'ok', data: { catalog: { work_count: null } } }),
      /invalid health response/,
    );
    assert.throws(
      () => validateCatalogEnvelope({ status: 'ok', data: { records: {} } }),
      /invalid catalog response/,
    );
    assert.throws(
      () => validateSearchEnvelope({
        status: 'ok',
        data: { hits: null },
        meta: { total: 'broken', offset: 0, limit: 20 },
      }),
      /invalid search response/,
    );
    assert.throws(
      () => validateWorkEnvelope({
        status: 'ok',
        data: { work: { work_id: 'broken' }, passage: { lines: null } },
        meta: { max_lines: 100, max_code_points: 200_000 },
      }),
      /invalid work response/,
    );
  });

  it('rejects search hits whose IDs, sources, or locators contradict the search mode', () => {
    const workId = `dc1_${'a'.repeat(64)}`;
    const hit = {
      source_id: 'daocanon',
      work_id: workId,
      title: '经',
      author: null,
      division: '部',
      match_type: 'title',
      locator: {
        source_id: 'daocanon', relative_path: '部/经.md',
        line_start: null, line_end: null,
      },
    };
    const body = {
      status: 'ok',
      data: { query: '经', mode: 'title', hits: [hit] },
      meta: { total: 1, offset: 0, limit: 20 },
    };
    assert.equal(validateSearchEnvelope(body), body);

    for (const mutate of [
      (value) => { value.data.hits[0].work_id = 'broken'; },
      (value) => { value.data.hits[0].source_id = 'other'; },
      (value) => { value.data.hits[0].locator.source_id = 'other'; },
      (value) => {
        value.data.hits[0].locator.line_start = 9;
        value.data.hits[0].locator.line_end = 9;
      },
      (value) => { value.data.mode = 'author'; },
    ]) {
      const malformed = structuredClone(body);
      mutate(malformed);
      assert.throws(() => validateSearchEnvelope(malformed), /invalid search response/);
    }

    const fulltext = structuredClone(body);
    fulltext.data.mode = 'fulltext';
    Object.assign(fulltext.data.hits[0], {
      match_type: 'fulltext', snippet: '본문', match_text: '본문',
      context_before: null, context_after: null,
    });
    fulltext.data.hits[0].locator.line_start = 10;
    fulltext.data.hits[0].locator.line_end = 11;
    assert.equal(validateSearchEnvelope(fulltext), fulltext);
    fulltext.data.hits[0].locator.line_end = 12;
    assert.throws(() => validateSearchEnvelope(fulltext), /invalid search response/);
  });

  it('rejects work passages that exceed real bounds or carry inconsistent navigation', () => {
    const workId = `dc1_${'b'.repeat(64)}`;
    const body = {
      status: 'ok',
      data: {
        work: {
          source_id: 'daocanon', work_id: workId, title: '经', author: null,
          division: '部', relative_path: '部/经.md', parse_warnings: [],
        },
        passage: {
          target_line: 1, line_start: 1, line_end: 1, total_lines: 2,
          previous_line: null, next_line: 2,
          lines: [{ number: 1, text: '正文' }],
        },
      },
      meta: { max_lines: 100, max_code_points: 200_000 },
    };
    assert.equal(validateWorkEnvelope(body), body);

    const tooManyLines = structuredClone(body);
    tooManyLines.data.passage.line_end = 101;
    tooManyLines.data.passage.total_lines = 101;
    tooManyLines.data.passage.next_line = null;
    tooManyLines.data.passage.lines = Array.from(
      { length: 101 },
      (_, index) => ({ number: index + 1, text: '甲' }),
    );
    assert.throws(() => validateWorkEnvelope(tooManyLines), /invalid work response/);

    const tooManyCodePoints = structuredClone(body);
    tooManyCodePoints.data.passage.lines[0].text = '甲'.repeat(200_001);
    assert.throws(() => validateWorkEnvelope(tooManyCodePoints), /invalid work response/);

    for (const [field, value] of [
      ['previous_line', 1],
      ['next_line', null],
      ['next_line', 3],
    ]) {
      const malformed = structuredClone(body);
      malformed.data.passage[field] = value;
      assert.throws(() => validateWorkEnvelope(malformed), /invalid work response/);
    }
  });

  it('requires the complete reader locator range to be present in the passage', () => {
    const route = { workId: `dc1_${'c'.repeat(64)}`, lineStart: 10, lineEnd: 11 };
    assert.equal(passageContainsRoute({
      target_line: 10, line_start: 1, line_end: 11, total_lines: 30,
    }, route), true);
    assert.equal(passageContainsRoute({
      target_line: 10, line_start: 1, line_end: 10, total_lines: 30,
    }, route), false);
    assert.equal(passageContainsRoute({
      target_line: 9, line_start: 1, line_end: 11, total_lines: 30,
    }, route), false);
  });

  it('accepts an exact bounded work passage envelope', () => {
    const workId = `dc1_${'b'.repeat(64)}`;
    const body = {
      status: 'ok',
      data: {
        work: {
          source_id: 'daocanon', work_id: workId, title: '经', author: null,
          division: '部', relative_path: '部/经.md', parse_warnings: [],
        },
        passage: {
          target_line: 2, line_start: 1, line_end: 2, total_lines: 2,
          previous_line: null, next_line: null,
          lines: [{ number: 1, text: '经' }, { number: 2, text: '正文' }],
        },
      },
      meta: { max_lines: 100, max_code_points: 200_000 },
    };
    assert.equal(validateWorkEnvelope(body), body);
  });

  it('prevents stale request completion from unlocking the active request', () => {
    const gate = createRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    assert.equal(first.signal.aborted, true);
    assert.equal(gate.isCurrent(first.id), false);
    assert.equal(gate.finish(first.id), false);
    assert.equal(gate.busy, true);
    assert.equal(gate.isCurrent(second.id), true);
    assert.equal(gate.finish(second.id), true);
    assert.equal(gate.busy, false);
  });
});

describe('reader text tools — pure contracts', () => {
  it('exposes the documented convert directions and translate model set', () => {
    assert.deepEqual([...CONVERT_TARGETS], ['original', 's2t', 't2s']);
    assert.throws(() => CONVERT_TARGETS.push('x'), TypeError);
    assert.deepEqual([...TRANSLATE_MODELS], [
      'gemma4:12b', 'gemma4:26b',
    ]);
    assert.throws(() => TRANSLATE_MODELS.push('x'), TypeError);
    assert.deepEqual([...TRANSLATE_SOURCE_LANGUAGES], ['classical_zh', 'zh']);
    assert.deepEqual([...TRANSLATE_TARGET_LANGUAGES], ['ko']);
  });

  it('builds the documented convert and translate request bodies', () => {
    assert.equal(buildConvertUrl(), '/v1/text/convert');
    assert.equal(buildTranslateUrl(), '/v1/text/translate');
    assert.deepEqual(buildConvertBody({ text: '道', direction: 's2t' }),
      { text: '道', direction: 's2t' });
    assert.deepEqual(buildTranslateBody({
      text: '道',
      sourceLanguage: 'classical_zh',
      targetLanguage: 'ko',
      model: 'gemma4:12b',
    }), {
      text: '道',
      source_language: 'classical_zh',
      target_language: 'ko',
      model: 'gemma4:12b',
    });
  });

  it('rejects off-contract values for the new enums at the boundary', () => {
    assert.equal(isConvertDirection('s2t'), true);
    assert.equal(isConvertDirection('original'), true);
    assert.equal(isConvertDirection('simplified'), false);
    assert.equal(isConvertDirection(null), false);
    assert.equal(isTranslateModel('gemma4:26b'), true);
    assert.equal(isTranslateModel('gpt4'), false);
    assert.equal(isTranslateModel('exaone'), false);
    assert.equal(isTranslateSourceLanguage('zh'), true);
    assert.equal(isTranslateSourceLanguage('en'), false);
    assert.equal(isTranslateTargetLanguage('ko'), true);
    assert.equal(isTranslateTargetLanguage('en'), false);
  });

  it('enforces the 4000 code-point translate input limit', () => {
    assert.equal(exceedsTranslateInputLimit(''), false);
    assert.equal(exceedsTranslateInputLimit('道'), false);
    assert.equal(MAX_TRANSLATE_INPUT_CODE_POINTS, 4000);
    assert.equal(exceedsTranslateInputLimit('道'.repeat(4000)), false);
    assert.equal(exceedsTranslateInputLimit('道'.repeat(4001)), true);
    assert.equal(exceedsTranslateInputLimit(null), true);
  });

  it('accepts a successful convert envelope with a non-empty data.converted', () => {
    const body = { status: 'ok', data: { converted: '道藏繁' } };
    assert.equal(validateConvertEnvelope(body), body);
  });

  it('rejects convert envelopes missing data.converted', () => {
    for (const bad of [
      { status: 'ok' },
      { status: 'ok', data: {} },
      { status: 'ok', data: { converted: '' } },
      { status: 'error' },
      null,
    ]) {
      assert.throws(() => validateConvertEnvelope(bad), /invalid convert response/);
    }
  });

  it('accepts a successful translate envelope with a non-empty data.translation', () => {
    const body = { status: 'ok', data: { translation: '도장' } };
    assert.equal(validateTranslateEnvelope(body), body);
  });

  it('rejects translate envelopes missing data.translation', () => {
    for (const bad of [
      { status: 'ok' },
      { status: 'ok', data: {} },
      { status: 'ok', data: { translation: '' } },
      { status: 'error' },
      null,
    ]) {
      assert.throws(() => validateTranslateEnvelope(bad), /invalid translate response/);
    }
  });

  it('returns the original line text outside conversion mode', () => {
    const line = { number: 7, text: '道藏' };
    assert.equal(readerLineDisplayText(line, null, 'original'), '道藏');
    assert.equal(readerLineDisplayText(line, new Map(), null), '道藏');
  });

  it('returns the override text when a convert map entry exists', () => {
    const line = { number: 7, text: '道藏' };
    const map = new Map([[7, '道藏簡']]);
    assert.equal(readerLineDisplayText(line, map, 's2t'), '道藏簡');
    assert.equal(readerLineDisplayText(line, map, 't2s'), '道藏簡');
  });

  it('falls back to the original line when the override is empty', () => {
    const line = { number: 7, text: '道藏' };
    const map = new Map([[7, '']]);
    assert.equal(readerLineDisplayText(line, map, 's2t'), '道藏');
  });

  it('truncates long reader line summaries without inventing content', () => {
    const line = { number: 1, text: '甲'.repeat(300) };
    const summary = summarizeReaderLine(line, 50);
    assert.equal(summary.length, 51);
    assert.ok(summary.endsWith('…'));
  });
});

describe('frontend document and source contract', () => {
  it('exposes exact peer navigation with DaoCanon Search active', async () => {
    const html = await fs.promises.readFile(path.join(repoRoot, 'src/web/index.html'), 'utf8');
    assert.match(html, /<nav class="global-nav" aria-label="주요 서비스">/);
    assert.match(html, /<a href="\/" aria-current="page">DaoCanon Search<\/a>/);
    assert.match(html, /<a href="\/research\/">Research Library<\/a>/);
    assert.doesNotMatch(html, /127\.0\.0\.1:(?:3040|3060)/);
  });

  it('provides semantic tabs, live state, browse, result, detail, and pagination regions', async () => {
    const html = await fs.promises.readFile(path.join(repoRoot, 'src/web/index.html'), 'utf8');
    assert.ok(html.includes('role="tablist"'));
    assert.equal((html.match(/role="tab"/g) ?? []).length, 6);
    assert.ok(html.includes('aria-selected="true"'));
    assert.ok(html.includes('role="tabpanel"'));
    assert.ok(html.includes('aria-live="polite"'));
    for (const marker of [
      'id="search-form"',
      'id="draft-status"',
      'id="division-list"',
      'id="results"',
      'id="detail"',
      'id="previous-page"',
      'id="next-page"',
      'id="reader-view"',
      'id="reader-back"',
      'id="reader-heading"',
      'id="reader-status"',
      'id="reader-lines"',
      'id="reader-previous"',
      'id="reader-next"',
    ]) {
      assert.ok(html.includes(marker), marker);
    }
  });

  it('commits the attempted query heading before awaiting a search response', async () => {
    const js = await fs.promises.readFile(path.join(repoRoot, 'src/web/app.js'), 'utf8');
    const runSearch = js.slice(
      js.indexOf('async function runSearch('),
      js.indexOf('async function loadHealth('),
    );
    assert.ok(runSearch.indexOf('refs.resultsHeading.textContent') > -1);
    assert.ok(runSearch.indexOf('refs.resultsHeading.textContent') < runSearch.indexOf('await fetch('));
  });


  it('preserves the grounded mockup palette and responsive focus-safe layout', async () => {
    const css = await fs.promises.readFile(path.join(repoRoot, 'src/web/styles.css'), 'utf8');
    for (const marker of [
      '--bg: #f4efe6',
      '--paper: #fffaf2',
      '--ink: #1c1915',
      '--accent: #7a3e2e',
      ':focus-visible',
      'overflow-wrap: anywhere',
      '-webkit-line-clamp: 3',
      '@media (max-width: 760px)',
      '@media (max-width: 360px)',
    ]) {
      assert.ok(css.includes(marker), marker);
    }
    assert.ok(!css.includes('html { min-width: 280px; }'));
    assert.ok(!css.includes('.catalog-table td:nth-child(3) { display: none; }'));
  });

  it('limits physical-line claims to fulltext results and keeps browse paths visible', async () => {
    const html = await fs.promises.readFile(path.join(repoRoot, 'src/web/index.html'), 'utf8');
    const js = await fs.promises.readFile(path.join(repoRoot, 'src/web/app.js'), 'utf8');
    assert.ok(html.includes('전문 결과는 물리 행 위치'));
    assert.ok(!html.includes('모든 결과는 상대 경로와 물리 행 위치'));
    assert.ok(js.includes("pathCell.dataset.label = '상대 경로';"));
  });

  it('connects only to accepted endpoints and uses inert DOM sinks', async () => {
    const js = await fs.promises.readFile(path.join(repoRoot, 'src/web/app.js'), 'utf8');
    assert.ok(js.includes("fetch('/health'"));
    assert.ok(js.includes("fetch('/v1/catalog'"));
    assert.ok(js.includes('fetch(buildSearchUrl('));
    assert.ok(js.includes('fetch(buildWorkUrl('));
    assert.ok(js.includes('fetch(buildConvertUrl('));
    assert.ok(js.includes('fetch(buildTranslateUrl('));
    assert.ok(js.includes("document.createElement('mark')"));
    assert.ok(js.includes('.textContent'));
    for (const forbidden of [
      '.innerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
      '周易参同契分章通真义',
      '114 works',
    ]) {
      assert.ok(!js.includes(forbidden), forbidden);
    }
  });

  it('keeps mock rows and unsupported work-detail claims out of packaged assets', async () => {
    const combined = await Promise.all([
      'src/web/index.html',
      'src/web/styles.css',
      'src/web/app.js',
    ].map((file) => fs.promises.readFile(path.join(repoRoot, file), 'utf8')));
    const source = combined.join('\n');
    for (const forbidden of [
      '周易参同契分章通真义',
      '周易参同契发挥',
      '114 works',
      '이체자 확장 ON',
      '/v1/works/:id',
    ]) {
      assert.ok(!source.includes(forbidden), forbidden);
    }
  });

  it('uses a semantic search-result list and keeps context out of result buttons', async () => {
    const js = await fs.promises.readFile(path.join(repoRoot, 'src/web/app.js'), 'utf8');
    const searchRenderer = js.slice(
      js.indexOf('function renderSearchResults()'),
      js.indexOf('function invalidateSearch()'),
    );
    assert.ok(searchRenderer.includes("makeNode('ul', 'result-list')"));
    assert.ok(searchRenderer.includes("makeNode('li', 'result-item')"));
    assert.ok(searchRenderer.includes("button.setAttribute('aria-pressed'"));
    assert.ok(!searchRenderer.includes('context_before'));
    assert.ok(!searchRenderer.includes('context_after'));
  });

  it('exposes reader-only convert and translate controls with strict semantics', async () => {
    const html = await fs.promises.readFile(path.join(repoRoot, 'src/web/index.html'), 'utf8');
    for (const marker of [
      'id="reader-convert"',
      'id="reader-convert-original"',
      'id="reader-convert-s2t"',
      'id="reader-convert-t2s"',
      'data-convert="original"',
      'data-convert="s2t"',
      'data-convert="t2s"',
      'id="reader-convert-status"',
      'id="reader-translate"',
      'id="reader-translate-text"',
      'id="reader-translate-model"',
      'value="gemma4:12b"',
      'value="gemma4:26b"',
      'name="reader-translate-source"',
      'value="classical_zh"',
      'value="zh"',
      'id="reader-translate-submit"',
      'id="reader-translate-output"',
      'id="reader-translate-status"',
    ]) {
      assert.ok(html.includes(marker), marker);
    }
    assert.ok(html.includes('role="radiogroup"'));
    assert.ok(html.includes('data-convert="s2t" data-direction="s2t">번체</button>'));
    assert.ok(html.includes('data-convert="t2s" data-direction="t2s">간체</button>'));
    assert.ok(!html.includes('value="simplified"'));
    assert.ok(!html.includes('value="traditional"'));
    assert.ok(!html.includes('value="exaone"'));
    assert.ok(!html.includes('value="gemma"'));
    assert.ok(!html.includes('value="llama"'));
    assert.ok(!html.includes('value="polyglot"'));
  });

  it('keeps reader text tools free of HTML injection and source-text persistence', async () => {
    const js = await fs.promises.readFile(path.join(repoRoot, 'src/web/app.js'), 'utf8');
    const html = await fs.promises.readFile(path.join(repoRoot, 'src/web/index.html'), 'utf8');
    for (const unsafe of [
      '.innerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval(',
      'new Function',
    ]) {
      assert.ok(!js.includes(unsafe), unsafe);
      assert.ok(!html.includes(unsafe), unsafe);
    }
    const readerBody = js.slice(js.indexOf('function renderReader('), js.indexOf('async function loadReader('));
    assert.ok(readerBody.includes("makeNode('li', 'reader-line')"));
    assert.ok(readerBody.includes('renderConvertedLines'));
    assert.ok(!readerBody.includes('convertMap.textContent'));
    const runTranslate = js.slice(js.indexOf('async function runTranslate('), js.indexOf('function renderReader('));
    assert.ok(runTranslate.includes("refs.readerTranslateOutput.textContent"));
    assert.ok(!runTranslate.includes('.innerHTML'));
    assert.ok(!runTranslate.includes('localStorage'));
    assert.ok(!runTranslate.includes('sessionStorage'));
  });

  it('resets reader text tools and cancels in-flight requests on reader navigation', async () => {
    const js = await fs.promises.readFile(path.join(repoRoot, 'src/web/app.js'), 'utf8');
    assert.ok(js.includes('resetReaderTools()'));
    assert.ok(js.includes('convertGate.begin()'));
    assert.ok(js.includes('translateGate.begin()'));
    const loadReader = js.slice(js.indexOf('async function loadReader('), js.indexOf('function handleHashRoute('));
    assert.ok(loadReader.includes('resetReaderTools()'));
    assert.ok(loadReader.includes('readerGate.begin()'));
  });
});

describe('shared Evidence Workspace stylesheet contract', () => {
  const researchWebRoot = [
    path.resolve(repoRoot, '..', 'daocanon-research-web'),
    path.resolve(repoRoot, '..', '..', 'daocanon-research-web'),
  ].find((p) => fs.existsSync(p)) || path.resolve(repoRoot, '..', 'daocanon-research-web');

  it('serves and links evidence-workspace.css after product styles.css in Search', async () => {
    const html = await fs.promises.readFile(path.join(repoRoot, 'src/web/index.html'), 'utf8');
    const stylesIdx = html.indexOf('<link rel="stylesheet" href="/styles.css">');
    const sharedIdx = html.indexOf('<link rel="stylesheet" href="/evidence-workspace.css">');
    assert.ok(stylesIdx !== -1, 'styles.css must be linked');
    assert.ok(sharedIdx !== -1, 'evidence-workspace.css must be linked');
    assert.ok(sharedIdx > stylesIdx, 'evidence-workspace.css must be linked AFTER styles.css');
  });

  it('ensures shared Evidence Workspace styling is owned by evidence-workspace.css and removed from Search styles.css', async () => {
    const productCss = await fs.promises.readFile(path.join(repoRoot, 'src/web/styles.css'), 'utf8');
    const sharedCss = await fs.promises.readFile(path.join(repoRoot, 'src/web/evidence-workspace.css'), 'utf8');

    assert.ok(sharedCss.includes('--ew-accent: #2e7a76'), 'sharedCss must define neutral --ew-accent design token');

    const selectors = ['.shelf-menu', '.dialogue-panel', '.stageb-tabs', '.stage3-controls'];
    for (const selector of selectors) {
      assert.ok(sharedCss.includes(selector), `evidence-workspace.css must include ${selector}`);
      assert.ok(!productCss.includes(selector), `Search styles.css must NOT include ${selector}`);
    }

    const buttonContainers = ['.shelf-menu', '.dialogue-panel', '.stageb-panel', '.reader-stage3-actions'];
    for (const container of buttonContainers) {
      assert.ok(sharedCss.includes(`${container} .primary-button`), `evidence-workspace.css must scope .primary-button within ${container}`);
      assert.ok(sharedCss.includes(`${container} .secondary-button`), `evidence-workspace.css must scope .secondary-button within ${container}`);
    }
  });

  it('ensures Research Library links shared stylesheet and no longer owns shared selector blocks', async () => {
    const html = await fs.promises.readFile(path.join(researchWebRoot, 'src/web/index.html'), 'utf8');
    const stylesIdx = html.indexOf('<link rel="stylesheet" href="/assets/styles.css">');
    const sharedIdx = html.indexOf('<link rel="stylesheet" href="/assets/evidence-workspace.css">');
    assert.ok(stylesIdx !== -1, 'Research Library index.html must link /assets/styles.css');
    assert.ok(sharedIdx !== -1, 'Research Library index.html must link /assets/evidence-workspace.css');
    assert.ok(sharedIdx > stylesIdx, '/assets/evidence-workspace.css must be linked AFTER /assets/styles.css');

    const researchShared = await fs.promises.readFile(path.join(researchWebRoot, 'src/web/evidence-workspace.css'), 'utf8');
    const candidateShared = await fs.promises.readFile(path.join(repoRoot, 'src/web/evidence-workspace.css'), 'utf8');
    assert.equal(researchShared, candidateShared, 'Research Library shared stylesheet must be identical to candidate');

    const researchProductCss = await fs.promises.readFile(path.join(researchWebRoot, 'src/web/styles.css'), 'utf8');
    const selectors = ['.shelf-menu', '.dialogue-panel', '.stageb-tabs', '.stage3-controls'];
    for (const selector of selectors) {
      assert.ok(!researchProductCss.includes(selector), `Research Library styles.css must NOT include ${selector}`);
    }
  });

  it('keeps the vendored Evidence Workspace module identical to the Research Library canonical copy', async () => {
    const moduleFiles = [
      'evidence-workspace.css',
      'evidence.js',
      'shelf-store.js',
      'stage3.js',
      'stageb.js',
      'stageb-render.js',
      'stageb-controls.js',
    ];

    for (const file of moduleFiles) {
      const canonical = await fs.promises.readFile(path.join(researchWebRoot, 'src/web', file), 'utf8');
      const vendored = await fs.promises.readFile(path.join(repoRoot, 'src/web', file), 'utf8');
      assert.equal(vendored, canonical, `${file} must be synchronized from the Research Library canonical module`);
    }
  });

  it('owns compact original-reader control dimensions inside the shared Evidence Workspace module', async () => {
    const sharedCss = await fs.promises.readFile(path.join(repoRoot, 'src/web/evidence-workspace.css'), 'utf8');
    const rule = sharedCss.match(/\.stageb-source-open\s*\{([\s\S]*?)\n\}/)?.[1] || '';

    assert.match(rule, /flex:\s*0\s+0\s+auto/);
    assert.match(rule, /min-width:\s*0/);
    assert.match(rule, /min-height:\s*22px/);
    assert.match(rule, /padding:\s*2px\s+8px/);
    assert.match(rule, /font-size:\s*11px/);
    assert.match(rule, /font-family:\s*Arial,\s*sans-serif/);
    assert.match(rule, /font-weight:\s*400/);
    assert.match(rule, /border:\s*2px\s+outset\s+buttonface/);
    assert.match(rule, /white-space:\s*nowrap/);
  });

  it('keeps the Search dialogue panel element order aligned with the Research Library canonical module', async () => {
    const panelIds = (html) => {
      const start = html.indexOf('<section id="dialogue-panel"');
      const end = html.indexOf('</section>', start);
      assert.notEqual(start, -1, 'dialogue panel must exist');
      assert.notEqual(end, -1, 'dialogue panel must close');
      return [...html.slice(start, end).matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    };
    const searchHtml = await fs.promises.readFile(path.join(repoRoot, 'src/web/index.html'), 'utf8');
    const researchHtml = await fs.promises.readFile(path.join(researchWebRoot, 'src/web/index.html'), 'utf8');
    assert.deepEqual(panelIds(searchHtml), panelIds(researchHtml));
  });
});
