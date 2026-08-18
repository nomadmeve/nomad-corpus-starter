// Common Evidence v0.1 projection and dedupe key.
// Pure functions, no I/O.

export const EVIDENCE_SCHEMA_VERSION = 'evidence.v0.1';
export const EVIDENCE_REFERENCE_SCHEMA_VERSION = 'evidence-reference.v1';

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

const KNOWN_EVIDENCE_V01_LOCATOR_FIELDS = new Set([
  'kind',
  'relative_path',
  'relativePath',
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
  'source_id',
  'work_id',
  'unit_id',
  'entry_id',
  'section_id',
  'page',
  'revision',
  'hash',
]);

const REQUIRED_FIELDS = [
  'schema_version',
  'source_id',
  'source_kind',
  'work_id',
  'unit_id',
  'unit_type',
  'title',
  'structure_path',
  'selected_text',
  'locator',
  'print_locator',
  'reader_url',
  'revision_or_content_hash',
  'retrieved_at',
  'selection_origin',
  'verification_status',
  'return_context',
];

const UNIT_TYPES = new Set(['work', 'entry', 'section']);
const SOURCE_KINDS = new Set(['primary', 'dictionary', 'research']);
const VERIFICATION_STATUSES = new Set([
  'discovered',
  'read',
  'verified',
  'stale',
  'failed',
]);

function ensureString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function ensureNullableString(value, label) {
  if (value === null) return null;
  return ensureString(value, label);
}

function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function ensureStructurePath(value) {
  const arr = ensureArray(value, 'structure_path');
  return arr.map((node) => ensureObject(node, 'structure_path node'));
}

export function canonicalJson(value) {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('non-finite number rejected');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    const parts = value.map(canonicalJson);
    if (parts.some((p) => p === undefined)) {
      throw new TypeError('undefined value rejected');
    }
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const v = value[key];
      if (v === undefined) continue;
      const encoded = canonicalJson(v);
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new TypeError(`unsupported value: ${typeof value}`);
}

export function evidenceKey(evidence) {
  ensureObject(evidence, 'evidence');
  const payload = [
    evidence.source_id,
    evidence.work_id,
    evidence.unit_id,
    evidence.locator,
    evidence.revision_or_content_hash,
  ];
  return canonicalJson(payload);
}

export function evidenceKeyFor(parts) {
  const [source_id, work_id, unit_id, locator, hash] = parts;
  return canonicalJson([source_id, work_id, unit_id, locator, hash]);
}

function ensureValidEvidenceShape(evidence) {
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(evidence, field)) {
      throw new TypeError(`evidence missing field: ${field}`);
    }
  }
  if (evidence.schema_version !== EVIDENCE_SCHEMA_VERSION) {
    throw new TypeError('evidence schema_version mismatch');
  }
  if (!SOURCE_KINDS.has(evidence.source_kind)) {
    throw new TypeError('evidence source_kind invalid');
  }
  if (!UNIT_TYPES.has(evidence.unit_type)) {
    throw new TypeError('evidence unit_type invalid');
  }
  if (!VERIFICATION_STATUSES.has(evidence.verification_status)) {
    throw new TypeError('evidence verification_status invalid');
  }
  ensureString(evidence.source_id, 'source_id');
  ensureString(evidence.work_id, 'work_id');
  ensureString(evidence.unit_id, 'unit_id');
  ensureString(evidence.title, 'title');
  ensureString(evidence.selected_text, 'selected_text');
  ensureString(evidence.selection_origin, 'selection_origin');
  if (evidence.selection_origin !== 'user_selected') {
    throw new TypeError('selection_origin must be user_selected');
  }
  ensureStructurePath(evidence.structure_path);
  const locator = ensureObject(evidence.locator, 'locator');
  ensureString(locator.relative_path || locator.relativePath, 'locator.relative_path');
  if (locator.relativePath && !locator.relative_path) {
    locator.relative_path = locator.relativePath;
  }
  if (evidence.return_context !== null && typeof evidence.return_context !== 'object') {
    throw new TypeError('return_context must be object or null');
  }
  return evidence;
}

