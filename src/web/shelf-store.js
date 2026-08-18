// Bounded sessionStorage shelf. In-memory snapshot acts as source of truth;
// sessionStorage is the persistence layer. Errors are isolated and reported
// via notifications; the in-memory state never falls below the previous
// good snapshot.

import {
  evidenceKey,
  validateEvidence,
  toEvidenceReference,
  canonicalJson,
  enforceSelectedTextCap,
  enforceItemCap,
  enforceShelfByteCap,
  utf8ByteLength,
} from './evidence.js';

export const SHELF_STORAGE_KEY = 'daocanon.research.evidence.v0.2';
export const LEGACY_SHELF_STORAGE_KEY = 'daocanon.research.evidence.v0.1';
export const SHELF_SCHEMA_VERSION = 'shelf.v0.2';

const DEFAULT_LIMITS = Object.freeze({
  maxItems: 20,
  maxSelectedCodePoints: 4000,
  maxBytes: 128 * 1024,
});

export class ShelfStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function buildEnvelope(items) {
  return {
    schema_version: SHELF_SCHEMA_VERSION,
    items: items.map((item) => ({ ...item })),
    updated_at: nowIso(),
  };
}

const ALLOWED_PROJECTED_LOCATOR_FIELDS = new Set([
  'kind',
  'line',
  'target_line',
  'line_start',
  'line_end',
  'total_lines',
  'whole_work',
  'unit_line_start',
  'unit_line_end',
  'match_line_start',
  'match_line_end',
  'body_line_start',
  'body_line_end',
  'passage_line_start',
  'passage_line_end',
]);

function normalizeKey(key) {
  if (typeof key !== 'string') return key;
  if (!key.startsWith('[') || !key.endsWith(']')) return key;
  try {
    const fixed = key.replace(/,\s*\]$/, ',null]');
    const parsed = JSON.parse(fixed);
    if (Array.isArray(parsed) && parsed.length >= 4) {
      const [source_id, work_id, unit_id, locator, hash] = parsed;
      if (locator && typeof locator === 'object') {
        const projectedLocator = {};
        if (locator.kind) projectedLocator.kind = locator.kind;
        for (const k of ALLOWED_PROJECTED_LOCATOR_FIELDS) {
          if (k === 'kind') continue;
          if (locator[k] !== undefined && locator[k] !== null) {
            projectedLocator[k] = locator[k];
          }
        }
        return canonicalJson([source_id, work_id, unit_id, projectedLocator, hash ?? null]);
      }
    }
  } catch {
    // ignore
  }
  return key;
}

export class ShelfStore {
  constructor({ storage, limits = DEFAULT_LIMITS, clock = () => Date.now() } = {}) {
    this.storage = storage;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this._clock = clock;
    this._items = [];
    this._notices = [];
    this._load();
  }

  get items() {
    return this._items.map((item) => ({ ...item }));
  }

  get size() {
    return this._items.length;
  }

  get notices() {
    return this._notices.slice();
  }

  takeNotices() {
    const out = this._notices.slice();
    this._notices.length = 0;
    return out;
  }

