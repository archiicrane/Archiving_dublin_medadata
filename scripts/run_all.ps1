Param(
  [int]$MaxImages = 0
)

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot"

.\run_pipeline.ps1 -MaxImages $MaxImages
.\run_frontend.ps1
