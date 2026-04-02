# Batch metadata enrichment + RDF export
# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Sends every drawing IMAGE to OpenAI Vision (gpt-4o-mini).
#         OpenAI describes only what it can actually SEE in each image —
#         colours, drawing type, visual elements (trees, water, topography…),
#         medium, style, site context, building programme.
#         Saves results → frontend/public/data/enriched_metadata.json
#
# Step 2: Converts the enriched JSON to a reusable RDF Turtle file.
#         Vocabulary defined in: schemas/archival_drawing.ttl
#         Output → frontend/public/data/archive_drawings.ttl
#
# Run this ONCE.  After that, the website loads the pre-generated files at
# startup — no OpenAI calls happen when clicking drawings.
#
# Usage:
#   .\scripts\run_enrich_metadata.ps1
#   .\scripts\run_enrich_metadata.ps1 -BatchSize 5      # faster (5 images/call)
#   .\scripts\run_enrich_metadata.ps1 -StartFrom 300    # resume from record 300
#   .\scripts\run_enrich_metadata.ps1 -DryRun           # preview, no API calls
#   .\scripts\run_enrich_metadata.ps1 -NoVision         # text-only, no images
# ─────────────────────────────────────────────────────────────────────────────

param(
    [int]$BatchSize  = 3,
    [int]$StartFrom  = 0,
    [switch]$DryRun,
    [switch]$NoVision
)

$Root       = Split-Path -Parent $PSScriptRoot
$EnrichScript = Join-Path $Root "scripts\enrich_metadata.py"
$ExportScript = Join-Path $Root "scripts\export_rdf.py"

if (-not (Test-Path $EnrichScript)) { Write-Error "Not found: $EnrichScript"; exit 1 }
if (-not (Test-Path $ExportScript)) { Write-Error "Not found: $ExportScript"; exit 1 }

if (-not $env:OPENAI_API_KEY -and -not $DryRun) {
    Write-Error "OPENAI_API_KEY environment variable is not set.`nSet it with:  `$env:OPENAI_API_KEY = 'sk-...'"
    exit 1
}

# ── Step 1: Enrich ──────────────────────────────────────────────────────────
$args_list = @("--batch-size", $BatchSize, "--start-from", $StartFrom)
if ($DryRun)    { $args_list += "--dry-run"   }
if ($NoVision)  { $args_list += "--no-vision" }

Write-Host ""
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  STEP 1 — Enrich metadata with OpenAI Vision" -ForegroundColor Cyan
Write-Host "  batch-size=$BatchSize  start-from=$StartFrom" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan

python $EnrichScript @args_list

if ($LASTEXITCODE -ne 0) {
    Write-Host "`nEnrichment failed. See errors above." -ForegroundColor Red
    exit 1
}

if ($DryRun) {
    Write-Host "`nDry-run complete. No files written." -ForegroundColor Yellow
    exit 0
}

# ── Step 2: Export RDF ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  STEP 2 — Export RDF Turtle file" -ForegroundColor Cyan
Write-Host "═══════════════════════════════════════════" -ForegroundColor Cyan

python $ExportScript

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✓ All done." -ForegroundColor Green
    Write-Host "  Enriched JSON  → frontend/public/data/enriched_metadata.json" -ForegroundColor Green
    Write-Host "  RDF data file  → frontend/public/data/archive_drawings.ttl" -ForegroundColor Green
    Write-Host "  RDF vocabulary → schemas/archival_drawing.ttl" -ForegroundColor Green
    Write-Host ""
    Write-Host "Rebuild the frontend to serve the new files:" -ForegroundColor Yellow
    Write-Host "  cd frontend ; npm run build" -ForegroundColor Yellow
} else {
    Write-Host "`nRDF export failed. See errors above." -ForegroundColor Red
}

