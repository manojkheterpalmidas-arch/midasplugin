# Package a plugin folder as a MIDAS CIVIL NX plugin zip.
#
# Do NOT use Compress-Archive for this. Windows PowerShell 5.1 writes
# `vendor\file.js` with BACKSLASH separators, which the ZIP spec forbids and
# which can stop a subfolder unpacking inside the host. The archive is therefore
# built entry by entry through .NET with the separator set explicitly.
#
#   .\pack.ps1 -Source "C:\...\my-plugin" -Out "C:\Users\me\Downloads\My Plugin v1.0.0.zip"

param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Out,
    # Development-only files that live in the source folder but must never ship.
    [string[]]$Exclude = @(
        "package.json",
        "package-lock.json",
        ".gitignore"
    ),
    # Folders excluded wholesale (prefix match on the relative path).
    [string[]]$ExcludeDirs = @("test", "mock-midas", "node_modules", ".git", ".claude", "scratchpad")
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$Source = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')

if (-not (Test-Path -LiteralPath (Join-Path $Source "index.html"))) {
    throw "No index.html in $Source. The host opens index.html from the ZIP ROOT."
}
if (-not (Test-Path -LiteralPath (Join-Path $Source "manifest.json"))) {
    throw "No manifest.json in $Source."
}

$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

$sep = [char]92   # backslash, kept out of the string literals below
$zip = [System.IO.Compression.ZipFile]::Open($Out, 'Create')
$added = 0
$skipped = 0

try {
    Get-ChildItem -LiteralPath $Source -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($Source.Length + 1).Replace($sep, '/')

        $firstSegment = $rel.Split('/')[0]
        if ($ExcludeDirs -contains $firstSegment) { $skipped++; return }
        if ($Exclude -contains $rel) { $skipped++; return }

        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
        $added++
    }
}
finally { $zip.Dispose() }

# Prove the result rather than assuming it.
$check = [System.IO.Compression.ZipFile]::OpenRead($Out)
$bad  = @($check.Entries | Where-Object { $_.FullName.Contains($sep) }).Count
$root = @($check.Entries | Where-Object { $_.FullName -eq 'index.html' }).Count
$check.Dispose()

Write-Output ("source          : {0}" -f $Source)
Write-Output ("output          : {0}" -f $Out)
Write-Output ("entries added   : {0}" -f $added)
Write-Output ("files skipped   : {0}" -f $skipped)
Write-Output ("backslash paths : {0}   (must be 0)" -f $bad)
Write-Output ("index.html at root: {0}   (must be 1)" -f $root)
Write-Output ("size            : {0:N2} MB" -f ((Get-Item -LiteralPath $Out).Length / 1MB))

if ($bad -gt 0)  { throw "The archive contains backslash separators." }
if ($root -ne 1) { throw "index.html is not at the zip root." }
