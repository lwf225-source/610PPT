param([string]$DataDirectory)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$DataDir = if ($DataDirectory) { $DataDirectory } elseif ($env:PPT_WORKBENCH_DATA_DIR) { $env:PPT_WORKBENCH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "610PPT" }
$PidFile = Join-Path $DataDir "workbench.pid"
$ProductionScript = Join-Path $Root "v2\server\production.js"

if (Test-Path $PidFile) {
  $RecordedPid = [int](Get-Content -LiteralPath $PidFile -Raw)
  try {
    $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $RecordedPid" -ErrorAction Stop
    $OwnsCommand = $ProcessInfo -and $ProcessInfo.CommandLine -and $ProcessInfo.CommandLine.IndexOf($ProductionScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($OwnsCommand) {
      & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $RecordedPid /T /F | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "Unable to stop the 610PPT process tree." }
    } elseif ($ProcessInfo) {
      Write-Warning "The recorded PID belongs to another process; it was not stopped."
    }
  } catch {
    Write-Warning "Unable to verify the background process; it was not force-stopped: $($_.Exception.Message)"
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

$ShortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "610PPT.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "610PPT.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Startup")) "610PPT.lnk")
)
foreach ($Path in $ShortcutPaths) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }

Write-Output "610PPT launch shortcuts were removed."
Write-Output "Local projects and settings were preserved: $DataDir"
