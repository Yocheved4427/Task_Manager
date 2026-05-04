@echo off
title Task Manager - Remove Auto-Start
echo.
echo  ========================================
echo   Task Manager - Removing Auto-Start
echo  ========================================
echo.

schtasks /delete /tn "TaskManagerServer" /f >nul 2>&1

if errorlevel 1 (
  echo  Task was not found or already removed.
) else (
  echo  SUCCESS: Auto-start has been removed.
)
echo.
pause
