@echo off
title Guardians of Galaxy

echo.
echo  =====================================================
echo   Guardians of Galaxy v2.0
echo   Web Accessibility / Spelling / Link Inspector
echo  =====================================================
echo.

:: Check Node.js
node --version >nul 2>nul
if errorlevel 1 (
    echo  ERROR: Node.js not found. Run SETUP.bat first.
    pause
    exit /b 1
)

:: Check node_modules
if not exist "node_modules\" (
    echo  Packages not installed. Installing now...
    echo.
    call npm install --no-fund --no-audit
    if errorlevel 1 (
        echo  ERROR: Install failed. Check internet connection.
        pause
        exit /b 1
    )
    echo.
    echo  Installing Chromium browser...
    call npx playwright install chromium
    echo.
)

:: Kill any existing process on port 3000
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3000 "') do (
    taskkill /PID %%p /F >nul 2>nul
)

:: Open browser after 3 seconds
start "" cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000"

echo  Starting server...
echo.
echo  -------------------------------------------------------
echo   Open your browser and go to:
echo.
echo     http://localhost:3000           (Main page)
echo     http://localhost:3000/minwon.html  (Minwon scan)
echo.
echo   WARNING: Do NOT close this window while scanning!
echo   To stop: press Ctrl+C or close this window.
echo  -------------------------------------------------------
echo.

node server.cjs

echo.
echo  Server stopped.
pause
