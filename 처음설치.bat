@echo off
chcp 65001 >nul 2>&1
title 가디언즈 오브 겔럭시 - 처음 설치

color 0A
echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║         가디언즈 오브 겔럭시  v2.0                   ║
echo  ║         처음 한 번만 실행하는 설치 프로그램           ║
echo  ╚══════════════════════════════════════════════════════╝
echo.
echo  이 창은 처음 1회만 실행하면 됩니다.
echo  설치 완료 후에는 [실행.bat] 을 사용하세요.
echo.
echo  ──────────────────────────────────────────────────────
echo.

:: ── STEP 1: Node.js 확인 ──────────────────────────────
echo  [1/3] Node.js 설치 확인 중...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ┌─────────────────────────────────────────────────┐
    echo  │  ❌  Node.js 가 설치되어 있지 않습니다!          │
    echo  │                                                  │
    echo  │  아래 주소에서 Node.js 를 설치해주세요:          │
    echo  │  https://nodejs.org                              │
    echo  │                                                  │
    echo  │  ① 사이트 접속 → 왼쪽 초록 버튼 "LTS" 클릭      │
    echo  │  ② 설치 파일 실행 → 계속 "다음" 클릭             │
    echo  │  ③ 설치 완료 후 PC 재시작                        │
    echo  │  ④ 이 파일을 다시 실행                           │
    echo  └─────────────────────────────────────────────────┘
    echo.
    start https://nodejs.org
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  ✅  Node.js %NODE_VER% 확인 완료
echo.

:: ── STEP 2: 패키지(라이브러리) 설치 ──────────────────
echo  [2/3] 필요한 라이브러리 설치 중...
echo        (인터넷 연결 필요 / 약 2~5분 소요)
echo        잠시 기다려 주세요...
echo.

call npm install --no-fund --no-audit 2>&1

if %errorlevel% neq 0 (
    echo.
    echo  ❌  라이브러리 설치 실패!
    echo      인터넷 연결을 확인하고 다시 시도하세요.
    echo      회사 네트워크라면 IT 담당자에게 문의하세요.
    pause
    exit /b 1
)
echo.
echo  ✅  라이브러리 설치 완료
echo.

:: ── STEP 3: Chromium 브라우저 설치 ───────────────────
echo  [3/3] 검사용 브라우저(Chromium) 설치 중...
echo        (약 150~300MB 다운로드 / 2~5분 소요)
echo        잠시 기다려 주세요...
echo.

call npx playwright install chromium 2>&1

if %errorlevel% neq 0 (
    echo.
    echo  ⚠️   브라우저 설치 중 오류가 발생했습니다.
    echo      아래 명령을 직접 실행해 보세요:
    echo        npx playwright install chromium
    echo.
    echo  오류가 계속되면 [실행.bat] 을 먼저 실행해보세요.
    echo  (일부 기능이 제한될 수 있습니다)
)
echo.
echo  ✅  브라우저 설치 완료
echo.

:: ── 완료 ──────────────────────────────────────────────
echo  ══════════════════════════════════════════════════════
echo.
echo   🎉  설치가 완료되었습니다!
echo.
echo   이제 [실행.bat] 을 더블클릭하여 프로그램을 시작하세요.
echo.
echo  ══════════════════════════════════════════════════════
echo.
pause