export function validateEvidence(evidence) {
  return ensureValidEvidenceShape({ ...evidence });
}

function nowIso() {
  return new Date().toISOString();
}

function pickCanonReaderText(reader, lines, scope = 'window') {
  if (!reader.passage || !Array.isArray(reader.passage.lines)) return '';
  const lo = reader.passage.line_start;
  const hi = reader.passage.line_end;
  const wanted = new Set();
  for (const ln of lines || []) wanted.add(ln);
  // Explicit line picks win.
  if (wanted.size > 0) {
    const out = [];
    for (const row of reader.passage.lines) {
      if (row.number >= lo && row.number <= hi && wanted.has(row.number)) {
        out.push(row.text);
      }
    }
    return out.join('\n');
  }
  // Default shelf/read path: whole currently displayed window (~100 lines),
  // not only the single target line.
  if (scope === 'target') {
    const targetLine = reader.passage.target_line;
    const row = reader.passage.lines.find((l) => l.number === targetLine);
    return row ? row.text : '';
  }
  return reader.passage.lines.map((row) => row.text).join('\n');
}

function clipByCodePoints(text, max) {
  const points = [...text];
  if (points.length <= max) return text;
  return points.slice(0, max).join('');
}

function buildReturnContextCanon({ surface, query, mode, limit, offset, hitWorkId, hitTitle }) {
  return Object.assign(
    {
      surface: surface || 'canon',
      committed_query: query || null,
      mode: mode || null,
      pagination: { limit: limit || null, offset: offset || null },
      selected_hit: hitWorkId
        ? { work_id: hitWorkId, title: hitTitle || null }
        : null,
    },
  );
}

function buildReturnContextResearch({ surface, source_id, material_type, scope, query, limit, offset, hit }) {
  return {
    surface: surface || 'research',
    committed_query: query || null,
    source_selection: source_id
      ? Array.isArray(source_id) ? source_id : [source_id]
      : null,
    material_type: material_type || null,
    scope: scope || null,
    pagination: { limit: limit || null, offset: offset || null },
    selected_hit: hit
      ? {
          unit_id: hit.unit_id,
          unit_type: hit.unit_type,
          title: hit.title,
          source_id: hit.source_id,
        }
      : null,
  };
}

export function fromCanonHit(hit, returnContext = {}) {
  if (!hit || hit.surface !== 'canon') {
    throw new TypeError('fromCanonHit: hit must be adapted canon hit');
  }
  const evidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    source_id: hit.source_id,
    source_kind: 'primary',
    work_id: hit.work_id,
    unit_id: hit.work_id,
    unit_type: 'work',
    title: hit.title,
    author_or_editor: hit.author,
    structure_path: [],
    selected_text: hit.match_text || hit.snippet || hit.title || '(제목만 선택됨)',
    locator: {
      kind: hit.locator.kind,
      relative_path: hit.locator.relative_path,
      line_start: hit.locator.line_start,
      line_end: hit.locator.line_end,
    },
    print_locator: null,
    reader_url: hit.reader_url,
    revision_or_content_hash: null,
    retrieved_at: nowIso(),
    selection_origin: 'user_selected',
    verification_status: 'discovered',
    return_context: buildReturnContextCanon({
      ...returnContext,
      hitWorkId: hit.work_id,
      hitTitle: hit.title,
    }),
  };
  return ensureValidEvidenceShape(evidence);
}

