@echo off
chcp 65001 >nul 2>&1
title 가디언즈 오브 겔럭시

color 0B
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║         가디언즈 오브 겔럭시  v2.0                   ║
echo  ║    웹 접근성 / 오탈자 / 링크 종합 검사 도구           ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: ── Node.js 확인 ─────────────────────────────────────
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ❌  Node.js 가 없습니다. [처음설치.bat] 을 먼저 실행하세요.
    pause
    exit /b 1
)

:: ── node_modules 확인 ────────────────────────────────
if not exist "node_modules\" (
    echo  ⚠️   라이브러리가 설치되지 않았습니다.
    echo      [처음설치.bat] 을 먼저 실행해주세요.
    echo.
    echo  지금 바로 설치하시겠습니까? (Y/N)
    set /p INSTALL_NOW=  선택: 
    if /i "%INSTALL_NOW%"=="Y" (
        echo.
        echo  설치 중... (2~5분 소요)
        call npm install --no-fund --no-audit
        echo.
        echo  브라우저 설치 중... (150~300MB)
        call npx playwright install chromium
        echo.
    ) else (
        echo  [처음설치.bat] 을 실행 후 다시 시도하세요.
        pause
        exit /b 1
    )
)

:: ── 포트 3000 정리 (이미 실행 중이면 종료) ───────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":3000 "') do (
    taskkill /PID %%p /F >nul 2>&1
)

:: ── 서버 시작 ─────────────────────────────────────────
echo  🚀  서버 시작 중...
echo.
echo  ┌─────────────────────────────────────────────────┐
echo  │  접속 주소 (브라우저에 붙여넣기)                │
echo  │                                                  │
echo  │  메인:   http://localhost:3000                   │
echo  │  민원검사: http://localhost:3000/minwon.html     │
echo  │                                                  │
echo  │  ⚠  이 창을 닫으면 서버가 종료됩니다            │
echo  │     종료하려면 Ctrl+C 를 누르세요               │
echo  └─────────────────────────────────────────────────┘
echo.

:: 3초 후 브라우저 자동 열기
start "" timeout /t 3 /nobreak >nul
start "" http://localhost:3000

:: 서버 실행
node server.cjs

echo.
echo  서버가 종료되었습니다.
pause
