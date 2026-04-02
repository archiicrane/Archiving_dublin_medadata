"""
STAGE 2: REGION TYPE DETECTION

Classify meaningful regions in board images by type:
- title_block: Main board title area
- text_block: Paragraph/body text
- diagram: Schematic drawing/plan/section
- map: Geographic/density/site plan
- render: 3D visualization/perspective
- chart: Graphs/data visualization
- photo: Photographic content
- legend: Key/scale/reference
- blank_region: Low-information area
"""

from typing import Dict, List, Optional

import cv2
import numpy as np
from PIL import Image


def _compute_edge_density(region_gray: np.ndarray) -> float:
    """Compute edge density in region using Canny."""
    if region_gray.size == 0:
        return 0.0
    try:
        edges = cv2.Canny(region_gray, 50, 150)
        return float(np.sum(edges > 0) / (region_gray.size) if region_gray.size > 0 else 0.0)
    except Exception:
        return 0.0


def _compute_line_density(region_gray: np.ndarray) -> float:
    """Compute density of thin lines (likely technical drawing lines)."""
    if region_gray.size == 0:
        return 0.0
    try:
        # Use Hough line detection as proxy for technical drawing structure
        edges = cv2.Canny(region_gray, 50, 150)
        lines = cv2.HoughLinesP(edges, 1, np.pi/180, 30, minLineLength=50, maxLineGap=10)
        if lines is None:
            return 0.0
        return float(len(lines) / max(1, region_gray.shape[0] * region_gray.shape[1] / 5000.0))
    except Exception:
        return 0.0


def _compute_blankness(region_gray: np.ndarray) -> float:
    """Compute ratio of white/blank pixels."""
    if region_gray.size == 0:
        return 1.0
    try:
        # Pixels above 240 (very light) considered blank
        blank = np.sum(region_gray > 240)
        return float(blank / region_gray.size)
    except Exception:
        return 0.0


