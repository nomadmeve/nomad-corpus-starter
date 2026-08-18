import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 'daocanon-catalog-v1';
export const SOURCE_ID = 'daocanon';

// Deterministic bound for derived metadata fields (title, raw author).
// Measured in Unicode code points, not UTF-16 units.
export const MAX_METADATA_CHARS = 200;

const catalogContents = new WeakMap();

export function getCatalogContents(catalog) {
  const contents = catalogContents.get(catalog);
  if (!contents) {
    throw new Error('catalog contents are unavailable');
  }
  return contents;
}

const ID_PREFIX = 'dc1_';
const ID_NAMESPACE = 'daocanon:v1:';

export function canonicalizeRelativePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error('invalid relative path: must be a non-empty string');
  }
  const normalized = rawPath.normalize('NFC');
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    normalized.includes('\\') ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error(`invalid relative path: ${rawPath}`);
  }
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`invalid relative path: ${rawPath}`);
    }
  }
  return normalized;
}

export function computeWorkId(relativePath) {
  const canonical = canonicalizeRelativePath(relativePath);
  const input = ID_NAMESPACE + canonical;
  return (
    ID_PREFIX + crypto.createHash('sha256').update(input, 'utf8').digest('hex')
  );
}

async function assertReadableDirectory(root) {
  const stat = await fs.promises.lstat(root);
  if (!stat.isDirectory()) {
    throw new Error('corpus root is not a directory');
  }
  await fs.promises.access(root, fs.constants.R_OK | fs.constants.X_OK);
  return fs.promises.realpath(root);
}

async function discover(root) {
  const candidates = [];
  let excludedIndexCount = 0;
  let excludedSymlinkCount = 0;

  async function walk(absDir, relDir) {
    const entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      const diskRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        excludedSymlinkCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path.join(absDir, entry.name), diskRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (entry.name === 'INDEX.md') {
        excludedIndexCount += 1;
        continue;
      }
      candidates.push({
        disk: diskRel,
        canonical: canonicalizeRelativePath(diskRel),
      });
    }
  }

  await walk(root, '');
  // UTF-8 byte order equals code-point order; JS string comparison would
  // order by UTF-16 units and misorder supplementary-plane characters.
  candidates.sort((a, b) =>
    Buffer.compare(Buffer.from(a.canonical, 'utf8'), Buffer.from(b.canonical, 'utf8')),
  );
  return { candidates, excludedIndexCount, excludedSymlinkCount };
}

