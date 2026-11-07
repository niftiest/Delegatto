@echo off
REM ── Delegatto launcher ─────────────────────────────────────────────
REM Double-click this file (or run it from a terminal) to start the app.
REM It builds the main/preload/renderer and opens the Electron window.
REM
REM First run after a fresh clone / dependency change may take a bit:
REM `predev` rebuilds better-sqlite3 against Electron's ABI. Leave the
REM window open while you use the app; closing it (or Ctrl+C) stops the app.

REM Run from this script's own folder no matter where it's invoked from.
cd /d "%~dp0"

REM Install dependencies on first run if they're missing.
if not exist "node_modules" (
  echo node_modules not found - running npm install first...
  call npm install
  if errorlevel 1 goto :fail
)

echo Starting Delegatto ^(dev^)...
call npm run dev
if errorlevel 1 goto :fail

REM Normal exit (app window closed).
echo.
echo Delegatto exited.
pause
exit /b 0

:fail
echo.
echo Delegatto failed to start - see the output above.
pause
exit /b 1
