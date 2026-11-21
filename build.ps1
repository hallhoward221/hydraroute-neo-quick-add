$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$out = Join-Path $dist "HydraRouteNeo-Extension-$version.zip"

if (Test-Path $out) {
    Remove-Item $out -Force
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ('hrneo-build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$items = @(
    'manifest.json',
    'background.js',
    'options.html',
    'options.css',
    'options.js',
    'README.md',
    'LICENSE',
    'lib',
    'icons',
    'content'
)

try {
    foreach ($item in $items) {
        Copy-Item (Join-Path $root $item) (Join-Path $stage $item) -Recurse -Force
    }

    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $out -CompressionLevel Optimal
    Write-Host "Built: $out"
} finally {
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}
