import { createShelfStore } from './shelf-store.js';
import { fromCanonReader, fromCanonWholeWork, fromCanonHit } from './evidence.js';
import { mountStage3 } from './stage3.js';
import { mountStageB, createAgentClient } from './stageb.js';

export function buildSearchUrl({ query, mode, limit = 20, offset = 0 }) {
  const params = new URLSearchParams({
    q: query,
    mode,
    limit: String(limit),
    offset: String(offset),
  });
  return `/v1/search?${params.toString()}`;
}

const WORK_ID_PATTERN = /^dc1_[0-9a-f]{64}$/;

export function buildReaderHash(workId, lineStart = 1, lineEnd = lineStart) {
  if (!WORK_ID_PATTERN.test(workId)
    || !Number.isSafeInteger(lineStart) || lineStart < 1
    || !Number.isSafeInteger(lineEnd) || lineEnd < lineStart || lineEnd > lineStart + 1) {
    throw new Error('invalid reader target');
  }
  return `#/works/${workId}/lines/${lineStart}-${lineEnd}`;
}

export function parseReaderHash(hash) {
  const match = /^#\/works\/(dc1_[0-9a-f]{64})\/lines\/([1-9][0-9]*)-([1-9][0-9]*)$/.exec(hash);
  if (!match) return null;
  const lineStart = Number(match[2]);
  const lineEnd = Number(match[3]);
  if (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)
    || lineEnd < lineStart || lineEnd > lineStart + 1) return null;
  return { workId: match[1], lineStart, lineEnd };
}

export function buildWorkUrl(workId, line = 1) {
  if (!WORK_ID_PATTERN.test(workId) || !Number.isSafeInteger(line) || line < 1) {
    throw new Error('invalid work target');
  }
  return `/v1/works/${workId}?line=${line}`;
}

/** Reader passage windows are ~100 lines; page numbers map to non-overlapping starts. */
export const READER_PAGE_SIZE = 100;

