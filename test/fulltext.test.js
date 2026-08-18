import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCatalog, getCatalogContents } from '../src/catalog.js';
import { searchFulltext } from '../src/fulltext.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

async function withCorpus(files, run) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daocanon-fulltext-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(root, ...relativePath.split('/'));
      await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.promises.writeFile(absolutePath, content, 'utf8');
    }
    const catalog = await buildCatalog(root);
    return await run({ root, catalog, contents: getCatalogContents(catalog) });
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

function options(query, overrides = {}) {
  return {
    query,
    mode: 'fulltext',
    limit: 20,
    offset: 0,
    ...overrides,
  };
}

describe('searchFulltext — physical line ranges', () => {
  it('returns same-line and adjacent two-line hits, collapses same-line duplicates, and excludes INDEX.md', async () => {
    await withCorpus(
      {
        '甲部/甲经.md': [
          '甲经',
          '经名：甲经。',
          '前文',
          '青靈與青靈同在一行',
          '另見青靈於後行',
          '末文',
        ].join('\n'),
        '乙部/乙经.md': [
          '乙经',
          '经名：乙经。',
          '跨行起青',
          '靈跨行止',
          '后文',
        ].join('\n'),
        '乙部/INDEX.md': '索引中的青靈不得返回',
      },
      async ({ catalog, contents }) => {
        assert.ok(contents instanceof Map);
        assert.equal(contents.size, 2);
        assert.ok(!JSON.stringify(catalog).includes('青靈與青靈同在一行'));

        const result = searchFulltext(catalog.records, contents, options('青靈'));
        assert.equal(result.total, 3);
        assert.deepEqual(
          result.hits.map((hit) => [
            hit.locator.relative_path,
            hit.locator.line_start,
            hit.locator.line_end,
          ]),
          [
            ['乙部/乙经.md', 3, 4],
            ['甲部/甲经.md', 4, 4],
            ['甲部/甲经.md', 5, 5],
          ],
        );
        const sameLine = result.hits[1];
        assert.equal(sameLine.match_type, 'fulltext');
        assert.equal(sameLine.match_text, '青靈');
        assert.ok(sameLine.snippet.includes('青靈'));
        assert.equal(sameLine.context_before, '前文');
        assert.equal(sameLine.context_after, '另見青靈於後行');

        const crossLine = result.hits[0];
        assert.equal(crossLine.match_text, '青\n靈');
        assert.ok(crossLine.snippet.includes('青\n靈'));
        assert.equal(crossLine.context_before, '经名：乙经。');
        assert.equal(crossLine.context_after, '后文');
        assert.ok(!result.hits.some((hit) => hit.locator.relative_path === '乙部/INDEX.md'));
      },
    );
  });

  it('keeps an adjacent-line hit when an earlier same-line occurrence shares the line pair', async () => {
    await withCorpus(
      { '경계중복经.md': 'aba\nba' },
      async ({ catalog, contents }) => {
        const result = searchFulltext(catalog.records, contents, options('aba'));
        assert.deepEqual(
          result.hits.map((hit) => [
            hit.locator.line_start,
            hit.locator.line_end,
            hit.match_text,
          ]),
          [
            [1, 1, 'aba'],
            [1, 2, 'a\nba'],
          ],
        );
      },
    );
  });

  it('keeps literal metacharacters, deterministic catalog/line ordering, and paginates after total', async () => {
    await withCorpus(
      {
        '乙部/后经.md': '后经\n经名：后经。\n先有[$](.*)\n再有[$](.*)',
        '甲部/前经.md': '前经\n经名：前经。\n唯一[$](.*)',
      },
      async ({ catalog, contents }) => {
        const all = searchFulltext(
          catalog.records,
          contents,
          options('[$](.*)'),
        );
        assert.deepEqual(
          all.hits.map((hit) => [
            hit.locator.relative_path,
            hit.locator.line_start,
            hit.locator.line_end,
          ]),
          [
            ['乙部/后经.md', 3, 3],
            ['乙部/后经.md', 4, 4],
            ['甲部/前经.md', 3, 3],
          ],
        );

        const page = searchFulltext(
          catalog.records,
          contents,
          options('[$](.*)', { limit: 1, offset: 1 }),
        );
        assert.equal(page.total, 3);
        assert.equal(page.hits.length, 1);
        assert.equal(page.hits[0].locator.relative_path, '乙部/后经.md');
        assert.equal(page.hits[0].locator.line_start, 4);
      },
    );
  });

  it('bounds source-preserving snippets and contexts while keeping the match', async () => {
    const longBefore = '前'.repeat(400);
    const longPrefix = '甲'.repeat(400);
    const longSuffix = '乙'.repeat(400);
    const longAfter = '後'.repeat(400);
    await withCorpus(
      {
        '长部/长经.md': [
          '长经',
          '经名：长经。',
          longBefore,
          `${longPrefix}核心詞${longSuffix}`,
          longAfter,
        ].join('\n'),
      },
      async ({ catalog, contents }) => {
        const [hit] = searchFulltext(
          catalog.records,
          contents,
          options('核心詞'),
        ).hits;
        assert.ok(hit.snippet.includes('核心詞'));
        assert.ok([...hit.snippet].length <= 320);
        assert.ok([...hit.context_before].length <= 160);
        assert.ok([...hit.context_after].length <= 160);
        assert.equal(hit.locator.line_start, 4);
        assert.equal(hit.locator.line_end, 4);
      },
    );
  });

  it('keeps both complete cross-line source fragments when canonical decomposition expands the query', async () => {
    const query = '각'.repeat(100);
    const decomposed = [...query.normalize('NFD')];
    const firstPart = decomposed.slice(0, 250).join('');
    const secondPart = decomposed.slice(250).join('');
    await withCorpus(
      { '분해경계经.md': `${firstPart}\n${secondPart}` },
      async ({ catalog, contents }) => {
        const [hit] = searchFulltext(catalog.records, contents, options(query)).hits;
        assert.equal(hit.match_text, `${firstPart}\n${secondPart}`);
        assert.ok(hit.snippet.includes(hit.match_text));
        assert.ok([...hit.snippet].length <= 320);
      },
    );
  });

  it('returns null context at physical file boundaries', async () => {
    await withCorpus(
      { '边界经.md': '首詞\n中行\n尾詞\n' },
      async ({ catalog, contents }) => {
        const first = searchFulltext(catalog.records, contents, options('首詞')).hits[0];
        const last = searchFulltext(catalog.records, contents, options('尾詞')).hits[0];
        assert.equal(first.context_before, null);
        assert.equal(first.context_after, '中行');
        assert.equal(last.context_before, '中行');
        assert.equal(last.context_after, null);
      },
    );
  });

  it('matches NFC queries against NFD source text without crossing three lines', async () => {
    await withCorpus(
      {
        '정규화经.md': '정규화经\n经名：정규화经。\ne\u0301詞',
        '세줄经.md': '세줄经\n经名：세줄经。\n青\n靈\n道',
      },
      async ({ catalog, contents }) => {
        const normalized = searchFulltext(
          catalog.records,
          contents,
          options('é詞'),
        );
        assert.equal(normalized.total, 1);
        assert.equal(normalized.hits[0].match_text, 'e\u0301詞');

        const threeLines = searchFulltext(
          catalog.records,
          contents,
          options('青靈道'),
        );
        assert.equal(threeLines.total, 0);
      },
    );
  });

  it('matches an NFC query against canonically equivalent mixed-normalization source', async () => {
    await withCorpus(
      { '혼합정규화经.md': '混合\n经名：混合。\née\u0301' },
      async ({ catalog, contents }) => {
        const result = searchFulltext(catalog.records, contents, options('éé'));
        assert.equal(result.total, 1);
        assert.equal(result.hits[0].match_text, 'ée\u0301');
      },
    );
  });

  it('projects canonically reordered combining marks back to the complete source grapheme', async () => {
    await withCorpus(
      { '重排经.md': '重排经\n经名：重排经。\na\u0315\u0300X' },
      async ({ catalog, contents }) => {
        const result = searchFulltext(catalog.records, contents, options('à'));

        assert.equal(result.total, 1);
        assert.equal(result.hits[0].match_text, 'a\u0315\u0300');
        assert.ok(result.hits[0].snippet.includes('a\u0315\u0300'));
      },
    );
  });

  it('preserves a reordered source grapheme when its canonical match crosses a line', async () => {
    await withCorpus(
      { '跨行重排经.md': '跨行重排经\n经名：跨行重排经。\na\u0315\u0300\nX' },
      async ({ catalog, contents }) => {
        const result = searchFulltext(catalog.records, contents, options('à\u0315X'));

        assert.equal(result.total, 1);
        assert.equal(result.hits[0].locator.line_start, 3);
        assert.equal(result.hits[0].locator.line_end, 4);
        assert.equal(result.hits[0].match_text, 'a\u0315\u0300\nX');
      },
    );
  });

  it('canonically matches reordered marks when NFC and NFD query forms are identical', async () => {
    await withCorpus(
      {
        '동일변형经.md': '동일변형经\n经名：동일변형经。\nq\u0315\u0301',
        '동일변형跨行经.md': '동일변형跨行经\n经名：동일변형跨行经。\nq\u0315\u0301\nX',
      },
      async ({ catalog, contents }) => {
        const sameLine = searchFulltext(
          catalog.records,
          contents,
          options('q\u0301\u0315'),
        );
        assert.equal(sameLine.total, 2);
        assert.ok(sameLine.hits.every((hit) => hit.match_text === 'q\u0315\u0301'));

        const crossLine = searchFulltext(
          catalog.records,
          contents,
          options('q\u0301\u0315X'),
        );
        assert.equal(crossLine.total, 1);
        assert.equal(crossLine.hits[0].locator.line_start, 3);
        assert.equal(crossLine.hits[0].locator.line_end, 4);
        assert.equal(crossLine.hits[0].match_text, 'q\u0315\u0301\nX');
      },
    );
  });

  it('omits a canonical occurrence whose complete source grapheme exceeds the snippet bound', async () => {
    const oversizedGrapheme = `a${'\u0315'.repeat(320)}\u0300`;
    await withCorpus(
      { '초과결합经.md': `초과결합经\n经名：초과결합经。\n${oversizedGrapheme}` },
      async ({ catalog, contents }) => {
        const result = searchFulltext(catalog.records, contents, options('à'));
        assert.equal(result.total, 0);
      },
    );
  });

  it('keeps an exact 320-code-point source match intact instead of replacing match text with ellipses', async () => {
    const sameLineGrapheme = `a${'\u0315'.repeat(318)}\u0300`;
    const crossLineFirst = `a${'\u0315'.repeat(316)}\u0300`;
    await withCorpus(
      {
        '상한동일행经.md': `상한동일행经\n经名：상한동일행经。\n前${sameLineGrapheme}後`,
        '상한跨行经.md': `상한跨行经\n经名：상한跨行经。\n前${crossLineFirst}\nX後`,
      },
      async ({ catalog, contents }) => {
        const sameLine = searchFulltext(catalog.records, contents, options('à'));
        const sameLineHit = sameLine.hits.find((hit) => hit.title === '상한동일행经');
        assert.equal([...sameLineHit.match_text].length, 320);
        assert.equal([...sameLineHit.snippet].length, 320);
        assert.ok(sameLineHit.snippet.includes(sameLineHit.match_text));

        const crossLineQuery = `à${'\u0315'.repeat(316)}X`;
        const crossLine = searchFulltext(
          catalog.records,
          contents,
          options(crossLineQuery),
        );
        assert.equal(crossLine.total, 1);
        assert.equal([...crossLine.hits[0].match_text].length, 320);
        assert.equal([...crossLine.hits[0].snippet].length, 320);
        assert.ok(crossLine.hits[0].snippet.includes(crossLine.hits[0].match_text));
      },
    );
  });

  it('continues after an oversized canonical occurrence to a later representable hit', async () => {
    const oversizedGrapheme = `a${'\u0315'.repeat(320)}\u0300`;
    await withCorpus(
      { '후속일치经.md': `후속일치经\n经名：후속일치经。\n${oversizedGrapheme} Z à` },
      async ({ catalog, contents }) => {
        const result = searchFulltext(catalog.records, contents, options('à'));
        assert.equal(result.total, 1);
        assert.equal(result.hits[0].match_text, 'à');
        assert.ok(result.hits[0].snippet.includes('à'));
      },
    );
  });
});

