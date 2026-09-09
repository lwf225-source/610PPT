param()

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$DataDir = if ($env:PPT_WORKBENCH_DATA_DIR) { $env:PPT_WORKBENCH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "610PPT" }
$PidFile = Join-Path $DataDir "workbench.pid"
$ProductionScript = Join-Path $Root "v2\server\production.js"

if (Test-Path $PidFile) {
  $RecordedPid = [int](Get-Content -LiteralPath $PidFile -Raw)
  try {
    $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $RecordedPid" -ErrorAction Stop
    $OwnsCommand = $ProcessInfo -and $ProcessInfo.CommandLine -and $ProcessInfo.CommandLine.IndexOf($ProductionScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($OwnsCommand) {
      Stop-Process -Id $RecordedPid -Force -ErrorAction Stop
    } elseif ($ProcessInfo) {
      Write-Warning "PID 已被其他进程使用，未终止该进程。"
    }
  } catch {
    Write-Warning "无法确认后台进程身份，未强制终止：$($_.Exception.Message)"
  }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

$ShortcutPaths = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "610PPT.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "610PPT.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Startup")) "610PPT.lnk")
)
foreach ($Path in $ShortcutPaths) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }

Write-Output "610PPT 启动入口已卸载。"
Write-Output "本地项目和设置已保留：$DataDir"
