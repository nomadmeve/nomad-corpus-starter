const MAX_SNIPPET_CHARS = 320;
const MAX_CONTEXT_CHARS = 160;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function codePointLength(value) {
  return [...value].length;
}

function codePointOffset(value, codeUnitOffset) {
  return [...value.slice(0, codeUnitOffset)].length;
}

function boundedExcerpt(value, matchStart, matchEnd, maximum) {
  const points = [...value];
  if (points.length <= maximum) return value;

  const matchLength = matchEnd - matchStart;
  const available = Math.max(0, maximum - matchLength);
  let start = Math.max(0, matchStart - Math.floor(available / 2));
  let end = Math.min(points.length, start + maximum);
  start = Math.max(0, end - maximum);

  let excerpt = points.slice(start, end).join('');
  if (start > 0 && matchStart > start) {
    excerpt = `…${[...excerpt].slice(1).join('')}`;
  }
  if (end < points.length && matchEnd < end) {
    excerpt = `${[...excerpt].slice(0, -1).join('')}…`;
  }
  return excerpt;
}

function boundedContext(value) {
  if (value === undefined) return null;
  const points = [...value];
  if (points.length <= MAX_CONTEXT_CHARS) return value;
  return `${points.slice(0, MAX_CONTEXT_CHARS - 1).join('')}…`;
}

function queryVariants(query) {
  const nfc = query.normalize('NFC');
  return [...new Set([nfc, nfc.normalize('NFD')])];
}

function projectLine(value, useCanonicalProjection) {
  if (!useCanonicalProjection) {
    return { source: value, comparable: value, boundaries: null };
  }

  const boundaries = [{ source: 0, comparable: 0 }];
  let comparable = '';
  let comparableOffset = 0;
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(value)) {
    const normalizedSegment = segment.normalize('NFD');
    comparable += normalizedSegment;
    comparableOffset += normalizedSegment.length;
    boundaries.push({
      source: index + segment.length,
      comparable: comparableOffset,
    });
  }
  return {
    source: value,
    comparable,
    boundaries,
  };
}

function sourceStartAt(projection, comparableOffset) {
  if (projection.boundaries === null) return comparableOffset;
  let selected = 0;
  for (const boundary of projection.boundaries) {
    if (boundary.comparable > comparableOffset) break;
    selected = boundary.source;
  }
  return selected;
}

function sourceEndAt(projection, comparableOffset) {
  if (projection.boundaries === null) return comparableOffset;
  for (const boundary of projection.boundaries) {
    if (boundary.comparable >= comparableOffset) return boundary.source;
  }
  return projection.source.length;
}

function firstMatch(value, variants, fromIndex = 0) {
  let selected = null;
  for (const variant of variants) {
    const index = value.indexOf(variant, fromIndex);
    if (index === -1) continue;
    if (
      selected === null ||
      index < selected.index ||
      (index === selected.index && variant.length > selected.variant.length)
    ) {
      selected = { index, variant };
    }
  }
  return selected;
}

function firstCrossLineMatch(first, second, variants, fromIndex = 0) {
  const combined = first + second;
  let selected = null;

  for (const variant of variants) {
    let index = combined.indexOf(
      variant,
      Math.max(fromIndex, first.length - variant.length + 1),
    );
    while (index !== -1 && index < first.length) {
      if (index + variant.length > first.length) {
        if (
          selected === null ||
          index < selected.index ||
          (index === selected.index && variant.length > selected.variant.length)
        ) {
          selected = { index, variant };
        }
        break;
      }
      index = combined.indexOf(variant, index + 1);
    }
  }

  return selected;
}

function baseHit(record, lineStart, lineEnd) {
  return {
    source_id: record.source_id,
    work_id: record.work_id,
    title: record.title,
    author: record.author,
    division: record.division,
    match_type: 'fulltext',
    locator: {
      source_id: record.source_id,
      relative_path: record.relative_path,
      line_start: lineStart,
      line_end: lineEnd,
    },
  };
}

