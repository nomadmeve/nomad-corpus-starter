// Stage B (확장 대화) — additive right-panel extended conversation.
//
// The backend is not final, so this module accepts an injected AgentClient
// (contract: health, createConversation, getConversation, startTurn,
// abortTurn, previewArtifact, saveArtifact, listArtifacts, attachArtifact).
// The only hard-coded live path is the single exported default base
// `/api/agent/v1`; a default client is created only when none is injected.
//
// Stage 3A (연구 대화) is never modified. The extended tab is health-gated:
// when unavailable it is disabled and the default 연구 대화 tab stays active.
// Answers are rendered only when backed by verified citations; the ledger is
// sanitized so chain-of-thought, credentials, and absolute host paths never
// reach the DOM.

import {
  formatElapsedMs,
  isVerifiedCitation,
  planTabActivation,
  sanitizeLedger,
  sourceLabel,
  statusLabel,
  toolLabel,
  partialFailureSummary,
  verifiedCitationsOnly,
  newConversationState,
} from './stageb-render.js';
import { createTabController } from './stageb-controls.js';
import { toEvidenceReference } from './evidence.js';

export const AGENT_BASE_DEFAULT = '/api/agent/v1';
export const STAGEB_STORAGE_KEY = 'daocanon:stageb-session';

export function readStageBSession(storage) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  try {
    const value = JSON.parse(storage.getItem(STAGEB_STORAGE_KEY) || 'null');
    if (!value || typeof value !== 'object' || typeof value.conversationId !== 'string') return null;
    const history = Array.isArray(value.history) ? value.history.filter((message) => (
      message && (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string'
    )) : [];
    return { conversationId: value.conversationId, history };
  } catch {
    return null;
  }
}

export function writeStageBSession(storage, state) {
  if (!storage || typeof storage.setItem !== 'function' || !state?.conversationId) return;
  try {
    storage.setItem(STAGEB_STORAGE_KEY, JSON.stringify({
      conversationId: state.conversationId,
      history: Array.isArray(state.history) ? state.history : [],
    }));
  } catch {
    // Storage is an optional refresh continuity layer.
  }
}

export function modelOptionsFromCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.models)) return [];
  return catalog.models.map((model) => {
    const unavailable = model.available === false;
    const reason = unavailable && model.availability_reason
      ? ` (${model.availability_reason})`
      : '';
    return {
      value: model.id,
      label: unavailable
        ? `${model.description || model.label || model.id} — 일시적 사용 불가${reason}`
        : (model.description || model.label || model.id),
      disabled: unavailable,
    };
  });
}

export function createConversationPayload({ modelId, reasoningEffort } = {}) {
  const payload = { title: '확장 대화' };
  if (modelId) payload.model_id = modelId;
  if (reasoningEffort) payload.reasoning_effort = reasoningEffort;
  return payload;
}

export function projectRetrievedSource(source) {
  if (!source || typeof source !== 'object') return null;
  try {
    return toEvidenceReference(source);
  } catch {
    return null;
  }
}

