"""
RDF export script.

Reads enriched_metadata.json (produced by enrich_metadata.py) and writes a
Turtle-format RDF file containing one archdrw:ArchivalDrawing instance per
drawing record.

The output file uses the vocabulary defined in schemas/archival_drawing.ttl.
It is a DATA file (instances) — the vocabulary itself lives in the schema file.

Output: frontend/public/data/archive_drawings.ttl
        backend/data/processed/archive_drawings.ttl  (copy)

Usage:
    python scripts/export_rdf.py
    python scripts/export_rdf.py --input frontend/public/data/image_metadata.json
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT           = Path(__file__).resolve().parent.parent
DEFAULT_INPUT  = ROOT / "frontend" / "public" / "data" / "enriched_metadata.json"
FALLBACK_INPUT = ROOT / "frontend" / "public" / "data" / "image_metadata.json"
OUTPUT_FRONT   = ROOT / "frontend" / "public" / "data" / "archive_drawings.ttl"
OUTPUT_BACK    = ROOT / "backend"  / "data"   / "processed" / "archive_drawings.ttl"

ARCHDRW_NS    = "https://archivingresearch.org/schema/drawing#"
ARCHIVE_DATA  = "https://archivingresearch.org/data/"
DC_NS         = "http://purl.org/dc/elements/1.1/"

# ---------------------------------------------------------------------------
# Vocabulary maps  (string value → local name in archdrw: namespace)
# ---------------------------------------------------------------------------

DRAWING_TYPE_MAP: dict[str, str] = {
    "plan":            "Plan",
    "site_plan":       "SitePlan",
    "floor_plan":      "FloorPlan",
    "elevation":       "Elevation",
    "section":         "Section",
    "perspective":     "Perspective",
    "axonometric":     "Axonometric",
    "isometric":       "Isometric",
    "detail":          "Detail",
    "concept_diagram": "ConceptDiagram",
    "collage":         "Collage",
    "sketch":          "Sketch",
    "render":          "RenderImage",
    "model_photo":     "ModelPhoto",
}

VISUAL_ELEMENT_MAP: dict[str, str] = {
    "trees":               "Trees",
    "vegetation":          "Vegetation",
    "grass":               "Grass",
    "water":               "Water",
    "river":               "River",
    "topography":          "Topography",
    "contour_lines":       "ContourLines",
    "sky":                 "Sky",
    "shadows":             "Shadows",
    "human_figures":       "HumanFigures",
    "vehicles":            "Vehicles",
    "streets":             "Streets",
    "public_space":        "PublicSpace",
    "courtyard":           "Courtyard",
    "roof":                "Roof",
    "facade":              "Facade",
    "grid_pattern":        "GridPattern",
    "structural_elements": "Structure",
    "staircase":           "Staircase",
    "bridge":              "Bridge",
    "waterfront":          "Waterfront",
    "scale_bar":           "ScaleBar",
    "north_arrow":         "NorthArrow",
    "title_block":         "TitleBlock",
    "text_annotations":    "TextAnnotation",
    "hatching":            "Hatching",
    "dimensions":          "Dimensions",
}

BUILDING_PROGRAM_MAP: dict[str, str] = {
    "residential":   "Residential",
    "housing":       "Housing",
    "commercial":    "Commercial",
    "civic":         "Civic",
    "cultural":      "Cultural",
    "educational":   "Educational",
    "industrial":    "Industrial",
    "religious":     "Religious",
    "landscape":     "Landscape",
    "urban_design":  "UrbanDesign",
    "infrastructure":"Infrastructure",
    "mixed_use":     "MixedUse",
    "hospitality":   "Hospitality",
    "healthcare":    "Healthcare",
    "recreation":    "Recreation",
}

# ---------------------------------------------------------------------------
# TTL helpers
# ---------------------------------------------------------------------------

def ttl_esc(s: str) -> str:
    """Escape a string for use inside a Turtle double-quoted literal."""
    return (
        s.replace("\\", "\\\\")
         .replace('"',  '\\"')
         .replace("\n", "\\n")
         .replace("\r", "\\r")
         .replace("\t", "\\t")
    )


def draw_iri(instance_id: str) -> str:
    """Build a safe IRI for a drawing instance."""
    safe = quote(instance_id, safe="-._~")
    return f"<{ARCHIVE_DATA}{safe}>"


def archdrw(local: str) -> str:
    return f"archdrw:{local}"


def dc(local: str) -> str:
    return f"dc:{local}"


def lit(value: str) -> str:
    return f'"{ttl_esc(str(value))}"'


def lit_int(value) -> str:
    try:
        return f'"{int(value)}"^^xsd:integer'
    except (TypeError, ValueError):
        return f'"{ttl_esc(str(value))}"'

# ---------------------------------------------------------------------------
# Record → Turtle triples
# ---------------------------------------------------------------------------

def record_to_ttl(rec: dict) -> str:
    """Convert one enriched record to a Turtle block."""
    iid    = rec.get("instance_id", "")
    dc_map = rec.get("dublin_core") or {}
    arch   = rec.get("archdrw") or {}

    subject = draw_iri(iid)
    lines:  list[str] = []

    def triple(pred: str, obj: str) -> None:
        lines.append(f"    {pred} {obj} ;")

    # Type
    triple("a", archdrw("ArchivalDrawing"))

    # Dublin Core
    title = dc_map.get("dc:title") or rec.get("title") or ""
    if title:
        triple(dc("title"),       lit(title))

    creator = dc_map.get("dc:creator") or ""
    if creator:
        triple(dc("creator"),     lit(creator))

    desc = dc_map.get("dc:description") or ""
    if desc:
        triple(dc("description"), lit(desc))

    date = dc_map.get("dc:date") or rec.get("year") or ""
    if date:
        triple(dc("date"),        lit(str(date)))

    coverage = dc_map.get("dc:coverage") or ""
    if coverage:
        triple(dc("coverage"),    lit(coverage))

    rights = dc_map.get("dc:rights") or ""
    if rights:
        triple(dc("rights"),      lit(rights))

    dtype = dc_map.get("dc:type") or rec.get("type") or "drawing"
    triple(dc("type"),            lit(dtype))

    fmt = dc_map.get("dc:format") or "image/jpeg"
    triple(dc("format"),          lit(fmt))

    url = rec.get("url") or dc_map.get("dc:source") or ""
    if url:
        triple(dc("source"),      f"<{url}>")

    triple(dc("identifier"),      lit(iid))
    triple(archdrw("instanceId"), lit(iid))

    # dc:subject keywords
    subjects = dc_map.get("dc:subject") or []
    if isinstance(subjects, list):
        for kw in subjects:
            kw = str(kw).strip()
            if kw:
                triple(dc("subject"), lit(kw))

    # competition / board page (from filename)
    project_key = rec.get("project_key") or ""
    if project_key:
        triple(archdrw("competition"), lit(project_key))

    page = rec.get("page")
    if page is not None:
        triple(archdrw("boardPage"), lit_int(page))

    # Architectural vocabulary — object properties
    for val in (arch.get("drawingType") or []):
        local = DRAWING_TYPE_MAP.get(str(val).strip().lower())
        if local:
            triple(archdrw("drawingType"), archdrw(local))

    for val in (arch.get("hasVisualElement") or []):
        local = VISUAL_ELEMENT_MAP.get(str(val).strip().lower())
        if local:
            triple(archdrw("hasVisualElement"), archdrw(local))

    for val in (arch.get("buildingProgram") or []):
        local = BUILDING_PROGRAM_MAP.get(str(val).strip().lower())
        if local:
            triple(archdrw("buildingProgram"), archdrw(local))

    # Architectural vocabulary — datatype properties
    for field in ("medium", "drawingStyle", "siteContext", "projection"):
        val = str(arch.get(field) or "").strip()
        if val:
            triple(archdrw(field), lit(val))

    for col in (arch.get("colorPalette") or []):
        col = str(col).strip()
        if col:
            triple(archdrw("colorPalette"), lit(col))

    if not lines:
        return ""

    # Last triple ends with . not ;
    lines[-1] = lines[-1].rstrip(" ;") + " ."

    return f"{subject}\n" + "\n".join(lines) + "\n"

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Export enriched metadata to RDF Turtle")
    parser.add_argument("--input", default=str(DEFAULT_INPUT),
                        help="Path to enriched_metadata.json (default: auto-detect)")
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        # Fall back to plain image_metadata.json if enriched version doesn't exist yet
        if DEFAULT_INPUT != FALLBACK_INPUT and FALLBACK_INPUT.exists():
            print(f"'{input_path}' not found — falling back to {FALLBACK_INPUT}")
            input_path = FALLBACK_INPUT
        else:
            print(f"ERROR: input file not found: {input_path}", file=sys.stderr)
            sys.exit(1)

    with open(input_path, encoding="utf-8") as f:
        records = json.load(f)

    if not isinstance(records, list):
        print("ERROR: input file must be a JSON array", file=sys.stderr)
        sys.exit(1)

    print(f"Loaded {len(records)} records from {input_path}")

    # ── Build TTL ───────────────────────────────────────────────────────────
    lines: list[str] = []

    # Header / prefixes
    lines.append(f"# archive_drawings.ttl")
    lines.append(f"# Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M')} UTC")
    lines.append(f"# Records: {len(records)}")
    lines.append(f"# Vocabulary: schemas/archival_drawing.ttl")
    lines.append("")
    lines.append(f"@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .")
    lines.append(f"@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .")
    lines.append(f"@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .")
    lines.append(f"@prefix dc:      <{DC_NS}> .")
    lines.append(f"@prefix archdrw: <{ARCHDRW_NS}> .")
    lines.append("")

    ok = 0
    skipped = 0
    for rec in records:
        if not rec.get("instance_id"):
            skipped += 1
            continue
        block = record_to_ttl(rec)
        if block:
            lines.append(block)
            ok += 1
        else:
            skipped += 1

    ttl_content = "\n".join(lines)

    # ── Write outputs ───────────────────────────────────────────────────────
    OUTPUT_FRONT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FRONT.write_text(ttl_content, encoding="utf-8")
    print(f"Written → {OUTPUT_FRONT}  ({ok} records)")

    try:
        OUTPUT_BACK.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_BACK.write_text(ttl_content, encoding="utf-8")
        print(f"Written → {OUTPUT_BACK}  (copy)")
    except Exception as e:
        print(f"Could not write backend copy: {e}")

    if skipped:
        print(f"Skipped {skipped} records (missing instance_id or empty)")

    size_kb = len(ttl_content.encode("utf-8")) / 1024
    print(f"\nFile size: {size_kb:.1f} KB  |  {ok} drawing instances")
    print("Done.")


if __name__ == "__main__":
    main()