export function fromCanonReader(reader, selection, returnContext = {}) {
  if (!reader || reader.passage === undefined) {
    throw new TypeError('fromCanonReader: reader required');
  }
  const lines = Array.isArray(selection?.lines) ? selection.lines : [];
  const scope = selection?.scope === 'target' ? 'target' : 'window';
  const rawText = typeof selection?.selected_text === 'string' && selection.selected_text.length > 0
    ? selection.selected_text
    : pickCanonReaderText(reader, lines, scope);
  const clipped = clipSelectedText(rawText, 4000);
  const wasClipped = [...rawText].length > [...clipped].length;

  const lineStart = Number.isInteger(selection?.line_start)
    ? selection.line_start
    : reader.passage.line_start;
  const lineEnd = Number.isInteger(selection?.line_end)
    ? selection.line_end
    : reader.passage.line_end;
  const targetLine = Number.isInteger(selection?.target_line)
    ? selection.target_line
    : reader.passage.target_line;
  const titleSuffix = selection?.title_suffix
    ? ` ${selection.title_suffix}`
    : (selection?.scope_label ? ` (${selection.scope_label})` : '');

  const evidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    source_id: reader.work.source_id,
    source_kind: 'primary',
    work_id: reader.work.work_id,
    unit_id: reader.work.work_id,
    unit_type: 'work',
    title: `${reader.work.title || ''}${titleSuffix}`.trim() || reader.work.title,
    author_or_editor: reader.work.author,
    structure_path: [],
    selected_text: clipped,
    locator: {
      kind: 'physical-lines',
      relative_path: reader.work.relative_path,
      line_start: lineStart,
      line_end: lineEnd,
      target_line: targetLine,
    },
    print_locator: null,
    reader_url: `/api/daocanon/v1/works/${encodeURIComponent(reader.work.work_id)}?line=${targetLine || lineStart || 1}`,
    revision_or_content_hash: null,
    retrieved_at: nowIso(),
    selection_origin: 'user_selected',
    verification_status: 'read',
    return_context: buildReturnContextCanon({
      ...returnContext,
      hitWorkId: reader.work.work_id,
      hitTitle: reader.work.title,
    }),
  };
  const valid = ensureValidEvidenceShape(evidence);
  valid._clipped = wasClipped;
  return valid;
}

// A whole-work item is a compact manifest, not a clipped text copy. The
// Dialogue service re-fetches bounded cited passages through the 3040 API.
export function fromCanonWholeWork(reader, returnContext = {}) {
  if (!reader?.work || !reader?.passage) {
    throw new TypeError('fromCanonWholeWork: reader required');
  }
  const totalLines = reader.passage.total_lines;
  if (!Number.isInteger(totalLines) || totalLines < 1) {
    throw new TypeError('fromCanonWholeWork: passage.total_lines required');
  }
  return ensureValidEvidenceShape({
    schema_version: EVIDENCE_SCHEMA_VERSION,
    source_id: reader.work.source_id,
    source_kind: 'primary',
    work_id: reader.work.work_id,
    unit_id: reader.work.work_id,
    unit_type: 'work',
    title: `${reader.work.title} (전체 원문 참조)`,
    author_or_editor: reader.work.author,
    structure_path: [],
    selected_text: `전체 원문 참조: L1–L${totalLines}. 질문 시 검증된 원문 구간을 다시 불러옵니다.`,
    locator: {
      kind: 'whole-work-reference',
      relative_path: reader.work.relative_path,
      line_start: 1,
      line_end: totalLines,
      target_line: 1,
      total_lines: totalLines,
      whole_work: true,
    },
    print_locator: null,
    reader_url: `/api/daocanon/v1/works/${encodeURIComponent(reader.work.work_id)}?line=1`,
    revision_or_content_hash: null,
    retrieved_at: nowIso(),
    selection_origin: 'user_selected',
    verification_status: 'read',
    return_context: buildReturnContextCanon({
      ...returnContext,
      hitWorkId: reader.work.work_id,
      hitTitle: reader.work.title,
    }),
  });
}

export function fromResearchHit(hit, returnContext = {}) {
  if (!hit || hit.surface !== 'research') {
    throw new TypeError('fromResearchHit: hit must be adapted research hit');
  }
  const evidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    source_id: hit.source_id,
    source_kind: hit.source_kind,
    work_id: hit.work_id,
    unit_id: hit.unit_id,
    unit_type: hit.unit_type,
    title: hit.title,
    author_or_editor: null,
    structure_path: hit.structure_path || [],
    selected_text: hit.snippet || hit.title || hit.headword || '(제목만 선택됨)',
    locator: {
      kind: 'research-source-locator',
      relative_path: hit.source_locator.relative_path,
      unit_line_start: hit.source_locator.unit_line_start,
      unit_line_end: hit.source_locator.unit_line_end,
      match_line_start: hit.source_locator.match_line_start,
      match_line_end: hit.source_locator.match_line_end,
    },
    print_locator: hit.print_locator || null,
    reader_url: hit.reader_url,
    revision_or_content_hash: hit.content_hash || null,
    retrieved_at: nowIso(),
    selection_origin: 'user_selected',
    verification_status: 'discovered',
    return_context: buildReturnContextResearch({
      ...returnContext,
      hit,
    }),
  };
  return ensureValidEvidenceShape(evidence);
}

