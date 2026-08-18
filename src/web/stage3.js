// Stage 3A UI: evidence shelf controls + selected-evidence dialogue panel.
// Shared by both surfaces (Stage 1 and Research Web) through vendored copies
// of evidence.js / shelf-store.js. Pure request/response/citation helpers are
// exported for unit tests; mountStage3 wires the DOM against a ShelfStore.

import {
  evidenceKey,
  toEvidenceReference,
} from './evidence.js';

export const DIALOGUE_STORAGE_KEY = 'daocanon.research.dialogue.v0.1';
export const DIALOGUE_REQUEST_SCHEMA_VERSION = 'dialogue.request.v0.1';
export const DIALOGUE_RESPONSE_SCHEMA_VERSION = 'dialogue.response.v0.1';
export const DIALOGUE_ERROR_SCHEMA_VERSION = 'dialogue.error.v0.1';
export const DIALOGUE_SESSION_SCHEMA_VERSION = 'dialogue.session.v0.1';

export const MAX_QUESTION_CODE_POINTS = 2000;
export const MAX_EVIDENCE_ITEMS = 20;
export const MAX_IDENTITY_CODE_POINTS = 128;
export const SUPPORTED_MODE = 'selected_evidence';
export const SUPPORTED_LOCALE = 'ko-KR';

const CANON_WORK_ID = /^dc1_[0-9a-f]{64}$/;
const ENTRY_ID = /^ent[0-9a-f]{32}$/;
const SECTION_ID = /^sec[0-9a-f]{32}$/;

