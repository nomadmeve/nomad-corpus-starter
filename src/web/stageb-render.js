// Stage B (확장 대화) render helpers — pure functions, no DOM/IO.
//
// The extended panel renders a typed ledger (status/tool/source/elapsed) and
// only verified-citation answers. Ledger and citation fields are sanitized so
// the UI never shows chain-of-thought, raw credentials, or absolute host
// paths. The default active tab remains 연구 대화 (Stage 3A); the extended tab
// is health-gated.

const ABSOLUTE_HOST = /https?:\/\/[^/?#]{1,512}/i;
const CREDENTIAL_PROBE = /(password|secret|api[_-]?key|token|authorization|bearer|credential)/i;
const CHAIN_OF_THOUGHT_PROBE = /(chain[_-]?of[_-]?thought|reasoning|thinking|self[_-]?talk)/i;

export function isSensitiveString(value) {
  if (typeof value !== 'string') return false;
  return ABSOLUTE_HOST.test(value)
    || CREDENTIAL_PROBE.test(value)
    || CHAIN_OF_THOUGHT_PROBE.test(value);
}

function sanitizeValue(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return isSensitiveString(value) ? fallback : value;
}

// Fields that are safe to render in the ledger. Everything else (internal
// reasoning, credentials, host URLs, etc.) is dropped.
const SAFE_LEDGER_FIELDS = ['type', 'status', 'tool', 'source', 'elapsed_ms'];

export function sanitizeLedger(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const safe = {};
    for (const field of SAFE_LEDGER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(entry, field)) {
        safe[field] = entry[field];
      }
    }
    if (entry.error && typeof entry.error === 'object') {
      const error = {};
      if (typeof entry.error.code === 'string' && !isSensitiveString(entry.error.code)) {
        error.code = entry.error.code;
      }
      const message = sanitizeValue(entry.error.message);
      if (message) error.message = message;
      safe.error = error;
    }
    // Drop any safe-listed field whose value is itself sensitive.
    for (const key of Object.keys(safe)) {
      if (isSensitiveString(safe[key])) delete safe[key];
    }
    if (Object.keys(safe).length > 0) out.push(safe);
  }
  return out;
}

export function isVerifiedCitation(citation) {
  if (!citation || typeof citation !== 'object') return false;
  if (citation.verified !== true) return false;
  if (citation.locator === null || citation.locator === undefined) return false;
  if (typeof citation.text !== 'string' || citation.text.length === 0) {
    if (typeof citation.snippet !== 'string' || citation.snippet.length === 0) {
      return false;
    }
  }
  return true;
}

export function verifiedCitationsOnly(citations) {
  if (!Array.isArray(citations)) return [];
  return citations.filter(isVerifiedCitation);
}

export function formatElapsedMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

export function statusLabel(status) {
  const labels = {
    completed: '완료',
    running: '진행 중',
    failed: '실패',
    partial: '부분 실패',
    cancelled: '취소',
    idle: '대기',
  };
  const label = labels[status];
  return typeof label === 'string' ? label : String(status ?? '');
}

export function toolLabel(tool) {
  const labels = {
    search: '검색',
    reader: '본문',
    verify: '검증',
    cite: '인용',
    retrieve: '검색',
    draft: '작성',
  };
  const label = labels[tool];
  return typeof label === 'string' ? label : (typeof tool === 'string' && !isSensitiveString(tool) ? tool : '');
}

export function sourceLabel(source) {
  const labels = {
    canon: '원문',
    research: '연구',
    dictionary: '사전',
    shelf: '선반',
  };
  const label = labels[source];
  return typeof label === 'string' ? label : (typeof source === 'string' && !isSensitiveString(source) ? source : '');
}

export function partialFailureSummary(ledger) {
  if (!Array.isArray(ledger)) return '';
  const count = ledger.filter((entry) => (
    entry && (entry.status === 'failed' || entry.status === 'partial')
  )).length;
  if (count === 0) return '';
  return `부분 실패 ${count}건`;
}

export function newConversationState() {
  return {
    conversationId: null,
    history: [],
    ledger: [],
    answer: null,
    citations: [],
    attached: [],
    retrievedSources: [],
    status: 'idle',
    running: false,
    turnId: null,
    error: null,
  };
}

export function planTabActivation({ healthOk, selectedTab }) {
  const bAvailable = Boolean(healthOk);
  const activeTab = bAvailable ? (selectedTab || '3a') : '3a';
  return {
    activeTab,
    bDisabled: !bAvailable,
    bAvailable,
  };
}