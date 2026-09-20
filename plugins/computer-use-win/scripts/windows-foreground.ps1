param([Parameter(Mandatory = $true)][int]$ProcessId)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OcuFg {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct Info {
    public IntPtr Hwnd;
    public int W;
    public int H;
    public bool Visible;
    public bool Iconic;
    public bool Offscreen;
    public bool Ok;
  }
  const int SW_RESTORE = 9;
  static uint TargetPid;
  static Info BestVisible;
  static Info BestHidden;
  static int BestVisibleArea;
  static int BestHiddenArea;

  static Info FromHwnd(IntPtr hWnd) {
    Info info = new Info();
    info.Hwnd = hWnd;
    RECT rect;
    if (!GetWindowRect(hWnd, out rect)) return info;
    info.W = rect.Right - rect.Left;
    info.H = rect.Bottom - rect.Top;
    info.Visible = IsWindowVisible(hWnd);
    info.Iconic = IsIconic(hWnd);
    info.Offscreen = rect.Left <= -10000 || rect.Top <= -10000;
    info.Ok = true;
    return info;
  }

  static bool OnWindow(IntPtr hWnd, IntPtr lParam) {
    uint owner;
    GetWindowThreadProcessId(hWnd, out owner);
    if (owner != TargetPid) return true;
    Info info = FromHwnd(hWnd);
    if (!info.Ok) return true;
    bool tooSmall = info.W < 120 || info.H < 80;
    bool usableVisible = info.Visible && !info.Iconic && !info.Offscreen && !tooSmall;
    if (usableVisible) {
      int area = info.W * info.H;
      if (area > BestVisibleArea) {
        BestVisibleArea = area;
        BestVisible = info;
      }
      return true;
    }
    StringBuilder title = new StringBuilder(256);
    GetWindowText(hWnd, title, 256);
    // Tiny visible title bars (160x28), tray/hidden, iconic, or offscreen: restore candidates.
    if (title.Length == 0 && !tooSmall && info.Visible) return true;
    if (title.Length == 0 && !info.Visible && !info.Iconic && tooSmall) return true;
    int hiddenArea = Math.Max(1, info.W * info.H);
    if (hiddenArea > BestHiddenArea) {
      BestHiddenArea = hiddenArea;
      BestHidden = info;
    }
    return true;
  }

  public static Info FindBest(uint pid) {
    TargetPid = pid;
    BestVisible = new Info();
    BestHidden = new Info();
    BestVisibleArea = 0;
    BestHiddenArea = 0;
    EnumWindows(OnWindow, IntPtr.Zero);
    return BestVisible.Ok ? BestVisible : BestHidden;
  }

  public static Info Describe(IntPtr hwnd) {
    return FromHwnd(hwnd);
  }

  public static bool Focus(IntPtr hwnd) {
    if (hwnd == IntPtr.Zero) return false;
    Info before = FromHwnd(hwnd);
    bool needShow = before.Iconic || !before.Visible || before.Offscreen || before.W < 120 || before.H < 80;
    if (needShow) ShowWindow(hwnd, SW_RESTORE);
    if (!needShow && GetForegroundWindow() == hwnd) return true;
    IntPtr fg = GetForegroundWindow();
    uint fgPid;
    uint fgTid = GetWindowThreadProcessId(fg, out fgPid);
    uint self = GetCurrentThreadId();
    uint targetPid;
    uint targetTid = GetWindowThreadProcessId(hwnd, out targetPid);
    bool attachedFg = false;
    bool attachedTarget = false;
    if (fgTid != 0 && fgTid != self) attachedFg = AttachThreadInput(self, fgTid, true);
    if (targetTid != 0 && targetTid != self && targetTid != fgTid) attachedTarget = AttachThreadInput(self, targetTid, true);
    BringWindowToTop(hwnd);
    bool ok = SetForegroundWindow(hwnd);
    if (!ok && GetForegroundWindow() != hwnd) {
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      ok = SetForegroundWindow(hwnd);
    }
    if (attachedTarget) AttachThreadInput(self, targetTid, false);
    if (attachedFg) AttachThreadInput(self, fgTid, false);
    Info after = FromHwnd(hwnd);
    return after.Visible && !after.Iconic && !after.Offscreen;
  }
}
"@

$hit = [OcuFg]::FindBest([uint32]$ProcessId)
if (-not $hit.Ok) {
  Write-Output '{"ok":false,"error":"no window"}'
  exit 0
}

$ok = $false
$info = $hit
for ($i = 0; $i -lt 2; $i++) {
  $ok = [OcuFg]::Focus($hit.Hwnd)
  Start-Sleep -Milliseconds 400
  $info = [OcuFg]::Describe($hit.Hwnd)
  if ($info.Visible -and -not $info.Iconic -and -not $info.Offscreen -and $info.W -ge 120 -and $info.H -ge 80) {
    $ok = $true
    break
  }
  if ($i -eq 0) {
    $again = [OcuFg]::FindBest([uint32]$ProcessId)
    if ($again.Ok) { $hit = $again }
  }
}

$fg = [OcuFg]::GetForegroundWindow()
$same = $fg.ToInt64() -eq $hit.Hwnd.ToInt64()
$usable = [bool]($info.Visible -and -not $info.Iconic -and -not $info.Offscreen -and $info.W -ge 120 -and $info.H -ge 80)
[pscustomobject]@{
  ok = $usable
  focused = [bool]$same
  restored = [bool]$ok
  hwnd = ('0x{0:X}' -f $hit.Hwnd.ToInt64())
  width = $info.W
  height = $info.H
  visible = [bool]$info.Visible
  iconic = [bool]$info.Iconic
  offscreen = [bool]$info.Offscreen
  pid = $ProcessId
} | ConvertTo-Json -Compress
