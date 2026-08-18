import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { buildCatalog, getCatalogContents } from './catalog.js';
import { parseSearchParams, searchCatalog } from './search.js';
import { searchFulltext } from './fulltext.js';
import { buildWorkPassage, parseTargetLine } from './work-reader.js';
import {
  readJsonBody,
  validateConvertRequest,
  validateTranslateRequest,
  createTextProxyHandlers,
} from './text-proxy.js';
const STATIC_ASSETS = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/evidence-workspace.css', { file: 'evidence-workspace.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/evidence.js', { file: 'evidence.js', type: 'text/javascript; charset=utf-8' }],
  ['/shelf-store.js', { file: 'shelf-store.js', type: 'text/javascript; charset=utf-8' }],
  ['/stage3.js', { file: 'stage3.js', type: 'text/javascript; charset=utf-8' }],
  ['/stageb.js', { file: 'stageb.js', type: 'text/javascript; charset=utf-8' }],
  ['/stageb-render.js', { file: 'stageb-render.js', type: 'text/javascript; charset=utf-8' }],
  ['/stageb-controls.js', { file: 'stageb-controls.js', type: 'text/javascript; charset=utf-8' }],
]);

const STATIC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function rawPathHasDotSegment(requestTarget) {
  const withoutQuery = requestTarget.split(/[?#]/, 1)[0];
  let rawPath = withoutQuery;
  const scheme = withoutQuery.indexOf('://');
  if (scheme !== -1) {
    const pathStart = withoutQuery.indexOf('/', scheme + 3);
    rawPath = pathStart === -1 ? '/' : withoutQuery.slice(pathStart);
  }
  return rawPath.split('/').some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    } catch {
      return false;
    }
  });
}

function readPackagedAsset(file) {
  return fs.promises.readFile(new URL(`./web/${file}`, import.meta.url), 'utf8');
}

function staticResponse(res, statusCode, contentType, body) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    ...STATIC_HEADERS,
  });
  res.end(body);
}

function jsonResponse(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(payload);
}

function errorEnvelope(code, message) {
  return {
    status: 'error',
    request_id: crypto.randomUUID(),
    error: { code, message },
  };
}

export function createSafeHandler(handler) {
  return (req, res) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        try {
          if (!res.headersSent) {
            jsonResponse(
              res,
              500,
              errorEnvelope('internal_error', 'unexpected server error'),
            );
          } else {
            res.destroy();
          }
        } catch {
          res.destroy();
        }
      });
  };
}

