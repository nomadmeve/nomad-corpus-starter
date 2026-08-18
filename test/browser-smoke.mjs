import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForJson(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw lastError ?? new Error(`timed out waiting for ${url}`);
}

async function openCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
  };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result.value;
}

async function waitForExpression(cdp, expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, `Boolean(${expression})`)) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for expression: ${expression}`);
}

const chrome = process.env.CHROME_BIN ?? '/usr/bin/google-chrome';
await fs.promises.access(chrome, fs.constants.X_OK);

const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daocanon-browser-corpus-'));
const userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'daocanon-browser-chrome-'));
await fs.promises.mkdir(path.join(root, '测试部'));
const lines = [
  '测试经',
  '经名：测试经。测试者撰。',
  ...Array.from({ length: 25 }, (_, index) => `第${index + 1}行 needle 前后文。`),
];
await fs.promises.writeFile(path.join(root, '测试部', '测试经.md'), `${lines.join('\n')}\n`);

const appServer = createServer(loadConfig({ DAO_CANON_ROOT: root }));
await new Promise((resolve) => appServer.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
const debugPort = await reservePort();
const browser = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userData}`,
  '--window-size=390,844',
  'about:blank',
], { stdio: 'ignore' });
const browserExited = new Promise((resolve) => browser.once('exit', resolve));

