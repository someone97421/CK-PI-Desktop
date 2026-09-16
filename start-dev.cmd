@echo off
setlocal EnableExtensions
title this-is-a-agent DEV

cd /d "%~dp0"

echo ============================================
echo  this-is-a-agent dev launcher
echo ============================================
echo.

echo [1/4] Killing stale dev processes ...
call "%~dp0kill-dev.cmd" /nopause
echo.

echo [2/4] Checking prerequisites ...

where pnpm >nul 2>&1
if errorlevel 1 (
  echo   ERROR: pnpm not found in PATH.
  echo   Install it first: npm i -g pnpm
  echo.
  pause
  exit /b 1
)

where cargo >nul 2>&1
if errorlevel 1 (
  echo   ERROR: cargo not found in PATH.
  echo   Install Rust toolchain first: https://rustup.rs
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo   ERROR: node_modules is missing.
  echo   Run this once first:  pnpm install
  echo.
  pause
  exit /b 1
)

echo   pnpm / cargo / node_modules OK.

echo [3/4] Building host-core and starting dev server ...
echo.
echo   Logs appear below. Keep this window open while using the app.
echo   If this window is force-closed, run kill-dev.cmd to clean up.
echo.

echo [4/4] pnpm dev
echo.

call pnpm dev
set "EXITCODE=%ERRORLEVEL%"

echo.
echo pnpm dev exited with code %EXITCODE%.
echo Cleaning up leftover processes ...
call "%~dp0kill-dev.cmd" /nopause

echo.
echo Finished.
pause
exit /b %EXITCODE%