export function fromResearchReader(reader, originatingHit, selection, returnContext = {}) {
  if (!reader || !reader.passage) {
    throw new TypeError('fromResearchReader: reader required');
  }
  const wanted = Array.isArray(selection?.lines) ? new Set(selection.lines) : null;
  const hasExplicitSelection = Boolean(wanted);
  const text = (() => {
    if (!wanted) return reader.passage;
    const lines = reader.passage.split('\n');
    const out = [];
    let cursor = 1;
    for (const line of lines) {
      if (wanted.has(cursor)) out.push(line);
      cursor += 1;
    }
    return out.join('\n');
  })();

  // The reader URL needs expected_hash for re-verification.
  const hash = reader.content_hash || originatingHit?.content_hash || null;
  const baseUrl = originatingHit?.reader_url || deriveReaderUrlFromReader(reader);
  const verified = Boolean(hash && selection?.expected_hash && selection.expected_hash === hash);

  // Research reader API often omits source_id/work_id; fill from hit/UI context.
  const sourceId = reader.source_id
    || originatingHit?.source_id
    || returnContext.source_id
    || returnContext.sourceId
    || null;
  const workId = reader.work_id
    || originatingHit?.work_id
    || returnContext.work_id
    || returnContext.workId
    || null;
  const sourceKind = reader.source_kind
    || originatingHit?.source_kind
    || returnContext.source_kind
    || (reader.unit_type === 'entry' ? 'dictionary' : 'research');

  // No explicit user selection → store a path reference (DaCanon whole-work style),
  // not clipped body text. The dialogue service re-fetches the bounded passage
  // through the reader_url at question time. When the user explicitly selects
  // lines, the selected body text is still capped at 4000 code points.
  const relativePath = reader.source_locator?.relative_path
    || reader.source_locator?.relativePath
    || originatingHit?.source_locator?.relative_path
    || null;

  const lineStart = reader.source_locator?.passage_line_start
    ?? reader.source_locator?.passageLineStart
    ?? reader.source_locator?.body_line_start
    ?? reader.source_locator?.bodyLineStart
    ?? null;
  const lineEnd = reader.source_locator?.passage_line_end
    ?? reader.source_locator?.passageLineEnd
    ?? reader.source_locator?.body_line_end
    ?? reader.source_locator?.bodyLineEnd
    ?? null;

  let selectedText;
  let wasClipped = false;
  let locator;
  if (hasExplicitSelection) {
    const rawText = typeof text === 'string' ? text : '';
    selectedText = clipSelectedText(rawText, 4000);
    wasClipped = [...rawText].length > [...selectedText].length;
    locator = {
      kind: 'physical-lines',
      relative_path: relativePath,
      body_line_start: reader.source_locator?.body_line_start ?? reader.source_locator?.bodyLineStart ?? null,
      body_line_end: reader.source_locator?.body_line_end ?? reader.source_locator?.bodyLineEnd ?? null,
      passage_line_start: reader.source_locator?.passage_line_start ?? reader.source_locator?.passageLineStart ?? null,
      passage_line_end: reader.source_locator?.passage_line_end ?? reader.source_locator?.passageLineEnd ?? null,
    };
  } else {
    const range = Number.isInteger(lineStart) && Number.isInteger(lineEnd)
      ? `L${lineStart}–L${lineEnd}`
      : (Number.isInteger(lineStart) ? `L${lineStart}` : '전체');
    selectedText = `전체 원문 참조: ${range}. 질문 시 검증된 원문 구간을 다시 불러옵니다.`;
    locator = {
      kind: 'whole-work-reference',
      relative_path: relativePath,
      line_start: lineStart,
      line_end: lineEnd,
      target_line: lineStart,
    };
  }

  const evidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    source_id: sourceId,
    source_kind: sourceKind,
    work_id: workId,
    unit_id: reader.unit_type === 'entry' ? reader.entry_id : reader.section_id,
    unit_type: reader.unit_type,
    title: reader.unit_type === 'entry' ? reader.headword : reader.title,
    author_or_editor: null,
    structure_path: reader.structure_path || originatingHit?.structure_path || [],
    selected_text: selectedText,
    locator,
    print_locator: reader.print_locator || null,
    reader_url: appendExpectedHash(baseUrl, hash),
    revision_or_content_hash: hash,
    retrieved_at: nowIso(),
    selection_origin: 'user_selected',
    verification_status: verified
      ? 'verified'
      : selection?.stale
        ? 'stale'
        : selection?.expected_hash
          ? 'failed'
          : 'read',
    return_context: buildReturnContextResearch({
      ...returnContext,
      hit: originatingHit,
      sourceId,
      workId,
      clipped: wasClipped,
    }),
  };
  const valid = ensureValidEvidenceShape(evidence);
  valid._clipped = wasClipped;
  return valid;
}

