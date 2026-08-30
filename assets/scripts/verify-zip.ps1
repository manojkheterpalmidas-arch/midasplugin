# Confirm a packaged plugin zip matches its source folder, entry by entry.
#
# Catches the two failures that actually happen: a stale zip built before the
# last edit, and a development-only file that leaked into a release.
#
#   .\verify-zip.ps1 -Source "C:\...\my-plugin" -Zip "C:\Users\me\Downloads\My Plugin v1.0.0.zip"

param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Zip,
    [string[]]$Exclude = @("package.json", "package-lock.json", ".gitignore"),
    [string[]]$ExcludeDirs = @("test", "mock-midas", "node_modules", ".git", ".claude", "scratchpad")
)

Add-Type -AssemblyName System.IO.Compression.FileSystem

$Source = (Resolve-Path -LiteralPath $Source).Path.TrimEnd('\')
$sep = [char]92

$archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
$mismatch = 0
$checked = 0

try {
    foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File -Force) {
        $rel = $file.FullName.Substring($Source.Length + 1).Replace($sep, '/')
        $firstSegment = $rel.Split('/')[0]

        $shouldShip = -not ($ExcludeDirs -contains $firstSegment) -and -not ($Exclude -contains $rel)

        $entry = $archive.Entries | Where-Object { $_.FullName -eq $rel }

        if (-not $shouldShip) {
            if ($entry) {
                Write-Output ("LEAKED   {0}   (development file present in the zip)" -f $rel)
                $mismatch++
            }
            continue
        }
        if (-not $entry) {
            Write-Output ("MISSING  {0}" -f $rel)
            $mismatch++
            continue
        }

        $stream = $entry.Open()
        $memory = New-Object System.IO.MemoryStream
        $stream.CopyTo($memory)
        $stream.Dispose()
        # CopyTo leaves the position at the end; hashing from there reads nothing.
        $memory.Position = 0
        $zipHash = (Get-FileHash -InputStream $memory -Algorithm SHA256).Hash
        $memory.Dispose()

        $diskHash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        $checked++
        if ($zipHash -ne $diskHash) {
            Write-Output ("STALE    {0}" -f $rel)
            $mismatch++
        }
    }

    # Anything in the zip with no counterpart on disk.
    foreach ($entry in $archive.Entries) {
        $onDisk = Join-Path $Source ($entry.FullName -replace '/', $sep)
        if (-not (Test-Path -LiteralPath $onDisk)) {
            Write-Output ("EXTRA    {0}   (in the zip, not in the source)" -f $entry.FullName)
            $mismatch++
        }
    }
}
finally { $archive.Dispose() }

Write-Output ("checked  : {0} file(s)" -f $checked)
Write-Output ("mismatch : {0}" -f $mismatch)
if ($mismatch -gt 0) { throw "The zip does not match the source." }
Write-Output "The zip matches the source."
