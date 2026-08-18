export const MAX_PASSAGE_LINES = 100;
export const MAX_PASSAGE_CODE_POINTS = 200_000;

function codePointLength(value) {
  return [...value].length;
}

function physicalLines(content) {
  const lines = content.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '' && /(?:\r\n|\r|\n)$/.test(content)) lines.pop();
  return lines;
}

function workError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseTargetLine(searchParams) {
  const values = searchParams.getAll('line');
  if (values.length === 0) return 1;
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0])) {
    throw workError('invalid_line', 'line must be one positive integer');
  }
  const line = Number(values[0]);
  if (!Number.isSafeInteger(line)) {
    throw workError('invalid_line', 'line must be one positive integer');
  }
  return line;
}

export function buildWorkPassage(record, content, targetLine) {
  if (typeof content !== 'string') {
    throw workError('work_unavailable', 'work content is unavailable');
  }
  const sourceLines = physicalLines(content);
  if (targetLine > sourceLines.length) {
    throw workError('line_out_of_range', 'line is outside the work');
  }
  const targetIndex = targetLine - 1;
  const targetLength = codePointLength(sourceLines[targetIndex]);
  if (targetLength > MAX_PASSAGE_CODE_POINTS) {
    throw workError('passage_too_large', 'target line exceeds the passage limit');
  }
  const selected = [{ number: targetLine, text: sourceLines[targetIndex] }];
  let codePoints = targetLength;

  for (let index = targetIndex - 1; index >= 0 && index >= targetIndex - 10; index -= 1) {
    const length = codePointLength(sourceLines[index]);
    if (codePoints + length > MAX_PASSAGE_CODE_POINTS) break;
    selected.unshift({ number: index + 1, text: sourceLines[index] });
    codePoints += length;
  }

  for (
    let index = targetIndex + 1;
    index < sourceLines.length && selected.length < MAX_PASSAGE_LINES;
    index += 1
  ) {
    const length = codePointLength(sourceLines[index]);
    if (codePoints + length > MAX_PASSAGE_CODE_POINTS) break;
    selected.push({ number: index + 1, text: sourceLines[index] });
    codePoints += length;
  }

  const lineStart = selected[0].number;
  const lineEnd = selected.at(-1).number;
  return {
    work: { ...record },
    passage: {
      target_line: targetLine,
      line_start: lineStart,
      line_end: lineEnd,
      total_lines: sourceLines.length,
      previous_line: lineStart > 1 ? Math.max(1, lineStart - 90) : null,
      next_line: lineEnd < sourceLines.length ? lineEnd + 1 : null,
      lines: selected,
    },
    meta: {
      max_lines: MAX_PASSAGE_LINES,
      max_code_points: MAX_PASSAGE_CODE_POINTS,
    },
  };
}
