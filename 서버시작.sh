#!/bin/bash

echo ""
echo " ====================================================="
echo "  가디언즈 오브 겔럭시  v2.0"
echo "  웹 접근성 / 오탈자 / 링크 종합 검사 도구"
echo " ====================================================="
echo ""

# Node.js 설치 확인
if ! command -v node &> /dev/null; then
    echo " ❌ Node.js 가 설치되지 않았습니다!"
    echo ""
    echo " 아래 주소에서 Node.js 를 설치하세요:"
    echo " https://nodejs.org"
    echo ""
    exit 1
fi

echo " ✅ Node.js 확인: $(node --version)"
echo ""

# node_modules 없으면 자동 설치
if [ ! -d "node_modules" ]; then
    echo " 📦 패키지 설치 중... (최초 1회, 인터넷 연결 필요)"
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo " ❌ 패키지 설치 실패!"
        exit 1
    fi
    echo ""
    echo " ✅ 패키지 설치 완료"
    echo ""
fi

# Chromium 없으면 자동 설치
CHROMIUM_PATH=$(find ~/.cache/ms-playwright -name "chrome" -o -name "chromium" 2>/dev/null | head -1)
if [ -z "$CHROMIUM_PATH" ]; then
    echo " 🌐 Chromium 브라우저 설치 중... (최초 1회, 약 150MB)"
    echo ""
    npx playwright install chromium
    if [ $? -ne 0 ]; then
        echo ""
        echo " ❌ Chromium 설치 실패!"
        exit 1
    fi
    echo ""
    echo " ✅ Chromium 설치 완료"
    echo ""
fi

# 브라우저 자동 열기 (3초 후)
(sleep 3 && open "http://localhost:3000" 2>/dev/null || xdg-open "http://localhost:3000" 2>/dev/null) &

echo " 🚀 서버를 시작합니다..."
echo ""
echo " ─────────────────────────────────────────"
echo "  브라우저에서 아래 주소로 접속하세요:"
echo ""
echo "  http://localhost:3000"
echo "  http://localhost:3000/minwon.html  (민원 검사)"
echo ""
echo "  종료하려면 Ctrl+C 를 누르세요"
echo " ─────────────────────────────────────────"
echo ""

node server.js
