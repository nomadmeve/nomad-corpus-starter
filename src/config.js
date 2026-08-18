import { parseTextApiUrl } from './text-proxy.js';

const DEFAULTS = {
  daoCanonRoot: '/mnt/d/Lab/ScholarLib/Corpus/DaoCanon',
  textApiUrl: 'http://text-api:3000',
  host: '127.0.0.1',
  port: 3040,
  sourceId: 'daocanon',
};

function parsePort(raw) {
  if (raw === undefined || raw === null) return DEFAULTS.port;
  const s = String(raw);
  if (!/^[0-9]+$/.test(s)) {
    throw new RangeError(`PORT must be a decimal integer, got "${s}"`);
  }
  const n = Number(s);
  if (n < 1 || n > 65535) {
    throw new RangeError(`PORT out of range 1..65535: ${n}`);
  }
  return n;
}

function parseHost(raw) {
  if (raw === undefined || raw === null) return DEFAULTS.host;
  const host = String(raw);
  if (host === '127.0.0.1' || host === '0.0.0.0') return host;
  throw new RangeError(`HOST must be 127.0.0.1 or 0.0.0.0, got "${host}"`);
}

export function loadConfig(env = process.env) {
  const textApiUrl = parseTextApiUrl(env.DAO_CANON_TEXT_API_URL);
  return {
    daoCanonRoot: env.CORPUS_ROOT || env.DAO_CANON_ROOT || DEFAULTS.daoCanonRoot,
    textApiUrl,
    host: parseHost(env.HOST),
    port: parsePort(env.PORT),
    sourceId: env.SOURCE_ID || DEFAULTS.sourceId,
  };
}
