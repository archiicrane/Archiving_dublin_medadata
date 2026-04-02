"""
Batch metadata enrichment using OpenAI Vision.

Sends each architectural drawing image to GPT-4o-mini Vision and asks it to
describe ONLY what is actually visible — colours, drawing type, visual features,
building programme, medium, style, site context.

Produces:
    frontend/public/data/enriched_metadata.json   ← loaded by the website at startup

Usage:
    python scripts/enrich_metadata.py                    # full run, 3 images per call
    python scripts/enrich_metadata.py --batch-size 5     # faster, slightly less accurate
    python scripts/enrich_metadata.py --start-from 300   # resume from record 300
    python scripts/enrich_metadata.py --dry-run          # preview first batch, no API calls
    python scripts/enrich_metadata.py --no-vision        # text-only (no image sent), cheaper

Requires: OPENAI_API_KEY environment variable.
Dependencies: requests (already in backend requirements).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

try:
    import requests
except ImportError:
    print("ERROR: requests package not installed.  Run: pip install requests", file=sys.stderr)
    sys.exit(1)
# ---------------------------------------------------------------------------

ROOT        = Path(__file__).resolve().parent.parent
INPUT_FILE  = ROOT / "frontend" / "public" / "data" / "image_metadata.json"
OUTPUT_FILE = ROOT / "frontend" / "public" / "data" / "enriched_metadata.json"

OPENAI_URL  = "https://api.openai.com/v1/chat/completions"

# ---------------------------------------------------------------------------
# Controlled vocabulary  (must match archival_drawing.ttl)
# ---------------------------------------------------------------------------

DRAWING_TYPES = [
    "plan", "site_plan", "floor_plan", "elevation", "section",
    "perspective", "axonometric", "isometric", "detail",
    "concept_diagram", "collage", "sketch", "render", "model_photo",
]

VISUAL_ELEMENTS = [
    "trees", "vegetation", "grass", "water", "river",
    "topography", "contour_lines", "sky", "shadows",
    "human_figures", "vehicles",
    "streets", "public_space", "courtyard", "roof", "facade",
    "grid_pattern", "structural_elements", "staircase", "bridge", "waterfront",
    "scale_bar", "north_arrow", "title_block", "text_annotations", "hatching", "dimensions",
]

BUILDING_PROGRAMS = [
    "residential", "housing", "commercial", "civic", "cultural",
    "educational", "industrial", "religious", "landscape",
    "urban_design", "infrastructure", "mixed_use",
    "hospitality", "healthcare", "recreation",
]

MEDIUMS = [
    "pencil", "ink", "watercolor", "gouache", "charcoal",
    "mixed_media", "digital", "cad", "print", "collage_media",
]

COLOR_PALETTE = [
    "monochrome", "blue", "green", "red", "orange", "yellow",
    "brown", "purple", "grey", "warm_tones", "cool_tones", "pastel", "sepia",
]

DRAWING_STYLES = ["technical", "freehand", "diagrammatic", "photorealistic", "abstract", "schematic"]
SITE_CONTEXTS  = ["urban", "suburban", "rural", "waterfront", "hillside", "coastal", "wooded", "flat"]
PROJECTIONS    = ["orthographic", "perspective", "axonometric", "isometric", "plan_oblique"]

# ---------------------------------------------------------------------------
# System prompt  (sent once per API call)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = f"""You are an expert architectural drawing analyst for a research archive.
You will receive one or more architectural competition drawing images.
Each image is labelled with its instance_id, title, and year.

For EACH image return a JSON object.
CRITICAL RULE: Only include fields and values for things you can ACTUALLY SEE in the image.
If an element is not visible, omit it or use an empty value / empty array.
Do NOT guess or invent information that is not present in the image.

Return a JSON array, one object per image, in the same order as the inputs.