export function createServer(
  config,
  {
    catalogBuilder = buildCatalog,
    catalogSearcher = searchCatalog,
    fulltextSearcher = searchFulltext,
    staticAssetReader = readPackagedAsset,
    textProxyHandlers = createTextProxyHandlers(config),
  } = {},
) {
  let catalogPromise = null;
  const getCatalog = () => {
    if (!catalogPromise) {
      catalogPromise = catalogBuilder(config.daoCanonRoot).catch((error) => {
        catalogPromise = null;
        throw error;
      });
    }
    return catalogPromise;
  };

  const textProxy = textProxyHandlers;
  const server = http.createServer(createSafeHandler(async (req, res) => {
    if (rawPathHasDotSegment(req.url)) {
      jsonResponse(res, 404, errorEnvelope('not_found', 'not found'));
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      jsonResponse(res, 400, errorEnvelope('invalid_request', 'malformed request target'));
      return;
    }

    const staticAsset = STATIC_ASSETS.get(url.pathname);
    if (staticAsset) {
      if (req.method !== 'GET') {
        jsonResponse(res, 405, errorEnvelope('method_not_allowed', 'use GET'), {
          Allow: 'GET',
          ...STATIC_HEADERS,
        });
        return;
      }
      try {
        const body = await staticAssetReader(staticAsset.file);
        staticResponse(res, 200, staticAsset.type, body);
      } catch {
        jsonResponse(res, 500, errorEnvelope('internal_error', 'web asset is unavailable'), STATIC_HEADERS);
      }
      return;
    }

    const textRoute = url.pathname === '/v1/text/convert' || url.pathname === '/v1/text/translate';
    if (textRoute) {
      if (req.method !== 'POST') {
        jsonResponse(res, 405, errorEnvelope('method_not_allowed', 'use POST'), { Allow: 'POST' });
        return;
      }
      let validated;
      let handler;
      try {
        const body = await readJsonBody(req);
        if (url.pathname === '/v1/text/convert') {
          validated = validateConvertRequest(body);
          handler = textProxy.handleConvert;
        } else {
          validated = validateTranslateRequest(body);
          handler = textProxy.handleTranslate;
        }
      } catch (error) {
        const statuses = {
          invalid_body: 400,
          invalid_text: 400,
          invalid_direction: 400,
          invalid_source_language: 400,
          invalid_target_language: 400,
          invalid_model: 400,
          invalid_json: 400,
          body_too_large: 413,
        };
        jsonResponse(res, statuses[error.code] || 400, errorEnvelope(error.code || 'invalid_body', error.message || 'invalid request'));
        return;
      }
      try {
        const data = await handler.call(textProxy, validated);
        jsonResponse(res, 200, { status: 'ok', request_id: crypto.randomUUID(), data, meta: {} });
      } catch (error) {
        const statuses = {
          text_service_unavailable: 503,
          text_service_timeout: 504,
          text_service_error: 502,
        };
        const status = statuses[error.code] ?? (Number.isInteger(error.status) ? 502 : 500);
        jsonResponse(res, status, errorEnvelope(error.code || 'internal_error', error.message || 'internal error'));
      }
      return;
    }

    if (url.pathname === '/health') {
      if (req.method !== 'GET') {
        jsonResponse(res, 405, errorEnvelope('method_not_allowed', 'use GET'), {
          Allow: 'GET',
        });
        return;
      }

      try {
        const catalog = await getCatalog();
        jsonResponse(res, 200, {
          status: 'ok',
          request_id: crypto.randomUUID(),
          data: {
            process: 'up',
            corpus: { configured: true, readable: true },
            catalog: {
              ready: true,
              work_count: catalog.summary.work_count,
            },
          },
          meta: {},
        });
      } catch {
        jsonResponse(
          res,
          503,
          errorEnvelope('corpus_unavailable', 'corpus root is not readable'),
        );
      }
      return;
    }

    if (url.pathname === '/v1/catalog') {
      if (req.method !== 'GET') {
        jsonResponse(res, 405, errorEnvelope('method_not_allowed', 'use GET'), {
          Allow: 'GET',
        });
        return;
      }

      try {
        const catalog = await getCatalog();
        jsonResponse(res, 200, {
          status: 'ok',
          request_id: crypto.randomUUID(),
          data: {
            schema_version: catalog.schema_version,
            source_id: catalog.source_id,
            records: catalog.records,
          },
          meta: catalog.summary,
        });
      } catch {
        jsonResponse(
          res,
          503,
          errorEnvelope('corpus_unavailable', 'corpus catalog could not be built'),
        );
      }
      return;
    }

    const workRoute = url.pathname.match(/^\/v1\/works\/(dc1_[0-9a-f]{64})$/);
    if (workRoute) {
      if (req.method !== 'GET') {
        jsonResponse(res, 405, errorEnvelope('method_not_allowed', 'use GET'), {
          Allow: 'GET',
        });
        return;
      }
      let targetLine;
      try {
        targetLine = parseTargetLine(url.searchParams);
      } catch (error) {
        jsonResponse(res, 400, errorEnvelope(error.code, error.message));
        return;
      }
      let catalog;
      try {
        catalog = await getCatalog();
      } catch {
        jsonResponse(
          res,
          503,
          errorEnvelope('corpus_unavailable', 'corpus catalog could not be built'),
        );
        return;
      }
      const record = catalog.records.find(({ work_id: workId }) => workId === workRoute[1]);
      if (!record) {
        jsonResponse(res, 404, errorEnvelope('work_not_found', 'work not found'));
        return;
      }
      let result;
      try {
        const content = getCatalogContents(catalog).get(record.work_id);
        result = buildWorkPassage(record, content, targetLine);
      } catch (error) {
        const statuses = {
          work_unavailable: 503,
          line_out_of_range: 416,
          passage_too_large: 413,
        };
        const status = statuses[error.code];
        if (!status) throw error;
        jsonResponse(res, status, errorEnvelope(error.code, error.message));
        return;
      }
      jsonResponse(res, 200, {
        status: 'ok',
        request_id: crypto.randomUUID(),
        data: {
          work: result.work,
          passage: result.passage,
        },
        meta: result.meta,
      });
      return;
    }

    if (url.pathname === '/v1/search') {
      if (req.method !== 'GET') {
        jsonResponse(res, 405, errorEnvelope('method_not_allowed', 'use GET'), {
          Allow: 'GET',
        });
        return;
      }

      let options;
      try {
        options = parseSearchParams(url.searchParams);
      } catch (error) {
        if (error.code === 'invalid_query' || error.code === 'invalid_mode') {
          jsonResponse(res, 400, errorEnvelope(error.code, error.message));
          return;
        }
        throw error;
      }

      let catalog;
      try {
        catalog = await getCatalog();
      } catch {
        jsonResponse(
          res,
          503,
          errorEnvelope('corpus_unavailable', 'corpus catalog could not be built'),
        );
        return;
      }

      const result = options.mode === 'fulltext'
        ? fulltextSearcher(
            catalog.records,
            getCatalogContents(catalog),
            options,
          )
        : catalogSearcher(catalog.records, options);
      jsonResponse(res, 200, {
        status: 'ok',
        request_id: crypto.randomUUID(),
        data: {
          query: options.query,
          mode: options.mode,
          hits: result.hits,
        },
        meta: {
          total: result.total,
          limit: options.limit,
          offset: options.offset,
          returned_count: result.hits.length,
        },
      });
      return;
    }

    jsonResponse(res, 404, errorEnvelope('not_found', 'not found'));
  }));

  return server;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`daocanon-api listening on ${config.host}:${config.port}`);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceExit = setTimeout(() => {
      process.exit(1);
    }, 1000);
    forceExit.unref();

    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
    server.closeAllConnections();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
