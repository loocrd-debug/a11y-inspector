# ♿ A11y Inspector - 웹 접근성 검사 도구

## 프로젝트 개요
- **이름**: A11y Inspector
- **목표**: 웹사이트의 WCAG 2.1 접근성 기준 자동 검사 및 증적자료 생성
- **주요 기능**:
  - URL 입력만으로 접근성 자동 검사
  - 스크린샷 포함 HTML 증적보고서 생성
  - 심각도별(치명적/심각/보통/경미) 위반 항목 분류
  - WCAG Level A / AA / AAA 선택 가능
  - 검사 결과 차트 시각화

## 기술 스택
- **Backend**: Node.js + Express.js
- **검사 엔진**: [axe-core](https://www.deque.com/axe/) (Deque Systems)
- **브라우저 자동화**: Playwright (Chromium headless)
- **Frontend**: Tailwind CSS + Chart.js + Font Awesome
- **프로세스 관리**: PM2

## 실행 방법

### 의존성 설치
```bash
npm install
npx playwright install chromium
npx playwright install-deps chromium
```

### 서버 시작 (PM2)
```bash
pm2 start ecosystem.config.cjs
```

### 서버 시작 (직접)
```bash
node server.js
```

접속: http://localhost:3000

## API 엔드포인트

### POST /api/scan
웹사이트 접근성 검사 실행

**요청**:
```json
{
  "url": "https://example.com",
  "level": "wcag2aa",
  "includeScreenshot": true
}
```

**응답**:
```json
{
  "id": "1234567890",
  "scannedAt": "2026-03-03T00:00:00.000Z",
  "url": "https://example.com",
  "pageTitle": "Example Domain",
  "level": "wcag2aa",
  "score": 84,
  "summary": {
    "violations": 1,
    "passes": 30,
    "incomplete": 2,
    "inapplicable": 45,
    "impactCounts": { "critical": 0, "serious": 1, "moderate": 0, "minor": 0 }
  },
  "violations": [...],
  "screenshot": "base64encodedimage..."
}
```

### POST /api/report
HTML 증적보고서 생성 (검사 결과를 body로 전달)

**응답**: HTML 파일 다운로드

## WCAG 검사 레벨

| 레벨 | 설명 | 권장 |
|------|------|------|
| Level A | 기본 접근성 요구사항 | - |
| **Level AA** | **국내외 표준 권장 수준** | **✅ 권장** |
| Level AAA | 최고 수준의 접근성 | - |

## 증적자료 포함 내용
- 검사 대상 URL 및 페이지 제목
- 검사 일시 및 검사 기준 레벨
- 페이지 스크린샷 (optional)
- 종합 점수 (0~100)
- 심각도별 위반 항목 수
- 위반 항목 상세 (ID, 설명, 영향받는 HTML 요소)
- WCAG 가이드라인 링크

## 프로젝트 구조
```
webapp/
├── server.js              # Express 서버 + API 라우터
├── public/
│   └── index.html         # 프론트엔드 SPA
├── ecosystem.config.cjs   # PM2 설정
├── logs/                  # 서버 로그
├── package.json
└── README.md
```

## 주의사항
- 자동 검사는 전체 접근성 이슈의 약 30~40%만 탐지 가능
- 완전한 접근성 보장을 위해 전문가 수동 검사 병행 권장
- 일부 사이트는 headless 브라우저 접근을 차단할 수 있음
