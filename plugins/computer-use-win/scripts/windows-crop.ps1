param(
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height
)

$ErrorActionPreference = "Stop"
$MaxInputBytes = 16MB
$MaxPngBytes = 3MB
$MaxDimension = 32768
$MaxPixels = 67108864

function Write-Result($Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 3))
}

$inputStream = $null
$source = $null
$crop = $null
$graphics = $null
$outputStream = $null

try {
  if ($X -lt 0 -or $Y -lt 0 -or $Width -le 0 -or $Height -le 0) {
    Write-Result ([pscustomobject]@{ ok = $false; code = "invalid_region"; error = "region must have a non-negative origin and positive size" })
    exit 0
  }

  Add-Type -AssemblyName System.Drawing
  $base64 = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrEmpty($base64) -or $base64.Length -gt 22369628 -or
      $base64 -notmatch '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$') {
    Write-Result ([pscustomobject]@{ ok = $false; code = "invalid_image"; error = "image input is not bounded base64" })
    exit 0
  }

  try {
    $bytes = [Convert]::FromBase64String($base64)
  } catch {
    Write-Result ([pscustomobject]@{ ok = $false; code = "invalid_image"; error = "image input is invalid base64" })
    exit 0
  }
  if ($bytes.Length -eq 0 -or $bytes.Length -gt $MaxInputBytes) {
    Write-Result ([pscustomobject]@{ ok = $false; code = "invalid_image"; error = "decoded image exceeds the input limit" })
    exit 0
  }

  $inputStream = New-Object System.IO.MemoryStream(,$bytes)
  try {
    $source = [System.Drawing.Image]::FromStream($inputStream, $true, $true)
    $sourceWidth = [int]$source.Width
    $sourceHeight = [int]$source.Height
  } catch {
    Write-Result ([pscustomobject]@{ ok = $false; code = "invalid_image"; error = "System.Drawing could not decode the image" })
    exit 0
  }

  if ($sourceWidth -le 0 -or $sourceHeight -le 0 -or
      $sourceWidth -gt $MaxDimension -or $sourceHeight -gt $MaxDimension -or
      ([long]$sourceWidth * [long]$sourceHeight) -gt $MaxPixels) {
    Write-Result ([pscustomobject]@{
      ok = $false; code = "image_too_large"; error = "source dimensions exceed the pixel budget"
      sourceWidth = $sourceWidth; sourceHeight = $sourceHeight
    })
    exit 0
  }

  if ($X -ge $sourceWidth -or $Y -ge $sourceHeight) {
    Write-Result ([pscustomobject]@{
      ok = $false; code = "region_out_of_bounds"; error = "region origin lies outside the source image"
      sourceWidth = $sourceWidth; sourceHeight = $sourceHeight
    })
    exit 0
  }

  $appliedWidth = [Math]::Min($Width, $sourceWidth - $X)
  $appliedHeight = [Math]::Min($Height, $sourceHeight - $Y)
  if ($appliedWidth -le 0 -or $appliedHeight -le 0 -or
      ([long]$appliedWidth * [long]$appliedHeight) -gt $MaxPixels) {
    Write-Result ([pscustomobject]@{
      ok = $false; code = "invalid_region"; error = "applied crop is empty or exceeds the pixel budget"
      sourceWidth = $sourceWidth; sourceHeight = $sourceHeight
    })
    exit 0
  }

  $crop = New-Object System.Drawing.Bitmap $appliedWidth, $appliedHeight
  $graphics = [System.Drawing.Graphics]::FromImage($crop)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $destination = New-Object System.Drawing.Rectangle 0, 0, $appliedWidth, $appliedHeight
  $graphics.DrawImage($source, $destination, $X, $Y, $appliedWidth, $appliedHeight, [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Dispose()
  $graphics = $null

  $outputStream = New-Object System.IO.MemoryStream
  $crop.Save($outputStream, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($outputStream.Length -gt $MaxPngBytes) {
    Write-Result ([pscustomobject]@{ ok = $false; code = "output_too_large"; error = "cropped PNG exceeds the output limit" })
    exit 0
  }
  $png = [Convert]::ToBase64String($outputStream.ToArray())
  Write-Result ([pscustomobject]@{
    ok = $true
    sourceWidth = $sourceWidth
    sourceHeight = $sourceHeight
    x = $X
    y = $Y
    width = $appliedWidth
    height = $appliedHeight
    png = $png
  })
  exit 0
} catch {
  $message = [string]$_.Exception.Message
  if ($message.Length -gt 240) { $message = $message.Substring(0, 240) }
  Write-Result ([pscustomobject]@{ ok = $false; code = "invalid_image"; error = $message })
  exit 0
} finally {
  if ($graphics) { $graphics.Dispose() }
  if ($outputStream) { $outputStream.Dispose() }
  if ($crop) { $crop.Dispose() }
  if ($source) { $source.Dispose() }
  if ($inputStream) { $inputStream.Dispose() }
}
