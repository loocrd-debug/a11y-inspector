@echo off
chcp 65001 >nul
title 가디언즈 오브 갤럭시 - 종료

echo.
echo  컨테이너를 종료합니다...
docker stop a11y-inspector >nul 2>&1
docker rm a11y-inspector >nul 2>&1
echo  ✅ 종료 완료
echo.
pause
