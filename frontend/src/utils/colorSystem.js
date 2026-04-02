export const connectionColors = {
  exact_visual_match: '#2563eb',
  semantic_similarity: '#16a34a',
  composition_similarity: '#facc15',
  ocr_text_relation: '#7c3aed',
  metadata_relation: '#dc2626',
};

export const connectionLabels = {
  exact_visual_match: 'Exact local visual match',
  semantic_similarity: 'Semantic/subject similarity',
  composition_similarity: 'Composition/formal similarity',
  ocr_text_relation: 'OCR/text relation',
  metadata_relation: 'Archival/metadata relation',
};

const COMPETITION_PALETTE = [
  '#4F46E5', '#0EA5E9', '#10B981', '#84CC16', '#EAB308', '#F59E0B',
  '#F97316', '#EF4444', '#EC4899', '#A855F7', '#14B8A6', '#22C55E',
];

export const thematicEdgeColors = {
  water: '#2563eb',
  vegetation: '#16a34a',
  topography: '#a16207',
  building: '#f97316',
};

const THEME_TERMS = {
  water: ['water', 'river', 'lake', 'canal', 'shore', 'coast', 'wetland', 'ocean', 'sea', 'harbor', 'harbour'],
  vegetation: ['tree', 'trees', 'plant', 'plants', 'vegetation', 'green', 'greenery', 'landscape', 'forest', 'park', 'botanical'],
  topography: ['topography', 'topographic', 'terrain', 'contour', 'slope', 'elevation model', 'landform', 'site section'],
  building: ['building', 'buildings', 'architecture', 'facade', 'elevation', 'section', 'housing', 'residential', 'office', 'structure'],
};

function hashString(value) {
  const text = String(value || 'ungrouped').toLowerCase();
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getCompetitionColor(competitionKey) {
  const idx = hashString(competitionKey) % COMPETITION_PALETTE.length;
  return COMPETITION_PALETTE[idx];
}

function collectRecordText(record) {
  if (!record) return '';
  const dcSubject = Array.isArray(record?.dublin_core?.['dc:subject'])
    ? record.dublin_core['dc:subject'].join(' ')
    : String(record?.dublin_core?.['dc:subject'] || '');
  const keywords = Array.isArray(record?.extractedText?.keywords)
    ? record.extractedText.keywords.join(' ')
    : '';

  return [
    record.title,
    record.resolvedDisplayTitle,
    record.canonical_board_title,
    record.board_title,
    dcSubject,
    record?.dublin_core?.['dc:description'],
    keywords,
    record.contentSummary,
  ].filter(Boolean).join(' ').toLowerCase();
}

function detectThemePair(sourceText, targetText) {
  for (const [theme, terms] of Object.entries(THEME_TERMS)) {
    const srcMatch = terms.some((t) => sourceText.includes(t));
    const tgtMatch = terms.some((t) => targetText.includes(t));
    if (srcMatch && tgtMatch) return theme;
  }
  return null;
}

export function getEdgeColor(edge, metadataById) {
  const source = metadataById?.get?.(edge.source);
  const target = metadataById?.get?.(edge.target);
  const sourceText = collectRecordText(source);
  const targetText = collectRecordText(target);

  const theme = detectThemePair(sourceText, targetText);
  if (theme) return thematicEdgeColors[theme];

  const firstType = edge.connection_types?.[0];
  return connectionColors[firstType] || '#9ca3af';
}

export function getEdgeThemeLabel(edge, metadataById) {
  const source = metadataById?.get?.(edge.source);
  const target = metadataById?.get?.(edge.target);
  const theme = detectThemePair(collectRecordText(source), collectRecordText(target));
  if (!theme) return null;
  if (theme === 'vegetation') return 'vegetation/plants';
  return theme;
}