function nonblankLines(content) {
  return content
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function filenameStem(diskRel) {
  const base = diskRel.slice(diskRel.lastIndexOf('/') + 1);
  return base.slice(0, -'.md'.length);
}

const METADATA_PREFIX = '经名：';
const SENTENCE_STOP = '。';
const UNKNOWN_AUTHOR = '撰人不详';
const AUTHOR_MARKERS = ['撰', '编', '編', '注', '集', '述'];

function capCodePoints(value) {
  const points = [...value];
  if (points.length <= MAX_METADATA_CHARS) return value;
  return points.slice(0, MAX_METADATA_CHARS).join('');
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8Strict(buffer) {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    const error = new Error('candidate is not valid UTF-8');
    error.code = 'EINVALIDUTF8';
    throw error;
  }
}

function isStrictlyInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`)
  );
}

async function readCandidateNoFollow(root, rootRealPath, disk) {
  const candidatePath = path.join(root, ...disk.split('/'));
  const noFollow = fs.constants.O_NOFOLLOW;
  if (noFollow === undefined || process.platform !== 'linux') {
    const error = new Error('secure no-follow open is unavailable');
    error.code = 'ENOSECUREOPEN';
    throw error;
  }
  const handle = await fs.promises.open(
    candidatePath,
    fs.constants.O_RDONLY | noFollow,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      const error = new Error('candidate is not a regular file');
      error.code = 'ENOTREGULAR';
      throw error;
    }
    const openedRealPath = await fs.promises.realpath(
      `/proc/self/fd/${handle.fd}`,
    );
    if (!isStrictlyInside(rootRealPath, openedRealPath)) {
      const error = new Error('candidate escaped corpus root');
      error.code = 'EOUTSIDECORPUS';
      throw error;
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function parseAuthorSentence(metadataAfterTitle) {
  const nextStop = metadataAfterTitle.indexOf(SENTENCE_STOP);
  const sentence = (
    nextStop === -1 ? metadataAfterTitle : metadataAfterTitle.slice(0, nextStop)
  ).trim();
  if (sentence.length === 0) return null;
  if (sentence.includes(UNKNOWN_AUTHOR)) return null;
  if (AUTHOR_MARKERS.some((marker) => sentence.includes(marker))) return sentence;
  return null;
}

function parseRecord(content, stem) {
  const lines = nonblankLines(content);
  const warnings = new Set();
  let title = null;
  let author = null;

  if (lines.length === 0) {
    title = stem;
    warnings.add('empty_content');
  } else {
    const first = lines[0];
    const second = lines.length > 1 ? lines[1] : null;
    if (second !== null && second.startsWith(METADATA_PREFIX)) {
      const afterPrefix = second.slice(METADATA_PREFIX.length);
      const stop = afterPrefix.indexOf(SENTENCE_STOP);
      const parsed = (
        stop === -1 ? afterPrefix : afterPrefix.slice(0, stop)
      ).trim();
      if (parsed.length === 0) {
        title = first;
        warnings.add('empty_metadata_title');
      } else {
        title = parsed;
        if (stop !== -1) {
          author = parseAuthorSentence(afterPrefix.slice(stop + 1));
        }
      }
    } else if (second !== null && second.includes(METADATA_PREFIX)) {
      title = first;
      warnings.add('malformed_metadata_prefix');
    } else {
      title = first;
      warnings.add('metadata_header_missing');
    }
  }

  if ([...title].length > MAX_METADATA_CHARS) {
    title = capCodePoints(title);
    warnings.add('metadata_truncated');
  }
  if (author !== null && [...author].length > MAX_METADATA_CHARS) {
    author = capCodePoints(author);
    warnings.add('metadata_truncated');
  }

  if (title !== stem) warnings.add('title_filename_mismatch');
  return { title, author, warnings: [...warnings].sort() };
}

export async function buildCatalog(root) {
  const rootRealPath = await assertReadableDirectory(root);
  const { candidates, excludedIndexCount, excludedSymlinkCount } =
    await discover(root);

  const seenPaths = new Set();
  const seenIds = new Set();
  const records = [];
  const contents = new Map();

  for (const { disk, canonical } of candidates) {
    if (seenPaths.has(canonical)) {
      const error = new Error(`duplicate canonical path: ${canonical}`);
      error.code = 'DUPLICATE_WORK_IDENTITY';
      throw error;
    }
    seenPaths.add(canonical);

    const workId = computeWorkId(canonical);
    if (seenIds.has(workId)) {
      const error = new Error(`duplicate work id: ${workId}`);
      error.code = 'DUPLICATE_WORK_IDENTITY';
      throw error;
    }
    seenIds.add(workId);

    const stem = filenameStem(disk);
    let title;
    let author;
    let warnings;
    try {
      const buffer = await readCandidateNoFollow(root, rootRealPath, disk);
      const content = decodeUtf8Strict(buffer);
      ({ title, author, warnings } = parseRecord(content, stem));
      contents.set(workId, content);
    } catch (error) {
      title = stem;
      author = null;
      warnings = [
        error.code === 'EINVALIDUTF8' ? 'invalid_utf8' : 'unreadable_file',
      ];
      if ([...title].length > MAX_METADATA_CHARS) {
        title = capCodePoints(title);
        warnings.push('metadata_truncated');
        warnings.sort();
      }
    }
    const slash = canonical.indexOf('/');

    records.push({
      source_id: SOURCE_ID,
      work_id: workId,
      title,
      author,
      division: slash === -1 ? null : canonical.slice(0, slash),
      relative_path: canonical,
      parse_warnings: warnings,
    });
  }

  const titleCounts = new Map();
  for (const record of records) {
    titleCounts.set(record.title, (titleCounts.get(record.title) ?? 0) + 1);
  }
  let duplicateTitleGroupCount = 0;
  for (const [title, count] of titleCounts) {
    if (count < 2) continue;
    duplicateTitleGroupCount += 1;
    for (const record of records) {
      if (record.title !== title) continue;
      record.parse_warnings.push('duplicate_title');
      record.parse_warnings.sort();
    }
  }

  let warningCount = 0;
  const warningTotals = new Map();
  for (const record of records) {
    warningCount += record.parse_warnings.length;
    for (const code of record.parse_warnings) {
      warningTotals.set(code, (warningTotals.get(code) ?? 0) + 1);
    }
  }
  const warningCounts = {};
  for (const code of [...warningTotals.keys()].sort()) {
    warningCounts[code] = warningTotals.get(code);
  }

  const catalog = {
    schema_version: SCHEMA_VERSION,
    source_id: SOURCE_ID,
    records,
    summary: {
      work_count: records.length,
      excluded_index_count: excludedIndexCount,
      excluded_symlink_count: excludedSymlinkCount,
      warning_count: warningCount,
      warning_counts: warningCounts,
      duplicate_title_group_count: duplicateTitleGroupCount,
    },
  };
  catalogContents.set(catalog, contents);
  return catalog;
}
