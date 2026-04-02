# Archive Metadata Extraction & Content-Aware Matching System

## Overview

This document describes the refactored archive matching system that moves from **blind local visual patch matching** to **content-aware, semantically-structured matching**.

The new system extracts meaningful contents from each board image and makes connections based on what the content actually is, rather than pixel-level visual similarity alone.

---

## Architecture: 8-Stage Pipeline

### Stage 1: Semantic Text Extraction

**Module:** `text_extractor.py`

Extracts OCR text from each image with semantic role classification.

**Process:**
1. Load image and enhance contrast via CLAHE
2. Run Tesseract OCR with per-word confidence scores
3. Clean OCR text (remove junk patterns, normalize whitespace)
4. Group words into lines and merge physically adjacent text blocks
5. Classify each text block by semantic role:
   - **title**: Board/section headline (detected by keyword matching, position, font size)
   - **heading**: Subsection, chapter, area label
   - **body**: Paragraph or descriptive text
   - **label**: Annotation, reference, scale label
   - **caption**: Figure description or source attribution

**Output per image:**
```json
{
  "extractedText": {
    "textBlocks": [
      {
        "text": "Example text",
        "role": "title|heading|body|label|caption",
        "confidence": 0.85,
        "bbox": { "x": 100, "y": 50, "w": 400, "h": 30 }
      }
    ],
    "keywords": ["word1", "word2", ...],
    "summary": "Human-readable summary of content",
    "hasText": true,
    "extraction_method": "tesseract_with_roles"
  }
}
```

**Key Features:**
- Rejects OCR junk (URLs, IDs, excessive symbols)
- Merges broken lines back together
- Filters low-confidence words (< 30% Tesseract confidence)
- Extracts keywords from titles/headings/labels only

---

### Stage 2: Region Type Detection

**Module:** `region_classifier.py`

Classifies visually meaningful regions by type.

**Process:**
1. Divide image into 3×3 grid with overlapping regions (spatial understanding)
2. For each region, compute visual features:
   - **Edge density**: Canny edge detection ratio
   - **Line density**: Count of technical drawing lines (Hough)
   - **Blankness**: Ratio of white/blank pixels (> 240/255)
   - **Compression ratio**: JPEG compressibility as texture proxy

3. Classify region type by heuristics:
   - **title_block**: Contains title-role text, high position, high confidence
   - **text_block**: Contains body text, no title text
   - **diagram**: High line density + moderate edges (technical drawing)
   - **map**: Geographic color patterns (greens, blues) or site plan keywords
   - **render**: High edge density + smooth areas (3D visualization)
   - **chart**: Grid-like structure from Hough line detection
   - **photo**: High saturation + moderate edges + natural colors
   - **legend**: Contains label-role text, usually lateral position
   - **blank_region**: > 85% blankness, low information

**Output per region:**
```json
{
  "gridId": "r0c0",
  "type": "title_block|diagram|map|...",
  "confidence": 0.85,
  "extractedText": "Text within this region",
  "visualFeatures": {
    "edge_density": 0.10,
    "line_density": 2.5,
    "blankness": 0.12,
    "compression_ratio": 0.15
  },
  "reasoning": ["contains_title_text", "technical_drawing_lines_2.50"]
}
```

**Key Features:**
- Spatial grid enables understanding of layout structure
- Each region is assessed independently
- Confidence scores indicate certainty of classification
- Reasoning field shows which features led to the decision

---

### Stage 3: Structured Board Metadata

**Module:** `structured_metadata.py`

Builds comprehensive, semantically-structured representation of each board.

**Process:**
1. Combine results from Stages 1 & 2
2. Build region type summary (map of type → list of grid IDs)
3. Extract board-level semantic tags:
   - `has_text`, `has_keywords`, `has_board_title`, `strong_board_title`
   - `has_diagram`, `has_map`, `has_render`, `has_chart`, `has_photo`
   - etc.

4. Generate human-readable content summary

**Output per board:**
```json
{
  "id": "instance_id",
  "title": "Board title from metadata",
  "boardTitle": "OCR-extracted board title",
  "boardTitleConfidence": 0.85,
  
  "extractedText": {
    "textBlocks": [...],
    "keywords": ["keyword1", "keyword2"],
    "summary": "Short summary",
    "hasText": true
  },
  
  "regions": [
    { "gridId": "r0c0", "type": "title_block", "confidence": 0.85, ... },
    { "gridId": "r0c1", "type": "diagram", "confidence": 0.75, ... },
    ...
  ],
  
  "regionTypes": {
    "title_block": ["r0c0"],
    "diagram": ["r0c1", "r1c1"],
    "map": ["r2c0"],
    "blank_region": ["r2c2"]
  },
  
  "semanticTags": ["has_text", "has_diagram", "has_title_block", ...],
  "contentSummary": "2 diagrams, 1 map; keywords: urban, vacancy, intervention"
}
```

