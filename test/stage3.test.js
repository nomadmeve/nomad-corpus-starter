import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fromCanonHit, validateEvidence } from '../src/web/evidence.js';
import {
  DIALOGUE_STORAGE_KEY,
  DIALOGUE_REQUEST_SCHEMA_VERSION,
  DIALOGUE_RESPONSE_SCHEMA_VERSION,
  DIALOGUE_ERROR_SCHEMA_VERSION,
  DIALOGUE_SESSION_SCHEMA_VERSION,
  buildDialogueRequest,
  parseDialogueResponse,
  parseDialogueError,
  citationTargetForCanon,
  citationTargetForResearch,
  citationTargetForReference,
  countBySourceKind,
  codePointLength,
  buildChatUrl,
} from '../src/web/stage3.js';

const DC1 = 'dc1_' + 'a'.repeat(64);
const ENT = 'ent' + 'b'.repeat(32);
const SEC = 'sec' + 'c'.repeat(32);

function evidenceFixture(overrides = {}) {
  const hit = {
    surface: 'canon',
    source_id: 'daocanon',
    work_id: DC1,
    title: '黄庭内景经',
    author: '佚名',
    match_type: 'fulltext',
    locator: { kind: 'physical-lines', relative_path: '道藏/黄庭内景经.md', line_start: 12, line_end: 14 },
    snippet: '上有魂灵',
    match_text: '魂灵',
    reader_url: `/api/daocanon/v1/works/${DC1}?line=12`,
  };
  return Object.assign(fromCanonHit(hit), overrides);
}

describe('stage3 request builder — bounded dialogue.request.v0.1', () => {
  it('builds a valid request envelope for a bounded shelf snapshot', () => {
    const request = buildDialogueRequest({
      sessionId: 'sess-1',
      turnId: 'turn-1',
      question: '이 세 근거만 놓고 비교해줘',
      evidence: [evidenceFixture()],
    });
    assert.equal(request.schema_version, DIALOGUE_REQUEST_SCHEMA_VERSION);
    assert.equal(request.mode, 'selected_evidence');
    assert.equal(request.locale, 'ko-KR');
    assert.equal(request.session_id, 'sess-1');
    assert.equal(request.turn_id, 'turn-1');
    assert.ok(request.request_id.length > 0);
    assert.equal(request.question, '이 세 근거만 놓고 비교해줘');
    assert.equal(request.evidence.length, 1);
  });

  it('projects raw evidence.v0.1 into a reference-only local dialogue request', () => {
    const raw = evidenceFixture({
      selected_text: 'SENTINEL_SELECTED_BODY',
      reader_url: `/api/daocanon/v1/works/${DC1}?sentinel=reader-url`,
      locator: { kind: 'physical-lines', relative_path: '道藏/SENTINEL_PATH.md', line_start: 12, line_end: 14 },
    });
    const request = buildDialogueRequest({
      sessionId: 'sess-raw', turnId: 'turn-raw', question: '이 근거를 확인해줘', evidence: [raw],
    });
    assert.equal(request.evidence[0].schema_version, 'evidence-reference.v1');
    assert.equal(JSON.stringify(request.evidence).includes('SENTINEL'), false);
    assert.equal(request.evidence[0].selected_text, undefined);
    assert.equal(request.evidence[0].reader_url, undefined);
    assert.equal(request.evidence[0].locator.relative_path, undefined);
  });

  it('trims the question and rejects empty or overlong input by code points', () => {
    assert.throws(() => buildDialogueRequest({
      sessionId: 's', turnId: 't', question: '   ', evidence: [evidenceFixture()],
    }), /question/i);
    const long = '가'.repeat(2001);
    assert.throws(() => buildDialogueRequest({
      sessionId: 's', turnId: 't', question: long, evidence: [evidenceFixture()],
    }), /question/i);
    // Emoji counts as one code point, not two UTF-16 units.
    const question = '가'.repeat(1999) + '😀';
    const request = buildDialogueRequest({
      sessionId: 's', turnId: 't', question, evidence: [evidenceFixture()],
    });
    assert.equal(codePointLength(request.question), 2000);
  });

  it('rejects empty or oversized evidence lists', () => {
    assert.throws(() => buildDialogueRequest({
      sessionId: 's', turnId: 't', question: '질문', evidence: [],
    }), /evidence/i);
    const tooMany = Array.from({ length: 21 }, () => evidenceFixture());
    assert.throws(() => buildDialogueRequest({
      sessionId: 's', turnId: 't', question: '질문', evidence: tooMany,
    }), /evidence/i);
  });

  it('rejects invalid evidence objects and bounded identity violations', () => {
    assert.throws(() => buildDialogueRequest({
      sessionId: 's', turnId: 't', question: '질문', evidence: [{ not: 'evidence' }],
    }), /evidence/i);
    assert.throws(() => buildDialogueRequest({
      sessionId: '', turnId: 't', question: '질문', evidence: [evidenceFixture()],
    }), /session/i);
    assert.throws(() => buildDialogueRequest({
      sessionId: 's', turnId: 'x'.repeat(200), question: '질문', evidence: [evidenceFixture()],
    }), /turn/i);
    assert.throws(() => buildDialogueRequest({
      sessionId: 'a\u0000b', turnId: 't', question: '질문', evidence: [evidenceFixture()],
    }), /session/i);
  });
});

