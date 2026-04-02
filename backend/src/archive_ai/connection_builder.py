from collections import defaultdict
from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import networkx as nx
import numpy as np

from .config import OUTPUT_REGION_CROPS_DIR
from .feature_extractor import extract_region_metrics, match_local_regions
from .content_matcher import (
    score_board_pair_content_aware,
    generate_content_based_explanation,
)

CONNECTION_TYPES = {
    "exact_visual_match": "#2563eb",
    "semantic_similarity": "#16a34a",
    "composition_similarity": "#facc15",
    "ocr_text_relation": "#7c3aed",
    "metadata_relation": "#dc2626",
    "content_aware_match": "#f59e0b",  # NEW: Content-based matches
}


def _metadata_overlap_score(a: Dict, b: Dict) -> float:
    a_subject = set(a.get("dublin_core", {}).get("dc:subject", []))
    b_subject = set(b.get("dublin_core", {}).get("dc:subject", []))
    if not a_subject and not b_subject:
        return 0.0
    intersection = len(a_subject.intersection(b_subject))
    union = max(1, len(a_subject.union(b_subject)))
    return intersection / union


def _ocr_overlap_score(a: Dict, b: Dict) -> float:
    sa = set(str(a.get("ocr_text", "")).lower().split())
    sb = set(str(b.get("ocr_text", "")).lower().split())
    if len(sa) < 3 or len(sb) < 3:
        return 0.0
    return len(sa.intersection(sb)) / max(1, len(sa.union(sb)))


def _composition_similarity(a: Dict, b: Dict) -> float:
    ha = np.array(a.get("visual", {}).get("color_histogram", []), dtype=float)
    hb = np.array(b.get("visual", {}).get("color_histogram", []), dtype=float)
    if ha.size == 0 or hb.size == 0:
        return 0.0
    diff = float(np.linalg.norm(ha - hb))
    return max(0.0, 1.0 - diff)


def generate_candidates(embeddings: np.ndarray, top_k: int = 25) -> List[Tuple[int, int, float]]:
    if embeddings.size == 0:
        return []

    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    normalized = embeddings / norms
    sim = normalized @ normalized.T

    candidates = []
    seen = set()
    n = sim.shape[0]
    for i in range(n):
        order = np.argsort(-sim[i])
        picked = 0
        for j_idx in order:
            j = int(j_idx)
            if j == i:
                continue
            pair = tuple(sorted((i, j)))
            if pair in seen:
                continue

            seen.add(pair)
            score = float(sim[i, j])
            candidates.append((pair[0], pair[1], score))
            picked += 1
            if picked >= top_k:
                break

    return candidates


def _region_quality_score(metrics: Dict) -> float:
    edge = float(metrics.get("edge_density", 0.0))
    keypoints = min(1.0, float(metrics.get("keypoint_count", 0)) / 45.0)
    contrast = float(metrics.get("contrast", 0.0))
    lines = float(metrics.get("line_density", 0.0))
    blank_penalty = 1.0 - float(metrics.get("blankness", 1.0))
    return max(0.0, min(1.0, 0.25 * edge + 0.3 * keypoints + 0.2 * contrast + 0.15 * lines + 0.1 * blank_penalty))


def _is_weak_blank_region(src_metrics: Dict, tgt_metrics: Dict) -> bool:
    blank = max(float(src_metrics.get("blankness", 1.0)), float(tgt_metrics.get("blankness", 1.0)))
    edges = max(float(src_metrics.get("edge_density", 0.0)), float(tgt_metrics.get("edge_density", 0.0)))
    keys = max(int(src_metrics.get("keypoint_count", 0)), int(tgt_metrics.get("keypoint_count", 0)))
    return blank >= 0.84 and edges < 0.02 and keys < 8


def _region_evidence_kinds(src_metrics: Dict, tgt_metrics: Dict, connection_type: str) -> List[str]:
    tags = set()
    if connection_type == "exact_visual_match":
        tags.update(["visual_pattern", "edges", "shape_structure"])

    if max(float(src_metrics.get("line_density", 0)), float(tgt_metrics.get("line_density", 0))) >= 0.12:
        tags.add("layout")
    if max(float(src_metrics.get("contrast", 0)), float(tgt_metrics.get("contrast", 0))) >= 0.22:
        tags.add("color_texture")
    if bool(src_metrics.get("text_presence")) or bool(tgt_metrics.get("text_presence")):
        tags.add("text")
    if max(float(src_metrics.get("blankness", 0)), float(tgt_metrics.get("blankness", 0))) >= 0.70:
        tags.add("blank_region")

    return sorted(tags)


