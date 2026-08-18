export const CONVERT_DIRECTIONS = Object.freeze(['s2t', 't2s']);
export const TRANSLATE_SOURCE_LANGUAGES = Object.freeze(['classical_zh', 'zh']);
export const TRANSLATE_TARGET_LANGUAGES = Object.freeze(['ko']);
export const TRANSLATE_MODELS = Object.freeze([
  'gemma4:12b',
  'gemma4:26b',
]);

const MAX_TEXT_BODY_BYTES = 64 * 1024;
const DEFAULT_TEXT_API_URL = 'http://text-api:3000';
const TEXT_API_TIMEOUT_MS = 120_000;
const SUPPORTED_PROXY_ERROR_CODES = new Set([
  'invalid_body',
  'invalid_text',
  'invalid_direction',
  'invalid_source_language',
  'invalid_target_language',
  'invalid_model',
  'invalid_json',
  'body_too_large',
  'text_service_unavailable',
  'text_service_timeout',
  'text_service_error',
]);

export function parseTextApiUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TEXT_API_URL;
  const url = String(raw);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new RangeError('DAO_CANON_TEXT_API_URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RangeError('DAO_CANON_TEXT_API_URL must use http or https');
  }
  return url;
}

export function readJsonBody(req, maxBytes = MAX_TEXT_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers?.['content-length'];
    if (typeof contentLength === 'string'
      && /^[0-9]+$/.test(contentLength)
      && Number(contentLength) > maxBytes) {
      req.resume();
      const error = new Error('request body exceeds size limit');
      error.code = 'body_too_large';
      reject(error);
      return;
    }
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        req.resume();
        const error = new Error('request body exceeds size limit');
        error.code = 'body_too_large';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch {
        const error = new Error('request body is not valid JSON');
        error.code = 'invalid_json';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function requireJsonObject(body, code = 'invalid_body') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('request body must be a JSON object');
    error.code = code;
    throw error;
  }
  return body;
}

function requireNonEmptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0) {
    const error = new Error('text must be a non-empty string');
    error.code = code;
    throw error;
  }
  return value;
}

function requireEnum(value, allowed, code, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    const error = new Error(`${label} must be one of: ${allowed.join(', ')}`);
    error.code = code;
    throw error;
  }
  return value;
}

export function validateConvertRequest(body) {
  const source = requireJsonObject(body);
  const text = requireNonEmptyString(source.text, 'invalid_text');
  const direction = requireEnum(source.direction, CONVERT_DIRECTIONS, 'invalid_direction', 'direction');
  return { text, direction };
}

export function validateTranslateRequest(body) {
  const source = requireJsonObject(body);
  const text = requireNonEmptyString(source.text, 'invalid_text');
  const sourceLanguage = requireEnum(
    source.source_language,
    TRANSLATE_SOURCE_LANGUAGES,
    'invalid_source_language',
    'source_language',
  );
  const targetLanguage = requireEnum(
    source.target_language,
    TRANSLATE_TARGET_LANGUAGES,
    'invalid_target_language',
    'target_language',
  );
  const model = requireEnum(source.model, TRANSLATE_MODELS, 'invalid_model', 'model');
  return { text, source_language: sourceLanguage, target_language: targetLanguage, model };
}

function pickUpstreamErrorCode(body) {
  const candidate = body?.error?.code;
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  if (candidate === 'text_service_error'
    || candidate === 'text_service_unavailable'
    || candidate === 'text_service_timeout') {
    return 'text_service_error';
  }
  return candidate;
}

function upstreamErrorResponse(response, body) {
  const error = new Error('text service error');
  error.status = response.status;
  error.code = pickUpstreamErrorCode(body) || 'text_service_error';
  return error;
}

function parseUpstreamPayload(response, body, expectedDataKey) {
  if (body?.status === 'ok' && body.data && typeof body.data === 'object') {
    const value = body.data[expectedDataKey];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  throw upstreamErrorResponse(response, body);
}

export function createTextProxyHandlers(
  { textApiUrl },
  { fetchImpl = globalThis.fetch, timeoutMs = TEXT_API_TIMEOUT_MS } = {},
) {
  const base = textApiUrl.replace(/\/+$/, '');

  async function proxyToText(pathname, body, expectedDataKey) {
    const url = `${base}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.name === 'AbortError') {
        const timeout = new Error('text service request timed out');
        timeout.code = 'text_service_timeout';
        throw timeout;
      }
      const wrapped = new Error('text service is unavailable');
      wrapped.code = 'text_service_unavailable';
      throw wrapped;
    }
    clearTimeout(timer);

    let responseBody = null;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }

    if (!response.ok) {
      throw upstreamErrorResponse(response, responseBody);
    }

    return parseUpstreamPayload(response, responseBody, expectedDataKey);
  }

  return {
    async handleConvert(validated) {
      const converted = await proxyToText('/v1/cjk/convert', validated, 'converted');
      return { converted };
    },

    async handleTranslate(validated) {
      const translation = await proxyToText('/v1/translate', validated, 'translation');
      return { translation };
    },

    errorCodes: SUPPORTED_PROXY_ERROR_CODES,
  };
}

export { DEFAULT_TEXT_API_URL, MAX_TEXT_BODY_BYTES, TEXT_API_TIMEOUT_MS };