async function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createAgentClient({ base = AGENT_BASE_DEFAULT, fetchImpl = globalThis.fetch } = {}) {
  // Normalize: strip trailing slash so base + '/health' never produces '//health'
  const normalizedBase = String(base).replace(/\/+$/, '');
  async function request(path, { method = 'GET', body, signal, unwrap = true } = {}) {
    const init = { method, signal };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(`${normalizedBase}${path}`, init);
    const data = await parseJsonSafe(await res.text());
    if (!res.ok) {
      const error = new Error(data?.error?.message || `agent request failed (${res.status})`);
      error.code = data?.error?.code || 'agent_error';
      error.status = res.status;
      throw error;
    }
    return unwrap ? (data?.data ?? data) : data;
  }

  return {
    base,
    async health(signal) {
      const data = await request('/health', { signal, unwrap: false });
      return { ok: data?.status === 'ok' || data?.status === 'degraded' || data?.ok === true, data };
    },
    async getModelCatalog(signal) {
      return request('/models', { signal });
    },
    async createConversation(body = {}, signal) {
      const data = await request('/conversations', { method: 'POST', body, signal });
      return data || {};
    },
    async getConversation(conversationId, signal) {
      return request(`/conversations/${encodeURIComponent(conversationId)}`, { signal });
    },
    async startTurn({ conversationId, question, retrievedSources, evidenceReferences, signal } = {}) {
      const body = { question: question ?? '' };
      const rawSources = evidenceReferences || retrievedSources;
      if (Array.isArray(rawSources) && rawSources.length > 0) {
        body.evidence_references = rawSources.map(projectRetrievedSource).filter(Boolean);
      }
      const data = await request(
        `/conversations/${encodeURIComponent(conversationId)}/turns`,
        { method: 'POST', body, signal },
      );
      return data || {};
    },
    async abortTurn(conversationId, turnId, signal) {
      return request(
        `/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}/abort`,
        { method: 'POST', body: {}, signal },
      );
    },
    async previewArtifact(body = {}, signal) {
      return request('/artifacts/preview', { method: 'POST', body, signal });
    },
    async saveArtifact(body = {}, signal) {
      return request('/artifacts', { method: 'POST', body, signal });
    },
    async listArtifacts(signal) {
      return request('/artifacts', { signal });
    },
    async attachArtifact({ conversationId, artifactId, signal } = {}) {
      return request(
        `/conversations/${encodeURIComponent(conversationId)}/attachments`,
        { method: 'POST', body: { artifact_id: artifactId }, signal },
      );
    },
  };
}

