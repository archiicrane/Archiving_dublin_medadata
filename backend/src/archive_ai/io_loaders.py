import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from .types import ImageRecord


def _read_text_fallback(file_path: Path) -> str:
    raw = file_path.read_bytes()
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue

    return raw.decode("utf-8", errors="replace")


def load_s3_links(file_path: Path) -> List[str]:
    links = []
    text = _read_text_fallback(file_path)
    for line in text.splitlines():
        line = line.strip()
        if line:
            links.append(line)
    return links


def _extract_json_from_archive_js(raw: str) -> str:
    # Accepts formats like window.archiveRecords = [...];
    match = re.search(r"=\s*(\[.*\])\s*;?\s*$", raw, flags=re.DOTALL)
    if not match:
        raise ValueError("Could not parse archive-data.js assignment into JSON array.")
    return match.group(1)


def load_archive_data_js(file_path: Path) -> List[Dict[str, Any]]:
    raw = _read_text_fallback(file_path)
    json_blob = _extract_json_from_archive_js(raw)
    return json.loads(json_blob)


def load_archive_data_json(file_path: Path) -> List[Dict[str, Any]]:
    raw = _read_text_fallback(file_path)
    payload = json.loads(raw)
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and isinstance(payload.get("items"), list):
        return payload["items"]
    raise ValueError(f"Unsupported JSON shape in {file_path}")


def _filename_from_url(url: str) -> str:
    return Path(urlparse(url).path).name


def _normalize_filename_key(filename: str) -> str:
    return filename.strip().lower()


def _instance_id_from_filename(filename: str) -> str:
    return Path(filename).stem


def _image_id_from_filename(filename: str) -> str:
    stem = Path(filename).stem
    return stem.split("-")[0] if stem else ""


def _sheet_index_from_filename(filename: str) -> Optional[int]:
    stem = Path(filename).stem
    match = re.search(r"-(\d+)$", stem)
    return int(match.group(1)) if match else None


def _record_from_archive_entry(entry: Dict[str, Any], fallback_url: str = "") -> ImageRecord:
    url = entry.get("url") or fallback_url
    filename = entry.get("filename") or _filename_from_url(url)
    image_id = str(entry.get("id") or filename.split("-")[0])

    return ImageRecord(
        image_id=image_id,
        instance_id=_instance_id_from_filename(filename),
        url=url,
        filename=filename,
        title=entry.get("title") or entry.get("displayTitle") or filename,
        year=entry.get("year"),
        page=entry.get("page"),
        type=entry.get("type") or "drawing",
        project_key=entry.get("projectKey") or "",
        tags=entry.get("tags") or [],
        source_metadata=entry,
    )


def _pick_gallery_url(item: Dict[str, Any]) -> str:
    gallery = item.get("gallery") or []
    if isinstance(gallery, list) and gallery:
        first = gallery[0] if isinstance(gallery[0], dict) else {}
        for size_key in ("full", "large", "medium", "thumbnail"):
            size = first.get(size_key) if isinstance(first, dict) else None
            if isinstance(size, dict) and size.get("url"):
                return str(size["url"])
    return ""


def _normalize_allitems_entry(item: Dict[str, Any]) -> Dict[str, Any]:
    # Flat export shape (already carries direct filename/url/id fields).
    if item.get("filename") or item.get("url") or item.get("id"):
        url = str(item.get("url") or "").strip()
        filename = str(item.get("filename") or _filename_from_url(url)).strip()
        title = str(item.get("title") or item.get("displayTitle") or filename or item.get("id") or "").strip()

        return {
            "id": str(item.get("id") or item.get("number") or item.get("ID") or _image_id_from_filename(filename)).strip(),
            "url": url,
            "filename": filename,
            "title": title,
            "displayTitle": str(item.get("displayTitle") or "").strip(),
            "year": item.get("year"),
            "page": item.get("page") or None,
            "type": item.get("type") or "drawing",
            "projectKey": str(item.get("projectKey") or item.get("record_id") or "").strip().lower(),
            "tags": item.get("tags") or [],
            "source": "allitems",
            "source_raw": item,
        }

    url = _pick_gallery_url(item)
    groups = item.get("groups") or []
    project_title = ""
    if isinstance(groups, list) and groups:
        first_group = groups[0] if isinstance(groups[0], dict) else {}
        project_title = str(first_group.get("title") or "").strip()

    display_title = str(item.get("title") or "").strip()
    final_title = project_title or display_title or str(item.get("record_id") or "")

    return {
        "id": str(item.get("number") or item.get("ID") or "").strip(),
        "url": url,
        "filename": _filename_from_url(url) if url else "",
        "title": final_title,
        "displayTitle": display_title,
        "year": item.get("year"),
        "page": item.get("page") or None,
        "type": "drawing",
        "projectKey": str(item.get("record_id") or "").strip().lower(),
        "tags": [],
        "source": "allitems",
        "source_raw": item,
    }


def load_archive_entries(archive_data_file: Path, allitems_file: Optional[Path] = None) -> List[Dict[str, Any]]:
    if allitems_file and allitems_file.exists():
        raw_items = load_archive_data_json(allitems_file)
        normalized = [_normalize_allitems_entry(item) for item in raw_items if isinstance(item, dict)]
        normalized = [item for item in normalized if item.get("id") or item.get("filename") or item.get("url")]
        if normalized:
            return normalized

    return load_archive_data_js(archive_data_file)


def merge_links_with_archive_data(
    links: List[str], archive_entries: List[Dict[str, Any]]
) -> List[ImageRecord]:
    by_filename: Dict[str, Dict[str, Any]] = {}
    by_image_id: Dict[str, List[Dict[str, Any]]] = {}

    for entry in archive_entries:
        filename = entry.get("filename") or _filename_from_url(entry.get("url", ""))
        if filename:
            by_filename[_normalize_filename_key(filename)] = entry

        image_id = str(entry.get("id") or "").strip()
        if image_id:
            by_image_id.setdefault(image_id, []).append(entry)

    records = []
    for link in links:
        filename = _filename_from_url(link)
        filename_key = _normalize_filename_key(filename)
        matched = by_filename.get(filename_key)

        if not matched:
            link_image_id = _image_id_from_filename(filename)
            candidates = by_image_id.get(link_image_id, [])
            if len(candidates) == 1:
                matched = candidates[0]
            elif len(candidates) > 1:
                sheet_idx = _sheet_index_from_filename(filename)
                if sheet_idx is not None:
                    by_page = [c for c in candidates if c.get("page") is not None]
                    page_match = next((c for c in by_page if int(c.get("page", -1)) == sheet_idx + 1), None)
                    matched = page_match or candidates[min(sheet_idx, len(candidates) - 1)]
                else:
                    matched = candidates[0]

        if matched:
            records.append(_record_from_archive_entry(matched, fallback_url=link))
        else:
            minimal = {
                "url": link,
                "filename": filename,
                "id": _image_id_from_filename(filename),
                "title": filename,
                "type": "drawing",
                "tags": [],
            }
            records.append(_record_from_archive_entry(minimal, fallback_url=link))

    return records
