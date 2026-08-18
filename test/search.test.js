import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSearchParams, searchCatalog } from '../src/search.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { buildCatalog } from '../src/catalog.js';

const fixtureRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures/corpus',
);

function record(workId, title, author = null, relativePath = `${workId}.md`) {
  return {
    source_id: 'daocanon',
    work_id: workId,
    title,
    author,
    division: '测试部',
    relative_path: relativePath,
    parse_warnings: [],
  };
}

describe('searchCatalog — title vertical slice', () => {
  it('ranks exact, prefix, then substring matches with catalog order as tie-breaker', () => {
    const records = [
      record('dc1_contains_b', '乙参同契后篇'),
      record('dc1_prefix_b', '参同契乙'),
      record('dc1_exact', '参同契'),
      record('dc1_prefix_a', '参同契甲'),
      record('dc1_contains_a', '甲参同契前篇'),
      record('dc1_other', '道德经'),
    ];

    const result = searchCatalog(records, {
      query: '参同契',
      mode: 'title',
      limit: 20,
      offset: 0,
    });

    assert.equal(result.total, 5);
    assert.deepEqual(
      result.hits.map((hit) => hit.work_id),
      [
        'dc1_exact',
        'dc1_prefix_b',
        'dc1_prefix_a',
        'dc1_contains_b',
        'dc1_contains_a',
      ],
    );
    assert.deepEqual(result.hits[0], {
      source_id: 'daocanon',
      work_id: 'dc1_exact',
      title: '参同契',
      author: null,
      division: '测试部',
      match_type: 'title',
      locator: {
        source_id: 'daocanon',
        relative_path: 'dc1_exact.md',
        line_start: null,
        line_end: null,
      },
    });
  });
});

describe('searchCatalog — author variants and literal matching', () => {
  it('treats 曉 and 晓 as the same author-search variant in both directions', () => {
    const records = [
      record('dc1_a', '甲经', '后蜀彭晓注'),
      record('dc1_b', '乙经', '徒蜀彭曉注'),
      record('dc1_null', '无名经', null),
    ];

    const traditional = searchCatalog(records, {
      query: '彭曉',
      mode: 'author',
      limit: 20,
      offset: 0,
    });
    const simplified = searchCatalog(records, {
      query: '彭晓',
      mode: 'author',
      limit: 20,
      offset: 0,
    });

    assert.deepEqual(
      traditional.hits.map((hit) => hit.work_id),
      ['dc1_a', 'dc1_b'],
    );
    assert.deepEqual(traditional.hits, simplified.hits);
    assert.ok(traditional.hits.every((hit) => hit.match_type === 'author'));
  });

  it('uses NFC literal substrings without regex, shell, or unrelated character folds', () => {
    const records = [
      record('dc1_nfc', 'é经'),
      record('dc1_literal', '[$](经).*'),
      record('dc1_unrelated', '後经'),
      record('dc1_author_unrelated', '别经', '後人撰'),
    ];

    assert.equal(
      searchCatalog(records, {
        query: 'e\u0301',
        mode: 'title',
        limit: 20,
        offset: 0,
      }).total,
      1,
    );
    assert.equal(
      searchCatalog(records, {
        query: '[$](',
        mode: 'title',
        limit: 20,
        offset: 0,
      }).total,
      1,
    );
    assert.equal(
      searchCatalog(records, {
        query: '后',
        mode: 'title',
        limit: 20,
        offset: 0,
      }).total,
      0,
    );
    assert.equal(
      searchCatalog(records, {
        query: '后',
        mode: 'author',
        limit: 20,
        offset: 0,
      }).total,
      0,
    );
  });
});

