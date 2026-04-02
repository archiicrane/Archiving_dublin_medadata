"""
STAGE 4-5: CONTENT-AWARE CONNECTION MATCHING

Make connections between boards based on extracted content types.
Rules:
1. Text block ↔ Text block (compare OCR semantically)
2. Diagram ↔ Diagram (compare visual diagrams)
3. Map ↔ Map (compare geospatial)
4. Region type must match or be compatible
5. Weak/blank regions are down-ranked

Generate explanations based on actual extracted content.
"""

import re
from typing import Dict, List, Optional, Tuple

import numpy as np


def _normalize_text(text: str) -> str:
    """Normalize text for comparison."""
    text = str(text).lower()
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def _text_similarity(a: str, b: str) -> float:
    """
    Compute semantic similarity of two text blocks.
    Uses: shared keywords, phrase overlap, character similarity.
    """
    if not a or not b:
        return 0.0
    
    na = _normalize_text(a)
    nb = _normalize_text(b)
    
    if not na or not nb:
        return 0.0
    
    # Word-level Jaccard similarity
    words_a = set(na.split())
    words_b = set(nb.split())
    
    if not words_a or not words_b:
        return 0.0
    
    intersection = len(words_a & words_b)
    union = len(words_a | words_b)
    
    jaccard = intersection / union if union > 0 else 0.0
    
    # Also check position of overlapping words (phrases)
    phrase_bonus = 0.0
    if intersection > 1:
        # If multiple words overlap, likely phrases match
        phrase_bonus = min(0.2, intersection * 0.05)
    
    return min(1.0, jaccard + phrase_bonus)


def _keywords_similarity(keywords_a: List[str], keywords_b: List[str]) -> float:
    """Compute similarity based on extracted keywords."""
    if not keywords_a or not keywords_b:
        return 0.0
    
    set_a = set(keywords_a)
    set_b = set(keywords_b)
    
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    
    return intersection / union if union > 0 else 0.0


def _is_compatible_type_pair(type_a: str, type_b: str) -> bool:
    """
    Check if two region types are compatible for matching.
    
    Compatibility rules:
    - Same type = compatible
    - diagram ↔ diagram
    - map ↔ map
    - text_block ↔ text_block
    - etc.
    - blank/title/legend are rarely good matches
    """
    # Blank regions rarely match meaningfully
    if type_a == "blank_region" or type_b == "blank_region":
        return False
    
    # Exact match
    if type_a == type_b:
        return True
    
    # Some type pairs are acceptable
    diagram_like = {"diagram", "render", "chart"}
    geospatial = {"map", "site_plan"}
    
    if type_a in diagram_like and type_b in diagram_like:
        return True
    if type_a in geospatial and type_b in geospatial:
        return True
    
    return False


def _score_text_block_pair(
    src_region: Dict,
    tgt_region: Dict,
    src_text_blocks: List[Dict],
    tgt_text_blocks: List[Dict]
) -> Tuple[float, str]:
    """
    Score a text block ↔ text block region pair.
    
    Returns: (score 0.0-1.0, explanation string)
    """
    src_text = src_region.get("extractedText", "")
    tgt_text = tgt_region.get("extractedText", "")
    
    if not src_text or not tgt_text:
        return 0.0, "no_text_in_regions"
    
    # Text similarity
    text_sim = _text_similarity(src_text, tgt_text)
    
    # If text similarity is high, good match
    if text_sim > 0.6:
        return text_sim, f"text_blocks_overlap_{text_sim:.2f}"
    
    # Otherwise low score for text blocks
    return text_sim * 0.5, f"weak_text_similarity_{text_sim:.2f}"


def _score_diagram_pair(
    src_region: Dict,
    tgt_region: Dict,
    src_metrics: Optional[Dict] = None,
    tgt_metrics: Optional[Dict] = None
) -> Tuple[float, str]:
    """
    Score a diagram ↔ diagram region pair.
    
    Uses: line density, edge density, complexity.
    """
    src_vf = src_region.get("visualFeatures", {})
    tgt_vf = tgt_region.get("visualFeatures", {})
    
    src_lines = src_vf.get("line_density", 0.0)
    tgt_lines = tgt_vf.get("line_density", 0.0)
    
    src_edges = src_vf.get("edge_density", 0.0)
    tgt_edges = tgt_vf.get("edge_density", 0.0)
    
    # Both should have notable line/edge structure
    if src_lines < 0.05 or tgt_lines < 0.05:
        return 0.2, "low_line_density"
    
    # Similarity of line density
    line_diff = abs(src_lines - tgt_lines)
    line_sim = max(0.0, 1.0 - line_diff)
    
    # Similarity of edge density
    edge_diff = abs(src_edges - tgt_edges)
    edge_sim = max(0.0, 1.0 - edge_diff)
    
    combined = (line_sim + edge_sim) / 2.0
    
    return combined, f"diagram_structure_sim_{combined:.2f}"


