function normalizeNfc(value) {
  return value.normalize('NFC');
}

function trimUnicodeWhitespace(value) {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

function normalizeSearchValue(value, mode) {
  const normalized = normalizeNfc(value);
  return mode === 'author' ? normalized.replaceAll('曉', '晓') : normalized;
}

function matchRank(value, query) {
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  return 2;
}

function toHit(record, mode) {
  return {
    source_id: record.source_id,
    work_id: record.work_id,
    title: record.title,
    author: record.author,
    division: record.division,
    match_type: mode,
    locator: {
      source_id: record.source_id,
      relative_path: record.relative_path,
      line_start: null,
      line_end: null,
    },
  };
}

function validationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function singleValue(params, name, code) {
  const values = params.getAll(name);
  if (values.length !== 1) {
    throw validationError(code, `exactly one ${name} parameter is required`);
  }
  return values[0];
}

function boundedInteger(params, name, fallback, minimum, maximum) {
  const values = params.getAll(name);
  if (values.length === 0) return fallback;
  if (values.length !== 1 || !/^[0-9]+$/.test(values[0])) {
    throw validationError('invalid_query', `invalid ${name} parameter`);
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw validationError('invalid_query', `invalid ${name} parameter`);
  }
  return value;
}

export function parseSearchParams(params) {
  const query = normalizeNfc(
    trimUnicodeWhitespace(singleValue(params, 'q', 'invalid_query')),
  );
  if ([...query].length < 1 || [...query].length > 100) {
    throw validationError('invalid_query', 'query must contain 1 to 100 characters');
  }

  const mode = singleValue(params, 'mode', 'invalid_mode');
  if (mode !== 'title' && mode !== 'author' && mode !== 'fulltext') {
    throw validationError('invalid_mode', 'mode must be title, author, or fulltext');
  }
  if (mode === 'fulltext' && [...query.normalize('NFD')].length > 319) {
    throw validationError(
      'invalid_query',
      'fulltext query canonical expansion must not exceed 319 characters',
    );
  }

  return {
    query,
    mode,
    limit: boundedInteger(params, 'limit', 20, 1, 100),
    offset: boundedInteger(params, 'offset', 0, 0, 1_000_000),
  };
}

export function searchCatalog(records, { query, mode, limit, offset }) {
  const normalizedQuery = normalizeSearchValue(query, mode);
  const matches = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const field = mode === 'title' ? record.title : record.author;
    if (field === null) continue;
    const normalizedField = normalizeSearchValue(field, mode);
    if (!normalizedField.includes(normalizedQuery)) continue;
    matches.push({
      index,
      rank: matchRank(normalizedField, normalizedQuery),
      record,
    });
  }

  matches.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return {
    total: matches.length,
    hits: matches
      .slice(offset, offset + limit)
      .map(({ record }) => toHit(record, mode)),
  };
}
