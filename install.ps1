param(
  [switch]$DryRun,
  [switch]$SkipSetup,
  [switch]$NoOpen,
  [string]$DataDirectory
)

$ErrorActionPreference = "Stop"
if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") { throw "This installer only supports Windows. On macOS, run ./install.sh." }
$Root = $PSScriptRoot
$RunScript = Join-Path $Root "scripts\run-workbench-windows.ps1"
$Node = (Get-Command node.exe -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$NodeMajor = [int]((& $Node -p "process.versions.node.split('.')[0]").Trim())
if ($NodeMajor -ne 24) { throw "Node.js 24.x is required; found $(& $Node --version)." }

$DataDir = if ($DataDirectory) { $DataDirectory } elseif ($env:PPT_WORKBENCH_DATA_DIR) { $env:PPT_WORKBENCH_DATA_DIR } else { Join-Path $env:LOCALAPPDATA "610PPT" }
$PublicPort = if ($env:PPT_WORKBENCH_API_PORT) { [int]$env:PPT_WORKBENCH_API_PORT } else { 5176 }
$ShortcutSpecs = @(
  @{ Path = Join-Path ([Environment]::GetFolderPath("Desktop")) "610PPT.lnk"; Open = $true },
  @{ Path = Join-Path ([Environment]::GetFolderPath("Programs")) "610PPT.lnk"; Open = $true },
  @{ Path = Join-Path ([Environment]::GetFolderPath("Startup")) "610PPT.lnk"; Open = $false }
)

if ($DryRun) {
  Write-Output "610PPT Windows installer check passed."
  Write-Output "Source: $Root"
  Write-Output "Node: $Node"
  Write-Output "Data: $DataDir"
  exit 0
}

if (-not $SkipSetup) {
  Push-Location $Root
  try {
    & $Npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    & $Npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
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
    $Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$RunScript`" -DataDirectory `"$DataDir`"$OpenArg"
    $Shortcut.WorkingDirectory = $Root
    $Icon = Join-Path $Root "assets\icons\610PPT.ico"
    if (Test-Path $Icon) { $Shortcut.IconLocation = $Icon }
    $Shortcut.Description = "610PPT local workbench"
    $Shortcut.Save()
    $Created += $Spec.Path
  }
  $LaunchArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $RunScript, "-DataDirectory", $DataDir)
  if (-not $NoOpen) { $LaunchArgs += "-Open" }
  & $PowerShell @LaunchArgs
  if ($LASTEXITCODE -ne 0) { throw "610PPT failed to start." }
} catch {
  foreach ($Path in $Created) { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue }
  throw
}

Write-Output "610PPT installed and passed its health check."
Write-Output "Workbench: http://127.0.0.1:$PublicPort/"
Write-Output "Local projects and settings: $DataDir"
