#!/bin/bash
docker stop a11y-inspector &>/dev/null || true
docker rm a11y-inspector &>/dev/null || true
echo "✅ 컨테이너 종료 완료"
