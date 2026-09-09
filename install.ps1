param(
  [switch]$DryRun,
  [switch]$SkipSetup,
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") { throw "此安装脚本仅支持 Windows。macOS 请运行 ./install.sh。" }
$Root = $PSScriptRoot
$RunScript = Join-Path $Root "scripts\run-workbench-windows.ps1"
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$NodeMajor = [int]((& $Node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -ne 24) { throw "需要 Node.js 24.x，当前为 $(& $Node --version)。" }

$DataDir = if ($env:PPT_WORKBENCH_DATA_DIR) { $env:PPT_WORKBENCH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "610PPT" }
$ShortcutSpecs = @(
  @{ Path = Join-Path ([Environment]::GetFolderPath("Desktop")) "610PPT.lnk"; Open = $true },
  @{ Path = Join-Path ([Environment]::GetFolderPath("Programs")) "610PPT.lnk"; Open = $true },
  @{ Path = Join-Path ([Environment]::GetFolderPath("Startup")) "610PPT.lnk"; Open = $false }
)

if ($DryRun) {
  Write-Output "610PPT Windows 安装检查通过。"
  Write-Output "源码目录：$Root"
  Write-Output "Node：$Node"
  Write-Output "数据目录：$DataDir"
  exit 0
}

if (-not $SkipSetup) {
  Push-Location $Root
  try {
    & $Npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败。" }
    & $Npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build 失败。" }
  } finally { Pop-Location }
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$Shell = New-Object -ComObject WScript.Shell
$Created = @()
try {
  foreach ($Spec in $ShortcutSpecs) {
    $Shortcut = $Shell.CreateShortcut($Spec.Path)
    $Shortcut.TargetPath = $PowerShell
    $OpenArg = if ($Spec.Open) { " -Open" } else { "" }
    $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$RunScript`"$OpenArg"
    $Shortcut.WorkingDirectory = $Root
    $Icon = Join-Path $Root "assets\icons\610PPT.ico"
    if (Test-Path $Icon) { $Shortcut.IconLocation = $Icon }
    $Shortcut.Description = "610PPT 本地工作台"
    $Shortcut.Save()
    $Created += $Spec.Path
  }
  $LaunchArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $RunScript)
  if (-not $NoOpen) { $LaunchArgs += "-Open" }
  & $PowerShell @LaunchArgs
  if ($LASTEXITCODE -ne 0) { throw "610PPT 启动失败。" }
} catch {
  foreach ($Path in $Created) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
  throw
}

Write-Output "610PPT 已安装并通过健康检查。"
Write-Output "工作台：http://127.0.0.1:$PublicPort/"
Write-Output "本地项目和设置：$DataDir"