def _region_explanation(src_metrics: Dict, tgt_metrics: Dict, quality_score: float) -> str:
    parts = []
    if bool(src_metrics.get("text_presence")) or bool(tgt_metrics.get("text_presence")):
        parts.append("Both crops include text-like structure")
    if max(float(src_metrics.get("line_density", 0)), float(tgt_metrics.get("line_density", 0))) >= 0.12:
        parts.append("line geometry is similarly dense")
    if max(float(src_metrics.get("edge_density", 0)), float(tgt_metrics.get("edge_density", 0))) >= 0.03:
        parts.append("edge patterns and corners align")
    if max(float(src_metrics.get("blankness", 0)), float(tgt_metrics.get("blankness", 0))) >= 0.72:
        parts.append("the compared area includes blank board space")

    if not parts:
        parts.append("local visual descriptors are similar")

    prefix = "Strong region evidence" if quality_score >= 0.55 else "Moderate region evidence"
    return f"{prefix}: " + "; ".join(parts) + "."


def _write_region_crop(image_path: str, region: Dict, output_path: Path) -> None:
    img = cv2.imread(str(image_path))
    if img is None:
        return

    h, w = img.shape[:2]
    x = int(max(0, min(w - 1, region.get("x", 0))))
    y = int(max(0, min(h - 1, region.get("y", 0))))
    rw = int(max(8, min(w - x, region.get("width", 0))))
    rh = int(max(8, min(h - y, region.get("height", 0))))
    crop = img[y : y + rh, x : x + rw]
    if crop.size == 0:
        return

    thumb = cv2.resize(crop, (140, 140), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(output_path), thumb)


