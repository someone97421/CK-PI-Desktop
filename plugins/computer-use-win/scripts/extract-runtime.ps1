param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
try {
  foreach ($name in @('cua-driver.exe', 'cua-driver-uia.exe', 'cua-cursor-theme.exe')) {
    $entry = $zip.GetEntry("cua-driver-rs-0.28.2-windows-x86_64/$name")
    if ($null -eq $entry) { throw "Missing bundled runtime: $name" }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, [System.IO.Path]::Combine($Destination, $name), $true)
  }
} finally { $zip.Dispose() }