  _read() {
    if (!this.storage) return { items: null, notice: null };

    // Legacy v0.1 removal on first v0.2 store load: remove without quarantine or copying
    try {
      const legacy = this.storage.getItem(LEGACY_SHELF_STORAGE_KEY);
      if (legacy !== null && legacy !== undefined) {
        this.storage.removeItem(LEGACY_SHELF_STORAGE_KEY);
        this._notices.push({
          code: 'legacy_shelf_removed',
          message: '이전 버전 근거 선반 데이터를 안전하게 정리했습니다.',
        });
      }
    } catch {
      // ignore storage access error on legacy check
    }

    let raw;
    try {
      raw = this.storage.getItem(SHELF_STORAGE_KEY);
    } catch (err) {
      return {
        items: null,
        notice: { code: 'storage_unavailable', message: err && err.message ? err.message : String(err) },
      };
    }
    if (raw === null || raw === undefined) return { items: null, notice: null };
    try {
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.schema_version !== SHELF_SCHEMA_VERSION ||
        !Array.isArray(parsed.items)
      ) {
        throw new ShelfStorageError('schema_mismatch', 'stored shelf has unknown schema');
      }
      return { items: parsed.items, notice: null };
    } catch (err) {
      // Quarantine the bad v0.2 payload.
      try {
        if (typeof this.storage.setItem === 'function') {
          this.storage.setItem(`${SHELF_STORAGE_KEY}.quarantine.${this._clock()}`, raw);
        }
      } catch {
        // ignore
      }
      try {
        this.storage.removeItem(SHELF_STORAGE_KEY);
      } catch {
        // ignore
      }
      return {
        items: null,
        notice: {
          code: 'storage_corrupt',
          message: err && err.message ? err.message : String(err),
        },
      };
    }
  }

  _load() {
    const { items: stored, notice } = this._read();
    if (notice) this._notices.push(notice);
    if (stored === null) return;
    const valid = [];
    let dropped = 0;
    for (const item of stored) {
      try {
        valid.push(toEvidenceReference(item));
      } catch {
        dropped += 1;
      }
    }
    this._items = valid;
    if (dropped > 0) {
      this._notices.push({
        code: 'storage_partial',
        message: '일부 shelf item이 schema 검증에 실패해 제외되었습니다.',
      });
    }
  }

  _persist() {
    if (!this.storage) return { ok: true, bytes: 0 };
    const envelope = buildEnvelope(this._items);
    let serialized;
    try {
      serialized = JSON.stringify(envelope);
    } catch (err) {
      return { ok: false, error: { code: 'serialize_failed', message: err.message } };
    }
    const cap = enforceShelfByteCap(serialized, this.limits.maxBytes);
    if (!cap.ok) return { ok: false, error: cap.error };
    try {
      this.storage.setItem(SHELF_STORAGE_KEY, serialized);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: err && err.name === 'QuotaExceededError' ? 'quota_exceeded' : 'storage_write_failed',
          message: err && err.message ? err.message : String(err),
        },
      };
    }
    return { ok: true, bytes: cap.bytes };
  }

  has(key) {
    const norm = normalizeKey(key);
    return this._items.some((item) => evidenceKey(item) === key || evidenceKey(item) === norm || item.evidence_ref === key);
  }

  get(key) {
    const norm = normalizeKey(key);
    const found = this._items.find((item) => evidenceKey(item) === key || evidenceKey(item) === norm || item.evidence_ref === key);
    return found ? { ...found } : null;
  }

  add(evidence) {
    if (evidence && typeof evidence.selected_text === 'string') {
      const textCap = enforceSelectedTextCap(evidence.selected_text, this.limits.maxSelectedCodePoints);
      if (!textCap.ok) {
        return { ok: false, error: { ...textCap.error, codePoints: textCap.codePoints } };
      }
    }

    let ref;
    try {
      ref = toEvidenceReference(evidence);
    } catch (err) {
      return { ok: false, error: { code: 'invalid_evidence', message: err.message } };
    }

    const key = evidenceKey(ref);
    const existingIndex = this._items.findIndex(
      (item) => evidenceKey(item) === key || item.evidence_ref === ref.evidence_ref,
    );
    if (existingIndex >= 0) {
      const snapshot = this._items.slice();
      this._items[existingIndex] = ref;
      const persisted = this._persist();
      if (!persisted.ok) {
        this._items = snapshot;
        return { ok: false, error: persisted.error };
      }
      return { ok: true, updated: true, key };
    }

    const itemCap = enforceItemCap(this._items.length, this.limits.maxItems);
    if (!itemCap.ok) {
      return { ok: false, error: { ...itemCap.error, itemCount: this._items.length } };
    }

    const snapshot = this._items.slice();
    this._items.push(ref);
    const persisted = this._persist();
    if (!persisted.ok) {
      this._items = snapshot;
      return { ok: false, error: persisted.error };
    }
    return { ok: true, added: true, key };
  }

  remove(key) {
    const norm = normalizeKey(key);
    const idx = this._items.findIndex((item) => evidenceKey(item) === key || evidenceKey(item) === norm || item.evidence_ref === key);
    if (idx < 0) return { ok: false, error: { code: 'not_found', message: 'item not found' } };
    const snapshot = this._items.slice();
    this._items.splice(idx, 1);
    const persisted = this._persist();
    if (!persisted.ok) {
      this._items = snapshot;
      return { ok: false, error: persisted.error };
    }
    return { ok: true, removed: true };
  }

  clear() {
    const snapshot = this._items.slice();
    this._items = [];
    const persisted = this._persist();
    if (!persisted.ok) {
      this._items = snapshot;
      return { ok: false, error: persisted.error };
    }
    return { ok: true };
  }

  exportHandoff() {
    return {
      schema_version: SHELF_SCHEMA_VERSION,
      items: this._items.map((item) => ({ ...item })),
      generated_at: nowIso(),
    };
  }
}

export function createShelfStore(options = {}) {
  return new ShelfStore(options);
}

export const _internals = {
  buildEnvelope,
  DEFAULT_LIMITS,
  validateEvidence,
  toEvidenceReference,
  evidenceKey,
  LEGACY_SHELF_STORAGE_KEY,
};
