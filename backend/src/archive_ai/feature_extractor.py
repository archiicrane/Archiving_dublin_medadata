import hashlib
import json
import math
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np
import requests
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True

try:
    import pytesseract

    # Set the Tesseract binary path explicitly so it works on Windows
    # even when the installer does not add it to PATH automatically.
    _TESS_CANDIDATES = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ]
    for _p in _TESS_CANDIDATES:
        if Path(_p).exists():
            pytesseract.pytesseract.tesseract_cmd = _p
            break
except Exception:  # pragma: no cover
    pytesseract = None

try:
    from sentence_transformers import SentenceTransformer
except Exception:  # pragma: no cover
    SentenceTransformer = None


def _cache_path_for_url(cache_dir: Path, url: str) -> Path:
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()
    return cache_dir / f"{digest}.jpg"


def fetch_image(cache_dir: Path, url: str, timeout: int = 20) -> Optional[Path]:
    cache_path = _cache_path_for_url(cache_dir, url)
    if cache_path.exists():
        return cache_path

    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
        cache_path.write_bytes(response.content)
        return cache_path
    except Exception:
        return None


def extract_visual_features(image_path: Path) -> Dict:
    try:
        pil_img = Image.open(image_path).convert("RGB")
        np_img = np.array(pil_img)
    except Exception:
        np_img = cv2.imread(str(image_path))
        if np_img is None:
            return {
                "width": 0,
                "height": 0,
                "color_histogram": [],
                "edge_density": 0.0,
                "orb_keypoints": [],
                "orb_descriptors": [],
            }
        np_img = cv2.cvtColor(np_img, cv2.COLOR_BGR2RGB)
    h, w = np_img.shape[:2]

    hsv = cv2.cvtColor(np_img, cv2.COLOR_RGB2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 8, 8], [0, 180, 0, 256, 0, 256])
    hist = cv2.normalize(hist, hist).flatten().astype(float)

    gray = cv2.cvtColor(np_img, cv2.COLOR_RGB2GRAY)
    edges = cv2.Canny(gray, 100, 200)
    edge_density = float(edges.mean() / 255.0)

    orb = cv2.ORB_create(nfeatures=500)
    keypoints, descriptors = orb.detectAndCompute(gray, None)

    top_keypoints = []
    for kp in (keypoints or [])[:120]:
        top_keypoints.append([float(kp.pt[0]), float(kp.pt[1])])

    return {
        "width": w,
        "height": h,
        "color_histogram": hist.tolist(),
        "edge_density": edge_density,
        "orb_keypoints": top_keypoints,
        "orb_descriptors": descriptors.tolist() if descriptors is not None else [],
    }


def extract_ocr_text(image_path: Path) -> str:
    if pytesseract is None:
        return ""

    try:
        text = pytesseract.image_to_string(str(image_path))
        return " ".join(text.split())[:1000]
    except Exception:
        return ""


# ── Board title extraction ───────────────────────────────────────────────────

# Words that are almost certainly not useful titles
_TITLE_STOP_WORDS: set = {
    "legend", "scale", "note", "notes", "section", "elevation", "plan",
    "drawing", "sheet", "figure", "fig", "diagram", "detail",
    "competition", "entry", "submission", "jury", "award",
}

# Minimum printable characters a candidate must have after cleaning
_MIN_TITLE_CHARS = 4
# Max words — real board titles are short
_MAX_TITLE_WORDS = 10
# Top fraction of image height to scan for title text
_TITLE_SCAN_TOP_FRACTION = 0.28
# Minimum per-word Tesseract confidence to include a word
_WORD_CONF_THRESHOLD = 55


def _clean_board_title_candidate(value: str) -> Optional[str]:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    text = text.strip("-_:;,.|/")
    if len(text) < _MIN_TITLE_CHARS:
        return None

    words = text.split()
    if not words:
        return None

    first = words[0]
    # Reject likely clipped fragments such as "ew Urban Block".
    if len(first) <= 2 and first.isalpha() and first.islower() and len(words) >= 2:
        return None

    # Reject candidates with too little alphabetic content.
    letters = sum(1 for c in text if c.isalpha())
    if letters < max(3, int(len(text) * 0.45)):
        return None

    return text