function deriveReaderUrlFromReader(reader) {
  if (reader.unit_type === 'entry') {
    return `/api/daoism-research/v1/entries/${encodeURIComponent(reader.entry_id)}`;
  }
  if (reader.unit_type === 'section') {
    return `/api/daoism-research/v1/sections/${encodeURIComponent(reader.section_id)}`;
  }
  return null;
}

function appendExpectedHash(url, hash) {
  if (!url || !hash) return url;
  return `${url}${url.includes('?') ? '&' : '?'}expected_hash=${encodeURIComponent(hash)}`;
}

export function clipSelectedText(text, maxCodePoints) {
  return clipByCodePoints(text, maxCodePoints);
}

export function utf8ByteLength(value) {
  return new TextEncoder().encode(value).length;
}

export function enforceSelectedTextCap(text, maxCodePoints) {
  const cp = [...text].length;
  if (cp > maxCodePoints) {
    const err = new Error(`selected_text exceeds ${maxCodePoints} code points (got ${cp})`);
    err.code = 'selected_text_too_large';
    return { ok: false, error: err, codePoints: cp };
  }
  return { ok: true, codePoints: cp };
}

export function enforceItemCap(count, maxItems) {
  if (count >= maxItems) {
    const err = new Error(`shelf already holds ${count} items (max ${maxItems})`);
    err.code = 'shelf_full';
    return { ok: false, error: err };
  }
  return { ok: true };
}

export function enforceShelfByteCap(serialized, maxBytes) {
  const bytes = utf8ByteLength(serialized);
  if (bytes > maxBytes) {
    const err = new Error(`shelf would exceed ${maxBytes} bytes (got ${bytes})`);
    err.code = 'shelf_overflow';
    return { ok: false, error: err, bytes };
  }
  return { ok: true, bytes };
}

function ensureProjectedId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
  return value;
}