def _compute_compression_ratio(region: np.ndarray) -> float:
    """
    Use JPEG compression ratio as proxy for visual complexity.
    More compressible = simpler/blanker.
    Less compressible = more complex texture/detail.
    """
    if region.size == 0:
        return 0.0
    try:
        # Simple approach: encode to JPEG and check size ratio
        if len(region.shape) == 2:
            region_3ch = cv2.cvtColor(region, cv2.COLOR_GRAY2RGB)
        else:
            region_3ch = region
        
        success, encoded = cv2.imencode('.jpg', region_3ch, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if success and encoded is not None:
            original_size = region_3ch.nbytes
            compressed_size = encoded.nbytes
            ratio = compressed_size / original_size if original_size > 0 else 1.0
            # High ratio = less compressible = more complex
            return float(ratio)
        return 0.5
    except Exception:
        return 0.0


def _has_photo_characteristics(region: np.ndarray) -> bool:
    """
    Detect photographic content:
    - High color variation
    - Smooth gradients
    - Natural textures
    """
    if region.size == 0 or len(region.shape) != 3:
        return False
    
    try:
        # Convert to HSV
        hsv = cv2.cvtColor(region, cv2.COLOR_RGB2HSV)
        
        # High saturation + varied hue = likely photo
        sat_channel = hsv[:, :, 1].astype(float) / 255.0
        avg_sat = np.mean(sat_channel)
        
        # Smooth gradients (natural) vs sharp edges (technical)
        gray = cv2.cvtColor(region, cv2.COLOR_RGB2GRAY)
        edges = cv2.Canny(gray, 100, 200)
        edge_density = np.sum(edges > 0) / float(gray.size) if gray.size > 0 else 0.0
        
        # Photos have moderate saturation and moderate edges
        is_photo = (avg_sat > 0.25 and edge_density < 0.08)
        return bool(is_photo)
    except Exception:
        return False


def _has_chart_characteristics(region_gray: np.ndarray) -> bool:
    """
    Detect chart/graph content:
    - Distinct color blocks
    - Clear axes/boundaries
    - Regular geometric patterns
    """
    if region_gray.size == 0 or region_gray.shape[0] < 20 or region_gray.shape[1] < 20:
        return False
    
    try:
        # Detect vertical and horizontal lines (chart axes)
        edges = cv2.Canny(region_gray, 30, 100)
        
        # Check for grid-like patterns
        h_lines = cv2.HoughLinesP(edges, 1, np.pi/180, 20, minLineLength=30, maxLineGap=5)
        v_lines = cv2.HoughLinesP(
            edges, 1, np.pi/2, 20, minLineLength=30, maxLineGap=5
        )
        
        # Charts typically have multiple aligned lines
        has_grid = (h_lines is not None and len(h_lines) >= 2) or (v_lines is not None and len(v_lines) >= 2)
        return bool(has_grid)
    except Exception:
        return False


def _has_map_characteristics(region: np.ndarray) -> bool:
    """
    Detect map-like content:
    - Geographic patterns
    - Density variations
    - Site/plan structure
    """
    if region.size == 0 or len(region.shape) != 3:
        return False
    
    try:
        hsv = cv2.cvtColor(region, cv2.COLOR_RGB2HSV)
        h_channel = hsv[:, :, 0]
        
        # Maps often use specific color ranges (greens, blues for geography)
        green_mask = (h_channel >= 40) & (h_channel <= 80)
        blue_mask = (h_channel >= 100) & (h_channel <= 140)
        
        green_ratio = np.sum(green_mask) / green_mask.size
        blue_ratio = np.sum(blue_mask) / blue_mask.size
        
        # Maps have significant greenish or bluish content
        has_geo_colors = (green_ratio > 0.15 or blue_ratio > 0.15)
        
        return bool(has_geo_colors)
    except Exception:
        return False


def classify_region_type(
    image_path: str,
    region: Dict,
    text_blocks: List[Dict],
    board_level_edge_density: float = 0.0
) -> Dict:
    """
    Classify a region based on visual and textual features.
    
    Args:
        image_path: Path to full image
        region: Region dict with bbox (x, y, w, h)
        text_blocks: Extracted text blocks with roles
        board_level_edge_density: Context from full board
    
    Returns:
    {
        "type": "title_block|text_block|diagram|map|render|chart|photo|legend|blank_region",
        "confidence": 0.0-1.0,
        "reasoning": ["feature1", "feature2", ...],
        "extracted_text": "text inside this region if any",
        "visual_features": {
            "edge_density": float,
            "line_density": float,
            "blankness": float,
            "compression_ratio": float
        }
    }
    """
    try:
        x = int(region.get("x", 0))
        y = int(region.get("y", 0))
        w = int(region.get("width", 0))
        h = int(region.get("height", 0))
        
        # Read full image
        from PIL import Image
        pil_img = Image.open(image_path).convert("RGB")
        np_img = np.array(pil_img)
        
        # Extract region
        y_end = min(y + h, np_img.shape[0])
        x_end = min(x + w, np_img.shape[1])
        
        if y_end <= y or x_end <= x:
            return {
                "type": "blank_region",
                "confidence": 1.0,
                "reasoning": ["invalid_region"],
                "extracted_text": "",
                "visual_features": {}
            }
        
        region_rgb = np_img[y:y_end, x:x_end]
        region_gray = cv2.cvtColor(region_rgb, cv2.COLOR_RGB2GRAY)
        
        # Compute visual features
        edge_density = _compute_edge_density(region_gray)
        line_density = _compute_line_density(region_gray)
        blankness = _compute_blankness(region_gray)
        compression = _compute_compression_ratio(region_gray)
        
        visual_features = {
            "edge_density": round(edge_density, 3),
            "line_density": round(line_density, 3),
            "blankness": round(blankness, 3),
            "compression_ratio": round(compression, 3)
        }
        
        # Check for text in region (overlap with text blocks)
        text_in_region = []
        for block in text_blocks:
            bbox = block.get("bbox", {})
            bx = bbox.get("x", 0)
            by = bbox.get("y", 0)
            bw = bbox.get("w", 0)
            bh = bbox.get("h", 0)
            
            # Check overlap
            if (bx < x_end and bx + bw > x and
                by < y_end and by + bh > y):
                text_in_region.append({
                    "text": block["text"],
                    "role": block["role"],
                    "confidence": block["confidence"]
                })
        
        extracted_text = " ".join(t["text"] for t in text_in_region)
        has_text = len(text_in_region) > 0
        title_text = [t for t in text_in_region if t["role"] == "title"]
        heading_text = [t for t in text_in_region if t["role"] in ("title", "heading")]
        
        reasoning = []
        type_scores = {}
        
        # === CLASSIFICATION LOGIC ===
        
        # Check if blank
        if blankness > 0.85:
            type_scores["blank_region"] = 0.95
            reasoning.append(f"very_blank_{blankness:.2f}")
        
        # Check if title block (top region with title-role text)
        if title_text and (y / np_img.shape[0]) < 0.25:
            type_scores["title_block"] = 0.85
            reasoning.append("contains_title_text")
        elif heading_text and (y / np_img.shape[0]) < 0.35:
            type_scores["title_block"] = 0.60
            reasoning.append("contains_heading_text")
        
        # Text block detection
        if has_text and len(extracted_text) > 30 and heading_text is None:
            type_scores["text_block"] = max(type_scores.get("text_block", 0), 0.70)
            reasoning.append("body_text_content")
        
        # Legend detection (usually has label-role text, often on side)
        label_text = [t for t in text_in_region if t["role"] == "label"]
        if label_text:
            type_scores["legend"] = 0.75
            reasoning.append("legend_labels")
        
        # Photo detection
        if _has_photo_characteristics(region_rgb):
            type_scores["photo"] = 0.80
            reasoning.append("photo_characteristics")
        
        # Chart detection
        if _has_chart_characteristics(region_gray):
            type_scores["chart"] = 0.75
            reasoning.append("chart_structure")
        
        # Map detection
        if _has_map_characteristics(region_rgb):
            type_scores["map"] = max(type_scores.get("map", 0), 0.75)
            reasoning.append("geographic_colors")
        
        # Diagram detection (technical drawing)
        # High line density + moderate edges + no photo characteristics
        if (line_density > 0.10 and edge_density > 0.05 and
            edge_density < 0.25 and not _has_photo_characteristics(region_rgb)):
            type_scores["diagram"] = max(type_scores.get("diagram", 0), 0.75)
            reasoning.append(f"technical_drawing_lines_{line_density:.2f}")
        
        # Render detection (3D visualization)
        # High edge density + color variation + smooth areas
        if edge_density > 0.15 and compression > 0.7 and not _has_chart_characteristics(region_gray):
            type_scores["render"] = max(type_scores.get("render", 0), 0.65)
            reasoning.append("3d_like_edges")
        
        # Default: blank if low scores
        if not type_scores:
            return {
                "type": "blank_region",
                "confidence": 0.70,
                "reasoning": reasoning or ["low_information"],
                "extracted_text": extracted_text,
                "visual_features": visual_features
            }
        
        # Pick highest scoring type
        best_type = max(type_scores.items(), key=lambda x: x[1])
        
        return {
            "type": best_type[0],
            "confidence": round(best_type[1], 2),
            "reasoning": reasoning,
            "extracted_text": extracted_text,
            "visual_features": visual_features
        }
    
    except Exception as e:
        print(f"Region classification error: {e}")
        return {
            "type": "blank_region",
            "confidence": 0.5,
            "reasoning": [f"error: {str(e)}"],
            "extracted_text": "",
            "visual_features": {}
        }
