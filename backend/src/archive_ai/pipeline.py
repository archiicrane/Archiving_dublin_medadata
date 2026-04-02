import argparse
import difflib
import re
import shutil
from pathlib import Path
from typing import Dict, List

from tqdm import tqdm

from .config import (
    ANNOTATED_DIR,
    CACHE_DIR,
    INPUT_ARCHIVE_ALLITEMS_FILE,
    INPUT_ARCHIVE_DATA_FILE,
    INPUT_DUBLIN_CORE_TTL,
    INPUT_LINKS_FILE,
    OUTPUT_CLUSTERS_JSON,
    OUTPUT_DC_SCHEMA_JSON,
    OUTPUT_IMAGE_GRAPH_JSON,
    OUTPUT_IMAGE_METADATA_CSV,
    OUTPUT_IMAGE_METADATA_JSON,
    OUTPUT_REGION_CROPS_DIR,
    OUTPUT_REGION_CONNECTIONS_JSON,
)
from .connection_builder import build_connections
from .dublin_core import normalize_to_dublin_core, parse_dublin_core_schema
from .exporters import (
    save_annotated_matches,
    save_image_metadata,
    save_json,
    save_region_connections,
)
from .feature_extractor import (
    compute_semantic_embeddings,
    cosine_matrix,
    extract_board_title,
    extract_ocr_text,
    extract_visual_features,
    fetch_image,
)
from .io_loaders import load_archive_entries, load_s3_links, merge_links_with_archive_data
from .structured_metadata import build_structured_board_metadata


def _normalize_title_for_match(value: str) -> str:
    text = re.sub(r"[^a-z0-9\s]", " ", str(value or "").lower())
    return re.sub(r"\s+", " ", text).strip()


def _title_similarity(a: str, b: str) -> float:
    na = _normalize_title_for_match(a)
    nb = _normalize_title_for_match(b)
    if not na or not nb:
        return 0.0

    ta = set(na.split())
    tb = set(nb.split())
    token_jaccard = len(ta & tb) / max(1, len(ta | tb))
    char_ratio = difflib.SequenceMatcher(None, na, nb).ratio()
    return max(token_jaccard, char_ratio)


def _canonicalize_project_titles(metadata: List[Dict]) -> None:
    grouped: Dict[str, List[Dict]] = {}
    for item in metadata:
        if not item.get("board_title"):
            continue
        if float(item.get("board_title_confidence") or 0.0) < 0.35:
            continue
        grouped.setdefault(str(item.get("project_key") or ""), []).append(item)

    for items in grouped.values():
        clusters: List[List[Dict]] = []
        for item in items:
            placed = False
            for cluster in clusters:
                if _title_similarity(item["board_title"], cluster[0]["board_title"]) >= 0.82:
                    cluster.append(item)
                    placed = True
                    break
            if not placed:
                clusters.append([item])

        for cluster in clusters:
            best = max(
                cluster,
                key=lambda r: (
                    float(r.get("board_title_confidence") or 0.0),
                    len(str(r.get("board_title") or "")),
                    sum(1 for w in str(r.get("board_title") or "").split() if w[:1].isupper()),
                ),
            )
            canonical = str(best.get("board_title") or "").strip()
            for item in cluster:
                item["canonical_board_title"] = canonical
                item["canonicalBoardTitle"] = canonical
                item["canonical_board_title_confidence"] = round(
                    max(float(item.get("board_title_confidence") or 0.0), float(best.get("board_title_confidence") or 0.0)),
                    3,
                )
                item["canonicalBoardTitleConfidence"] = item["canonical_board_title_confidence"]

    # Substring rescue pass: if a short title is likely a clipped fragment of a better title
    # in the same project (e.g. "ew Urban Block" vs "New Urban Block"), promote the better one.
    for project_key, items in grouped.items():
        _ = project_key
        long_titles = [
            str(it.get("canonical_board_title") or it.get("board_title") or "").strip()
            for it in items
            if str(it.get("canonical_board_title") or it.get("board_title") or "").strip()
        ]
        for item in items:
            current = str(item.get("canonical_board_title") or item.get("board_title") or "").strip()
            if not current:
                continue
            ncur = _normalize_title_for_match(current)
            replacement = None
            for candidate in long_titles:
                if candidate == current:
                    continue
                ncan = _normalize_title_for_match(candidate)
                if not ncan:
                    continue
                is_sub = ncur in ncan and len(ncan) >= len(ncur) + 1
                similar = _title_similarity(current, candidate) >= 0.86
                if is_sub and similar:
                    replacement = candidate
                    break
            if replacement:
                item["canonical_board_title"] = replacement
                item["canonicalBoardTitle"] = replacement