function makeNode(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeButton(text, className) {
  const button = makeNode('button', className, text);
  button.type = 'button';
  return button;
}

function byId(id) {
  return document.getElementById(id);
}

export function mountStageB({ client, onOpenReader, storage } = {}) {
  const agentClient = client || createAgentClient({ base: AGENT_BASE_DEFAULT });

  const refs = {
    tabs: {
      '3a': byId('dialogue-tab-3a'),
      b: byId('dialogue-tab-b'),
    },
    panels: {
      '3a': byId('dialogue-panel-3a'),
      b: byId('dialogue-panel-b'),
    },
    inputs: {
      '3a': byId('dialogue-question'),
      b: byId('stageb-question'),
    },
    health: byId('stageb-health'),
    unavailable: byId('stageb-unavailable'),
    status: byId('stageb-status'),
    sources: byId('stageb-sources'),
    ledger: byId('stageb-ledger'),
    answer: byId('stageb-answer'),
    artifacts: byId('stageb-artifacts'),
    preview: byId('stageb-preview'),
    send: byId('stageb-send'),
    new: byId('stageb-new'),
    attach: byId('stageb-attach'),
    question: byId('stageb-question'),
    model: byId('stageb-model'),
  };

  const tabController = createTabController({
    refs,
    defaultTab: '3a',
    onActivate(tab) {
      if (tab === 'b') {
        refs.send.disabled = refs.question.value.trim().length === 0;
        refs.question.addEventListener('input', updateComposer);
      }
    },
  });

  const sessionStorageLike = storage || (typeof window !== 'undefined' ? window.sessionStorage : null);
  const restored = readStageBSession(sessionStorageLike);
  let state = { ...newConversationState(), ...(restored || {}) };
  let turnController = null;
  let modelCatalog = null;

  function renderModelSelect() {
    if (!refs.model) return;
    const options = modelOptionsFromCatalog(modelCatalog);
    refs.model.replaceChildren();
    if (options.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '사용 가능한 모델이 없습니다.';
      refs.model.append(option);
      refs.model.disabled = true;
      return;
    }
    for (const item of options) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      option.disabled = item.disabled;
      option.selected = item.value === modelCatalog.default_model_id;
      refs.model.append(option);
    }
    refs.model.disabled = false;
  }

  async function loadModelCatalog() {
    try {
      modelCatalog = await agentClient.getModelCatalog();
    } catch {
      modelCatalog = null;
    }
    renderModelSelect();
  }

  function updateComposer() {
    const hasQuestion = refs.question.value.trim().length > 0;
    const available = !refs.tabs.b.disabled;
    if (state.running) {
      refs.send.disabled = false;
      refs.send.textContent = '중단';
      return;
    }
    refs.send.disabled = !available || !hasQuestion;
    refs.send.textContent = '요청';
  }

  function setStatus(message, { error = false } = {}) {
    refs.status.textContent = message || '';
    refs.status.classList.toggle('stageb-status--error', error);
    refs.status.hidden = !message;
  }

  function renderLedger() {
    refs.ledger.replaceChildren();
    if (!Array.isArray(state.ledger) || state.ledger.length === 0) {
      refs.ledger.append(makeNode('p', 'stageb-ledger-empty', '아직 작업 기록이 없습니다.'));
      return;
    }
    const list = makeNode('ul', 'stageb-ledger-list');
    for (const entry of state.ledger) {
      const li = makeNode('li', `stageb-ledger-entry stageb-ledger-entry--${entry.status || 'unknown'}`);
      const type = makeNode('span', 'stageb-ledger-type', entry.type || '');
      const status = makeNode('span', 'stageb-ledger-status', statusLabel(entry.status));
      const tool = entry.tool ? makeNode('span', 'stageb-ledger-tool', toolLabel(entry.tool)) : null;
      const source = entry.source ? makeNode('span', 'stageb-ledger-source', sourceLabel(entry.source)) : null;
      const elapsed = formatElapsedMs(entry.elapsed_ms);
      const time = elapsed ? makeNode('span', 'stageb-ledger-elapsed', elapsed) : null;
      li.append(type, status, tool, source, time);
      if (entry.error && typeof entry.error === 'object') {
        const errText = entry.error.code || 'error';
        const errMsg = entry.error.message ? `: ${entry.error.message}` : '';
        li.append(makeNode('span', 'stageb-ledger-error', `${errText}${errMsg}`));
      }
      list.append(li);
    }
    refs.ledger.append(list);
    const partial = partialFailureSummary(state.ledger);
    if (partial) {
      refs.ledger.append(makeNode('p', 'stageb-ledger-partial', partial));
    }
  }

  function renderAnswer() {
    refs.answer.replaceChildren();
    if (state.history.length > 0) {
      for (const message of state.history) {
        const card = makeNode('div', `stageb-answer-card stageb-answer-card--${message.role}`);
        card.append(makeNode('p', 'stageb-answer-text', message.text));
        refs.answer.append(card);
      }
      return;
    }
    if (!state.answer) {
      if (state.citations.length === 0 && (state.status === 'completed' || state.status === 'partial')) {
        refs.answer.append(makeNode('p', 'stageb-answer-empty', '검증된 인용이 없어 답변을 표시하지 않습니다.'));
      }
      return;
    }
    const card = makeNode('div', 'stageb-answer-card');
    card.append(makeNode('p', 'stageb-answer-text', state.answer));
    if (state.citations.length > 0) {
      const list = makeNode('ul', 'stageb-answer-citations');
      for (const citation of state.citations) {
        const li = makeNode('li', 'stageb-answer-citation');
        const text = citation.text || citation.snippet || '(인용)';
        li.append(makeNode('span', 'stageb-answer-citation-text', text));
        const open = makeButton('열기', 'stageb-answer-citation-open');
        if (onOpenReader) {
          open.addEventListener('click', () => onOpenReader(citation.locator));
        } else {
          open.disabled = true;
          open.setAttribute('aria-disabled', 'true');
        }
        li.append(open);
        list.append(li);
      }
      card.append(list);
    }
    refs.answer.append(card);
  }

  function renderRetrievedSources() {
    if (!refs.sources) return;
    refs.sources.replaceChildren();
    if (!Array.isArray(state.retrievedSources) || state.retrievedSources.length === 0) return;
    refs.sources.append(makeNode('p', 'stageb-sources-heading', `전달 근거 ${state.retrievedSources.length}건`));
    const list = makeNode('ul', 'stageb-sources-list');
    for (const source of state.retrievedSources) {
      const item = makeNode('li', 'stageb-source');
      const locator = source.locator || {};
      const start = locator.target_line ?? locator.line_start ?? locator.body_line_start;
      const end = locator.line_end ?? locator.body_line_end;
      const range = Number.isInteger(start) ? `L${start}${Number.isInteger(end) && end !== start ? `–L${end}` : ''}` : '원문 위치 참조';
      const title = typeof source.title === 'string' ? source.title : '제목 없는 근거';
      item.append(makeNode('span', 'stageb-source-title', `${title} · ${range}`));
      const open = makeButton('원문 열기', 'secondary-button stageb-source-open');
      if (onOpenReader) open.addEventListener('click', () => onOpenReader(source));
      else open.disabled = true;
      item.append(open);
      list.append(item);
    }
    refs.sources.append(list);
  }

  function renderRetry() {
    if (state.status === 'failed' || state.status === 'cancelled') {
      const row = makeNode('div', 'stageb-retry-row');
      const retry = makeButton('다시 시도', 'secondary-button stageb-retry');
      retry.disabled = refs.tabs.b.disabled;
      retry.addEventListener('click', send);
      row.append(retry);
      refs.answer.append(row);
    }
  }

  function renderArtifacts() {
    refs.artifacts.replaceChildren();
    const list = Array.isArray(state.availableArtifacts) ? state.availableArtifacts : [];
    if (list.length === 0) {
      refs.artifacts.append(makeNode('p', 'stageb-artifacts-empty', '첨부할 산출물이 없습니다.'));
      return;
    }
    const ul = makeNode('ul', 'stageb-artifacts-list');
    for (const artifact of list) {
      const id = artifact.artifactId || artifact.artifact_id || artifact.id;
      const name = artifact.name || artifact.title || id || '(산출물)';
      const li = makeNode('li', 'stageb-artifact');
      li.append(makeNode('span', 'stageb-artifact-name', typeof name === 'string' ? name : '(산출물)'));
      const preview = makeButton('미리보기', 'secondary-button stageb-artifact-preview');
      preview.disabled = refs.tabs.b.disabled;
      preview.addEventListener('click', () => previewArtifact(id));
      const attach = makeButton('첨부', 'secondary-button stageb-artifact-attach');
      attach.disabled = refs.tabs.b.disabled || state.attached.includes(id);
      attach.addEventListener('click', () => attachArtifact(id));
      li.append(preview, attach);
      ul.append(li);
    }
    refs.artifacts.append(ul);
    if (state.attached.length > 0) {
      refs.artifacts.append(makeNode('p', 'stageb-attached-note', `첨부 산출물 ${state.attached.length}건`));
    }
  }

  function renderPreview() {
    refs.preview.replaceChildren();
    if (!state.preview) {
      refs.preview.hidden = true;
      refs.preview.textContent = '';
      return;
    }
    refs.preview.hidden = false;
    const card = makeNode('div', 'stageb-preview-card');
    card.append(makeNode('p', 'stageb-preview-label', '산출물 미리보기'));
    const content = state.preview.content ?? state.preview.preview ?? state.preview.text ?? '';
    card.append(makeNode('pre', 'stageb-preview-content', typeof content === 'string' ? content : JSON.stringify(content)));
    const save = makeButton('저장', 'primary-button stageb-preview-save');
    save.disabled = refs.tabs.b.disabled;
    save.addEventListener('click', () => saveArtifact(state.preview.artifactId));
    card.append(save);
    refs.preview.append(card);
  }

  function renderStageB() {
    renderRetrievedSources();
    renderLedger();
    refs.answer.replaceChildren();
    renderAnswer();
    renderRetry();
    renderArtifacts();
    renderPreview();
    updateComposer();
  }

  async function loadArtifacts() {
    setStatus('산출물 목록을 불러오는 중…');
    try {
      const data = await agentClient.listArtifacts();
      state.availableArtifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
      setStatus('');
    } catch {
      state.availableArtifacts = [];
      setStatus('산출물 목록을 불러오지 못했습니다.', { error: true });
    }
    renderStageB();
  }

  async function previewArtifact(artifactId) {
    if (!artifactId) return;
    setStatus('산출물을 미리보기로 생성하는 중…');
    try {
      const data = await agentClient.previewArtifact({ artifact_id: artifactId });
      const preview = data?.artifact || data?.preview || data || {};
      state.preview = {
        artifactId,
        content: preview.content ?? preview.preview ?? preview.text ?? '',
      };
      setStatus('미리보기 준비 완료. 저장하려면 저장 버튼을 누르세요.');
    } catch {
      state.preview = null;
      setStatus('산출물 미리보기를 생성하지 못했습니다.', { error: true });
    }
    renderStageB();
  }

  async function saveArtifact(artifactId) {
    if (!state.preview) return;
    setStatus('산출물을 저장하는 중…');
    try {
      const data = await agentClient.saveArtifact({
        artifact_id: artifactId,
        content: state.preview.content,
      });
      const saved = data?.artifact || {};
      state.preview = null;
      setStatus('산출물을 저장했습니다.');
      // Refresh the available list so the saved artifact becomes attachable.
      const listData = await agentClient.listArtifacts();
      state.availableArtifacts = Array.isArray(listData?.artifacts) ? listData.artifacts : [];
    } catch {
      setStatus('산출물을 저장하지 못했습니다.', { error: true });
    }
    renderStageB();
  }

  async function attachArtifact(artifactId) {
    if (!artifactId || !state.conversationId) {
      setStatus('먼저 대화를 시작한 뒤 산출물을 첨부해 주세요.', { error: true });
      return;
    }
    try {
      await agentClient.attachArtifact({ conversationId: state.conversationId, artifactId });
      if (!state.attached.includes(artifactId)) state.attached.push(artifactId);
      setStatus('산출물을 첨부했습니다.');
    } catch {
      setStatus('산출물을 첨부하지 못했습니다.', { error: true });
    }
    renderStageB();
  }

  async function ensureConversation() {
    if (state.conversationId) return true;
    try {
      const data = await agentClient.createConversation(createConversationPayload({
        modelId: refs.model?.value || modelCatalog?.default_model_id,
        reasoningEffort: 'medium',
      }));
      state.conversationId = data.conversationId || data.conversation_id || null;
      writeStageBSession(sessionStorageLike, state);
      return Boolean(state.conversationId);
    } catch {
      state.conversationId = null;
      return false;
    }
  }

  async function send() {
    if (state.running) {
      if (turnController && state.turnId) {
        try {
          await agentClient.abortTurn(state.conversationId, state.turnId);
        } catch {
          // best effort; the local controller still resolves/cancels below
        }
      }
      if (turnController) turnController.abort();
      return;
    }
    const question = refs.question.value.trim();
    if (question.length === 0) {
      setStatus('질문을 입력해 주세요.', { error: true });
      return;
    }
    if (refs.tabs.b.disabled) {
      setStatus('확장 대화를 사용할 수 없습니다.', { error: true });
      return;
    }
    if (!(await ensureConversation())) {
      state.status = 'failed';
      state.error = '대화를 시작하지 못했습니다.';
      setStatus(state.error, { error: true });
      renderStageB();
      return;
    }
    state.answer = null;
    state.citations = [];
    state.ledger = [];
    state.error = null;
    state.history.push({ role: 'user', text: question });
    state.running = true;
    state.status = 'running';
    turnController = new AbortController();
    const agentStartedAt = Date.now();
    const agentPhaseText = () => {
      const sec = Math.max(1, Math.round((Date.now() - agentStartedAt) / 1000));
      return `AI가 답변 생성 중… (${sec}초 경과, 중단 버튼 사용 가능)`;
    };
    setStatus(agentPhaseText());
    const agentProgressTimer = setInterval(() => setStatus(agentPhaseText()), 1000);
    renderStageB();
    try {
      const data = await agentClient.startTurn({
        conversationId: state.conversationId,
        question,
        retrievedSources: state.retrievedSources,
        signal: turnController.signal,
      });
      const turnId = data.turn_timestamp || data.turn_id || data.turnId || null;
      const verified = verifiedCitationsOnly(data.citations || []);
      state.turnId = turnId;
      state.ledger = sanitizeLedger(data.ledger || []);
      state.status = data.status === 'completed' || data.status === 'partial' ? data.status : 'failed';
      state.citations = verified;
      state.answer = (state.status === 'completed' || state.status === 'partial')
        ? (typeof data.answer === 'string' && data.answer.trim().length > 0 ? data.answer : null)
        : null;
      state.running = false;
      if (state.answer) state.history.push({ role: 'assistant', text: state.answer, citations: state.citations });
      writeStageBSession(sessionStorageLike, state);
      if (state.answer) setStatus('');
      else if (state.status === 'partial') setStatus('일부 작업이 실패했습니다. 검증된 인용만 표시합니다.');
      else setStatus('답변을 완성하지 못했습니다.', { error: true });
    } catch (error) {
      state.running = false;
      if (error?.name === 'AbortError') {
        state.status = 'cancelled';
        state.answer = null;
        state.citations = [];
        setStatus('확장 대화를 중단했습니다.');
      } else {
        state.status = 'failed';
        state.answer = null;
        state.citations = [];
        setStatus('확장 대화를 진행하지 못했습니다.', { error: true });
      }
    } finally {
      clearInterval(agentProgressTimer);
      turnController = null;
      renderStageB();
    }
  }

  async function newConversation() {
    if (state.running && turnController) turnController.abort();
    state = newConversationState();
    try {
      const data = await agentClient.createConversation(createConversationPayload({
        modelId: refs.model?.value || modelCatalog?.default_model_id,
        reasoningEffort: 'medium',
      }));
      state.conversationId = data.conversationId || data.conversation_id || null;
      writeStageBSession(sessionStorageLike, state);
      setStatus('새 확장 대화를 시작했습니다.');
    } catch {
      setStatus('새 대화를 시작하지 못했습니다.', { error: true });
    }
    renderStageB();
    try {
      refs.question.focus({ preventScroll: true });
    } catch {
      refs.question.focus();
    }
  }

  async function checkHealth() {
    let ok = false;
    try {
      const health = await agentClient.health();
      ok = health?.ok === true;
    } catch {
      ok = false;
    }
    tabController.setAvailability(ok);
    if (refs.health) {
      refs.health.textContent = ok ? '확장 대화 사용 가능' : '확장 대화 서비스 불가';
      refs.health.classList.toggle('stageb-health--ok', ok);
      refs.health.classList.toggle('stageb-health--bad', !ok);
    }
    if (refs.unavailable) refs.unavailable.hidden = ok;
    updateComposer();
    return ok;
  }

  // Real tab buttons + keyboard roving.
  for (const key of tabController.TAB_KEYS) {
    const btn = refs.tabs[key];
    if (!btn) continue;
    btn.addEventListener('click', () => {
      tabController.activate(key);
    });
    btn.addEventListener('keydown', (event) => {
      const handled = tabController.handleKeydown(event, event.key);
      if (handled) event.preventDefault();
    });
  }

  if (refs.send) refs.send.addEventListener('click', send);
  if (refs.new) refs.new.addEventListener('click', newConversation);
  if (refs.attach) refs.attach.addEventListener('click', loadArtifacts);
  if (refs.question) refs.question.addEventListener('input', updateComposer);

  // Observe the shared dialogue panel so focus returns to the active tab's
  // composer when the panel reopens.
  const panel = byId('dialogue-panel');
  if (panel && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver(() => {
      if (!panel.hidden) {
        const input = tabController.activeTab === 'b' ? refs.inputs.b : refs.inputs['3a'];
        if (input && document.activeElement !== input) {
          try {
            input.focus({ preventScroll: true });
          } catch {
            input.focus();
          }
        }
      }
    });
    observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  }

  checkHealth().then((ok) => (ok ? loadModelCatalog() : null));
  renderStageB();

  return {
    checkHealth,
    plan: () => planTabActivation({
      healthOk: !refs.tabs.b.disabled,
      selectedTab: tabController.activeTab,
    }),
    addRetrievedSource(source) {
      if (!source || typeof source !== 'object') return false;
      state.retrievedSources = [...state.retrievedSources, source];
      tabController.activate('b');
      setStatus(`확장 대화 근거 ${state.retrievedSources.length}건을 준비했습니다.`);
      renderStageB();
      return true;
    },
    replaceRetrievedSources(sources, question = '') {
      if (!Array.isArray(sources) || sources.length === 0) return false;
      state.retrievedSources = [...sources];
      if (typeof question === 'string' && question.trim().length > 0 && refs.question.value.trim().length === 0) {
        refs.question.value = question.trim();
      }
      tabController.activate('b');
      setStatus(`전달된 대화 문맥 근거 ${state.retrievedSources.length}건을 준비했습니다.`);
      renderStageB();
      return true;
    },
    getConversationState: () => ({
      ...state,
      attached: [...state.attached],
      retrievedSources: [...state.retrievedSources],
    }),
    isVerifiedCitation,
  };
}