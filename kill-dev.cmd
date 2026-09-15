@echo off
setlocal EnableExtensions

if /i not "%~1"=="/nopause" title PI-Desktop Kill

echo ============================================
echo  PI-Desktop force kill
echo ============================================
echo.

echo [1/4] Freeing dev ports 5173-5180 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 5173 -and $_.LocalPort -le 5180 } | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Write-Host ('  port owner PID ' + $_); taskkill /F /T /PID $_ }" 2>nul

echo [2/4] Killing host-core / packaged app ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*host-core*' -or $_.Name -eq 'PI-Desktop.exe' } | ForEach-Object { Write-Host ('  ' + $_.Name + ' PID ' + $_.ProcessId); taskkill /F /T /PID $_.ProcessId }" 2>nul

echo [3/4] Killing electron-vite dev servers ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*electron-vite*' } | ForEach-Object { Write-Host ('  ' + $_.Name + ' PID ' + $_.ProcessId); taskkill /F /T /PID $_.ProcessId }" 2>nul

echo [4/4] Killing Electron dev windows ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*PI-Desktop*' } | ForEach-Object { Write-Host ('  electron PID ' + $_.Id); taskkill /F /T /PID $_.Id }" 2>nul

echo.
echo Leftover check:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$left = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*host-core*' -or $_.Name -eq 'PI-Desktop.exe' -or ($_.Name -eq 'electron.exe' -and $_.CommandLine -like '*electron-vite*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*electron-vite*') }; if ($left) { $left | ForEach-Object { Write-Host ('  STILL RUNNING: ' + $_.Name + ' PID ' + $_.ProcessId) } } else { Write-Host '  clean.' }"

echo.
if /i not "%~1"=="/nopause" (
  echo Done. You can close this window.
  pause
)
exit /b 0
