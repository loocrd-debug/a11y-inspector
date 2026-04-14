# ─────────────────────────────────────────────────────────────
#  가디언즈 오브 갤럭시 (웹 접근성 검사 시스템)
#  Dockerfile — Node.js 20 + Playwright Chromium 포함
# ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# ── 시스템 의존성 (Chromium headless 실행에 필요한 라이브러리) ──
RUN apt-get update && apt-get install -y \
    # 폰트
    fonts-noto-cjk \
    fonts-liberation \
    # Chromium 런타임 라이브러리
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    wget \
    ca-certificates \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── 작업 디렉토리 ──────────────────────────────────────────────
WORKDIR /app

# ── package.json 먼저 복사 → npm install (레이어 캐시 최적화) ──
COPY package.json ./

# npm install + Playwright Chromium 다운로드
RUN npm install --omit=dev 2>/dev/null || npm install \
    && npx playwright install chromium \
    && npx playwright install-deps chromium 2>/dev/null || true

# ── 앱 소스 복사 ───────────────────────────────────────────────
COPY server.cjs ./
COPY public/ ./public/
COPY data/ ./data/

# ── 환경변수 ───────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=3000
# Playwright: 컨테이너 내부 브라우저 경로 자동 탐지
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

# ── 포트 노출 ──────────────────────────────────────────────────
EXPOSE 3000

# ── Chromium sandbox 비활성화 (컨테이너 내부 root 실행 대응) ──
ENV PLAYWRIGHT_CHROMIUM_SANDBOX=false

# ── 시작 명령 ──────────────────────────────────────────────────
CMD ["node", "--max-old-space-size=512", "server.cjs"]
