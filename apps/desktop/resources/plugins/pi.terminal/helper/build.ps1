param(
    [ValidateSet('x64', 'arm64')]
    [string[]]$Architecture = @('x64', 'arm64')
)

$ErrorActionPreference = 'Stop'
$previousGoOs = $env:GOOS
$previousGoArch = $env:GOARCH
$previousCgo = $env:CGO_ENABLED
$vendorDir = Join-Path $PSScriptRoot '../vendor'

Push-Location $PSScriptRoot
try {
    New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null
    $env:GOOS = 'windows'
    $env:CGO_ENABLED = '0'
    foreach ($targetArchitecture in $Architecture) {
        $env:GOARCH = if ($targetArchitecture -eq 'x64') { 'amd64' } else { 'arm64' }
        $outputFile = Join-Path $vendorDir "pi-pty-win32-$targetArchitecture.exe"
        Write-Output "构建 Windows $targetArchitecture 终端助手"
        & go build -trimpath '-ldflags=-s -w -H windowsgui' -o $outputFile .
        if ($LASTEXITCODE -ne 0) { throw "Windows $targetArchitecture 助手构建失败" }
    }
} finally {
    $env:GOOS = $previousGoOs
    $env:GOARCH = $previousGoArch
    $env:CGO_ENABLED = $previousCgo
    Pop-Location
}