describe('parseSearchParams — bounded HTTP query contract', () => {
  it('trims and NFC-normalizes q and applies pagination defaults', () => {
    assert.deepEqual(
      parseSearchParams(new URLSearchParams('q=%20e%CC%81%E7%BB%8F%20&mode=title')),
      { query: 'é经', mode: 'title', limit: 20, offset: 0 },
    );
    assert.deepEqual(
      parseSearchParams(new URLSearchParams(`q=${encodeURIComponent('\u0085甲\u0085')}&mode=title`)),
      { query: '甲', mode: 'title', limit: 20, offset: 0 },
    );
  });

  it('accepts the exact query and pagination bounds', () => {
    const one = parseSearchParams(new URLSearchParams('q=甲&mode=author&limit=1&offset=0'));
    assert.deepEqual(one, { query: '甲', mode: 'author', limit: 1, offset: 0 });

    const max = parseSearchParams(
      new URLSearchParams(`q=${'甲'.repeat(100)}&mode=title&limit=100&offset=1000000`),
    );
    assert.equal([...max.query].length, 100);
    assert.equal(max.limit, 100);
    assert.equal(max.offset, 1_000_000);

    const astralMax = parseSearchParams(
      new URLSearchParams(`q=${'𠀀'.repeat(100)}&mode=title`),
    );
    assert.equal([...astralMax.query].length, 100);

    const fulltext = parseSearchParams(
      new URLSearchParams('q=%E9%BB%83%E5%BA%AD%E5%85%A7%E6%99%AF%E7%B6%93&mode=fulltext'),
    );
    assert.deepEqual(fulltext, {
      query: '黃庭內景經',
      mode: 'fulltext',
      limit: 20,
      offset: 0,
    });
  });

  it('rejects missing, repeated, blank, and overlong q as invalid_query', () => {
    for (const raw of [
      'mode=title',
      'q=甲&q=乙&mode=title',
      'q=%20%20&mode=title',
      `q=${encodeURIComponent('\u0085')}&mode=title`,
      `q=${'甲'.repeat(101)}&mode=title`,
      `q=${'𠀀'.repeat(101)}&mode=title`,
    ]) {
      assert.throws(
        () => parseSearchParams(new URLSearchParams(raw)),
        (error) => error.code === 'invalid_query',
        raw,
      );
    }
  });

  it('bounds fulltext canonical expansion so a cross-line source match fits the snippet', () => {
    const accepted = parseSearchParams(
      new URLSearchParams(`q=${encodeURIComponent('ᾂ'.repeat(79))}&mode=fulltext`),
    );
    assert.equal([...accepted.query.normalize('NFD')].length, 316);

    assert.throws(
      () => parseSearchParams(
        new URLSearchParams(`q=${encodeURIComponent('ᾂ'.repeat(80))}&mode=fulltext`),
      ),
      (error) => error.code === 'invalid_query',
    );
  });

  it('rejects missing, repeated, and unsupported mode as invalid_mode', () => {
    for (const raw of [
      'q=甲',
      'q=甲&mode=title&mode=author',
      'q=甲&mode=body',
      'q=甲&mode=TITLE',
    ]) {
      assert.throws(
        () => parseSearchParams(new URLSearchParams(raw)),
        (error) => error.code === 'invalid_mode',
        raw,
      );
    }
  });

  it('strictly validates limit and offset without coercion', () => {
    for (const raw of [
      'q=甲&mode=title&limit=0',
      'q=甲&mode=title&limit=101',
      'q=甲&mode=title&limit=1.5',
      'q=甲&mode=title&limit=+1',
      'q=甲&mode=title&limit=%201',
      'q=甲&mode=title&limit=1&limit=2',
      'q=甲&mode=title&offset=-1',
      'q=甲&mode=title&offset=1000001',
      'q=甲&mode=title&offset=1.0',
      'q=甲&mode=title&offset=0&offset=1',
    ]) {
      assert.throws(
        () => parseSearchParams(new URLSearchParams(raw)),
        (error) => error.code === 'invalid_query',
        raw,
      );
    }
  });

  it('paginates after total calculation and permits beyond-end offsets', () => {
    const records = [record('a', '甲'), record('b', '甲乙'), record('c', '丙甲')];
    const page = searchCatalog(records, {
      query: '甲',
      mode: 'title',
      limit: 1,
      offset: 1,
    });
    assert.equal(page.total, 3);
    assert.deepEqual(page.hits.map((hit) => hit.work_id), ['b']);

    const empty = searchCatalog(records, {
      query: '甲',
      mode: 'title',
      limit: 20,
      offset: 100,
    });
    assert.equal(empty.total, 3);
    assert.deepEqual(empty.hits, []);
  });
});

