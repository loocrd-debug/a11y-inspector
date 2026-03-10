@echo off
title Guardians of Galaxy - SETUP

echo.
echo  =====================================================
echo   Guardians of Galaxy v2.0 - First Time Setup
echo  =====================================================
echo.
echo  Run this ONCE only. After setup, use [START.bat]
echo.

:: Check Node.js
echo [1/3] Checking Node.js...
node --version >nul 2>nul
if errorlevel 1 (
    echo.
    echo  ERROR: Node.js is not installed!
    echo.
    echo  Please install Node.js from:
    echo  https://nodejs.org
    echo.
    echo  Steps:
    echo    1. Go to https://nodejs.org
    echo    2. Click the green LTS button
    echo    3. Install the downloaded file
    echo    4. Run this file again
    echo.
    start https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  OK: Node.js %NODE_VER%
echo.

:: Install packages
echo [2/3] Installing packages (2~5 min, internet required)...
echo.
call npm install --no-fund --no-audit
if errorlevel 1 (
    echo.
    echo  ERROR: Package install failed!
    echo  Check internet connection and try again.
    pause
    exit /b 1
)
echo.
echo  OK: Packages installed
echo.

:: Install Chromium
echo [3/3] Installing Chromium browser (150~300MB, 2~5 min)...
echo.
call npx playwright install chromium
if errorlevel 1 (
    echo.
    echo  WARNING: Chromium install had issues.
    echo  Try running START.bat anyway.
)
echo.
echo  OK: Browser installed
echo.

echo  =====================================================
echo   Setup COMPLETE!
echo   Now double-click [START.bat] to run the program.
echo  =====================================================
echo.
pause
