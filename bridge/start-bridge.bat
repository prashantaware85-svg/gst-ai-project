@echo off
rem =====================================================================
rem  GST AI Agent - Windows Tally Bridge launcher
rem  Connects this PC's TallyPrime (localhost:9000) to the hosted app.
rem  Prerequisite: Node.js LTS (https://nodejs.org) and npm.
rem =====================================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Download it from https://nodejs.org and re-run.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing Tally Bridge dependencies...
  call npm install
  if errorlevel 1 (
    echo Dependency install failed.
    pause
    exit /b 1
  )
)

if not exist .env (
  echo No bridge\.env found yet.
  echo Copying bridge\.env.example to bridge\.env ...
  copy /Y ".env.example" ".env"
  echo.
  echo IMPORTANT: open bridge\.env and set TALLY_BRIDGE_URL and TALLY_BRIDGE_TOKEN.
  echo The token must match TALLY_BRIDGE_TOKEN on the Render server.
  echo Then re-run this file.
  pause
  exit /b 1
)

echo Starting Tally Bridge...
npx tsx bridge.ts
pause