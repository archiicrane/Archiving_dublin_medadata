Param(
  [int]$MaxImages = 0,
  [switch]$EnableEmbeddingsModel
)

$ErrorActionPreference = "Stop"

Set-Location "$PSScriptRoot\.."

if (-not (Test-Path ".venv")) {
  python -m venv .venv
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to create virtual environment with system python"
  }
}

.\.venv\Scripts\Activate.ps1

python --version
if ($LASTEXITCODE -ne 0) {
  throw "Could not run python in virtual environment"
}

python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
  throw "Failed to upgrade pip"
}

python -m pip install -r backend\requirements.txt
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install backend requirements. Ensure Python 3.10-3.12 is being used."
}

python -m pip install -e backend
if ($LASTEXITCODE -ne 0) {
  throw "Failed to install backend package"
}

$cmd = "python -m archive_ai.cli --max-images $MaxImages"
if ($EnableEmbeddingsModel) {
  $cmd = "$cmd --enable-embeddings-model"
}

Invoke-Expression $cmd
if ($LASTEXITCODE -ne 0) {
  throw "Pipeline execution failed"
}

Write-Host "Outputs generated in backend/data/processed and copied to frontend/public/data"
