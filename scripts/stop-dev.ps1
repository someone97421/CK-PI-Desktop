$ErrorActionPreference = 'Stop'
# Windows PowerShell 按 BOM 识别脚本编码；此文件须保存为 UTF-8 BOM。
# 控制台和原生命令的输入输出统一使用 UTF-8。
$consoleEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $consoleEncoding
[Console]::OutputEncoding = $consoleEncoding
$OutputEncoding = $consoleEncoding
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$workspacePrefix = $workspaceRoot + [IO.Path]::DirectorySeparatorChar
$processes = @(Get-CimInstance Win32_Process)
$targets = @($processes | Where-Object {
    $executable = $_.ExecutablePath
    $command = $_.CommandLine
    $localExecutable = $executable -and $executable.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)
    $localCommand = $command -and $command.IndexOf($workspaceRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    ($localExecutable -and $_.Name -in @('pi-desktop-host-core.exe', 'electron.exe', 'this-is-a-agent.exe')) -or
    ($_.Name -eq 'node.exe' -and $localCommand -and $command -match 'electron-vite|scripts[\\/](dev-electron|build)\.mjs')
})
if (!$targets.Count) { Write-Output '当前项目没有残留的开发进程。'; exit 0 }
foreach ($target in $targets) {
    # 仅结束此工作区的已识别进程及其子进程；不按端口或全局程序名清理。
    $live = Get-CimInstance Win32_Process -Filter "ProcessId = $($target.ProcessId)"
    if (!$live -or $live.CreationDate -ne $target.CreationDate) { continue }
    Write-Output "结束 $($target.Name)，PID $($target.ProcessId)"
    & taskkill.exe /F /T /PID $target.ProcessId 2>$null | Out-Host
}
