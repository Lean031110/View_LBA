# ViewLBA Server — MSI Build Script (mission §3, §31)
# ====================================================================
# Builds the canonical Windows installer using WiX v4.
#
# Usage:
#   pwsh installer/windows-msi/build-msi.ps1 -Version 3.3.0 -PayloadDir dist/release/windows/ViewLBA-Server -BuildDir dist/release/windows/stage -OutDir dist/release/windows/out
#
# Output:
#   $OutDir\ViewLBA-Server-Setup-$VERSION.msi
#   $OutDir\ViewLBA-Server-Setup-$VERSION.msi.sha256
#   $OutDir\manifest.json (with MSI checksum, components, build reproducibility)

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [Parameter(Mandatory=$true)]
    [string]$PayloadDir,

    [Parameter(Mandatory=$true)]
    [string]$BuildDir,

    [Parameter(Mandatory=$true)]
    [string]$OutDir,

    [string]$UpgradeCode = "E7A3F5B2-9C41-4D8E-A6F3-7B5E1D2C9A80"
)

$ErrorActionPreference = "Stop"

Write-Host "=== ViewLBA MSI Build ===" -ForegroundColor Cyan
Write-Host "Version:      $Version"
Write-Host "PayloadDir:   $PayloadDir"
Write-Host "BuildDir:     $BuildDir"
Write-Host "OutDir:       $OutDir"
Write-Host "UpgradeCode:  $UpgradeCode"
Write-Host ""

# Verify inputs
if (-not (Test-Path $PayloadDir)) {
    throw "PayloadDir does not exist: $PayloadDir"
}
if (-not (Test-Path $BuildDir)) {
    throw "BuildDir does not exist: $BuildDir"
}
if (-not (Test-Path "$BuildDir\viewlba-service.exe")) {
    throw "viewlba-service.exe missing from BuildDir: $BuildDir (did build-windows-native.yml run?)"
}
if (-not (Test-Path "$BuildDir\viewlba-tray.exe")) {
    throw "viewlba-tray.exe missing from BuildDir: $BuildDir"
}

# Ensure WiX v4 is available
$wix = Get-Command wix -ErrorAction SilentlyContinue
if (-not $wix) {
    Write-Host "Installing WiX v4 via dotnet tool..." -ForegroundColor Yellow
    dotnet tool install --global wix --version 4.0.5
    $env:Path = "$env:USERPROFILE\.dotnet\tools;$env:Path"
    $wix = Get-Command wix -ErrorAction SilentlyContinue
    if (-not $wix) {
        throw "WiX v4 not installed. Install with: dotnet tool install --global wix"
    }
}
Write-Host "WiX v4 found: $($wix.Source)" -ForegroundColor Green

# Create out dir
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Build MSI
$msiName = "ViewLBA-Server-Setup-$Version.msi"
$msiPath = Join-Path $OutDir $msiName
Write-Host "Building MSI: $msiPath" -ForegroundColor Cyan

& wix build installer/windows-msi/viewlba.wxs `
    -o $msiPath `
    -d "VERSION=$Version" `
    -d "UPGRADE_CODE=$UpgradeCode" `
    -d "BUILD_DIR=$BuildDir" `
    -d "PAYLOAD_DIR=$PayloadDir" `
    -ext "WixToolset.UI.wixext"

if ($LASTEXITCODE -ne 0) {
    throw "WiX build failed with exit code $LASTEXITCODE"
}
Write-Host "MSI built: $msiPath" -ForegroundColor Green

# SHA256
$hash = (Get-FileHash $msiPath -Algorithm SHA256).Hash.ToLower()
$shaPath = "$msiPath.sha256"
"$hash *$msiName" | Out-File -Encoding ASCII $shaPath
Write-Host "SHA256: $hash" -ForegroundColor Green

# manifest.json
$manifest = @{
    version = $Version
    commit_sha = $env:GITHUB_SHA
    build_date = (Get-Date).ToUniversalTime().ToString("o")
    platform = "windows"
    architecture = "x86_64"
    installer_type = "msi"
    installer_version = "wix v4"
    components = @(
        @{ name = $msiName; sha256 = $hash; size_bytes = (Get-Item $msiPath).Length }
    )
    dependencies_excluded = @("NSSM", "PowerShell", "CMD", "sc.exe", "find.exe")
    build_reproducibility = @{
        wix_version = (wix --version)
        upgrade_code = $UpgradeCode
    }
}
$manifestPath = Join-Path $OutDir "manifest.json"
$manifest | ConvertTo-Json -Depth 6 | Out-File -Encoding UTF8 $manifestPath

Write-Host "Manifest: $manifestPath" -ForegroundColor Green
Write-Host ""
Write-Host "=== MSI Build Complete ===" -ForegroundColor Cyan
Write-Host "Files in $OutDir :"
Get-ChildItem $OutDir | ForEach-Object {
    Write-Host "  $($_.Name)  ($($_.Length) bytes)"
}
