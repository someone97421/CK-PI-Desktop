param(
  [int]$MaxB64Chars = 200000,
  [string]$Qualities = "80,65,50"
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Drawing

$b64 = [Console]::In.ReadToEnd().Trim()
if (-not $b64) {
  Write-Output '{"ok":false,"error":"empty"}'
  exit 0
}

function Save-Jpeg([System.Drawing.Bitmap]$bitmap, [long]$quality) {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq "image/jpeg" } |
    Select-Object -First 1
  $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
  $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter (
    [System.Drawing.Imaging.Encoder]::Quality,
    $quality
  )
  $out = New-Object System.IO.MemoryStream
  $bitmap.Save($out, $codec, $encParams)
  $bytes = $out.ToArray()
  $out.Dispose()
  return [Convert]::ToBase64String($bytes)
}

function Resize-Bitmap([System.Drawing.Image]$src, [int]$w, [int]$h) {
  $dst = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $w, $h)
  $g.Dispose()
  return $dst
}

$bytes = [Convert]::FromBase64String($b64)
$in = New-Object System.IO.MemoryStream(,$bytes)
$src = $null
try {
  $src = [System.Drawing.Image]::FromStream($in)
  $ow = [int]$src.Width
  $oh = [int]$src.Height
  $qualities = @([int]($Qualities -replace '[^0-9].*', ''))
  $edges = @(0, 1280, 1024, 768)
  $best = $null
  foreach ($maxEdge in $edges) {
    $w = $ow
    $h = $oh
    $bitmap = $null
    $owned = $false
    if ($maxEdge -gt 0) {
      $edge = [Math]::Max($w, $h)
      if ($edge -gt $maxEdge) {
        $scale = $maxEdge / $edge
        $w = [Math]::Max(1, [int][Math]::Round($w * $scale))
        $h = [Math]::Max(1, [int][Math]::Round($h * $scale))
        $bitmap = Resize-Bitmap $src $w $h
        $owned = $true
      }
    }
    if (-not $bitmap) {
      if ($src -is [System.Drawing.Bitmap]) {
        $bitmap = [System.Drawing.Bitmap]$src
      } else {
        $bitmap = Resize-Bitmap $src $w $h
        $owned = $true
      }
    }
    try {
      foreach ($q in $qualities) {
        $jpeg = Save-Jpeg $bitmap ([long]$q)
        if ($jpeg.Length -le $MaxB64Chars) {
          [pscustomobject]@{
            ok = $true
            jpeg = $jpeg
            width = $w
            height = $h
            quality = $q
          } | ConvertTo-Json -Compress
          exit 0
        }
        $best = $jpeg
      }
    } finally {
      if ($owned -and $bitmap) { $bitmap.Dispose() }
    }
  }
  if ($best -and $best.Length -le $MaxB64Chars) {
    [pscustomobject]@{ ok = $true; jpeg = $best } | ConvertTo-Json -Compress
    exit 0
  }
  Write-Output '{"ok":false,"error":"too-large"}'
} catch {
  $msg = $_.Exception.Message.Replace('\', '\\').Replace('"', '\"')
  Write-Output ('{"ok":false,"error":"' + $msg + '"}')
  exit 0
} finally {
  if ($src) { $src.Dispose() }
  $in.Dispose()
}
