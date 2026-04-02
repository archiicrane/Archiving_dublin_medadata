function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractFilenameFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const clean = safeDecode(url.split('?')[0]);
  const parts = clean.split('/');
  return parts[parts.length - 1] || '';
}

export function parseArchiveFilename(filenameInput) {
  if (!filenameInput || typeof filenameInput !== 'string') return null;

  const filename = safeDecode(filenameInput.trim()).replace(/^.*[\\/]/, '');
  const base = filename.replace(/\.[^.]+$/, '');

  // Pattern: {id}-{year}-{project_name}-{sheetIndex}
  const match = base.match(/^([^-]+)-(\d{4})-(.+)-(\d+)$/);
  if (!match) return null;

  const [, id, year, rawProject, sheetIndex] = match;
  const projectName = rawProject.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    id,
    year,
    projectName,
    sheetIndex,
    filename,
    base,
  };
}

function compactUrl(url) {
  if (!url) return '';
  const filename = extractFilenameFromUrl(url);
  return filename || url;
}

/**
 * Returns the best primary display title for a drawing record.
 *
 * Priority chain:
 *   1. resolvedDisplayTitle (set by backend OCR extraction, confidence ≥ 0.40)
 *   2. board_title (raw OCR result, confidence ≥ 0.40 – same source but direct)
 *   3. Parsed filename: "10011 • S1 — Urban Voids Grounds for Change"
 *   4. Plain filename without extension
 *   5. URL filename
 *   6. id / instance_id / title
 */
export function getDrawingDisplayName(recordLike) {
  if (!recordLike) return 'Unknown drawing';

  // Priority 0 — project-level canonicalized board title
  if (recordLike.canonicalBoardTitle && String(recordLike.canonicalBoardTitle).trim()) {
    return String(recordLike.canonicalBoardTitle).trim();
  }
  if (recordLike.canonical_board_title && String(recordLike.canonical_board_title).trim()) {
    return String(recordLike.canonical_board_title).trim();
  }

  // Priority 1 — backend-resolved display title (OCR or metadata displayTitle)
  if (recordLike.resolvedDisplayTitle && String(recordLike.resolvedDisplayTitle).trim()) {
    return String(recordLike.resolvedDisplayTitle).trim();
  }

  // Priority 2 — raw board_title field with acceptable confidence
  if (
    recordLike.board_title &&
    String(recordLike.board_title).trim() &&
    (recordLike.board_title_confidence ?? 0) >= 0.40
  ) {
    return String(recordLike.board_title).trim();
  }

  const filename =
    recordLike.filename ||
    extractFilenameFromUrl(recordLike.url) ||
    (recordLike.instance_id ? `${recordLike.instance_id}.jpg` : '');

  // Priority 3 — filename-parsed label
  const parsed = parseArchiveFilename(filename);
  if (parsed) {
    return `${parsed.id} • S${parsed.sheetIndex} — ${parsed.projectName}`;
  }

  if (filename) {
    return filename.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
  }

  if (recordLike.url) {
    return compactUrl(recordLike.url);
  }

  return String(
    recordLike.instance_id ||
    recordLike.image_id ||
    recordLike.id ||
    recordLike.title ||
    recordLike.displayTitle ||
    'Unknown drawing'
  );
}

/**
 * Returns the secondary archive line shown beneath the primary title.
 * Format: "10011 • S1 • Urban Voids Grounds for Change"
 *
 * When a resolved/OCR title is the primary, this line provides traceability.
 * When no OCR title exists, returns null (the primary title already contains this info).
 */
export function getArchiveSecondaryLine(recordLike) {
  if (!recordLike) return null;

  const hasOcrTitle =
    (recordLike.canonicalBoardTitle && String(recordLike.canonicalBoardTitle).trim()) ||
    (recordLike.canonical_board_title && String(recordLike.canonical_board_title).trim()) ||
    (recordLike.resolvedDisplayTitle && String(recordLike.resolvedDisplayTitle).trim()) ||
    (recordLike.board_title && (recordLike.board_title_confidence ?? 0) >= 0.40);

  if (!hasOcrTitle) return null;  // primary IS the archive label — no need to repeat

  const filename =
    recordLike.filename ||
    extractFilenameFromUrl(recordLike.url) ||
    (recordLike.instance_id ? `${recordLike.instance_id}.jpg` : '');

  const parsed = parseArchiveFilename(filename);
  if (parsed) {
    return `${parsed.id} • S${parsed.sheetIndex} • ${parsed.projectName}`;
  }

  if (recordLike.instance_id) {
    return recordLike.instance_id.replace(/_/g, ' ');
  }

  return null;
}