describe('searchFulltext — S4 exact-script boundary', () => {
  it('searches each corpus spelling literally without claiming traditional/simplified conversion', async () => {
    await withCorpus(
      {
        '甲部/繁体经.md': '繁体经\n经名：繁体经。\n暮臥先讀《黃庭內景經》一過乃眠。',
        '乙部/简体经.md': '简体经\n经名：简体经。\n暮卧先读《黄庭内景经》一过乃眠。',
      },
      async ({ catalog, contents }) => {
        const traditional = searchFulltext(
          catalog.records,
          contents,
          options('黃庭內景經'),
        );
        const simplified = searchFulltext(
          catalog.records,
          contents,
          options('黄庭内景经'),
        );

        assert.equal(traditional.total, 1);
        assert.equal(simplified.total, 1);
        assert.equal(traditional.hits[0].match_text, '黃庭內景經');
        assert.equal(simplified.hits[0].match_text, '黄庭内景经');
        assert.notEqual(traditional.hits[0].work_id, simplified.hits[0].work_id);
      },
    );
  });
});

describe('GET /v1/search?mode=fulltext — HTTP contract', () => {
  it('returns bounded fulltext hits without exposing cached source text through catalog', async () => {
    await withCorpus(
      {
        '甲部/甲经.md': '甲经\n经名：甲经。\n前文\n秘密搜尋詞在此\n後文',
      },
      async ({ root }) => {
        const server = createServer(loadConfig({ DAO_CANON_ROOT: root }));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        try {
          const response = await fetch(
            `${baseUrl}/v1/search?q=${encodeURIComponent('秘密搜尋詞')}&mode=fulltext`,
          );
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.deepEqual(Object.keys(body).sort(), ['data', 'meta', 'request_id', 'status']);
          assert.equal(body.status, 'ok');
          assert.equal(typeof body.request_id, 'string');
          assert.deepEqual(Object.keys(body.data).sort(), ['hits', 'mode', 'query']);
          assert.equal(body.data.query, '秘密搜尋詞');
          assert.equal(body.data.mode, 'fulltext');
          assert.deepEqual(body.meta, {
            total: 1,
            limit: 20,
            offset: 0,
            returned_count: 1,
          });
          assert.deepEqual(Object.keys(body.data.hits[0]).sort(), [
            'author',
            'context_after',
            'context_before',
            'division',
            'locator',
            'match_text',
            'match_type',
            'snippet',
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
          assert.equal(body.data.hits[0].locator.line_start, 4);
          assert.ok(body.data.hits[0].snippet.includes('秘密搜尋詞'));
          assert.ok(!JSON.stringify(body).includes(root));

          const catalogResponse = await fetch(`${baseUrl}/v1/catalog`);
          const catalogText = await catalogResponse.text();
          assert.equal(catalogResponse.status, 200);
          assert.ok(!catalogText.includes('秘密搜尋詞在此'));
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
  });

  it('returns safe 503 when the fulltext corpus is unavailable', async () => {
    const missing = path.join(os.tmpdir(), `daocanon-fulltext-missing-${process.pid}`);
    const server = createServer(loadConfig({ DAO_CANON_ROOT: missing }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/v1/search?q=甲&mode=fulltext`,
      );
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.equal(JSON.parse(text).error.code, 'corpus_unavailable');
      assert.ok(!text.includes(missing));
      assert.ok(!text.includes('    at '));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('returns fulltext-specific safe 400 and 405 envelopes', async () => {
    await withCorpus(
      { '甲经.md': '甲经\n经名：甲经。\n甲' },
      async ({ root }) => {
        const server = createServer(loadConfig({ DAO_CANON_ROOT: root }));
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        try {
          const invalid = await fetch(`${baseUrl}/v1/search?mode=fulltext`);
          assert.equal(invalid.status, 400);
          assert.equal((await invalid.json()).error.code, 'invalid_query');

          const method = await fetch(`${baseUrl}/v1/search?q=甲&mode=fulltext`, {
            method: 'POST',
          });
          assert.equal(method.status, 405);
          assert.ok(method.headers.get('allow').includes('GET'));
          assert.equal((await method.json()).error.code, 'method_not_allowed');
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
  });

  it('returns safe 500 for an unexpected fulltext implementation defect', async () => {
    await withCorpus(
      { '甲经.md': '甲经\n经名：甲经。\n甲' },
      async ({ root }) => {
        const server = createServer(
          loadConfig({ DAO_CANON_ROOT: root }),
          {
            fulltextSearcher: () => {
              throw new Error('private implementation detail');
            },
          },
        );
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
          const response = await fetch(
            `http://127.0.0.1:${server.address().port}/v1/search?q=甲&mode=fulltext`,
          );
          assert.equal(response.status, 500);
          const text = await response.text();
          assert.equal(JSON.parse(text).error.code, 'internal_error');
          assert.ok(!text.includes('private implementation detail'));
          assert.ok(!text.includes('    at '));
        } finally {
          await new Promise((resolve) => server.close(resolve));
        }
      },
    );
  });
});

describe('live fulltext owner gold', () => {
  it(
    'returns deterministic 52-line/25-work hits for simplified 黄庭内景经',
    { skip: process.env.DAO_LIVE_SMOKE !== '1' && 'live fulltext smoke disabled' },
    async () => {
      const root = '/mnt/d/Lab/ScholarLib/Corpus/DaoCanon';
      const server = createServer(loadConfig({ DAO_CANON_ROOT: root }));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      try {
        const request = async (query) => {
          const response = await fetch(
            `${baseUrl}/v1/search?q=${encodeURIComponent(query)}&mode=fulltext&limit=100`,
          );
          assert.equal(response.status, 200);
          return response.json();
        };

        const simplified = await request('黄庭内景经');
        const repeated = await request('黄庭内景经');
        assert.equal(simplified.meta.total, 52);
        assert.equal(new Set(simplified.data.hits.map((hit) => hit.work_id)).size, 25);

        const locators = (body) => body.data.hits.map((hit) => [
          hit.work_id,
          hit.locator.relative_path,
          hit.locator.line_start,
          hit.locator.line_end,
        ]);
        assert.deepEqual(locators(simplified), locators(repeated));

        assert.ok(locators(simplified).some(([, relativePath, start]) =>
          relativePath === '正统道藏太平部/三洞珠囊.md' && start === 1053));
        assert.ok(locators(simplified).some(([, relativePath, start]) =>
          relativePath === '正统道藏太玄部/真诰.md' && start === 912));

        const representatives = new Map([
          ['正统道藏太平部/三洞珠囊.md', [1053]],
          ['正统道藏太平部/无上秘要.md', [2975, 2978, 3504]],
          ['正统道藏太玄部/云笈七签.md', [
            733, 738, 763, 784, 2502, 2504, 2541, 2556, 2562, 3094, 3864, 7976,
          ]],
          ['正统道藏太玄部/真诰.md', [912, 1338]],
        ]);
        const hitByLocator = new Map(simplified.data.hits.map((hit) => [
          `${hit.locator.relative_path}:${hit.locator.line_start}`,
          hit,
        ]));
        for (const [relativePath, lines] of representatives) {
          for (const line of lines) {
            const hit = hitByLocator.get(`${relativePath}:${line}`);
            assert.ok(hit, `missing representative locator ${relativePath}:${line}`);
            const source = await fs.promises.readFile(
              path.join(root, ...relativePath.split('/')),
              'utf8',
            );
            const reopened = source.split(/\r\n|\r|\n/)[line - 1];
            assert.ok(reopened.includes(hit.match_text));
          }
        }

        for (const hit of simplified.data.hits.slice(0, 5)) {
          const source = await fs.promises.readFile(
            path.join(root, ...hit.locator.relative_path.split('/')),
            'utf8',
          );
          const physicalLines = source.split(/\r\n|\r|\n/);
          const reopened = physicalLines
            .slice(hit.locator.line_start - 1, hit.locator.line_end)
            .join('\n');
          assert.ok(reopened.includes(hit.match_text));
        }

        const none = await request('此詞在道藏中確定不存在甲乙丙丁');
        const noneRepeated = await request('此詞在道藏中確定不存在甲乙丙丁');
        assert.equal(none.meta.total, 0);
        assert.deepEqual(none.data.hits, []);
        assert.deepEqual(none.data, noneRepeated.data);
        assert.deepEqual(none.meta, noneRepeated.meta);

        const responseText = JSON.stringify({ simplified, repeated, none, noneRepeated });
        assert.ok(!responseText.includes(root));
        assert.ok(!responseText.includes('/home/'));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
});