function sameLineHit(record, lines, projections, lineIndex, match) {
  const line = lines[lineIndex];
  const projection = projections[lineIndex];
  const sourceStart = sourceStartAt(projection, match.index);
  const sourceEnd = sourceEndAt(projection, match.index + match.variant.length);
  const start = codePointOffset(line, sourceStart);
  const matchedSource = line.slice(sourceStart, sourceEnd);
  const matchLength = codePointLength(matchedSource);
  if (matchLength > MAX_SNIPPET_CHARS) return null;
  const end = start + matchLength;
  return {
    ...baseHit(record, lineIndex + 1, lineIndex + 1),
    match_text: matchedSource,
    snippet: boundedExcerpt(line, start, end, MAX_SNIPPET_CHARS),
    context_before: boundedContext(lines[lineIndex - 1]),
    context_after: boundedContext(lines[lineIndex + 1]),
  };
}

function crossLineHit(record, lines, projections, lineIndex, match) {
  const first = lines[lineIndex];
  const second = lines[lineIndex + 1];
  const firstProjection = projections[lineIndex];
  const secondProjection = projections[lineIndex + 1];
  const sourceStart = sourceStartAt(firstProjection, match.index);
  const secondComparableEnd =
    match.index + match.variant.length - firstProjection.comparable.length;
  const sourceEnd = sourceEndAt(secondProjection, secondComparableEnd);
  const firstPart = first.slice(sourceStart);
  const secondPart = second.slice(0, sourceEnd);
  const firstStart = codePointOffset(first, sourceStart);
  const firstMatchLength = codePointLength(firstPart);
  const secondMatchLength = codePointLength(secondPart);
  if (firstMatchLength + secondMatchLength + 1 > MAX_SNIPPET_CHARS) return null;
  const contextBudget = Math.max(
    0,
    MAX_SNIPPET_CHARS - firstMatchLength - secondMatchLength - 1,
  );
  const firstSnippet = boundedExcerpt(
    first,
    firstStart,
    codePointLength(first),
    firstMatchLength + Math.floor(contextBudget / 2),
  );
  const secondSnippet = boundedExcerpt(
    second,
    0,
    codePointLength(secondPart),
    secondMatchLength + Math.ceil(contextBudget / 2),
  );
  return {
    ...baseHit(record, lineIndex + 1, lineIndex + 2),
    match_text: `${firstPart}\n${secondPart}`,
    snippet: `${firstSnippet}\n${secondSnippet}`,
    context_before: boundedContext(lines[lineIndex - 1]),
    context_after: boundedContext(lines[lineIndex + 2]),
  };
}

export function searchFulltext(records, contents, { query, limit, offset }) {
  const variants = queryVariants(query);
  const useCanonicalProjection = variants.length > 1 || /\p{Mark}/u.test(query);
  const comparableVariants = useCanonicalProjection ? [variants.at(-1)] : variants;
  const matches = [];

  for (const record of records) {
    const content = contents.get(record.work_id);
    if (content === undefined) continue;
    const lines = content.split(/\r\n|\r|\n/);
    if (lines.at(-1) === '' && /(?:\r\n|\r|\n)$/.test(content)) lines.pop();
    const projections = lines.map((line) => projectLine(line, useCanonicalProjection));
    const workHits = new Map();

    for (let index = 0; index < lines.length; index += 1) {
      let sameLine = firstMatch(projections[index].comparable, comparableVariants);
      while (sameLine) {
        const hit = sameLineHit(record, lines, projections, index, sameLine);
        if (hit) {
          workHits.set(`${index + 1}:${index + 1}`, hit);
          break;
        }
        sameLine = firstMatch(
          projections[index].comparable,
          comparableVariants,
          sameLine.index + 1,
        );
      }

      if (index + 1 >= lines.length) continue;
      let crossLine = firstCrossLineMatch(
        projections[index].comparable,
        projections[index + 1].comparable,
        comparableVariants,
      );
      while (crossLine) {
        const hit = crossLineHit(record, lines, projections, index, crossLine);
        if (hit) {
          workHits.set(`${index + 1}:${index + 2}`, hit);
          break;
        }
        crossLine = firstCrossLineMatch(
          projections[index].comparable,
          projections[index + 1].comparable,
          comparableVariants,
          crossLine.index + 1,
        );
      }
    }

    matches.push(
      ...[...workHits.values()].sort(
        (a, b) =>
          a.locator.line_start - b.locator.line_start ||
          a.locator.line_end - b.locator.line_end,
      ),
    );
  }

  return {
    total: matches.length,
    hits: matches.slice(offset, offset + limit),
  };
}
