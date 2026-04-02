from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
INPUT_LINKS_FILE = ROOT / "all-s3-links.txt"
INPUT_ARCHIVE_DATA_FILE = ROOT / "archive-data.js"
INPUT_ARCHIVE_ALLITEMS_FILE = ROOT / "allitems.json"
INPUT_DUBLIN_CORE_TTL = ROOT / "dublin_core_terms.ttl"

DATA_DIR = ROOT / "backend" / "data"
CACHE_DIR = DATA_DIR / "cache"
API_CACHE_DIR = CACHE_DIR / "api"
PROCESSED_DIR = DATA_DIR / "processed"
ANNOTATED_DIR = DATA_DIR / "annotated_pairs"
OUTPUT_REGION_CROPS_DIR = PROCESSED_DIR / "region_crops"

OUTPUT_IMAGE_METADATA_JSON = PROCESSED_DIR / "image_metadata.json"
OUTPUT_IMAGE_METADATA_CSV = PROCESSED_DIR / "image_metadata.csv"
OUTPUT_IMAGE_GRAPH_JSON = PROCESSED_DIR / "image_graph.json"
OUTPUT_REGION_CONNECTIONS_JSON = PROCESSED_DIR / "region_connections.json"
OUTPUT_CLUSTERS_JSON = PROCESSED_DIR / "clusters.json"
OUTPUT_DC_SCHEMA_JSON = PROCESSED_DIR / "dublin_core_schema.json"

for folder in [
    DATA_DIR,
    CACHE_DIR,
    API_CACHE_DIR,
    PROCESSED_DIR,
    OUTPUT_REGION_CROPS_DIR,
    ANNOTATED_DIR,
]:
    folder.mkdir(parents=True, exist_ok=True)