describe('stage3 response parsing — fail-closed dialogue.response.v0.1', () => {
  function validResponse(overrides = {}) {
    return Object.assign({
      schema_version: 'dialogue.response.v0.1',
      request_id: 'req-1',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      status: 'ok',
      answer: '黄庭内景经의 본문에 근거하여 설명합니다.',
      citations: [{
        citation_id: '1',
        evidence_key: '["daocanon","dc1_'+'a'.repeat(64)+'",...]',
        claim_excerpt: '근거 대응 구간',
        reader_url: `/api/daocanon/v1/works/${DC1}?line=12`,
        locator: { kind: 'physical-lines', line_start: 12, line_end: 14 },
      }],
      grounding: { requested: 1, verified: 1, excluded: 0 },
      model: { backend: 'local', model_id: 'qwen3.6:35b' },
    }, overrides);
  }

  it('accepts a well-formed ok envelope', () => {
    const parsed = parseDialogueResponse(validResponse(), {
      request_id: 'req-1', session_id: 'sess-1', turn_id: 'turn-1',
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.answer.length > 0, true);
    assert.equal(parsed.value.citations[0].reader_url.startsWith('/api/daocanon/v1/works/'), true);
  });

  it('rejects wrong schema version, missing status, and empty answers', () => {
    for (const bad of [
      { ...validResponse(), schema_version: 'dialogue.response.v9' },
      { ...validResponse(), status: 'error' },
      { ...validResponse(), answer: '' },
    ]) {
      const parsed = parseDialogueResponse(bad, {
        request_id: 'req-1', session_id: 'sess-1', turn_id: 'turn-1',
      });
      assert.equal(parsed.ok, false);
      assert.ok(parsed.error.code);
    }
  });

  it('rejects malformed citations and mismatched identity fields', () => {
    for (const bad of [
      { ...validResponse(), citations: [{ citation_id: '1' }] },
      { ...validResponse(), citations: 'nope' },
      { ...validResponse(), request_id: 'different' },
      { ...validResponse(), session_id: '' },
    ]) {
      const parsed = parseDialogueResponse(bad, {
        request_id: 'req-1', session_id: 'sess-1', turn_id: 'turn-1',
      });
      assert.equal(parsed.ok, false, JSON.stringify(bad));
    }
  });
});

describe('stage3 error parsing — dialogue.error.v0.1', () => {
  it('extracts code, message, and optional excluded keys', () => {
    const parsed = parseDialogueError({
      schema_version: DIALOGUE_ERROR_SCHEMA_VERSION,
      request_id: 'req-1',
      session_id: 'sess-1',
      turn_id: 'turn-1',
      status: 'error',
      error: {
        code: 'E_CONTEXT_BUDGET_EXCEEDED',
        message: '선택한 근거가 Local 문맥 상한을 넘었습니다.',
        excluded_evidence_keys: ['["daocanon",...]'],
      },
    });
    assert.equal(parsed.code, 'E_CONTEXT_BUDGET_EXCEEDED');
    assert.equal(parsed.message.includes('문맥'), true);
    assert.equal(parsed.excluded_evidence_keys.length, 1);
  });
});

describe('stage3 citation targeting — allowlisted reader navigation only', () => {
  it('parses canon reader URLs into a physical line target', () => {
    assert.deepEqual(citationTargetForCanon(`/api/daocanon/v1/works/${DC1}?line=12`), {
      surface: 'canon', workId: DC1, line: 12,
    });
  });

  it('fails closed on non-allowlisted or malformed canon reader URLs', () => {
    for (const bad of [
      'https://evil.example/api/daocanon/v1/works/' + DC1 + '?line=12',
      `/api/daocanon/v1/works/${'x'.repeat(64)}?line=12`,
      `/api/daocanon/v1/works/${DC1}?line=0`,
      `/api/daocanon/v1/works/${DC1}`,
      '/api/daocanon/v1/works/' + DC1 + '?line=999999999999',
    ]) {
      assert.equal(citationTargetForCanon(bad), null, bad);
    }
  });

  it('parses research entry and section reader URLs', () => {
    assert.deepEqual(citationTargetForResearch(`/api/daoism-research/v1/entries/${ENT}`), {
      surface: 'research', unitType: 'entry', unitId: ENT,
    });
    assert.deepEqual(citationTargetForResearch(`/api/daoism-research/v1/sections/${SEC}?expected_hash=sha256%3A${'a'.repeat(64)}`), {
      surface: 'research', unitType: 'section', unitId: SEC,
    });
  });

  it('fails closed on malformed research reader URLs', () => {
    for (const bad of [
      `/api/daoism-research/v1/entries/${'x'.repeat(32)}`,
      `https://evil.example/api/daoism-research/v1/entries/${ENT}`,
      '/api/daoism-research/v1/entries/',
    ]) {
      assert.equal(citationTargetForResearch(bad), null, bad);
    }
  });

  it('derives safe navigation target from evidence reference objects', () => {
    const canonRef = {
      schema_version: 'evidence-reference.v1',
      source_kind: 'primary',
      unit_type: 'work',
      source_id: 'daocanon',
      work_id: DC1,
      unit_id: DC1,
      title: '黄庭内景经',
      locator: { kind: 'physical-lines', line_start: 12, line_end: 14, target_line: 12 },
    };
    assert.deepEqual(citationTargetForReference(canonRef), {
      surface: 'canon', workId: DC1, line: 12,
    });

    const entryRef = {
      schema_version: 'evidence-reference.v1',
      source_kind: 'dictionary',
      unit_type: 'entry',
      source_id: 'daojiao-dacidian',
      work_id: 'wrk' + 'a'.repeat(32),
      unit_id: ENT,
      title: '太清',
      locator: { kind: 'research-source-locator', unit_line_start: 1, unit_line_end: 10 },
    };
    assert.deepEqual(citationTargetForReference(entryRef), {
      surface: 'research', unitType: 'entry', unitId: ENT, sourceId: 'daojiao-dacidian',
    });
  });
});

describe('stage3 shelf summary helpers', () => {
  it('counts shelf items by source kind', () => {
    const canon = evidenceFixture();
    const entry = Object.assign(evidenceFixture(), {
      source_kind: 'dictionary', unit_type: 'entry', unit_id: ENT,
      title: '사전 표제어', selected_text: '사전 본문',
      reader_url: `/api/daoism-research/v1/entries/${ENT}`,
    });
    validateEvidence(entry);
    const section = Object.assign(evidenceFixture(), {
      source_kind: 'research', unit_type: 'section', unit_id: SEC,
      title: '연구서 절', selected_text: '연구서 본문',
      reader_url: `/api/daoism-research/v1/sections/${SEC}`,
    });
    validateEvidence(section);
    assert.deepEqual(countBySourceKind([canon, entry, section]), {
      primary: 1, dictionary: 1, research: 1,
    });
  });

  it('keeps the dialogue storage key stable', () => {
    assert.equal(DIALOGUE_STORAGE_KEY, 'daocanon.research.dialogue.v0.1');
    assert.equal(DIALOGUE_SESSION_SCHEMA_VERSION, 'dialogue.session.v0.1');
    assert.equal(buildChatUrl(), '/api/dialogue/v1/chat');
  });

  it('keeps the Stage 1 shelf dialogue selector on the current local model allowlist', async () => {
    const html = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
    const block = html.match(/<select id="dialogue-model"[\s\S]*?<\/select>/)?.[0];
    assert.ok(block, 'dialogue model selector must exist');
    assert.deepEqual(
      [...block.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
      ['qwen3.6:35b', 'gemma4:26b', 'nemotron-3.5-lightning:latest'],
    );
    assert.doesNotMatch(block, /gemma4:12b/);
  });
});

describe('stage3 context transfer visibility', () => {
  it('refreshes the visible context and transfer control when evidence is added to an open panel', async () => {
    const source = await readFile(new URL('../src/web/stage3.js', import.meta.url), 'utf8');
    assert.match(source, /if \(panelOpen\) renderContextStrip\(\);/);
    assert.match(source, /if \(panelOpen\) updateComposer\(\);/);
  });
});