export function getCompetitionTitle(recordLike) {
  if (!recordLike) return 'Unknown competition';

  const explicit =
    recordLike.source_metadata?.displayTitle ||
    recordLike.source_metadata?.title ||
    recordLike.displayTitle ||
    recordLike.title;

  if (explicit && String(explicit).trim()) {
    return String(explicit).trim();
  }

  const filename =
    recordLike.filename ||
    extractFilenameFromUrl(recordLike.url) ||
    (recordLike.instance_id ? `${recordLike.instance_id}.jpg` : '');

  const parsed = parseArchiveFilename(filename);
  if (parsed?.projectName) {
    return parsed.projectName;
  }

  return 'Unknown competition';
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

export function createArchiveResolver(metadata) {
  const byFilename = new Map();
  const byUrl = new Map();
  const byInstanceId = new Map();
  const byImageId = new Map();

  metadata.forEach((record) => {
    const filename = record.filename || extractFilenameFromUrl(record.url);
    if (filename) byFilename.set(normalizeKey(filename), record);
    if (record.url) byUrl.set(normalizeKey(record.url), record);
    if (record.instance_id) byInstanceId.set(normalizeKey(record.instance_id), record);
    if (record.image_id) byImageId.set(normalizeKey(record.image_id), record);
    if (record.id) byImageId.set(normalizeKey(record.id), record);
  });

  function resolveArchiveRecord(linkedImage) {
    if (!linkedImage) return null;

    if (typeof linkedImage === 'string') {
      const raw = linkedImage;
      const filenameFromUrl = extractFilenameFromUrl(raw);
      const cleanFilename = raw.endsWith('.jpg') || raw.endsWith('.jpeg') ? raw : filenameFromUrl;

      return (
        byFilename.get(normalizeKey(cleanFilename)) ||
        byUrl.get(normalizeKey(raw)) ||
        byInstanceId.get(normalizeKey(raw.replace(/\.[^.]+$/, ''))) ||
        byImageId.get(normalizeKey(raw)) ||
        null
      );
    }

    const filename = linkedImage.filename || extractFilenameFromUrl(linkedImage.url);

    return (
      byFilename.get(normalizeKey(filename)) ||
      byUrl.get(normalizeKey(linkedImage.url)) ||
      byInstanceId.get(normalizeKey(linkedImage.instance_id)) ||
      byImageId.get(normalizeKey(linkedImage.image_id || linkedImage.id)) ||
      null
    );
  }

  function getDisplayName(linkedImage) {
    const resolved = resolveArchiveRecord(linkedImage);
    if (resolved) return getDrawingDisplayName(resolved);

    if (typeof linkedImage === 'string') {
      const parsed = parseArchiveFilename(extractFilenameFromUrl(linkedImage) || linkedImage);
      if (parsed) return `${parsed.id} • S${parsed.sheetIndex} — ${parsed.projectName}`;
      return linkedImage;
    }

    return getDrawingDisplayName(linkedImage);
  }

  function getCompetitionName(linkedImage) {
    const resolved = resolveArchiveRecord(linkedImage);
    if (resolved) return getCompetitionTitle(resolved);

    if (typeof linkedImage === 'string') {
      const parsed = parseArchiveFilename(extractFilenameFromUrl(linkedImage) || linkedImage);
      if (parsed?.projectName) return parsed.projectName;
    }

    return getCompetitionTitle(linkedImage);
  }

  function getCompetitionKey(linkedImage) {
    return normalizeKey(getCompetitionName(linkedImage));
  }

  /**
   * Returns the secondary archive traceability line for a drawing.
   * Returns null when no OCR/resolved title is present (the primary already encodes the archive ID).
   */
  function getSecondaryLine(linkedImage) {
    const resolved = resolveArchiveRecord(linkedImage);
    if (resolved) return getArchiveSecondaryLine(resolved);
    if (typeof linkedImage !== 'string') return getArchiveSecondaryLine(linkedImage);
    return null;
  }

  return {
    resolveArchiveRecord,
    getDisplayName,
    getSecondaryLine,
    getCompetitionName,
    getCompetitionKey,
  };
}
