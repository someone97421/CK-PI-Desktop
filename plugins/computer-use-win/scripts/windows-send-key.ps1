# One-shot transport: at most one safe activation, never refocus a Document/caret or replay a key.
param(
  [Parameter(Mandatory = $true)][int64]$Hwnd,
  [Parameter(Mandatory = $true)][uint32]$TargetPid,
  [Parameter(Mandatory = $true)][string]$Key,
  [switch]$Shift,
  [switch]$Control,
  [switch]$Alt,
  [switch]$Office
)
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$result = [ordered]@{
  ok = $false; code = 'helper_error'; sent = 0; expected = 0
  foreground_hwnd = 0; focus_hwnd = 0; target_hwnd = $Hwnd; target_pid = $TargetPid; last_error = 0
  foreground_pid = 0; foreground_class = ''
  activation_attempted = $false; activation_returned = $false; activation_wait_ms = 0
}
try {
  $vkMap = @{
    escape = 0x1B; return = 0x0D; tab = 0x09
    down = 0x28; up = 0x26; left = 0x25; right = 0x27
    delete = 0x2E; insert = 0x2D; backspace = 0x08
    end = 0x23; home = 0x24; pageup = 0x21; pagedown = 0x22
    space = 0x20; menu = 0x5D; f10 = 0x79; v = 0x56
    n = 0x4E; o = 0x4F; s = 0x53; g = 0x47; f = 0x46; a = 0x41
    z = 0x5A; y = 0x59; b = 0x42; i = 0x49; u = 0x55; m = 0x4D; d = 0x44; l = 0x4C
    w = 0x57; f4 = 0x73
    '1' = 0x31; '2' = 0x32; '3' = 0x33
    f2 = 0x71; f5 = 0x74; f9 = 0x78; f12 = 0x7B
  }
  $name = $Key.Trim().ToLowerInvariant()
  # Office mappings are opt-in; the existing menu/navigation/paste contract stays narrow.
  $allowed = if ($Office) {
    if ($Control -and -not $Shift -and -not $Alt) {
      $name -in @('n', 'o', 's', 'g', 'f', 'a', 'z', 'y', 'b', 'i', 'u', 'home', 'end', 'return', 'm', 'd', 'w', '1')
    } elseif ($Control -and $Shift -and -not $Alt) { $name -in @('n', 'l', 's', 'home', 'end', 'left', 'right', 'up', 'down')
    } elseif ($Control -and $Alt -and -not $Shift) { $name -in @('1', '2', '3')
    } elseif ($Shift -and -not $Control -and -not $Alt) { $name -in @('f5', 'home', 'end', 'left', 'right', 'up', 'down', 'pageup', 'pagedown', 'tab')
    } elseif ($Alt -and -not $Control -and -not $Shift) { $name -eq 'f4'
    } else { -not $Control -and -not $Shift -and -not $Alt -and $name -in @('f2', 'f5', 'f9', 'f12', 'delete', 'backspace', 'space') }
  } else {
    -not $Alt -and $(if ($Control) { -not $Shift -and $name -eq 'v'
      } elseif ($Shift) { $name -in @('f10', 'tab')
      } else { $name -in @('escape', 'return', 'tab', 'down', 'up', 'left', 'right', 'delete', 'insert', 'backspace', 'end', 'home', 'pageup', 'pagedown', 'space', 'menu', 'f10') })
  }
  if (-not $vkMap.ContainsKey($name) -or -not $allowed) {
    $result.code = 'unsupported_key_chord'
  } else {
    Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class WinSendKey {
  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT {
    public ushort wVk, wScan;
    public uint dwFlags, time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MOUSEINPUT {
    public int dx, dy;
    public uint mouseData, dwFlags, time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL, wParamH;
  }
  [StructLayout(LayoutKind.Explicit)]
  struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Sequential)]
  struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct GUITHREADINFO {
    public uint cbSize, flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  public class Result {
    public bool ok;
    public string code = "helper_error";
    public uint sent, expected;
    public long foreground_hwnd, focus_hwnd, target_hwnd;
    public uint target_pid;
    public uint foreground_pid;
    public string foreground_class = "";
    public int last_error;
    public bool activation_attempted, activation_returned;
    public long activation_wait_ms;
  }
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")]
  static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")]
  static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder className, int maxCount);
  [DllImport("user32.dll")]
  static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")]
  static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError = true)]
  static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll")]
  static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")]
  static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll")]
  static extern short GetAsyncKeyState(int key);
  [DllImport("kernel32.dll")]
  static extern void SetLastError(uint error);

  static bool Extended(ushort vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5D;
  }
  static INPUT Key(ushort vk, bool up) {
    INPUT input = new INPUT();
    input.type = 1;
    input.U.ki.wVk = vk;
    input.U.ki.wScan = (ushort)MapVirtualKey(vk, 0);
    input.U.ki.dwFlags = (Extended(vk) ? 1u : 0u) | (up ? 2u : 0u);
    return input;
  }
  static bool BelongsTo(IntPtr hwnd, IntPtr root, uint expectedPid) {
    // GA_ROOT retains popup ownership; follow GW_OWNER explicitly, with a bound.
    for (int i = 0; hwnd != IntPtr.Zero && i < 32; i++) {
      uint pid;
      if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out pid) == 0 || pid != expectedPid) return false;
      hwnd = GetAncestor(hwnd, 2);
      if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out pid) == 0 || pid != expectedPid) return false;
      if (hwnd == root) return true;
      hwnd = GetWindow(hwnd, 4);
    }
    return false;
  }
  static bool Held(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }
  static void ReadForeground(Result result) {
    IntPtr foreground = GetForegroundWindow();
    result.foreground_hwnd = foreground.ToInt64();
    result.foreground_pid = 0;
    result.foreground_class = "";
    if (foreground == IntPtr.Zero) return;
    uint pid;
    if (GetWindowThreadProcessId(foreground, out pid) != 0) result.foreground_pid = pid;
    // Window class only: never read a title or document text. Include the NUL slot.
    var className = new System.Text.StringBuilder(129);
    if (GetClassName(foreground, className, className.Capacity) > 0)
      result.foreground_class = className.ToString();
  }
  static bool EnsureForeground(IntPtr hwnd, uint pid, Result result) {
    ReadForeground(result);
    uint actualPid;
    if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out actualPid) == 0 || actualPid != pid || pid == 0) {
      result.code = "target_pid_mismatch"; return false;
    }
    IntPtr root = GetAncestor(hwnd, 2);
    if (root == IntPtr.Zero || !IsWindow(root) || GetWindowThreadProcessId(root, out actualPid) == 0 || actualPid != pid) {
      result.code = "target_pid_mismatch"; return false;
    }
    // Preserve a target-owned popup: activating its root can dismiss the menu.
    if (BelongsTo(new IntPtr(result.foreground_hwnd), root, pid)) return true;
    // Bounded best effort only. No Alt hack, thread attachment, or caret/focus APIs.
    bool restored = IsIconic(root);
    if (restored) ShowWindow(root, 9); // SW_RESTORE, only if minimized.
    result.activation_attempted = true;
    result.activation_returned = SetForegroundWindow(root);
    var activationTimer = System.Diagnostics.Stopwatch.StartNew();
    if (restored) {
      // Keys raced into a still-restoring Chromium window are silently dropped;
      // give the restore/repaint a short bounded settle, then re-verify below.
      System.Threading.Thread.Sleep(300);
      result.activation_wait_ms = activationTimer.ElapsedMilliseconds;
      ReadForeground(result);
      if (IsIconic(root)) { result.code = "restore_incomplete"; return false; }
    }
    // The API return is diagnostic only; actual same-process ownership decides delivery.
    // Restore's existing settle consumes this budget, so it adds no second wait.
    while (true) {
      ReadForeground(result);
      bool belongs = BelongsTo(new IntPtr(result.foreground_hwnd), root, pid);
      result.activation_wait_ms = activationTimer.ElapsedMilliseconds;
      if (belongs) return true;
      long remaining = 300 - result.activation_wait_ms;
      if (remaining <= 0) { result.code = "foreground_mismatch"; return false; }
      System.Threading.Thread.Sleep((int)Math.Min(20, remaining));
    }
  }
  static bool CheckTarget(IntPtr hwnd, uint pid, Result result) {
    ReadForeground(result);
    result.focus_hwnd = 0;
    uint actualPid;
    if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out actualPid) == 0 || actualPid != pid || pid == 0) {
      result.code = "target_pid_mismatch"; return false;
    }
    IntPtr root = GetAncestor(hwnd, 2);
    IntPtr foreground = new IntPtr(result.foreground_hwnd);
    // Do not activate the owner: that could dismiss its active popup or move selection.
    if (root == IntPtr.Zero || !BelongsTo(foreground, root, pid)) {
      result.code = "foreground_mismatch"; return false;
    }
    uint foregroundPid;
    uint thread = GetWindowThreadProcessId(foreground, out foregroundPid);
    GUITHREADINFO info = new GUITHREADINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
    if (thread == 0 || !GetGUIThreadInfo(thread, ref info)) {
      result.last_error = Marshal.GetLastWin32Error();
      result.code = "focus_query_failed"; return false;
    }
    result.focus_hwnd = info.hwndFocus.ToInt64();
    if (!BelongsTo(info.hwndFocus, root, pid)) {
      result.code = "focus_mismatch"; return false;
    }
    return true;
  }
  public static Result Send(long hwndValue, uint pid, ushort vk, bool shift, bool control) {
    return Send(hwndValue, pid, vk, shift, control, false);
  }
  public static Result Send(long hwndValue, uint pid, ushort vk, bool shift, bool control, bool alt) {
    Result result = new Result();
    result.target_hwnd = hwndValue; result.target_pid = pid;
    ushort[] downs = control ? new ushort[] { 0x11, vk } : shift ? new ushort[] { 0x10, vk } : new ushort[] { vk };
    if (alt || (control && shift)) {
      List<ushort> chord = new List<ushort>();
      if (control) chord.Add(0x11);
      if (shift) chord.Add(0x10);
      if (alt) chord.Add(0x12);
      chord.Add(vk);
      downs = chord.ToArray();
    }
    INPUT[] inputs = new INPUT[downs.Length * 2];
    for (int i = 0; i < downs.Length; i++) inputs[i] = Key(downs[i], false);
    for (int i = 0; i < downs.Length; i++) inputs[downs.Length + i] = Key(downs[downs.Length - 1 - i], true);
    result.expected = (uint)inputs.Length;
    IntPtr hwnd = new IntPtr(hwndValue);
    if (!EnsureForeground(hwnd, pid, result)) return result;
    // No settle/focus delay. Recheck held modifiers and HWND/focus immediately before injection.
    int[] modifiers = { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
    foreach (int modifier in modifiers) {
      if (Held(modifier)) { result.code = "modifier_held"; return result; }
    }
    if (Held(vk)) { result.code = "key_held"; return result; }
    if (!CheckTarget(hwnd, pid, result)) return result;
    SetLastError(0);
    result.sent = SendInput(result.expected, inputs, Marshal.SizeOf(typeof(INPUT)));
    result.last_error = Marshal.GetLastWin32Error();
    if (result.sent == result.expected) {
      result.ok = true; result.code = "transport_sent"; return result;
    }
    result.code = result.sent == 0 ? "send_input_failed" : "send_input_partial";
    // Only release keys still down in the definitely inserted prefix. Never replay downs.
    List<ushort> pending = new List<ushort>();
    for (int i = 0; i < result.sent && i < inputs.Length; i++) {
      ushort key = inputs[i].U.ki.wVk;
      if ((inputs[i].U.ki.dwFlags & 2) == 0) pending.Add(key);
      else pending.Remove(key);
    }
    if (pending.Count > 0) {
      INPUT[] cleanup = new INPUT[pending.Count];
      for (int i = 0; i < pending.Count; i++) cleanup[i] = Key(pending[pending.Count - 1 - i], true);
      if (SendInput((uint)cleanup.Length, cleanup, Marshal.SizeOf(typeof(INPUT))) != cleanup.Length)
        result.code = "send_input_partial_cleanup_failed";
    }
    return result;
  }
}
"@
    if ($Office) {
      $result = [WinSendKey]::Send($Hwnd, $TargetPid, [uint16]$vkMap[$name], $Shift.IsPresent, $Control.IsPresent, $Alt.IsPresent)
    } else {
      $result = [WinSendKey]::Send($Hwnd, $TargetPid, [uint16]$vkMap[$name], $Shift.IsPresent, $Control.IsPresent)
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message.Substring(0, [Math]::Min(800, $_.Exception.Message.Length)))
}
$result | ConvertTo-Json -Compress
if (-not $result.ok) { exit 1 }