def _is_mostly_numeric(text: str) -> bool:
    letters = sum(1 for c in text if c.isalpha())
    return letters < max(2, len(text) * 0.4)


def _score_title_candidate(words: List[str], line_y_fraction: float) -> float:
    """
    Return a heuristic score for how likely `words` form the board title.
    Higher is better; 0 means discard.
    """
    n = len(words)
    if n == 0 or n > _MAX_TITLE_WORDS:
        return 0.0

    line = " ".join(words)
    if len(line) < _MIN_TITLE_CHARS:
        return 0.0

    if _is_mostly_numeric(line):
        return 0.0

    # Reject if it looks like a URL or domain
    if re.search(r"https?://|\.com|\.org|\.net|www\.", line, re.IGNORECASE):
        return 0.0

    # Reject if it looks like an ID, serial number, or utility reference
    # e.g. "UST ID# 0673", "CUST ID# 0673", "#12345", "ID: 0001"
    if re.search(r"(?:ID|CUST|UST|REF|NO\.?)\s*#?\s*\d{3,}", line, re.IGNORECASE):
        return 0.0
    if re.search(r"#\s*\d{3,}", line):
        return 0.0
    # Reject lines where more than one third of characters are digits
    digit_ratio = sum(1 for c in line if c.isdigit()) / max(1, len(line))
    if digit_ratio > 0.33:
        return 0.0

    lower_words = [w.lower() for w in words]
    if all(w in _TITLE_STOP_WORDS for w in lower_words):
        return 0.0

    # Position score — top of crop zone is best
    position_score = max(0.0, 1.0 - (line_y_fraction / _TITLE_SCAN_TOP_FRACTION) * 0.6)

    # Length score — sweet spot around 2–6 words
    length_score = 1.0 if 2 <= n <= 6 else (0.65 if n <= 9 else 0.25)

    # Capitalisation score
    cap_start = sum(1 for w in words if w and w[0].isupper())
    cap_score = 1.0 if cap_start >= max(1, n // 2) else 0.5
    if line.isupper() and n <= 2:
        cap_score *= 0.4  # penalize short all-caps (often labels/ids)

    return position_score * 0.45 + length_score * 0.30 + cap_score * 0.25


def extract_board_title(image_path: Path) -> Dict:
    """
    Attempt to extract the primary board title from an architectural drawing.

    Strategy:
    1.  Crop the top `_TITLE_SCAN_TOP_FRACTION` of the image.
    2.  Boost contrast so lightly-printed text is more readable.
    3.  Run Tesseract `image_to_data` to get per-word confidence scores.
    4.  Keep only words with confidence ≥ `_WORD_CONF_THRESHOLD`.
    5.  Re-group surviving words into lines by their bounding-box row.
    6.  Score each line and return the best candidate.

    Returns a dict with keys:
        board_title (str | None), board_title_confidence (float), board_title_source (str)
    """
    empty: Dict = {
        "board_title": None,
        "board_title_confidence": 0.0,
        "board_title_source": "none",
    }

    if pytesseract is None:
        return empty

    try:
        pil_img = Image.open(image_path).convert("L")  # greyscale
        w, h = pil_img.size

        crop_h = max(80, int(h * _TITLE_SCAN_TOP_FRACTION))
        top_crop = pil_img.crop((0, 0, w, crop_h))

        # Contrast enhancement: stretch to [0, 255]
        np_crop = np.array(top_crop)
        lo, hi = float(np.percentile(np_crop, 5)), float(np.percentile(np_crop, 95))
        if hi > lo:
            np_crop = np.clip((np_crop.astype(float) - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
        enhanced = Image.fromarray(np_crop)

        # Use image_to_data for per-word confidence and bounding boxes
        tess_config = "--psm 11 --oem 1"  # psm 11 = sparse text, finds words anywhere
        df = pytesseract.image_to_data(
            enhanced, config=tess_config, output_type=pytesseract.Output.DICT
        )

        n_boxes = len(df["text"])
        # Group high-confidence words into lines by (block_num, par_num, line_num)
        line_groups: dict = {}
        crop_h_actual = crop_h or 1

        for i in range(n_boxes):
            conf = int(df["conf"][i])
            word = str(df["text"][i]).strip()
            if conf < _WORD_CONF_THRESHOLD or not word:
                continue

            # Only include real words (at least 2 letters, not just punctuation)
            alpha_chars = sum(1 for c in word if c.isalpha())
            if alpha_chars < 2 and len(word) < 3:
                continue

            key = (int(df["block_num"][i]), int(df["par_num"][i]), int(df["line_num"][i]))
            y_mid = int(df["top"][i]) + int(df["height"][i]) / 2.0
            line_groups.setdefault(key, {"words": [], "y_sum": 0.0, "word_count": 0})
            line_groups[key]["words"].append(word)
            line_groups[key]["y_sum"] += y_mid
            line_groups[key]["word_count"] += 1

        best_line: Optional[str] = None
        best_score: float = 0.0

        for grp in line_groups.values():
            words = grp["words"]
            avg_y = grp["y_sum"] / max(1, grp["word_count"])
            y_frac = avg_y / crop_h_actual
            score = _score_title_candidate(words, y_frac)
            if score > best_score:
                best_score = score
                best_line = " ".join(words)

        cleaned = _clean_board_title_candidate(best_line) if best_line else None
        if cleaned is None or best_score < 0.20:
            return empty

        confidence = min(0.95, best_score)
        return {
            "board_title": cleaned,
            "board_title_confidence": round(confidence, 3),
            "board_title_source": "ocr_top_region",
        }

    except Exception:
        return empty


def extract_region_metrics(image_path: Path, region: Dict) -> Dict:
    """
    Compute lightweight, interpretable region evidence metrics.
    """
    default = {
        "edge_density": 0.0,
        "keypoint_count": 0,
        "text_presence": False,
        "text_presence_score": 0.0,
        "blankness": 1.0,
        "contrast": 0.0,
        "line_density": 0.0,
    }

    try:
        img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
        if img is None:
            return default

        h, w = img.shape[:2]
        x = int(max(0, min(w - 1, region.get("x", 0))))
        y = int(max(0, min(h - 1, region.get("y", 0))))
        rw = int(max(4, min(w - x, region.get("width", 0))))
        rh = int(max(4, min(h - y, region.get("height", 0))))
        crop = img[y : y + rh, x : x + rw]
        if crop.size == 0:
            return default

        edges = cv2.Canny(crop, 90, 200)
        edge_density = float(edges.mean() / 255.0)

        orb = cv2.ORB_create(nfeatures=250)
        kps = orb.detect(crop, None) or []
        keypoint_count = int(len(kps))

        contrast = float(np.std(crop) / 255.0)

        white_ratio = float((crop > 238).mean())
        low_var = 1.0 if np.std(crop) < 16 else max(0.0, 1.0 - (np.std(crop) / 80.0))
        blankness = float(min(1.0, 0.72 * white_ratio + 0.28 * low_var))

        lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=18, minLineLength=12, maxLineGap=4)
        line_density = float(min(1.0, (0 if lines is None else len(lines)) / 55.0))

        _, bw = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        n_labels, _, stats, _ = cv2.connectedComponentsWithStats(bw, connectivity=8)
        text_like = 0
        for i in range(1, n_labels):
            area = int(stats[i, cv2.CC_STAT_AREA])
            cw = int(stats[i, cv2.CC_STAT_WIDTH])
            ch = int(stats[i, cv2.CC_STAT_HEIGHT])
            if area < 6 or area > 650 or cw <= 0 or ch <= 0:
                continue
            aspect = cw / max(1.0, ch)
            if 0.12 <= aspect <= 6.0:
                text_like += 1

        text_presence_score = float(min(1.0, text_like / 35.0))
        text_presence = bool(text_presence_score >= 0.22)

        return {
            "edge_density": round(edge_density, 4),
            "keypoint_count": keypoint_count,
            "text_presence": text_presence,
            "text_presence_score": round(text_presence_score, 4),
            "blankness": round(blankness, 4),
            "contrast": round(contrast, 4),
            "line_density": round(line_density, 4),
        }
    except Exception:
        return default


def compute_semantic_embeddings(records: List[Dict], enable_model: bool = False) -> np.ndarray:
    texts = []
    for r in records:
        dc = r.get("dublin_core", {})
        combined = " ".join(
            [
                str(dc.get("dc:title", "")),
                " ".join(dc.get("dc:subject", []))
                if isinstance(dc.get("dc:subject", []), list)
                else str(dc.get("dc:subject", "")),
                str(dc.get("dc:description", "")),
                str(r.get("ocr_text", "")),
            ]
        )
        texts.append(combined)

    if enable_model and SentenceTransformer is not None:
        model = SentenceTransformer("sentence-transformers/clip-ViT-B-32")
        return np.array(model.encode(texts, show_progress_bar=True))

    return _tfidf_hash_embeddings(texts, dim=2048)


def cosine_matrix(vectors: np.ndarray) -> np.ndarray:
    if vectors.size == 0:
        return np.zeros((0, 0), dtype=float)

    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normalized = vectors / norms
    return normalized @ normalized.T


def save_feature_snapshot(path: Path, metadata: List[Dict]) -> None:
    serializable = []
    for item in metadata:
        copy_item = dict(item)
        if isinstance(copy_item.get("embedding"), np.ndarray):
            copy_item["embedding"] = copy_item["embedding"].tolist()
        serializable.append(copy_item)

    path.write_text(json.dumps(serializable, indent=2), encoding="utf-8")


def match_local_regions(source: Dict, target: Dict) -> Tuple[float, List[Dict]]:
    src_desc = np.array(source.get("visual", {}).get("orb_descriptors", []), dtype=np.uint8)
    tgt_desc = np.array(target.get("visual", {}).get("orb_descriptors", []), dtype=np.uint8)

    if src_desc.size == 0 or tgt_desc.size == 0:
        return 0.0, []

    bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
    matches = bf.match(src_desc, tgt_desc)
    matches = sorted(matches, key=lambda x: x.distance)

    if not matches:
        return 0.0, []

    src_kp = source.get("visual", {}).get("orb_keypoints", [])
    tgt_kp = target.get("visual", {}).get("orb_keypoints", [])

    good = matches[: min(40, len(matches))]
    regions = []
    for m in good:
        if m.queryIdx >= len(src_kp) or m.trainIdx >= len(tgt_kp):
            continue
        sx, sy = src_kp[m.queryIdx]
        tx, ty = tgt_kp[m.trainIdx]
        box = 20.0
        regions.append(
            {
                "source_region": {
                    "x": sx - box,
                    "y": sy - box,
                    "width": box * 2,
                    "height": box * 2,
                },
                "target_region": {
                    "x": tx - box,
                    "y": ty - box,
                    "width": box * 2,
                    "height": box * 2,
                },
                "distance": float(m.distance),
            }
        )

    confidence = float(max(0.0, 1.0 - np.mean([m.distance for m in good]) / 100.0))
    return confidence, regions


def _tokenize(text: str) -> List[str]:
    return [t for t in re.findall(r"[a-zA-Z0-9]+", text.lower()) if len(t) > 2]


def _tfidf_hash_embeddings(texts: List[str], dim: int = 2048) -> np.ndarray:
    doc_tokens = [_tokenize(t) for t in texts]
    n_docs = max(1, len(doc_tokens))

    # Document frequency for hashed token buckets.
    df = np.zeros(dim, dtype=float)
    for tokens in doc_tokens:
        seen = set()
        for tok in tokens:
            idx = hash(tok) % dim
            if idx not in seen:
                df[idx] += 1.0
                seen.add(idx)

    idf = np.log((1.0 + n_docs) / (1.0 + df)) + 1.0

    vectors = np.zeros((len(doc_tokens), dim), dtype=float)
    for i, tokens in enumerate(doc_tokens):
        if not tokens:
            continue
        counts = {}
        for tok in tokens:
            idx = hash(tok) % dim
            counts[idx] = counts.get(idx, 0.0) + 1.0

        total = float(sum(counts.values()))
        for idx, c in counts.items():
            tf = c / total
            vectors[i, idx] = tf * idf[idx]

        norm = math.sqrt(float(np.dot(vectors[i], vectors[i])))
        if norm > 0:
            vectors[i] /= norm

    return vectors