def run_pipeline(
    max_images: int = 0,
    enable_embeddings_model: bool = False,
    export_frontend: bool = True,
) -> Dict:
    links = load_s3_links(INPUT_LINKS_FILE)
    archive_entries = load_archive_entries(INPUT_ARCHIVE_DATA_FILE, INPUT_ARCHIVE_ALLITEMS_FILE)
    records = merge_links_with_archive_data(links, archive_entries)

    if max_images and max_images > 0:
        records = records[:max_images]

    dc_schema = parse_dublin_core_schema(str(INPUT_DUBLIN_CORE_TTL))
    save_json(OUTPUT_DC_SCHEMA_JSON, dc_schema)

    metadata: List[Dict] = []
    print(f"Processing {len(records)} images...")

    for rec in tqdm(records):
        item = {
            "image_id": rec.image_id,
            "instance_id": rec.instance_id,
            "url": rec.url,
            "filename": rec.filename,
            "title": rec.title,
            "year": rec.year,
            "page": rec.page,
            "type": rec.type,
            "project_key": rec.project_key,
            "tags": rec.tags,
            "source_metadata": rec.source_metadata,
        }

        item["dublin_core"] = normalize_to_dublin_core(item, dc_schema)

        cached = fetch_image(CACHE_DIR, rec.url)
        item["cache_path"] = str(cached) if cached else ""

        if cached:
            try:
                item["visual"] = extract_visual_features(cached)
            except Exception:
                item["visual"] = {}
            item["ocr_text"] = extract_ocr_text(cached)
            title_result = extract_board_title(cached)
            item["board_title"] = title_result["board_title"]
            item["board_title_confidence"] = title_result["board_title_confidence"]
            item["board_title_source"] = title_result["board_title_source"]
        else:
            item["visual"] = {}
            item["ocr_text"] = ""
            item["board_title"] = None
            item["board_title_confidence"] = 0.0
            item["board_title_source"] = "none"

        # Resolve the best display title:
        # Priority 1 — OCR-extracted board title (confidence ≥ 0.40)
        # Priority 2 — archive displayTitle / title from metadata
        # Priority 3 — parsed prettier filename (handled in frontend)
        if item["board_title"] and item["board_title_confidence"] >= 0.40:
            item["resolvedDisplayTitle"] = item["board_title"]
            item["resolvedTitleSource"] = "ocr"
        elif rec.source_metadata.get("displayTitle") and rec.source_metadata["displayTitle"] != rec.title:
            item["resolvedDisplayTitle"] = rec.source_metadata["displayTitle"]
            item["resolvedTitleSource"] = "metadata_display_title"
        else:
            item["resolvedDisplayTitle"] = None   # frontend will use filename parsing
            item["resolvedTitleSource"] = "filename_parse"

        metadata.append(item)

    _canonicalize_project_titles(metadata)

    for item in metadata:
        canonical = item.get("canonical_board_title")
        canonical_conf = float(item.get("canonical_board_title_confidence") or 0.0)
        if canonical and canonical_conf >= 0.40:
            item["resolvedDisplayTitle"] = canonical
            item["resolvedTitleSource"] = "ocr_canonical"
            item["canonicalBoardTitle"] = canonical
            item["canonicalBoardTitleConfidence"] = canonical_conf

    # === STAGE 3: BUILD STRUCTURED METADATA ===
    # Extract semantic text blocks, region types, and build rich board representations
    print("Building structured board metadata (Stage 3)...")
    for idx, item in enumerate(tqdm(metadata)):
        cached = item.get("cache_path")
        if cached and Path(cached).exists():
            try:
                structured = build_structured_board_metadata(item, Path(cached))
                # Merge structured metadata into item
                item.update(structured)
            except Exception as e:
                print(f"Error building structured metadata for {item.get('image_id')}: {e}")
                # Fallback: add empty structure
                item["extractedText"] = {"textBlocks": [], "keywords": [], "summary": "", "hasText": False}
                item["regions"] = []
                item["regionTypes"] = {}
                item["semanticTags"] = []
                item["contentSummary"] = ""

    embeddings = compute_semantic_embeddings(metadata, enable_model=enable_embeddings_model)

    for idx, emb in enumerate(embeddings):
        metadata[idx]["embedding"] = emb.tolist()

    # Useful for diagnostics and thresholds tuning.
    similarity = cosine_matrix(embeddings)

    graph_payload = build_connections(metadata, embeddings)
    graph_payload["embedding_similarity_preview"] = {
        "shape": [int(similarity.shape[0]), int(similarity.shape[1])],
        "sample": similarity[:5, :5].round(4).tolist(),
    }

    save_image_metadata(metadata, OUTPUT_IMAGE_METADATA_JSON, OUTPUT_IMAGE_METADATA_CSV)
    save_json(
        OUTPUT_IMAGE_GRAPH_JSON,
        {
            "nodes": graph_payload["nodes"],
            "edges": graph_payload["edges"],
            "connection_color_map": graph_payload["connection_color_map"],
            "embedding_similarity_preview": graph_payload["embedding_similarity_preview"],
        },
    )
    save_region_connections(OUTPUT_REGION_CONNECTIONS_JSON, graph_payload["region_connections"])
    save_json(OUTPUT_CLUSTERS_JSON, {"clusters": graph_payload["clusters"]})

    metadata_map = {m["instance_id"]: m for m in metadata}
    save_annotated_matches(
        metadata_map,
        graph_payload["edges"],
        graph_payload["region_connections"],
        ANNOTATED_DIR,
        max_pairs=80,
    )

    if export_frontend:
        _copy_outputs_to_frontend()

    return {
        "metadata_count": len(metadata),
        "node_count": len(graph_payload["nodes"]),
        "edge_count": len(graph_payload["edges"]),
        "region_connection_count": len(graph_payload["region_connections"]),
        "cluster_count": len(graph_payload["clusters"]),
    }


