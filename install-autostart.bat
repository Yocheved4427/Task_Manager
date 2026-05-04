@echo off
title Task Manager - Install Auto-Start
echo.
echo  ========================================
echo   Task Manager - Installing Auto-Start
echo  ========================================
echo.

:: Get the directory of this script
set "SCRIPT_DIR=%~dp0"
set "VBS_PATH=%SCRIPT_DIR%start-background.vbs"

:: Register with Task Scheduler to run on login (current user)
schtasks /create /tn "TaskManagerServer" ^
  /tr "wscript.exe \"%VBS_PATH%\"" ^
  /sc onlogon ^
  /rl highest ^
  /f >nul 2>&1

if errorlevel 1 (
  echo  ERROR: Could not register the task.
  echo  Try running this file as Administrator.
  pause
  exit /b 1
)

echo  SUCCESS: Task Manager server will now start automatically
echo  every time you log in to Windows.
echo.
echo  To remove auto-start, run: uninstall-autostart.bat
echo.
echo  Starting the server now...
wscript.exe "%VBS_PATH%"
echo.
pause
