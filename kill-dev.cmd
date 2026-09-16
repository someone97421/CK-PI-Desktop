@echo off
setlocal EnableExtensions
if /i not "%~1"=="/nopause" title this-is-a-agent Kill
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dev.ps1"
set "EXITCODE=%ERRORLEVEL%"
if /i not "%~1"=="/nopause" pause
exit /b %EXITCODE%
