import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

import requests
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

from .config import API_CACHE_DIR, CACHE_DIR
from .feature_extractor import extract_board_title, extract_ocr_text, extract_visual_features, fetch_image

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

CACHE_BOARD = API_CACHE_DIR / "board_title"
CACHE_META = API_CACHE_DIR / "image_metadata"
CACHE_EXPLAIN = API_CACHE_DIR / "explain_match"
for folder in [CACHE_BOARD, CACHE_META, CACHE_EXPLAIN]:
    folder.mkdir(parents=True, exist_ok=True)


class BoardTitleRequest(BaseModel):
    image_url: str
    use_openai: bool = True


class ImageMetadataRequest(BaseModel):
    image_url: str
    instance_id: Optional[str] = None
    use_openai: bool = True
    force_refresh: bool = False


class ExplainMatchRequest(BaseModel):
    source_instance_id: Optional[str] = None
    target_instance_id: Optional[str] = None
    connection_type: str
    confidence_score: float = 0.0
    evidence_kinds: list[str] = Field(default_factory=list)
    source_region_metrics: Dict[str, Any] = Field(default_factory=dict)
    target_region_metrics: Dict[str, Any] = Field(default_factory=dict)
    existing_explanation: Optional[str] = None
    use_openai: bool = True


app = FastAPI(title="Archive AI API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _hash_key(payload: Dict[str, Any]) -> str:
    packed = json.dumps(payload, sort_keys=True, ensure_ascii=True)
    return hashlib.sha1(packed.encode("utf-8")).hexdigest()


def _cache_get(folder: Path, key: str) -> Optional[Dict[str, Any]]:
    path = folder / f"{key}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _cache_set(folder: Path, key: str, payload: Dict[str, Any]) -> None:
    path = folder / f"{key}.json"
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _openai_chat(system_prompt: str, user_prompt: str) -> Optional[str]:
    if not OPENAI_API_KEY:
        return None

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    body = {
        "model": OPENAI_MODEL,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }

    try:
        response = requests.post(OPENAI_URL, headers=headers, json=body, timeout=25)
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"].strip()
    except Exception:
        return None


def _heuristic_explanation(payload: ExplainMatchRequest) -> str:
    src = payload.source_region_metrics or {}
    tgt = payload.target_region_metrics or {}
    edge = max(float(src.get("edge_density", 0.0)), float(tgt.get("edge_density", 0.0)))
    line = max(float(src.get("line_density", 0.0)), float(tgt.get("line_density", 0.0)))
    blank = max(float(src.get("blankness", 0.0)), float(tgt.get("blankness", 0.0)))
    text = bool(src.get("text_presence")) or bool(tgt.get("text_presence"))

    phrases = []
    if edge >= 0.03:
        phrases.append("edge and corner structure")
    if line >= 0.12:
        phrases.append("line density and direction")
    if text:
        phrases.append("text-like visual patterns")
    if blank >= 0.7:
        phrases.append("large blank board areas")

    if not phrases:
        phrases.append("local visual descriptors")

    return (
        f"This match is driven by {'; '.join(phrases)}. "
        f"Confidence is {payload.confidence_score:.2f}, so treat this as a visual hint rather than a semantic guarantee."
    )


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "openai_configured": bool(OPENAI_API_KEY),
        "model": OPENAI_MODEL,
    }


@app.post("/api/extract-board-title")
def extract_board_title_route(req: BoardTitleRequest) -> Dict[str, Any]:
    key = _hash_key(req.model_dump())
    cached = _cache_get(CACHE_BOARD, key)
    if cached:
        return cached

    cached_path = fetch_image(CACHE_DIR, req.image_url)
    if not cached_path:
        payload = {"ok": False, "error": "Could not fetch image"}
        _cache_set(CACHE_BOARD, key, payload)
        return payload

    result = extract_board_title(cached_path)
    title = result.get("board_title")
    refined_title = title
    openai_used = False

    if req.use_openai and title:
        system = "You clean OCR board titles. Return only one cleaned title line."
        user = f"OCR title: {title}\nClean OCR mistakes but keep original wording."
        candidate = _openai_chat(system, user)
        if candidate:
            refined_title = candidate.splitlines()[0].strip()
            openai_used = True

    payload = {
        "ok": True,
        "image_url": req.image_url,
        "board_title": refined_title,
        "raw_board_title": title,
        "board_title_confidence": result.get("board_title_confidence", 0.0),
        "source": "openai" if openai_used else result.get("board_title_source", "heuristic_ocr"),
        "openai_used": openai_used,
    }
    _cache_set(CACHE_BOARD, key, payload)
    return payload


@app.post("/api/extract-image-metadata")
def extract_image_metadata_route(req: ImageMetadataRequest) -> Dict[str, Any]:
    key = _hash_key(req.model_dump())
    if not req.force_refresh:
        cached = _cache_get(CACHE_META, key)
        if cached:
            return cached

    cached_path = fetch_image(CACHE_DIR, req.image_url)
    if not cached_path:
        payload = {"ok": False, "error": "Could not fetch image"}
        _cache_set(CACHE_META, key, payload)
        return payload

    visual = extract_visual_features(cached_path)
    ocr_text = extract_ocr_text(cached_path)
    title = extract_board_title(cached_path)

    payload = {
        "ok": True,
        "instance_id": req.instance_id,
        "image_url": req.image_url,
        "board_title": title.get("board_title"),
        "board_title_confidence": title.get("board_title_confidence", 0.0),
        "ocr_text": ocr_text,
        "visual_summary": {
            "edge_density": visual.get("edge_density", 0.0),
            "keypoint_count": len(visual.get("orb_keypoints", [])),
            "width": visual.get("width"),
            "height": visual.get("height"),
        },
        "openai_used": False,
    }

    if req.use_openai and OPENAI_API_KEY and payload["board_title"]:
        system = "You summarize architecture board metadata from OCR and simple metrics in one sentence."
        user = json.dumps(
            {
                "board_title": payload["board_title"],
                "ocr_text_preview": ocr_text[:400],
                "visual_summary": payload["visual_summary"],
            }
        )
        summary = _openai_chat(system, user)
        if summary:
            payload["llm_summary"] = summary
            payload["openai_used"] = True

    _cache_set(CACHE_META, key, payload)
    return payload


@app.post("/api/explain-match")
def explain_match_route(req: ExplainMatchRequest) -> Dict[str, Any]:
    key = _hash_key(req.model_dump())
    cached = _cache_get(CACHE_EXPLAIN, key)
    if cached:
        return cached

    explanation = req.existing_explanation or _heuristic_explanation(req)
    openai_used = False

    if req.use_openai and OPENAI_API_KEY:
        system = (
            "You explain visual match evidence in plain language for architects. "
            "Use 2 concise sentences and avoid generic wording."
        )
        user = json.dumps(req.model_dump())
        candidate = _openai_chat(system, user)
        if candidate:
            explanation = candidate
            openai_used = True

    payload = {
        "ok": True,
        "source_instance_id": req.source_instance_id,
        "target_instance_id": req.target_instance_id,
        "explanation": explanation,
        "evidence_kinds": req.evidence_kinds,
        "openai_used": openai_used,
    }
    _cache_set(CACHE_EXPLAIN, key, payload)
    return payload
