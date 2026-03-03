# ♿ A11y Inspector - 웹 품질 종합 검사 도구

웹사이트의 **접근성(WCAG 2.1)**, **오탈자(한글/영문)**, **데드링크**를 한 번에 검사하고 HTML 증적보고서를 생성하는 도구입니다.

## 🌐 서비스 URL

**https://a11y-inspector-production.up.railway.app/**

---

## 🚀 배포 방법 (Railway - 무료)

### 1단계: Railway 계정 생성
👉 https://railway.app 에서 GitHub 계정으로 가입

### 2단계: 새 프로젝트 생성
1. Railway 대시보드 → **"New Project"** 클릭
2. **"Deploy from GitHub repo"** 선택
3. **`loocrd-debug/a11y-inspector`** 저장소 선택
4. Railway가 Dockerfile을 자동 감지하여 빌드 시작

### 3단계: 공개 URL 발급
1. 배포 완료 후 서비스 클릭
2. **Settings → Networking → Generate Domain** 클릭
3. `https://a11y-inspector-xxxx.up.railway.app` 형태의 URL 발급

> ✅ 이후 `main` 브랜치에 push할 때마다 자동으로 재배포됩니다.

---

## 📋 주요 기능

| 기능 | 설명 |
|------|------|
| ♿ **접근성 검사** | WCAG 2.1 Level A/AA/AAA 기준 axe-core 엔진 검사 |
| ✍️ **오탈자 검사** | 한글 맞춤법 규칙 + 영문 nspell 사전 기반 |
| 🔗 **데드링크 검사** | HTTP 상태코드 기반 링크 유효성 검사 |
| 📸 **스크린샷** | Playwright Chromium 페이지 캡처 |
| 📄 **HTML 보고서** | 3개 검사 결과 통합 증적자료 생성 |

## 🛠 기술 스택

- **Backend**: Node.js + Express
- **검사 엔진**: axe-core (접근성) + nspell (영문 맞춤법)
- **브라우저**: Playwright Chromium (headless)
- **컨테이너**: Docker (mcr.microsoft.com/playwright)

## 로컬 실행

```bash
# 의존성 설치
npm install
npx playwright install chromium
npx playwright install-deps chromium

# 서버 시작
node server.js
# 접속: http://localhost:3000
```

## API

### POST /api/scan
```json
{
  "url": "https://example.com",
  "level": "wcag2aa",
  "includeScreenshot": true,
  "checkSpelling": true,
  "checkLinks": true
}
```

### POST /api/report
검사 결과(JSON)를 body로 전달 → HTML 보고서 파일 다운로드
