# AI-Powered Interconnected Drawing Archive

This project builds an interactive, region-aware archive web for ~3,000 drawing images.

## 1) Inferred Input File Formats

### all-s3-links.txt
- Format: plain text, one public image URL per line.
- Example: `https://archivingresearch.s3.amazonaws.com/10002-2006-Urban_Voids_Grounds_for_Change-0.jpg`
- Parser behavior: blank lines ignored.

### archive-data.js
- Format: browser-style JS assignment of an array, e.g. `window.archiveRecords = [...]`.
- Each entry contains metadata fields such as:
  - `id`, `url`, `filename`, `title`, `displayTitle`, `year`, `page`, `type`, `projectKey`, `tags`, `relatedCount`
- Parser behavior: extracts the JSON array from the assignment and merges by filename with URL list.

### dublin_core_terms.ttl
- Format: RDF Turtle vocabulary file.
- Parser: `rdflib`
- Backbone fields extracted into internal schema:
  - `dc:title`, `dc:creator`, `dc:subject`, `dc:description`, `dc:date`, `dc:type`, `dc:format`, `dc:identifier`, `dc:source`, `dc:relation`, `dc:coverage`, `dc:rights`

## 2) Architecture Overview

### Backend (`backend/src/archive_ai`)
- `io_loaders.py`: load URL list + parse `archive-data.js` + merge records.
- `dublin_core.py`: parse TTL and normalize each image to Dublin Core fields.
- `feature_extractor.py`: image caching, visual features (histogram, edges, ORB keypoints/descriptors), OCR, semantic embedding vectors.
- `connection_builder.py`: staged candidate generation + multi-signal scoring + local region matching + clustering.
- `api_server.py`: secure backend API routes for board title extraction, image metadata extraction, and match explanation (`/api/*`).
- `exporters.py`: export JSON/CSV outputs + annotated side-by-side match images.
- `pipeline.py`: end-to-end orchestration and CLI entrypoint.

### Frontend (`frontend`)
- React + Cytoscape graph explorer.
- Node click opens full image modal.
- Modal renders clickable region hotspots.
- Hotspot click navigates to linked image / mini cluster list.
- Metadata side panel shows normalized Dublin Core fields.
- Filter controls: connection type, strength, subject, cluster.
- Color legend for connection semantics.

## 3) Performance Strategy (for ~3,000 images)

Staged pipeline is implemented:
1. Metadata + embedding indexing to generate nearest-neighbor candidates.
2. Candidate edges scored via metadata, semantic, OCR, composition signals.
3. Expensive local ORB region matching only on promising candidates.

This avoids all-pairs exhaustive expensive matching.

## 4) Data Outputs

Generated in `backend/data/processed` and copied to `frontend/public/data`:
- `image_metadata.json`
- `image_metadata.csv`
- `image_graph.json`
- `region_connections.json`
- `clusters.json`
- `dublin_core_schema.json`
- `region_crops/*.jpg` (source/target crop thumbnails for region cards)

Also generated:
- `backend/data/annotated_pairs/*.jpg` (annotated comparison outputs)

## 5) Region Connection Schema

Each region connection entry includes:
- `source_image_id`
- `target_image_id`
- `source_region` `{x,y,width,height}`
- `target_region` `{x,y,width,height}`
- `connection_type`
- `confidence_score`
- `explanation`
- `source_instance_id`
- `target_instance_id`

## 6) Run Instructions (Windows PowerShell)

### Run pipeline only
```powershell
.\scripts\run_pipeline.ps1 -MaxImages 300
```

Options:
- `-MaxImages 0` means all images.
- add `-EnableEmbeddingsModel` to use sentence-transformers CLIP text embedding path.

### Run frontend
```powershell
.\scripts\run_frontend.ps1
```

### Run backend API (required for `/api/*` routes)
```powershell
.\scripts\run_backend_api.ps1
```

Create backend env vars first:
1. Copy `backend/.env.example` to `backend/.env`
2. Set `OPENAI_API_KEY` in `backend/.env` (backend only, never frontend)

### Run both
```powershell
.\scripts\run_all.ps1 -MaxImages 300
```

## 10) Secure OpenAI Integration

- The frontend calls backend routes only:
  - `POST /api/extract-board-title`
  - `POST /api/extract-image-metadata`
  - `POST /api/explain-match`
- `OPENAI_API_KEY` is read only from backend environment variables.
- Responses are cached under `backend/data/cache/api/` to avoid repeated regeneration.
- If `OPENAI_API_KEY` is missing, routes still return heuristic fallback results.

## 7) Where to Plug Your Files

At project root:
- `all-s3-links.txt`
- `archive-data.js`
- `dublin_core_terms.ttl`

The backend config expects these exact root filenames.

## 8) Notes and Practical Decisions

- The pipeline prefers realistic defaults and robustness over brittle assumptions.
- OCR is optional and degrades gracefully if Tesseract is unavailable.
- Embeddings default to TF-IDF text vectors for lighter setup; model-based embeddings are switchable.
- Region-to-region links are produced from local ORB feature correspondences and exported with explicit coordinates.
- Connection colors are kept consistent across graph edges, hotspots, and legend:
  - blue: exact visual match
  - green: semantic similarity
  - yellow: composition/formal similarity
  - purple: OCR/text relation
  - red: metadata relation

## 9) Validation Schemas

JSON Schemas are provided in `schemas/`:
- `image_metadata.schema.json`
- `image_graph.schema.json`
- `region_connections.schema.json`
- `clusters.schema.json`
