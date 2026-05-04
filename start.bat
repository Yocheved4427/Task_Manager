@echo off
title Task Manager
echo.
echo  ========================================
echo   Task Manager - Starting...
echo  ========================================
echo.

:: Locate node.exe (checks PATH first, then default install dir)
set "NODE_EXE=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
    set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"
  ) else (
    echo  ERROR: Node.js is not installed.
    echo  Download it from https://nodejs.org/
    pause
    exit /b 1
  )
) else (
  set "NPM_CMD=npm"
)

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
  echo  Installing dependencies...
  "%NPM_CMD%" install
  echo.
)

echo  Server starting on http://localhost:3000
echo  Press Ctrl+C to stop.
echo.

:: Open browser after a short delay
start "" /b cmd /c "timeout /t 2 >nul && start http://localhost:3000"

:: Start the server
"%NODE_EXE%" server.js

pause
