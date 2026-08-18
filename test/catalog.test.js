import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalizeRelativePath,
  computeWorkId,
  buildCatalog,
  MAX_METADATA_CHARS,
  SCHEMA_VERSION,
  SOURCE_ID,
} from '../src/catalog.js';
import { createSafeHandler, createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const fixtureRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures/corpus',
);

function byPath(catalog, relativePath) {
  return catalog.records.find((r) => r.relative_path === relativePath);
}

async function makeTempCorpus(files) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'daocanon-catalog-test-'),
  );
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  return {
    root,
    async cleanup() {
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}

describe('canonicalizeRelativePath', () => {
  it('returns NFC-normalized POSIX relative paths unchanged', () => {
    assert.equal(canonicalizeRelativePath('正统部/标准经.md'), '正统部/标准经.md');
    assert.equal(canonicalizeRelativePath('a/b/c.md'), 'a/b/c.md');
  });

  it('normalizes NFD input to NFC', () => {
    const nfd = 'NFC部/e\u0301经.md';
    const nfc = 'NFC部/\u00e9经.md';
    assert.equal(canonicalizeRelativePath(nfd), nfc);
  });

  it('preserves case and division exactly', () => {
    assert.equal(canonicalizeRelativePath('Div/X.md'), 'Div/X.md');
    assert.notEqual(
      canonicalizeRelativePath('div/x.md'),
      canonicalizeRelativePath('Div/X.md'),
    );
  });

  it('rejects empty and non-string input', () => {
    assert.throws(() => canonicalizeRelativePath(''), /relative path/);
    assert.throws(() => canonicalizeRelativePath(null), /relative path/);
    assert.throws(() => canonicalizeRelativePath(42), /relative path/);
  });

  it('rejects absolute paths', () => {
    assert.throws(() => canonicalizeRelativePath('/abs/a.md'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('\\abs\\a.md'), /relative path/);
  });

  it('rejects Windows drive-absolute identities', () => {
    assert.throws(() => canonicalizeRelativePath('C:/outside.md'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('z:/outside.md'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('C:'), /relative path/);
    assert.throws(() => computeWorkId('C:/outside.md'), /relative path/);
  });

  it('rejects dot segments and root escaping identities', () => {
    assert.throws(() => canonicalizeRelativePath('.'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('..'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('../a.md'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('a/../b.md'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('a//b.md'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('a/./b.md'), /relative path/);
    assert.throws(() => canonicalizeRelativePath('a\\b.md'), /relative path/);
  });
});

describe('computeWorkId', () => {
  it('matches the exact frozen vector for a known relative path', () => {
    assert.equal(
      computeWorkId('正统部/标准经.md'),
      'dc1_f13ddffb672d0172b2a03d3c4798a99f453ba94ed4117d6fcb149e7dc84635a3',
    );
  });

  it('produces identical IDs for NFC-equivalent path identities', () => {
    assert.equal(
      computeWorkId('NFC部/e\u0301经.md'),
      computeWorkId('NFC部/\u00e9经.md'),
    );
  });

  it('produces different IDs for different divisions with the same stem', () => {
    assert.notEqual(
      computeWorkId('正统部/标准经.md'),
      computeWorkId('藏外/标准经.md'),
    );
  });

  it('emits lowercase hex sha256 with the dc1_ prefix', () => {
    assert.match(computeWorkId('a.md'), /^dc1_[0-9a-f]{64}$/);
  });

  it('rejects invalid identities', () => {
    assert.throws(() => computeWorkId(''), /relative path/);
    assert.throws(() => computeWorkId('/abs.md'), /relative path/);
    assert.throws(() => computeWorkId('..'), /relative path/);
  });
});

describe('buildCatalog — fixture discovery and shape', () => {
  it('exposes schema_version and source_id', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    assert.equal(catalog.schema_version, 'daocanon-catalog-v1');
    assert.equal(catalog.source_id, 'daocanon');
    assert.equal(catalog.schema_version, SCHEMA_VERSION);
    assert.equal(catalog.source_id, SOURCE_ID);
  });

  it('discovers 11 works and excludes 3 INDEX.md files', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    assert.equal(catalog.records.length, 11);
    assert.equal(catalog.summary.work_count, 11);
    assert.equal(catalog.summary.excluded_index_count, 3);
    assert.equal(catalog.summary.excluded_symlink_count, 0);
  });

  it('emits valid, unique work IDs', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const ids = new Set(catalog.records.map((r) => r.work_id));
    assert.equal(ids.size, 11);
    for (const id of ids) assert.match(id, /^dc1_[0-9a-f]{64}$/);
  });

  it('orders records by UTF-8 binary order of normalized relative path', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const paths = catalog.records.map((r) => r.relative_path);
    const utf8Binary = (a, b) =>
      Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
    assert.deepEqual(paths, [...paths].sort(utf8Binary));
  });

  it('orders supplementary-plane paths by code point, not UTF-16 unit', async () => {
    // U+E000 (private use) is D800 DC00-free; U+10000 is a surrogate pair.
    // UTF-16 unit order puts U+10000 first (D800 < E000); code-point/UTF-8
    // binary order puts U+E000 first (0xE000 < 0x10000).
    const temp = await makeTempCorpus({
      '部/\uD800\uDC00.md': '甲\n经名：甲。\n',
      '部/\uE000.md': '乙\n经名：乙。\n',
    });
    try {
      const catalog = await buildCatalog(temp.root);
      assert.deepEqual(
        catalog.records.map((r) => r.relative_path),
        ['部/\uE000.md', '部/\uD800\uDC00.md'],
      );
    } finally {
      await temp.cleanup();
    }
  });

  it('is deeply deterministic across repeated builds', async () => {
    const a = await buildCatalog(fixtureRoot);
    const b = await buildCatalog(fixtureRoot);
    assert.deepEqual(a, b);
  });

  it('never exposes the absolute corpus root', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const text = JSON.stringify(catalog);
    assert.ok(!text.includes(fixtureRoot), 'must not contain the corpus root');
    assert.ok(!text.includes('/home/'), 'must not contain host home paths');
  });

  it('records carry exactly the contract fields', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    for (const record of catalog.records) {
      assert.deepEqual(Object.keys(record).sort(), [
        'author',
        'division',
        'parse_warnings',
        'relative_path',
        'source_id',
        'title',
        'work_id',
      ]);
      assert.equal(record.source_id, 'daocanon');
      assert.ok(Array.isArray(record.parse_warnings));
    }
  });

  it('parses the standard record with the frozen ID vector', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const record = byPath(catalog, '正统部/标准经.md');
    assert.ok(record, 'standard fixture record must exist');
    assert.equal(record.title, '标准经');
    assert.equal(record.division, '正统部');
    assert.equal(
      record.work_id,
      'dc1_f13ddffb672d0172b2a03d3c4798a99f453ba94ed4117d6fcb149e7dc84635a3',
    );
  });

  it('reports null division for root-level works', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const record = byPath(catalog, '题名不同.md');
    assert.ok(record, 'root-level fixture record must exist');
    assert.equal(record.division, null);
  });

  it('summary carries the required count keys', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    for (const key of [
      'work_count',
      'excluded_index_count',
      'excluded_symlink_count',
      'warning_count',
      'warning_counts',
      'duplicate_title_group_count',
    ]) {
      assert.ok(key in catalog.summary, `summary.${key} must exist`);
    }
  });
});

