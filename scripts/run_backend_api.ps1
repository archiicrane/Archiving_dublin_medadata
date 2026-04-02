param(
  [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'

Set-Location "$PSScriptRoot\..\backend"

if (-not (Test-Path "..\.venv\Scripts\python.exe")) {
  throw "Missing virtual environment at ..\.venv\Scripts\python.exe"
}

& "..\.venv\Scripts\python.exe" -m uvicorn archive_ai.api_server:app --host 127.0.0.1 --port $Port --reload