function deterministicReferenceHandle(parts) {
  const input = canonicalJson(parts);
  let left = 2166136261;
  let right = 2246822519;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619) >>> 0;
    right = Math.imul(right ^ code, 3266489917) >>> 0;
  }
  return `evr_${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

const ALLOWED_REFERENCE_ROOT_FIELDS = new Set([
  'schema_version',
  'evidence_ref',
  'source_kind',
  'unit_type',
  'source_id',
  'work_id',
  'unit_id',
  'title',
  'locator',
  'revision_or_content_hash',
  'verification_status',
  'allowed_operations',
]);

const REQUIRED_REFERENCE_OPERATIONS = Object.freeze([
  'source_search',
  'source_open',
  'inspect_source_structure',
]);

export function toEvidenceReference(evidence) {
  if (!evidence || typeof evidence !== 'object') throw new TypeError('evidence must be an object');

  if (evidence.schema_version && evidence.schema_version !== EVIDENCE_SCHEMA_VERSION && evidence.schema_version !== EVIDENCE_REFERENCE_SCHEMA_VERSION) {
    throw new TypeError(`unsupported schema_version: ${evidence.schema_version}`);
  }

  const isAlreadyReference = evidence.schema_version === EVIDENCE_REFERENCE_SCHEMA_VERSION;
  if (isAlreadyReference) {
    for (const key of Object.keys(evidence)) {
      if (!ALLOWED_REFERENCE_ROOT_FIELDS.has(key)) {
        throw new TypeError(`unknown or unsafe reference field rejected: ${key}`);
      }
    }
  }

  const locator = ensureObject(evidence.locator, 'locator');
  for (const key of Object.keys(locator)) {
    if (isAlreadyReference) {
      if (!ALLOWED_PROJECTED_LOCATOR_FIELDS.has(key)) {
        throw new TypeError(`unknown or unsafe locator field rejected: ${key}`);
      }
    } else {
      if (!KNOWN_EVIDENCE_V01_LOCATOR_FIELDS.has(key)) {
        throw new TypeError(`unknown or unsafe locator field rejected: ${key}`);
      }
    }
  }

  const projectedLocator = {};
  if (typeof locator.kind !== 'string' || locator.kind.length === 0 || /[\\/]/.test(locator.kind) || /^[a-z][a-z0-9+.-]*:\/\//i.test(locator.kind)) {
    throw new TypeError('locator.kind must be a safe non-path string');
  }
  projectedLocator.kind = locator.kind;
  for (const key of ALLOWED_PROJECTED_LOCATOR_FIELDS) {
    if (key === 'kind') continue;
    const val = locator[key];
    if (val !== undefined && val !== null) {
      if (typeof val === 'number') {
        if (!Number.isInteger(val) || val < 1 || val > 1_000_000_000) throw new TypeError(`locator.${key} must be a positive bounded integer`);
        projectedLocator[key] = val;
      } else if (key === 'whole_work' && typeof val === 'boolean') {
        projectedLocator[key] = val;
      } else {
        throw new TypeError(`locator.${key} must be a number or boolean`);
      }
    }
  }

  ensureProjectedId(evidence.source_id, 'source_id');
  ensureProjectedId(evidence.work_id, 'work_id');
  ensureProjectedId(evidence.unit_id, 'unit_id');
  ensureString(evidence.title, 'title');
  if (!SOURCE_KINDS.has(evidence.source_kind)) throw new TypeError('evidence source_kind invalid');
  if (!UNIT_TYPES.has(evidence.unit_type)) throw new TypeError('evidence unit_type invalid');
  if (!VERIFICATION_STATUSES.has(evidence.verification_status)) throw new TypeError('evidence verification_status invalid');

  const deterministicRef = deterministicReferenceHandle([
    evidence.source_id, evidence.work_id, evidence.unit_id, projectedLocator, evidence.revision_or_content_hash,
  ]);
  if (isAlreadyReference && evidence.evidence_ref !== deterministicRef) {
    throw new TypeError('evidence_ref must match the deterministic reference handle');
  }
  if (isAlreadyReference && (!Array.isArray(evidence.allowed_operations)
    || evidence.allowed_operations.length !== REQUIRED_REFERENCE_OPERATIONS.length
    || evidence.allowed_operations.some((operation, index) => operation !== REQUIRED_REFERENCE_OPERATIONS[index]))) {
    throw new TypeError('allowed_operations must match the reference capability allowlist');
  }

  return {
    schema_version: EVIDENCE_REFERENCE_SCHEMA_VERSION,
    evidence_ref: deterministicRef,
    source_kind: evidence.source_kind,
    unit_type: evidence.unit_type,
    source_id: evidence.source_id,
    work_id: evidence.work_id,
    unit_id: evidence.unit_id,
    title: evidence.title,
    locator: projectedLocator,
    revision_or_content_hash: ensureNullableString(evidence.revision_or_content_hash, 'revision_or_content_hash'),
    verification_status: evidence.verification_status,
    allowed_operations: REQUIRED_REFERENCE_OPERATIONS.slice(),
  };
}

export const projectEvidenceReference = toEvidenceReference;

