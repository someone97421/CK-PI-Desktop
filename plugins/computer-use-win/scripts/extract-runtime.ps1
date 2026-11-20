param(
  [Parameter(Mandatory=$true)][string]$Archive,
  [Parameter(Mandatory=$true)][string]$Destination,
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$Files
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  foreach ($name in ($Files -split ',')) {
    $entry = $zip.GetEntry("$Root/$name")
    if ($null -eq $entry) { throw "Missing bundled runtime: $name" }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, [System.IO.Path]::Combine($Destination, $name), $true)
  }
} finally { $zip.Dispose() }