Required fields:
  "instance_id"   — copy from input (required, do not change)
  "dc:title"      — title text visible in the drawing; if unreadable, copy input title
  "dc:creator"    — architect / designer name only if readable in the image, else ""
  "dc:subject"    — array of 3–8 lowercase keywords describing what you actually SEE
  "dc:description"— one sentence about what the drawing actually shows
  "dc:coverage"   — city or region only if visible as text in the image, else ""
    "archdrw:drawingType"      — array from allowed values (use [] if unclear)
    "archdrw:hasVisualElement" — array from allowed values (use [] if none confidently visible)
    "archdrw:buildingProgram"  — array from allowed values (use [] if unclear)
    "archdrw:medium"           — one value from allowed values or ""
    "archdrw:colorPalette"     — array from allowed values (use [] if unclear)
    "archdrw:drawingStyle"     — one value from allowed values or ""
    "archdrw:siteContext"      — one value from allowed values or ""
    "archdrw:projection"       — one value from allowed values or ""

Example of correct behaviour:
  — A monochrome pencil site plan with trees and a north arrow but no people →
    colorPalette: ["monochrome"],  medium: "pencil",  drawingType: ["site_plan"],
    hasVisualElement: ["trees", "north_arrow", "scale_bar"],  (no human_figures)

Return ONLY a valid JSON array.  No markdown fences.  No explanation text.
"""

TEXT_ONLY_SYSTEM_PROMPT = f"""You are a metadata analyst for an architectural drawing archive.
You will receive a JSON array of drawing records (title, year, project_key).

For EACH record return a JSON object.
NOTE: You cannot see the images, so base your analysis on the title and project name only.
Mark every field as inferred — keep descriptions short and factual.

Return a JSON array, one object per record, same order as input.

Required fields:
  "instance_id", "dc:title", "dc:creator" (leave "" if unknown),
  "dc:subject" (3–6 keywords inferred from project name), "dc:description" (one sentence),
  "dc:coverage" (city/region if inferable from name, else "")

Optional: "archdrw:buildingProgram", "archdrw:siteContext"

