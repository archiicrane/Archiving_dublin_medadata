from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ImageRecord:
    image_id: str
    instance_id: str
    url: str
    filename: str
    title: str
    year: Optional[int]
    page: Optional[int]
    type: str
    project_key: str
    tags: List[str]
    source_metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RegionConnection:
    source_image_id: str
    target_image_id: str
    source_region: Dict[str, float]
    target_region: Dict[str, float]
    connection_type: str
    confidence: float
    explanation: str
    source_instance_id: str
    target_instance_id: str


@dataclass
class ImageConnection:
    source_instance_id: str
    target_instance_id: str
    weight: float
    connection_types: List[str]
    explanation: str
    region_connection_ids: List[str] = field(default_factory=list)
