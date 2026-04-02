/**
 * connectionExplainer.js
 *
 * Translates raw AI connection data into plain-language explanations,
 * evidence tags, and confidence labels for the archive viewer UI.
 *
 * All exported functions are pure and work from the `connection_type` string
 * that is already present in every region_connections.json record — no
 * pipeline re-run is required.
 */

// ── Evidence tag definitions ─────────────────────────────────────────────────

const EVIDENCE_TAG_META = {
  visual_pattern:     { label: 'Visual pattern',    cls: 'tag--visual' },
  edges:              { label: 'Edges & contrast',  cls: 'tag--edges' },
  shape_structure:    { label: 'Shape structure',   cls: 'tag--shape' },
  subject_similarity: { label: 'Subject similarity',cls: 'tag--subject' },
  color_texture:      { label: 'Color & tone',      cls: 'tag--color' },
  layout:             { label: 'Layout',            cls: 'tag--layout' },
  text:               { label: 'Text / OCR',        cls: 'tag--text' },
  metadata:           { label: 'Metadata',          cls: 'tag--metadata' },
  blank_region:       { label: 'Blank region',      cls: 'tag--blank' },
};

// Which evidence kinds belong to each connection type
const TYPE_EVIDENCE = {
  exact_visual_match:     ['visual_pattern', 'edges', 'shape_structure'],
  semantic_similarity:    ['subject_similarity'],
  composition_similarity: ['layout', 'color_texture'],
  ocr_text_relation:      ['text'],
  metadata_relation:      ['metadata'],
};

// ── Match source labels ───────────────────────────────────────────────────────

const TYPE_SOURCE = {
  exact_visual_match:     'Local feature matching',
  semantic_similarity:    'Semantic similarity model',
  composition_similarity: 'Color & composition analysis',
  ocr_text_relation:      'OCR text matching',
  metadata_relation:      'Archive metadata',
};

// ── Human-readable type labels ────────────────────────────────────────────────

const TYPE_LABEL = {
  exact_visual_match:     'Exact local visual match',
  semantic_similarity:    'Semantic / subject similarity',
  composition_similarity: 'Composition / layout similarity',
  ocr_text_relation:      'Text match (OCR)',
  metadata_relation:      'Archive metadata link',
};

// ── Short plain-language explanations ────────────────────────────────────────

const TYPE_HUMAN = {
  exact_visual_match:
    'The system found a similar small visual pattern in both highlighted areas. ' +
    'It is comparing local edges, contrast, and shape structure — not the full meaning of the drawing.',

  semantic_similarity:
    'The images appear related by visual content or subject matter, even if the exact shapes ' +
    'do not match. A similarity model compared their overall content as a whole.',

  composition_similarity:
    'The images have a similar color distribution and tonal balance. ' +
    'The system compared the overall spread of light, dark, and color across each image.',

  ocr_text_relation:
    'The system found matching or similar text in both images using optical character recognition (OCR). ' +
    'This is a text-based match, not based on image appearance.',

  metadata_relation:
    'These images are linked through archive catalog information — such as shared subject tags, ' +
    'project grouping, or year — not by comparing image pixels.',
};

// ── What the AI was actually comparing (bullet list) ─────────────────────────

const TYPE_COMPARED = {
  exact_visual_match: [
    'Small local patches detected at keypoint locations in each image',
    'Edge and corner keypoints within those patches',
    'Contrast and gradient patterns (how pixel brightness changes)',
    'Local shape arrangement within each patch',
  ],
  semantic_similarity: [
    'Overall image content encoded as a numerical feature vector',
    'High-level visual patterns detected by a similarity model',
    'Content similarity at a broad level — not pixel-by-pixel detail',
  ],
  composition_similarity: [
    'Color histogram — how frequently each tone appears across the image',
    'Overall tonal balance (light vs. dark distribution)',
    'Color similarity across the full image area',
  ],
  ocr_text_relation: [
    'Text extracted from both images via OCR (optical character recognition)',
    'Shared words between the two text regions',
    'Word overlap ratio between detected text',
  ],
  metadata_relation: [
    'Archive subject tags and catalog fields',
    'Project title or administrative grouping',
    'Shared thematic or catalog categories',
  ],
};

// ── Whether each type uses pixel data ────────────────────────────────────────

const IS_PIXEL_BASED = {
  exact_visual_match:     true,
  semantic_similarity:    true,
  composition_similarity: true,
  ocr_text_relation:      false,
  metadata_relation:      false,
};

// ── Public API ────────────────────────────────────────────────────────────────

/** Human-friendly label for a connection type. */
export function getConnectionLabel(type) {
  return TYPE_LABEL[type] || type;
}

/** Short name for the matching system that produced this connection. */
export function getMatchSource(type) {
  return TYPE_SOURCE[type] || type;
}

/** One or two sentence plain-language explanation of the connection. */
export function getHumanExplanation(type) {
  return (
    TYPE_HUMAN[type] ||
    'This connection type does not yet have a plain-language description.'
  );
}

/** Bullet-point list of what the AI was numerically comparing. */
export function getAIComparedList(type) {
  return TYPE_COMPARED[type] || [];
}

/** True if the connection was derived from image pixel data. */
export function isPixelBased(type) {
  return IS_PIXEL_BASED[type] ?? true;
}

/**
 * Returns an array of evidence tag objects for the given connection type.
 * Each object: { kind, label, cls }
 */
export function getEvidenceTags(type, evidenceKinds = null) {
  const kinds = Array.isArray(evidenceKinds) && evidenceKinds.length
    ? evidenceKinds
    : (TYPE_EVIDENCE[type] || []);
  return kinds.map((k) => ({ kind: k, ...EVIDENCE_TAG_META[k] }));
}

/**
 * Returns a confidence level descriptor for a numeric score [0–1].
 * Returns { label, cls } where cls is a CSS modifier class.
 */
export function getConfidenceLabel(score) {
  if (score >= 0.75) return { label: 'High',     cls: 'conf--high' };
  if (score >= 0.50) return { label: 'Moderate', cls: 'conf--moderate' };
  if (score >= 0.30) return { label: 'Low',      cls: 'conf--low' };
  return                     { label: 'Weak',    cls: 'conf--weak' };
}
