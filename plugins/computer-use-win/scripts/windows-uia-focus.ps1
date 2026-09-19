# UIA SetFocus on the largest Document/Edit under HWND, caret to end via TextPattern.
# Does not click (click would move the caret to the click point).
# Does not SendInput Ctrl+End (that would hit the OS foreground, often PI-Desktop).
# powershell.exe 5.1 cannot resolve TextPatternRangeEndpoint / TextUnit even after Add-Type
# UIAutomationTypes — use integer endpoints (Start=0, End=1) or the catch swallows and caret stays at 0.
param(
  [Parameter(Mandatory = $true)][int64]$Hwnd
)
$ErrorActionPreference = "Stop"

if ($Hwnd -eq 0) {
  Write-Output '{"ok":false,"error":"no-hwnd"}'
  exit 1
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$EP_Start = 0
$EP_End = 1

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
if (-not $root) {
  Write-Output '{"ok":false,"error":"no-element"}'
  exit 1
}

$scope = [System.Windows.Automation.TreeScope]::Descendants

function Get-BestControl([System.Windows.Automation.ControlType]$controlType, [bool]$requireFocusable) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    $controlType
  )
  $found = $root.FindAll($scope, $cond)
  $best = $null
  $bestArea = -1
  foreach ($el in $found) {
    try {
      if ($requireFocusable -and -not $el.Current.IsKeyboardFocusable) { continue }
      $rect = $el.Current.BoundingRectangle
      if ($rect.Width -lt 8 -or $rect.Height -lt 8) { continue }
      $area = [int]($rect.Width * $rect.Height)
      if ($area -gt $bestArea) {
        $bestArea = $area
        $best = $el
      }
    } catch {
      continue
    }
  }
  return $best
}

$hit = Get-BestControl ([System.Windows.Automation.ControlType]::Document) $true
if (-not $hit) { $hit = Get-BestControl ([System.Windows.Automation.ControlType]::Edit) $true }
if (-not $hit) { $hit = Get-BestControl ([System.Windows.Automation.ControlType]::Document) $false }
if (-not $hit) { $hit = Get-BestControl ([System.Windows.Automation.ControlType]::Edit) $false }
if (-not $hit) {
  Write-Output '{"ok":false,"error":"no-edit"}'
  exit 1
}

$hit.SetFocus()

$caret = "focus"
try {
  $textPattern = $hit.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  if ($textPattern) {
    $doc = $textPattern.DocumentRange
    $end = $doc.Clone()
    $end.MoveEndpointByRange($EP_Start, $doc, $EP_End)
    $end.Select()
    $sels = $textPattern.GetSelection()
    if ($sels -and $sels.Length -gt 0) {
      $sel = $sels[0]
      if ($sel.CompareEndpoints($EP_End, $doc, $EP_End) -eq 0) {
        $caret = "end"
      }
    }
  }
} catch {
  $caret = "focus"
}

[pscustomobject]@{
  ok = $true
  role = $hit.Current.ControlType.ProgrammaticName
  name = [string]$hit.Current.Name
  caret = $caret
} | ConvertTo-Json -Compress
