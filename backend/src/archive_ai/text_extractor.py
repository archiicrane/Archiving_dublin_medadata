"""
STAGE 1: SEMANTIC TEXT EXTRACTION

Extract text from images with semantic roles and confidence.
Handles OCR cleaning, text grouping by role (title, heading, body, label).
"""

import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

try:
    import pytesseract
except Exception:
    pytesseract = None


# Text role heuristics
_TITLE_KEYWORDS = {"title", "main", "principal", "primary", "heading", "subject"}
_HEADING_KEYWORDS = {"chapter", "section", "part", "phase", "area", "zone", "level"}
_LABEL_KEYWORDS = {"label", "key", "legend", "scale", "north", "ref", "note", "annotation"}
_CAPTION_KEYWORDS = {"caption", "figure", "fig", "description", "note", "source"}


def _estimate_text_role(text: str, y_fraction: float, font_size_px: int) -> str:
    """
    Estimate the semantic role of a text block based on:
    - Content keywords
    - Position (top = more likely title)
    - Font size (larger = more likely title/heading)
    
    Returns one of: "title", "heading", "label", "caption", "body"
    """
    text_lower = text.lower()
    
    # Font size heuristic: larger text is likely more important
    size_score = min(1.0, font_size_px / 32.0)  # 32px is "large"
    
    # Position heuristic: text at top is more likely title
    pos_score = max(0.0, 1.0 - (y_fraction * 1.5))
    
    # Keyword matches
    title_match = any(kw in text_lower for kw in _TITLE_KEYWORDS)
    heading_match = any(kw in text_lower for kw in _HEADING_KEYWORDS)
    label_match = any(kw in text_lower for kw in _LABEL_KEYWORDS)
    caption_match = any(kw in text_lower for kw in _CAPTION_KEYWORDS)
    
    # Decision logic
    if title_match and (size_score > 0.6 or pos_score > 0.7):
        return "title"
    if heading_match and (size_score > 0.4 or pos_score > 0.5):
        return "heading"
    if caption_match:
        return "caption"
    if label_match:
        return "label"
    
    # Default: if large and at top, likely body (paragraph)
    if size_score > 0.3 or pos_score > 0.4:
        return "body"
    
    # Otherwise body text
    return "body"


def _clean_ocr_text(text: str) -> str:
    """
    Clean OCR output by:
    - Normalizing whitespace
    - Removing junk characters
    - Merging broken lines
    """
    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text.strip())
    
    # Remove common OCR junk patterns
    text = re.sub(r'[`|¬|„|‟|ʻ]', '', text)
    
    # Remove excessive special characters (keep basic punctuation)
    text = re.sub(r'[^\w\s.,;:\-\'\"()&%/$#@!?]', '', text)
    
    # Re-normalize after cleanup
    text = re.sub(r'\s+', ' ', text.strip())
    
    return text


def _is_meaningful_text(text: str, min_length: int = 3) -> bool:
    """Check if OCR text is meaningful (not junk/noise)."""
    if not text or len(text) < min_length:
        return False
    
    # Reject purely numeric or symbol lines
    letters = sum(1 for c in text if c.isalpha())
    if letters < max(2, len(text) * 0.35):
        return False
    
    # Reject URLs and emails
    if re.search(r'https?://|www\.|[a-z]+@[a-z]+\.[a-z]+', text.lower()):
        return False
    
    return True


def _group_nearby_text_blocks(
    text_blocks: List[Dict],
    proximity_pixels: int = 15
) -> List[Dict]:
    """
    Merge text blocks that are very close together vertically.
    Helps recover text broken across OCR scan lines.
    """
    if not text_blocks:
        return []
    
    # Sort by vertical position
    sorted_blocks = sorted(text_blocks, key=lambda b: b["bbox"]["y"])
    
    merged = []
    current_group = [sorted_blocks[0]]
    
    for block in sorted_blocks[1:]:
        prev_bottom = current_group[-1]["bbox"]["y"] + current_group[-1]["bbox"]["h"]
        curr_top = block["bbox"]["y"]
        
        # If blocks are close vertically and similar height
        if curr_top - prev_bottom <= proximity_pixels:
            current_group.append(block)
        else:
            # Merge current group
            merged_block = _merge_text_group(current_group)
            merged.append(merged_block)
            current_group = [block]
    
    # Don't forget last group
    if current_group:
        merged_block = _merge_text_group(current_group)
        merged.append(merged_block)
    
    return merged


