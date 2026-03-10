#!/bin/bash
# 가디언즈 오브 겔럭시 - macOS/Linux 실행 스크립트

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

clear
echo ""
echo " ╔══════════════════════════════════════════════════════╗"
echo " ║         가디언즈 오브 겔럭시  v2.0                   ║"
echo " ║    웹 접근성 / 오탈자 / 링크 종합 검사 도구           ║"
echo " ╚══════════════════════════════════════════════════════╝"
echo ""

# Node.js 확인
if ! command -v node &>/dev/null; then
    echo " ❌  Node.js 가 설치되지 않았습니다."
    echo ""
    echo " 설치 방법:"
    echo "   https://nodejs.org 접속 → LTS 버전 다운로드 → 설치"
    echo ""
    exit 1
fi
echo " ✅  Node.js $(node --version) 확인"
echo ""

# node_modules 없으면 자동 설치
if [ ! -d "node_modules" ]; then
    echo " 📦  라이브러리 설치 중... (최초 1회, 2~5분 소요)"
    npm install --no-fund --no-audit
    echo ""
    echo " 🌐  검사용 브라우저 설치 중... (150~300MB)"
    npx playwright install chromium
    echo ""
fi

# 포트 3000 정리
lsof -ti:3000 | xargs kill -9 2>/dev/null || true

# 브라우저 자동 열기 (3초 후)
(sleep 3 && (open "http://localhost:3000" 2>/dev/null || xdg-open "http://localhost:3000" 2>/dev/null)) &

echo " 🚀  서버 시작 중..."
echo ""
echo " ┌─────────────────────────────────────────────────┐"
echo " │  접속 주소                                      │"
echo " │                                                  │"
echo " │  메인:     http://localhost:3000                │"
echo " │  민원검사: http://localhost:3000/minwon.html    │"
echo " │                                                  │"
echo " │  종료하려면 Ctrl+C 를 누르세요                  │"
echo " └─────────────────────────────────────────────────┘"
echo ""

node server.cjs
