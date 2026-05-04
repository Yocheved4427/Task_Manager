@echo off
title Stop Task Manager
echo Stopping Task Manager server...
taskkill /F /IM node.exe /FI "WINDOWTITLE eq Task Manager*" >nul 2>&1
taskkill /F /FI "IMAGENAME eq node.exe" /FI "MODULES eq server.js" >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000 "') do (
  taskkill /F /PID %%a >nul 2>&1
)
echo Server stopped.
timeout /t 2 >nul
