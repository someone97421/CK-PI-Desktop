# Read-only, window-scoped UI Automation value probe. Request JSON is read from stdin.
$ErrorActionPreference = 'Stop'
# Node sends UTF-8 JSON; Windows PowerShell otherwise uses the system code page.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ValueReaderNative
{
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint command);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam,
        uint flags, uint timeout, out IntPtr result);

    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    // A bounded, same-process GW_OWNER chain is required, including every intermediary.
    // The path is also an identity snapshot for the post-read ownership check.
    public static string OwnerPath(IntPtr candidate, IntPtr target, uint pid) {
        if (candidate != target && !IsWindowVisible(candidate)) return null;
        var seen = new System.Collections.Generic.HashSet<IntPtr>();
        var path = new System.Collections.Generic.List<string>();
        for (int depth = 0; depth < 32; depth++) {
            uint actual;
            if (candidate == IntPtr.Zero || !seen.Add(candidate) || !IsWindow(candidate) ||
                GetWindowThreadProcessId(candidate, out actual) == 0 || actual != pid) return null;
            path.Add(candidate.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (candidate == target) return String.Join("/", path.ToArray());
            candidate = GetWindow(candidate, 4); // GW_OWNER, never parent/desktop traversal
        }
        return null;
    }

    public static IntPtr[] SearchRoots(IntPtr target, uint pid, int maxRoots,
        System.Diagnostics.Stopwatch timer, int deadline, out int filtered, out bool complete) {
        var roots = new System.Collections.Generic.List<IntPtr>();
        roots.Add(target);
        int rejected = 0, candidates = 0;
        bool finished = true;
        bool enumerated = EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (timer.ElapsedMilliseconds >= deadline || ++candidates > 4096) {
                finished = false; return false;
            }
            if (hwnd == target) return true;
            if (OwnerPath(hwnd, target, pid) == null) { rejected++; return true; }
            if (roots.Count >= maxRoots) { finished = false; return false; }
            roots.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        filtered = rejected;
        complete = finished && enumerated;
        return roots.ToArray();
    }

    public static IntPtr FindRenderWidget(IntPtr root) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(root, delegate (IntPtr hwnd, IntPtr lParam) {
            System.Text.StringBuilder name = new System.Text.StringBuilder(256);
            GetClassName(hwnd, name, name.Capacity);
            if (name.ToString().IndexOf("RenderWidgetHost", System.StringComparison.OrdinalIgnoreCase) >= 0) {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@ | Out-Null

function Normalize-Role([string]$Role) {
  if ($null -eq $Role) { return $null }
  $normalized = $Role.Trim()
  if ($normalized.StartsWith('ControlType.', [System.StringComparison]::OrdinalIgnoreCase)) {
    $normalized = $normalized.Substring('ControlType.'.Length)
  }
  return $normalized.ToLowerInvariant()
}

function Get-WindowProcessId([IntPtr]$Handle) {
  [uint32]$actual = 0
  if (-not [ValueReaderNative]::IsWindow($Handle)) { return [uint32]0 }
  $thread = [ValueReaderNative]::GetWindowThreadProcessId($Handle, [ref]$actual)
  if ($thread -eq 0) { return [uint32]0 }
  return $actual
}

function New-Result($Status, $Code, $Target, $Selector, [bool]$Complete, [int]$MatchCount, $Diagnostics) {
  return [ordered]@{
    status = $Status
    source = $null
    code = $Code
    match_count = $MatchCount
    target = $Target
    selector = $Selector
    complete = $Complete
    diagnostics = $Diagnostics
  }
}

$targetEcho = [ordered]@{ pid = 0; window_id = 0 }
$selectorEcho = [ordered]@{}
$result = New-Result 'error' 'invalid_request' $targetEcho $selectorEcho $false 0 ([ordered]@{ stage = 'validation' })
$rootVerified = $false
$handle = [IntPtr]::Zero
$targetPid = [uint32]0
$timer = $null
$nodesVisited = 0
$maxNodes = 2000
$deadlineMs = 4500
$initializingProviders = $false

try {
  $rawRequest = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($rawRequest) -or $rawRequest.Length -gt 65536) { throw 'invalid request' }
  $request = $rawRequest | ConvertFrom-Json
  if ($null -eq $request -or $null -eq $request.target -or $null -eq $request.selector -or
      $null -eq $request.limits) { throw 'invalid request' }

  [int64]$windowId = $request.target.window_id
  [int64]$pid64 = $request.target.pid
  if ($windowId -le 0 -or $pid64 -le 0 -or $pid64 -gt [uint32]::MaxValue) { throw 'invalid target' }
  $targetPid = [uint32]$pid64
  $handle = [IntPtr]$windowId
  $targetEcho = [ordered]@{ pid = [int64]$targetPid; window_id = $windowId }

  $hasName = $null -ne $request.selector.PSObject.Properties['name']
  $hasAutomationId = $null -ne $request.selector.PSObject.Properties['automation_id']
  $hasRole = $null -ne $request.selector.PSObject.Properties['role']
  $selectorName = if ($hasName) { [string]$request.selector.name } else { $null }
  $selectorAutomationId = if ($hasAutomationId) { [string]$request.selector.automation_id } else { $null }
  $selectorRole = if ($hasRole) { [string]$request.selector.role } else { $null }
  if ((-not $hasName -and -not $hasAutomationId) -or
      ($hasName -and [string]::IsNullOrWhiteSpace($selectorName)) -or
      ($hasAutomationId -and [string]::IsNullOrWhiteSpace($selectorAutomationId)) -or
      ($hasRole -and [string]::IsNullOrWhiteSpace($selectorRole))) { throw 'invalid selector' }
  if ($hasName) { $selectorEcho['name'] = $selectorName }
  if ($hasAutomationId) { $selectorEcho['automation_id'] = $selectorAutomationId }
  if ($hasRole) { $selectorEcho['role'] = $selectorRole }

  $maxChars = [int]$request.limits.max_chars
  $maxNodes = [int]$request.limits.max_nodes
  $deadlineMs = [int]$request.limits.deadline_ms
  if ($maxChars -lt 0 -or $maxChars -gt 100000 -or $maxNodes -lt 1 -or $maxNodes -gt 2000 -or
      $deadlineMs -lt 1 -or $deadlineMs -gt 5000) { throw 'invalid limits' }

  $initialPid = Get-WindowProcessId $handle
  if ($initialPid -ne $targetPid) {
    $result = New-Result 'unavailable' 'target_pid_mismatch' $targetEcho $selectorEcho $false 0 `
      ([ordered]@{ stage = 'target'; nodes_visited = 0; elapsed_ms = 0; limit = $maxNodes; deadline_ms = $deadlineMs })
  } else {
    # Load the standard Win32 control proxies before any UIA provider access.
    # ProxyManager inspects its caller's stack: PowerShell dynamic frames can have
    # no ReflectedType. A non-inlined CLR method supplies the required caller.
    $initializingProviders = $true
    Add-Type -ReferencedAssemblies ([System.Windows.Automation.AutomationElement].Assembly.Location) -TypeDefinition @'
using System.Runtime.CompilerServices;
using System.Windows.Automation;
public static class ValueReaderProviderBootstrap
{
    [MethodImpl(MethodImplOptions.NoInlining)]
    public static void Initialize()
    {
        // An empty registration triggers default proxies without appending them twice.
        ClientSettings.RegisterClientSideProviders(new ClientSideProviderDescription[0]);
    }
}
'@ | Out-Null
    [ValueReaderProviderBootstrap]::Initialize()
    $initializingProviders = $false
    $rootVerified = $true
    # Acquire UIA roots only after WM_GETOBJECT has activated the provider.
      # Chromium/Electron renderers expose their full UIA tree lazily: nudge the
      # renderer widget with WM_GETOBJECT/OBJID_CLIENT before the raw walk, or a
      # selector that matches the driver tree reports no_match here. EnumChildWindows
      # covers every descendant, so a renamed or wrapped render widget still counts.
      $activation = 'no_chromium_renderer'
      try {
        $renderer = [ValueReaderNative]::FindRenderWidget($handle)
        $WM_GETOBJECT = 0x003D
        $OBJID_CLIENT = [IntPtr](-4)
        $SMTO_ABORTIFHUNG = 0x2
        $msgResult = [IntPtr]::Zero
        if ($renderer -ne [IntPtr]::Zero) {
          [void][ValueReaderNative]::SendMessageTimeout($renderer, $WM_GETOBJECT, [IntPtr]::Zero, $OBJID_CLIENT, $SMTO_ABORTIFHUNG, 1000, [ref]$msgResult)
          $msgResult = [IntPtr]::Zero
          [void][ValueReaderNative]::SendMessageTimeout($handle, $WM_GETOBJECT, [IntPtr]::Zero, $OBJID_CLIENT, $SMTO_ABORTIFHUNG, 1000, [ref]$msgResult)
          $activation = 'sent'
        } else {
          [void][ValueReaderNative]::SendMessageTimeout($handle, $WM_GETOBJECT, [IntPtr]::Zero, $OBJID_CLIENT, $SMTO_ABORTIFHUNG, 1000, [ref]$msgResult)
          $activation = 'root_only'
        }
        Start-Sleep -Milliseconds 200
      } catch {
        $activation = 'failed'
      }
      $timer = [System.Diagnostics.Stopwatch]::StartNew()
      $candidatesFiltered = 0
      $complete = $true
      $rootHandles = [ValueReaderNative]::SearchRoots($handle, $targetPid, $maxNodes, $timer,
        $deadlineMs, [ref]$candidatesFiltered, [ref]$complete)
      $queue = New-Object System.Collections.Queue
      $seen = New-Object 'System.Collections.Generic.HashSet[string]'
      $rootPaths = @{}
      $matches = New-Object System.Collections.ArrayList
      $searchFailure = $false
      $rootsScanned = 0
      $wantedRole = Normalize-Role $selectorRole
      $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker

      # Seed every root before walking: an owned root already present in the main
      # provider tree is deduplicated with the same runtime ID and native scope.
      foreach ($rootHandle in $rootHandles) {
        if ($timer.ElapsedMilliseconds -ge $deadlineMs) { $complete = $false; break }
        $ownerPath = [ValueReaderNative]::OwnerPath($rootHandle, $handle, $targetPid)
        if ($null -eq $ownerPath) { $complete = $false; $searchFailure = $true; break }
        $rootPaths[$rootHandle] = $ownerPath
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($rootHandle)
        if ($null -eq $root -or [uint32]$root.Current.ProcessId -ne $targetPid) {
          $complete = $false; $searchFailure = $true; break
        }
        $rootsScanned++
        $runtimeId = $root.GetRuntimeId()
        if ($null -eq $runtimeId -or $runtimeId.Length -eq 0) {
          $complete = $false; $searchFailure = $true; break
        }
        if ($seen.Add(($runtimeId -join ','))) { $queue.Enqueue($root) }
      }

      :search while ($complete -and $queue.Count -gt 0) {
        if ($timer.ElapsedMilliseconds -ge $deadlineMs) { $complete = $false; break search }
        $element = $queue.Dequeue()
        $nodesVisited++
        try {
          $current = $element.Current
          # A provider may expose foreign children; never walk through their subtree.
          if ([uint32]$current.ProcessId -ne $targetPid) { continue }
          if ($current.IsEnabled -and -not $current.IsOffscreen) {
            $matchesSelector = $true
            if ($hasName -and -not [string]::Equals([string]$current.Name, $selectorName,
                [System.StringComparison]::OrdinalIgnoreCase)) { $matchesSelector = $false }
            if ($hasAutomationId -and -not [string]::Equals([string]$current.AutomationId, $selectorAutomationId,
                [System.StringComparison]::Ordinal)) { $matchesSelector = $false }
            if ($hasRole -and (Normalize-Role ([string]$current.ControlType.ProgrammaticName)) -ne $wantedRole) {
              $matchesSelector = $false
            }
            if ($matchesSelector) { [void]$matches.Add($element) }
          }

          # One shared budget and runtime-ID set across all selected roots.
          $child = $walker.GetFirstChild($element)
          while ($null -ne $child) {
            if ($timer.ElapsedMilliseconds -ge $deadlineMs) { $complete = $false; break search }
            if ([uint32]$child.Current.ProcessId -eq $targetPid) {
              $runtimeId = $child.GetRuntimeId()
              if ($null -eq $runtimeId -or $runtimeId.Length -eq 0) { throw 'missing runtime identity' }
              if ($seen.Add(($runtimeId -join ','))) {
                if (($nodesVisited + $queue.Count) -ge $maxNodes) { $complete = $false; break search }
                $queue.Enqueue($child)
              }
            }
            $child = $walker.GetNextSibling($child)
          }
        } catch {
          $complete = $false
          $searchFailure = $true
          break search
        }
      }
      if ($timer.ElapsedMilliseconds -ge $deadlineMs) { $complete = $false }

      $matchCount = $matches.Count
      $diagnostics = [ordered]@{
        stage = 'search'; nodes_visited = $nodesVisited; elapsed_ms = [int]$timer.ElapsedMilliseconds
        limit = $maxNodes; deadline_ms = $deadlineMs; uia_activation = $activation
        roots_scanned = $rootsScanned; owned_roots = $rootHandles.Count - 1; candidates_filtered = $candidatesFiltered
      }
      if (-not $complete) {
        $code = if ($searchFailure) { 'search_unavailable' } else { 'partial_search' }
        $result = New-Result 'unavailable' $code $targetEcho $selectorEcho $false $matchCount $diagnostics
      } elseif ($matchCount -eq 0) {
        $result = New-Result 'unavailable' 'no_match' $targetEcho $selectorEcho $true 0 $diagnostics
      } elseif ($matchCount -gt 1) {
        $result = New-Result 'unavailable' 'ambiguous_match' $targetEcho $selectorEcho $true $matchCount $diagnostics
      } else {
        $hit = $matches[0]
        $isPassword = $true
        try { $isPassword = [bool]$hit.Current.IsPassword } catch { $isPassword = $true }
        $diagnostics['is_password'] = $isPassword
        if ($isPassword) {
          $result = New-Result 'unavailable' 'password_blocked' $targetEcho $selectorEcho $true 1 $diagnostics
        } else {
          $readValue = $null
          $readSource = $null
          $valueTooLong = $false
          $patternObject = $null
          try {
            if ($hit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObject)) {
              $candidate = ([System.Windows.Automation.ValuePattern]$patternObject).Current.Value
              if ($null -ne $candidate) {
                if ($candidate.Length -gt $maxChars) {
                  $valueTooLong = $true
                } else {
                  $readValue = [string]$candidate
                  $readSource = 'uia_value_pattern'
                }
              }
            }
          } catch {
            $patternObject = $null
          }
          if ($null -eq $readSource -and -not $valueTooLong) {
            try {
              $patternObject = $null
              if ($hit.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$patternObject)) {
                $document = ([System.Windows.Automation.TextPattern]$patternObject).DocumentRange
                if ($null -ne $document) {
                  $candidate = $document.GetText($maxChars + 1)
                  if ($null -ne $candidate) {
                    if ($candidate.Length -gt $maxChars) {
                      $valueTooLong = $true
                    } else {
                      $readValue = [string]$candidate
                      $readSource = 'uia_text_pattern'
                    }
                  }
                }
              }
            } catch {
              $patternObject = $null
            }
          }
          if ($null -ne $readSource) {
            $diagnostics['provider'] = $readSource
            $result = New-Result 'read' 'value_read' $targetEcho $selectorEcho $true 1 $diagnostics
            $result['source'] = $readSource
            $result['value'] = $readValue
          } elseif ($valueTooLong) {
            $result = New-Result 'unavailable' 'value_too_long' $targetEcho $selectorEcho $true 1 $diagnostics
          } else {
            $result = New-Result 'unavailable' 'pattern_unavailable' $targetEcho $selectorEcho $true 1 $diagnostics
          }
        }
      }
      # Recheck every selected root, including owned windows deduplicated against
      # the main tree. Any PID/owner/visibility change invalidates the merged read.
      foreach ($rootHandle in $rootPaths.Keys) {
        if ([ValueReaderNative]::OwnerPath($rootHandle, $handle, $targetPid) -cne $rootPaths[$rootHandle]) {
          $result = New-Result 'unavailable' 'root_scope_changed' $targetEcho $selectorEcho $false 0 $diagnostics
          break
        }
      }
      if ($result.status -eq 'read' -and ([uint32]$hit.Current.ProcessId -ne $targetPid -or $hit.Current.IsPassword)) {
        $result = New-Result 'unavailable' 'root_scope_changed' $targetEcho $selectorEcho $false 0 $diagnostics
      }
  }

  # Revalidate the native HWND/PID identity after every completed search/read decision.
  if ($rootVerified) {
    $finalPid = Get-WindowProcessId $handle
    if ($finalPid -ne $targetPid) {
      $result = New-Result 'unavailable' 'target_pid_changed' $targetEcho $selectorEcho $false 0 `
        ([ordered]@{ stage = 'target'; nodes_visited = $nodesVisited; elapsed_ms = $(if ($timer) { [int]$timer.ElapsedMilliseconds } else { 0 }); limit = $maxNodes; deadline_ms = $deadlineMs })
    }
  }
} catch {
  $failureCode = if ($initializingProviders) { 'provider_initialization_failed' } else { 'helper_exception' }
  $failureStage = if ($initializingProviders) { 'provider_initialization' } else { 'helper' }
  $result = New-Result 'error' $failureCode $targetEcho $selectorEcho $false 0 `
    ([ordered]@{ stage = $failureStage; nodes_visited = $nodesVisited; limit = $maxNodes; deadline_ms = $deadlineMs })
}

$result | ConvertTo-Json -Compress -Depth 6