def build_connections(records: List[Dict], embeddings: np.ndarray) -> Dict:
    OUTPUT_REGION_CROPS_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUTPUT_REGION_CROPS_DIR.glob("*.jpg"):
        old.unlink(missing_ok=True)

    graph = nx.Graph()
    for idx, rec in enumerate(records):
        graph.add_node(
            rec["instance_id"],
            image_id=rec["image_id"],
            title=rec["title"],
            type=rec.get("type", "drawing"),
            cluster=-1,
            index=idx,
        )

    region_connections = []
    edge_payloads = []
    region_id_counter = 1

    candidates = generate_candidates(embeddings, top_k=30)

    for i, j, semantic_score in candidates:
        a = records[i]
        b = records[j]

        metadata_score = _metadata_overlap_score(a, b)
        ocr_score = _ocr_overlap_score(a, b)
        composition_score = _composition_similarity(a, b)

        # NEW: Content-aware scoring (Stage 4 of refactoring)
        content_score = 0.0
        content_basis = ""
        content_region_matches = []
        try:
            content_score, content_types, content_region_matches = score_board_pair_content_aware(a, b)
            if content_types:
                content_basis = "_".join(content_types[:2])  # Take top 2 types
        except Exception as e:
            print(f"Content-aware scoring error for {a.get('image_id')} vs {b.get('image_id')}: {e}")
            content_score = 0.0
            content_basis = ""

        score_components = []
        types = []

        if semantic_score > 0.15:
            score_components.append(semantic_score * 0.35)
            types.append("semantic_similarity")

        if metadata_score > 0.0:
            score_components.append(metadata_score * 0.30)
            types.append("metadata_relation")

        if composition_score > 0.3:
            score_components.append(composition_score * 0.20)
            types.append("composition_similarity")

        if ocr_score > 0.05:
            score_components.append(ocr_score * 0.15)
            types.append("ocr_text_relation")

        # NEW: Content-aware is prioritized if available
        if content_score > 0.2:
            score_components.append(content_score * 0.40)
            types.append("content_aware_match")

        if not score_components:
            continue

        total = float(min(1.0, sum(score_components)))
        if total < 0.2:
            continue

        visual_conf, matched_regions = match_local_regions(a, b)
        region_refs = []
        if visual_conf > 0.2 and matched_regions:
            types.append("exact_visual_match")
            total = float(min(1.0, total + visual_conf * 0.2))

            for region in matched_regions[:12]:
                src_metrics = extract_region_metrics(Path(a["cache_path"]), region["source_region"])
                tgt_metrics = extract_region_metrics(Path(b["cache_path"]), region["target_region"])
                if _is_weak_blank_region(src_metrics, tgt_metrics):
                    continue

                quality = (_region_quality_score(src_metrics) + _region_quality_score(tgt_metrics)) / 2.0
                adjusted_conf = max(0.0, min(1.0, visual_conf * (0.72 + 0.48 * quality)))
                region_id = f"rc_{region_id_counter}"
                region_id_counter += 1

                src_crop_name = f"{region_id}_src.jpg"
                tgt_crop_name = f"{region_id}_tgt.jpg"
                _write_region_crop(a["cache_path"], region["source_region"], OUTPUT_REGION_CROPS_DIR / src_crop_name)
                _write_region_crop(b["cache_path"], region["target_region"], OUTPUT_REGION_CROPS_DIR / tgt_crop_name)

                evidence_kinds = _region_evidence_kinds(src_metrics, tgt_metrics, "exact_visual_match")
                payload = {
                    "id": region_id,
                    "source_image_id": a["image_id"],
                    "target_image_id": b["image_id"],
                    "source_instance_id": a["instance_id"],
                    "target_instance_id": b["instance_id"],
                    "source_region": region["source_region"],
                    "target_region": region["target_region"],
                    "connection_type": "exact_visual_match",
                    "confidence_score": adjusted_conf,
                    "explanation": _region_explanation(src_metrics, tgt_metrics, quality),
                    "source_region_metrics": src_metrics,
                    "target_region_metrics": tgt_metrics,
                    "evidence_kinds": evidence_kinds,
                    "weak_region": bool("blank_region" in evidence_kinds or adjusted_conf < 0.28),
                    "quality_score": round(quality, 3),
                    "source_system": "local_feature_matcher",
                    "source_crop_url": f"/data/region_crops/{src_crop_name}",
                    "target_crop_url": f"/data/region_crops/{tgt_crop_name}",
                    "color": CONNECTION_TYPES["exact_visual_match"],
                }
                region_connections.append(payload)
                region_refs.append(region_id)

        # Build structured, human-readable edge explanation
        edge_evidence = []
        edge_human_parts = []
        edge_sources = []

        # NEW: Include content-aware explanation if available
        if content_score > 0.15:
            content_explanation = generate_content_based_explanation(
                a, b, content_region_matches, types, content_score
            )
            edge_human_parts.insert(0, f"content-aware match ({content_score:.2f}) — {content_explanation}")
            edge_sources.append("content_aware_matcher")
            edge_evidence.append("content_structure")

        if visual_conf > 0:
            edge_evidence.extend(["visual_pattern", "edges", "shape_structure"])
            edge_human_parts.append(
                f"local visual pattern match (confidence {visual_conf:.2f}) — "
                "based on edges, contrast, and shape structure"
            )
            edge_sources.append("local_feature_matcher")
        if semantic_score > 0:
            edge_evidence.append("subject_similarity")
            edge_human_parts.append(
                f"semantic content similarity ({semantic_score:.2f}) — "
                "overall visual content compared by a similarity model"
            )
            edge_sources.append("semantic_similarity_model")
        if composition_score > 0:
            edge_evidence.extend(["layout", "color_texture"])
            edge_human_parts.append(
                f"color and composition similarity ({composition_score:.2f}) — "
                "similar tonal balance and color distribution"
            )
            edge_sources.append("color_composition_analysis")
        if ocr_score > 0:
            edge_evidence.append("text")
            edge_human_parts.append(
                f"shared OCR text ({ocr_score:.2f}) — "
                "matching words detected in both images"
            )
            edge_sources.append("ocr_text_matcher")
        if metadata_score > 0:
            edge_evidence.append("metadata")
            edge_human_parts.append(
                f"archive metadata overlap ({metadata_score:.2f}) — "
                "shared subject tags or catalog categories"
            )
            edge_sources.append("metadata_matcher")

        src = a["instance_id"]
        tgt = b["instance_id"]

        graph.add_edge(src, tgt, weight=total, connection_types=types)
        edge_payloads.append(
            {
                "source": src,
                "target": tgt,
                "weight": total,
                "connection_types": sorted(set(types)),
                "evidence_kinds": sorted(set(edge_evidence)),
                "source_systems": sorted(set(edge_sources)),
                "explanation": "; ".join(edge_human_parts) if edge_human_parts else "Connection based on combined signals.",
                "region_connection_ids": region_refs,
            }
        )

    communities = _compute_clusters(graph)
    for node, cluster_id in communities.items():
        graph.nodes[node]["cluster"] = cluster_id

    clusters = defaultdict(list)
    for node, attrs in graph.nodes(data=True):
        clusters[attrs["cluster"]].append(node)

    cluster_payload = []
    for cluster_id, nodes in clusters.items():
        cluster_payload.append(
            {
                "cluster_id": int(cluster_id),
                "node_count": len(nodes),
                "members": nodes,
                "summary": f"Cluster {cluster_id} with {len(nodes)} interconnected drawings.",
            }
        )

    node_payload = []
    for node, attrs in graph.nodes(data=True):
        node_payload.append(
            {
                "id": node,
                "image_id": attrs["image_id"],
                "label": attrs["title"],
                "type": attrs["type"],
                "cluster": attrs["cluster"],
            }
        )

    return {
        "nodes": node_payload,
        "edges": edge_payloads,
        "region_connections": region_connections,
        "clusters": cluster_payload,
        "connection_color_map": CONNECTION_TYPES,
    }


def _compute_clusters(graph: nx.Graph) -> Dict[str, int]:
    if graph.number_of_nodes() == 0:
        return {}

    try:
        import community as community_louvain  # python-louvain

        return community_louvain.best_partition(graph, weight="weight")
    except Exception:
        # Fallback: connected components as coarse clusters.
        mapping = {}
        for idx, component in enumerate(nx.connected_components(graph)):
            for node in component:
                mapping[node] = idx
        return mapping