---

### Stage 4: Content-Aware Pair Scoring

**Module:** `content_matcher.py`

Scores board pairs based on extracted content types and text similarity.

**Scoring Logic:**

#### Text Block ↔ Text Block
- Compute word-level Jaccard similarity (shared keywords)
- Merge character-level similarity (phrases)
- Score: 0.0-1.0 based on overlap strength

#### Diagram ↔ Diagram
- Compare line density similarity
- Compare edge density similarity
- Score: 0.0-1.0 based on structural match

#### Map ↔ Map
- Check for geographic keywords ("block", "site", "density", "vacant")
- Check for geographic color patterns
- Score: 0.0-1.0 based on geospatial similarity

#### Cross-Board Scoring
Returns:
```json
{
  "content_score": 0.42,           // 0.0-1.0
  "connection_types": ["text_match", "diagram_match"],
  "region_matches": [
    {
      "source_grid_id": "r0c0",
      "target_grid_id": "r1c1",
      "source_type": "diagram",
      "target_type": "diagram",
      "score": 0.70,
      "basis": "diagram_match",
      "explanation": "diagram_structure_sim_0.70"
    }
  ]
}
```

**Key Rules:**
- Only matches compatible types (text ↔ text, diagram ↔ diagram, etc.)
- Blank regions rarely match (≤ 0.15 score)
- Title blocks match based on text similarity
- Down-weights weak matches automatically

---

### Stage 5: Content-Based Explanation Generation

**Module:** `content_matcher.py`

Generates human-readable explanations based on what was extracted.

**Example Explanations:**

- "Strong content-based match; Similar titled boards: 'Urban Design Principles'; Shared keywords: population, density, intervention; Diagram structure match: 2 diagrams"

- "Moderate match; Shared keywords: site, intervention; Diagram structure match"

- "Weak match based on extracted content; Both contain geographic/map content; Keywords: block, site"

**Output in Edge:**
```json
{
  "source": "board1",
  "target": "board2",
  "connectionTypes": ["content_aware_match", "diagram_match"],
  "explanation": "content-aware match (0.42) — Moderate match; Shared keywords: city, growth; Diagram structure match; local visual pattern match ...",
  "evidenceKinds": ["content_structure", "visual_pattern", ...],
  "sourceSystems": ["content_aware_matcher", "local_feature_matcher", ...]
}
```

---

### Stage 6: Integration with Visual Matching

The new content-aware system **coexists with** the existing visual matching system.

**Scoring Weights:**
- Semantic similarity: 35%
- Metadata relation: 30%
- Composition similarity: 20%
- OCR text relation: 15%
- **Content-aware match: 40%** (NEW, highest priority if available)

When a board pair is scored:
1. Compute all traditional scores (visual, metadata, composition, OCR)
2. Compute content-aware score (new)
3. If content-aware score is significant (>0.2), weight it prominently
4. Final score is min(1.0, sum of components)

This means:
- **High-quality content matches are prioritized**
- Traditional visual/semantic matching remains as fallback
- Random patch matches are down-ranked by content-aware filtering

---

### Stage 7: Enhanced Title Extraction

Board title extraction uses:
1. OCR on top portion of image with contrast enhancement
2. Per-word confidence scoring (retain words with conf ≥ 55%)
3. Heuristic filtering:
   - Reject clipped fragments (e.g., "ew Urban Block")
   - Reject mostly-numeric lines
   - Reject lines that are all-caps (likely labels)
   - Reject lines with too many digits or special chars

4. Canonicalization across project:
   - Group similar titles by project
   - Select best (highest confidence) title as canonical
   - Apply substring rescue: if short title is substring of better title, promote better one

---

### Stage 8: Backend API Integration

**Routes in `api_server.py`:**

```
POST /api/extract-board-title
  Input: { "url": "https://..." }
  Output: { "title": "...", "confidence": 0.85, "source": "ocr" }

POST /api/extract-image-metadata
  Input: { "url": "https://..." }
  Output: <Full structured metadata from Stage 3>

POST /api/explain-connection
  Input: { "source_id": "...", "target_id": "..." }
  Output: { "explanation": "...", "bases": ["text_match", "diagram_match"] }
```