describe('GET /v1/search — HTTP contract', () => {
  async function startServer(root = fixtureRoot, serverOptions = undefined) {
    const server = createServer(loadConfig({ DAO_CANON_ROOT: root }), serverOptions);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('returns the success envelope, exact hit fields, and pagination metadata', async () => {
    const srv = await startServer();
    try {
      const res = await fetch(
        `${srv.baseUrl}/v1/search?q=${encodeURIComponent('标准经')}&mode=title&limit=1&offset=0`,
      );
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('application/json'));
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.request_id, 'string');
      assert.deepEqual(body.data.query, '标准经');
      assert.equal(body.data.mode, 'title');
      assert.equal(body.data.hits.length, 1);
      assert.deepEqual(Object.keys(body.data.hits[0]).sort(), [
        'author',
        'division',
        'locator',
        'match_type',
        'source_id',
        'title',
        'work_id',
      ]);
      assert.deepEqual(Object.keys(body.data.hits[0].locator).sort(), [
        'line_end',
        'line_start',
        'relative_path',
        'source_id',
      ]);
      assert.deepEqual(body.meta, {
        total: 2,
        limit: 1,
        offset: 0,
        returned_count: 1,
      });
      assert.ok(!JSON.stringify(body).includes(fixtureRoot));
      assert.ok(!JSON.stringify(body).includes('/home/'));
    } finally {
      await srv.close();
    }
  });

  it('maps validation failures to safe 400 error codes', async () => {
    const srv = await startServer();
    try {
      for (const [query, code] of [
        ['mode=title', 'invalid_query'],
        ['q=甲&mode=body', 'invalid_mode'],
        ['q=甲&mode=title&limit=0', 'invalid_query'],
      ]) {
        const res = await fetch(`${srv.baseUrl}/v1/search?${query}`);
        assert.equal(res.status, 400, query);
        const body = await res.json();
        assert.equal(body.error.code, code, query);
        assert.ok(!JSON.stringify(body).includes('    at '));
      }
    } finally {
      await srv.close();
    }
  });

  it('returns 405 with Allow GET and 503 without path leakage', async () => {
    const srv = await startServer();
    try {
      const method = await fetch(`${srv.baseUrl}/v1/search?q=甲&mode=title`, {
        method: 'POST',
      });
      assert.equal(method.status, 405);
      assert.ok(method.headers.get('allow').includes('GET'));
      assert.equal((await method.json()).error.code, 'method_not_allowed');
    } finally {
      await srv.close();
    }

    const missing = `/tmp/daocanon-search-missing-${process.pid}`;
    const unavailable = await startServer(missing);
    try {
      const res = await fetch(`${unavailable.baseUrl}/v1/search?q=甲&mode=title`);
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.equal(JSON.parse(text).error.code, 'corpus_unavailable');
      assert.ok(!text.includes(missing));
      assert.ok(!text.includes('    at '));
    } finally {
      await unavailable.close();
    }
  });

  it('reuses one memoized catalog across concurrent and repeated search requests', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daocanon-search-'));
    await fs.promises.writeFile(path.join(root, '甲.md'), '甲\n经名：甲。\n');
    let catalogBuildCalls = 0;
    const srv = await startServer(root, {
      catalogBuilder: async (corpusRoot) => {
        catalogBuildCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return buildCatalog(corpusRoot);
      },
    });
    try {
      const url = `${srv.baseUrl}/v1/search?q=甲&mode=title`;
      const [first, concurrent] = await Promise.all([
        fetch(url).then((res) => res.json()),
        fetch(url).then((res) => res.json()),
      ]);
      assert.equal(catalogBuildCalls, 1, 'concurrent requests share one in-flight build');
      assert.equal(first.meta.total, 1);
      assert.deepEqual(first.data.hits, concurrent.data.hits);

      await fs.promises.writeFile(path.join(root, '甲乙.md'), '甲乙\n经名：甲乙。\n');
      const repeated = await (await fetch(url)).json();
      assert.equal(catalogBuildCalls, 1, 'completed catalog remains memoized');
      assert.equal(repeated.meta.total, 1, 'same server instance stays memoized');
    } finally {
      await srv.close();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('retries a rejected catalog build on the next request', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daocanon-search-retry-'));
    await fs.promises.writeFile(path.join(root, '甲.md'), '甲\n经名：甲。\n');
    let catalogBuildCalls = 0;
    const srv = await startServer(root, {
      catalogBuilder: async (corpusRoot) => {
        catalogBuildCalls += 1;
        if (catalogBuildCalls === 1) throw new Error('transient build failure');
        return buildCatalog(corpusRoot);
      },
    });
    try {
      const url = `${srv.baseUrl}/v1/search?q=甲&mode=title`;
      const failed = await fetch(url);
      assert.equal(failed.status, 503);
      assert.equal((await failed.json()).error.code, 'corpus_unavailable');

      const recovered = await fetch(url);
      assert.equal(recovered.status, 200);
      assert.equal((await recovered.json()).meta.total, 1);
      assert.equal(catalogBuildCalls, 2);
    } finally {
      await srv.close();
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

describe('live title/author gold search', () => {
  it(
    'returns the owner-confirmed 14 title hits and identical two-work author variants',
    { skip: process.env.DAO_LIVE_SMOKE !== '1' && 'live search smoke disabled' },
    async () => {
      const root = '/mnt/d/Lab/ScholarLib/Corpus/DaoCanon';
      const server = createServer(loadConfig({ DAO_CANON_ROOT: root }));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      try {
        const title = await (
          await fetch(
            `${baseUrl}/v1/search?q=${encodeURIComponent('参同契')}&mode=title&limit=100`,
          )
        ).json();
        assert.equal(title.meta.total, 14);
        assert.equal(title.data.hits.length, 14);

        const simplified = await (
          await fetch(
            `${baseUrl}/v1/search?q=${encodeURIComponent('彭晓')}&mode=author&limit=100`,
          )
        ).json();
        const traditional = await (
          await fetch(
            `${baseUrl}/v1/search?q=${encodeURIComponent('彭曉')}&mode=author&limit=100`,
          )
        ).json();

        assert.equal(simplified.meta.total, 2);
        assert.equal(traditional.meta.total, 2);
        assert.deepEqual(
          traditional.data.hits.map((hit) => hit.work_id),
          simplified.data.hits.map((hit) => hit.work_id),
        );
        assert.deepEqual(
          simplified.data.hits.map((hit) => hit.locator.relative_path),
          [
            '正统道藏太玄部/周易参同契分章通真义.md',
            '正统道藏太玄部/周易参同契鼎器歌明镜图.md',
          ],
        );

        const responseText = JSON.stringify({ title, simplified, traditional });
        assert.ok(!responseText.includes(root));
        assert.ok(!responseText.includes('/home/'));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
});
