#!/bin/bash
# 가디언즈 오브 갤럭시 — Docker 실행 스크립트 (Mac/Linux)
set -e

echo ""
echo " ╔══════════════════════════════════════════════════════╗"
echo " ║       가디언즈 오브 갤럭시  (Docker 버전)            ║"
echo " ║       웹 접근성 검사 시스템                          ║"
echo " ╚══════════════════════════════════════════════════════╝"
echo ""

# Docker 설치 확인
if ! command -v docker &> /dev/null; then
    echo " [오류] Docker가 설치되어 있지 않습니다."
    echo " https://www.docker.com/products/docker-desktop/"
    exit 1
fi

# Docker 데몬 실행 확인
if ! docker info &> /dev/null; then
    echo " [오류] Docker Desktop이 실행중이 아닙니다. Docker를 먼저 시작하세요."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo " [1/3] 이미지 확인 중..."
if ! docker image inspect a11y-inspector:latest &>/dev/null; then
    echo " [2/3] 첫 실행 - 이미지 빌드 중... (5~10분 소요)"
    docker build -t a11y-inspector:latest "$SCRIPT_DIR"
else
    echo " [2/3] 기존 이미지 사용"
fi

# 기존 컨테이너 정리
docker stop a11y-inspector &>/dev/null || true
docker rm a11y-inspector &>/dev/null || true

echo " [3/3] 컨테이너 시작 중..."
docker run -d \
    --name a11y-inspector \
    -p 3000:3000 \
    --shm-size=256m \
    -v "$SCRIPT_DIR/data:/app/data:ro" \
    --restart unless-stopped \
    a11y-inspector:latest

echo ""
echo " ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " ✅  실행 완료!"
echo ""
echo " 브라우저에서 아래 주소로 접속하세요:"
echo ""
echo "     http://localhost:3000"
echo ""
echo " 종료하려면: ./stop_docker.sh"
echo " ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Mac에서 브라우저 자동 열기
sleep 2
if [[ "$OSTYPE" == "darwin"* ]]; then
    open http://localhost:3000
fi
