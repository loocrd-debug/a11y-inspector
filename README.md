# 🛡️ 가디언즈 오브 겔럭시
### 웹 접근성·오탈자·링크 종합 검사 도구

> **⚠️ 중요**: 정부24(www.gov.kr) 민원 검사는 **로컬 PC에서만** 가능합니다.  
> Railway 등 해외 서버에서는 gov.kr 접속이 차단됩니다.

---

## 🖥️ 로컬 실행 (초보자 안내)

👉 **[상세 설치 가이드 보기 → LOCAL_SETUP_GUIDE.md](./LOCAL_SETUP_GUIDE.md)**

### 빠른 시작 (3단계)

```bash
# 1. 패키지 설치
npm install

# 2. Chromium 브라우저 설치 (최초 1회)
npx playwright install chromium

# 3. 서버 실행
node server.js
```

→ 브라우저에서 **http://localhost:3000** 접속

---

## 🌐 온라인 데모

**https://a11y-inspector-production.up.railway.app/**

> ⚠️ 온라인 데모에서는 gov.kr 차단으로 **민원 검사 불가** (접근성 검사 일반 URL은 가능)

---

## 📋 주요 기능

| 기능 | 설명 |
|------|------|
| ♿ **접근성 검사** | WCAG 2.1 Level A/AA/AAA · axe-core 엔진 |
| ✍️ **오탈자 검사** | 한글 맞춤법 + 영문 nspell 사전 |
| 🔗 **데드링크 검사** | HTTP 상태코드 기반 링크 유효성 |
| 📸 **스크린샷** | Playwright Chromium 페이지 캡처 |
| 📄 **보고서 생성** | Excel·HTML 통합 증적자료 |
| 🏛️ **차수별 검사** | 정부24 전환 민원 1차/2차/3차 (엑셀 8,461건) |

---

## 🏛️ 전환 차수별 민원 검사

`data/minwon-list.xlsx` 파일 기반 (8,461건 수록)

| 차수 | 건수 | 설명 |
|------|------|------|
| 1차 | 1,963건 | 1차 전환 대상 민원안내 페이지 |
| 2차 | 3,237건 | 2차 전환 대상 민원안내 페이지 |
| 3차 | 3,261건 | 3차 전환 대상 민원안내 페이지 |

접속: `http://localhost:3000/minwon.html` → "배치 스캔 실행" 탭

---

## 🛠 기술 스택

- **Backend**: Node.js 18+ · Express
- **검사 엔진**: axe-core (접근성) · nspell (영문 맞춤법)
- **브라우저**: Playwright Chromium (headless)
- **Excel**: ExcelJS (민원 목록 파싱, 보고서 생성)
- **배포**: Docker · Railway (일반 URL 검사용)

---

## 📁 프로젝트 구조

```
a11y-inspector/
├── server.js          # 메인 서버 (Node.js + Express)
├── public/
│   ├── index.html     # 메인 검사 UI
│   └── minwon.html    # 정부24 민원 배치 검사 UI
├── data/
│   └── minwon-list.xlsx  # 전환 민원 목록 (8,461건)
├── LOCAL_SETUP_GUIDE.md  # 📖 로컬 실행 상세 가이드
├── Dockerfile         # Railway/Docker 배포용
└── package.json
```

---

## 🚀 Railway 배포

1. https://railway.app 에서 GitHub 계정으로 가입
2. "New Project" → "Deploy from GitHub repo"
3. `loocrd-debug/a11y-inspector` 선택
4. 자동 빌드 및 배포

> `main` 브랜치 push 시 자동 재배포됩니다.

---

*가디언즈 오브 겔럭시 v2.0 | Node.js + Playwright + axe-core*