def _merge_text_group(blocks: List[Dict]) -> Dict:
    """Merge multiple text blocks into one."""
    texts = [b["text"] for b in blocks]
    merged_text = " ".join(texts)
    
    min_y = min(b["bbox"]["y"] for b in blocks)
    max_y = max(b["bbox"]["y"] + b["bbox"]["h"] for b in blocks)
    min_x = min(b["bbox"]["x"] for b in blocks)
    max_x = max(b["bbox"]["x"] + b["bbox"]["w"] for b in blocks)
    
    # Average confidence
    avg_conf = sum(b["confidence"] for b in blocks) / len(blocks)
    
    # Use role of highest-confidence block
    role = blocks[0].get("role", "body")
    
    return {
        "text": merged_text,
        "confidence": avg_conf,
        "role": role,
        "bbox": {
            "x": min_x,
            "y": min_y,
            "w": max_x - min_x,
            "h": max_y - min_y
        }
    }


def extract_text_blocks(image_path: Path) -> Dict:
    """
    Extract semantic text blocks from an image.
    
    Returns:
    {
        "text_blocks": [
            {
                "text": "...",
                "role": "title|heading|body|label|caption",
                "confidence": 0.0-1.0,
                "bbox": {"x": px, "y": px, "w": px, "h": px}
            },
            ...
        ],
        "summary": "human-readable summary of extracted content",
        "keywords": ["word1", "word2", ...],
        "has_text": bool,
        "extraction_method": "tesseract_with_roles"
    }
    """
    empty = {
        "text_blocks": [],
        "summary": "",
        "keywords": [],
        "has_text": False,
        "extraction_method": "none"
    }
    
    if pytesseract is None:
        return empty
    
    try:
        # Load image
        pil_img = Image.open(image_path).convert("RGB")
        np_img = np.array(pil_img)
        h, w = np_img.shape[:2]
        
        # Enhance contrast for better OCR
        gray = cv2.cvtColor(np_img, cv2.COLOR_RGB2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        enhanced_pil = Image.fromarray(enhanced)
        
        # Extract text with bboxes and confidence
        tess_config = "--psm 6"  # Assume single column of text
        data = pytesseract.image_to_data(
            enhanced_pil, config=tess_config, output_type=pytesseract.Output.DICT
        )
        
        text_blocks = []
        
        # Group by "line" (from Tesseract output)
        line_groups = {}
        for i in range(len(data["text"])):
            if not data["text"][i] or data["text"][i].strip() == "":
                continue
            
            conf = int(data["conf"][i])
            if conf < 30:  # Very low confidence
                continue
            
            line_num = data["block_num"][i]
            if line_num not in line_groups:
                line_groups[line_num] = []
            
            line_groups[line_num].append({
                "text": data["text"][i],
                "conf": conf,
                "x": int(data["left"][i]),
                "y": int(data["top"][i]),
                "w": int(data["width"][i]),
                "h": int(data["height"][i])
            })
        
        # Merge words into text blocks (one per Tesseract line)
        for line_items in line_groups.values():
            if not line_items:
                continue
            
            # Merge words in the line
            line_text = " ".join(item["text"] for item in line_items)
            line_text = _clean_ocr_text(line_text)
            
            if not _is_meaningful_text(line_text):
                continue
            
            # Compute bounding box for entire line
            min_x = min(item["x"] for item in line_items)
            max_x = max(item["x"] + item["w"] for item in line_items)
            min_y = min(item["y"] for item in line_items)
            max_y = max(item["y"] + item["h"] for item in line_items)
            
            # Average confidence (0-100 → 0.0-1.0)
            avg_conf = sum(item["conf"] for item in line_items) / len(line_items) / 100.0
            
            # Estimate font size (relative to image height)
            approx_font_size = max_y - min_y
            
            # Estimate text role
            y_fraction = min_y / h if h > 0 else 0.5
            role = _estimate_text_role(line_text, y_fraction, approx_font_size)
            
            text_blocks.append({
                "text": line_text,
                "role": role,
                "confidence": float(min(1.0, avg_conf)),
                "bbox": {
                    "x": float(min_x),
                    "y": float(min_y),
                    "w": float(max_x - min_x),
                    "h": float(max_y - min_y)
                }
            })
        
        # Group nearby text blocks
        text_blocks = _group_nearby_text_blocks(text_blocks, proximity_pixels=12)
        
        # Extract keywords (all unique words from title/heading blocks)
        keywords = set()
        for block in text_blocks:
            if block["role"] in ("title", "heading", "label"):
                words = re.findall(r'\b\w+\b', block["text"].lower())
                keywords.update(w for w in words if len(w) > 2)
        
        # Build summary
        summary_parts = []
        for role in ("title", "heading", "label"):
            role_texts = [b["text"] for b in text_blocks if b["role"] == role]
            if role_texts:
                summary_parts.append(" / ".join(role_texts[:3]))
        
        summary = " | ".join(summary_parts) if summary_parts else ""
        
        return {
            "text_blocks": text_blocks,
            "summary": summary[:200],  # Truncate
            "keywords": sorted(keywords),
            "has_text": len(text_blocks) > 0,
            "extraction_method": "tesseract_with_roles"
        }
        
    except Exception as e:
        print(f"Text extraction error: {e}")
        return empty
