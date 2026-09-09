param(
  [switch]$Open,
  [string]$DataDirectory
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$PublicPort = if ($env:PPT_WORKBENCH_API_PORT) { [int]$env:PPT_WORKBENCH_API_PORT } else { 5176 }
$EnginePort = if ($env:PPT_V1_ENGINE_PORT) { [int]$env:PPT_V1_ENGINE_PORT } else { 6176 }
$DataDir = if ($DataDirectory) { $DataDirectory } elseif ($env:PPT_WORKBENCH_DATA_DIR) { $env:PPT_WORKBENCH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "610PPT" }
$HealthUrl = "http://127.0.0.1:$PublicPort/api/health"
$ProductionScript = Join-Path $Root "v2\server\production.js"
$RuntimeSource = Get-Content -LiteralPath (Join-Path $Root "shared\runtime-version.js") -Raw
if ($RuntimeSource -notmatch 'WORKBENCH_BUILD_ID\s*=\s*"([^"]+)"') { throw "Unable to read the current 610PPT build ID." }
$ExpectedBuildId = $Matches[1]

function Test-Health {
  try {
    $Health = Invoke-RestMethod -UseBasicParsing -Uri $HealthUrl -TimeoutSec 1
    return $Health.ok -eq $true -and $Health.engine -eq "connected" -and $Health.buildId -eq $ExpectedBuildId
  } catch { return $false }
}

if (-not (Test-Health)) {
  $Node = (Get-Command node.exe -ErrorAction Stop).Source
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "logs") | Out-Null
  $env:PPT_WORKBENCH_API_PORT = [string]$PublicPort
  $env:PPT_V2_PORT = [string]$PublicPort
  $env:PPT_V1_ENGINE_PORT = [string]$EnginePort
  $env:PPT_V2_V1_BASE_URL = "http://127.0.0.1:$EnginePort"
  $env:PPT_WORKBENCH_DATA_DIR = $DataDir
  $OutLog = Join-Path $DataDir "logs\workbench-service.stdout.log"
  $ErrLog = Join-Path $DataDir "logs\workbench-service.stderr.log"
  $NodeArgs = '"' + $ProductionScript + '"'
  $Process = Start-Process -FilePath $Node -ArgumentList $NodeArgs -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
  Set-Content -Path (Join-Path $DataDir "workbench.pid") -Value $Process.Id -Encoding ascii
  for ($i = 0; $i -lt 80 -and -not (Test-Health); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Health)) {
    if (-not $Process.HasExited) { Stop-Process -Id $Process.Id -Force }
    throw "610PPT failed its startup health check. Logs: $DataDir\logs"
  }
}

if ($Open) { Start-Process "http://127.0.0.1:$PublicPort/" }