export function codePointLength(value) {
  if (typeof value !== 'string') return 0;
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

function hasControlChar(value) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isBoundedOpaqueId(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (codePointLength(value) > MAX_IDENTITY_CODE_POINTS) {
    throw new TypeError(`${label} exceeds ${MAX_IDENTITY_CODE_POINTS} code points`);
  }
  if (hasControlChar(value)) {
    throw new TypeError(`${label} must not contain control characters`);
  }
  return value;
}

function newRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildChatUrl() {
  return '/api/dialogue/v1/chat';
}

export function buildDialogueRequest({ sessionId, turnId, question, evidence, model }) {
  const session = isBoundedOpaqueId(sessionId, 'session_id');
  const turn = isBoundedOpaqueId(turnId, 'turn_id');
  if (typeof question !== 'string') {
    throw new TypeError('question must be a string');
  }
  const trimmedQuestion = question.trim();
  const questionLength = codePointLength(trimmedQuestion);
  if (questionLength < 1) {
    throw new TypeError('question must not be empty after trimming');
  }
  if (questionLength > MAX_QUESTION_CODE_POINTS) {
    throw new TypeError(`question exceeds ${MAX_QUESTION_CODE_POINTS} code points`);
  }
  if (!Array.isArray(evidence)) {
    throw new TypeError('evidence must be an array');
  }
  if (evidence.length < 1 || evidence.length > MAX_EVIDENCE_ITEMS) {
    throw new TypeError(`evidence must contain 1..${MAX_EVIDENCE_ITEMS} items`);
  }
  const validEvidence = evidence.map((item) => {
    try {
      return toEvidenceReference(item);
    } catch (error) {
      throw new TypeError(`evidence item invalid: ${error.message}`);
    }
  });
  const payload = {
    schema_version: DIALOGUE_REQUEST_SCHEMA_VERSION,
    mode: SUPPORTED_MODE,
    request_id: newRequestId(),
    session_id: session,
    turn_id: turn,
    question: trimmedQuestion,
    evidence: validEvidence,
    locale: SUPPORTED_LOCALE,
  };
  if (typeof model === 'string' && model.length > 0) {
    payload.model = model;
  }
  return payload;
}

export function parseDialogueResponse(body, expected) {
  const invalid = (code) => ({ ok: false, error: { code, message: 'invalid dialogue response' } });
  if (!body || typeof body !== 'object') return invalid('malformed_envelope');
  if (body.schema_version !== DIALOGUE_RESPONSE_SCHEMA_VERSION) return invalid('schema_mismatch');
  if (body.status !== 'ok') return invalid('not_ok');
  if (typeof body.request_id !== 'string' || body.request_id.length === 0
    || typeof body.session_id !== 'string' || body.session_id.length === 0
    || typeof body.turn_id !== 'string' || body.turn_id.length === 0) {
    return invalid('identity_missing');
  }
  if (expected) {
    if (body.request_id !== expected.request_id
      || body.session_id !== expected.session_id
      || body.turn_id !== expected.turn_id) {
      return invalid('identity_mismatch');
    }
  }
  if (typeof body.answer !== 'string' || body.answer.length === 0) {
    return invalid('answer_missing');
  }
  if (!Array.isArray(body.citations)) return invalid('citations_invalid');
  for (const citation of body.citations) {
    if (!citation || typeof citation !== 'object'
      || typeof citation.citation_id !== 'string' || citation.citation_id.length === 0
      || typeof citation.evidence_key !== 'string' || citation.evidence_key.length === 0
      || typeof citation.reader_url !== 'string' || citation.reader_url.length === 0) {
      return invalid('citation_invalid');
    }
  }
  const grounding = body.grounding;
  if (!grounding || typeof grounding !== 'object'
    || !Number.isInteger(grounding.requested)
    || !Number.isInteger(grounding.verified)
    || !Number.isInteger(grounding.excluded)) {
    return invalid('grounding_invalid');
  }
  const model = body.model;
  if (!model || typeof model !== 'object'
    || typeof model.backend !== 'string'
    || typeof model.model_id !== 'string') {
    return invalid('model_invalid');
  }
  return { ok: true, value: body };
}

export function parseDialogueError(body) {
  if (!body || typeof body !== 'object' || body.status !== 'error' || !body.error) {
    return { code: 'unknown_error', message: '요청을 완료하지 못했습니다.', excluded_evidence_keys: [] };
  }
  const error = body.error;
  const excluded = Array.isArray(error.excluded_evidence_keys)
    ? error.excluded_evidence_keys.filter((key) => typeof key === 'string')
    : [];
  return {
    code: typeof error.code === 'string' && error.code.length > 0 ? error.code : 'unknown_error',
    message: typeof error.message === 'string' && error.message.length > 0
      ? error.message
      : '요청을 완료하지 못했습니다.',
    excluded_evidence_keys: excluded,
  };
}

export function citationTargetForCanon(readerUrl) {
  if (typeof readerUrl !== 'string' || !readerUrl.startsWith('/api/daocanon/v1/works/')) return null;
  const match = /^\/api\/daocanon\/v1\/works\/(dc1_[0-9a-f]{64})\?line=([1-9][0-9]*)$/.exec(readerUrl);
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line < 1 || line > 10_000_000) return null;
  if (!CANON_WORK_ID.test(match[1])) return null;
  return { surface: 'canon', workId: match[1], line };
}

export function citationTargetForResearch(readerUrl) {
  if (typeof readerUrl !== 'string' || !readerUrl.startsWith('/api/daoism-research/v1/')) return null;
  const entryMatch = /^\/api\/daoism-research\/v1\/entries\/(ent[0-9a-f]{32})(?:\?|$)/.exec(readerUrl);
  if (entryMatch && ENTRY_ID.test(entryMatch[1])) {
    return { surface: 'research', unitType: 'entry', unitId: entryMatch[1] };
  }
  const sectionMatch = /^\/api\/daoism-research\/v1\/sections\/(sec[0-9a-f]{32})(?:\?|$)/.exec(readerUrl);
  if (sectionMatch && SECTION_ID.test(sectionMatch[1])) {
    return { surface: 'research', unitType: 'section', unitId: sectionMatch[1] };
  }
  return null;
}

export function citationTargetForReference(reference) {
  if (!reference || typeof reference !== 'object') return null;
  const locator = reference.locator || {};
  const line = Number.isInteger(locator.target_line)
    ? locator.target_line
    : Number.isInteger(locator.line_start)
      ? locator.line_start
      : Number.isInteger(locator.body_line_start)
        ? locator.body_line_start
        : Number.isInteger(locator.unit_line_start)
          ? locator.unit_line_start
          : 1;

  if (reference.source_kind === 'primary' || reference.unit_type === 'work') {
    if (reference.work_id) {
      return { surface: 'canon', workId: reference.work_id, line };
    }
  }
  if (reference.unit_type === 'entry' && reference.unit_id) {
    return {
      surface: 'research',
      unitType: 'entry',
      unitId: reference.unit_id,
      sourceId: reference.source_id || null,
    };
  }
  if (reference.unit_type === 'section' && reference.unit_id) {
    return {
      surface: 'research',
      unitType: 'section',
      unitId: reference.unit_id,
      sourceId: reference.source_id || null,
    };
  }
  return null;
}

