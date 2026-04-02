"""
STAGE 3: STRUCTURED IMAGE METADATA

Build rich, semantically-structured representation of each board.

Instead of treating each board as one flat image, structure it as:
{
  board metadata
  extracted text blocks (with roles and confidence)
  regions (with types and extracted contents)
  keywords and tags
}

This allows Stage 4 to make connections based on meaningful content types.
"""

from pathlib import Path
from typing import Dict, List, Optional

from .text_extractor import extract_text_blocks
from .region_classifier import classify_region_type


def extract_regions_for_classification(
    image_width: int,
    image_height: int,
    num_segments: int = 9
) -> List[Dict]:
    """
    Generate a grid of overlapping regions for classification.
    This gives us a spatial understanding of the board.
    
    Uses 3x3 grid with overlaps.
    """
    regions = []
    cols = rows = 3
    
    # Grid dimensions
    col_width = image_width / cols
    row_height = image_height / rows
    
    # Overlap factor (0.3 means 30% overlap)
    overlap = 0.3
    
    for r in range(rows):
        for c in range(cols):
            x = max(0, c * col_width - col_width * overlap / 2)
            y = max(0, r * row_height - row_height * overlap / 2)
            w = min(image_width - x, col_width * (1 + overlap))
            h = min(image_height - y, row_height * (1 + overlap))
            
            regions.append({
                "grid_id": f"r{r}c{c}",
                "row": r,
                "col": c,
                "x": int(x),
                "y": int(y),
                "width": int(w),
                "height": int(h)
            })
    
    return regions


def build_structured_board_metadata(
    item: Dict,
    image_path: Path
) -> Dict:
    """
    Build comprehensive structured metadata for a board.
    
    Combines:
    1. Basic metadata (ID, title, URL, year, etc.)
    2. Extracted text blocks (title, headings, body, labels)
    3. Classified regions (diagram, map, text, etc.)
    4. Extracted keywords and summary
    
    Args:
        item: Existing item dict with basic metadata
        image_path: Path to image file
    
    Returns:
    {
        "id": "...",
        "title": "...",
        "year": int,
        "boardTitle": "...",  # OCR-extracted board title
        "url": "...",
        
        # NEW: Semantic text extraction
        "extractedText": {
            "textBlocks": [...],
            "keywords": ["word1", "word2", ...],
            "summary": "...",
            "hasText": bool
        },
        
        # NEW: Semantic region classification
        "regions": [
            {
                "gridId": "r0c0",
                "type": "diagram|map|text|title|etc",
                "confidence": 0.85,
                "extractedText": "...",
                "visualFeatures": {...},
                "reasoning": [...]
            },
            ...
        ],
        
        # Region type summary
        "regionTypes": {
            "diagram": ["r1c1", "r2c2"],
            "map": ["r0c1"],
            "text": ["r1c0"],
            ...
        },
        
        # NEW: Semantic understanding
        "semanticTags": ["has_diagram", "has_map", "has_title", ...],
        "contentSummary": "2 diagrams, 1 map, title block with text"
    }
    """
    # Start with existing metadata
    structured = {
        "id": item.get("instance_id"),
        "image_id": item.get("image_id"),
        "title": item.get("title"),
        "year": item.get("year"),
        "type": item.get("type"),
        "url": item.get("url"),
        "boardTitle": item.get("canonical_board_title") or item.get("board_title"),
        "boardTitleConfidence": item.get("canonical_board_title_confidence", item.get("board_title_confidence", 0.0)),
    }
    
    # STAGE 1: Extract semantic text blocks
    try:
        text_result = extract_text_blocks(image_path)
        structured["extractedText"] = {
            "textBlocks": text_result["text_blocks"],
            "keywords": text_result["keywords"],
            "summary": text_result["summary"],
            "hasText": text_result["has_text"],
            "method": text_result["extraction_method"]
        }
    except Exception as e:
        print(f"Error extracting text for {image_path}: {e}")
        structured["extractedText"] = {
            "textBlocks": [],
            "keywords": [],
            "summary": "",
            "hasText": False,
            "method": "error"
        }
    
    # STAGE 2: Classify regions
    try:
        visual = item.get("visual", {})
        img_w = visual.get("width", 1200)
        img_h = visual.get("height", 900)
        
        # Generate grid regions
        grid_regions = extract_regions_for_classification(img_w, img_h)
        
        text_blocks = structured["extractedText"]["textBlocks"]
        
        # Classify each region
        classified_regions = []
        for grid_region in grid_regions:
            classification = classify_region_type(
                str(image_path),
                grid_region,
                text_blocks,
                visual.get("edge_density", 0.0)
            )
            
            region_summary = {
                "gridId": grid_region["grid_id"],
                "row": grid_region["row"],
                "col": grid_region["col"],
                "bbox": {
                    "x": grid_region["x"],
                    "y": grid_region["y"],
                    "w": grid_region["width"],
                    "h": grid_region["height"]
                },
                "type": classification["type"],
                "confidence": classification["confidence"],
                "extractedText": classification["extracted_text"][:100],  # Truncate
                "visualFeatures": classification["visual_features"],
                "reasoning": classification["reasoning"]
            }
            classified_regions.append(region_summary)
        
        structured["regions"] = classified_regions
        
    except Exception as e:
        print(f"Error classifying regions for {image_path}: {e}")
        structured["regions"] = []
    
    # Summarize region types
    region_types = {}
    for region in structured.get("regions", []):
        rtype = region["type"]
        if rtype not in region_types:
            region_types[rtype] = []
        region_types[rtype].append(region["gridId"])
    
    structured["regionTypes"] = region_types
    
    # Build semantic tags
    semantic_tags = set()
    
    if structured["extractedText"]["hasText"]:
        semantic_tags.add("has_text")
    
    if structured["extractedText"]["keywords"]:
        semantic_tags.add("has_keywords")
    
    for rtype, regions in region_types.items():
        if len(regions) > 0:
            semantic_tags.add(f"has_{rtype}")
    
    if structured["boardTitle"]:
        semantic_tags.add("has_board_title")
        if structured["boardTitleConfidence"] >= 0.70:
            semantic_tags.add("strong_board_title")
    
    structured["semanticTags"] = sorted(semantic_tags)
    
    # Build content summary
    summary_parts = []
    for rtype in sorted(region_types.keys()):
        count = len(region_types[rtype])
        if count > 0 and rtype != "blank_region":
            summary_parts.append(f"{count} {rtype}(s)")
    
    if structured["extractedText"]["keywords"]:
        top_keywords = structured["extractedText"]["keywords"][:3]
        summary_parts.append(f"keywords: {', '.join(top_keywords)}")
    
    structured["contentSummary"] = "; ".join(summary_parts) if summary_parts else "low-information board"
    
    return structured