def _score_map_pair(
    src_region: Dict,
    tgt_region: Dict
) -> Tuple[float, str]:
    """
    Score a map ↔ map region pair.
    
    Uses: color distribution (geographic colors), compression ratio (complexity).
    """
    src_vf = src_region.get("visualFeatures", {})
    tgt_vf = tgt_region.get("visualFeatures", {})
    
    src_text = src_region.get("extractedText", "")
    tgt_text = tgt_region.get("extractedText", "")
    
    # Geographic keywords
    geo_keywords = {"block", "site", "area", "zone", "land", "density", "vacant", "developed"}
    has_geo_src = any(kw in _normalize_text(src_text) for kw in geo_keywords)
    has_geo_tgt = any(kw in _normalize_text(tgt_text) for kw in geo_keywords)
    
    if has_geo_src and has_geo_tgt:
        return 0.75, "geographic_keyword_match"
    
    # Compression ratio similarity (maps have distinctive compression)
    src_comp = src_vf.get("compression_ratio", 0.5)
    tgt_comp = tgt_vf.get("compression_ratio", 0.5)
    
    comp_diff = abs(src_comp - tgt_comp)
    comp_sim = max(0.0, 1.0 - comp_diff)
    
    return comp_sim, f"map_structure_sim_{comp_sim:.2f}"


def score_region_pair(
    src_record: Dict,
    tgt_record: Dict,
    src_region: Dict,
    tgt_region: Dict,
    src_text_blocks: List[Dict],
    tgt_text_blocks: List[Dict]
) -> Tuple[float, str, str]:
    """
    Score a region pair for connection.
    
    Returns:
        (confidence_score, explanation, content_basis)
    """
    src_type = src_region.get("type", "unknown")
    tgt_type = tgt_region.get("type", "unknown")
    
    # Check type compatibility
    if not _is_compatible_type_pair(src_type, tgt_type):
        return 0.0, f"incompatible_types_{src_type}_vs_{tgt_type}", "type_incompatible"
    
    # Blank regions are weak
    if src_type == "blank_region" or tgt_type == "blank_region":
        return 0.15, f"weak_blank_region_match", "weak_region_match"
    
    # Type-specific scoring
    if src_type == "text_block" and tgt_type == "text_block":
        score, reason = _score_text_block_pair(src_region, tgt_region, src_text_blocks, tgt_text_blocks)
        return score, reason, "text_match"
    
    elif src_type == "diagram" and tgt_type == "diagram":
        score, reason = _score_diagram_pair(src_region, tgt_region)
        return score, reason, "diagram_match"
    
    elif src_type == "render" and tgt_type == "render":
        score, reason = _score_diagram_pair(src_region, tgt_region)
        return score, reason, "render_match"
    
    elif src_type == "chart" and tgt_type == "chart":
        score, reason = _score_diagram_pair(src_region, tgt_region)
        return score, reason, "chart_match"
    
    elif src_type == "map" and tgt_type == "map":
        score, reason = _score_map_pair(src_region, tgt_region)
        return score, reason, "map_match"
    
    elif src_type == "photo" and tgt_type == "photo":
        # Photos hard to compare, use conservative score
        return 0.3, "photo_region_match", "photo_match"
    
    else:
        # Same type but not specifically handled
        return 0.4, f"same_type_{src_type}", "type_match"