All responses are cached. If OpenAI key is available, LLM can refine explanations remotely.

---

## Key Improvements Over Old System

| Aspect | Old System | New System |
|--------|-----------|-----------|
| **Matching Basis** | ORB keypoints (visual patches) | Extracted content types (text, diagrams, maps) |
| **Text Matching** | Word overlap in OCR | Semantic text block classification + role-aware comparison |
| **Region Understanding** | Generic metrics | 9-region grid with type classification |
| **Invalid Matches** | ✗ Matches random fragments | ✓ Filters blank regions, incompatible types |
| **Explanations** | Generic ("edges similar") | Specific ("Both contain text about urban renewal; diagram structure match") |
| **Board Structure** | Flat image | Structured (text blocks, regions, types) |
| **Weak Match Handling** | Same treatment as strong | ✓ Explicitly flagged and can be filtered |

---

## Data Output Changes

### Metadata JSON
New fields per image:
- `extractedText.textBlocks` - Text with roles and confidence
- `extractedText.keywords` - Extracted keywords
- `regions` - 9 grid regions with types
- `regionTypes` - Summary map of type → grid IDs
- `semanticTags` - Board-level feature flags
- `contentSummary` - Human-readable summary

### Region Connections JSON
Updated with:
- Connection basis (text_match, diagram_match, map_match, etc.)
- Source systems (content_aware_matcher, local_feature_matcher, etc.)
- Evidence kinds (content_structure, visual_pattern, etc.)

### Image Graph JSON (Edges)
Updates:
- `connectionTypes` includes "content_aware_match"
- `explanation` includes content-aware reasoning
- `sourceSystems` includes content_aware_matcher

---

## Performance

- **Text Extraction (Stage 1):** ~4-6 seconds per image
- **Region Classification (Stage 2):** ~1-2 seconds per image
- **Structured Metadata Build (Stage 3):** ~5-7 seconds per image total
- **Content-Aware Scoring (Stage 4):** ~10-20ms per board pair (negligible)
- **Total pipeline time:** ~2-3x slower than before, worth it for semantic understanding

Bottleneck is OCR + image loading. Can be optimized with caching and parallel processing.

---

## Frontend Integration

Frontend receives in metadata:
```json
{
  "extractedText": {...},
  "regions": [...],
  "regionTypes": {...},
  "semanticTags": [...],
  "contentSummary": "..."
}
```

UI enhancements can include:
- Modal overlay showing detected text blocks on demand
- Region type visualization (color-code regions by type)
- Connection explanation panel with matched content highlighted
- Filter by connection basis (text-only, diagram-only, map-only)
- Show "matched because" reasoning to user

---

## Usage Example

```bash
# Build full structured metadata for all images
cd backend
python -m archive_ai.cli --max-images 0

# Check a specific image
python -c "
import json
m = json.load(open('data/processed/image_metadata.json'))
img = m[0]
print(f\"Board: {img['boardTitle']}\")
print(f\"Region types: {img['regionTypes']}\")
print(f\"Content summary: {img['contentSummary']}\")
print(f\"Semantic tags: {img['semanticTags']}\")
"

# Inspect edges
python -c "
import json
g = json.load(open('data/processed/image_graph.json'))
for edge in g['edges'][:5]:
    if 'content_aware_match' in edge['connectionTypes']:
        print(f\"Content-based edge: {edge['source']} -> {edge['target']}\")
        print(f\"  Explanation: {edge['explanation'][:100]}...\")
"
```

---

## Limitations & Future Work

1. **Region Grid is Fixed**: Could use semantic segmentation (like SAM) for better region detection
2. **OCR Quality**: Dependent on image quality, contrast
3. **Text Role Heuristics**: Could be improved with LLM classification
4. **No Deep Learning**: Could use vision transformers for region classification
5. **Map Detection**: Currently simple color heuristics, could use geographic data detection
6. **Content Caching**: Could cache extracted features to avoid re-processing

---

## Troubleshooting

**Issue:** "No content-aware matches being detected"
- Check if `content_matcher.py` is being imported in `connection_builder.py`
- Verify structured metadata is being built (check `extractedText` field in metadata)
- Check content_score threshold in connection_builder.py

**Issue:** "OCR text is very noisy"
- Increase `_WORD_CONF_THRESHOLD` in `text_extractor.py` (currently 55)
- Improve image contrast before OCR (currently using CLAHE)

**Issue:** "Regions are misclassified"
- Adjust thresholds in `region_classifier.py` (e.g., blankness > 0.85)
- Check `_compute_edge_density`, `_compute_line_density` implementations