Return ONLY a valid JSON array.  No markdown fences.
"""

# ---------------------------------------------------------------------------
# Loaders / savers
# ---------------------------------------------------------------------------

def load_records() -> list[dict]:
    with open(INPUT_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, list) else []


def load_existing_enriched() -> dict[str, dict]:
    """Returns {instance_id: enriched_record} for already-processed records."""
    if not OUTPUT_FILE.exists():
        return {}
    with open(OUTPUT_FILE, encoding="utf-8") as f:
        existing = json.load(f)
    return {rec["instance_id"]: rec for rec in existing if rec.get("instance_id")}


def is_truly_enriched(rec: dict) -> bool:
    """True when a record has architectural enrichment, not only Dublin Core text."""
    if not isinstance(rec, dict):
        return False
    arch = rec.get("archdrw") or {}
    if not isinstance(arch, dict) or not arch:
        return False

    # Require at least one meaningful architectural signal.
    for field in ("drawingType", "hasVisualElement", "buildingProgram", "colorPalette"):
        vals = arch.get(field)
        if isinstance(vals, list) and len(vals) > 0:
            return True

    for field in ("medium", "drawingStyle", "siteContext", "projection"):
        if str(arch.get(field) or "").strip():
            return True

    return False


def save_enriched(enriched_by_id: dict[str, dict]) -> None:
    records = list(enriched_by_id.values())
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, indent=2, ensure_ascii=False)
    print(f"  Saved {len(records)} records -> {OUTPUT_FILE}")

# ---------------------------------------------------------------------------
# Message builders
# ---------------------------------------------------------------------------

def _record_label(rec: dict) -> str:
    return f"instance_id: {rec.get('instance_id', '')}, title: {rec.get('title', '')}, year: {rec.get('year', '')}"


def make_vision_messages(batch: list[dict]) -> list[dict]:
    """Build a messages array that sends each image URL to the vision model."""
    content: list = []

    for i, rec in enumerate(batch):
        content.append({
            "type": "text",
            "text": f"Image {i + 1}: {_record_label(rec)}",
        })
        content.append({
            "type": "image_url",
            "image_url": {
                "url": rec.get("url", ""),
                "detail": "low",   # low-res is enough for feature detection; reduces cost
            },
        })

    content.append({
        "type": "text",
        "text": (
            f"Analyse all {len(batch)} image(s) above.  "
            "Return a JSON array with one object per image in the same order."
        ),
    })

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": content},
    ]


def make_text_messages(batch: list[dict]) -> list[dict]:
    """Text-only messages (no images) for --no-vision mode."""
    short = [
        {
            "instance_id": rec.get("instance_id", ""),
            "title":        rec.get("title", ""),
            "year":         rec.get("year", ""),
            "project_key":  rec.get("project_key", ""),
        }
        for rec in batch
    ]
    return [
        {"role": "system", "content": TEXT_ONLY_SYSTEM_PROMPT},
        {"role": "user",   "content": json.dumps(short, ensure_ascii=False)},
    ]

# ---------------------------------------------------------------------------
# OpenAI call
# ---------------------------------------------------------------------------

def call_openai(api_key: str, model: str, messages: list, max_tokens: int = 2000) -> str | None:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type":  "application/json",
    }
    body = {
        "model":       model,
        "temperature": 0.1,
        "max_tokens":  max_tokens,
        "messages":    messages,
    }
    try:
        resp = requests.post(OPENAI_URL, headers=headers, json=body, timeout=90)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()
    except requests.HTTPError as e:
        print(f"    HTTP {resp.status_code}: {resp.text[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"    API error: {e}", file=sys.stderr)
        return None


def parse_json_array(raw: str) -> list[dict] | None:
    """Parse a JSON array from the model response, tolerating markdown fences."""
    text = raw.strip()
    # Strip ```json ... ``` fences
    text = re.sub(r"^```[a-z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    text = text.strip()

    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass

    # Try to extract the array from somewhere inside the string
    start = text.find("[")
    end   = text.rfind("]")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass

    return None

# ---------------------------------------------------------------------------
# Merge enrichment into original record
# ---------------------------------------------------------------------------

def merge_enrichment(original: dict, enrichment: dict) -> dict:
    rec = dict(original)
    dc  = dict(rec.get("dublin_core") or {})

    # Standard DC string fields — only overwrite if OpenAI returned something
    for field in ("dc:creator", "dc:description", "dc:coverage", "dc:rights"):
        val = str(enrichment.get(field) or "").strip()
        if val:
            dc[field] = val

    # dc:title — prefer what's in the image if it differs
    image_title = str(enrichment.get("dc:title") or "").strip()
    if image_title and not dc.get("dc:title"):
        dc["dc:title"] = image_title

    # dc:subject — merge, deduplicate, keep lowercase
    existing_subjects = set(dc.get("dc:subject") or [])
    new_subjects = enrichment.get("dc:subject", [])
    if isinstance(new_subjects, list):
        for s in new_subjects:
            s = str(s).strip().lower()
            if s:
                existing_subjects.add(s)
    dc["dc:subject"] = sorted(existing_subjects)

    rec["dublin_core"] = dc

    # Architectural vocabulary fields — stored under "archdrw" key
    archdrw = dict(rec.get("archdrw") or {})
    for field in ("archdrw:drawingType", "archdrw:hasVisualElement", "archdrw:buildingProgram", "archdrw:colorPalette"):
        vals = enrichment.get(field, [])
        if isinstance(vals, list) and vals:
            archdrw[field.split(":")[1]] = [str(v).strip() for v in vals if str(v).strip()]

    for field in ("archdrw:medium", "archdrw:drawingStyle", "archdrw:siteContext", "archdrw:projection"):
        val = str(enrichment.get(field) or "").strip()
        if val:
            archdrw[field.split(":")[1]] = val

    if archdrw:
        rec["archdrw"] = archdrw

    rec["enriched_by_vision"] = True
    return rec

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Batch-enrich image metadata with OpenAI Vision")
    parser.add_argument("--batch-size",  type=int,   default=3,
                        help="Images per OpenAI call (default 3 for vision, try 5 if stable)")
    parser.add_argument("--model",       default="gpt-4o-mini",
                        help="OpenAI model (must support vision, default: gpt-4o-mini)")
    parser.add_argument("--start-from",  type=int,   default=0,
                        help="Skip to this record index to resume an interrupted run")
    parser.add_argument("--dry-run",     action="store_true",
                        help="Preview the first batch only — no API calls made")
    parser.add_argument("--no-vision",   action="store_true",
                        help="Text-only mode: infer from title/year only, no image sent")
    parser.add_argument("--delay",       type=float, default=0.4,
                        help="Seconds to wait between batches (default 0.4)")
    args = parser.parse_args()

    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key and not args.dry_run:
        print("ERROR: OPENAI_API_KEY environment variable not set.", file=sys.stderr)
        sys.exit(1)

    records = load_records()
    total   = len(records)
    print(f"Loaded {total} records from {INPUT_FILE}")

    existing_enriched = load_existing_enriched()
    truly_enriched_ids = {
        iid for iid, rec in existing_enriched.items()
        if is_truly_enriched(rec)
    }
    print(f"  {len(truly_enriched_ids)} already enriched (will skip)")

    to_process = [
        r for r in records[args.start_from:]
        if r.get("instance_id") and r.get("instance_id") not in truly_enriched_ids
    ]

    batch_size  = args.batch_size
    num_batches = (len(to_process) + batch_size - 1) // batch_size if to_process else 0
    mode_label  = "text-only (no vision)" if args.no_vision else "vision"

    print(f"  {len(to_process)} records to enrich | {num_batches} batches of {batch_size} | mode: {mode_label}")

    if args.dry_run:
        print("\n--- DRY RUN: first batch preview ---")
        preview = to_process[:batch_size]
        for rec in preview:
            print(f"  {rec.get('instance_id')}  |  {rec.get('title')}  |  url: {rec.get('url', '')[:60]}")
        print("\nSystem prompt (truncated):")
        prompt = TEXT_ONLY_SYSTEM_PROMPT if args.no_vision else SYSTEM_PROMPT
        print(prompt[:600], "...")
        return

    # Seed output map with existing output first (so we preserve previous progress),
    # then fill missing IDs from original records.
    output_by_id = dict(existing_enriched)

    # Seed remaining IDs with original (unenriched) versions as fallback
    for rec in records:
        iid = rec.get("instance_id")
        if iid and iid not in output_by_id:
            output_by_id[iid] = rec

    failed_ids: list[str] = []

    for batch_idx in range(num_batches):
        batch     = to_process[batch_idx * batch_size : (batch_idx + 1) * batch_size]
        batch_ids = [r.get("instance_id", "?") for r in batch]
        print(f"\nBatch {batch_idx + 1}/{num_batches}  ({len(batch)} images)  first: {batch_ids[0][:50]}")

        if args.no_vision:
            messages = make_text_messages(batch)
        else:
            messages = make_vision_messages(batch)

        raw = call_openai(api_key, args.model, messages)
        if raw is None:
            print(f"  FAILED — keeping originals for this batch")
            failed_ids.extend(batch_ids)
        else:
            enrichments = parse_json_array(raw)
            if enrichments is None:
                print(f"  Could not parse response — keeping originals")
                print(f"  Raw response (200 chars): {raw[:200]}")
                failed_ids.extend(batch_ids)
            else:
                enrichment_map = {}
                for e in enrichments:
                    iid = str(e.get("instance_id", "")).strip()
                    if iid:
                        enrichment_map[iid] = e

                for rec in batch:
                    iid = rec.get("instance_id", "")
                    if iid in enrichment_map:
                        output_by_id[iid] = merge_enrichment(rec, enrichment_map[iid])
                        el = output_by_id[iid].get("archdrw", {}).get("hasVisualElement", [])
                        print(f"  OK {iid[:55]}  elements: {el[:4]}")
                    else:
                        print(f"  ~ {iid[:55]}  (no enrichment returned)")
                        failed_ids.append(iid)

        # Save after every batch — progress is never lost
        save_enriched(output_by_id)

        if batch_idx < num_batches - 1:
            time.sleep(args.delay)

    print(f"\n{'=' * 60}")
    print(f"Done.  Enriched: {len(output_by_id) - len(failed_ids)}  |  Failed/original: {len(failed_ids)}")
    print(f"Output -> {OUTPUT_FILE}")
    if failed_ids:
        print(f"Failed instance IDs (first 5): {failed_ids[:5]}")
    print("\nNext step: run   python scripts/export_rdf.py   to generate archive_drawings.ttl")


if __name__ == "__main__":
    main()