export function passagePageCount(totalLines, pageSize = READER_PAGE_SIZE) {
  const total = Number(totalLines);
  if (!Number.isFinite(total) || total < 1) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function passagePageOfLine(line, pageSize = READER_PAGE_SIZE) {
  const n = Number(line);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor((n - 1) / pageSize) + 1;
}

export function passagePageStartLine(page, pageSize = READER_PAGE_SIZE) {
  const p = Number(page);
  if (!Number.isFinite(p) || p < 1) return 1;
  return (Math.floor(p) - 1) * pageSize + 1;
}

/** Compact page tokens: 1 … 4 5 [6] 7 8 … 20 */
export function compactPageTokens(current, total, side = 2) {
  const cur = Math.min(Math.max(1, Number(current) || 1), Math.max(1, Number(total) || 1));
  const tot = Math.max(1, Number(total) || 1);
  if (tot <= 1) return [1];
  const pages = new Set([1, tot, cur]);
  for (let i = cur - side; i <= cur + side; i += 1) {
    if (i >= 1 && i <= tot) pages.add(i);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const page of sorted) {
    if (prev && page - prev > 1) out.push('…');
    out.push(page);
    prev = page;
  }
  return out;
}

export function groupDivisions(records) {
  const counts = new Map();
  for (const record of records) {
    const division = record.division ?? null;
    counts.set(division, (counts.get(division) ?? 0) + 1);
  }
  return [
    { value: '*', label: '전체', count: records.length },
    ...[...counts].map(([value, count]) => ({
      value,
      label: value ?? '미분류',
      count,
    })),
  ];
}

export function paginationState(total, offset, limit = 20) {
  const boundedTotal = Math.max(0, total);
  const boundedOffset = Math.max(0, offset);
  const boundedLimit = Math.max(1, limit);
  const inRange = boundedTotal > 0 && boundedOffset < boundedTotal;
  const hasNext = boundedOffset + boundedLimit < boundedTotal;
  return {
    total: boundedTotal,
    offset: boundedOffset,
    limit: boundedLimit,
    start: inRange ? boundedOffset + 1 : 0,
    end: inRange ? Math.min(boundedTotal, boundedOffset + boundedLimit) : 0,
    hasPrevious: boundedOffset > 0,
    hasNext,
    previousOffset: Math.max(0, boundedOffset - boundedLimit),
    nextOffset: hasNext ? boundedOffset + boundedLimit : boundedOffset,
  };
}

export function lineLabel(locator) {
  const start = locator?.line_start;
  const end = locator?.line_end;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return start === end ? `L${start}` : `L${start}–L${end}`;
}

export function passageContainsRoute(passage, route) {
  return Number.isInteger(route?.lineStart)
    && Number.isInteger(route?.lineEnd)
    && passage?.target_line === route.lineStart
    && passage.line_start <= route.lineStart
    && passage.line_end >= route.lineEnd
    && passage.total_lines >= route.lineEnd;
}

export function isModeBusy(mode, loading) {
  return mode === 'browse' ? loading.catalog : loading.search;
}

export const CONVERT_TARGETS = Object.freeze(['original', 's2t', 't2s']);
export const TRANSLATE_MODELS = Object.freeze([
  'gemma4:12b',
  'gemma4:26b',
]);
export const TRANSLATE_SOURCE_LANGUAGES = Object.freeze(['classical_zh', 'zh']);
export const TRANSLATE_TARGET_LANGUAGES = Object.freeze(['ko']);
export const MAX_TRANSLATE_INPUT_CODE_POINTS = 4000;

const READER_LINE_TRUNCATE = 120;

export function buildConvertUrl() {
  return '/v1/text/convert';
}

export function buildTranslateUrl() {
  return '/v1/text/translate';
}

export function buildConvertBody({ text, direction }) {
  return { text, direction };
}

export function buildTranslateBody({ text, sourceLanguage, targetLanguage, model }) {
  return {
    text,
    source_language: sourceLanguage,
    target_language: targetLanguage,
    model,
  };
}

export function isConvertDirection(value) {
  return typeof value === 'string' && CONVERT_TARGETS.includes(value);
}

export function isTranslateModel(value) {
  return typeof value === 'string' && TRANSLATE_MODELS.includes(value);
}

export function isTranslateSourceLanguage(value) {
  return typeof value === 'string' && TRANSLATE_SOURCE_LANGUAGES.includes(value);
}

export function isTranslateTargetLanguage(value) {
  return typeof value === 'string' && TRANSLATE_TARGET_LANGUAGES.includes(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function codePointLength(value) {
  if (typeof value !== 'string') return 0;
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

export function exceedsTranslateInputLimit(text) {
  if (typeof text !== 'string') return true;
  return codePointLength(text) > MAX_TRANSLATE_INPUT_CODE_POINTS;
}

export function validateConvertEnvelope(body) {
  if (!body || body.status !== 'ok' || typeof body.data !== 'object'
    || body.data === null || typeof body.data.converted !== 'string'
    || body.data.converted.length === 0) {
    throw new Error('invalid convert response');
  }
  return body;
}

export function validateTranslateEnvelope(body) {
  if (!body || body.status !== 'ok' || typeof body.data !== 'object'
    || body.data === null || typeof body.data.translation !== 'string'
    || body.data.translation.length === 0) {
    throw new Error('invalid translate response');
  }
  return body;
}

export function readerLineDisplayText(line, convertMap, mode) {
  if (!line) return '';
  if (mode === 'original' || mode == null) return line.text ?? '';
  const override = convertMap?.get(line.number);
  if (typeof override === 'string' && override.length > 0) return override;
  return line.text ?? '';
}

export function summarizeReaderLine(line, maxLength = READER_LINE_TRUNCATE) {
  if (!line) return '';
  const text = typeof line.text === 'string' ? line.text : '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}
function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validLocator(locator) {
  if (!locator || typeof locator !== 'object'
    || locator.source_id !== 'daocanon'
    || typeof locator.relative_path !== 'string') return false;
  const noLines = locator.line_start === null && locator.line_end === null;
  const physicalLines = Number.isInteger(locator.line_start)
    && locator.line_start > 0
    && Number.isInteger(locator.line_end)
    && locator.line_end >= locator.line_start
    && locator.line_end <= locator.line_start + 1;
  return noLines || physicalLines;
}

function validCatalogRecord(record) {
  return record
    && typeof record === 'object'
    && record.source_id === 'daocanon'
    && WORK_ID_PATTERN.test(record.work_id)
    && typeof record.title === 'string'
    && isNullableString(record.author)
    && isNullableString(record.division)
    && typeof record.relative_path === 'string'
    && Array.isArray(record.parse_warnings)
    && record.parse_warnings.every((warning) => typeof warning === 'string');
}

function validSearchHit(hit, mode) {
  if (!hit || typeof hit !== 'object') return false;
  if (hit.source_id !== 'daocanon'
    || !WORK_ID_PATTERN.test(hit.work_id)
    || typeof hit.title !== 'string') return false;
  if (!isNullableString(hit.author) || !isNullableString(hit.division)) return false;
  if (hit.match_type !== mode || !validLocator(hit.locator)) return false;
  const noLines = hit.locator.line_start === null && hit.locator.line_end === null;
  if (mode !== 'fulltext') return noLines;
  if (noLines) return false;
  return typeof hit.snippet === 'string'
    && typeof hit.match_text === 'string'
    && isNullableString(hit.context_before)
    && isNullableString(hit.context_after);
}

export function validateHealthEnvelope(body) {
  if (!isNonNegativeInteger(body?.data?.catalog?.work_count)) {
    throw new Error('invalid health response');
  }
  return body;
}

export function validateCatalogEnvelope(body) {
  if (!Array.isArray(body?.data?.records) || !body.data.records.every(validCatalogRecord)) {
    throw new Error('invalid catalog response');
  }
  return body;
}

export function validateSearchEnvelope(body) {
  const mode = body?.data?.mode;
  const validMeta = isNonNegativeInteger(body?.meta?.total)
    && isNonNegativeInteger(body?.meta?.offset)
    && Number.isInteger(body?.meta?.limit)
    && body.meta.limit > 0;
  if (!validMeta || !['title', 'author', 'fulltext'].includes(mode)
    || !Array.isArray(body?.data?.hits)
    || !body.data.hits.every((hit) => validSearchHit(hit, mode))) {
    throw new Error('invalid search response');
  }
  return body;
}

export function validateWorkEnvelope(body) {
  const work = body?.data?.work;
  const passage = body?.data?.passage;
  const meta = body?.meta;
  const validWork = validCatalogRecord(work)
    && work.source_id === 'daocanon'
    && WORK_ID_PATTERN.test(work.work_id);
  const validLines = Array.isArray(passage?.lines)
    && passage.lines.length > 0
    && passage.lines.length <= 100
    && passage.lines.every((line, index) => Number.isInteger(line?.number)
      && typeof line.text === 'string'
      && line.number === passage.line_start + index)
    && passage.lines.reduce((total, line) => total + [...line.text].length, 0) <= 200_000;
  const expectedPrevious = passage?.line_start > 1
    ? Math.max(1, passage.line_start - 90) : null;
  const expectedNext = passage?.line_end < passage?.total_lines
    ? passage.line_end + 1 : null;
  const validPassage = Number.isInteger(passage?.target_line)
    && Number.isInteger(passage?.line_start)
    && Number.isInteger(passage?.line_end)
    && Number.isInteger(passage?.total_lines)
    && passage.line_start >= 1
    && passage.line_end >= passage.line_start
    && passage.total_lines >= passage.line_end
    && passage.target_line >= passage.line_start
    && passage.target_line <= passage.line_end
    && passage.previous_line === expectedPrevious
    && passage.next_line === expectedNext
    && validLines
    && passage.lines.length === passage.line_end - passage.line_start + 1;
  if (!validWork || !validPassage
    || meta?.max_lines !== 100 || meta?.max_code_points !== 200_000) {
    throw new Error('invalid work response');
  }
  return body;
}

export function createRequestGate() {
  let sequence = 0;
  let active = null;
  return {
    begin() {
      active?.controller.abort();
      const request = {
        id: ++sequence,
        controller: new AbortController(),
      };
      active = request;
      return { id: request.id, signal: request.controller.signal };
    },
    isCurrent(id) {
      return active?.id === id;
    },
    finish(id) {
      if (active?.id !== id) return false;
      active = null;
      return true;
    },
    get busy() {
      return active !== null;
    },
  };
}

const PAGE_SIZE = 20;
const MODE_COPY = {
  browse: ['부별 목록', '전체 경전', 'CATALOG'],
  title: ['경전명', '경전명 검색', 'TITLE SEARCH'],
  author: ['저자', '저자 검색', 'AUTHOR SEARCH'],
  fulltext: ['전문', '전문 검색', 'FULLTEXT SEARCH'],
};

function byId(id) {
  return document.getElementById(id);
}

function makeNode(tag, className = '', text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function appendHighlighted(container, text, matchText) {
  const index = matchText ? text.indexOf(matchText) : -1;
  if (index === -1) {
    container.textContent = text;
    return;
  }
  container.append(document.createTextNode(text.slice(0, index)));
  const mark = document.createElement('mark');
  mark.textContent = matchText;
  container.append(mark, document.createTextNode(text.slice(index + matchText.length)));
}

async function readResponse(response, validate) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || body?.status !== 'ok') {
    const error = new Error('request failed');
    error.status = response.status;
    error.code = body?.error?.code;
    throw error;
  }
  return validate(body);
}

function safeMessage(error) {
  if (error?.name === 'AbortError') return null;
  if (error?.code === 'invalid_query') return '검색어 형식을 확인해 주세요.';
  if (error?.code === 'invalid_mode') return '지원하지 않는 검색 방식입니다.';
  if (error?.code === 'corpus_unavailable' || error?.status === 503) {
    return '도장 자료를 읽을 수 없습니다. 잠시 뒤 다시 시도해 주세요.';
  }
  if (error?.code === 'work_not_found' || error?.status === 404) {
    return '해당 경전을 찾을 수 없습니다.';
  }
  if (error?.code === 'line_out_of_range' || error?.status === 416) {
    return '요청한 행이 경전 범위를 벗어났습니다.';
  }
  if (error?.code === 'passage_too_large' || error?.status === 413) {
    return '해당 행이 너무 길어 안전하게 표시할 수 없습니다.';
  }
  if (error?.code === 'text_service_unavailable' || error?.status === 503) {
    return '텍스트 도구를 일시적으로 사용할 수 없습니다. 잠시 뒤 다시 시도해 주세요.';
  }
  if (error?.code === 'text_service_timeout' || error?.status === 504) {
    return '텍스트 도구 응답이 지연되고 있습니다. 다시 시도해 주세요.';
  }
  if (error?.code === 'body_too_large' || error?.status === 413) {
    return '입력 본문이 너무 깁니다. 분량을 줄여 다시 시도해 주세요.';
  }
  if (error?.code === 'invalid_direction') return '변환 방향이 잘못되었습니다.';
  if (error?.code === 'invalid_source_language') return '원문 종류 선택을 확인해 주세요.';
  if (error?.code === 'invalid_target_language') return '대상 언어가 한국어여야 합니다.';
  if (error?.code === 'invalid_model') return '지원하지 않는 번역 모델입니다.';
  if (error?.code === 'invalid_text') return '번역할 본문이 비어 있습니다.';
  return '요청을 완료하지 못했습니다. API 상태를 확인해 주세요.';
}

function initializeBrowser() {
  const refs = {
    apiStatus: byId('api-status'),
    apiStatusText: byId('api-status-text'),
    tabs: [...document.querySelectorAll('[role="tab"]')],
    searchForm: byId('search-form'),
    queryLabel: byId('query-label'),
    queryInput: byId('query-input'),
    searchSubmit: byId('search-submit'),
    draftStatus: byId('draft-status'),
    searchHints: byId('search-hints'),
    searchSurface: byId('search-surface'),
    workspace: byId('workspace'),
    layout: byId('workspace-layout'),
    divisionPanel: byId('division-panel'),
    divisionList: byId('division-list'),
    resultsHeading: byId('results-heading'),
    resultKicker: byId('result-kicker'),
    resultCount: byId('result-count'),
    message: byId('message'),
    results: byId('results'),
    previous: byId('previous-page'),
    next: byId('next-page'),
    pageSummary: byId('page-summary'),
    detailContent: byId('detail-content'),
    readerView: byId('reader-view'),
    readerBack: byId('reader-back'),
    readerRange: byId('reader-range'),
    readerHeading: byId('reader-heading'),
    readerMeta: byId('reader-meta'),
    readerStatus: byId('reader-status'),
    readerLines: byId('reader-lines'),
    readerPrevious: byId('reader-previous'),
    readerNext: byId('reader-next'),
    readerPageList: byId('reader-page-list'),
    readerConvert: byId('reader-convert'),
    readerConvertStatus: byId('reader-convert-status'),
    readerConvertButtons: [...document.querySelectorAll('.reader-convert-button')],
    readerTranslate: byId('reader-translate'),
    readerTranslateText: byId('reader-translate-text'),
    readerTranslateModel: byId('reader-translate-model'),
    readerTranslateSourceRadios: [...document.querySelectorAll('input[name="reader-translate-source"]')],
    readerTranslateSubmit: byId('reader-translate-submit'),
    readerTranslateStatus: byId('reader-translate-status'),
    readerTranslateOutput: byId('reader-translate-output'),
    readerAddEvidence: byId('reader-add-evidence'),
    readerAddFull: byId('reader-add-full'),
    readerAsk: byId('reader-ask'),
  };
  const healthGate = createRequestGate();
  const catalogGate = createRequestGate();
  const searchGate = createRequestGate();
  const readerGate = createRequestGate();
  const convertGate = createRequestGate();
  const translateGate = createRequestGate();
  const shelfStore = createShelfStore({ storage: window.sessionStorage });
  const stage3 = mountStage3({
    shelfStore,
    storage: window.sessionStorage,
    onNavigateCitation(target) {
      if (!target) return;
      if (target.surface === 'canon' && target.workId) {
        window.location.hash = buildReaderHash(target.workId, target.line, target.line);
        return;
      }
      if (target.surface === 'research') {
        const unit = target.unitType === 'entry' ? 'entries' : 'sections';
        const sourceHint = target.sourceId ? `/sources/${encodeURIComponent(target.sourceId)}` : '';
        window.location.assign(`/research/#/research${sourceHint}/${unit}/${encodeURIComponent(target.unitId)}`);
      }
    },
  });
  const stageB = mountStageB({
    client: createAgentClient(),
    onOpenReader(source) {
      if (!source || typeof source !== 'object') return;
      const line = source.locator?.target_line || source.locator?.line_start || 1;
      if (source.source_kind === 'primary' && source.work_id) {
        window.location.hash = buildReaderHash(source.work_id, line, line);
        return;
      }
      if (source.unit_id) {
        const unit = source.unit_type === 'entry' ? 'entries' : 'sections';
        const sourceHint = source.source_id ? `/sources/${encodeURIComponent(source.source_id)}` : '';
        window.location.assign(`/research/#/research${sourceHint}/${unit}/${encodeURIComponent(source.unit_id)}`);
      }
    },
  });
  window.addEventListener('daocanon:dialogue-context-transfer', (event) => {
    const detail = event.detail || {};
    stageB.replaceRetrievedSources(detail.evidence, detail.question);
  });
  const state = {
    mode: 'browse', records: [], division: '*', browseOffset: 0,
    committedQuery: '', searchOffset: 0, hits: [], total: 0,
    loading: { catalog: false, search: false }, selectedWorkId: null,
    readerRoute: null, readerWork: null, readerPassage: null, readerOpenedFromSearch: false,
    convertMode: 'original', convertMap: new Map(),
    translateInput: '', translateModel: 'gemma4:12b', translateSourceLanguage: 'classical_zh',
    translateOutput: '', translateBusy: false,
  };

  function setMessage(text, error = false) {
    refs.message.textContent = text;
    refs.message.classList.toggle('error', error);
  }

  function filteredRecords() {
    return state.division === '*'
      ? state.records
      : state.records.filter((record) => (record.division ?? null) === state.division);
  }

  function currentPage() {
    return state.mode === 'browse'
      ? paginationState(filteredRecords().length, state.browseOffset, PAGE_SIZE)
      : paginationState(state.total, state.searchOffset, PAGE_SIZE);
  }

  function updateDraftStatus() {
    const draft = refs.queryInput.value.trim();
    const dirty = state.mode !== 'browse' && draft !== state.committedQuery;
    refs.draftStatus.hidden = !dirty;
    refs.draftStatus.textContent = dirty
      ? '입력한 검색어는 아직 결과에 반영되지 않았습니다.'
      : '';
    refs.searchForm.classList.toggle('has-draft', dirty);
  }

  function updateControls() {
    const page = currentPage();
    const busy = isModeBusy(state.mode, state.loading);
    refs.previous.disabled = busy || !page.hasPrevious;
    refs.next.disabled = busy || !page.hasNext;
    refs.searchSubmit.disabled = state.loading.search;
    refs.workspace.setAttribute('aria-busy', busy ? 'true' : 'false');
    refs.resultCount.textContent = `${page.total.toLocaleString('ko-KR')}건`;
    refs.pageSummary.textContent = page.start
      ? `${page.start.toLocaleString('ko-KR')}–${page.end.toLocaleString('ko-KR')} / ${page.total.toLocaleString('ko-KR')}건`
      : `전체 ${page.total.toLocaleString('ko-KR')}건`;
    updateDraftStatus();
  }

  function renderDivisions() {
    refs.divisionList.replaceChildren();
    for (const division of groupDivisions(state.records)) {
      const button = makeNode('button', 'division-button');
      button.type = 'button';
      const active = state.division === division.value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.append(
        makeNode('span', '', division.label),
        makeNode('span', 'division-count', division.count.toLocaleString('ko-KR')),
      );
      button.addEventListener('click', () => {
        state.division = division.value;
        state.browseOffset = 0;
        state.selectedWorkId = null;
        renderDivisions();
        renderBrowse();
      });
      refs.divisionList.append(button);
    }
  }

  function addDetailField(list, label, value, className = '') {
    list.append(makeNode('dt', '', label), makeNode('dd', className, value ?? '—'));
  }

  function readerTarget(item) {
    const start = Number.isInteger(item?.locator?.line_start)
      ? item.locator.line_start : 1;
    const candidateEnd = Number.isInteger(item?.locator?.line_end)
      ? item.locator.line_end : start;
    const end = candidateEnd >= start && candidateEnd <= start + 1
      ? candidateEnd : start;
    return { workId: item.work_id, lineStart: start, lineEnd: end };
  }

  function readerHashFor(item) {
    const target = readerTarget(item);
    return buildReaderHash(target.workId, target.lineStart, target.lineEnd);
  }

  function prepareReaderLink(link, item) {
    link.href = readerHashFor(item);
    link.addEventListener('click', (event) => {
      if (event.button === 0 && !event.metaKey && !event.ctrlKey
        && !event.shiftKey && !event.altKey) {
        state.readerOpenedFromSearch = true;
      }
    });
    return link;
  }

  function navigateToReader(item) {
    state.readerOpenedFromSearch = true;
    window.location.hash = readerHashFor(item);
  }

  function bindDoubleClick(node, item) {
    node.addEventListener('dblclick', (event) => {
      event.preventDefault();
      navigateToReader(item);
    });
  }

  function showSearchView() {
    if (readerGate.busy) {
      const invalidation = readerGate.begin();
      readerGate.finish(invalidation.id);
    }
    state.readerRoute = null;
    state.readerOpenedFromSearch = false;
    refs.searchSurface.hidden = false;
    refs.workspace.hidden = false;
    refs.readerView.hidden = true;
    refs.readerView.setAttribute('aria-busy', 'false');
  }

  function showReaderView() {
    refs.searchSurface.hidden = true;
    refs.workspace.hidden = true;
    refs.readerView.hidden = false;
  }

  function resetReaderTools() {
    if (convertGate.busy) {
      const invalidation = convertGate.begin();
      convertGate.finish(invalidation.id);
    }
    if (translateGate.busy) {
      const invalidation = translateGate.begin();
      translateGate.finish(invalidation.id);
    }
    state.convertMap = new Map();
    state.convertMode = 'original';
    state.translateInput = '';
    state.translateOutput = '';
    state.translateBusy = false;
    if (refs.readerTranslateText) refs.readerTranslateText.value = '';
    if (refs.readerTranslateOutput) {
      refs.readerTranslateOutput.textContent = '';
      refs.readerTranslateOutput.hidden = true;
    }
    if (refs.readerTranslateStatus) {
      refs.readerTranslateStatus.classList.remove('error');
      refs.readerTranslateStatus.textContent = '';
      refs.readerTranslateStatus.hidden = true;
    }
    if (refs.readerConvertStatus) {
      refs.readerConvertStatus.classList.remove('error');
      refs.readerConvertStatus.textContent = '원문 그대로 표시 중입니다.';
      refs.readerConvertStatus.hidden = false;
    }
    for (const button of refs.readerConvertButtons) {
      const active = button.dataset.convert === 'original';
      button.setAttribute('aria-checked', active ? 'true' : 'false');
      button.disabled = true;
    }
  }

  function renderConvertedLines() {
    if (!state.readerPassage?.lines) return;
    const mode = state.convertMode;
    const map = state.convertMap;
    for (const entry of state.readerPassage.lines) {
      const node = byId(`L${entry.number}`);
      if (!node) continue;
      const textNode = node.querySelector('.reader-line-text');
      if (!textNode) continue;
      const next = readerLineDisplayText(entry, map, mode);
      textNode.textContent = next;
      node.dataset.readerLineMode = (mode === 'original') ? 'original' : 'converted';
    }
  }

  function setConvertStatus(message, { error = false } = {}) {
    if (!refs.readerConvertStatus) return;
    refs.readerConvertStatus.classList.toggle('error', error);
    refs.readerConvertStatus.textContent = message;
    refs.readerConvertStatus.hidden = false;
  }

  function setConvertMode(mode) {
    if (!isConvertDirection(mode)) return;
    state.convertMode = mode;
    for (const button of refs.readerConvertButtons) {
      const active = button.dataset.convert === mode;
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    renderConvertedLines();
  }

  async function runConvert() {
    if (!state.readerPassage?.lines) return;
    if (state.convertMode === 'original') {
      state.convertMap = new Map();
      renderConvertedLines();
      setConvertStatus('원문 그대로 표시 중입니다.');
      return;
    }
    const request = convertGate.begin();
    const direction = state.convertMode;
    setConvertStatus(`${direction === 's2t' ? '번체' : '간체'}로 변환 중입니다.`);
    for (const button of refs.readerConvertButtons) button.disabled = true;
    try {
      const next = new Map();
      const lines = state.readerPassage.lines;
      for (const entry of lines) {
        const text = typeof entry.text === 'string' ? entry.text : '';
        if (text.length === 0) {
          next.set(entry.number, '');
          continue;
        }
        const response = await fetch(buildConvertUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildConvertBody({ text, direction })),
          signal: request.signal,
        });
        const body = await readResponse(response, validateConvertEnvelope);
        if (!convertGate.isCurrent(request.id)) return;
        next.set(entry.number, body.data.converted);
      }
      if (!convertGate.isCurrent(request.id)) return;
      state.convertMap = next;
      renderConvertedLines();
      setConvertStatus(direction === 's2t' ? '번체로 변환된 본문을 표시 중입니다.' : '간체로 변환된 본문을 표시 중입니다.');
    } catch (error) {
      if (!convertGate.isCurrent(request.id) || error?.name === 'AbortError') return;
      const message = safeMessage(error) ?? '변환을 완료하지 못했습니다.';
      setConvertStatus(message, { error: true });
    } finally {
      if (convertGate.finish(request.id)) {
        for (const button of refs.readerConvertButtons) button.disabled = false;
      }
    }
  }

  function readSelectedSourceLanguage() {
    for (const radio of refs.readerTranslateSourceRadios) {
      if (radio.checked) return radio.value;
    }
    return 'classical_zh';
  }

  function setTranslateStatus(message, { error = false } = {}) {
    if (!refs.readerTranslateStatus) return;
    refs.readerTranslateStatus.classList.toggle('error', error);
    refs.readerTranslateStatus.textContent = message;
    refs.readerTranslateStatus.hidden = false;
  }

  async function runTranslate() {
    const text = refs.readerTranslateText?.value?.trim() ?? '';
    if (text.length === 0) {
      setTranslateStatus('번역할 본문을 붙여 넣어 주세요.', { error: true });
      return;
    }
    if (exceedsTranslateInputLimit(text)) {
      setTranslateStatus('입력 본문이 너무 깁니다. 분량을 줄여 다시 시도해 주세요.', { error: true });
      return;
    }
    const model = refs.readerTranslateModel?.value ?? 'gemma4:12b';
    const sourceLanguage = readSelectedSourceLanguage();
    state.translateModel = model;
    state.translateSourceLanguage = sourceLanguage;
    state.translateInput = text;
    const request = translateGate.begin();
    state.translateBusy = true;
    if (refs.readerTranslateSubmit) refs.readerTranslateSubmit.disabled = true;
    setTranslateStatus('한국어로 번역 중입니다.');
    if (refs.readerTranslateOutput) {
      refs.readerTranslateOutput.textContent = '';
      refs.readerTranslateOutput.hidden = true;
    }
    try {
      const response = await fetch(buildTranslateUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTranslateBody({
          text, sourceLanguage, targetLanguage: 'ko', model,
        })),
        signal: request.signal,
      });
      const body = await readResponse(response, validateTranslateEnvelope);
      if (!translateGate.isCurrent(request.id)) return;
      state.translateOutput = body.data.translation;
      if (refs.readerTranslateOutput) {
        refs.readerTranslateOutput.textContent = body.data.translation;
        refs.readerTranslateOutput.hidden = false;
      }
      setTranslateStatus('번역이 끝났습니다. 결과는 저장되지 않았습니다.');
    } catch (error) {
      if (!translateGate.isCurrent(request.id) || error?.name === 'AbortError') return;
      const message = safeMessage(error) ?? '번역을 완료하지 못했습니다.';
      setTranslateStatus(message, { error: true });
      state.translateOutput = '';
      if (refs.readerTranslateOutput) {
        refs.readerTranslateOutput.textContent = '';
        refs.readerTranslateOutput.hidden = true;
      }
    } finally {
      if (translateGate.finish(request.id)) {
        state.translateBusy = false;
        if (refs.readerTranslateSubmit) refs.readerTranslateSubmit.disabled = false;
      }
    }
  }

  function renderPassagePager(passage) {
    if (!refs.readerPageList) return;
    refs.readerPageList.replaceChildren();
    const totalLines = passage?.total_lines;
    if (!Number.isInteger(totalLines) || totalLines < 1) return;

    const totalPages = passagePageCount(totalLines);
    const anchor = Number.isInteger(passage.target_line)
      ? passage.target_line
      : (Number.isInteger(passage.line_start) ? passage.line_start : 1);
    const current = Math.min(totalPages, passagePageOfLine(anchor));

    for (const token of compactPageTokens(current, totalPages, 2)) {
      if (token === '…') {
        const ellipsis = makeNode('span', 'reader-page-ellipsis', '…');
        ellipsis.setAttribute('aria-hidden', 'true');
        refs.readerPageList.append(ellipsis);
        continue;
      }
      const startLine = passagePageStartLine(token);
      const endLine = Math.min(totalLines, token * READER_PAGE_SIZE);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = token === current
        ? 'reader-page-button is-current'
        : 'reader-page-button';
      button.textContent = String(token);
      button.title = `구간 ${token}: L${startLine}–L${endLine}`;
      button.setAttribute(
        'aria-label',
        `구간 ${token}, L${startLine}부터 L${endLine}`,
      );
      if (token === current) {
        button.setAttribute('aria-current', 'page');
        button.disabled = true;
      } else {
        button.addEventListener('click', () => moveReader(startLine));
      }
      refs.readerPageList.append(button);
    }
  }

  function renderReader(body, route) {
    const { work, passage } = body.data;
    state.readerWork = work;
    state.readerPassage = passage;
    refs.readerHeading.textContent = work.title;
    refs.readerMeta.replaceChildren();
    addDetailField(refs.readerMeta, '저자', work.author ?? '저자 미상');
    addDetailField(refs.readerMeta, '부', work.division ?? '미분류');
    addDetailField(refs.readerMeta, '상대 경로', work.relative_path, 'path-text');
    const totalPages = passagePageCount(passage.total_lines);
    const currentPage = passagePageOfLine(passage.target_line || passage.line_start || route.lineStart || 1);
    refs.readerRange.textContent = totalPages > 1
      ? `구간 ${currentPage}/${totalPages} · L${passage.line_start}–L${passage.line_end} / ${passage.total_lines.toLocaleString('ko-KR')}행`
      : `L${passage.line_start}–L${passage.line_end} / ${passage.total_lines.toLocaleString('ko-KR')}행`;
    refs.readerLines.replaceChildren();
    for (const entry of passage.lines) {
      const line = makeNode('li', 'reader-line');
      line.id = `L${entry.number}`;
      line.value = entry.number;
      line.append(makeNode('span', 'reader-line-text', entry.text));
      if (entry.number >= route.lineStart && entry.number <= route.lineEnd) {
        line.classList.add('reader-line-match');
      }
      if (entry.number === route.lineStart) {
        line.setAttribute('aria-current', 'location');
      }
      refs.readerLines.append(line);
    }
    refs.readerPrevious.disabled = passage.previous_line === null;
    refs.readerNext.disabled = passage.next_line === null;
    refs.readerPrevious.dataset.line = passage.previous_line ?? '';
    refs.readerNext.dataset.line = passage.next_line ?? '';
    renderPassagePager(passage);
    refs.readerStatus.classList.remove('error');
    refs.readerStatus.textContent = `요청한 L${route.lineStart}${route.lineEnd === route.lineStart ? '' : `–L${route.lineEnd}`}을 포함한 원문입니다.`;
    for (const button of refs.readerConvertButtons) button.disabled = false;
    renderConvertedLines();
    refs.readerHeading.focus({ preventScroll: true });
    requestAnimationFrame(() => byId(`L${route.lineStart}`)?.scrollIntoView({ block: 'center' }));
  }

  async function loadReader(route) {
    const request = readerGate.begin();
    state.readerRoute = route;
    state.readerWork = null;
    state.readerPassage = null;
    showReaderView();
    resetReaderTools();
    refs.readerView.setAttribute('aria-busy', 'true');
    refs.readerHeading.textContent = '경전 불러오는 중';
    refs.readerMeta.replaceChildren();
    refs.readerLines.replaceChildren();
    refs.readerRange.textContent = '—';
    refs.readerPrevious.disabled = true;
    refs.readerNext.disabled = true;
    if (refs.readerPageList) refs.readerPageList.replaceChildren();
    refs.readerStatus.classList.remove('error');
    refs.readerStatus.textContent = `L${route.lineStart} 근처 원문을 불러오고 있습니다.`;
    try {
      const response = await fetch(buildWorkUrl(route.workId, route.lineStart), {
        signal: request.signal,
      });
      const body = await readResponse(response, validateWorkEnvelope);
      if (!readerGate.isCurrent(request.id)
        || parseReaderHash(window.location.hash)?.workId !== route.workId) return;
      if (body.data.work.work_id !== route.workId
        || !passageContainsRoute(body.data.passage, route)) {
        const error = new Error('reader route does not match work response');
        error.code = 'line_out_of_range';
        throw error;
      }
      renderReader(body, route);
    } catch (error) {
      if (!readerGate.isCurrent(request.id)) return;
      const message = safeMessage(error);
      if (message === null) return;
      refs.readerStatus.classList.add('error');
      refs.readerStatus.textContent = message;
      refs.readerHeading.textContent = '경전을 표시할 수 없습니다';
    } finally {
      if (readerGate.finish(request.id)) {
        refs.readerView.setAttribute('aria-busy', 'false');
      }
    }
  }

  function handleHashRoute() {
    if (!window.location.hash || window.location.hash === '#') {
      showSearchView();
      return;
    }
    const route = parseReaderHash(window.location.hash);
    if (!route) {
      showSearchView();
      setMessage('올바르지 않은 경전 위치입니다.', true);
      return;
    }
    loadReader(route);
  }

  function renderDetail(item) {
    refs.detailContent.replaceChildren();
    if (!item) {
      refs.detailContent.append(makeNode(
        'p', 'empty-detail',
        '목록에서 경전을 선택하면 API가 제공한 서지와 상대 경로를 확인할 수 있습니다.',
      ));
      return;
    }
    refs.detailContent.append(makeNode('h3', 'detail-title', item.title));
    const list = makeNode('dl', 'detail-grid');
    addDetailField(list, '저자', item.author ?? '저자 미상');
    addDetailField(list, '부', item.division ?? '미분류');
    if (item.match_type) addDetailField(list, '매칭', item.match_type);
    const physicalLine = lineLabel(item.locator);
    if (physicalLine) addDetailField(list, '위치', physicalLine);
    addDetailField(
      list, '상대 경로', item.locator?.relative_path ?? item.relative_path,
      'detail-value path-text',
    );
    if (Array.isArray(item.parse_warnings)) {
      addDetailField(list, '파싱 경고', `${item.parse_warnings.length}건`);
    }
    refs.detailContent.append(list);
    if (item.match_type === 'fulltext') {
      const snippet = makeNode('p', 'snippet');
      appendHighlighted(snippet, item.snippet ?? '', item.match_text ?? '');
      refs.detailContent.append(snippet);
      if (item.context_before != null) {
        refs.detailContent.append(makeNode('p', 'context', `앞 문맥 · ${item.context_before}`));
      }
      if (item.context_after != null) {
        refs.detailContent.append(makeNode('p', 'context', `뒤 문맥 · ${item.context_after}`));
      }
    }
    const readerLink = prepareReaderLink(
      makeNode('a', 'work-link detail-reader-link', physicalLine ? '이 위치에서 경전 읽기' : '경전 처음부터 읽기'),
      item,
    );
    refs.detailContent.append(readerLink);
  }

  function renderBrowse() {
    const records = filteredRecords();
    const page = paginationState(records.length, state.browseOffset, PAGE_SIZE);
    refs.resultsHeading.textContent = state.division === '*' ? '전체 경전' : state.division ?? '미분류';
    refs.resultKicker.textContent = 'CATALOG';
    refs.results.replaceChildren();
    if (!records.length) {
      refs.results.append(makeNode('p', 'empty-state', '이 부에는 표시할 경전이 없습니다.'));
      setMessage('목록이 비어 있습니다.');
      renderDetail(null);
      updateControls();
      return;
    }
    const table = makeNode('table', 'catalog-table');
    const thead = makeNode('thead');
    const headingRow = makeNode('tr');
    for (const [text, width] of [['경전명', '45%'], ['저자 · 부', '24%'], ['상대 경로', '31%']]) {
      const th = makeNode('th', '', text);
      th.style.width = width;
      headingRow.append(th);
    }
    thead.append(headingRow);
    const tbody = makeNode('tbody');
    for (const record of records.slice(state.browseOffset, state.browseOffset + PAGE_SIZE)) {
      const row = makeNode('tr');
      const titleCell = makeNode('td');
      titleCell.dataset.label = '경전명';
      const title = prepareReaderLink(makeNode('a', 'work-link', record.title), record);
      const preview = makeNode('button', 'preview-button', '근거 미리보기');
      preview.type = 'button';
      preview.addEventListener('click', () => {
        state.selectedWorkId = record.work_id;
        renderDetail(record);
      });
      titleCell.append(
        title,
        preview,
        makeNode('div', 'cell-meta', `파싱 경고 ${record.parse_warnings?.length ?? 0}건`),
      );
      const author = makeNode('td');
      author.dataset.label = '저자 · 부';
      author.append(
        makeNode('div', '', record.author ?? '저자 미상'),
        makeNode('div', 'cell-meta', record.division ?? '미분류'),
      );
      const pathCell = makeNode('td', 'path-text', record.relative_path);
      pathCell.dataset.label = '상대 경로';
      row.append(titleCell, author, pathCell);
      bindDoubleClick(row, record);
      tbody.append(row);
    }
    table.append(thead, tbody);
    refs.results.append(table);
    setMessage(`${page.start}번째부터 ${page.end}번째 경전을 표시합니다.`);
    updateControls();
  }

  function renderSearchResults() {
    const copy = MODE_COPY[state.mode];
    refs.resultsHeading.textContent = state.committedQuery
      ? `${copy[0]} · ${state.committedQuery}` : copy[1];
    refs.resultKicker.textContent = copy[2];
    refs.results.replaceChildren();
    if (!state.hits.length) {
      const message = state.searchOffset
        ? '이 페이지에는 결과가 없습니다. 이전 버튼으로 돌아가세요.'
        : '일치하는 결과가 없습니다.';
      refs.results.append(makeNode('p', 'empty-state', message));
      setMessage(message);
      renderDetail(null);
      updateControls();
      return;
    }
    const resultList = makeNode('ul', 'result-list');
    const initialHit = state.hits[0];
    state.selectedWorkId = initialHit.work_id;
    renderDetail(initialHit);
    for (const [index, hit] of state.hits.entries()) {
      const item = makeNode('li', 'result-item');
      const heading = makeNode('div', 'result-row-heading');
      const title = prepareReaderLink(makeNode('a', 'work-link result-title', hit.title), hit);
      const button = makeNode('button', 'result-button preview-button', '근거 미리보기');
      button.type = 'button';
      button.setAttribute('aria-pressed', index === 0 ? 'true' : 'false');
      button.classList.toggle('active', index === 0);
      button.setAttribute('aria-label', `${hit.title} 근거 미리보기`);
      heading.append(title, button);
      const metadata = [
        hit.author ?? '저자 미상',
        hit.division ?? '미분류',
        hit.match_type,
        lineLabel(hit.locator),
      ].filter(Boolean).join(' · ');
      item.append(
        heading,
        makeNode('span', 'result-meta', metadata),
        makeNode('span', 'path-text', hit.locator.relative_path),
      );
      if (hit.match_type === 'fulltext') {
        const snippet = prepareReaderLink(makeNode('a', 'snippet-link'), hit);
        snippet.classList.add('snippet');
        snippet.id = `result-snippet-${state.searchOffset + index}`;
        appendHighlighted(snippet, hit.snippet ?? '', hit.match_text ?? '');
        button.setAttribute('aria-describedby', snippet.id);
        item.append(snippet);
      }
      button.addEventListener('click', () => {
        state.selectedWorkId = hit.work_id;
        for (const candidate of refs.results.querySelectorAll('.result-button')) {
          candidate.classList.toggle('active', candidate === button);
          candidate.setAttribute('aria-pressed', candidate === button ? 'true' : 'false');
        }
        renderDetail(hit);
      });
      bindDoubleClick(item, hit);
      resultList.append(item);
    }
    refs.results.append(resultList);
    const page = paginationState(state.total, state.searchOffset, PAGE_SIZE);
    setMessage(`${page.start}번째부터 ${page.end}번째 결과를 표시합니다.`);
    updateControls();
  }

  function invalidateSearch() {
    if (!searchGate.busy) return;
    const invalidation = searchGate.begin();
    searchGate.finish(invalidation.id);
    state.loading.search = false;
  }

  function switchMode(mode, focusInput = true) {
    if (!MODE_COPY[mode] || state.mode === mode) return;
    invalidateSearch();
    state.mode = mode;
    state.searchOffset = 0;
    state.hits = [];
    state.total = 0;
    state.committedQuery = '';
    state.selectedWorkId = null;
    for (const tab of refs.tabs) {
      const active = tab.dataset.mode === mode;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      if (active) refs.workspace.setAttribute('aria-labelledby', tab.id);
    }
    const browsing = mode === 'browse';
    refs.searchForm.hidden = browsing;
    refs.searchHints.hidden = !browsing;
    refs.divisionPanel.hidden = !browsing;
    refs.layout.classList.toggle('searching', !browsing);
    renderDetail(null);
    if (browsing) {
      renderBrowse();
      return;
    }
    refs.queryLabel.textContent = `${MODE_COPY[mode][0]} 검색어`;
    refs.queryInput.placeholder = `${MODE_COPY[mode][0]} 검색어를 입력하세요`;
    refs.resultsHeading.textContent = MODE_COPY[mode][1];
    refs.resultKicker.textContent = MODE_COPY[mode][2];
    refs.results.replaceChildren(makeNode('p', 'empty-state', '검색어를 입력하고 검색 버튼을 누르세요.'));
    setMessage('새 검색을 기다리고 있습니다.');
    updateControls();
    if (focusInput) refs.queryInput.focus();
  }

  async function runSearch(query, offset) {
    const mode = state.mode;
    const request = searchGate.begin();
    state.loading.search = true;
    state.committedQuery = query;
    state.searchOffset = offset;
    state.selectedWorkId = null;
    refs.resultsHeading.textContent = `${MODE_COPY[mode][0]} · ${query}`;
    refs.resultKicker.textContent = MODE_COPY[mode][2];
    setMessage('검색 중입니다.');
    updateControls();
    try {
      const response = await fetch(buildSearchUrl({
        query, mode, limit: PAGE_SIZE, offset,
      }), { signal: request.signal });
      const body = await readResponse(response, validateSearchEnvelope);
      if (!searchGate.isCurrent(request.id) || state.mode !== mode) return;
      state.hits = body.data.hits;
      state.total = body.meta.total;
      state.searchOffset = body.meta.offset;
      renderSearchResults();
    } catch (error) {
      if (!searchGate.isCurrent(request.id)) return;
      const message = safeMessage(error);
      if (message === null) return;
      state.hits = [];
      state.total = 0;
      refs.results.replaceChildren(makeNode('p', 'empty-state', message));
      setMessage(message, true);
      renderDetail(null);
    } finally {
      if (searchGate.finish(request.id)) {
        state.loading.search = false;
        updateControls();
      }
    }
  }

  async function loadHealth() {
    const request = healthGate.begin();
    try {
      const response = await fetch('/health', { signal: request.signal });
      const body = await readResponse(response, validateHealthEnvelope);
      if (!healthGate.isCurrent(request.id)) return;
      refs.apiStatus.hidden = true;
      refs.apiStatus.classList.add('ready');
      refs.apiStatus.classList.remove('failed');
      refs.apiStatusText.textContent = '';
    } catch (error) {
      if (!healthGate.isCurrent(request.id) || error?.name === 'AbortError') return;
      refs.apiStatus.hidden = false;
      refs.apiStatus.classList.add('failed');
      refs.apiStatus.classList.remove('ready');
      refs.apiStatusText.textContent = 'API 또는 corpus를 확인하세요';
    } finally {
      healthGate.finish(request.id);
    }
  }

  async function loadCatalog() {
    const request = catalogGate.begin();
    state.loading.catalog = true;
    updateControls();
    try {
      const response = await fetch('/v1/catalog', { signal: request.signal });
      const body = await readResponse(response, validateCatalogEnvelope);
      if (!catalogGate.isCurrent(request.id)) return;
      state.records = body.data.records;
      renderDivisions();
      if (state.mode === 'browse') renderBrowse();
    } catch (error) {
      if (!catalogGate.isCurrent(request.id)) return;
      const message = safeMessage(error);
      if (message === null) return;
      state.records = [];
      renderDivisions();
      refs.results.replaceChildren(makeNode('p', 'empty-state', message));
      setMessage(message, true);
    } finally {
      if (catalogGate.finish(request.id)) {
        state.loading.catalog = false;
        updateControls();
      }
    }
  }

  refs.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = refs.queryInput.value.trim();
    if (query && !state.loading.search) runSearch(query, 0);
  });

  refs.queryInput.addEventListener('input', updateDraftStatus);

  refs.previous.addEventListener('click', () => {
    const page = currentPage();
    if (!page.hasPrevious || isModeBusy(state.mode, state.loading)) return;
    if (state.mode === 'browse') {
      state.browseOffset = page.previousOffset;
      renderBrowse();
    } else runSearch(state.committedQuery, page.previousOffset);
  });

  refs.next.addEventListener('click', () => {
    const page = currentPage();
    if (!page.hasNext || isModeBusy(state.mode, state.loading)) return;
    if (state.mode === 'browse') {
      state.browseOffset = page.nextOffset;
      renderBrowse();
    } else runSearch(state.committedQuery, page.nextOffset);
  });

  for (const tab of refs.tabs) {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
    tab.addEventListener('keydown', (event) => {
      const index = refs.tabs.indexOf(tab);
      let target = null;
      if (event.key === 'ArrowRight') target = (index + 1) % refs.tabs.length;
      if (event.key === 'ArrowLeft') target = (index - 1 + refs.tabs.length) % refs.tabs.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = refs.tabs.length - 1;
      if (target === null) return;
      event.preventDefault();
      switchMode(refs.tabs[target].dataset.mode, false);
      refs.tabs[target].focus();
    });
  }

  for (const hint of document.querySelectorAll('[data-example]')) {
    hint.addEventListener('click', () => {
      switchMode(hint.dataset.exampleMode, false);
      refs.queryInput.value = hint.dataset.example;
      updateDraftStatus();
      refs.queryInput.focus();
    });
  }

  refs.readerBack.addEventListener('click', () => {
    if (state.readerOpenedFromSearch && window.history.length > 1) {
      window.history.back();
      return;
    }
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    handleHashRoute();
  });

  function moveReader(targetLine) {
    if (!state.readerRoute || !Number.isInteger(targetLine)) return;
    window.location.hash = buildReaderHash(state.readerRoute.workId, targetLine, targetLine);
  }

  refs.readerPrevious.addEventListener('click', () => {
    moveReader(Number(refs.readerPrevious.dataset.line));
  });
  refs.readerNext.addEventListener('click', () => {
    moveReader(Number(refs.readerNext.dataset.line));
  });

  for (const button of refs.readerConvertButtons) {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const direction = button.dataset.convert;
      if (!isConvertDirection(direction)) return;
      if (state.convertMode === direction) {
        if (direction !== 'original') runConvert();
        return;
      }
      setConvertMode(direction);
      if (direction !== 'original') runConvert();
    });
  }

  if (refs.readerTranslateSubmit) {
    refs.readerTranslateSubmit.addEventListener('click', () => {
      if (state.translateBusy) return;
      runTranslate();
    });
  }

  if (refs.readerTranslateText) {
    refs.readerTranslateText.addEventListener('input', () => {
      if (refs.readerTranslateStatus?.classList.contains('error')) {
        refs.readerTranslateStatus.classList.remove('error');
        refs.readerTranslateStatus.textContent = '';
        refs.readerTranslateStatus.hidden = true;
      }
    });
  }

  function currentReaderEvidence(selection = {}) {
    if (!state.readerWork || !state.readerPassage) {
      throw new Error('먼저 경전 원문을 열어 주세요.');
    }
    return fromCanonReader({
      work: state.readerWork,
      passage: state.readerPassage,
    }, {
      scope: 'window',
      scope_label: '이 구간',
      ...selection,
    });
  }

  function notifyShelf(result) {
    if (!result) return;
    // shelf-store returns { ok, added|updated, key } — not { status }.
    if (result.ok && (result.added || result.updated)) {
      refs.readerStatus.classList.remove('error');
      refs.readerStatus.textContent = result.updated
        ? '선반 항목을 갱신했습니다.'
        : (result.clipped
          ? '근거 선반에 담았습니다. (본문이 길어 앞부분만 담았습니다)'
          : '근거 선반에 담았습니다.');
      return;
    }
    refs.readerStatus.classList.add('error');
    const code = result.error?.code || result.reason;
    if (code === 'shelf_full' || code === 'item_cap_exceeded') {
      refs.readerStatus.textContent = '선반이 가득 찼습니다. 일부 항목을 비워 주세요.';
      return;
    }
    if (code === 'selected_text_too_large') {
      refs.readerStatus.textContent = '근거 본문이 너무 깁니다. 더 짧은 구간을 담아 주세요.';
      return;
    }
    refs.readerStatus.textContent = result.error?.message || '근거를 선반에 담지 못했습니다.';
  }

  if (refs.readerAddEvidence) {
    refs.readerAddEvidence.addEventListener('click', () => {
      try {
        const passage = state.readerPassage;
        notifyShelf(stage3.addEvidence(currentReaderEvidence({
          scope_label: passage
            ? `L${passage.line_start}–L${passage.line_end}`
            : '이 구간',
        })));
      } catch (error) {
        refs.readerStatus.classList.add('error');
        refs.readerStatus.textContent = error.message || '근거를 선반에 담지 못했습니다.';
      }
    });
  }
  if (refs.readerAddFull) {
    refs.readerAddFull.addEventListener('click', async () => {
      if (!state.readerWork?.work_id) {
        refs.readerStatus.classList.add('error');
        refs.readerStatus.textContent = '먼저 경전 원문을 열어 주세요.';
        return;
      }
      const prev = refs.readerAddFull.textContent;
      refs.readerAddFull.disabled = true;
      refs.readerAddFull.textContent = '참조 등록 중…';
      refs.readerStatus.classList.remove('error');
      refs.readerStatus.textContent = '전체 원문 참조를 근거 선반에 등록하고 있습니다.';
      try {
        const evidence = fromCanonWholeWork({
          work: state.readerWork,
          passage: state.readerPassage,
        });
        notifyShelf(stage3.addEvidence(evidence));
      } catch (error) {
        refs.readerStatus.classList.add('error');
        refs.readerStatus.textContent = error.message || '전체 원문 참조를 담지 못했습니다.';
      } finally {
        refs.readerAddFull.disabled = false;
        refs.readerAddFull.textContent = prev || '전체 원문 참조 담기';
      }
    });
  }
  if (refs.readerAsk) {
    refs.readerAsk.addEventListener('click', () => {
      try {
        const passage = state.readerPassage;
        notifyShelf(stage3.addEvidenceAndAsk(currentReaderEvidence({
          scope_label: passage
            ? `L${passage.line_start}–L${passage.line_end}`
            : '이 구간',
        })));
      } catch (error) {
        refs.readerStatus.classList.add('error');
        refs.readerStatus.textContent = error.message || '근거를 선반에 담지 못했습니다.';
      }
    });
  }

  window.addEventListener('hashchange', handleHashRoute);

  loadHealth();
  loadCatalog();
  handleHashRoute();
}

if (typeof document !== 'undefined') initializeBrowser();
