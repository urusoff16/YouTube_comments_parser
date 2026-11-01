$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Manifest = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot "manifest.json") | ConvertFrom-Json
$Version = $Manifest.version
$ReleaseRoot = Join-Path $ProjectRoot "release"
$StagingRoot = Join-Path $ReleaseRoot "staging"
$ArchivePath = Join-Path $ReleaseRoot "Comment-Tree-Exporter-for-YouTube-Chrome-v$Version.zip"
$ChecksumPath = "$ArchivePath.sha256.txt"

foreach ($Target in @($ReleaseRoot, $StagingRoot, $ArchivePath, $ChecksumPath)) {
  $FullTarget = [System.IO.Path]::GetFullPath($Target)
  if (-not $FullTarget.StartsWith($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe release target: $FullTarget"
  }
}

if (Test-Path -LiteralPath $StagingRoot) {
  Remove-Item -LiteralPath $StagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null

$Files = @(
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "collector.html",
  "collector.css",
  "collector.js",
  "content-proxy.js",
  "privacy.html",
  "info.css",
  "info.js",
  "README.md",
  "PRIVACY.md",
  "DISTRIBUTION.md"
)

foreach ($RelativePath in $Files) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $RelativePath) -Destination (Join-Path $StagingRoot $RelativePath)
}

foreach ($Directory in @("src", "_locales")) {
  Copy-Item -LiteralPath (Join-Path $ProjectRoot $Directory) -Destination (Join-Path $StagingRoot $Directory) -Recurse
}

$AssetsTarget = Join-Path $StagingRoot "assets"
New-Item -ItemType Directory -Path $AssetsTarget -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "assets") -Filter "icon-*.png" | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $AssetsTarget $_.Name)
}

if (Test-Path -LiteralPath $ArchivePath) {
  Remove-Item -LiteralPath $ArchivePath -Force
}
if (Test-Path -LiteralPath $ChecksumPath) {
  Remove-Item -LiteralPath $ChecksumPath -Force
}

Compress-Archive -Path (Join-Path $StagingRoot "*") -DestinationPath $ArchivePath -CompressionLevel Optimal
$Sha256 = [System.Security.Cryptography.SHA256]::Create()
$ArchiveStream = [System.IO.File]::OpenRead($ArchivePath)
try {
  $HashBytes = $Sha256.ComputeHash($ArchiveStream)
  $Hash = [System.BitConverter]::ToString($HashBytes).Replace("-", "").ToLowerInvariant()
} finally {
  $ArchiveStream.Dispose()
  $Sha256.Dispose()
}
Set-Content -LiteralPath $ChecksumPath -Value "$Hash  $([System.IO.Path]::GetFileName($ArchivePath))" -Encoding utf8
Remove-Item -LiteralPath $StagingRoot -Recurse -Force

Write-Output "Archive: $ArchivePath"
Write-Output "SHA256: $Hash"
