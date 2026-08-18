import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeWorkId } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const fixtureRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures/corpus',
);

async function listen(root = fixtureRoot, dependencies = {}) {
  const server = createServer(loadConfig({ DAO_CANON_ROOT: root }), dependencies);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function makeTempCorpus(files) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daocanon-work-test-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.promises.writeFile(absolutePath, content);
  }
  return {
    root,
    cleanup: () => fs.promises.rm(root, { recursive: true, force: true }),
  };
}

describe('GET /v1/works/:work_id — passage success contract', () => {
  let srv;

  before(async () => {
    srv = await listen();
  });

  after(async () => {
    await srv.close();
  });

  it('returns the requested physical line from cached catalog content', async () => {
    const workId = computeWorkId('正统部/标准经.md');
    const response = await fetch(`${srv.baseUrl}/v1/works/${workId}?line=2`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);

    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.deepEqual(body.data.work, {
      source_id: 'daocanon',
      work_id: workId,
      title: '标准经',
      author: '张三撰',
      division: '正统部',
      relative_path: '正统部/标准经.md',
      parse_warnings: [],
    });
    assert.deepEqual(body.data.passage, {
      target_line: 2,
      line_start: 1,
      line_end: 2,
      total_lines: 2,
      previous_line: null,
      next_line: null,
      lines: [
        { number: 1, text: '标准经' },
        { number: 2, text: '经名：标准经。张三撰。' },
      ],
    });
    assert.deepEqual(body.meta, {
      max_lines: 100,
      max_code_points: 200_000,
    });
    assert.ok(!JSON.stringify(body).includes(fixtureRoot));
  });
});

describe('GET /v1/works/:work_id — bounded failure contract', () => {
  it('strictly validates one positive line and reports out-of-range targets', async () => {
    const srv = await listen();
    const workId = computeWorkId('正统部/标准经.md');
    try {
      for (const query of ['line=0', 'line=-1', 'line=1.5', 'line=abc', 'line=1&line=2']) {
        const response = await fetch(`${srv.baseUrl}/v1/works/${workId}?${query}`);
        assert.equal(response.status, 400, query);
        assert.equal((await response.json()).error.code, 'invalid_line', query);
      }
      const outOfRange = await fetch(`${srv.baseUrl}/v1/works/${workId}?line=3`);
      assert.equal(outOfRange.status, 416);
      assert.equal((await outOfRange.json()).error.code, 'line_out_of_range');
    } finally {
      await srv.close();
    }
  });

  it('returns safe 404/405 envelopes without treating IDs as paths', async () => {
    const srv = await listen();
    const unknown = `dc1_${'0'.repeat(64)}`;
    const known = computeWorkId('正统部/标准经.md');
    try {
      const missing = await fetch(`${srv.baseUrl}/v1/works/${unknown}`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json()).error.code, 'work_not_found');

      const malformed = await fetch(`${srv.baseUrl}/v1/works/..%2F标准经.md`);
      assert.equal(malformed.status, 404);
      assert.equal((await malformed.json()).error.code, 'not_found');

      const method = await fetch(`${srv.baseUrl}/v1/works/${known}`, { method: 'POST' });
      assert.equal(method.status, 405);
      assert.equal(method.headers.get('allow'), 'GET');
      assert.equal((await method.json()).error.code, 'method_not_allowed');
    } finally {
      await srv.close();
    }
  });

  it('returns a contiguous maximum-100-line window around the target', async () => {
    const content = Array.from({ length: 200 }, (_, index) => `제${index + 1}행`).join('\n');
    const temp = await makeTempCorpus({
      '测试部/长经.md': `长经\n经名：长经。测试者撰。\n${content}\n`,
    });
    const srv = await listen(temp.root);
    const workId = computeWorkId('测试部/长经.md');
    try {
      const response = await fetch(`${srv.baseUrl}/v1/works/${workId}?line=50`);
      assert.equal(response.status, 200);
      const { passage } = (await response.json()).data;
      assert.equal(passage.target_line, 50);
      assert.equal(passage.line_start, 40);
      assert.equal(passage.line_end, 139);
      assert.equal(passage.lines.length, 100);
      assert.deepEqual(
        passage.lines.map(({ number }) => number),
        Array.from({ length: 100 }, (_, index) => index + 40),
      );
      assert.equal(passage.previous_line, 1);
      assert.equal(passage.next_line, 140);
    } finally {
      await srv.close();
      await temp.cleanup();
    }
  });

  it('refuses an unreadable work and a target line above the response cap safely', async () => {
    const temp = await makeTempCorpus({
      '测试部/坏字节.md': Buffer.from([0xff, 0xfe]),
      '测试部/超长行.md': `超长行\n经名：超长行。\n${'甲'.repeat(200_001)}\n`,
    });
    const srv = await listen(temp.root);
    try {
      const unreadable = await fetch(
        `${srv.baseUrl}/v1/works/${computeWorkId('测试部/坏字节.md')}`,
      );
      assert.equal(unreadable.status, 503);
      assert.equal((await unreadable.json()).error.code, 'work_unavailable');

      const oversized = await fetch(
        `${srv.baseUrl}/v1/works/${computeWorkId('测试部/超长行.md')}?line=3`,
      );
      assert.equal(oversized.status, 413);
      assert.equal((await oversized.json()).error.code, 'passage_too_large');
    } finally {
      await srv.close();
      await temp.cleanup();
    }
  });
});

describe('live fulltext-to-reader owner gold', () => {
  it(
    'opens the first 黄庭内景经 hit at its real physical line',
    {
      skip: process.env.DAO_LIVE_SMOKE !== '1' && 'live reader smoke disabled',
      timeout: 180_000,
    },
    async () => {
      const root = '/mnt/d/Lab/ScholarLib/Corpus/DaoCanon';
      const server = createServer(loadConfig({ DAO_CANON_ROOT: root }));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      try {
        const searchResponse = await fetch(
          `${baseUrl}/v1/search?q=${encodeURIComponent('黄庭内景经')}&mode=fulltext&limit=20&offset=0`,
        );
        assert.equal(searchResponse.status, 200);
        const searchBody = await searchResponse.json();
        assert.equal(searchBody.meta.total, 52);
        const first = searchBody.data.hits[0];
        assert.equal(first.locator.relative_path, '正统道藏太平部/三洞珠囊.md');
        assert.equal(first.locator.line_start, 1053);

        const workResponse = await fetch(
          `${baseUrl}/v1/works/${first.work_id}?line=${first.locator.line_start}`,
        );
        assert.equal(workResponse.status, 200);
        const workBody = await workResponse.json();
        assert.equal(workBody.data.work.work_id, first.work_id);
        assert.equal(workBody.data.work.relative_path, first.locator.relative_path);
        assert.equal(workBody.data.passage.target_line, 1053);
        const matched = workBody.data.passage.lines.find(({ number }) => number === 1053);
        assert.ok(matched?.text.includes('黄庭内景经'));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    },
  );
});