def _copy_outputs_to_frontend() -> None:
    root = Path(__file__).resolve().parents[3]
    target = root / "frontend" / "public" / "data"
    target.mkdir(parents=True, exist_ok=True)

    for src in [
        OUTPUT_IMAGE_METADATA_JSON,
        OUTPUT_IMAGE_GRAPH_JSON,
        OUTPUT_REGION_CONNECTIONS_JSON,
        OUTPUT_CLUSTERS_JSON,
        OUTPUT_DC_SCHEMA_JSON,
    ]:
        if src.exists():
            shutil.copy2(src, target / src.name)

    crop_target = target / "region_crops"
    if OUTPUT_REGION_CROPS_DIR.exists():
        if crop_target.exists():
            shutil.rmtree(crop_target)
        shutil.copytree(OUTPUT_REGION_CROPS_DIR, crop_target)


def main():
    parser = argparse.ArgumentParser(description="AI archive processing pipeline")
    parser.add_argument(
        "--max-images",
        type=int,
        default=0,
        help="Limit number of images for fast iteration (0 = all).",
    )
    parser.add_argument(
        "--enable-embeddings-model",
        action="store_true",
        help="Use sentence-transformers model instead of TF-IDF embeddings.",
    )
    parser.add_argument(
        "--no-frontend-export",
        action="store_true",
        help="Skip copying generated JSON files to frontend/public/data.",
    )

    args = parser.parse_args()
    stats = run_pipeline(
        max_images=args.max_images,
        enable_embeddings_model=args.enable_embeddings_model,
        export_frontend=not args.no_frontend_export,
    )

    print("Pipeline complete:")
    for k, v in stats.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