def score_board_pair_content_aware(
    src_record: Dict,
    tgt_record: Dict
) -> Tuple[float, List[str], List[Dict]]:
    """
    Score a board pair using extracted content.
    
    Uses:
    1. Board titles (if available)
    2. Extracted keywords
    3. Region type compatibility
    4. Text block overlap
    
    Returns:
        (confidence_score 0.0-1.0, connection_types ['text_basis', 'diagram_basis', ...], region_matches [...])
    """
    score_components = []
    connection_types = []
    region_matches = []
    
    # Extract board text
    src_title = src_record.get("boardTitle", "")
    tgt_title = tgt_record.get("boardTitle", "")
    src_text = src_record.get("extractedText", {})
    tgt_text = tgt_record.get("extractedText", {})
    src_regions = src_record.get("regions", [])
    tgt_regions = tgt_record.get("regions", [])
    
    # 1. Title similarity
    if src_title and tgt_title:
        title_sim = _text_similarity(src_title, tgt_title)
        if title_sim > 0.5:
            score_components.append(title_sim * 0.25)
            connection_types.append("title_similarity")
    
    # 2. Keywords (board-level)
    src_keywords = src_text.get("keywords", [])
    tgt_keywords = tgt_text.get("keywords", [])
    if src_keywords and tgt_keywords:
        kw_sim = _keywords_similarity(src_keywords, tgt_keywords)
        if kw_sim > 0.15:
            score_components.append(kw_sim * 0.15)
            connection_types.append("keyword_match")
    
    # 3. Region type overlap (e.g., both have diagrams)
    src_types = set(src_record.get("regionTypes", {}).keys())
    tgt_types = set(tgt_record.get("regionTypes", {}).keys())
    src_types.discard("blank_region")
    tgt_types.discard("blank_region")
    
    type_overlap = src_types & tgt_types
    if type_overlap:
        type_sim = len(type_overlap) / max(1, len(src_types | tgt_types))
        score_components.append(type_sim * 0.20)
        connection_types.append("region_type_overlap")
    
    # 4. Region-level matching
    best_region_matches = []
    for src_r in src_regions:
        src_type = src_r.get("type", "")
        if src_type == "blank_region":
            continue
        for tgt_r in tgt_regions:
            tgt_type = tgt_r.get("type", "")
            if tgt_type == "blank_region":
                continue
            
            region_score, explanation, basis = score_region_pair(
                src_record, tgt_record, src_r, tgt_r, 
                src_text.get("textBlocks", []),
                tgt_text.get("textBlocks", [])
            )
            
            if region_score > 0.25:
                best_region_matches.append({
                    "source_grid_id": src_r["gridId"],
                    "target_grid_id": tgt_r["gridId"],
                    "source_type": src_type,
                    "target_type": tgt_type,
                    "score": region_score,
                    "basis": basis,
                    "explanation": explanation
                })
    
    # Sort by score and keep top matches
    best_region_matches.sort(key=lambda x: x["score"], reverse=True)
    region_matches = best_region_matches[:5]
    
    if region_matches:
        avg_region_score = sum(m["score"] for m in region_matches) / len(region_matches)
        score_components.append(avg_region_score * 0.40)
        bases = set(m["basis"] for m in region_matches)
        connection_types.extend(sorted(bases))
    
    # Final score
    if not score_components:
        return 0.0, [], []
    
    total_score = float(min(1.0, sum(score_components)))
    
    return total_score, connection_types, region_matches


def generate_content_based_explanation(
    src_record: Dict,
    tgt_record: Dict,
    region_matches: List[Dict],
    connection_types: List[str],
    overall_score: float
) -> str:
    """
    Generate human-readable explanation based on extracted content.
    
    Examples:
    - "These boards share diagram-based content: both contain technical planning diagrams"
    - "Connected by title and keyword match: both about 'urban renewal'"
    - "Text-based connection: shared references to 'density' and 'intervention'"
    """
    parts = []
    
    # From board titles
    src_title = src_record.get("boardTitle", "")
    tgt_title = tgt_record.get("boardTitle", "")
    
    if src_title and tgt_title and _text_similarity(src_title, tgt_title) > 0.5:
        parts.append(f"Similar titled boards: '{src_title}'")
    
    # From keywords
    src_kw = src_record.get("extractedText", {}).get("keywords", [])
    tgt_kw = tgt_record.get("extractedText", {}).get("keywords", [])
    shared_kw = set(src_kw) & set(tgt_kw)
    if shared_kw:
        kw_list = ", ".join(sorted(list(shared_kw))[:3])
        parts.append(f"Shared keywords: {kw_list}")
    
    # From region type matches
    if region_matches:
        detailed_bases = {}
        for match in region_matches:
            basis = match["basis"]
            if basis not in detailed_bases:
                detailed_bases[basis] = []
            detailed_bases[basis].append(
                f"{match['source_type']}/{match['target_type']}"
            )
        
        for basis, type_pairs in detailed_bases.items():
            if basis == "text_match":
                parts.append(f"Text block similarity detected")
            elif basis == "diagram_match":
                parts.append(f"Diagram structure match: {len(type_pairs)} diagram(s)")
            elif basis == "map_match":
                parts.append(f"Geographic/map content match")
            elif basis == "render_match":
                parts.append(f"3D visualization match")
            elif basis == "chart_match":
                parts.append(f"Chart/graph structure match")
            elif basis == "photo_match":
                parts.append(f"Photography content match")
    
    # Confidence note
    if overall_score < 0.35:
        parts.insert(0, "Weak match based on extracted content")
    elif overall_score < 0.55:
        parts.insert(0, "Moderate match")
    elif overall_score < 0.75:
        parts.insert(0, "Strong content-based match")
    else:
        parts.insert(0, "Excellent content match")
    
    return "; ".join(parts) if parts else "Content-based board connection"
