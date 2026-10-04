/** 退出后执行；只接收由主进程写入的 JSON，不拼接用户路径为脚本。 */
export const WINDOWS_ICON_HELPER = String.raw`
param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Json($Path, $Value) {
  $temporary = $Path + '.tmp'
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 30), $utf8)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}
function Normalize-Path([string]$Path) {
  if (!$Path) { return '' }
  return [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path)).TrimEnd('\').ToLowerInvariant()
}
function Matches-App([string]$Path) {
  try { return $request.matchPaths -contains (Normalize-Path $Path) } catch { return $false }
}
function Get-FileDigest([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}
$changed = @()
$warnings = New-Object 'System.Collections.Generic.List[string]'
$parentExited = $false
$metadata = @()
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AppearanceShell {
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)]
  public static extern void SHChangeNotify(uint eventId, uint flags, string item1, IntPtr item2);
}
'@
  [IO.File]::WriteAllText($request.readyPath, 'ready', $utf8)
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while (Get-Process -Id $request.processId -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -gt $deadline) { throw '等待应用退出超时，图标文件未替换。' }
    Start-Sleep -Milliseconds 250
  }
  $parentExited = $true
  foreach ($path in @($request.activeIconPath, $request.statePath)) {
    $backup = Join-Path $request.jobDirectory ('metadata-' + $metadata.Count)
    $existed = Test-Path -LiteralPath $path
    if ($existed) { Copy-Item -LiteralPath $path -Destination $backup }
    $metadata += @{ path = $path; backup = $backup; existed = $existed }
  }
  foreach ($target in $request.targets) {
    if ((Get-FileDigest $target.path) -ne $target.beforeHash) {
      throw '程序文件在图标准备后发生变化，请重新应用图标。'
    }
    $temporary = $target.path + '.icon-' + $request.id + '.tmp'
    $backup = $target.path + '.icon-' + $request.id + '.bak'
    Copy-Item -LiteralPath $target.preparedPath -Destination $temporary -Force
    $replacementDeadline = [DateTime]::UtcNow.AddSeconds(45)
    try {
      while ($true) {
        try {
          [IO.File]::Replace($temporary, $target.path, $backup)
          break
        } catch {
          if ([DateTime]::UtcNow -gt $replacementDeadline) { throw }
          Start-Sleep -Milliseconds 250
        }
      }
      $changed += @{ path = $target.path; backup = $backup }
    } finally {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
  }
  # 图标文件使用固定路径，让系统入口与下次启动保持一致。
  Copy-Item -LiteralPath $request.icoPath -Destination $request.activeIconPath -Force
  $shell = New-Object -ComObject WScript.Shell
  $roots = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('CommonDesktopDirectory'),
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonStartMenu'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
  foreach ($root in $roots) {
    foreach ($file in (Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue)) {
      try {
        $shortcut = $shell.CreateShortcut($file.FullName)
        if (Matches-App $shortcut.TargetPath) {
          # COM 属性接收路径与索引，额外的引号会被当作路径内容。
          $shortcut.IconLocation = $request.activeIconPath + ',0'
          $shortcut.Save()
          [AppearanceShell]::SHChangeNotify(0x2000, 0x5, $file.FullName, [IntPtr]::Zero)
        }
      } catch { $warnings.Add('快捷方式更新失败：' + $file.FullName + '；' + $_.Exception.Message) }
    }
  }
  # 卸载入口及本应用资源管理器菜单使用相同图标。
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      try {
        $value = (Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue).DisplayIcon
        if ($value -and (Matches-App (($value -replace ',\s*-?\d+$', '').Trim('"')))) {
          Set-ItemProperty -LiteralPath $key.PSPath -Name DisplayIcon -Value ('"' + $request.activeIconPath + '",0')
        }
      } catch { $warnings.Add('卸载图标更新失败：' + $_.Exception.Message) }
    }
  }
  foreach ($key in @('HKCU:\Software\Classes\Directory\shell\this-is-a-agent-temporary-workspace', 'HKCU:\Software\Classes\Directory\Background\shell\this-is-a-agent-temporary-workspace')) {
    if (Test-Path -LiteralPath $key) {
      try { Set-ItemProperty -LiteralPath $key -Name Icon -Value ('"' + $request.activeIconPath + '",0') }
      catch { $warnings.Add('目录菜单图标更新失败：' + $_.Exception.Message) }
    }
  }
  foreach ($target in $request.targets) {
    [AppearanceShell]::SHChangeNotify(0x2000, 0x5, $target.path, [IntPtr]::Zero)
  }
  [AppearanceShell]::SHChangeNotify(0x8000000, 0, $null, [IntPtr]::Zero)
  foreach ($target in $request.targets) {
    $item = Get-Item -LiteralPath $target.path
    $target.record.size = $item.Length
    $target.record.mtimeMs = ([DateTimeOffset]$item.LastWriteTimeUtc).ToUnixTimeMilliseconds()
  }
  $records = @($request.retainedTargets) + @($request.targets | ForEach-Object { $_.record })
  Write-Json $request.statePath @{ version = 1; choice = $request.choice; targets = $records }
  Write-Json $request.resultPath @{ ok = $true; warnings = $warnings.ToArray(); restart = $request.restart }
  foreach ($item in $changed) { Remove-Item -LiteralPath $item.backup -Force -ErrorAction SilentlyContinue }
} catch {
  $failure = $_.Exception.Message
  foreach ($item in $changed) {
    try {
      if (Test-Path -LiteralPath $item.backup) { [IO.File]::Replace($item.backup, $item.path, $null) }
    } catch { $failure += '；恢复程序文件失败：' + $_.Exception.Message + '；备份：' + $item.backup }
  }
  foreach ($item in $metadata) {
    try {
      if ($item.existed) { Copy-Item -LiteralPath $item.backup -Destination $item.path -Force }
      else { Remove-Item -LiteralPath $item.path -Force -ErrorAction SilentlyContinue }
    } catch { $failure += '；恢复图标设置失败：' + $_.Exception.Message }
  }
  Write-Json $request.resultPath @{ ok = $false; error = $failure; warnings = $warnings.ToArray() }
} finally {
  if ($request.restart -and $parentExited) {
    # 便携外层负责重新解包；不把旧的临时运行目录作为重启入口。
    Remove-Item Env:PORTABLE_EXECUTABLE_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:PORTABLE_EXECUTABLE_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:PORTABLE_EXECUTABLE_APP_FILENAME -ErrorAction SilentlyContinue
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    try { Start-Process -FilePath $request.launchPath -WorkingDirectory ([IO.Path]::GetDirectoryName($request.launchPath)) }
    catch { Write-Json $request.resultPath @{ ok = $false; error = ('图标处理完成，但重新启动失败：' + $_.Exception.Message) } }
  }
  Remove-Item -LiteralPath $request.jobDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
`;
