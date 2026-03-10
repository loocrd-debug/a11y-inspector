@echo off
chcp 65001 > nul
title 가디언즈 오브 겔럭시 - 서버 실행

echo.
echo  =====================================================
echo   가디언즈 오브 겔럭시  v2.0
echo   웹 접근성 / 오탈자 / 링크 종합 검사 도구
echo  =====================================================
echo.

:: Node.js 설치 확인
node --version > nul 2>&1
if errorlevel 1 (
    echo  ❌ Node.js 가 설치되지 않았습니다!
    echo.
    echo  아래 주소에서 Node.js 를 설치하세요:
    echo  https://nodejs.org
    echo.
    echo  설치 후 이 파일을 다시 실행하세요.
    pause
    exit /b 1
)

echo  ✅ Node.js 확인 완료
for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo     버전: %NODE_VER%
echo.

:: node_modules 없으면 자동 설치
if not exist "node_modules\" (
    echo  📦 패키지 설치 중... (최초 1회, 인터넷 연결 필요)
    echo     잠시 기다려 주세요...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  ❌ 패키지 설치 실패!
        echo  인터넷 연결을 확인하고 다시 시도하세요.
        pause
        exit /b 1
    )
    echo.
    echo  ✅ 패키지 설치 완료
    echo.
)

:: Chromium 없으면 자동 설치
set CHROMIUM_OK=0
for /d %%d in ("%LOCALAPPDATA%\ms-playwright\chromium-*") do set CHROMIUM_OK=1
for /d %%d in ("%USERPROFILE%\AppData\Local\ms-playwright\chromium-*") do set CHROMIUM_OK=1

if "%CHROMIUM_OK%"=="0" (
    echo  🌐 Chromium 브라우저 설치 중... (최초 1회, 약 150MB)
    echo     잠시 기다려 주세요...
    echo.
    call npx playwright install chromium
    if errorlevel 1 (
        echo.
        echo  ❌ Chromium 설치 실패!
        echo  아래 명령을 직접 실행해 보세요:
        echo    npx playwright install chromium
        pause
        exit /b 1
    )
    echo.
    echo  ✅ Chromium 설치 완료
    echo.
)

:: 서버 실행
echo  🚀 서버를 시작합니다...
echo.
echo  ─────────────────────────────────────────
echo   브라우저에서 아래 주소로 접속하세요:
echo.
echo   http://localhost:3000
echo   http://localhost:3000/minwon.html  (민원 검사)
echo.
echo   종료하려면 이 창을 닫거나 Ctrl+C 를 누르세요
echo  ─────────────────────────────────────────
echo.

:: 잠시 후 브라우저 자동 열기
timeout /t 3 /nobreak > nul
start http://localhost:3000

:: 서버 시작
node server.js

echo.
echo  서버가 종료되었습니다.
pause
