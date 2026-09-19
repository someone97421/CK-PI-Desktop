# Read-only keyboard focus probe for one window (GetGUIThreadInfo on its thread).
# Never moves focus, never sends input. Used when a target has no UIA ValuePattern
# read-back (games, custom-drawn canvases) so an unverified type_text can still
# report where keyboard focus actually sits.
# Output: JSON { ok, target_hwnd, foreground_hwnd, focus_hwnd, caret_hwnd,
#   target_foreground, target_thread_focus, caret_visible }
param(
  [Parameter(Mandatory = $true)][int64]$Hwnd,
  [Parameter(Mandatory = $false)][int64]$TargetPid = 0
)
$ErrorActionPreference = "Stop"

if ($Hwnd -eq 0) {
  Write-Output '{"ok":false,"error":"no-hwnd"}'
  exit 1
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FocusProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left; public int top; public int right; public int bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO {
    public int cbSize;
    public int flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public RECT rcCaret;
  }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr hWndParent, IntPtr hWnd);
}
"@

$target = [IntPtr]$Hwnd
$procId = [uint32]0
$threadId = [FocusProbe]::GetWindowThreadProcessId($target, [ref]$procId)
if ($threadId -eq 0) {
  Write-Output '{"ok":false,"error":"no-thread"}'
  exit 1
}
if ($TargetPid -ne 0 -and $procId -ne [uint32]$TargetPid) {
  Write-Output ('{"ok":false,"error":"pid-mismatch","actual_pid":' + $procId + '}')
  exit 1
}

$info = New-Object FocusProbe+GUITHREADINFO
$info.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type][FocusProbe+GUITHREADINFO])
if (-not [FocusProbe]::GetGUIThreadInfo($threadId, [ref]$info)) {
  Write-Output '{"ok":false,"error":"gui-thread-info-failed"}'
  exit 1
}

$foreground = [FocusProbe]::GetForegroundWindow()
$focus = $info.hwndFocus
$belongs = ($focus -eq $target) -or ($focus -ne [IntPtr]::Zero -and [FocusProbe]::IsChild($target, $focus))
# GUI_CARETBLINKING = 0x1
$caretVisible = ($info.flags -band 1) -ne 0 -and $info.hwndCaret -ne [IntPtr]::Zero

[pscustomobject]@{
  ok = $true
  target_hwnd = $Hwnd
  foreground_hwnd = $foreground.ToInt64()
  focus_hwnd = $focus.ToInt64()
  caret_hwnd = $info.hwndCaret.ToInt64()
  target_foreground = ($foreground -eq $target)
  target_thread_focus = [bool]$belongs
  caret_visible = [bool]$caretVisible
} | ConvertTo-Json -Compress
