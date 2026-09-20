# Fail-closed compatibility wrapper; never retry a paste or move the caret.
# Parameter is -ClipFile (not -File) so powershell.exe -File <script> is unambiguous.
param(
  [string]$ClipFile = "",
  [int64]$Hwnd = 0,
  [uint32]$TargetPid = 0
)
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$result = [ordered]@{
  ok = $false; code = 'helper_error'; sent = 0; expected = 4
  foreground_hwnd = 0; focus_hwnd = 0; target_hwnd = $Hwnd; target_pid = $TargetPid; last_error = 0
}
try {
  # Manual validation avoids a mandatory-parameter prompt and emits JSON even when omitted.
  if (-not $PSBoundParameters.ContainsKey('TargetPid') -or $TargetPid -eq 0 -or
      -not $PSBoundParameters.ContainsKey('Hwnd') -or $Hwnd -eq 0) {
    $result.code = 'target_required'
  } else {
    if ($ClipFile) {
      if (-not (Test-Path -LiteralPath $ClipFile -PathType Leaf)) { throw "paste clip file missing" }
      $text = [System.IO.File]::ReadAllText($ClipFile, (New-Object System.Text.UTF8Encoding $false))
      Set-Clipboard -Value $text
    }
    $helper = Join-Path $PSScriptRoot 'windows-send-key.ps1'
    $LASTEXITCODE = 0
    $output = & $helper -Hwnd $Hwnd -TargetPid $TargetPid -Key v -Control
    $helperExit = $LASTEXITCODE
    $delivery = ($output -join "`n") | ConvertFrom-Json
    if ($null -eq $delivery -or $delivery.ok -isnot [bool] -or
        $null -eq $delivery.sent -or $null -eq $delivery.expected) {
      throw "invalid paste helper result"
    }
    $result = $delivery
    if ($result.ok -and ($helperExit -ne 0 -or $result.code -ne 'transport_sent' -or
        $result.sent -ne 4 -or $result.expected -ne 4)) {
      $result.ok = $false
      $result.code = 'invalid_paste_delivery'
    }
  }
} catch {
  $result.ok = $false
  [Console]::Error.WriteLine($_.Exception.Message.Substring(0, [Math]::Min(800, $_.Exception.Message.Length)))
}
$result | ConvertTo-Json -Compress
if (-not $result.ok) { exit 1 }