let cdp;
try {
  const targets = await waitForJson(`http://127.0.0.1:${debugPort}/json/list`);
  const page = targets.find((target) => target.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Chrome page target is unavailable');
  cdp = await openCdp(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      (() => {
        const nativeFetch = window.fetch.bind(window);
        window.__catalogPending = false;
        window.__searchRequests = 0;
        window.__releaseCatalog = null;
        window.fetch = (input, init) => {
          const url = String(input);
          if (url === '/v1/catalog' && !window.__catalogPending) {
            window.__catalogPending = true;
            return new Promise((resolve) => {
              window.__releaseCatalog = () => resolve(nativeFetch(input, init));
            });
          }
          if (url.startsWith('/v1/search')) window.__searchRequests += 1;
          return nativeFetch(input, init);
        };
      })();
    `,
  });
  await cdp.send('Page.navigate', { url: baseUrl });
  // Ready state intentionally hides the status banner rather than displaying
  // a stale "API 준비" message.
  await waitForExpression(cdp, `document.querySelector('#api-status')?.hidden === true`);
  await waitForExpression(cdp, `window.__catalogPending === true`);

  await evaluate(cdp, `
    (() => {
      document.querySelector('[data-example-mode="fulltext"]').click();
      const input = document.querySelector('#query-input');
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, `document.querySelector('#result-count')?.textContent === '25건'`);
  const firstPage = await evaluate(cdp, `({
    catalogPending: window.__catalogPending,
    searchRequests: window.__searchRequests,
    listItems: document.querySelectorAll('.result-item').length,
    contextInList: document.querySelectorAll('.result-item .context').length,
    firstPressed: document.querySelector('.result-button')?.getAttribute('aria-pressed'),
    detailTitle: document.querySelector('.detail-title')?.textContent,
    detailHasContext: document.querySelectorAll('#detail-content .context').length > 0,
    buttonNameHasContext: document.querySelector('.result-button')?.textContent.includes('앞 문맥'),
  })`);
  assert.deepEqual(firstPage, {
    catalogPending: true,
    searchRequests: 1,
    listItems: 20,
    contextInList: 0,
    firstPressed: 'true',
    detailTitle: '测试经',
    detailHasContext: true,
    buttonNameHasContext: false,
  });

  await evaluate(cdp, `window.__releaseCatalog()`);
  await waitForExpression(cdp, `document.querySelectorAll('.division-button').length > 0`);

  await evaluate(cdp, `
    (() => {
      document.querySelector('#tab-title').click();
      const input = document.querySelector('#query-input');
      input.value = '测试经';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, `document.querySelector('#result-count')?.textContent === '1건'`);
  await evaluate(cdp, `history.pushState(null, '', '?origin=search')`);
  await evaluate(cdp, `document.querySelector('.work-link.result-title').focus()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
  await waitForExpression(cdp, `!document.querySelector('#reader-view').hidden
    && document.querySelector('#L1')?.getAttribute('aria-current') === 'location'`);
  assert.deepEqual(await evaluate(cdp, `({
    hash: location.hash.replace(/dc1_[0-9a-f]{64}/, 'WORK_ID'),
    heading: document.querySelector('#reader-heading').textContent,
    matchedText: document.querySelector('#L1 .reader-line-text').textContent,
    searchHidden: document.querySelector('#search-surface').hidden,
    workspaceHidden: document.querySelector('#workspace').hidden,
  })`), {
    hash: '#/works/WORK_ID/lines/1-1',
    heading: '测试经',
    matchedText: '测试经',
    searchHidden: true,
    workspaceHidden: true,
  });
  assert.equal(
    await evaluate(cdp, `(() => {
      const button = document.querySelector('#reader-add-evidence');
      const rect = button?.getBoundingClientRect();
      const hit = rect
        ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        : null;
      return hit?.closest('#reader-add-evidence')?.id || null;
    })()`),
    'reader-add-evidence',
  );
  await evaluate(cdp, `document.querySelector('#reader-add-evidence').click()`);
  await waitForExpression(cdp, `document.querySelector('#shelf-total')?.textContent === '1건'`);
  await evaluate(cdp, `document.querySelector('#dialogue-toggle').click()`);
  assert.deepEqual(await evaluate(cdp, `({
    summary: document.querySelector('.dialogue-context-summary')?.textContent,
    itemCount: document.querySelectorAll('.dialogue-context-items > li').length,
    transferHidden: document.querySelector('#dialogue-transfer-context')?.hidden,
    transferDisabled: document.querySelector('#dialogue-transfer-context')?.disabled,
  })`), {
    summary: '대화 문맥 1/1건 · 원문 1',
    itemCount: 1,
    transferHidden: false,
    transferDisabled: false,
  });
  await evaluate(cdp, `(() => {
    document.querySelector('#dialogue-close').click();
    document.querySelector('#evidence-shelf-toggle').click();
    document.querySelector('#shelf-clear').click();
  })()`);
  await waitForExpression(cdp, `document.querySelector('#shelf-total')?.textContent === '0건'`);
  await evaluate(cdp, `document.querySelector('#reader-back').click()`);
  await waitForExpression(cdp, `document.querySelector('#reader-view').hidden
    && location.search === '?origin=search'
    && document.querySelector('#result-count')?.textContent === '1건'`);
  await evaluate(cdp, `history.back()`);
  await waitForExpression(cdp, `document.querySelector('#reader-view').hidden
    && location.search === '' && location.hash === ''`);

  await evaluate(cdp, `
    (() => {
      document.querySelector('#tab-fulltext').click();
      const input = document.querySelector('#query-input');
      input.value = 'needle';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, `document.querySelector('#result-count')?.textContent === '25건'`);
  await evaluate(cdp, `document.querySelector('.snippet-link').click()`);
  await waitForExpression(cdp, `document.querySelector('#L3')?.getAttribute('aria-current') === 'location'`);
  assert.deepEqual(await evaluate(cdp, `({
    hash: location.hash.replace(/dc1_[0-9a-f]{64}/, 'WORK_ID'),
    matchedText: document.querySelector('#L3 .reader-line-text').textContent,
    lineCount: document.querySelectorAll('.reader-line').length,
    htmlSinkAbsent: document.querySelector('#reader-lines script') === null,
  })`), {
    hash: '#/works/WORK_ID/lines/3-3',
    matchedText: '第1行 needle 前后文。',
    lineCount: 27,
    htmlSinkAbsent: true,
  });
  await evaluate(cdp, `document.querySelector('#reader-back').click()`);
  await waitForExpression(cdp, `document.querySelector('#reader-view').hidden
    && document.querySelectorAll('.result-item').length === 20`);

  await evaluate(cdp, `document.querySelectorAll('.result-item')[1]
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))`);
  await waitForExpression(cdp, `document.querySelector('#L4')?.getAttribute('aria-current') === 'location'`);
  assert.equal(
    await evaluate(cdp, `document.querySelector('#L4 .reader-line-text').textContent`),
    '第2行 needle 前后文。',
  );
  await evaluate(cdp, `document.querySelector('#reader-back').click()`);
  await waitForExpression(cdp, `document.querySelector('#reader-view').hidden
    && document.querySelectorAll('.result-item').length === 20`);

  await evaluate(cdp, `
    (() => {
      const input = document.querySelector('#query-input');
      input.value = '미제출 draft';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#next-page').click();
    })()
  `);
  await waitForExpression(cdp, `
    document.querySelector('#page-summary')?.textContent.startsWith('21')
      && document.querySelectorAll('.result-item').length === 5
  `);
  const pagination = await evaluate(cdp, `({
    heading: document.querySelector('#results-heading').textContent,
    input: document.querySelector('#query-input').value,
    draftVisible: !document.querySelector('#draft-status').hidden,
    listItems: document.querySelectorAll('.result-item').length,
  })`);
  assert.deepEqual(pagination, {
    heading: '전문 · needle',
    input: '미제출 draft',
    draftVisible: true,
    listItems: 5,
  });

  await evaluate(cdp, `
    (() => {
      const tab = document.querySelector('#tab-fulltext');
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    })()
  `);
  assert.deepEqual(await evaluate(cdp, `({
    selected: document.querySelector('[role="tab"][aria-selected="true"]').id,
    focused: document.activeElement.id,
    labelledBy: document.querySelector('[role="tabpanel"]').getAttribute('aria-labelledby'),
  })`), { selected: 'tab-author', focused: 'tab-author', labelledBy: 'tab-author' });

  await evaluate(cdp, `
    (() => {
      const priorFetch = window.fetch;
      window.fetch = (input, init) => String(input).startsWith('/v1/search')
        ? Promise.resolve(new Response(JSON.stringify({
            status: 'ok', data: { hits: null },
            meta: { total: 'broken', offset: 0, limit: 20 },
          }), { status: 200, headers: { 'content-type': 'application/json' } }))
        : priorFetch(input, init);
      document.querySelector('#tab-title').click();
      const input = document.querySelector('#query-input');
      input.value = 'BROKEN';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#search-form').requestSubmit();
    })()
  `);
  await waitForExpression(cdp, `document.querySelector('#message')?.classList.contains('error')`);
  assert.deepEqual(await evaluate(cdp, `({
    heading: document.querySelector('#results-heading').textContent,
    message: document.querySelector('#message').textContent,
    count: document.querySelector('#result-count').textContent,
    draftHidden: document.querySelector('#draft-status').hidden,
  })`), {
    heading: '경전명 · BROKEN',
    message: '요청을 완료하지 못했습니다. API 상태를 확인해 주세요.',
    count: '0건',
    draftHidden: true,
  });

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 280,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Page.navigate', { url: baseUrl });
  await waitForExpression(cdp, `window.__catalogPending === true`);
  await evaluate(cdp, `window.__releaseCatalog()`);
  await waitForExpression(cdp, `document.querySelector('.path-text')?.textContent.length > 0`);
  const narrow = await evaluate(cdp, `({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    pathDisplay: getComputedStyle(document.querySelector('.path-text')).display,
    pathText: document.querySelector('.path-text').textContent,
  })`);
  assert.equal(narrow.innerWidth, 280);
  assert.ok(narrow.documentScrollWidth <= narrow.clientWidth, JSON.stringify(narrow));
  assert.ok(narrow.bodyScrollWidth <= narrow.clientWidth, JSON.stringify(narrow));
  assert.notEqual(narrow.pathDisplay, 'none');
  assert.equal(narrow.pathText, '测试部/测试经.md');

  console.log(JSON.stringify({
    status: 'PASS',
    viewports: ['390x844', '280x844'],
    checks: [
      'catalog/search loading isolation',
      'semantic fulltext list and selected detail',
      'title link Enter to reader line 1',
      'fulltext snippet link to matched physical line',
      'result double-click to matched physical line',
      'reader back preserves search state',
      'committed pagination with dirty draft',
      'keyboard tab semantics',
      'malformed success envelope safety',
      '280px no-overflow catalog path visibility',
    ],
  }));
} finally {
  cdp?.close();
  browser.kill('SIGTERM');
  await Promise.race([browserExited, sleep(3_000)]);
  await new Promise((resolve) => appServer.close(resolve));
  await Promise.all([
    fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    fs.promises.rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  ]);
}