describe('buildCatalog — metadata parsing policy', () => {
  it('parses canonical title and raw author from a standard header', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const record = byPath(catalog, '正统部/标准经.md');
    assert.equal(record.title, '标准经');
    assert.equal(record.author, '张三撰');
    assert.deepEqual(record.parse_warnings, []);
  });

  it('maps 撰人不详 to null author without inventing a person', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const record = byPath(catalog, '正统部/撰人不详经.md');
    assert.equal(record.title, '撰人不详经');
    assert.equal(record.author, null);
    assert.deepEqual(record.parse_warnings, []);
  });

  it('retains raw author attribution for each marker verb', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    assert.equal(byPath(catalog, '正统部/同题甲.md').author, '赵六集');
    assert.equal(byPath(catalog, '深部/子目录/嵌套经.md').author, '孙八述');
    assert.equal(byPath(catalog, '题名不同.md').author, '钱七编');
    assert.equal(byPath(catalog, '藏外/标准经.md').author, '王五注');
  });

  it('falls back to first_nonblank with metadata_header_missing', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const record = byPath(catalog, '正统部/无元数据.md');
    assert.equal(record.title, '无元数据');
    assert.equal(record.author, null);
    assert.deepEqual(record.parse_warnings, ['metadata_header_missing']);
  });

  it('flags malformed leading text before 经名：', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const record = byPath(catalog, '正统部/畸形前缀.md');
    assert.equal(record.title, '畸形前缀');
    assert.equal(record.author, null);
    assert.deepEqual(record.parse_warnings, ['malformed_metadata_prefix']);
  });

  it('uses filename stem and empty_content for empty files', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const record = byPath(catalog, '正统部/空文件.md');
    assert.equal(record.title, '空文件');
    assert.equal(record.author, null);
    assert.deepEqual(record.parse_warnings, ['empty_content']);
  });

  it('flags title/filename-stem mismatch', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const root = byPath(catalog, '题名不同.md');
    assert.equal(root.title, '实际题名');
    assert.deepEqual(root.parse_warnings, ['title_filename_mismatch']);
    const variant = byPath(catalog, '藏外/标准经.md');
    assert.equal(variant.title, '标准经别本');
    assert.deepEqual(variant.parse_warnings, ['title_filename_mismatch']);
  });

  it('keeps NFC fixture title equal to its stem without mismatch noise', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const record = byPath(catalog, 'NFC部/\u00e9经.md');
    assert.ok(record, 'NFC-normalized record must exist');
    assert.equal(record.author, '周九撰');
    assert.deepEqual(record.parse_warnings, []);
  });

  it('emits empty_metadata_title and falls back when parsed title is empty', async () => {
    const temp = await makeTempCorpus({
      '部/空题经.md': '空题经\n经名：。张三撰。\n',
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/空题经.md');
      assert.equal(record.title, '空题经');
      assert.deepEqual(record.parse_warnings, ['empty_metadata_title']);
    } finally {
      await temp.cleanup();
    }
  });

  it('keeps parse_warnings in stable sorted order', async () => {
    const temp = await makeTempCorpus({
      '部/错名.md': '别题\n经名：。张三撰。\n',
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/错名.md');
      assert.equal(record.title, '别题');
      assert.deepEqual(record.parse_warnings, [
        'empty_metadata_title',
        'title_filename_mismatch',
      ]);
    } finally {
      await temp.cleanup();
    }
  });

  it('leaves author null when the attribution sentence has no marker', async () => {
    const temp = await makeTempCorpus({
      '部/无撰者.md': '无撰者\n经名：无撰者。大明三年。\n',
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/无撰者.md');
      assert.equal(record.title, '无撰者');
      assert.equal(record.author, null);
      assert.deepEqual(record.parse_warnings, []);
    } finally {
      await temp.cleanup();
    }
  });

  it('takes the whole remainder as title when no full stop follows', async () => {
    const temp = await makeTempCorpus({
      '部/无句读.md': '无句读\n经名：无句读\n',
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/无句读.md');
      assert.equal(record.title, '无句读');
      assert.equal(record.author, null);
      assert.deepEqual(record.parse_warnings, []);
    } finally {
      await temp.cleanup();
    }
    // A remainder without a full stop is still bounded by the metadata cap.
    const exact = '戊'.repeat(MAX_METADATA_CHARS);
    const bounded = await makeTempCorpus({
      '部/无句读长.md': `无句读长\n经名：${exact}\n`,
    });
    try {
      const catalog = await buildCatalog(bounded.root);
      const record = byPath(catalog, '部/无句读长.md');
      assert.equal(record.title, exact);
      assert.ok(!record.parse_warnings.includes('metadata_truncated'));
    } finally {
      await bounded.cleanup();
    }
  });

  it('caps metadata titles with metadata_truncated', async () => {
    const long = '长'.repeat(1_000_000);
    const temp = await makeTempCorpus({
      '部/巨题.md': `巨题\n经名：${long}。张三撰。\n`,
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/巨题.md');
      assert.equal(record.title, '长'.repeat(MAX_METADATA_CHARS));
      assert.equal([...record.title].length, MAX_METADATA_CHARS);
      assert.equal(record.author, '张三撰', 'short author stays intact');
      assert.deepEqual(record.parse_warnings, [
        'metadata_truncated',
        'title_filename_mismatch',
      ]);
      assert.ok(
        JSON.stringify(catalog).length < 65536,
        'catalog output must stay bounded',
      );
    } finally {
      await temp.cleanup();
    }
  });

  it('truncates on code-point boundaries without orphaning surrogates', async () => {
    const temp = await makeTempCorpus({
      '部/巨符.md': `巨符\n经名：${'𠀀'.repeat(250)}。\n`,
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/巨符.md');
      assert.equal(record.title, '𠀀'.repeat(MAX_METADATA_CHARS));
      assert.equal([...record.title].length, MAX_METADATA_CHARS);
      assert.ok(record.parse_warnings.includes('metadata_truncated'));
    } finally {
      await temp.cleanup();
    }
  });

  it('does not truncate a title at exactly the bound', async () => {
    const exact = '丁'.repeat(MAX_METADATA_CHARS);
    const temp = await makeTempCorpus({
      '部/边界.md': `边界\n经名：${exact}。\n`,
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/边界.md');
      assert.equal(record.title, exact);
      assert.ok(!record.parse_warnings.includes('metadata_truncated'));
    } finally {
      await temp.cleanup();
    }
  });

  it('caps raw author attribution at the same bound', async () => {
    const hugeAuthor = '王'.repeat(300) + '撰';
    const temp = await makeTempCorpus({
      '部/巨者.md': `巨者\n经名：巨者。${hugeAuthor}。\n`,
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/巨者.md');
      assert.equal([...record.author].length, MAX_METADATA_CHARS);
      assert.ok(record.parse_warnings.includes('metadata_truncated'));
    } finally {
      await temp.cleanup();
    }
  });

  it('flags metadata_header_missing for single-line files', async () => {
    const temp = await makeTempCorpus({
      '部/单行.md': '单行\n',
    });
    try {
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/单行.md');
      assert.equal(record.title, '单行');
      assert.deepEqual(record.parse_warnings, ['metadata_header_missing']);
    } finally {
      await temp.cleanup();
    }
  });
});

describe('GET /v1/catalog — HTTP contract', () => {
  async function startServer(root) {
    const config = loadConfig({ DAO_CANON_ROOT: root });
    const server = createServer(config);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close() {
        return new Promise((resolve) => server.close(resolve));
      },
    };
  }

  it('returns 200 with records in data and summary in meta', async () => {
    const srv = await startServer(fixtureRoot);
    try {
      const res = await fetch(`${srv.baseUrl}/v1/catalog`);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('application/json'));
      const body = await res.json();
      assert.equal(body.status, 'ok');
      assert.equal(typeof body.request_id, 'string');
      assert.equal(body.data.schema_version, 'daocanon-catalog-v1');
      assert.equal(body.data.source_id, 'daocanon');
      assert.equal(body.data.records.length, 11);
      assert.equal(body.meta.work_count, 11);
      assert.equal(body.meta.excluded_index_count, 3);
      assert.equal(body.meta.duplicate_title_group_count, 1);
    } finally {
      await srv.close();
    }
  });

  it('serves deterministic record order across requests', async () => {
    const srv = await startServer(fixtureRoot);
    try {
      const a = await (await fetch(`${srv.baseUrl}/v1/catalog`)).json();
      const b = await (await fetch(`${srv.baseUrl}/v1/catalog`)).json();
      assert.deepEqual(a.data.records, b.data.records);
    } finally {
      await srv.close();
    }
  });

  it('does not expose absolute host paths', async () => {
    const srv = await startServer(fixtureRoot);
    try {
      const text = await (await fetch(`${srv.baseUrl}/v1/catalog`)).text();
      assert.ok(!text.includes(fixtureRoot), 'must not contain the corpus root');
      assert.ok(!text.includes('/home/'), 'must not contain host home paths');
    } finally {
      await srv.close();
    }
  });

  it('returns JSON 405 with Allow: GET for unsupported methods', async () => {
    const srv = await startServer(fixtureRoot);
    try {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const res = await fetch(`${srv.baseUrl}/v1/catalog`, { method });
        assert.equal(res.status, 405, `${method} must return 405`);
        assert.ok(res.headers.get('allow').includes('GET'));
        const body = await res.json();
        assert.equal(body.status, 'error');
        assert.equal(body.error.code, 'method_not_allowed');
      }
    } finally {
      await srv.close();
    }
  });

  it('returns 503 corpus_unavailable when the corpus is missing', async () => {
    const missing = `/tmp/daocanon-missing-${process.pid}`;
    const srv = await startServer(missing);
    try {
      const res = await fetch(`${srv.baseUrl}/v1/catalog`);
      assert.equal(res.status, 503);
      const text = await res.text();
      const body = JSON.parse(text);
      assert.equal(body.status, 'error');
      assert.equal(body.error.code, 'corpus_unavailable');
      assert.ok(!text.includes(missing), 'must not leak the configured path');
      assert.ok(!text.includes('    at '), 'must not leak stack traces');
    } finally {
      await srv.close();
    }
  });

  it('returns 503 and health not ready when the build fails on duplicate identity', async () => {
    const temp = await makeTempCorpus({});
    try {
      const dir = path.join(temp.root, '部');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'e\u0301.md'), '甲\n');
      await fs.promises.writeFile(path.join(dir, '\u00e9.md'), '乙\n');

      const srv = await startServer(temp.root);
      try {
        const res = await fetch(`${srv.baseUrl}/v1/catalog`);
        assert.equal(res.status, 503);
        const body = await res.json();
        assert.equal(body.error.code, 'corpus_unavailable');

        const health = await fetch(`${srv.baseUrl}/health`);
        assert.equal(health.status, 503, 'health must not claim ready');
      } finally {
        await srv.close();
      }
    } finally {
      await temp.cleanup();
    }
  });

  it('memoizes the catalog per server instance', async () => {
    const temp = await makeTempCorpus({ '部/甲.md': '甲\n经名：甲。\n' });
    try {
      const srvA = await startServer(temp.root);
      try {
        const first = await (await fetch(`${srvA.baseUrl}/v1/catalog`)).json();
        assert.equal(first.meta.work_count, 1);

        await fs.promises.writeFile(
          path.join(temp.root, '部/乙.md'),
          '乙\n经名：乙。\n',
        );
        const second = await (await fetch(`${srvA.baseUrl}/v1/catalog`)).json();
        assert.equal(second.meta.work_count, 1, 'same instance stays memoized');

        const srvB = await startServer(temp.root);
        try {
          const third = await (await fetch(`${srvB.baseUrl}/v1/catalog`)).json();
          assert.equal(third.meta.work_count, 2, 'new instance rebuilds');
        } finally {
          await srvB.close();
        }
      } finally {
        await srvA.close();
      }
    } finally {
      await temp.cleanup();
    }
  });
});

describe('createSafeHandler — async error boundary', () => {
  it('returns JSON internal_error when the handler rejects before headers', async () => {
    const server = http.createServer(
      createSafeHandler(async () => {
        throw new Error('boom secret-detail');
      }),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/x`);
      assert.equal(res.status, 500);
      assert.ok(res.headers.get('content-type').includes('application/json'));
      const body = await res.json();
      assert.equal(body.status, 'error');
      assert.equal(body.error.code, 'internal_error');
      const text = JSON.stringify(body);
      assert.ok(!text.includes('boom'), 'must not leak the error message');
      assert.ok(!text.includes('    at '), 'must not leak stack traces');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('closes the connection without details when headers were already sent', async () => {
    const server = http.createServer(
      createSafeHandler(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write('partial');
        throw new Error('boom-after-headers');
      }),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const raw = await new Promise((resolve, reject) => {
        const socket = net.connect(server.address().port, '127.0.0.1', () => {
          socket.write(
            'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
          );
        });
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk;
        });
        socket.on('end', () => resolve(data));
        socket.on('close', () => resolve(data));
        socket.on('error', reject);
      });
      // Bytes buffered before the failure may be discarded by the socket
      // close; the contract is that the connection ends without details.
      assert.ok(!raw.includes('boom-after-headers'), 'must not leak details');
      assert.ok(!raw.includes('    at '), 'must not leak stack traces');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('buildCatalog — runtime corpus hazards', () => {
  it('excludes symlinked files and directories without following them', async (t) => {
    const temp = await makeTempCorpus({
      '部/实文件.md': '实文件\n经名：实文件。\n',
      '部/目标.md': '目标\n经名：目标。\n',
    });
    try {
      await fs.promises.symlink(
        path.join(temp.root, '部/目标.md'),
        path.join(temp.root, '部/链接.md'),
      );
      await fs.promises.mkdir(path.join(temp.root, '实目录'));
      await fs.promises.writeFile(
        path.join(temp.root, '实目录/内.md'),
        '内\n经名：内。\n',
      );
      await fs.promises.symlink(
        path.join(temp.root, '实目录'),
        path.join(temp.root, '链接目录'),
      );

      const catalog = await buildCatalog(temp.root);
      assert.equal(catalog.summary.excluded_symlink_count, 2);
      assert.equal(catalog.summary.work_count, 3);
      assert.ok(!byPath(catalog, '部/链接.md'), 'symlinked file excluded');
      assert.ok(!byPath(catalog, '链接目录/内.md'), 'symlinked dir not followed');
    } catch (err) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) {
        t.skip(`platform does not permit symlinks: ${err.code}`);
        return;
      }
      throw err;
    } finally {
      await temp.cleanup();
    }
  });

  it('rejects duplicate canonical path identity as an integrity error', async () => {
    const temp = await makeTempCorpus({});
    try {
      const dir = path.join(temp.root, '部');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, 'e\u0301.md'),
        '甲\n经名：甲。\n',
      );
      await fs.promises.writeFile(path.join(dir, '\u00e9.md'), '乙\n经名：乙。\n');

      await assert.rejects(buildCatalog(temp.root), (err) => {
        assert.equal(err.code, 'DUPLICATE_WORK_IDENTITY');
        return true;
      });
    } finally {
      await temp.cleanup();
    }
  });

  it('represents unreadable candidates with a warning instead of dropping them', async (t) => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.skip('root ignores file permissions');
      return;
    }
    const temp = await makeTempCorpus({
      '部/可读.md': '可读\n经名：可读。\n',
      '部/不可读.md': '不可读\n经名：不可读。\n',
    });
    const locked = path.join(temp.root, '部/不可读.md');
    try {
      await fs.promises.chmod(locked, 0o000);
      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/不可读.md');
      assert.ok(record, 'unreadable candidate must remain a record');
      assert.equal(record.title, '不可读');
      assert.equal(record.author, null);
      assert.deepEqual(record.parse_warnings, ['unreadable_file']);
      assert.ok(byPath(catalog, '部/可读.md'), 'readable sibling still parsed');
    } finally {
      await fs.promises.chmod(locked, 0o644).catch(() => {});
      await temp.cleanup();
    }
  });

  it('flags invalid UTF-8 with a stable warning and filename fallback', async () => {
    const temp = await makeTempCorpus({});
    try {
      const dir = path.join(temp.root, '部');
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, '坏字节.md'),
        Buffer.from([0x58, 0xff, 0xfe, 0x0a, 0x61]),
      );

      const catalog = await buildCatalog(temp.root);
      const record = byPath(catalog, '部/坏字节.md');
      assert.ok(record, 'invalid UTF-8 candidate must remain a record');
      assert.equal(record.title, '坏字节');
      assert.equal(record.author, null);
      assert.deepEqual(record.parse_warnings, ['invalid_utf8']);
      assert.ok(
        !JSON.stringify(catalog).includes('\ufffd'),
        'must not emit replacement characters',
      );
    } finally {
      await temp.cleanup();
    }
  });

  // Adversarial TOCTOU: the candidate is a regular file when discovered,
  // then swapped to a symlink pointing outside the corpus before the read.
  // The catalog must never follow the substituted symlink.
  it('never follows a symlink swapped in between discovery and read', async () => {
    const outside = await makeTempCorpus({
      '外部.md': '外部秘密\n经名：外部秘密。外部人撰。\n',
    });
    const temp = await makeTempCorpus({
      '部/正常.md': '正常\n经名：正常。正常人撰。\n',
    });
    const target = path.join(temp.root, '部/正常.md');
    const originalReaddir = fs.promises.readdir;
    let swapped = false;
    fs.promises.readdir = async function patchedReaddir(...args) {
      const entries = await originalReaddir.apply(this, args);
      if (!swapped && String(args[0]).endsWith(`${path.sep}部`)) {
        swapped = true;
        // Discovery has just seen 正常.md as a regular file; race the open.
        await fs.promises.rm(target);
        await fs.promises.symlink(path.join(outside.root, '外部.md'), target);
      }
      return entries;
    };
    try {
      const catalog = await buildCatalog(temp.root);
      assert.ok(swapped, 'the substitution race must actually have run');
      const record = byPath(catalog, '部/正常.md');
      assert.ok(record, 'raced candidate must remain a record');
      const text = JSON.stringify(catalog);
      assert.ok(!text.includes('外部秘密'), 'outside title must not be read');
      assert.ok(!text.includes('外部人'), 'outside author must not be read');
      assert.ok(!text.includes(outside.root), 'outside path must not leak');
      assert.equal(record.title, '正常');
      assert.equal(record.author, null);
      assert.deepEqual(record.parse_warnings, ['unreadable_file']);
      assert.equal(
        catalog.summary.excluded_symlink_count,
        0,
        'discovery legitimately saw a regular file',
      );
    } finally {
      fs.promises.readdir = originalReaddir;
      await temp.cleanup();
      await outside.cleanup();
    }
  });

  it('never follows a parent directory swapped to an outside symlink', async () => {
    const outside = await makeTempCorpus({
      '正常.md': '外部秘密\n经名：外部秘密。外部人撰。\n',
    });
    const temp = await makeTempCorpus({
      '部/正常.md': '正常\n经名：正常。正常人撰。\n',
    });
    const insideDir = path.join(temp.root, '部');
    const savedDir = path.join(temp.root, '部.saved');
    const originalReaddir = fs.promises.readdir;
    let swapped = false;
    fs.promises.readdir = async function patchedReaddir(...args) {
      const entries = await originalReaddir.apply(this, args);
      if (!swapped && path.resolve(String(args[0])) === path.resolve(insideDir)) {
        swapped = true;
        await fs.promises.rename(insideDir, savedDir);
        await fs.promises.symlink(outside.root, insideDir, 'dir');
      }
      return entries;
    };
    try {
      const catalog = await buildCatalog(temp.root);
      assert.ok(swapped, 'the parent-directory substitution must run');
      const record = byPath(catalog, '部/正常.md');
      assert.ok(record, 'raced candidate must remain a record');
      const text = JSON.stringify(catalog);
      assert.ok(!text.includes('外部秘密'), 'outside title must not be read');
      assert.ok(!text.includes('外部人'), 'outside author must not be read');
      assert.ok(!text.includes(outside.root), 'outside path must not leak');
      assert.equal(record.title, '正常');
      assert.equal(record.author, null);
      assert.deepEqual(record.parse_warnings, ['unreadable_file']);
    } finally {
      fs.promises.readdir = originalReaddir;
      await temp.cleanup();
      await outside.cleanup();
    }
  });

  it('bounds filename fallback when invalid UTF-8 cannot be parsed', async () => {
    const stem = 'a'.repeat(MAX_METADATA_CHARS + 20);
    const temp = await makeTempCorpus({});
    try {
      await fs.promises.writeFile(
        path.join(temp.root, `${stem}.md`),
        Buffer.from([0xff]),
      );
      const catalog = await buildCatalog(temp.root);
      const record = catalog.records[0];
      assert.equal([...record.title].length, MAX_METADATA_CHARS);
      assert.deepEqual(record.parse_warnings, [
        'invalid_utf8',
        'metadata_truncated',
      ]);
    } finally {
      await temp.cleanup();
    }
  });
});

describe('buildCatalog — duplicates and summary aggregation', () => {
  it('keeps duplicate filename stems distinct with different IDs', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const a = byPath(catalog, '正统部/标准经.md');
    const b = byPath(catalog, '藏外/标准经.md');
    assert.notEqual(a.work_id, b.work_id);
  });

  it('marks every record sharing a parsed title with duplicate_title', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    const a = byPath(catalog, '正统部/同题甲.md');
    const b = byPath(catalog, '藏外/同题乙.md');
    assert.equal(a.title, '同题共名');
    assert.equal(b.title, '同题共名');
    assert.deepEqual(a.parse_warnings, [
      'duplicate_title',
      'title_filename_mismatch',
    ]);
    assert.deepEqual(b.parse_warnings, [
      'duplicate_title',
      'title_filename_mismatch',
    ]);
  });

  it('aggregates exact summary counts for the fixture corpus', async () => {
    const catalog = await buildCatalog(fixtureRoot);
    assert.deepEqual(catalog.summary, {
      work_count: 11,
      excluded_index_count: 3,
      excluded_symlink_count: 0,
      warning_count: 9,
      warning_counts: {
        duplicate_title: 2,
        empty_content: 1,
        malformed_metadata_prefix: 1,
        metadata_header_missing: 1,
        title_filename_mismatch: 4,
      },
      duplicate_title_group_count: 1,
    });
  });

  it('counts duplicate-title groups across divisions', async () => {
    const temp = await makeTempCorpus({
      'a/甲.md': '同题一\n经名：同题一。\n',
      'b/乙.md': '同题一\n经名：同题一。\n',
      'a/丙.md': '同题二\n经名：同题二。\n',
      'b/丁.md': '同题二\n经名：同题二。\n',
      'a/独.md': '独自题\n经名：独自题。\n',
    });
    try {
      const catalog = await buildCatalog(temp.root);
      assert.equal(catalog.summary.duplicate_title_group_count, 2);
      assert.equal(catalog.summary.warning_counts.duplicate_title, 4);
      assert.equal(catalog.summary.warning_counts.title_filename_mismatch, 5);
      assert.equal(catalog.summary.warning_count, 9);
    } finally {
      await temp.cleanup();
    }
  });
});

// Narrow live-corpus smoke. Opt in with `npm run test:live`; skipped with a
// clear reason when the configured corpus is absent. Never mutates source.
const LIVE_ROOT =
  process.env.DAO_CANON_ROOT || '/mnt/d/Lab/ScholarLib/Corpus/DaoCanon';
const liveSkipReason = (() => {
  if (process.env.DAO_LIVE_SMOKE !== '1') {
    return 'live corpus smoke disabled; run: npm run test:live';
  }
  if (!fs.existsSync(LIVE_ROOT)) {
    return 'configured corpus root is absent; set DAO_CANON_ROOT to the live corpus';
  }
  return undefined;
})();

describe('live corpus smoke', { skip: liveSkipReason }, () => {
  let liveCatalogPromise = null;
  const getLiveCatalog = () => {
    liveCatalogPromise ??= buildCatalog(LIVE_ROOT);
    return liveCatalogPromise;
  };

  async function hashFile(relativePath) {
    const content = await fs.promises.readFile(
      path.join(LIVE_ROOT, ...relativePath.split('/')),
    );
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  it('matches the measured S0 baseline counts', async () => {
    const catalog = await getLiveCatalog();
    assert.equal(catalog.summary.work_count, 1721);
    assert.equal(catalog.summary.excluded_index_count, 46);
  });

  it('produces identical IDs and order across two builds', async () => {
    const first = await getLiveCatalog();
    const second = await buildCatalog(LIVE_ROOT);
    assert.deepEqual(
      first.records.map((r) => r.work_id),
      second.records.map((r) => r.work_id),
    );
    assert.deepEqual(
      first.records.map((r) => r.relative_path),
      second.records.map((r) => r.relative_path),
    );
  });

  it('returns only non-escaping relative paths and well-formed IDs', async () => {
    const catalog = await getLiveCatalog();
    const ids = new Set();
    for (const record of catalog.records) {
      const rel = record.relative_path;
      assert.ok(!rel.startsWith('/'), `absolute path: ${rel}`);
      assert.ok(!rel.includes('\\'), `backslash path: ${rel}`);
      assert.ok(
        !rel.split('/').includes('..'),
        `root-escaping path: ${rel}`,
      );
      assert.match(record.work_id, /^dc1_[0-9a-f]{64}$/);
      ids.add(record.work_id);
    }
    assert.equal(ids.size, catalog.records.length, 'IDs must be unique');
  });

  it('does not expose the absolute corpus root', async () => {
    const catalog = await getLiveCatalog();
    assert.ok(!JSON.stringify(catalog).includes(LIVE_ROOT));
  });

  it('does not mutate sampled source files', async () => {
    const catalog = await getLiveCatalog();
    const sample = catalog.records.slice(0, 5).map((r) => r.relative_path);
    assert.ok(sample.length > 0, 'sample must not be empty');
    const before = [];
    for (const rel of sample) before.push(await hashFile(rel));
    await buildCatalog(LIVE_ROOT);
    const after = [];
    for (const rel of sample) after.push(await hashFile(rel));
    assert.deepEqual(before, after);
  });
});