export function countBySourceKind(items) {
  const counts = { primary: 0, dictionary: 0, research: 0 };
  for (const item of items) {
    if (item && typeof item.source_kind === 'string' && Object.prototype.hasOwnProperty.call(counts, item.source_kind)) {
      counts[item.source_kind] += 1;
    }
  }
  return counts;
}

const SOURCE_KIND_LABELS = Object.freeze({ primary: '원문', dictionary: '사전', research: '연구' });

export function sourceKindLabel(kind) {
  return SOURCE_KIND_LABELS[kind] ?? '자료';
}

function byId(id) {
  return document.getElementById(id);
}

function makeNode(tag, className = '', text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function makeButton(text, className) {
  const button = makeNode('button', className, text);
  button.type = 'button';
  return button;
}

function itemSummary(item) {
  const locator = item?.locator && typeof item.locator === 'object' ? item.locator : {};
  const start = locator.line_start ?? locator.body_line_start ?? locator.passage_line_start ?? locator.unit_line_start;
  const end = locator.line_end ?? locator.body_line_end ?? locator.passage_line_end ?? locator.unit_line_end;
  const line = Number.isInteger(start) ? (start === end ? ` · L${start}` : ` · L${start}–L${end}`) : '';
  return {
    title: item?.title || '제목 없음',
    locator: `${item?.structure_path?.length ? `${item.structure_path.length}단계 구조` : '원문 근거'}${line}`,
  };
}

export function readDialogueSession(storage) {
  if (!storage) return null;
  let raw;
  try {
    raw = storage.getItem(DIALOGUE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema_version !== DIALOGUE_SESSION_SCHEMA_VERSION
      || typeof parsed.session_id !== 'string'
      || !Array.isArray(parsed.messages)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeDialogueSession(storage, session) {
  if (!storage) return;
  try {
    storage.setItem(DIALOGUE_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // sessionStorage full or unavailable: keep the in-memory copy alive.
  }
}

export function newDialogueSession() {
  return {
    schema_version: DIALOGUE_SESSION_SCHEMA_VERSION,
    session_id: newRequestId(),
    turn: 0,
    messages: [],
  };
}

export function mountStage3({ shelfStore, onNavigateCitation, storage }) {
  const refs = {
    shelfToggle: byId('evidence-shelf-toggle'),
    shelfMenu: byId('evidence-shelf-menu'),
    shelfList: byId('shelf-list'),
    shelfEmpty: byId('shelf-empty'),
    shelfTotal: byId('shelf-total'),
    shelfClear: byId('shelf-clear'),
    shelfChat: byId('shelf-chat'),
    dialogueToggle: byId('dialogue-toggle'),
    dialoguePanel: byId('dialogue-panel'),
    dialogueClose: byId('dialogue-close'),
    dialogueContextList: byId('dialogue-context-list'),
    dialogueMessages: byId('dialogue-messages'),
    dialogueQuestion: byId('dialogue-question'),
    dialogueSend: byId('dialogue-send'),
    dialogueNew: byId('dialogue-new'),
    dialogueLimit: byId('dialogue-limit'),
    dialogueStatus: byId('dialogue-status'),
    dialogueModel: byId('dialogue-model'),
    dialogueTransferContext: byId('dialogue-transfer-context'),
  };
  const sessionStorageLike = storage || (typeof window !== 'undefined' ? window.sessionStorage : null);
  let session = readDialogueSession(sessionStorageLike) || newDialogueSession();
  let panelOpen = false;
  let shelfOpen = false;
  let activeRequest = null;

  function persistSession() {
    writeDialogueSession(sessionStorageLike, session);
  }

  function setStatus(message, { error = false } = {}) {
    refs.dialogueStatus.textContent = message;
    refs.dialogueStatus.classList.toggle('error', error);
    refs.dialogueStatus.hidden = !message;
  }

  function refreshShelfUI() {
    const items = shelfStore.items;
    const count = items.length;
    refs.shelfToggle.textContent = `근거 선반 ${count}`;
    refs.shelfToggle.setAttribute('aria-label', `근거 선반, ${count}개 담김`);
    refs.shelfTotal.textContent = `${count}건`;
    refs.shelfList.replaceChildren();
    if (items.length === 0) {
      refs.shelfEmpty.hidden = false;
      refs.shelfList.hidden = true;
      refs.shelfClear.disabled = true;
      refs.shelfChat.disabled = true;
      return;
    }
    refs.shelfEmpty.hidden = true;
    refs.shelfList.hidden = false;
    refs.shelfClear.disabled = false;
    refs.shelfChat.disabled = false;
    for (const item of items) {
      const entry = makeNode('li', 'shelf-item');
      const summary = itemSummary(item);
      const kind = makeNode('span', `shelf-kind shelf-kind--${item.source_kind}`, sourceKindLabel(item.source_kind));
      const body = makeNode('div', 'shelf-item-copy');
      body.append(makeNode('strong', 'shelf-item-title', summary.title));
      body.append(makeNode('span', 'shelf-item-locator', summary.locator));
      const open = makeButton('열기', 'shelf-item-open');
      open.addEventListener('click', () => {
        const target = citationTargetForReference(item)
          || (item.reader_url && (citationTargetForCanon(item.reader_url) || citationTargetForResearch(item.reader_url)));
        if (target && onNavigateCitation) onNavigateCitation(target, item);
        closeShelfMenu();
      });
      const remove = makeButton('제거', 'shelf-item-remove');
      remove.setAttribute('aria-label', `${item.title} 선반에서 제거`);
      remove.addEventListener('click', () => {
        shelfStore.remove(evidenceKey(item));
        refreshShelfUI();
      });
      entry.append(kind, body, open, remove);
      refs.shelfList.append(entry);
    }
    if (panelOpen) renderContextStrip();
    if (panelOpen) updateComposer();
  }

  function renderContextStrip() {
    const allItems = shelfStore.items;
    const excluded = new Set(session.contextKeys || []);
    const activeItems = allItems.filter((item) => !excluded.has(evidenceKey(item)));
    const counts = countBySourceKind(activeItems);
    const parts = [];
    if (counts.primary) parts.push(`원문 ${counts.primary}`);
    if (counts.dictionary) parts.push(`사전 ${counts.dictionary}`);
    if (counts.research) parts.push(`연구 ${counts.research}`);
    refs.dialogueContextList.replaceChildren();
    if (allItems.length === 0) {
      const empty = makeNode('p', 'dialogue-context-empty', '먼저 원문·사전·연구서에서 근거를 선반에 담아주세요.');
      refs.dialogueContextList.append(empty);
      return;
    }
    const summary = makeNode(
      'p',
      'dialogue-context-summary',
      `대화 문맥 ${activeItems.length}/${allItems.length}건${parts.length ? ` · ${parts.join(' · ')}` : ''}`,
    );
    refs.dialogueContextList.append(summary);
    const list = makeNode('ul', 'dialogue-context-items');
    for (const item of allItems) {
      const li = makeNode('li');
      const hash = evidenceKey(item);
      const isExcluded = excluded.has(hash);
      if (isExcluded) li.classList.add('dialogue-context-item--excluded');
      const label = makeNode(
        'span',
        '',
        `${isExcluded ? '[제외] ' : ''}${sourceKindLabel(item.source_kind)} · ${item.title}`,
      );
      if (isExcluded) {
        const include = makeButton('다시 포함', 'dialogue-context-include');
        include.setAttribute('aria-label', `${item.title} 문맥에 다시 포함`);
        include.addEventListener('click', () => {
          const next = new Set(session.contextKeys || []);
          next.delete(hash);
          session.contextKeys = [...next];
          persistSession();
          renderContextStrip();
          updateComposer();
        });
        const removeShelf = makeButton('선반에서 제거', 'dialogue-context-shelf-remove');
        removeShelf.addEventListener('click', () => {
          shelfStore.remove(hash);
          const next = new Set(session.contextKeys || []);
          next.delete(hash);
          session.contextKeys = [...next];
          persistSession();
          refreshShelfUI();
          renderContextStrip();
          updateComposer();
        });
        li.append(label, include, removeShelf);
      } else {
        const remove = makeButton('문맥에서 제외', 'dialogue-context-remove');
        remove.setAttribute('aria-label', `${item.title} 문맥에서 제외`);
        remove.addEventListener('click', () => {
          const next = new Set(session.contextKeys || []);
          next.add(hash);
          session.contextKeys = [...next];
          persistSession();
          renderContextStrip();
          updateComposer();
        });
        const removeShelf = makeButton('선반에서 제거', 'dialogue-context-shelf-remove');
        removeShelf.setAttribute('aria-label', `${item.title} 선반에서 제거`);
        removeShelf.addEventListener('click', () => {
          shelfStore.remove(hash);
          const next = new Set(session.contextKeys || []);
          next.delete(hash);
          session.contextKeys = [...next];
          persistSession();
          refreshShelfUI();
          renderContextStrip();
          updateComposer();
        });
        li.append(label, remove, removeShelf);
      }
      list.append(li);
    }
    refs.dialogueContextList.append(list);
  }

  function renderMessages() {
    refs.dialogueMessages.replaceChildren();
    for (const message of session.messages) {
      refs.dialogueMessages.append(buildMessageNode(message));
    }
    refs.dialogueMessages.scrollTop = refs.dialogueMessages.scrollHeight;
  }

  function buildMessageNode(message) {
    if (message.role === 'error') {
      const node = makeNode('div', 'dialogue-msg dialogue-msg--error');
      node.setAttribute('role', 'alert');
      node.textContent = message.text;
      return node;
    }
    const node = makeNode('div', `dialogue-msg dialogue-msg--${message.role}`);
    if (message.role === 'user') {
      node.append(makeNode('p', 'dialogue-msg-text', message.text));
      return node;
    }
    const body = makeNode('div', 'dialogue-msg-body');
    body.append(makeNode('p', 'dialogue-msg-text', message.text));
    if (Array.isArray(message.citations) && message.citations.length > 0) {
      const cards = makeNode('ul', 'dialogue-citations');
      for (const citation of message.citations) {
        const card = makeNode('li', 'dialogue-citation');
        const id = makeNode('span', 'dialogue-citation-id', `[${citation.citation_id}]`);
        const copy = makeNode('span', 'dialogue-citation-copy', citation.claim_excerpt || '근거 인용');
        const target = (citation.reader_url && (citationTargetForCanon(citation.reader_url) || citationTargetForResearch(citation.reader_url)))
          || citationTargetForReference(citation);
        const open = makeButton('열기', 'dialogue-citation-open');
        if (target && onNavigateCitation) {
          open.addEventListener('click', () => {
            onNavigateCitation(target, citation);
          });
        } else {
          open.disabled = true;
          open.setAttribute('aria-disabled', 'true');
        }
        card.append(id, copy, open);
        cards.append(card);
      }
      body.append(cards);
    }
    node.append(body);
    return node;
  }

  function appendMessage(message) {
    session.messages.push(message);
    persistSession();
    refs.dialogueMessages.append(buildMessageNode(message));
    refs.dialogueMessages.scrollTop = refs.dialogueMessages.scrollHeight;
  }

  function updateComposer() {
    const question = refs.dialogueQuestion.value;
    const length = codePointLength(question.trim());
    const emptyShelf = shelfStore.size === 0;
    const emptyContext = contextItems().length === 0;
    const overLimit = length > MAX_QUESTION_CODE_POINTS;
    refs.dialogueLimit.textContent = length > 0
      ? `${length.toLocaleString('ko-KR')} / ${MAX_QUESTION_CODE_POINTS.toLocaleString('ko-KR')}자`
      : '';
    if (activeRequest) {
      // Keep enabled so the user can abort a long local generation.
      refs.dialogueSend.disabled = false;
      refs.dialogueSend.textContent = '중단';
      return;
    }
    if (refs.dialogueTransferContext) refs.dialogueTransferContext.disabled = emptyContext;
    refs.dialogueSend.disabled = emptyShelf || emptyContext || length === 0 || overLimit;
    refs.dialogueSend.textContent = '전송';
  }

  function openPanel() {
    panelOpen = true;
    refs.dialoguePanel.hidden = false;
    refs.dialogueToggle.setAttribute('aria-expanded', 'true');
    refs.dialogueToggle.classList.add('active');
    refs.shelfMenu.hidden = true;
    refs.shelfToggle.setAttribute('aria-expanded', 'false');
    renderContextStrip();
    renderMessages();
    updateComposer();
    refs.dialogueQuestion.focus({ preventScroll: true });
  }

  function closePanel() {
    panelOpen = false;
    refs.dialoguePanel.hidden = true;
    refs.dialogueToggle.setAttribute('aria-expanded', 'false');
    refs.dialogueToggle.classList.remove('active');
    refs.dialogueToggle.focus({ preventScroll: true });
  }

  function openShelfMenu() {
    shelfOpen = true;
    refs.shelfMenu.hidden = false;
    refs.shelfToggle.setAttribute('aria-expanded', 'true');
    refreshShelfUI();
  }

  function closeShelfMenu() {
    shelfOpen = false;
    refs.shelfMenu.hidden = true;
    refs.shelfToggle.setAttribute('aria-expanded', 'false');
  }

  function contextItems() {
    const excluded = new Set(session.contextKeys || []);
    return shelfStore.items.filter((item) => !excluded.has(evidenceKey(item)));
  }

  async function send() {
    if (activeRequest) {
      activeRequest.controller.abort();
      return;
    }
    const question = refs.dialogueQuestion.value.trim();
    const evidence = contextItems();
    if (shelfStore.size === 0 || question.length === 0 || evidence.length === 0) {
      setStatus('먼저 원문·사전·연구서에서 근거를 선반에 담아주세요.', { error: true });
      return;
    }
    if (codePointLength(question) > MAX_QUESTION_CODE_POINTS) {
      setStatus('질문이 너무 깁니다. 분량을 줄여 주세요.', { error: true });
      return;
    }
    session.turn += 1;
    const turnId = String(session.turn);
    let request;
    try {
      request = buildDialogueRequest({
        sessionId: session.session_id,
        turnId,
        question,
        evidence,
        model: refs.dialogueModel?.value || 'qwen3.6:35b',
      });
    } catch (error) {
      setStatus(error.message, { error: true });
      return;
    }
    const controller = new AbortController();
    activeRequest = { controller, request };
    const snapshotKeys = evidence.map((item) => evidenceKey(item));
    appendMessage({ role: 'user', text: question });
    refs.dialogueQuestion.value = '';
    updateComposer();
    const startedAt = Date.now();
    let phase = 0;
    const phaseText = () => {
      const sec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      if (phase === 0) return `선택 근거 ${evidence.length}건 재검증 중… (${sec}초)`;
      if (phase === 1) return `Local LLM 답변 생성 중… (${sec}초 경과, 중단 버튼 사용 가능)`;
      return `답변을 정리하는 중… (${sec}초)`;
    };
    setStatus(phaseText());
    const progressTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > 2500) phase = Math.max(phase, 1);
      if (elapsed > 45000) phase = Math.max(phase, 2);
      setStatus(phaseText());
    }, 1000);
    try {
      const response = await fetch(buildChatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const stale = activeRequest?.request.request_id !== request.request_id
        || session.session_id !== request.session_id;
      if (stale || activeRequest?.request.turn_id !== request.turn_id) return;
      if (!response.ok || body?.status === 'error') {
        const parsed = parseDialogueError(body);
        session.messages.push({
          role: 'error',
          text: parsed.message,
          code: parsed.code,
        });
        persistSession();
        renderMessages();
        setStatus('');
        return;
      }
      const parsed = parseDialogueResponse(body, {
        request_id: request.request_id,
        session_id: request.session_id,
        turn_id: request.turn_id,
      });
      if (!parsed.ok) {
        session.messages.push({
          role: 'error',
          text: '답변 형식을 확인할 수 없어 표시하지 못했습니다.',
          code: parsed.error.code,
        });
        persistSession();
        renderMessages();
        setStatus('');
        return;
      }
      session.messages.push({
        role: 'assistant',
        text: parsed.value.answer,
        citations: parsed.value.citations,
        grounding: parsed.value.grounding,
        model: parsed.value.model,
        evidenceKeys: snapshotKeys,
      });
      persistSession();
      renderMessages();
      setStatus('');
    } catch (error) {
      if (error?.name === 'AbortError') {
        session.messages.push({ role: 'error', text: '답변 생성을 중단했습니다.', code: 'cancelled' });
        persistSession();
        renderMessages();
        setStatus('');
        return;
      }
      session.messages.push({ role: 'error', text: '연구 대화 기능을 일시적으로 사용할 수 없습니다.', code: 'request_failed' });
      persistSession();
      renderMessages();
      setStatus('');
    } finally {
      clearInterval(progressTimer);
      if (activeRequest?.request.request_id === request.request_id) {
        activeRequest = null;
      }
      updateComposer();
    }
  }

  function newChat() {
    session = newDialogueSession();
    persistSession();
    renderContextStrip();
    renderMessages();
    setStatus('');
    refs.dialogueQuestion.value = '';
    updateComposer();
    refs.dialogueQuestion.focus({ preventScroll: true });
  }

  function transferCurrentContext() {
    const evidence = contextItems();
    if (evidence.length === 0) {
      setStatus('전달할 선택 근거가 없습니다.', { error: true });
      return;
    }
    const question = refs.dialogueQuestion.value.trim();
    window.dispatchEvent(new CustomEvent('daocanon:dialogue-context-transfer', {
      detail: { evidence, question },
    }));
    setStatus(`대화 문맥 ${evidence.length}건을 다음 작업대로 전달했습니다.`);
  }

  refs.shelfToggle.addEventListener('click', () => {
    if (shelfOpen) closeShelfMenu();
    else openShelfMenu();
  });

  refs.shelfClear.addEventListener('click', () => {
    shelfStore.clear();
    refreshShelfUI();
  });

  refs.shelfChat.addEventListener('click', () => {
    closeShelfMenu();
    openPanel();
  });

  refs.dialogueToggle.addEventListener('click', () => {
    if (panelOpen) closePanel();
    else openPanel();
  });

  refs.dialogueClose.addEventListener('click', () => closePanel());

  refs.dialogueSend.addEventListener('click', send);

  if (refs.dialogueTransferContext) {
    refs.dialogueTransferContext.addEventListener('click', transferCurrentContext);
  }

  refs.dialogueNew.addEventListener('click', newChat);

  refs.dialogueQuestion.addEventListener('input', () => {
    if (refs.dialogueStatus.classList.contains('error')) {
      setStatus('');
    }
    updateComposer();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (shelfOpen) closeShelfMenu();
      else if (panelOpen && document.activeElement !== refs.dialogueQuestion) closePanel();
    }
  });

  document.addEventListener('click', (event) => {
    if (shelfOpen && !refs.shelfMenu.contains(event.target) && !refs.shelfToggle.contains(event.target)) {
      closeShelfMenu();
    }
  });

  refreshShelfUI();

  return {
    refresh: refreshShelfUI,
    openPanel,
    closePanel,
    addEvidence(evidence) {
      const clipped = Boolean(evidence && evidence._clipped);
      const payload = evidence && typeof evidence === 'object' ? { ...evidence } : evidence;
      if (payload && Object.prototype.hasOwnProperty.call(payload, '_clipped')) {
        delete payload._clipped;
      }
      const result = shelfStore.add(payload);
      refreshShelfUI();
      return { ...result, clipped };
    },
    addEvidenceAndAsk(evidence) {
      const clipped = Boolean(evidence && evidence._clipped);
      const payload = evidence && typeof evidence === 'object' ? { ...evidence } : evidence;
      if (payload && Object.prototype.hasOwnProperty.call(payload, '_clipped')) {
        delete payload._clipped;
      }
      const result = shelfStore.add(payload);
      refreshShelfUI();
      if (result?.ok) openPanel();
      return { ...result, clipped };
    },
    sessionStore: sessionStorageLike,
    refs,
  };
}
