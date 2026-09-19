param(
  [Parameter(Mandatory = $true)][int]$ProcessId
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class OcuCap {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public struct Hit {
    public IntPtr Hwnd;
    public int X;
    public int Y;
    public int W;
    public int H;
    public bool Visible;
    public bool Ok;
  }

  public static void Init() {
    try { SetProcessDPIAware(); } catch {}
  }

  static uint TargetPid;
  static Hit BestHit;
  static long BestScore;

  static bool OnWindow(IntPtr hWnd, IntPtr lParam) {
    uint owner;
    GetWindowThreadProcessId(hWnd, out owner);
    if (owner != TargetPid) return true;
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) return true;
    if (rect.Left <= -10000 || rect.Top <= -10000) return true;
    int w = rect.Right - rect.Left;
    int h = rect.Bottom - rect.Top;
    if (w < 120 || h < 80) return true;
    if (IsIconic(hWnd)) return true;
    bool visible = IsWindowVisible(hWnd);
    if (!visible) {
      System.Text.StringBuilder title = new System.Text.StringBuilder(256);
      GetWindowText(hWnd, title, 256);
      if (title.Length == 0) return true;
    }
    long score = (long)w * h;
    if (visible) score += 1000000000L;
    if (score > BestScore) {
      BestScore = score;
      BestHit.Ok = true;
      BestHit.Hwnd = hWnd;
      BestHit.X = rect.Left;
      BestHit.Y = rect.Top;
      BestHit.W = w;
      BestHit.H = h;
      BestHit.Visible = visible;
    }
    return true;
  }

  public static Hit FindLargest(uint pid) {
    TargetPid = pid;
    BestHit = new Hit();
    BestScore = 0;
    EnumWindows(OnWindow, IntPtr.Zero);
    return BestHit;
  }

  public static bool TryPrint(IntPtr hwnd, IntPtr hdc) {
    if (PrintWindow(hwnd, hdc, 2)) return true;
    return PrintWindow(hwnd, hdc, 0);
  }
}
"@

[OcuCap]::Init()
$hit = [OcuCap]::FindLargest([uint32]$ProcessId)
if (-not $hit.Ok) {
  Write-Output '{"ok":false,"error":"no visible window"}'
  exit 0
}

function Save-PngB64([System.Drawing.Bitmap]$bitmap) {
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $b64 = [Convert]::ToBase64String($stream.ToArray())
  $stream.Dispose()
  return $b64
}

function Test-MostlyEmpty([System.Drawing.Bitmap]$bitmap) {
  $w = $bitmap.Width
  $h = $bitmap.Height
  if ($w -lt 2 -or $h -lt 2) { return $true }
  $samples = @(
    $bitmap.GetPixel([int]($w / 2), [int]($h / 2)),
    $bitmap.GetPixel([int]($w / 4), [int]($h / 4)),
    $bitmap.GetPixel([int](3 * $w / 4), [int](3 * $h / 4))
  )
  $empty = 0
  foreach ($px in $samples) {
    $max = [Math]::Max($px.R, [Math]::Max($px.G, $px.B))
    $min = [Math]::Min($px.R, [Math]::Min($px.G, $px.B))
    if ($max -lt 8 -or ($min -gt 247 -and ($max - $min) -lt 8)) { $empty++ }
  }
  return $empty -ge 2
}

$bitmap = New-Object System.Drawing.Bitmap $hit.W, $hit.H
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
$printed = $false
try { $printed = [OcuCap]::TryPrint($hit.Hwnd, $hdc) } catch { $printed = $false }
$graphics.ReleaseHdc($hdc)

if (-not $printed -or (Test-MostlyEmpty $bitmap)) {
  if (-not $hit.Visible) {
    $graphics.Dispose()
    $bitmap.Dispose()
    Write-Output '{"ok":false,"error":"no visible window"}'
    exit 0
  }
  try {
    $graphics.CopyFromScreen($hit.X, $hit.Y, 0, 0, $bitmap.Size)
  } catch {
    $graphics.Dispose()
    $bitmap.Dispose()
    Write-Output '{"ok":false,"error":"capture failed"}'
    exit 0
  }
}

$png = Save-PngB64 $bitmap
$graphics.Dispose()
$bitmap.Dispose()

$result = [pscustomobject]@{
  ok = $true
  width = $hit.W
  height = $hit.H
  x = $hit.X
  y = $hit.Y
  visible = [bool]$hit.Visible
  png = $png
}
Write-Output ($result | ConvertTo-Json -Compress)
