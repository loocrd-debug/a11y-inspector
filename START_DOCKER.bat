@echo off
chcp 65001 >nul
title 가디언즈 오브 갤럭시 - Docker 실행

echo.
echo  ╔══════════════════════════════════════════════════════╗
echo  ║       가디언즈 오브 갤럭시  (Docker 버전)            ║
echo  ║       웹 접근성 검사 시스템                          ║
echo  ╚══════════════════════════════════════════════════════╝
echo.

:: Docker 설치 확인
docker --version >nul 2>&1
if errorlevel 1 (
    echo  [오류] Docker Desktop이 설치되어 있지 않습니다.
    echo.
    echo  Docker Desktop 다운로드:
    echo  https://www.docker.com/products/docker-desktop/
    echo.
    pause
    exit /b 1
)

:: Docker 실행 중인지 확인
docker info >nul 2>&1
if errorlevel 1 (
    echo  [오류] Docker Desktop이 실행중이 아닙니다.
    echo  Docker Desktop을 먼저 시작한 후 다시 실행하세요.
    echo.
    pause
    exit /b 1
)

echo  [1/3] 이미지 확인 중...
docker image inspect a11y-inspector:latest >nul 2>&1
if errorlevel 1 (
    echo  [2/3] 첫 실행 - 이미지 빌드 중... (5~10분 소요)
    docker build -t a11y-inspector:latest .
    if errorlevel 1 (
        echo  [오류] 이미지 빌드 실패
        pause
        exit /b 1
    )
) else (
    echo  [2/3] 기존 이미지 사용
)

:: 기존 컨테이너 정리
docker stop a11y-inspector >nul 2>&1
docker rm a11y-inspector >nul 2>&1

echo  [3/3] 컨테이너 시작 중...
docker run -d ^
    --name a11y-inspector ^
    -p 3000:3000 ^
    --shm-size=256m ^
    -v "%~dp0data:/app/data:ro" ^
    --restart unless-stopped ^
    a11y-inspector:latest

if errorlevel 1 (
    echo  [오류] 컨테이너 시작 실패
    pause
    exit /b 1
)

echo.
echo  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo  ✅  실행 완료!
echo.
echo  브라우저에서 아래 주소로 접속하세요:
echo.
echo      http://localhost:3000
echo.
echo  종료하려면: STOP_DOCKER.bat 실행
echo  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

:: 브라우저 자동 열기 (3초 후)
timeout /t 3 /nobreak >nul
start http://localhost:3000

pause
