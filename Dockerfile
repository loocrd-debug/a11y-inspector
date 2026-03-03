# Playwright 공식 이미지 (Chromium + 모든 시스템 의존성 포함)
FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

# package.json 먼저 복사 (레이어 캐싱 활용)
COPY package*.json ./

# production 의존성만 설치
RUN npm ci --omit=dev

# Chromium 브라우저 설치
RUN npx playwright install chromium

# 소스코드 복사
COPY server.js ./
COPY public/ ./public/

# 포트
EXPOSE 3000

# 헬스체크
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
