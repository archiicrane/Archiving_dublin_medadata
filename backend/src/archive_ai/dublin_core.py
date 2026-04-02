from typing import Dict, List

from rdflib import Graph, Namespace
from rdflib.namespace import RDF, RDFS

DCTERMS = Namespace("http://purl.org/dc/terms/")

TARGET_TERMS = [
    "title",
    "creator",
    "subject",
    "description",
    "date",
    "type",
    "format",
    "identifier",
    "source",
    "relation",
    "coverage",
    "rights",
]


def parse_dublin_core_schema(ttl_path: str) -> Dict[str, Dict[str, str]]:
    graph = Graph()
    graph.parse(ttl_path, format="ttl")

    schema: Dict[str, Dict[str, str]] = {}
    for term in TARGET_TERMS:
        uri = DCTERMS[term]
        label = graph.value(uri, RDFS.label)
        comment = graph.value(uri, RDFS.comment)
        schema[f"dc:{term}"] = {
            "uri": str(uri),
            "label": str(label) if label else term,
            "description": str(comment) if comment else "",
            "rdf_type": str(graph.value(uri, RDF.type) or ""),
        }

    return schema


def normalize_to_dublin_core(record: Dict, dc_schema: Dict[str, Dict[str, str]]) -> Dict:
    tags = record.get("tags", [])
    identifier = record.get("instance_id") or record.get("filename")

    dc_record = {
        "dc:title": record.get("title", ""),
        "dc:creator": record.get("source_metadata", {}).get("creator", "unknown"),
        "dc:subject": tags,
        "dc:description": record.get("source_metadata", {}).get("description", ""),
        "dc:date": record.get("year"),
        "dc:type": record.get("type", "drawing"),
        "dc:format": record.get("source_metadata", {}).get("format", "image/jpeg"),
        "dc:identifier": identifier,
        "dc:source": record.get("url"),
        "dc:relation": record.get("source_metadata", {}).get("projectKey", ""),
        "dc:coverage": record.get("source_metadata", {}).get("coverage", ""),
        "dc:rights": record.get("source_metadata", {}).get("rights", ""),
    }

    # Keep only fields listed in parsed schema for strict alignment.
    return {k: v for k, v in dc_record.items() if k in dc_schema}
