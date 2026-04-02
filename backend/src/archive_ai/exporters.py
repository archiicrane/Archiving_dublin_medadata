import csv
import json
from pathlib import Path
from typing import Dict, List

import cv2
import numpy as np


def save_json(path: Path, payload: Dict) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def save_region_connections(path: Path, payload: List[Dict]) -> None:
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def save_image_metadata(metadata: List[Dict], json_path: Path, csv_path: Path) -> None:
    json_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    rows = []
    for m in metadata:
        dc = m.get("dublin_core", {})
        rows.append(
            {
                "instance_id": m.get("instance_id"),
                "image_id": m.get("image_id"),
                "title": m.get("title"),
                "year": m.get("year"),
                "type": m.get("type"),
                "url": m.get("url"),
                "dc:title": dc.get("dc:title"),
                "dc:creator": dc.get("dc:creator"),
                "dc:subject": "|".join(dc.get("dc:subject", []))
                if isinstance(dc.get("dc:subject"), list)
                else dc.get("dc:subject"),
                "dc:date": dc.get("dc:date"),
                "dc:identifier": dc.get("dc:identifier"),
                "ocr_text": m.get("ocr_text", ""),
            }
        )

    if not rows:
        csv_path.write_text("", encoding="utf-8")
        return

    fieldnames = list(rows[0].keys())
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def save_annotated_matches(
    metadata_by_instance: Dict[str, Dict],
    edges: List[Dict],
    region_connections: List[Dict],
    output_dir: Path,
    max_pairs: int = 50,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    rc_by_pair = {}
    for rc in region_connections:
        key = (rc["source_instance_id"], rc["target_instance_id"])
        rc_by_pair.setdefault(key, []).append(rc)

    written = 0
    for edge in sorted(edges, key=lambda e: e["weight"], reverse=True):
        if written >= max_pairs:
            break

        src = edge["source"]
        tgt = edge["target"]
        pair_regions = rc_by_pair.get((src, tgt), [])
        if not pair_regions:
            continue

        src_meta = metadata_by_instance.get(src)
        tgt_meta = metadata_by_instance.get(tgt)
        if not src_meta or not tgt_meta:
            continue

        src_img_path = Path(src_meta.get("cache_path", ""))
        tgt_img_path = Path(tgt_meta.get("cache_path", ""))
        if not src_img_path.exists() or not tgt_img_path.exists():
            continue

        src_img = cv2.imread(str(src_img_path))
        tgt_img = cv2.imread(str(tgt_img_path))
        if src_img is None or tgt_img is None:
            continue

        src_copy = src_img.copy()
        tgt_copy = tgt_img.copy()

        for rc in pair_regions[:10]:
            s = rc["source_region"]
            t = rc["target_region"]
            cv2.rectangle(
                src_copy,
                (int(s["x"]), int(s["y"])),
                (int(s["x"] + s["width"]), int(s["y"] + s["height"])),
                (255, 0, 0),
                2,
            )
            cv2.rectangle(
                tgt_copy,
                (int(t["x"]), int(t["y"])),
                (int(t["x"] + t["width"]), int(t["y"] + t["height"])),
                (0, 255, 255),
                2,
            )

        max_h = max(src_copy.shape[0], tgt_copy.shape[0])
        src_padded = _pad_height(src_copy, max_h)
        tgt_padded = _pad_height(tgt_copy, max_h)
        canvas = np.hstack([src_padded, tgt_padded])

        out_path = output_dir / f"{src}__{tgt}.jpg"
        cv2.imwrite(str(out_path), canvas)
        written += 1


def _pad_height(img, target_h: int):
    if img.shape[0] == target_h:
        return img
    pad = target_h - img.shape[0]
    return cv2.copyMakeBorder(img, 0, pad, 0, 0, cv2.BORDER_CONSTANT, value=(20, 20, 20))
